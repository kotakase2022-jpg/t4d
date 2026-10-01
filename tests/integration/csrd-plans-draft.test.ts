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
import { PROMPT_VERSIONS, setAiProviderForTesting } from '@/lib/ai';
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
/** 別々のリクエストの操作として、更新日時（版）が同じミリ秒にならないよう間を空ける */
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));
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
      baseUpdatedAt: plan.updatedAt,
    });
    expect(updated).toMatchObject({
      status: 'in_progress',
      department: '環境管理部',
      dueDate: null,
    });
  });

  it('表示した後に別の操作（収集項目の作成で対応中へ進んだ）で変わった計画は、古い値で上書きしない', async () => {
    const plan = await createCsrdActionPlan(db, manager(), planInput('ESRS-E1-6'));
    await tick();
    // 別のタブで収集項目を作る → 計画は「対応中」になる
    await createCsrdCollectionItem(db, manager(), {
      planId: plan.id,
      metricCode: 'scope2_location',
      metricName: 'Scope2（ロケーション基準）',
      unit: 't-CO2e',
      unitId: UNIT_IDS.hq,
      ownerUserId: null,
      dueDate: '2026-12-01',
      requiresEvidence: false,
      department: '',
    });
    // 古いタブ（未着手のまま表示していた）から担当者だけ変えて「更新」
    await expect(
      updateCsrdActionPlan(db, manager(), {
        planId: plan.id,
        status: 'not_started',
        department: plan.department,
        assigneeUserId: userId('reviewer@demo.local'),
        dueDate: plan.dueDate,
        priority: plan.priority,
        baseUpdatedAt: plan.updatedAt,
      }),
    ).rejects.toThrow(/他の操作で内容が更新されています/);
    expect(fixture.csrdActionPlans.find((p) => p.id === plan.id)!.status).toBe('in_progress');
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
    expect(result).toEqual({
      metricCode: 'csrd_test_new_metric',
      metricCreated: true,
      assignmentCreated: true,
      planStatus: 'in_progress',
      planStatusChanged: true,
    });
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

  it('同じ指標 × 拠点 × 期間の割当が既にあれば作り直さず、結果でそれを返す（担当者・期限は既存のまま）', async () => {
    // E1-4（Fixture の対応中の計画）から、Fixture で割当済みの female_manager_ratio × EU を指定する
    const before = structuredClone(
      fixture.metricAssignments.find(
        (a) =>
          a.metricId === metricId('AOMI', 'female_manager_ratio') &&
          a.unitId === UNIT_IDS.eu &&
          a.reportingPeriodId === PERIOD_IDS.fy2026,
      )!,
    );
    const result = await createCsrdCollectionItem(db, manager(), {
      planId: CSRD_IDS.plans.e1Target,
      metricCode: 'female_manager_ratio',
      metricName: '女性管理職比率',
      unit: '%',
      unitId: UNIT_IDS.eu,
      ownerUserId: userId('reviewer@demo.local'),
      dueDate: '2027-01-31',
      requiresEvidence: false,
      department: '',
    });
    // 既存の割当を使い（作らない）、計画はもともと対応中なので状況は変わらない
    expect(result).toMatchObject({
      assignmentCreated: false,
      planStatus: 'in_progress',
      planStatusChanged: false,
    });
    const after = fixture.metricAssignments.find((a) => a.id === before.id)!;
    expect(after.ownerUserId).toBe(before.ownerUserId);
    expect(after.dueDate).toBe(before.dueDate);
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
    // ESRS 2 は人が書いた本文を保存済みで未確定（DMA が未確定のため確定できない）、S1 は AI 草案のみ（本文未採用）
    expect(by.ESRS2!.draft?.body).toContain('取締役会が監督');
    expect(by.ESRS2!.draft).toMatchObject({ confirmedAt: null, confirmedBy: null });
    expect(by.ESRS2!.confirmable).toBe(false);
    expect(by.ESRS2!.confirmBlockedReason).toContain('DMA');
    expect(by.ESRS2!.generatable).toBe(true);
    expect(by.S1!.draft).toMatchObject({ body: '' });
    expect(by.S1!.draft!.aiBody).toContain('両面');
    expect(by.E1!.generatable).toBe(true);
    expect(by.E1!.draft).toBeNull();
    expect(overview!.confirmedCount).toBe(0);
  });

  it('草案は ai_body だけを書き、本文は変えない。対象外・未判定・確定済みの節は不可', async () => {
    const draft = await generateCsrdDraft(db, manager(), fy2026, 'E1');
    expect(draft.body).toBe('');
    expect(draft.aiBody).toContain('インパクトと財務の両面で重要と判断');
    expect(draft.aiBody.length).toBeLessThanOrEqual(600);
    expect(draft.aiRunId).not.toBeNull();
    expect(draft.confirmedAt).toBeNull();
    for (const section of ['E5', 'G1'] as const) {
      await expect(generateCsrdDraft(db, manager(), fy2026, section)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    // ESRS 2（本文を保存済み・未確定）は AI 草案だけを作り、人の本文は変えない
    const esrs2 = await generateCsrdDraft(db, manager(), fy2026, 'ESRS2');
    expect(esrs2.body).toContain('取締役会が監督');
    expect(esrs2.aiBody).toContain('ESRS 2 全般開示');
    // 既存の S1 は AI 草案だけを差し替え、本文（空）はそのまま
    const s1 = await generateCsrdDraft(db, manager(), fy2026, 'S1');
    expect(s1.body).toBe('');
    expect(s1.id).toBe(CSRD_IDS.drafts.s1);
  });

  it('採用 → 保存 → 確定は人。確定は DMA の確定後・本文ありのときだけ', async () => {
    const generated = await generateCsrdDraft(db, manager(), fy2026, 'E1');
    const adopted = await adoptCsrdDraft(db, manager(), {
      draftId: generated.id,
      baseUpdatedAt: generated.updatedAt,
    });
    expect(adopted.body).toBe(generated.aiBody);
    expect(fixture.aiRuns.find((r) => r.id === generated.aiRunId)!.status).toBe('accepted');

    const saved = await saveCsrdDraftBody(db, manager(), {
      draftId: generated.id,
      body: `${adopted.body}（人が加筆）`,
      baseUpdatedAt: adopted.updatedAt,
    });
    expect(saved.body).toContain('人が加筆');
    // DMA が未確定のうちは確定できない
    await expect(
      confirmCsrdDraft(db, manager(), { draftId: generated.id, baseUpdatedAt: saved.updatedAt }),
    ).rejects.toThrow(/DMA/);

    await confirmDmaWithG1();
    const confirmed = await confirmCsrdDraft(db, manager(), {
      draftId: generated.id,
      baseUpdatedAt: saved.updatedAt,
    });
    expect(confirmed.confirmedBy).toBe(userId('sustainability@demo.local'));
    // 確定済みの節は作り直せない。本文を保存すると確定が外れる
    await expect(generateCsrdDraft(db, manager(), fy2026, 'E1')).rejects.toBeInstanceOf(
      ValidationError,
    );
    const resaved = await saveCsrdDraftBody(db, manager(), {
      draftId: generated.id,
      body: confirmed.body,
      baseUpdatedAt: confirmed.updatedAt,
    });
    expect(resaved.confirmedAt).toBeNull();

    // 本文が空なら確定できない
    const emptied = await saveCsrdDraftBody(db, manager(), {
      draftId: generated.id,
      body: '   ',
      baseUpdatedAt: resaved.updatedAt,
    });
    await expect(
      confirmCsrdDraft(db, manager(), { draftId: emptied.id, baseUpdatedAt: emptied.updatedAt }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('草案の無い節は採用できない・本文の上限を超えて保存できない', async () => {
    const esrs2 = fixture.csrdDisclosureDrafts.find((d) => d.id === CSRD_IDS.drafts.esrs2)!;
    await expect(
      adoptCsrdDraft(db, manager(), { draftId: esrs2.id, baseUpdatedAt: esrs2.updatedAt }),
    ).rejects.toBeInstanceOf(ValidationError);
    const s1 = fixture.csrdDisclosureDrafts.find((d) => d.id === CSRD_IDS.drafts.s1)!;
    await expect(
      saveCsrdDraftBody(db, manager(), {
        draftId: s1.id,
        body: 'あ'.repeat(3001),
        baseUpdatedAt: s1.updatedAt,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('表示した後に別の操作で変わった節は、保存・採用・確定しない（見ていない内容を上書き・確定しない）', async () => {
    const generated = await generateCsrdDraft(db, manager(), fy2026, 'E1');
    // タブ 1 は v1 の草案を表示したまま。タブ 2 が採用して人の本文を保存する
    // （別々のリクエストの操作なので、版（updatedAt）が同じミリ秒にならないよう間を空ける）
    await tick();
    const adopted = await adoptCsrdDraft(db, manager(), {
      draftId: generated.id,
      baseUpdatedAt: generated.updatedAt,
    });
    await tick();
    const otherSave = await saveCsrdDraftBody(db, reviewer(), {
      draftId: generated.id,
      body: `${adopted.body}（別の人の加筆）`,
      baseUpdatedAt: adopted.updatedAt,
    });
    // タブ 1 の保存は、表示した版が古いので断る（別の人の加筆を黙って消さない）
    await expect(
      saveCsrdDraftBody(db, manager(), {
        draftId: generated.id,
        body: 'タブ 1 の本文（テスト）',
        baseUpdatedAt: generated.updatedAt,
      }),
    ).rejects.toThrow(/他の操作で内容が更新されています/);
    // タブ 1 の「本文に採用」も断る（いまの本文を見ずに置き換えない）
    await expect(
      adoptCsrdDraft(db, manager(), { draftId: generated.id, baseUpdatedAt: generated.updatedAt }),
    ).rejects.toThrow(/他の操作で内容が更新されています/);
    await confirmDmaWithG1();
    // 確定も、表示した本文のままのときだけ
    await expect(
      confirmCsrdDraft(db, manager(), { draftId: generated.id, baseUpdatedAt: adopted.updatedAt }),
    ).rejects.toThrow(/他の操作で内容が更新されています/);
    // 版を送らない呼び出しも断る
    await expect(
      confirmCsrdDraft(db, manager(), { draftId: generated.id, baseUpdatedAt: '' }),
    ).rejects.toBeInstanceOf(ValidationError);
    const stored = fixture.csrdDisclosureDrafts.find((d) => d.id === generated.id)!;
    expect(stored.body).toBe(otherSave.body);
    expect(stored.confirmedAt).toBeNull();
    // いま表示している版なら確定できる（空振りテストでないことの確認）
    const confirmed = await confirmCsrdDraft(db, manager(), {
      draftId: generated.id,
      baseUpdatedAt: otherSave.updatedAt,
    });
    expect(confirmed.confirmedAt).not.toBeNull();
  });

  it('AI の実行権限の無い編集者（レビュー担当）の採用は本文に入るが、AI の採否（ai_runs）は記録しない', async () => {
    const generated = await generateCsrdDraft(db, manager(), fy2026, 'E1');
    const adopted = await adoptCsrdDraft(db, reviewer(), {
      draftId: generated.id,
      baseUpdatedAt: generated.updatedAt,
    });
    expect(adopted.body).toBe(generated.aiBody);
    const run = fixture.aiRuns.find((r) => r.id === generated.aiRunId)!;
    // recordAiDecision と 0023 の RLS と同じく、AI の採否は ai.run を持つ人だけが記録する
    expect(run.status).toBe('succeeded');
    expect(run.reviewedBy).toBeNull();
    expect(run.acceptedAt).toBeNull();
    // 権限のある人の採用は記録する（空振りテストでないことの確認）
    const regenerated = await generateCsrdDraft(db, manager(), fy2026, 'S1');
    await adoptCsrdDraft(db, manager(), {
      draftId: regenerated.id,
      baseUpdatedAt: regenerated.updatedAt,
    });
    expect(fixture.aiRuns.find((r) => r.id === regenerated.aiRunId)).toMatchObject({
      status: 'accepted',
      reviewedBy: userId('sustainability@demo.local'),
    });
  });

  it('AI の実行権限の無い編集者も、草案の行が無い評価対象の節に本文を書いて保存できる（対象外の節は不可）', async () => {
    const overview = await loadCsrdDrafts(db, reviewer(), fy2026);
    const e1 = overview!.sections.find((s) => s.section === 'E1')!;
    expect(e1.draft).toBeNull();
    expect(e1.canWriteBody).toBe(true);
    expect(e1.generatable).toBe(false);
    const created = await saveCsrdDraftBody(db, reviewer(), {
      draftId: null,
      reportingPeriodId: PERIOD_IDS.fy2026,
      section: 'E1',
      body: '気候変動の取組みを担当者が直接書いた本文（テスト）',
      baseUpdatedAt: null,
    });
    expect(created).toMatchObject({
      section: 'E1',
      aiBody: '',
      aiRunId: null,
      confirmedAt: null,
      createdBy: userId('reviewer@demo.local'),
    });
    // 行ができた後に、行の無い版（null）で書こうとしても上書きしない
    await expect(
      saveCsrdDraftBody(db, reviewer(), {
        draftId: null,
        reportingPeriodId: PERIOD_IDS.fy2026,
        section: 'E1',
        body: '別のタブ（テスト）',
        baseUpdatedAt: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    // 対象外（E5）・未判定（G1）の節には書けない
    for (const section of ['E5', 'G1'] as const) {
      await expect(
        saveCsrdDraftBody(db, reviewer(), {
          draftId: null,
          reportingPeriodId: PERIOD_IDS.fy2026,
          section,
          body: '書けない（テスト）',
          baseUpdatedAt: null,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    expect(
      (await loadCsrdDrafts(db, reviewer(), fy2026))!.sections.find((s) => s.section === 'E5')!
        .canWriteBody,
    ).toBe(false);
  });

  it('事項の判断が変わったら、その事項の節の確定を外す。対象外になった節の確定は確定済みに数えない', async () => {
    await confirmDmaWithG1();
    const generated = await generateCsrdDraft(db, manager(), fy2026, 'E1');
    const adopted = await adoptCsrdDraft(db, manager(), {
      draftId: generated.id,
      baseUpdatedAt: generated.updatedAt,
    });
    await confirmCsrdDraft(db, manager(), {
      draftId: generated.id,
      baseUpdatedAt: adopted.updatedAt,
    });
    expect((await loadCsrdDrafts(db, manager(), fy2026))!.confirmedCount).toBe(1);

    // E1 を両軸とも「重要でない」に変える → 本文は残すが確定は外れる
    await decideCsrdDmaMatter(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      topic: 'E1',
      impactAssessment: 'not_material',
      impactRationale: '見直し（テスト）',
      financialAssessment: 'not_material',
      financialRationale: '見直し（テスト）',
      stakeholderNote: '',
    });
    const stored = fixture.csrdDisclosureDrafts.find((d) => d.id === generated.id)!;
    expect(stored).toMatchObject({ confirmedAt: null, confirmedBy: null, body: adopted.body });
    const overview = await loadCsrdDrafts(db, manager(), fy2026);
    const e1 = overview!.sections.find((s) => s.section === 'E1')!;
    expect(e1.inScope).toBe(false);
    expect(e1.staleConfirmation).toBe(false);
    expect(overview!.confirmedCount).toBe(0);

    // 以前のデータ（判断が変わる前に確定し、確定が残っている行）も、対象外なら確定済みに数えない
    stored.confirmedAt = new Date().toISOString();
    stored.confirmedBy = userId('sustainability@demo.local');
    const legacy = await loadCsrdDrafts(db, manager(), fy2026);
    expect(legacy!.sections.find((s) => s.section === 'E1')!.staleConfirmation).toBe(true);
    expect(legacy!.confirmedCount).toBe(0);
  });

  it('判断の観点が変わらない保存（根拠の書き直し）では、節の確定を外さない', async () => {
    await confirmDmaWithG1();
    const generated = await generateCsrdDraft(db, manager(), fy2026, 'E1');
    const adopted = await adoptCsrdDraft(db, manager(), {
      draftId: generated.id,
      baseUpdatedAt: generated.updatedAt,
    });
    await confirmCsrdDraft(db, manager(), {
      draftId: generated.id,
      baseUpdatedAt: adopted.updatedAt,
    });
    await decideCsrdDmaMatter(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      topic: 'E1',
      impactAssessment: 'material',
      impactRationale: '根拠を書き直し（テスト）',
      financialAssessment: 'material',
      financialRationale: '根拠を書き直し（テスト）',
      stakeholderNote: '',
    });
    expect(
      fixture.csrdDisclosureDrafts.find((d) => d.id === generated.id)!.confirmedAt,
    ).not.toBeNull();
  });

  it('AI の出力が節の規則に合わなければ保存しない・根拠から外す（別の節・節の外のコード・長すぎる本文）', async () => {
    const base = {
      section: 'E1',
      perspectives: ['impact', 'financial'],
      body: 'E1 の草案（テスト）',
      coveredItemCodes: ['ESRS-E1-5'],
      gaps: [{ itemCode: 'ESRS-E1-4', reason: '未確認' }],
      confidence: 0.5,
      warnings: [],
      sources: [],
    };
    const runWith = async (output: Record<string, unknown>) => {
      setAiProviderForTesting({
        kind: 'openai',
        model: 'test-model',
        run: async (invocation) => ({
          output: output as never,
          provider: 'openai',
          model: 'test-model',
          promptVersion: PROMPT_VERSIONS[invocation.feature],
          latencyMs: 1,
          tokenUsage: { input: 0, output: 0, total: 0 },
          estimatedCostUsd: 0,
        }),
      });
      try {
        return await generateCsrdDraft(db, manager(), fy2026, 'E1');
      } finally {
        setAiProviderForTesting(null);
      }
    };
    // 別の節を返した → 保存しない
    await expect(runWith({ ...base, section: 'S1' })).rejects.toThrow(/別の節/);
    expect(fixture.csrdDisclosureDrafts.some((d) => d.section === 'E1')).toBe(false);
    // 本文の上限を超えた → 保存しない（採用すると本文の上限を破るため）
    await expect(runWith({ ...base, body: 'あ'.repeat(3001) })).rejects.toThrow(/上限/);
    // 担当者が確定していない要求事項（E1-4・AI 候補のみ）・別の節のコードは根拠から外し、注意を添える
    const saved = await runWith({
      ...base,
      coveredItemCodes: ['ESRS-E1-5', 'ESRS-E1-4', 'ESRS-S1-6'],
      gaps: [
        { itemCode: 'ESRS-E1-4', reason: '未確認' },
        { itemCode: 'ESRS-S1-9', reason: '別の節' },
      ],
    });
    expect(saved.coveredItemCodes).toEqual(['ESRS-E1-5']);
    expect(saved.gaps.map((g) => g.itemCode)).toEqual(['ESRS-E1-4']);
    expect(saved.aiWarnings.join(' ')).toContain('ESRS-E1-4、ESRS-S1-6');
    expect(saved.aiWarnings.join(' ')).toContain('ESRS-S1-9');
  });

  it('推計値は推計のまま AI に渡し、草案（デモ生成）も推計値と明記する', async () => {
    // E1-6 の Scope1（本社）を承認済みの推計にする
    const scope1 = fixture.dataPoints.find(
      (dp) =>
        dp.metricId === metricId('AOMI', 'scope1') &&
        dp.unitId === UNIT_IDS.hq &&
        dp.reportingPeriodId === PERIOD_IDS.fy2026,
    )!;
    scope1.valueKind = 'estimate';
    expect(scope1.status).toBe('approved');
    const draft = await generateCsrdDraft(db, manager(), fy2026, 'E1');
    expect(draft.aiBody).toContain('（推計値）');
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
