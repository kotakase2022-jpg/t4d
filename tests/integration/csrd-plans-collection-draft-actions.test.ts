import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getURLFromRedirectError } from 'next/dist/client/components/redirect';
import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { revalidatePath } from 'next/cache';
import { CSRD_IDS } from '@/lib/fixtures/csrd';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, metricId, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { applyDemoEdits } from '@/lib/repositories/demo-edit-codec';
import { demoEditsWereEvicted, readDemoEdits } from '@/lib/repositories/demo-persistence';
import { createCsrdActionPlan } from '@/lib/services/csrd/plans';
import { confirmCsrdDma, decideCsrdDmaMatter } from '@/lib/services/csrd/settings';
import { createCsrdCollectionItemAction } from '@/app/enterprise/disclosures/csrd/collection/actions';
import {
  adoptCsrdDraftAction,
  confirmCsrdDraftAction,
  generateCsrdDraftAction,
  saveCsrdDraftBodyAction,
} from '@/app/enterprise/disclosures/csrd/draft/actions';
import { updateCsrdActionPlanAction } from '@/app/enterprise/disclosures/csrd/plans/actions';
import { IDLE_FORM_STATE, type FormActionState } from '@/lib/errors/form-action-state';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * CSRD 対応計画・データ収集・開示ドラフトの Server Actions（docs/disclosure-first.md §9.4・§9.7）。
 *
 * Vercel の最悪の場合（すべてのリクエストが別インスタンスに届く）を再現するため、getDb は呼ばれるたびに
 * Fixture を作り直し、Cookie（next/headers を差し替えた入れ物）に控えた操作だけを適用して返す。
 * その上で §9.7 の zzz-csrd-chain の後半（計画を対応中へ → 収集項目 → 草案の生成・採用・保存・確定）を
 * 画面と同じ Action・同じフォームの値で進める。
 *  - 成功時はフラッシュのキーと節・行の位置へ戻す。CSRD と分析の画面を再検証する
 *  - 利用者向けのエラーは ?error= で同じ画面へ戻し、何も書かない。入力を伴うフォーム（本文の保存・
 *    収集項目の作成）はリダイレクトせず、理由と送った値を返す（画面が入力を残す）
 *  - 採用・保存・確定・計画の更新は、画面が表示したときの版（baseUpdatedAt）を送る
 *  - AI の草案は ai_body だけ。本文への採用・保存・確定は別々の人の操作
 */

const jar = vi.hoisted(() => new Map<string, string>());
const state = vi.hoisted(() => ({ ctx: null as AuthorizationContext | null }));

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
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({
  requireEnterpriseContext: async () => {
    if (!state.ctx) throw new Error('テストの利用者が設定されていません');
    return state.ctx;
  },
}));
// 呼ばれるたびに別インスタンス（Fixture を作り直して Cookie の操作だけを適用）
vi.mock('@/lib/repositories', () => ({
  getDb: async () => {
    const { createFixtureDb: create } = await import('@/lib/fixtures/store');
    const { applyDemoEdits: apply } = await import('@/lib/repositories/demo-edit-codec');
    const { readDemoEdits: read } = await import('@/lib/repositories/demo-persistence');
    const { DemoDbClient: Client } = await import('@/lib/repositories/demo-client');
    const fixture = create();
    apply(fixture, await read());
    return new Client(fixture);
  },
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
      organizationName: organizationId === ORG_IDS.aomi ? '青海テクノロジー株式会社' : '他社',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
/** 開示の編集はできるが、指標の管理・AI の実行はできない */
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
/** 開示を読めるが編集できない（最終承認者） */
const viewer = () => ctxFor('approver@demo.local', ['approver']);
const otherOrgAdmin = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);

/** 起動直後の別インスタンス（getDb と同じ手順） */
async function fresh(): Promise<{ db: DemoDbClient; fixture: FixtureDb }> {
  const fixture = createFixtureDb();
  applyDemoEdits(fixture, await readDemoEdits());
  return { db: new DemoDbClient(fixture), fixture };
}

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

/** Action は最後に redirect する。遷移先の URL を返す（redirect しなければ失敗） */
async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (isRedirectError(error)) return getURLFromRedirectError(error);
    throw error;
  }
  throw new Error('redirect されませんでした');
}

/** 入力を残すフォームの Action（成功なら redirect、断られたら状態を返す）。断られた状態を返す */
async function failureOf(
  run: (previous: FormActionState, formData: FormData) => Promise<FormActionState>,
  formData: FormData,
): Promise<FormActionState> {
  try {
    return await run(IDLE_FORM_STATE, formData);
  } catch (error) {
    if (isRedirectError(error)) {
      throw new Error(`断られずに遷移しました: ${getURLFromRedirectError(error)}`, {
        cause: error,
      });
    }
    throw error;
  }
}

/** 計画の表示中の版（画面は表示したときの updatedAt を hidden で送る） */
async function planVersion(planId: string): Promise<string> {
  return (await fresh()).fixture.csrdActionPlans.find((p) => p.id === planId)!.updatedAt;
}

/** 節の表示中の版 */
async function draftVersion(draftId: string): Promise<string> {
  return (await fresh()).fixture.csrdDisclosureDrafts.find((d) => d.id === draftId)!.updatedAt;
}

function errorOf(url: string): string | null {
  const query = url.split('#')[0]!.split('?')[1] ?? '';
  return new URLSearchParams(query).get('error');
}

/** 計画画面の更新フォームと同じ値（期限・担当部署・優先度・表示したときの版は hidden で送る） */
function planUpdateForm(
  planId: string,
  status: string,
  baseUpdatedAt: string,
  assigneeUserId = '',
) {
  return form({
    planId,
    department: '環境管理部',
    priority: 'high',
    dueDate: '2026-11-30',
    assigneeUserId,
    status,
    baseUpdatedAt,
  });
}

/** 設定画面で G1 を判断し DMA を確定、要求事項の詳細で E1-6 に計画を追加（B3 の画面の操作） */
async function prepareChain(): Promise<string> {
  await decideCsrdDmaMatter((await fresh()).db, manager(), {
    reportingPeriodId: PERIOD_IDS.fy2026,
    topic: 'G1',
    impactAssessment: 'not_material',
    impactRationale: '贈収賄への関与の算定結果 2.2 で閾値未満（テスト）',
    financialAssessment: 'material',
    financialRationale: '制裁金の算定結果 3.2 が閾値以上（テスト）',
    stakeholderNote: '',
  });
  await confirmCsrdDma((await fresh()).db, manager(), PERIOD_IDS.fy2026);
  const plan = await createCsrdActionPlan((await fresh()).db, manager(), {
    reportingPeriodId: PERIOD_IDS.fy2026,
    itemId: CSRD_IDS.items['ESRS-E1-6']!,
    gapKind: 'data',
    title: 'Scope2 ロケーション基準の排出量を集める（テスト）',
    detail: '',
    actionType: 'data_collection',
    department: '環境管理部',
    assigneeUserId: userId('sustainability@demo.local'),
    dueDate: '2026-11-30',
    priority: 'high',
  });
  return plan.id;
}

beforeEach(() => {
  jar.clear();
  state.ctx = manager();
  vi.mocked(revalidatePath).mockClear();
  delete (globalThis as { __t4dAppliedDemoResets?: unknown }).__t4dAppliedDemoResets;
});

describe('流れ（操作ごとに別インスタンス）: 計画を対応中へ → 収集項目 → 草案の生成・採用・保存・確定', () => {
  it('画面と同じフォームの値で最後まで進み、各操作の結果が Cookie から戻る', async () => {
    const planId = await prepareChain();

    // 対応計画: 対応中へ
    const shown = await planVersion(planId);
    expect(
      await redirectOf(() =>
        updateCsrdActionPlanAction(planUpdateForm(planId, 'in_progress', shown)),
      ),
    ).toBe(`/enterprise/disclosures/csrd/plans?flash=csrdPlanUpdated#csrd-plan-${planId}`);
    expect(revalidatePath).toHaveBeenCalledWith('/enterprise/disclosures/csrd', 'layout');
    expect(revalidatePath).toHaveBeenCalledWith('/enterprise/analysis', 'layout');
    expect((await fresh()).fixture.csrdActionPlans.find((p) => p.id === planId)!.status).toBe(
      'in_progress',
    );

    // データ収集: scope2_location の収集項目（既存の指標。割当だけを作る）
    // 計画は既に対応中なので状況は変えない（フラッシュも「対応中になりました」と言わない）
    expect(
      await redirectOf(() =>
        createCsrdCollectionItemAction(
          IDLE_FORM_STATE,
          form({
            planId,
            metricCode: 'scope2_location',
            metricName: 'Scope2 排出量（ロケーション基準）',
            unit: 't-CO2e',
            unitId: UNIT_IDS.hq,
            ownerUserId: userId('sustainability@demo.local'),
            dueDate: '2026-12-01',
            department: '環境管理部',
            requiresEvidence: 'on',
          }),
        ),
      ),
    ).toBe(
      '/enterprise/disclosures/csrd/collection?flash=csrdCollectionCreated&code=scope2_location&plan=unchanged#csrd-collection-plan-rows',
    );
    {
      const { fixture } = await fresh();
      expect(fixture.csrdActionPlans.find((p) => p.id === planId)!.linkedMetricCode).toBe(
        'scope2_location',
      );
      expect(
        fixture.metricAssignments.filter(
          (a) =>
            a.metricId === metricId('AOMI', 'scope2_location') &&
            a.unitId === UNIT_IDS.hq &&
            a.reportingPeriodId === PERIOD_IDS.fy2026,
        ),
      ).toHaveLength(1);
    }

    // 開示ドラフト E1: 生成（ai_body だけ）
    expect(
      await redirectOf(() =>
        generateCsrdDraftAction(form({ reportingPeriodId: PERIOD_IDS.fy2026, section: 'E1' })),
      ),
    ).toBe('/enterprise/disclosures/csrd/draft?flash=csrdDraftGenerated&ai=mock#csrd-draft-E1');
    const generated = (await fresh()).fixture.csrdDisclosureDrafts.find(
      (d) => d.organizationId === ORG_IDS.aomi && d.section === 'E1',
    )!;
    expect(generated.body).toBe('');
    expect(generated.confirmedAt).toBeNull();
    expect(generated.aiBody).toContain('インパクトと財務の両面で重要と判断');

    // 本文に採用（人）。確定はしない
    expect(
      await redirectOf(() =>
        adoptCsrdDraftAction(
          form({ draftId: generated.id, section: 'E1', baseUpdatedAt: generated.updatedAt }),
        ),
      ),
    ).toBe('/enterprise/disclosures/csrd/draft?flash=csrdDraftAdopted#csrd-draft-E1');
    const adopted = (await fresh()).fixture.csrdDisclosureDrafts.find(
      (d) => d.id === generated.id,
    )!;
    expect(adopted.body).toBe(generated.aiBody);
    expect(adopted.confirmedAt).toBeNull();

    // 本文を人が直して保存
    const edited = `${adopted.body}（担当者が確認して加筆）`;
    // 古い版（採用の前に表示した版）で保存しようとすると、本文を残したまま断る（別の操作を消さない）
    const stale = await failureOf(
      saveCsrdDraftBodyAction,
      form({
        draftId: generated.id,
        section: 'E1',
        body: edited,
        baseUpdatedAt: generated.updatedAt,
      }),
    );
    expect(stale.status).toBe('error');
    expect(stale.message).toContain('他の操作で内容が更新されています');
    expect(stale.values).toContainEqual(['body', edited]);
    expect(
      await redirectOf(() =>
        saveCsrdDraftBodyAction(
          IDLE_FORM_STATE,
          form({
            draftId: generated.id,
            section: 'E1',
            body: edited,
            baseUpdatedAt: adopted.updatedAt,
          }),
        ),
      ),
    ).toBe('/enterprise/disclosures/csrd/draft?flash=csrdDraftSaved#csrd-draft-E1');

    // 確定（人）
    expect(
      await redirectOf(async () =>
        confirmCsrdDraftAction(
          form({
            draftId: generated.id,
            section: 'E1',
            baseUpdatedAt: await draftVersion(generated.id),
          }),
        ),
      ),
    ).toBe('/enterprise/disclosures/csrd/draft?flash=csrdDraftConfirmed#csrd-draft-E1');
    const confirmed = (await fresh()).fixture.csrdDisclosureDrafts.find(
      (d) => d.id === generated.id,
    )!;
    expect(confirmed.body).toBe(edited);
    expect(confirmed.confirmedBy).toBe(userId('sustainability@demo.local'));

    // 押し出し（古い操作の取りこぼし）は起きていない
    expect(await demoEditsWereEvicted()).toBe(false);
  });
});

describe('利用者向けのエラーは同じ画面へ ?error= で戻し、何も書かない', () => {
  async function draftEdits(): Promise<number> {
    return (await readDemoEdits()).filter((e) => e.t === 'csrdDisclosureDrafts').length;
  }

  it('対象外（E5）・未判定（G1）の節、他組織の期間では草案を作らない', async () => {
    const e5 = await redirectOf(() =>
      generateCsrdDraftAction(form({ reportingPeriodId: PERIOD_IDS.fy2026, section: 'E5' })),
    );
    expect(e5.startsWith('/enterprise/disclosures/csrd/draft?error=')).toBe(true);
    expect(errorOf(e5)).toContain('対象外');

    const g1 = await redirectOf(() =>
      generateCsrdDraftAction(form({ reportingPeriodId: PERIOD_IDS.fy2026, section: 'G1' })),
    );
    expect(errorOf(g1)).toContain('未評価');

    const otherPeriod = await redirectOf(() =>
      generateCsrdDraftAction(form({ reportingPeriodId: PERIOD_IDS.sotenFy2026, section: 'E1' })),
    );
    expect(errorOf(otherPeriod)).toBe('報告期間が見つかりません。');
    expect(await draftEdits()).toBe(0);
  });

  it('節の値が CSRD の節でなければ、エラー画面の URL に節の位置を付けない', async () => {
    const url = await redirectOf(() =>
      generateCsrdDraftAction(
        form({ reportingPeriodId: PERIOD_IDS.fy2026, section: 'E1"><script>' }),
      ),
    );
    expect(errorOf(url)).not.toBeNull();
    expect(url).not.toContain('#');
    expect(await draftEdits()).toBe(0);
  });

  it('DMA の確定前は節を確定できない（AI 草案のみ・本文が空の S1）', async () => {
    const url = await redirectOf(async () =>
      confirmCsrdDraftAction(
        form({
          draftId: CSRD_IDS.drafts.s1,
          section: 'S1',
          baseUpdatedAt: await draftVersion(CSRD_IDS.drafts.s1),
        }),
      ),
    );
    expect(errorOf(url)).toContain('DMA');
    const s1 = (await fresh()).fixture.csrdDisclosureDrafts.find(
      (d) => d.id === CSRD_IDS.drafts.s1,
    )!;
    expect(s1.confirmedAt).toBeNull();
    expect(await draftEdits()).toBe(0);
  });

  it('AI の実行権限が無い役割は草案を作れず、閲覧のみの役割は本文を保存できない', async () => {
    state.ctx = reviewer();
    const generated = await redirectOf(() =>
      generateCsrdDraftAction(form({ reportingPeriodId: PERIOD_IDS.fy2026, section: 'E1' })),
    );
    expect(errorOf(generated)).not.toBeNull();

    state.ctx = viewer();
    const saved = await failureOf(
      saveCsrdDraftBodyAction,
      form({
        draftId: CSRD_IDS.drafts.s1,
        section: 'S1',
        body: '書換え',
        baseUpdatedAt: await draftVersion(CSRD_IDS.drafts.s1),
      }),
    );
    expect(saved.status).toBe('error');
    // 断られても書いた本文は戻る（画面が入力を残す）
    expect(saved.values).toContainEqual(['body', '書換え']);
    expect(await draftEdits()).toBe(0);
  });

  it('対応計画: 不正な状態・他組織の利用者・閲覧のみの役割では更新しない', async () => {
    const planId = CSRD_IDS.plans.e1Target;
    const shown = await planVersion(planId);
    const invalid = await redirectOf(() =>
      updateCsrdActionPlanAction(planUpdateForm(planId, 'finished', shown)),
    );
    expect(invalid.startsWith('/enterprise/disclosures/csrd/plans?error=')).toBe(true);

    // 表示した後に変わった計画（古い版）は更新しない
    const stale = await redirectOf(() =>
      updateCsrdActionPlanAction(planUpdateForm(planId, 'done', '2000-01-01T00:00:00.000Z')),
    );
    expect(errorOf(stale)).toContain('他の操作で内容が更新されています');

    state.ctx = otherOrgAdmin();
    const otherOrg = await redirectOf(() =>
      updateCsrdActionPlanAction(planUpdateForm(planId, 'done', shown)),
    );
    expect(errorOf(otherOrg)).toBe('対応計画が見つかりません。');

    state.ctx = viewer();
    const denied = await redirectOf(() =>
      updateCsrdActionPlanAction(planUpdateForm(planId, 'done', shown)),
    );
    expect(errorOf(denied)).not.toBeNull();

    expect((await fresh()).fixture.csrdActionPlans.find((p) => p.id === planId)!.status).toBe(
      'in_progress',
    );
    expect((await readDemoEdits()).filter((e) => e.t === 'csrdActionPlans')).toEqual([]);
  });

  it('収集項目: 指標の管理権限が無い役割・他組織の拠点・期限なしでは作らない（入力は残して理由を返す）', async () => {
    const base = {
      planId: CSRD_IDS.plans.e1Target,
      metricCode: 'scope2_location',
      metricName: 'Scope2 排出量（ロケーション基準）',
      unit: 't-CO2e',
      unitId: UNIT_IDS.hq,
      ownerUserId: '',
      dueDate: '2026-12-01',
      department: '',
    };
    state.ctx = reviewer();
    const denied = await failureOf(createCsrdCollectionItemAction, form(base));
    expect(denied.status).toBe('error');
    expect(denied.message).not.toBeNull();

    state.ctx = manager();
    const sotenUnit = createFixtureDb().units.find((u) => u.organizationId === ORG_IDS.soten)!;
    const otherUnit = await failureOf(
      createCsrdCollectionItemAction,
      form({ ...base, unitId: sotenUnit.id }),
    );
    expect(otherUnit.message).toBe('拠点はこの組織のものから選んでください。');
    // 選んだ計画・指標・拠点は戻る（画面が入力を残す）
    expect(otherUnit.values).toEqual(
      expect.arrayContaining([
        ['planId', base.planId],
        ['metricCode', 'scope2_location'],
        ['unitId', sotenUnit.id],
      ]),
    );

    const noDue = await failureOf(createCsrdCollectionItemAction, form({ ...base, dueDate: '' }));
    expect(noDue.message).toBe('期限を入力してください。');

    const edits = await readDemoEdits();
    expect(edits.filter((e) => e.t === 'metricAssignments' || e.t === 'csrdActionPlans')).toEqual(
      [],
    );
  });

  it('収集項目: 既存の割当を使ったときは「作成しました」と言わず、既存の割当に結び付けたと伝える', async () => {
    // E1-4（Fixture・対応中）から、Fixture で割当済みの female_manager_ratio × EU を指定する
    const url = await redirectOf(() =>
      createCsrdCollectionItemAction(
        IDLE_FORM_STATE,
        form({
          planId: CSRD_IDS.plans.e1Target,
          metricCode: 'female_manager_ratio',
          metricName: '女性管理職比率',
          unit: '%',
          unitId: UNIT_IDS.eu,
          ownerUserId: userId('reviewer@demo.local'),
          dueDate: '2027-01-31',
          department: '',
        }),
      ),
    );
    expect(url).toBe(
      '/enterprise/disclosures/csrd/collection?flash=csrdCollectionLinked&code=female_manager_ratio&plan=unchanged#csrd-collection-plan-rows',
    );
  });
});
