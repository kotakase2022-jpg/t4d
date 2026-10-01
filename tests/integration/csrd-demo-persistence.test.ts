import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRD_IDS } from '@/lib/fixtures/csrd';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, metricId, userId } from '@/lib/fixtures/dataset';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { applyDemoEdits, type DemoEdit } from '@/lib/repositories/demo-edit-codec';
import {
  COOKIE_CHUNKS,
  MAX_BYTES_PER_COOKIE,
  demoEditsWereEvicted,
  readDemoEdits,
} from '@/lib/repositories/demo-persistence';
import {
  DISCLOSURE_DEMO_RESET_TABLES,
  restoreDisclosureDemoTables,
} from '@/lib/repositories/demo-reset-sync';
import {
  adoptCsrdDraft,
  confirmCsrdDraft,
  generateCsrdDraft,
  loadCsrdDrafts,
  saveCsrdDraftBody,
} from '@/lib/services/csrd/draft';
import {
  createCsrdActionPlan,
  createCsrdCollectionItem,
  loadCsrdActionPlans,
  loadCsrdDataCollection,
  updateCsrdActionPlan,
} from '@/lib/services/csrd/plans';
import {
  loadCsrdOverview,
  loadCsrdRequirementViews,
  reviewCsrdAssessment,
  runCsrdGapAnalysis,
} from '@/lib/services/csrd/requirements';
import { confirmCsrdDma, decideCsrdDmaMatter } from '@/lib/services/csrd/settings';
import { resetDisclosureDemoData } from '@/lib/services/disclosure-demo-reset';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * CSRD の編集が別インスタンスでも残る（docs/disclosure-first.md §9.3「デモ永続化」、
 * docs/known-limitations.md D-3）。
 *
 * next/headers の cookies() をテスト用の入れ物に差し替え、操作ごとに Fixture を作り直して
 * Cookie の操作だけを適用した DB（すべてのリクエストが別インスタンスに届く最悪の場合）で
 * §9.7 の zzz-csrd-chain の流れを最後まで進める。偽の Cookie は DB と同じ規則で拒否する。
 */

const jar = vi.hoisted(() => new Map<string, string>());

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string, options?: { maxAge?: number }) => {
      if (options?.maxAge === 0 || value === '') jar.delete(name);
      else jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
}));

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
const REF = { referenceDate: '2026-08-14' };
const CSRD_TABLES = [
  'csrdAnalysisSettings',
  'csrdDmaMatters',
  'csrdDmaIros',
  'csrdAssessments',
  'csrdActionPlans',
  'csrdDisclosureDrafts',
] as const;

/** 起動直後の別インスタンス: Fixture を作り直し、Cookie の操作だけを適用する（getDb と同じ手順） */
async function fresh(): Promise<{ db: DemoDbClient; fixture: FixtureDb }> {
  const fixture = createFixtureDb();
  applyDemoEdits(fixture, await readDemoEdits());
  return { db: new DemoDbClient(fixture), fixture };
}

async function period(db: DemoDbClient) {
  return (await db.findById('periods', PERIOD_IDS.fy2026))!;
}

function editsBytes(): number {
  return [...jar.entries()]
    .filter(([name]) => name.startsWith('t4d.demo-edits'))
    .reduce((sum, [, value]) => sum + value.length, 0);
}

beforeEach(() => {
  jar.clear();
  delete (globalThis as { __t4dAppliedDemoResets?: unknown }).__t4dAppliedDemoResets;
});

/** §9.7 の zzz-csrd-chain と同じ流れ（操作ごとに別インスタンス） */
async function playChain(): Promise<{ planId: string; draftId: string }> {
  // 設定: G1 をインパクト=重要でない・財務=重要と判断 → DMA を確定
  await decideCsrdDmaMatter((await fresh()).db, manager(), {
    reportingPeriodId: PERIOD_IDS.fy2026,
    topic: 'G1',
    impactAssessment: 'not_material',
    impactRationale: '贈収賄への関与の算定結果 2.2 で閾値未満（E2E）',
    financialAssessment: 'material',
    financialRationale: '制裁金の算定結果 3.2 が閾値以上（E2E）',
    stakeholderNote: '',
  });
  await confirmCsrdDma((await fresh()).db, manager(), PERIOD_IDS.fy2026);

  // E1-6 の AI 分析（デモ生成）→ 候補を採用 → 対応計画を追加 → 対応中へ
  const { assessment } = await runCsrdGapAnalysis((await fresh()).db, manager(), {
    reportingPeriodId: PERIOD_IDS.fy2026,
    itemId: CSRD_IDS.items['ESRS-E1-6']!,
  });
  await reviewCsrdAssessment((await fresh()).db, manager(), {
    assessmentId: assessment.id,
    decision: 'approved',
    comment: '',
  });
  const plan = await createCsrdActionPlan((await fresh()).db, manager(), {
    reportingPeriodId: PERIOD_IDS.fy2026,
    itemId: CSRD_IDS.items['ESRS-E1-6']!,
    gapKind: 'data',
    title: 'Scope2 ロケーション基準の排出量を集める（架空）',
    detail: '',
    actionType: 'data_collection',
    department: '環境管理部',
    assigneeUserId: userId('sustainability@demo.local'),
    dueDate: '2026-11-30',
    priority: 'high',
  });
  await updateCsrdActionPlan((await fresh()).db, manager(), {
    planId: plan.id,
    status: 'in_progress',
    department: '環境管理部',
    assigneeUserId: userId('sustainability@demo.local'),
    dueDate: '2026-11-30',
    priority: 'high',
  });
  // 収集画面で scope2_location の収集項目を作る
  await createCsrdCollectionItem((await fresh()).db, manager(), {
    planId: plan.id,
    metricCode: 'scope2_location',
    metricName: 'Scope2（ロケーション基準）',
    unit: 't-CO2e',
    unitId: UNIT_IDS.hq,
    ownerUserId: userId('sustainability@demo.local'),
    dueDate: '2026-12-01',
    requiresEvidence: false,
    department: '環境管理部',
  });

  // 開示ドラフト E1: 生成 → 本文に採用 → 保存 → 確定
  const generated = await generateCsrdDraft(
    (await fresh()).db,
    manager(),
    await period((await fresh()).db),
    'E1',
  );
  await adoptCsrdDraft((await fresh()).db, manager(), generated.id);
  await saveCsrdDraftBody(
    (await fresh()).db,
    manager(),
    generated.id,
    `${generated.aiBody}（人が確認して加筆）`,
  );
  await confirmCsrdDraft((await fresh()).db, manager(), generated.id);
  return { planId: plan.id, draftId: generated.id };
}

describe('CSRD の流れは、すべてのリクエストが別インスタンスに届いても最後まで進む', () => {
  it('DMA 確定 → AI 分析と採用 → 計画 → 収集項目 → 草案の採用・保存・確定が Cookie から戻る', async () => {
    const { planId, draftId } = await playChain();
    const { db, fixture } = await fresh();
    const fy2026 = await period(db);

    const overview = await loadCsrdOverview(db, manager(), fy2026, REF);
    expect(overview!.dma.confirmed).toBe(true);
    expect(overview!.applicabilityCounts).toMatchObject({ inScope: 11, provisional: 0 });
    const views = await loadCsrdRequirementViews(db, manager(), fy2026, REF);
    for (const code of ['ESRS-G1-1', 'ESRS-G1-4']) {
      expect(views!.views.find((v) => v.item.code === code)!.applicability).toMatchObject({
        kind: 'material',
        perspectives: ['financial'],
        provisional: false,
      });
    }
    const e16 = views!.views.find((v) => v.item.code === 'ESRS-E1-6')!;
    expect(e16.reviewState).toBe('human');
    expect(e16.assessment!.reviewDecision).toBe('approved');
    expect(e16.assessment!.finalStatus).toBe(e16.assessment!.aiStatus);

    const plans = await loadCsrdActionPlans(db, manager(), fy2026, REF);
    expect(plans.find((p) => p.plan.id === planId)!.plan).toMatchObject({
      status: 'in_progress',
      linkedMetricCode: 'scope2_location',
    });
    const collection = await loadCsrdDataCollection(db, manager(), fy2026, REF);
    expect(
      collection.planRows.filter((r) => r.plan.id === planId).map((r) => [r.metricCode, r.state]),
    ).toEqual([['scope2_location', 'not_entered']]);
    expect(
      fixture.metricAssignments.some(
        (a) =>
          a.metricId === metricId('AOMI', 'scope2_location') &&
          a.unitId === UNIT_IDS.hq &&
          a.reportingPeriodId === PERIOD_IDS.fy2026,
      ),
    ).toBe(true);

    const drafts = await loadCsrdDrafts(db, manager(), fy2026);
    const e1 = drafts!.sections.find((s) => s.section === 'E1')!;
    expect(e1.draft!.id).toBe(draftId);
    expect(e1.draft!.body).toContain('インパクトと財務の両面で重要と判断');
    expect(e1.draft!.body).toContain('（人が確認して加筆）');
    expect(e1.draft!.confirmedAt).not.toBeNull();
    // E5 は対象外のまま（草案を作れない）
    expect(drafts!.sections.find((s) => s.section === 'E5')!.generateBlockedReason).toContain(
      '対象外',
    );

    // 押し出しが起きず、Cookie の上限（3 × 3,800B）に収まる
    expect(await demoEditsWereEvicted()).toBe(false);
    expect(editsBytes()).toBeLessThan(COOKIE_CHUNKS * MAX_BYTES_PER_COOKIE);
    console.warn(
      `[csrd-chain] Cookie（操作の記録）: 流れの終わり ${editsBytes()}B（上限 ${COOKIE_CHUNKS}×${MAX_BYTES_PER_COOKIE}B）`,
    );
  });

  it('同じインスタンスへ Cookie を適用し直しても、行は増えず状態も変わらない', async () => {
    await playChain();
    const { fixture } = await fresh();
    const before = structuredClone(CSRD_TABLES.map((t) => fixture[t]));
    const assignments = fixture.metricAssignments.length;
    applyDemoEdits(fixture, await readDemoEdits());
    expect(CSRD_TABLES.map((t) => fixture[t])).toEqual(before);
    expect(fixture.metricAssignments).toHaveLength(assignments);
  });

  it('開示デモのリセットで CSRD の 6 表が Fixture の初期値へ戻り、Cookie と CSRD の AI 実行からも消える', async () => {
    expect(DISCLOSURE_DEMO_RESET_TABLES).toEqual(expect.arrayContaining([...CSRD_TABLES]));
    await playChain();
    const { db, fixture } = await fresh();
    const pristine = createFixtureDb();
    await resetDisclosureDemoData(db, manager(), { pristine });
    for (const table of CSRD_TABLES) {
      const own = <T extends { organizationId: string }>(rows: T[]) =>
        rows.filter((r) => r.organizationId === ORG_IDS.aomi);
      expect(own(fixture[table] as Array<{ organizationId: string }>), table).toEqual(
        own(pristine[table] as Array<{ organizationId: string }>),
      );
    }
    expect(
      fixture.aiRuns.filter(
        (r) => r.featureType === 'csrdGapAnalysis' || r.featureType === 'csrdDisclosureDraft',
      ),
    ).toEqual([]);
    const edits = await readDemoEdits();
    expect(edits.filter((e) => (CSRD_TABLES as readonly string[]).includes(e.t))).toEqual([]);
    // 別インスタンスにも同じリセットを反映できる（restoreDisclosureDemoTables）
    const other = createFixtureDb();
    await decideCsrdDmaMatter(new DemoDbClient(other), manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      topic: 'G1',
      impactAssessment: 'material',
      impactRationale: '別インスタンス（テスト）',
      financialAssessment: 'material',
      financialRationale: '別インスタンス（テスト）',
      stakeholderNote: '',
    });
    restoreDisclosureDemoTables(other, createFixtureDb(), ORG_IDS.aomi);
    expect(other.csrdDmaMatters).toEqual(pristine.csrdDmaMatters);
  });
});

// ----------------------------------------------------------------------
// 偽の Cookie（Fixture DB はインスタンスの全利用者で共有される）
// ----------------------------------------------------------------------

describe('偽の Cookie の CSRD の行は、DB と同じ規則で拒否する', () => {
  const AUTHOR = userId('sustainability@demo.local');
  const SOTEN_ADMIN = userId('other-enterprise-admin@demo.local');
  const NOW = '2026-10-01T00:00:00.000Z';

  function apply(edits: DemoEdit[]): FixtureDb {
    const db = createFixtureDb();
    applyDemoEdits(db, edits);
    return db;
  }

  function assessmentRow(overrides: Record<string, unknown>) {
    const base = structuredClone(
      createFixtureDb().csrdAssessments.find((a) => a.id === CSRD_IDS.assessments['ESRS-E1-6'])!,
    );
    return { ...base, ...overrides };
  }

  it('CSRD の評価に SSBJ の要求事項は入らない（ガードトリガと同じ）', () => {
    const pristine = createFixtureDb();
    const ssbjItem = pristine.disclosureItems.find((i) => i.code.startsWith('気候-'))!;
    const id = fid('csrd_assessment', 'forged/ssbj');
    const db = apply([
      {
        t: 'csrdAssessments',
        id,
        v: assessmentRow({ id, itemId: ssbjItem.id, reportingPeriodId: PERIOD_IDS.fy2025 }),
      },
    ]);
    expect(db.csrdAssessments.some((a) => a.id === id)).toBe(false);
  });

  it('権限の無い人の名義・他組織の期間を名乗る行は戻さない', () => {
    const db = apply([
      // 他社の管理者の名義で、企業 A の事項の判断を書き換える
      {
        t: 'csrdDmaMatters',
        id: CSRD_IDS.matters.G1,
        v: {
          impactAssessment: 'material',
          impactRationale: '偽',
          financialAssessment: 'material',
          financialRationale: '偽',
          decidedAt: NOW,
          decidedBy: SOTEN_ADMIN,
          updatedBy: SOTEN_ADMIN,
        },
      },
      // 企業 B の名義で企業 A の期間の分析条件を作る
      {
        t: 'csrdAnalysisSettings',
        id: fid('csrd_analysis_settings', 'forged/soten'),
        v: {
          ...structuredClone(createFixtureDb().csrdAnalysisSettings[0]!),
          id: fid('csrd_analysis_settings', 'forged/soten'),
          organizationId: ORG_IDS.soten,
          createdBy: SOTEN_ADMIN,
          updatedBy: SOTEN_ADMIN,
        },
      },
    ]);
    expect(db.csrdDmaMatters.find((m) => m.id === CSRD_IDS.matters.G1)!.impactAssessment).toBe(
      'not_assessed',
    );
    expect(db.csrdAnalysisSettings.some((s) => s.organizationId === ORG_IDS.soten)).toBe(false);
  });

  it('既にある行の組織・業務キーは書き換えさせない', () => {
    const db = apply([
      {
        t: 'csrdAssessments',
        id: CSRD_IDS.assessments['ESRS-E1-6']!,
        v: { organizationId: ORG_IDS.soten },
      },
      { t: 'csrdDmaMatters', id: CSRD_IDS.matters.E1, v: { esrsTopic: 'E2' } },
      { t: 'csrdDisclosureDrafts', id: CSRD_IDS.drafts.s1, v: { section: 'E1' } },
    ]);
    const pristine = createFixtureDb();
    expect(db.csrdAssessments).toEqual(pristine.csrdAssessments);
    expect(db.csrdDmaMatters).toEqual(pristine.csrdDmaMatters);
    expect(db.csrdDisclosureDrafts).toEqual(pristine.csrdDisclosureDrafts);
  });

  it('条件を満たさない DMA の確定は外し、ほかの変更（閾値）は受け付ける', () => {
    const db = apply([
      {
        t: 'csrdAnalysisSettings',
        id: CSRD_IDS.settings,
        v: { impactThreshold: 3.5, dmaConfirmedAt: NOW, dmaConfirmedBy: AUTHOR, updatedBy: AUTHOR },
      },
    ]);
    const settings = db.csrdAnalysisSettings.find((s) => s.id === CSRD_IDS.settings)!;
    // G1 が未評価のままなので確定は名乗れない
    expect(settings.dmaConfirmedAt).toBeNull();
    expect(settings.dmaConfirmedBy).toBeNull();
    expect(settings.impactThreshold).toBe(3.5);
  });

  it('G1 の判断が同じ Cookie で戻れば、確定も受け付ける（事項 → 分析条件の順で戻す）', () => {
    const db = apply([
      // 追記の順は分析条件が先でも、事項を先に戻してから確定の条件を確かめる
      {
        t: 'csrdAnalysisSettings',
        id: CSRD_IDS.settings,
        v: { dmaConfirmedAt: NOW, dmaConfirmedBy: AUTHOR, updatedBy: AUTHOR },
        n: 1,
      },
      {
        t: 'csrdDmaMatters',
        id: CSRD_IDS.matters.G1,
        v: {
          impactAssessment: 'not_material',
          impactRationale: '根拠',
          financialAssessment: 'material',
          financialRationale: '根拠',
          decidedAt: NOW,
          decidedBy: AUTHOR,
          updatedBy: AUTHOR,
        },
        n: 2,
      },
    ]);
    expect(db.csrdAnalysisSettings.find((s) => s.id === CSRD_IDS.settings)!.dmaConfirmedAt).toBe(
      NOW,
    );
  });

  it('他組織の事項・評価を指す IRO・計画、不正な形の IRO は戻さない', () => {
    const pristine = createFixtureDb();
    const baseIro = structuredClone(
      pristine.csrdDmaIros.find((i) => i.id === CSRD_IDS.iros.E1.financial)!,
    );
    const basePlan = structuredClone(pristine.csrdActionPlans[0]!);
    const db = apply([
      {
        t: 'csrdDmaIros',
        id: 'forged-iro-1',
        v: {
          ...baseIro,
          id: 'forged-iro-1',
          organizationId: ORG_IDS.soten,
          reportingPeriodId: PERIOD_IDS.sotenFy2026,
          relatedImpactIroId: null,
          createdBy: SOTEN_ADMIN,
          updatedBy: SOTEN_ADMIN,
        },
      },
      {
        t: 'csrdDmaIros',
        id: 'forged-iro-2',
        v: { ...baseIro, id: 'forged-iro-2', humanRights: true, relatedImpactIroId: null },
      },
      {
        t: 'csrdActionPlans',
        id: 'forged-plan',
        v: {
          ...basePlan,
          id: 'forged-plan',
          organizationId: ORG_IDS.soten,
          reportingPeriodId: PERIOD_IDS.sotenFy2026,
          createdBy: SOTEN_ADMIN,
          updatedBy: SOTEN_ADMIN,
        },
      },
    ]);
    expect(db.csrdDmaIros.some((i) => i.id.startsWith('forged'))).toBe(false);
    expect(db.csrdActionPlans.some((p) => p.id === 'forged-plan')).toBe(false);
  });

  it('本文の無い確定・人の確認なしの最終判定・総合と食い違う最終判定は戻さない', () => {
    const db = apply([
      {
        t: 'csrdDisclosureDrafts',
        id: CSRD_IDS.drafts.s1,
        v: { confirmedAt: NOW, confirmedBy: AUTHOR, updatedBy: AUTHOR },
      },
      {
        t: 'csrdAssessments',
        id: CSRD_IDS.assessments['ESRS-E1-4']!,
        v: { finalStatus: 'covered', updatedBy: AUTHOR },
      },
      {
        t: 'csrdAssessments',
        id: CSRD_IDS.assessments['ESRS-E1-6']!,
        v: {
          finalStatus: 'covered',
          reviewedAt: NOW,
          reviewedBy: AUTHOR,
          updatedBy: AUTHOR,
        },
      },
    ]);
    const pristine = createFixtureDb();
    expect(db.csrdDisclosureDrafts).toEqual(pristine.csrdDisclosureDrafts);
    expect(db.csrdAssessments).toEqual(pristine.csrdAssessments);
  });

  it('他組織の指標・拠点の割当、同じ組み合わせの二重の割当は戻さない', () => {
    const pristine = createFixtureDb();
    const sotenMetric = pristine.metrics.find((m) => m.organizationId === ORG_IDS.soten)!;
    const existing = pristine.metricAssignments.find(
      (a) => a.metricId === metricId('AOMI', 'female_manager_ratio'),
    )!;
    const db = apply([
      {
        t: 'metricAssignments',
        id: 'forged-assignment-1',
        v: { ...structuredClone(existing), id: 'forged-assignment-1', metricId: sotenMetric.id },
      },
      {
        t: 'metricAssignments',
        id: 'forged-assignment-2',
        v: { ...structuredClone(existing), id: 'forged-assignment-2' },
      },
    ]);
    expect(db.metricAssignments).toEqual(pristine.metricAssignments);
  });

  it('正しい形の割当（指標の管理権限のある人の名義）は戻す（空振りテストでないことの確認）', () => {
    const pristine = createFixtureDb();
    const existing = pristine.metricAssignments.find(
      (a) => a.metricId === metricId('AOMI', 'female_manager_ratio'),
    )!;
    const db = apply([
      {
        t: 'metricAssignments',
        id: 'assignment-ok',
        v: {
          ...structuredClone(existing),
          id: 'assignment-ok',
          unitId: UNIT_IDS.west,
          createdBy: AUTHOR,
          updatedBy: AUTHOR,
        },
      },
    ]);
    expect(db.metricAssignments.some((a) => a.id === 'assignment-ok')).toBe(true);
  });
});
