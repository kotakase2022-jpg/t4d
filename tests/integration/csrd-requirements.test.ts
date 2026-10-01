import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { CSRD_IDS } from '@/lib/fixtures/csrd';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  filterCsrdRequirements,
  loadCsrdOverview,
  loadCsrdRequirementDetail,
  loadCsrdRequirementViews,
  reviewCsrdAssessment,
  runCsrdGapAnalysis,
  saveCsrdAssessment,
} from '@/lib/services/csrd/requirements';
import { confirmCsrdDma, decideCsrdDmaMatter } from '@/lib/services/csrd/settings';
import type {
  AuthorizationContext,
  CsrdAssessment,
  ReportingPeriod,
  RoleKey,
} from '@/types/domain';
import { WriteDetectingDbClient } from '../support/write-detecting-db';

/**
 * CSRD の要求事項（docs/disclosure-first.md §9.2・§9.4）。
 *  - Fixture の適用は DMA の人の判断から導出（ESRS2×2 常に適用・E1×4/S1×2 両面・E3-4 インパクト・
 *    E5-5 対象外・G1×2 未判定、すべて暫定 → 評価対象 9／12）
 *  - G1 を「財務のみ」と判断すると G1-1/G1-4 が「適用（財務）」になり、DMA を確定すると暫定が外れる
 *  - AI は ai_* 以外を変えない。担当者が「候補を採用」「修正して確定」して初めて最終判定が入る
 *  - 読込関数は書かない
 */

let fixture: FixtureDb;
let db: DemoDbClient;
let fy2026: ReportingPeriod;
let fy2025: ReportingPeriod;

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  organizationId: string = ORG_IDS.aomi,
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
/** 開示の編集権限はあるが AI の実行権限は無い（レビュー担当） */
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const viewer = () => ctxFor('approver@demo.local', ['approver']);
const otherOrg = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);

const REF = { referenceDate: '2026-08-14' };
const item = (code: string) => CSRD_IDS.items[code]!;

beforeEach(async () => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  fy2026 = (await db.findById('periods', PERIOD_IDS.fy2026))!;
  fy2025 = (await db.findById('periods', PERIOD_IDS.fy2025))!;
});

async function decideG1FinancialOnly() {
  await decideCsrdDmaMatter(db, manager(), {
    reportingPeriodId: PERIOD_IDS.fy2026,
    topic: 'G1',
    impactAssessment: 'not_material',
    impactRationale: '算定結果 2.2 で閾値未満（テスト）',
    financialAssessment: 'material',
    financialRationale: '制裁金の算定結果 3.2 が閾値以上（テスト）',
    stakeholderNote: '',
  });
}

function rowOf(assessmentId: string): CsrdAssessment {
  return fixture.csrdAssessments.find((a) => a.id === assessmentId)!;
}

describe('Fixture の適用の導出', () => {
  it('12 項目の適用・観点・暫定（評価対象 9／12）', async () => {
    const loaded = await loadCsrdRequirementViews(db, manager(), fy2026, REF);
    expect(loaded!.masterTotal).toBe(12);
    expect(loaded!.legalLabel).toBe('サンプル（架空）');
    expect(loaded!.materialityBasis).toBe('double');
    expect(loaded!.dmaConfirmed).toBe(false);
    const summary = Object.fromEntries(
      loaded!.views.map((v) => [
        v.item.code,
        [v.applicability.kind, v.applicability.perspectives.join('+'), v.applicability.provisional],
      ]),
    );
    expect(summary).toEqual({
      'ESRS2-GOV-1': ['always', '', false],
      'ESRS2-SBM-3': ['always', '', false],
      'ESRS-E1-1': ['material', 'impact+financial', true],
      'ESRS-E1-4': ['material', 'impact+financial', true],
      'ESRS-E1-5': ['material', 'impact+financial', true],
      'ESRS-E1-6': ['material', 'impact+financial', true],
      'ESRS-E3-4': ['material', 'impact', true],
      'ESRS-E5-5': ['not_material', '', true],
      'ESRS-S1-6': ['material', 'impact+financial', true],
      'ESRS-S1-9': ['material', 'impact+financial', true],
      'ESRS-G1-1': ['undetermined', '', true],
      'ESRS-G1-4': ['undetermined', '', true],
    });
    const inScope = loaded!.views.filter((v) => v.priority !== null);
    expect(inScope).toHaveLength(9);
  });

  it('評価 12 行は Fixture にあり、AI 候補・人の確定の状態が §9.3 のとおり', async () => {
    const loaded = await loadCsrdRequirementViews(db, manager(), fy2026, REF);
    const state = Object.fromEntries(
      loaded!.views.map((v) => [v.item.code, [v.combined, v.reviewState, v.awaitingReview]]),
    );
    expect(state).toEqual({
      'ESRS2-GOV-1': ['mostly_covered', 'human', false],
      'ESRS2-SBM-3': ['unconfirmed', 'ai_only', true],
      'ESRS-E1-1': ['not_covered', 'human', false],
      'ESRS-E1-4': ['unconfirmed', 'ai_only', true],
      'ESRS-E1-5': ['mostly_covered', 'human', false],
      'ESRS-E1-6': ['unconfirmed', 'none', false],
      'ESRS-E3-4': ['unconfirmed', 'none', false],
      'ESRS-E5-5': ['unconfirmed', 'none', false],
      'ESRS-S1-6': ['mostly_covered', 'human', false],
      'ESRS-S1-9': ['unconfirmed', 'ai_only', true],
      'ESRS-G1-1': ['unconfirmed', 'none', false],
      'ESRS-G1-4': ['unconfirmed', 'none', false],
    });
    expect(loaded!.views.every((v) => v.assessment !== null)).toBe(true);
    // 回答（版・承認）は CSRD の回答だけ（未着手）
    expect(loaded!.views.every((v) => v.response?.status === 'not_started')).toBe(true);
  });

  it('対応状況の要約（DMA・適用の内訳・評価対象の件数・確認待ち・計画）', async () => {
    const overview = await loadCsrdOverview(db, manager(), fy2026, REF);
    expect(overview!.dma).toMatchObject({
      confirmed: false,
      matterTotal: 10,
      settingsPersisted: true,
      boundaryDecided: true,
      outcomeCounts: {
        both: 2,
        impact_only: 2,
        financial_only: 1,
        not_material: 4,
        not_assessed: 1,
      },
    });
    expect(overview!.applicabilityCounts).toEqual({
      always: 2,
      material: 7,
      not_material: 1,
      undetermined: 2,
      inScope: 9,
      total: 12,
      provisional: 10,
    });
    expect(overview!.coverageCounts.combined).toEqual({
      covered: 0,
      mostly_covered: 3,
      partial: 0,
      not_covered: 1,
      unconfirmed: 5,
    });
    expect(overview!.awaitingReview).toBe(3);
    expect(overview!.planCounts).toEqual({
      not_started: 1,
      in_progress: 1,
      in_review: 0,
      done: 0,
    });
    expect(overview!.collectionPlanCount).toBe(1);
    expect(overview!.draftCounts).toEqual({ confirmed: 1, generated: 1 });
  });

  it('G1 を「財務のみ」と判断すると G1-1/G1-4 が適用（財務）になり、DMA を確定すると暫定が外れる', async () => {
    await decideG1FinancialOnly();
    let loaded = await loadCsrdRequirementViews(db, manager(), fy2026, REF);
    for (const code of ['ESRS-G1-1', 'ESRS-G1-4']) {
      const view = loaded!.views.find((v) => v.item.code === code)!;
      expect(view.applicability).toMatchObject({
        kind: 'material',
        perspectives: ['financial'],
        provisional: true,
      });
      expect(view.priority).not.toBeNull();
    }
    expect(loaded!.views.filter((v) => v.priority !== null)).toHaveLength(11);

    await confirmCsrdDma(db, manager(), PERIOD_IDS.fy2026);
    loaded = await loadCsrdRequirementViews(db, manager(), fy2026, REF);
    expect(loaded!.dmaConfirmed).toBe(true);
    expect(loaded!.views.some((v) => v.applicability.provisional)).toBe(false);
  });

  it('行の無い期間（FY2025）は評価なし・未判定で返し、読込関数は書かない', async () => {
    const readOnly = new WriteDetectingDbClient(db);
    const loaded = await loadCsrdRequirementViews(readOnly, manager(), fy2025, REF);
    expect(loaded!.views).toHaveLength(12);
    expect(loaded!.views.every((v) => v.assessment === null && v.combined === 'unconfirmed')).toBe(
      true,
    );
    expect(loaded!.views.filter((v) => v.applicability.kind === 'always')).toHaveLength(2);
    expect(loaded!.views.filter((v) => v.applicability.kind === 'undetermined')).toHaveLength(10);
    await loadCsrdOverview(readOnly, manager(), fy2025, REF);
    await loadCsrdOverview(readOnly, manager(), fy2026, REF);
    await loadCsrdRequirementDetail(readOnly, manager(), fy2026, item('ESRS-E1-6'), REF);
    await loadCsrdRequirementDetail(readOnly, manager(), fy2025, item('ESRS-E1-6'), REF);
    expect(readOnly.writes).toEqual([]);
  });
});

describe('絞り込み', () => {
  it('適用・観点・状況・優先度・確認待ち', async () => {
    await decideG1FinancialOnly();
    const { views } = (await loadCsrdRequirementViews(db, manager(), fy2026, REF))!;
    const codes = (list: typeof views) => list.map((v) => v.item.code);
    expect(codes(filterCsrdRequirements(views, { applicability: ['always'] }))).toEqual([
      'ESRS2-GOV-1',
      'ESRS2-SBM-3',
    ]);
    expect(codes(filterCsrdRequirements(views, { perspective: ['financial'] }))).toEqual([
      'ESRS-E1-1',
      'ESRS-E1-4',
      'ESRS-E1-5',
      'ESRS-E1-6',
      'ESRS-S1-6',
      'ESRS-S1-9',
      'ESRS-G1-1',
      'ESRS-G1-4',
    ]);
    expect(codes(filterCsrdRequirements(views, { applicability: ['not_material'] }))).toEqual([
      'ESRS-E5-5',
    ]);
    expect(codes(filterCsrdRequirements(views, { review: ['awaiting'] }))).toEqual([
      'ESRS2-SBM-3',
      'ESRS-E1-4',
      'ESRS-S1-9',
    ]);
    expect(codes(filterCsrdRequirements(views, { coverage: ['not_covered'] }))).toEqual([
      'ESRS-E1-1',
    ]);
    // 優先度は評価対象だけが持つ（対象外の E5-5 は優先度で絞り込むと出ない）
    const prioritized = filterCsrdRequirements(views, { priority: ['high', 'medium', 'low'] });
    expect(codes(prioritized)).not.toContain('ESRS-E5-5');
    expect(prioritized).toHaveLength(11);
  });
});

describe('要求事項の詳細', () => {
  it('対応付いた指標の当期データ（値は承認済みだけ）と回答の画面', async () => {
    const detail = await loadCsrdRequirementDetail(db, manager(), fy2026, item('ESRS-E1-6'), REF);
    expect(detail!.view.item.code).toBe('ESRS-E1-6');
    expect(detail!.matter?.topic).toBe('E1');
    expect(detail!.responseHref).toBe(`/enterprise/disclosures/csrd/${item('ESRS-E1-6')}`);
    const scope1 = detail!.metricData.filter((r) => r.metric.code === 'scope1');
    expect(scope1.map((r) => [r.unit?.code, r.state])).toEqual([
      ['HQ', 'approved'],
      ['EAST', 'approved'],
      ['WEST', 'approved'],
      ['EU', 'in_review'],
      ['JV', 'awaiting_submission'],
    ]);
    expect(scope1.find((r) => r.unit?.code === 'EU')!.value).toBeNull();
    expect(scope1.find((r) => r.unit?.code === 'HQ')!.value).toBe(1190.9);
    // 当期の行が無い指標は「未入力」（0 として扱わない）
    const location = detail!.metricData.filter((r) => r.metric.code === 'scope2_location');
    expect(location).toEqual([
      expect.objectContaining({ unit: null, state: 'not_entered', value: null }),
    ]);
    expect(detail!.view.dataCoverage).toBe('partial');
    expect(detail!.canRunAi).toBe(true);
  });

  it('CSRD 以外の要求事項は null', async () => {
    const ssbjItem = fixture.disclosureItems.find((i) => i.code.startsWith('気候-'))!;
    expect(await loadCsrdRequirementDetail(db, manager(), fy2026, ssbjItem.id)).toBeNull();
  });
});

describe('AI ギャップ分析と担当者の確認', () => {
  it('AI は ai_* 以外を変えない（人の 3 観点・最終判定・確認の記録はそのまま）', async () => {
    const assessmentId = CSRD_IDS.assessments['ESRS-E1-1']!;
    const before = structuredClone(rowOf(assessmentId));
    const { assessment, runId } = await runCsrdGapAnalysis(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      itemId: item('ESRS-E1-1'),
    });
    expect(assessment.aiStatus).not.toBeNull();
    expect(assessment.aiRunId).toBe(runId);
    const after = rowOf(assessmentId);
    for (const key of [
      'disclosureStatus',
      'dataStatus',
      'processStatus',
      'finalStatus',
      'reviewDecision',
      'reviewedBy',
      'reviewedAt',
      'reviewComment',
      'ownerDepartment',
      'ownerUserId',
      'itemId',
      'organizationId',
      'reportingPeriodId',
      'createdAt',
      'createdBy',
    ] as const) {
      expect(after[key], key).toEqual(before[key]);
    }
    // 人が確認した後に AI を実行し直したので、確認待ちになる
    const loaded = await loadCsrdRequirementViews(db, manager(), fy2026, REF);
    expect(loaded!.views.find((v) => v.item.code === 'ESRS-E1-1')!.awaitingReview).toBe(true);
    const run = fixture.aiRuns.find((r) => r.id === runId)!;
    expect(run.featureType).toBe('csrdGapAnalysis');
    expect(run.promptVersion).toBe('csrd-gap-analysis@2026-10-01.1');
  });

  it('評価対象でない（対象外・未判定）要求事項は分析できない', async () => {
    for (const code of ['ESRS-E5-5', 'ESRS-G1-1']) {
      await expect(
        runCsrdGapAnalysis(db, manager(), {
          reportingPeriodId: PERIOD_IDS.fy2026,
          itemId: item(code),
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('AI の実行権限が無い役割は分析できない', async () => {
    await expect(
      runCsrdGapAnalysis(db, reviewer(), {
        reportingPeriodId: PERIOD_IDS.fy2026,
        itemId: item('ESRS-E1-6'),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('「候補を採用」は AI の 3 観点を写し、最終判定を入れる', async () => {
    const { assessment } = await runCsrdGapAnalysis(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      itemId: item('ESRS-E1-6'),
    });
    expect(assessment.finalStatus).toBeNull();
    const reviewed = await reviewCsrdAssessment(db, manager(), {
      assessmentId: assessment.id,
      decision: 'approved',
      comment: '',
    });
    expect([reviewed.disclosureStatus, reviewed.dataStatus, reviewed.processStatus]).toEqual([
      assessment.aiDisclosureStatus,
      assessment.aiDataStatus,
      assessment.aiProcessStatus,
    ]);
    expect(reviewed.finalStatus).toBe(assessment.aiStatus);
    expect(reviewed.reviewDecision).toBe('approved');
    expect(reviewed.reviewedBy).toBe(userId('sustainability@demo.local'));
    const loaded = await loadCsrdRequirementViews(db, manager(), fy2026, REF);
    expect(loaded!.views.find((v) => v.item.code === 'ESRS-E1-6')!.awaitingReview).toBe(false);
  });

  it('「修正して確定」は人の値とコメントが必須。AI の候補が無ければ採用できない', async () => {
    const assessmentId = CSRD_IDS.assessments['ESRS-E3-4']!;
    await expect(
      reviewCsrdAssessment(db, manager(), { assessmentId, decision: 'approved', comment: '' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      reviewCsrdAssessment(db, manager(), {
        assessmentId,
        decision: 'modified',
        disclosureStatus: 'partial',
        dataStatus: 'partial',
        processStatus: 'partial',
        comment: '',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const modified = await reviewCsrdAssessment(db, manager(), {
      assessmentId,
      decision: 'modified',
      disclosureStatus: 'partial',
      dataStatus: 'covered',
      processStatus: 'mostly_covered',
      comment: '取水量の資料を確認した（テスト）',
    });
    expect(modified).toMatchObject({ finalStatus: 'partial', reviewDecision: 'modified' });
  });

  it('人が 3 観点を入力して確定できる（AI の候補が無ければ判断の区分は付けない）', async () => {
    const saved = await saveCsrdAssessment(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      itemId: item('ESRS-E3-4'),
      disclosureStatus: 'covered',
      dataStatus: 'covered',
      processStatus: 'covered',
      comment: '',
    });
    expect(saved).toMatchObject({ finalStatus: 'covered', reviewDecision: null });
    expect(saved.aiStatus).toBeNull();
  });

  it('評価行の無い期間で AI を実行すると、評価行を作ってから候補を書く', async () => {
    const created = await runCsrdGapAnalysis(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2025,
      itemId: item('ESRS2-GOV-1'),
    });
    expect(created.assessment.id).toBe(
      fid('csrd_assessment', `${ORG_IDS.aomi}/${PERIOD_IDS.fy2025}/ESRS2-GOV-1`),
    );
    expect(created.assessment).toMatchObject({
      finalStatus: null,
      disclosureStatus: 'unconfirmed',
    });
  });

  it('他組織の評価は確認できない・他組織の期間には書けない', async () => {
    await expect(
      reviewCsrdAssessment(db, otherOrg(), {
        assessmentId: CSRD_IDS.assessments['ESRS-E1-4']!,
        decision: 'approved',
        comment: '',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      saveCsrdAssessment(db, otherOrg(), {
        reportingPeriodId: PERIOD_IDS.fy2026,
        itemId: item('ESRS-E1-4'),
        disclosureStatus: 'covered',
        dataStatus: 'covered',
        processStatus: 'covered',
        comment: '',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      saveCsrdAssessment(db, viewer(), {
        reportingPeriodId: PERIOD_IDS.fy2026,
        itemId: item('ESRS-E1-4'),
        disclosureStatus: 'covered',
        dataStatus: 'covered',
        processStatus: 'covered',
        comment: '',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(rowOf(CSRD_IDS.assessments['ESRS-E1-4']!).finalStatus).toBeNull();
  });
});
