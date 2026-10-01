import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { CSRD_IDS } from '@/lib/fixtures/csrd';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  confirmCsrdDma,
  decideCsrdDmaMatter,
  deleteCsrdDmaIro,
  loadCsrdMatterDetail,
  loadCsrdSettings,
  saveCsrdBoundary,
  saveCsrdMethod,
  upsertCsrdDmaIro,
  type CsrdIroInput,
} from '@/lib/services/csrd/settings';
import type { AuthorizationContext, ReportingPeriod, RoleKey } from '@/types/domain';
import { WriteDetectingDbClient } from '../support/write-detecting-db';

/**
 * CSRD の設定（報告範囲・評価方法と閾値・ダブル・マテリアリティ評価）（docs/disclosure-first.md §9.2・§9.4）。
 *  - 評価済みの軸は根拠が必須
 *  - DMA に関わる書込（報告範囲・閾値・IRO・事項の判断）は確定を外す
 *  - 確定は条件（報告範囲・ステークホルダー関与・10 事項の判断）が揃ったときだけ
 *  - 他組織・権限の無い役割は拒否。読込は書かない
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
      organizationName: 'テスト組織',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
/** 承認者（承認権限だけ。開示の編集権限は無い） */
const approverOnly = () => ctxFor('approver@demo.local', ['approver']);
/** 拠点担当（開示の閲覧権限も無い） */
const site = () => ctxFor('site-user@demo.local', ['site_contributor']);
const otherOrg = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);

beforeEach(async () => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  fy2026 = (await db.findById('periods', PERIOD_IDS.fy2026))!;
  fy2025 = (await db.findById('periods', PERIOD_IDS.fy2025))!;
});

async function decideG1(ctx = manager()) {
  return decideCsrdDmaMatter(db, ctx, {
    reportingPeriodId: PERIOD_IDS.fy2026,
    topic: 'G1',
    impactAssessment: 'not_material',
    impactRationale: '算定結果 2.2 で閾値未満（テスト）',
    financialAssessment: 'material',
    financialRationale: '制裁金の算定結果 3.2 が閾値以上（テスト）',
    stakeholderNote: '',
  });
}

async function confirmed(): Promise<boolean> {
  const view = await loadCsrdSettings(db, manager(), fy2026);
  return view!.confirmed;
}

const RISK: CsrdIroInput = {
  iroType: 'risk',
  subTopic: '',
  description: '排出量取引の対象拡大（テスト）',
  valueChainStage: 'own_operations',
  timeHorizon: 'long',
  impactOccurrence: null,
  impactDirection: null,
  impactScale: null,
  impactScope: null,
  impactIrremediability: null,
  impactLikelihood: null,
  financialLikelihood: 3,
  financialMagnitude: 3,
  humanRights: false,
  affectedStakeholders: '',
  relatedImpactIroId: null,
};

describe('Fixture（FY2026）の DMA', () => {
  it('10 事項の算定結果は §9.3 の表どおりで、人の判断の結果は G1 だけ未評価', async () => {
    const view = await loadCsrdSettings(db, manager(), fy2026);
    expect(view).not.toBeNull();
    const scores = Object.fromEntries(
      view!.matters.map((m) => [m.topic, [m.axes.impact.maxScore, m.axes.financial.maxScore]]),
    );
    expect(scores).toEqual({
      E1: [4.0, 4.0],
      E2: [2.3, 2.0],
      E3: [3.3, 2.4],
      E4: [2.2, 1.7],
      E5: [2.0, 2.0],
      S1: [3.3, 3.5],
      S2: [4.3, 2.0],
      S3: [1.6, 1.4],
      S4: [1.7, 3.2],
      G1: [2.2, 3.2],
    });
    const outcomes = Object.fromEntries(view!.matters.map((m) => [m.topic, m.outcome]));
    expect(outcomes).toEqual({
      E1: 'both',
      E2: 'not_material',
      E3: 'impact_only',
      E4: 'not_material',
      E5: 'not_material',
      S1: 'both',
      S2: 'impact_only',
      S3: 'not_material',
      S4: 'financial_only',
      G1: 'not_assessed',
    });
    expect(view!.outcomeCounts).toEqual({
      both: 2,
      impact_only: 2,
      financial_only: 1,
      not_material: 4,
      not_assessed: 1,
    });
    expect(view!.matterTotal).toBe(10);
    expect(view!.thresholds).toEqual({ impactThreshold: 3.0, financialThreshold: 3.0 });
    expect(view!.confirmed).toBe(false);
    expect(view!.readiness).toMatchObject({
      boundaryDecided: true,
      stakeholderNoted: true,
      allMattersAssessed: false,
      unassessedTopics: ['G1'],
      ready: false,
    });
  });

  it('算定結果は提案で、人の判断と違ってよい（G1 は算定では財務のみ）', async () => {
    const view = await loadCsrdSettings(db, manager(), fy2026);
    const g1 = view!.matters.find((m) => m.topic === 'G1')!;
    expect(g1.proposedOutcome).toBe('financial_only');
    expect(g1.outcome).toBe('not_assessed');
  });

  it('行の無い期間（FY2025）は既定値の仮想行で返し、読込では書かない', async () => {
    const readOnly = new WriteDetectingDbClient(db);
    const view = await loadCsrdSettings(readOnly, manager(), fy2025);
    expect(view!.settingsPersisted).toBe(false);
    expect(view!.settings).toMatchObject({
      valueChainScope: 'not_decided',
      impactThreshold: 3.0,
      financialThreshold: 3.0,
      dmaConfirmedAt: null,
    });
    expect(view!.matters.every((m) => !m.persisted && m.outcome === 'not_assessed')).toBe(true);
    expect(view!.matters.every((m) => m.axes.impact.proposedMaterial === null)).toBe(true);
    await loadCsrdSettings(readOnly, manager(), fy2026);
    await loadCsrdMatterDetail(readOnly, manager(), fy2026, 'E1');
    expect(readOnly.writes).toEqual([]);
  });

  it('1 事項の画面: IRO のスコアと関連するインパクト。ESRS のテーマ以外は null', async () => {
    const detail = await loadCsrdMatterDetail(db, manager(), fy2026, 'E1');
    expect(detail!.iros.map((v) => [v.iro.iroType, v.impactScore, v.financialScore])).toEqual([
      ['impact', 4.0, null],
      ['risk', null, 4.0],
    ]);
    expect(detail!.iros[1]!.relatedImpactDescription).toBe('製造拠点の GHG 排出（架空）');
    expect(detail!.impactIroOptions).toHaveLength(1);
    expect(await loadCsrdMatterDetail(db, manager(), fy2026, 'E6')).toBeNull();
    expect(await loadCsrdMatterDetail(db, manager(), fy2026, 'esrs2')).toBeNull();
  });
});

describe('事項の判断', () => {
  it('評価済みの軸は根拠が必須', async () => {
    await expect(
      decideCsrdDmaMatter(db, manager(), {
        reportingPeriodId: PERIOD_IDS.fy2026,
        topic: 'G1',
        impactAssessment: 'not_material',
        impactRationale: '  ',
        financialAssessment: 'not_assessed',
        financialRationale: '',
        stakeholderNote: '',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      decideCsrdDmaMatter(db, manager(), {
        reportingPeriodId: PERIOD_IDS.fy2026,
        topic: 'G1',
        impactAssessment: 'not_assessed',
        impactRationale: '',
        financialAssessment: 'material',
        financialRationale: '',
        stakeholderNote: '',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('判断すると判断者と日時が残り、未評価に戻すと消える', async () => {
    const decided = await decideG1();
    expect(decided).toMatchObject({
      impactAssessment: 'not_material',
      financialAssessment: 'material',
      decidedBy: userId('sustainability@demo.local'),
    });
    expect(decided.decidedAt).not.toBeNull();
    const reset = await decideCsrdDmaMatter(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      topic: 'G1',
      impactAssessment: 'not_assessed',
      impactRationale: '',
      financialAssessment: 'not_assessed',
      financialRationale: '',
      stakeholderNote: '',
    });
    expect(reset.decidedAt).toBeNull();
    expect(reset.decidedBy).toBeNull();
  });

  it('行の無い期間で判断すると、事項の行を作る（同じ ID）', async () => {
    const decided = await decideCsrdDmaMatter(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2025,
      topic: 'E1',
      impactAssessment: 'material',
      impactRationale: '前年度も重要と判断（テスト）',
      financialAssessment: 'not_assessed',
      financialRationale: '',
      stakeholderNote: '',
    });
    const view = await loadCsrdSettings(db, manager(), fy2025);
    const e1 = view!.matters.find((m) => m.topic === 'E1')!;
    expect(e1.persisted).toBe(true);
    expect(e1.matter.id).toBe(decided.id);
    expect(
      fixture.csrdDmaMatters.filter((m) => m.reportingPeriodId === PERIOD_IDS.fy2025),
    ).toHaveLength(1);
  });

  it('存在しないテーマは判断できない', async () => {
    await expect(
      decideCsrdDmaMatter(db, manager(), {
        reportingPeriodId: PERIOD_IDS.fy2026,
        topic: 'E9',
        impactAssessment: 'not_assessed',
        impactRationale: '',
        financialAssessment: 'not_assessed',
        financialRationale: '',
        stakeholderNote: '',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('DMA の確定', () => {
  it('10 事項すべてを判断するまで確定できない（理由に未評価の事項を挙げる）', async () => {
    await expect(confirmCsrdDma(db, manager(), PERIOD_IDS.fy2026)).rejects.toThrow(/G1/);
    await decideG1();
    const settings = await confirmCsrdDma(db, manager(), PERIOD_IDS.fy2026);
    expect(settings.dmaConfirmedBy).toBe(userId('sustainability@demo.local'));
    expect(await confirmed()).toBe(true);
  });

  it('分析条件を保存していない期間・報告範囲が未決定・ステークホルダー関与が空なら確定できない', async () => {
    await expect(confirmCsrdDma(db, manager(), PERIOD_IDS.fy2025)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await decideG1();
    await saveCsrdMethod(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      impactThreshold: 3.0,
      financialThreshold: 3.0,
      methodNote: '',
      stakeholderEngagementNote: ' ',
    });
    await expect(confirmCsrdDma(db, manager(), PERIOD_IDS.fy2026)).rejects.toThrow(
      /ステークホルダー関与/,
    );
    await saveCsrdMethod(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      impactThreshold: 3.0,
      financialThreshold: 3.0,
      methodNote: '',
      stakeholderEngagementNote: '従業員への聞き取り（テスト）',
    });
    await saveCsrdBoundary(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      consolidationScope: 'same_as_financial',
      consolidationNote: '',
      includedUnitIds: [],
      valueChainScope: 'not_decided',
      valueChainNote: '',
    });
    await expect(confirmCsrdDma(db, manager(), PERIOD_IDS.fy2026)).rejects.toThrow(/報告範囲/);
  });

  it('DMA に関わる書込はすべて確定を外す（閾値・報告範囲・IRO の追加と削除・事項の判断）', async () => {
    await decideG1();
    const reconfirm = async () => {
      await confirmCsrdDma(db, manager(), PERIOD_IDS.fy2026);
      expect(await confirmed()).toBe(true);
    };

    await reconfirm();
    await saveCsrdMethod(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      impactThreshold: 3.5,
      financialThreshold: 3.0,
      methodNote: '閾値を見直し（テスト）',
      stakeholderEngagementNote: '従業員への聞き取り（テスト）',
    });
    expect(await confirmed()).toBe(false);

    await reconfirm();
    await saveCsrdBoundary(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      consolidationScope: 'same_as_financial',
      consolidationNote: '',
      includedUnitIds: [],
      valueChainScope: 'upstream',
      valueChainNote: '',
    });
    expect(await confirmed()).toBe(false);

    await reconfirm();
    const iro = await upsertCsrdDmaIro(db, manager(), {
      ...RISK,
      reportingPeriodId: PERIOD_IDS.fy2026,
      topic: 'E1',
    });
    expect(await confirmed()).toBe(false);

    await reconfirm();
    await deleteCsrdDmaIro(db, manager(), iro.id);
    expect(await confirmed()).toBe(false);

    await reconfirm();
    await decideG1();
    expect(await confirmed()).toBe(false);
  });

  it('読むだけでは確定を外さない', async () => {
    await decideG1();
    await confirmCsrdDma(db, manager(), PERIOD_IDS.fy2026);
    await loadCsrdSettings(db, manager(), fy2026);
    await loadCsrdMatterDetail(db, manager(), fy2026, 'G1');
    expect(await confirmed()).toBe(true);
  });
});

describe('評価方法・閾値', () => {
  it('閾値は 1.0〜5.0 の小数 1 桁', async () => {
    for (const bad of [0.5, 5.5, 3.05, Number.NaN]) {
      await expect(
        saveCsrdMethod(db, manager(), {
          reportingPeriodId: PERIOD_IDS.fy2026,
          impactThreshold: bad,
          financialThreshold: 3.0,
          methodNote: '',
          stakeholderEngagementNote: 'x',
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    const saved = await saveCsrdMethod(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      impactThreshold: 5,
      financialThreshold: 1,
      methodNote: '',
      stakeholderEngagementNote: 'x',
    });
    expect(saved).toMatchObject({ impactThreshold: 5, financialThreshold: 1 });
  });

  it('閾値を変えると提案だけが変わり、人の判断の結果は変わらない', async () => {
    await saveCsrdMethod(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      impactThreshold: 4.5,
      financialThreshold: 3.0,
      methodNote: '',
      stakeholderEngagementNote: 'x',
    });
    const view = await loadCsrdSettings(db, manager(), fy2026);
    const e1 = view!.matters.find((m) => m.topic === 'E1')!;
    expect(e1.axes.impact).toMatchObject({
      maxScore: 4.0,
      threshold: 4.5,
      proposedMaterial: false,
    });
    expect(e1.outcome).toBe('both');
  });

  it('報告対象の拠点は自組織のものに限る', async () => {
    const sotenUnit = fixture.units.find((u) => u.organizationId === ORG_IDS.soten)!;
    await expect(
      saveCsrdBoundary(db, manager(), {
        reportingPeriodId: PERIOD_IDS.fy2026,
        consolidationScope: 'same_as_financial',
        consolidationNote: '',
        includedUnitIds: [sotenUnit.id],
        valueChainScope: 'both',
        valueChainNote: '',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      saveCsrdBoundary(db, manager(), {
        reportingPeriodId: PERIOD_IDS.fy2026,
        consolidationScope: 'custom',
        consolidationNote: '',
        includedUnitIds: [],
        valueChainScope: 'both',
        valueChainNote: '',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('IRO', () => {
  it('不正な形は保存しない（リスクに人権フラグ・インパクトに財務の値）', async () => {
    await expect(
      upsertCsrdDmaIro(db, manager(), {
        ...RISK,
        humanRights: true,
        reportingPeriodId: PERIOD_IDS.fy2026,
        topic: 'E1',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      upsertCsrdDmaIro(db, manager(), {
        ...RISK,
        iroType: 'impact',
        reportingPeriodId: PERIOD_IDS.fy2026,
        topic: 'E1',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('関連するインパクトは同じ事項のインパクト IRO に限る', async () => {
    await expect(
      upsertCsrdDmaIro(db, manager(), {
        ...RISK,
        relatedImpactIroId: CSRD_IDS.iros.E3.impact,
        reportingPeriodId: PERIOD_IDS.fy2026,
        topic: 'E1',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      upsertCsrdDmaIro(db, manager(), {
        ...RISK,
        relatedImpactIroId: CSRD_IDS.iros.E1.financial,
        reportingPeriodId: PERIOD_IDS.fy2026,
        topic: 'E1',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const ok = await upsertCsrdDmaIro(db, manager(), {
      ...RISK,
      relatedImpactIroId: CSRD_IDS.iros.E1.impact,
      reportingPeriodId: PERIOD_IDS.fy2026,
      topic: 'E1',
    });
    expect(ok.relatedImpactIroId).toBe(CSRD_IDS.iros.E1.impact);
  });

  it('更新は同じ事項の IRO だけ。別の事項の IRO を指定すると見つからない扱い', async () => {
    const updated = await upsertCsrdDmaIro(db, manager(), {
      ...RISK,
      financialLikelihood: 5,
      iroId: CSRD_IDS.iros.E1.financial,
      reportingPeriodId: PERIOD_IDS.fy2026,
      topic: 'E1',
    });
    expect(updated.id).toBe(CSRD_IDS.iros.E1.financial);
    expect(updated.financialLikelihood).toBe(5);
    await expect(
      upsertCsrdDmaIro(db, manager(), {
        ...RISK,
        iroId: CSRD_IDS.iros.E3.financial,
        reportingPeriodId: PERIOD_IDS.fy2026,
        topic: 'E1',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('インパクト IRO を削除すると、それを関連先にしていたリスクから参照を外す（論理削除）', async () => {
    await deleteCsrdDmaIro(db, manager(), CSRD_IDS.iros.E1.impact);
    const deleted = fixture.csrdDmaIros.find((i) => i.id === CSRD_IDS.iros.E1.impact)!;
    expect(deleted.deletedAt).not.toBeNull();
    const risk = fixture.csrdDmaIros.find((i) => i.id === CSRD_IDS.iros.E1.financial)!;
    expect(risk.relatedImpactIroId).toBeNull();
    const view = await loadCsrdSettings(db, manager(), fy2026);
    const e1 = view!.matters.find((m) => m.topic === 'E1')!;
    expect(e1.iros.map((i) => i.id)).toEqual([CSRD_IDS.iros.E1.financial]);
    expect(e1.axes.impact.proposedMaterial).toBeNull();
    // 論理削除した IRO は二度削除できない
    await expect(deleteCsrdDmaIro(db, manager(), CSRD_IDS.iros.E1.impact)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('権限と他組織', () => {
  it('開示の編集権限が無い役割は保存・確定できない（閲覧はできる）', async () => {
    await expect(decideG1(approverOnly())).rejects.toBeInstanceOf(AuthorizationError);
    await expect(confirmCsrdDma(db, approverOnly(), PERIOD_IDS.fy2026)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(
      upsertCsrdDmaIro(db, approverOnly(), {
        ...RISK,
        reportingPeriodId: PERIOD_IDS.fy2026,
        topic: 'E1',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(await loadCsrdSettings(db, approverOnly(), fy2026)).not.toBeNull();
  });

  it('開示の閲覧権限も無い役割は読めない', async () => {
    await expect(loadCsrdSettings(db, site(), fy2026)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('他組織の期間・行は扱えない', async () => {
    await expect(decideG1(otherOrg())).rejects.toBeInstanceOf(ValidationError);
    await expect(loadCsrdSettings(db, otherOrg(), fy2026)).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteCsrdDmaIro(db, otherOrg(), CSRD_IDS.iros.E1.impact)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // 企業 A の行は変わっていない
    expect(fixture.csrdDmaIros.find((i) => i.id === CSRD_IDS.iros.E1.impact)!.deletedAt).toBeNull();
  });
});
