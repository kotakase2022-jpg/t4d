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
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * CSRD 対応計画・データ収集・開示ドラフトの Server Actions（docs/disclosure-first.md §9.4・§9.7）。
 *
 * Vercel の最悪の場合（すべてのリクエストが別インスタンスに届く）を再現するため、getDb は呼ばれるたびに
 * Fixture を作り直し、Cookie（next/headers を差し替えた入れ物）に控えた操作だけを適用して返す。
 * その上で §9.7 の zzz-csrd-chain の後半（計画を対応中へ → 収集項目 → 草案の生成・採用・保存・確定）を
 * 画面と同じ Action・同じフォームの値で進める。
 *  - 成功時はフラッシュのキーと節・行の位置へ戻す。CSRD と分析の画面を再検証する
 *  - 利用者向けのエラーは ?error= で同じ画面へ戻し、何も書かない
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

function errorOf(url: string): string | null {
  const query = url.split('#')[0]!.split('?')[1] ?? '';
  return new URLSearchParams(query).get('error');
}

/** 計画画面の更新フォームと同じ値（期限・担当部署・優先度は表示中の値を hidden で送る） */
function planUpdateForm(planId: string, status: string, assigneeUserId = '') {
  return form({
    planId,
    department: '環境管理部',
    priority: 'high',
    dueDate: '2026-11-30',
    assigneeUserId,
    status,
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
    expect(
      await redirectOf(() => updateCsrdActionPlanAction(planUpdateForm(planId, 'in_progress'))),
    ).toBe(`/enterprise/disclosures/csrd/plans?flash=csrdPlanUpdated#csrd-plan-${planId}`);
    expect(revalidatePath).toHaveBeenCalledWith('/enterprise/disclosures/csrd', 'layout');
    expect(revalidatePath).toHaveBeenCalledWith('/enterprise/analysis', 'layout');
    expect((await fresh()).fixture.csrdActionPlans.find((p) => p.id === planId)!.status).toBe(
      'in_progress',
    );

    // データ収集: scope2_location の収集項目（既存の指標。割当だけを作る）
    expect(
      await redirectOf(() =>
        createCsrdCollectionItemAction(
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
      '/enterprise/disclosures/csrd/collection?flash=csrdCollectionCreated&code=scope2_location#csrd-collection-plan-rows',
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
    ).toBe('/enterprise/disclosures/csrd/draft?flash=csrdDraftGenerated#csrd-draft-E1');
    const generated = (await fresh()).fixture.csrdDisclosureDrafts.find(
      (d) => d.organizationId === ORG_IDS.aomi && d.section === 'E1',
    )!;
    expect(generated.body).toBe('');
    expect(generated.confirmedAt).toBeNull();
    expect(generated.aiBody).toContain('インパクトと財務の両面で重要と判断');

    // 本文に採用（人）。確定はしない
    expect(
      await redirectOf(() => adoptCsrdDraftAction(form({ draftId: generated.id, section: 'E1' }))),
    ).toBe('/enterprise/disclosures/csrd/draft?flash=csrdDraftAdopted#csrd-draft-E1');
    const adopted = (await fresh()).fixture.csrdDisclosureDrafts.find(
      (d) => d.id === generated.id,
    )!;
    expect(adopted.body).toBe(generated.aiBody);
    expect(adopted.confirmedAt).toBeNull();

    // 本文を人が直して保存
    const edited = `${adopted.body}（担当者が確認して加筆）`;
    expect(
      await redirectOf(() =>
        saveCsrdDraftBodyAction(form({ draftId: generated.id, section: 'E1', body: edited })),
      ),
    ).toBe('/enterprise/disclosures/csrd/draft?flash=csrdDraftSaved#csrd-draft-E1');

    // 確定（人）
    expect(
      await redirectOf(() =>
        confirmCsrdDraftAction(form({ draftId: generated.id, section: 'E1' })),
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
    const url = await redirectOf(() =>
      confirmCsrdDraftAction(form({ draftId: CSRD_IDS.drafts.s1, section: 'S1' })),
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
    const saved = await redirectOf(() =>
      saveCsrdDraftBodyAction(form({ draftId: CSRD_IDS.drafts.s1, section: 'S1', body: '書換え' })),
    );
    expect(errorOf(saved)).not.toBeNull();
    expect(await draftEdits()).toBe(0);
  });

  it('対応計画: 不正な状態・他組織の利用者・閲覧のみの役割では更新しない', async () => {
    const planId = CSRD_IDS.plans.e1Target;
    const invalid = await redirectOf(() =>
      updateCsrdActionPlanAction(planUpdateForm(planId, 'finished')),
    );
    expect(invalid.startsWith('/enterprise/disclosures/csrd/plans?error=')).toBe(true);

    state.ctx = otherOrgAdmin();
    const otherOrg = await redirectOf(() =>
      updateCsrdActionPlanAction(planUpdateForm(planId, 'done')),
    );
    expect(errorOf(otherOrg)).toBe('対応計画が見つかりません。');

    state.ctx = viewer();
    const denied = await redirectOf(() =>
      updateCsrdActionPlanAction(planUpdateForm(planId, 'done')),
    );
    expect(errorOf(denied)).not.toBeNull();

    expect((await fresh()).fixture.csrdActionPlans.find((p) => p.id === planId)!.status).toBe(
      'in_progress',
    );
    expect((await readDemoEdits()).filter((e) => e.t === 'csrdActionPlans')).toEqual([]);
  });

  it('収集項目: 指標の管理権限が無い役割・他組織の拠点・期限なしでは作らない', async () => {
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
    const denied = await redirectOf(() => createCsrdCollectionItemAction(form(base)));
    expect(denied.startsWith('/enterprise/disclosures/csrd/collection?error=')).toBe(true);

    state.ctx = manager();
    const sotenUnit = createFixtureDb().units.find((u) => u.organizationId === ORG_IDS.soten)!;
    const otherUnit = await redirectOf(() =>
      createCsrdCollectionItemAction(form({ ...base, unitId: sotenUnit.id })),
    );
    expect(errorOf(otherUnit)).toBe('拠点はこの組織のものから選んでください。');

    const noDue = await redirectOf(() =>
      createCsrdCollectionItemAction(form({ ...base, dueDate: '' })),
    );
    expect(errorOf(noDue)).toBe('期限を入力してください。');

    const edits = await readDemoEdits();
    expect(edits.filter((e) => e.t === 'metricAssignments' || e.t === 'csrdActionPlans')).toEqual(
      [],
    );
  });
});
