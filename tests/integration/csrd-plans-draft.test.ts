import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { CSRD_COLLECTION_UNIT_IDS, CSRD_IDS } from '@/lib/fixtures/csrd';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, metricId, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
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
  type CreateCsrdActionPlanInput,
} from '@/lib/services/csrd/plans';
import { confirmCsrdDma, decideCsrdDmaMatter } from '@/lib/services/csrd/settings';
import type { AuthorizationContext, ReportingPeriod, RoleKey } from '@/types/domain';
import { WriteDetectingDbClient } from '../support/write-detecting-db';

/**
 * CSRD の対応計画・データ収集・開示ドラフト（docs/disclosure-first.md §9.4）。
 *  - 計画は評価対象の要求事項だけ（評価行が無ければ作る）
 *  - 収集項目の新しい指標は出所が CSRD（frameworks = ['csrd']）
 *  - 草案は評価対象の節だけ・ai_body だけを書く・確定済みの節は作り直せない
 *  - 本文への採用・保存・確定は人。確定は DMA の確定後・本文ありのとき
 */

let fixture: FixtureDb;
let db: DemoDbClient;
let fy2026: ReportingPeriod;
let fy2025: ReportingPeriod;

function ctxFor(email: string, roleKeys: RoleKey[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
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
/** 開示の編集権限はあるが、指標の管理・AI の実行権限は無い */
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const REF = { referenceDate: '2026-08-14' };
const item = (code: string) => CSRD_IDS.items[code]!;

function planInput(code: string, overrides: Partial<CreateCsrdActionPlanInput> = {}) {
  return {
    reportingPeriodId: PERIOD_IDS.fy2026,
    itemId: item(code),
    gapKind: 'data' as const,
    title: 'Scope2 ロケーション基準の収集方法を決める（テスト）',
    detail: '',
    actionType: 'data_collection' as const,
    department: 'サステナビリティ推進部',
    assigneeUserId: userId('sustainability@demo.local'),
    dueDate: '2026-11-30',
    priority: 'high' as const,
    ...overrides,
  };
}

beforeEach(async () => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  fy2026 = (await db.findById('periods', PERIOD_IDS.fy2026))!;
  fy2025 = (await db.findById('periods', PERIOD_IDS.fy2025))!;
});

async function confirmDmaWithG1() {
  await decideCsrdDmaMatter(db, manager(), {
    reportingPeriodId: PERIOD_IDS.fy2026,
    topic: 'G1',
    impactAssessment: 'not_material',
    impactRationale: '算定結果 2.2 で閾値未満（テスト）',
    financialAssessment: 'material',
    financialRationale: '制裁金の算定結果 3.2 が閾値以上（テスト）',
    stakeholderNote: '',
  });
  await confirmCsrdDma(db, manager(), PERIOD_IDS.fy2026);
}

describe('対応計画', () => {
  it('Fixture の 2 件（E1-4 開示・対応中、S1-9 データ・未着手）', async () => {
    const plans = await loadCsrdActionPlans(db, manager(), fy2026, REF);
    expect(
      plans.map((p) => [
        p.item?.code,
        p.plan.gapKind,
        p.plan.status,
        p.plan.priority,
        p.outOfScope,
      ]),
    ).toEqual([
      ['ESRS-E1-4', 'disclosure', 'in_progress', 'high', false],
      ['ESRS-S1-9', 'data', 'not_started', 'medium', false],
    ]);
    expect(plans[0]!.assigneeName).toBe('海野 みどり');
    expect(plans[0]!.daysLeft).toBe(108);
  });

  it('評価対象の要求事項に計画を立て、状態を更新できる', async () => {
    const plan = await createCsrdActionPlan(db, manager(), planInput('ESRS-E1-6'));
    expect(plan).toMatchObject({
      status: 'not_started',
      assessmentId: CSRD_IDS.assessments['ESRS-E1-6'],
    });
    const updated = await updateCsrdActionPlan(db, manager(), {
      planId: plan.id,
      status: 'in_progress',
      department: '環境管理部',
      assigneeUserId: null,
      dueDate: null,
      priority: 'medium',
    });
    expect(updated).toMatchObject({
      status: 'in_progress',
      department: '環境管理部',
      dueDate: null,
    });
  });

  it('対象外・未判定の要求事項には立てられない', async () => {
    for (const code of ['ESRS-E5-5', 'ESRS-G1-1']) {
      await expect(createCsrdActionPlan(db, manager(), planInput(code))).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });

  it('評価行が無ければ作る（行の無い期間の ESRS 2）', async () => {
    const plan = await createCsrdActionPlan(
      db,
      manager(),
      planInput('ESRS2-GOV-1', { reportingPeriodId: PERIOD_IDS.fy2025 }),
    );
    const assessment = fixture.csrdAssessments.find((a) => a.id === plan.assessmentId)!;
    expect(assessment).toMatchObject({
      reportingPeriodId: PERIOD_IDS.fy2025,
      itemId: item('ESRS2-GOV-1'),
      finalStatus: null,
    });
  });

  it('入力の検査（空の対応内容・他組織の担当者・不正な期限）', async () => {
    await expect(
      createCsrdActionPlan(db, manager(), planInput('ESRS-E1-6', { title: ' ' })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createCsrdActionPlan(
        db,
        manager(),
        planInput('ESRS-E1-6', { assigneeUserId: userId('other-enterprise-admin@demo.local') }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createCsrdActionPlan(db, manager(), planInput('ESRS-E1-6', { dueDate: '2026/11/30' })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('計画の後に重要でないと判断した事項の計画は「対象外の要求事項」になる', async () => {
    await decideCsrdDmaMatter(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      topic: 'E1',
      impactAssessment: 'not_material',
      impactRationale: '見直し（テスト）',
      financialAssessment: 'not_material',
      financialRationale: '見直し（テスト）',
      stakeholderNote: '',
    });
    const plans = await loadCsrdActionPlans(db, manager(), fy2026, REF);
    expect(plans.find((p) => p.item?.code === 'ESRS-E1-4')!.outOfScope).toBe(true);
    expect(plans.find((p) => p.item?.code === 'ESRS-S1-9')!.outOfScope).toBe(false);
  });
});

describe('データ収集', () => {
  it('Fixture: S1-9 の計画の収集項目（EU・JV）と、評価対象の要求事項 × 指標 × 拠点の状況', async () => {
    const collection = await loadCsrdDataCollection(db, manager(), fy2026, REF);
    expect(
      collection.planRows.map((r) => [r.item?.code, r.metricCode, r.unitName, r.state]),
    ).toEqual([
      [
        'ESRS-S1-9',
        'female_manager_ratio',
        fixture.units.find((u) => u.id === UNIT_IDS.eu)!.name,
        'not_entered',
      ],
      [
        'ESRS-S1-9',
        'female_manager_ratio',
        fixture.units.find((u) => u.id === UNIT_IDS.jv)!.name,
        'not_entered',
      ],
    ]);
    expect(CSRD_COLLECTION_UNIT_IDS).toEqual([UNIT_IDS.eu, UNIT_IDS.jv]);
    // 評価対象でない E5-5（対象外）・G1（未判定）の指標は出さない
    const codes = new Set(collection.requirementRows.map((r) => r.item.code));
    expect(codes.has('ESRS-E5-5')).toBe(false);
    expect(codes.has('ESRS-E1-6')).toBe(true);
    // S1-9 の女性管理職比率: 本社は承認済み（値あり）、EU・JV は割当だけ（未入力）
    const ratio = collection.requirementRows.filter(
      (r) => r.metric.code === 'female_manager_ratio',
    );
    expect(ratio.map((r) => [r.unit?.code, r.state, r.value])).toEqual([
      ['HQ', 'approved', 18.3],
      ['EU', 'not_entered', null],
      ['JV', 'not_entered', null],
    ]);
  });

  it('新しい指標の収集項目は出所が CSRD。計画に指標を結び付け、未着手なら対応中にする', async () => {
    const plan = await createCsrdActionPlan(db, manager(), planInput('ESRS-E1-6'));
    const result = await createCsrdCollectionItem(db, manager(), {
      planId: plan.id,
      metricCode: 'csrd_test_new_metric',
      metricName: 'CSRD テスト用の新しい指標',
      unit: 't-CO2e',
      unitId: UNIT_IDS.hq,
      ownerUserId: userId('sustainability@demo.local'),
      dueDate: '2026-12-01',
      requiresEvidence: false,
      department: '環境管理部',
    });
    expect(result.metricCode).toBe('csrd_test_new_metric');
    const metric = fixture.metrics.find(
      (m) => m.organizationId === ORG_IDS.aomi && m.code === 'csrd_test_new_metric',
    )!;
    expect(metric.frameworks).toEqual(['csrd']);
    expect(metric.description).toContain('CSRD 対応計画');
    expect(
      fixture.metricAssignments.filter(
        (a) => a.metricId === metric.id && a.reportingPeriodId === PERIOD_IDS.fy2026,
      ),
    ).toHaveLength(1);
    const saved = fixture.csrdActionPlans.find((p) => p.id === plan.id)!;
    expect(saved).toMatchObject({
      linkedMetricCode: 'csrd_test_new_metric',
      status: 'in_progress',
    });
  });

  it('既存の指標（scope2_location）は作り直さず、割当だけを作る（出所は変えない）', async () => {
    const plan = await createCsrdActionPlan(db, manager(), planInput('ESRS-E1-6'));
    const before = fixture.metrics.filter((m) => m.organizationId === ORG_IDS.aomi).length;
    await createCsrdCollectionItem(db, manager(), {
      planId: plan.id,
      metricCode: 'scope2_location',
      metricName: 'Scope2（ロケーション基準）',
      unit: 't-CO2e',
      unitId: UNIT_IDS.east,
      ownerUserId: null,
      dueDate: '2026-12-01',
      requiresEvidence: false,
      department: '',
    });
    expect(fixture.metrics.filter((m) => m.organizationId === ORG_IDS.aomi)).toHaveLength(before);
    const metric = fixture.metrics.find((m) => m.id === metricId('AOMI', 'scope2_location'))!;
    expect(metric.frameworks).toEqual(['ssbj', 'cdp']);
    const collection = await loadCsrdDataCollection(db, manager(), fy2026, REF);
    expect(
      collection.planRows.filter((r) => r.metricCode === 'scope2_location').map((r) => r.state),
    ).toEqual(['not_entered']);
  });

  it('指標の管理権限が無い役割・他組織の拠点では作れない', async () => {
    await expect(
      createCsrdCollectionItem(db, reviewer(), {
        planId: CSRD_IDS.plans.s1FemaleManagers,
        metricCode: 'female_manager_ratio',
        metricName: '女性管理職比率',
        unit: '%',
        unitId: UNIT_IDS.hq,
        ownerUserId: null,
        dueDate: '2026-12-01',
        requiresEvidence: false,
        department: '',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    const sotenUnit = fixture.units.find((u) => u.organizationId === ORG_IDS.soten)!;
    await expect(
      createCsrdCollectionItem(db, manager(), {
        planId: CSRD_IDS.plans.s1FemaleManagers,
        metricCode: 'female_manager_ratio',
        metricName: '女性管理職比率',
        unit: '%',
        unitId: sotenUnit.id,
        ownerUserId: null,
        dueDate: '2026-12-01',
        requiresEvidence: false,
        department: '',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('開示ドラフト', () => {
  it('節はマスターに要求事項のある 6 つ。対象外・未判定の節は作れない理由を出す', async () => {
    const overview = await loadCsrdDrafts(db, manager(), fy2026);
    expect(overview!.sections.map((s) => s.section)).toEqual([
      'ESRS2',
      'E1',
      'E3',
      'E5',
      'S1',
      'G1',
    ]);
    const by = Object.fromEntries(overview!.sections.map((s) => [s.section, s]));
    expect(by.E5!.generatable).toBe(false);
    expect(by.E5!.generateBlockedReason).toContain('対象外');
    expect(by.G1!.generateBlockedReason).toContain('未評価');
    // ESRS 2 は人が確定済み（作り直せない）、S1 は AI 草案のみ（本文未採用）
    expect(by.ESRS2!.draft?.confirmedAt).not.toBeNull();
    expect(by.ESRS2!.generatable).toBe(false);
    expect(by.S1!.draft).toMatchObject({ body: '' });
    expect(by.S1!.draft!.aiBody).toContain('両面');
    expect(by.E1!.generatable).toBe(true);
    expect(by.E1!.draft).toBeNull();
    expect(overview!.confirmedCount).toBe(1);
  });

  it('草案は ai_body だけを書き、本文は変えない。対象外・未判定・確定済みの節は不可', async () => {
    const draft = await generateCsrdDraft(db, manager(), fy2026, 'E1');
    expect(draft.body).toBe('');
    expect(draft.aiBody).toContain('インパクトと財務の両面で重要と判断');
    expect(draft.aiBody.length).toBeLessThanOrEqual(600);
    expect(draft.aiRunId).not.toBeNull();
    expect(draft.confirmedAt).toBeNull();
    for (const section of ['E5', 'G1', 'ESRS2'] as const) {
      await expect(generateCsrdDraft(db, manager(), fy2026, section)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    // 既存の S1 は AI 草案だけを差し替え、本文（空）はそのまま
    const s1 = await generateCsrdDraft(db, manager(), fy2026, 'S1');
    expect(s1.body).toBe('');
    expect(s1.id).toBe(CSRD_IDS.drafts.s1);
  });

  it('採用 → 保存 → 確定は人。確定は DMA の確定後・本文ありのときだけ', async () => {
    const generated = await generateCsrdDraft(db, manager(), fy2026, 'E1');
    const adopted = await adoptCsrdDraft(db, manager(), generated.id);
    expect(adopted.body).toBe(generated.aiBody);
    expect(fixture.aiRuns.find((r) => r.id === generated.aiRunId)!.status).toBe('accepted');

    const saved = await saveCsrdDraftBody(
      db,
      manager(),
      generated.id,
      `${adopted.body}（人が加筆）`,
    );
    expect(saved.body).toContain('人が加筆');
    // DMA が未確定のうちは確定できない
    await expect(confirmCsrdDraft(db, manager(), generated.id)).rejects.toThrow(/DMA/);

    await confirmDmaWithG1();
    const confirmed = await confirmCsrdDraft(db, manager(), generated.id);
    expect(confirmed.confirmedBy).toBe(userId('sustainability@demo.local'));
    // 確定済みの節は作り直せない。本文を保存すると確定が外れる
    await expect(generateCsrdDraft(db, manager(), fy2026, 'E1')).rejects.toBeInstanceOf(
      ValidationError,
    );
    const resaved = await saveCsrdDraftBody(db, manager(), generated.id, confirmed.body);
    expect(resaved.confirmedAt).toBeNull();

    // 本文が空なら確定できない
    const emptied = await saveCsrdDraftBody(db, manager(), generated.id, '   ');
    await expect(confirmCsrdDraft(db, manager(), emptied.id)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('草案の無い節は採用できない・本文の上限を超えて保存できない', async () => {
    await expect(adoptCsrdDraft(db, manager(), CSRD_IDS.drafts.esrs2)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      saveCsrdDraftBody(db, manager(), CSRD_IDS.drafts.s1, 'あ'.repeat(3001)),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('AI の実行権限が無い役割は草案を作れない', async () => {
    await expect(generateCsrdDraft(db, reviewer(), fy2026, 'E1')).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});

describe('読込関数は書かない', () => {
  it('計画・収集・ドラフトの読込（行の有無の両方の期間）', async () => {
    const readOnly = new WriteDetectingDbClient(db);
    for (const period of [fy2026, fy2025]) {
      await loadCsrdActionPlans(readOnly, manager(), period, REF);
      await loadCsrdDataCollection(readOnly, manager(), period, REF);
      await loadCsrdDrafts(readOnly, manager(), period);
    }
    expect(readOnly.writes).toEqual([]);
  });
});
