import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError } from '@/lib/authorization/can';
import { combineCoverage } from '@/lib/domain/ssbj';
import { CSRD_IDS } from '@/lib/fixtures/csrd';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  CDP_OPTION_NOT_CONTRACTED_REASON,
  CSRD_BREAKDOWN_NOTE,
  SSBJ_BREAKDOWN_AI_NOTE,
  loadRegulatoryCoverage,
  type RegulationRow,
} from '@/lib/services/analysis/regulations';
import { decideCsrdDmaMatter } from '@/lib/services/csrd/settings';
import type {
  AuthorizationContext,
  FrameworkKey,
  ReportingPeriod,
  RoleKey,
  Uuid,
} from '@/types/domain';
import { WriteDetectingDbClient } from '../support/write-detecting-db';

/**
 * 各規制への対応度（docs/disclosure-first.md §9.6）。
 *  - 行の順 SSBJ・CSRD・ESRS-40a・CDP・MSCI・FTSE。重み付きの「対応度%」・準拠率は出さない
 *  - 評価対象は基準ごとの規則（SSBJ: 適用かつ重要性なし以外、CSRD: 常に適用＋重要、CDP: 全項目）
 *  - 人が確認済みと AI 判定のみを分ける。未収録の基準は 0% と出さず、算定しない理由を示す
 *  - CDP と CSRD の回答を混ぜない（下書きを準備済みと数えない）
 *  - SSBJ の評価行を作らない（ssbj_assessments を読むだけ）。読込は書かない
 */

let fixture: FixtureDb;
let db: DemoDbClient;
let fy2026: ReportingPeriod;
let fy2025: ReportingPeriod;

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  organizationId: Uuid = ORG_IDS.aomi,
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType: 'enterprise',
      organizationName: 'テスト',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const viewer = () => ctxFor('approver@demo.local', ['viewer']);
const siteUser = () => ctxFor('site-user@demo.local', ['site_contributor']);
const otherTenant = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);

const REF = { referenceDate: '2026-08-14' };

beforeEach(async () => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  fy2026 = (await db.findById('periods', PERIOD_IDS.fy2026))!;
  fy2025 = (await db.findById('periods', PERIOD_IDS.fy2025))!;
});

async function rowsFor(
  ctx = manager(),
  period = fy2026,
): Promise<Record<FrameworkKey, RegulationRow>> {
  const coverage = await loadRegulatoryCoverage(db, ctx, period, REF);
  return Object.fromEntries(coverage.rows.map((r) => [r.key, r])) as Record<
    FrameworkKey,
    RegulationRow
  >;
}

const sum = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);

describe('行の並びと位置付け', () => {
  it('SSBJ・CSRD・ESRS-40a・CDP・MSCI・FTSE の順', async () => {
    const coverage = await loadRegulatoryCoverage(db, manager(), fy2026, REF);
    expect(coverage.rows.map((r) => r.key)).toEqual([
      'ssbj',
      'csrd',
      'esrs_40a',
      'cdp',
      'msci',
      'ftse',
    ]);
    expect(coverage.period.id).toBe(PERIOD_IDS.fy2026);
  });

  it('位置付け・重要性の考え方・収録状況と件数', async () => {
    const rows = await rowsFor();
    expect(rows.ssbj).toMatchObject({
      positioning: { kind: 'published', label: '公表済み' },
      materialityLabel: '財務的重要性',
      coverage: { label: '一部のみ収録', itemCount: 133 },
    });
    expect(rows.csrd).toMatchObject({
      positioning: { kind: 'sample', label: 'サンプル（架空）' },
      materialityLabel: 'ダブル・マテリアリティ',
      coverage: { label: 'サンプル（架空）', itemCount: 12 },
    });
    expect(rows.esrs_40a).toMatchObject({
      positioning: { kind: 'draft_prep', label: '公開草案に基づく準備' },
      materialityLabel: 'インパクト重要性',
      coverage: { label: '要求事項は未収録', itemCount: 0 },
    });
    expect(rows.cdp).toMatchObject({
      positioning: { kind: 'sample', label: 'サンプル（架空）' },
      materialityLabel: '未登録',
      coverage: { itemCount: 12 },
    });
    expect(rows.cdp.versionLabel).toBe('CDP 2026（架空）');
    for (const key of ['msci', 'ftse'] as const) {
      expect(rows[key]).toMatchObject({
        positioning: { kind: 'planned', label: '今後対応予定' },
        coverage: { itemCount: null },
        inScope: null,
        breakdown: null,
        responses: null,
      });
    }
  });
});

describe('算定しない基準（0% と出さない）', () => {
  it('ESRS-40a は要求事項が未収録のため算定しない', async () => {
    const rows = await rowsFor();
    expect(rows.esrs_40a.notCalculatedReason).toBe('要求事項が未収録（公開草案）のため算定しない');
    expect(rows.esrs_40a.inScope).toBeNull();
    expect(rows.esrs_40a.breakdown).toBeNull();
  });

  it('MSCI・FTSE は評価項目マスター未収録のため算定しない', async () => {
    const rows = await rowsFor();
    expect(rows.msci.notCalculatedReason).toBe('評価項目マスター未収録のため算定しない');
    expect(rows.ftse.notCalculatedReason).toBe('評価項目マスター未収録のため算定しない');
  });

  it('割合（%）・準拠率・対応度% を一切返さない', async () => {
    const coverage = await loadRegulatoryCoverage(db, manager(), fy2026, REF);
    const json = JSON.stringify(coverage);
    expect(json).not.toMatch(/\d\s*%/);
    expect(json).not.toContain('準拠率');
    expect(json).not.toContain('対応度%');
    expect(json).not.toMatch(/"(rate|score|percent)"/i);
  });
});

describe('SSBJ（ssbj_assessments を読むだけ）', () => {
  it('評価対象 = 適用かつ重要性なし以外。分母は対象基準の要求事項。人の確認と AI のみを分ける', async () => {
    const assessments = fixture.ssbjAssessments.filter(
      (a) => a.organizationId === ORG_IDS.aomi && a.reportingPeriodId === PERIOD_IDS.fy2026,
    );
    const inScope = assessments.filter(
      (a) => a.applicability === 'applicable' && a.materiality !== 'not_material',
    );
    const expectedCounts = {
      covered: 0,
      mostly_covered: 0,
      partial: 0,
      not_covered: 0,
      unconfirmed: 0,
    };
    for (const a of inScope) {
      expectedCounts[combineCoverage(a.disclosureStatus, a.dataStatus, a.processStatus)] += 1;
    }

    const ssbj = (await rowsFor()).ssbj;
    expect(ssbj.inScope).toMatchObject({ count: 124, denominator: 133 });
    expect(ssbj.breakdown!.counts).toEqual(expectedCounts);
    expect(sum(ssbj.breakdown!.counts)).toBe(124);
    expect(ssbj.breakdown!.humanConfirmed).toBe(
      inScope.filter((a) => a.finalStatus !== null).length,
    );
    expect(ssbj.breakdown!.aiOnly).toBe(
      inScope.filter((a) => a.aiStatus !== null && a.finalStatus === null).length,
    );
    expect(ssbj.breakdown!.humanConfirmed).toBe(100);
    expect(ssbj.breakdown!.aiOnly).toBe(23);
    // SSBJ の AI は 3 観点の列に直接書くため、内訳に未確認の AI 判定が入ることを明記する
    expect(ssbj.notes).toContain(SSBJ_BREAKDOWN_AI_NOTE);
    // SSBJ の対応状況画面の「未対応」は未確認を含むため、「同じ数え方」と言わず違いを示す（未対応 31・未確認 10）
    expect(SSBJ_BREAKDOWN_AI_NOTE).not.toContain('同じ数え方');
    expect(SSBJ_BREAKDOWN_AI_NOTE).toContain('「未対応」は未確認を含みます');
    // SSBJ には要求事項ごとの回答が無い（節ごとの開示ドラフト）
    expect(ssbj.responses).toBeNull();
    expect(ssbj.responsesNote).toContain('開示ドラフト');
  });

  it('評価行の無い期間は行を作らず、既定（適用・未評価・未確認）として数える', async () => {
    const spy = new WriteDetectingDbClient(db);
    const coverage = await loadRegulatoryCoverage(spy, manager(), fy2025, REF);
    const ssbj = coverage.rows.find((r) => r.key === 'ssbj')!;
    expect(ssbj.inScope).toMatchObject({ count: 133, denominator: 133 });
    expect(ssbj.breakdown!.counts.unconfirmed).toBe(133);
    expect(ssbj.breakdown!.humanConfirmed).toBe(0);
    expect(spy.writes).toEqual([]);
    expect(
      fixture.ssbjAssessments.filter((a) => a.reportingPeriodId === PERIOD_IDS.fy2025),
    ).toHaveLength(0);
  });

  it('分析条件で適用しない基準は、評価対象の分母から外す（SSBJ の要求事項画面と同じ）', async () => {
    fixture.ssbjAnalysisSettings.push({
      id: '00000000-0000-4000-8000-0000000000a1',
      organizationId: ORG_IDS.aomi,
      reportingPeriodId: PERIOD_IDS.fy2026,
      applyGeneral: false,
      applyClimate: true,
      applyPractical: false,
      firstTimeAdoption: false,
      consolidationScope: 'same_as_financial',
      consolidationNote: '',
      includedUnitIds: [],
      valueChainScope: 'not_decided',
      valueChainNote: '',
      confirmedAt: null,
      confirmedBy: null,
      frameworkVersionId: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      createdBy: null,
      updatedBy: null,
    });
    const ssbj = (await rowsFor()).ssbj;
    const ssbjVersion = fixture.frameworkVersions.find((v) => v.label.startsWith('SSBJ'))!;
    const climateItems = fixture.disclosureItems.filter(
      (i) => i.frameworkVersionId === ssbjVersion.id && i.section.startsWith('気候'),
    );
    expect(ssbj.inScope!.denominator).toBe(climateItems.length);
    expect(ssbj.inScope!.denominator).toBeLessThan(133);
  });
});

describe('CSRD（DMA から導出した適用）', () => {
  it('Fixture: 評価対象 9/12（うち暫定 7）、人の確認 4・AI 判定のみ 3、回答の承認 0/12', async () => {
    const csrd = (await rowsFor()).csrd;
    expect(csrd.inScope).toMatchObject({ count: 9, denominator: 12, provisional: 7 });
    expect(sum(csrd.breakdown!.counts)).toBe(9);
    expect(csrd.breakdown!.humanConfirmed).toBe(4);
    expect(csrd.breakdown!.aiOnly).toBe(3);
    expect(csrd.responses).toEqual({ approved: 0, total: 12 });
    // 回答が必要なのは評価対象の要求事項だけ（現状診断の「未承認の回答」はこちらで数える）
    expect(csrd.responsesRequired).toEqual({ approved: 0, total: 9 });
    expect(csrd.notes.join('')).toContain('改正 ESRS（2026-07-03 採択・未発効）は未収録');
    // CSRD の AI は候補の列だけに書く。内訳は人の値だけで、AI の候補だけの要求事項は「未確認」
    expect(csrd.notes).toContain(CSRD_BREAKDOWN_NOTE);
    expect(csrd.breakdown!.counts.unconfirmed).toBeGreaterThanOrEqual(csrd.breakdown!.aiOnly);
  });

  it('G1 を「財務のみ」と判断すると評価対象が 11/12 になる', async () => {
    await decideCsrdDmaMatter(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      topic: 'G1',
      impactAssessment: 'not_material',
      impactRationale: '算定結果が閾値未満（テスト）',
      financialAssessment: 'material',
      financialRationale: '制裁金の算定結果が閾値以上（テスト）',
      stakeholderNote: '',
    });
    const csrd = (await rowsFor()).csrd;
    expect(csrd.inScope).toMatchObject({ count: 11, denominator: 12 });
  });
});

describe('CDP と CSRD の回答を混ぜない', () => {
  function responseFor(itemId: Uuid) {
    return fixture.disclosureResponses.find(
      (r) =>
        r.organizationId === ORG_IDS.aomi &&
        r.reportingPeriodId === PERIOD_IDS.fy2026 &&
        r.itemId === itemId,
    )!;
  }

  it('CSRD の回答の承認は CDP に数えず、CDP の承認は CSRD に数えない', async () => {
    responseFor(CSRD_IDS.items['ESRS-E1-5']!).status = 'approved';
    let rows = await rowsFor();
    expect(rows.csrd.responses).toEqual({ approved: 1, total: 12 });
    expect(rows.cdp.responses).toEqual({ approved: 0, total: 12 });

    const cdpVersion = fixture.frameworkVersions.find((v) => v.label === 'CDP 2026（架空）')!;
    const cdpItems = fixture.disclosureItems.filter((i) => i.frameworkVersionId === cdpVersion.id);
    responseFor(cdpItems[0]!.id).status = 'approved';
    rows = await rowsFor();
    expect(rows.cdp.responses).toEqual({ approved: 1, total: 12 });
    expect(rows.csrd.responses).toEqual({ approved: 1, total: 12 });
  });

  it('下書き・レビュー中の回答を承認済みと数えない', async () => {
    const cdpVersion = fixture.frameworkVersions.find((v) => v.label === 'CDP 2026（架空）')!;
    const cdpItems = fixture.disclosureItems.filter((i) => i.frameworkVersionId === cdpVersion.id);
    responseFor(cdpItems[0]!.id).status = 'draft';
    responseFor(cdpItems[1]!.id).status = 'in_review';
    const rows = await rowsFor();
    expect(rows.cdp.responses).toEqual({ approved: 0, total: 12 });
  });

  it('CDP は 3 観点の評価を持たない（内訳を作らず、全項目を評価対象として示す）', async () => {
    const cdp = (await rowsFor()).cdp;
    expect(cdp.inScope).toMatchObject({ count: 12, denominator: 12 });
    expect(cdp.breakdown).toBeNull();
    expect(cdp.breakdownNote).toContain('3 観点');
  });
});

describe('権限・テナント・書込', () => {
  it('開示の閲覧権限が無い役割（拠点担当）は拒否', async () => {
    await expect(loadRegulatoryCoverage(db, siteUser(), fy2026, REF)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it('閲覧者は読める', async () => {
    const coverage = await loadRegulatoryCoverage(db, viewer(), fy2026, REF);
    expect(coverage.rows).toHaveLength(6);
  });

  it('他組織の期間は扱わない（他テナントの評価・回答を数えない）', async () => {
    await expect(loadRegulatoryCoverage(db, otherTenant(), fy2026, REF)).rejects.toThrow();
    const sotenPeriod = (await db.findById('periods', PERIOD_IDS.sotenFy2026))!;
    const rows = await rowsFor(otherTenant(), sotenPeriod);
    expect(rows.ssbj.breakdown!.humanConfirmed).toBe(0);
    expect(rows.ssbj.breakdown!.aiOnly).toBe(0);
    expect(rows.csrd.breakdown!.humanConfirmed).toBe(0);
    expect(rows.csrd.breakdown!.aiOnly).toBe(0);
    // 越権テスト用の組織は CDP 対応オプションが無効（NF-38）。CDP 行は算定せず理由を出す
    // （他テナントの回答を数えないことは、契約のある組織の行と cdp-option.test.ts で確かめている）
    expect(rows.cdp.responses).toBeNull();
    expect(rows.cdp.notCalculatedReason).toBe(CDP_OPTION_NOT_CONTRACTED_REASON);
  });

  it('書込検知ラッパーで包んでも例外が出ない（SSBJ・CSRD の読込を含む）', async () => {
    const spy = new WriteDetectingDbClient(db);
    await loadRegulatoryCoverage(spy, manager(), fy2026, REF);
    await loadRegulatoryCoverage(spy, viewer(), fy2025, REF);
    expect(spy.writes).toEqual([]);
  });
});
