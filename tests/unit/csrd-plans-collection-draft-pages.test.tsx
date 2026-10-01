import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAiProviderForTesting } from '@/lib/ai';
import { MockAIProvider } from '@/lib/ai/mock-provider';
import { CSRD_IDS } from '@/lib/fixtures/csrd';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { adoptCsrdDraft, generateCsrdDraft, saveCsrdDraftBody } from '@/lib/services/csrd/draft';
import { createCsrdActionPlan, loadCsrdDataCollection } from '@/lib/services/csrd/plans';
import { confirmCsrdDma, decideCsrdDmaMatter } from '@/lib/services/csrd/settings';
import type { EnterpriseShell } from '@/lib/services/shell';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * CSRD 対応計画・データ収集・開示ドラフトの画面（docs/disclosure-first.md §9.4）。
 * Server Component のページをそのまま呼び、Fixture の DB で描画する（Action は呼ばない）。
 *  - CSRD の計画・収集項目だけを出し、SSBJ の計画は出さない。対象外になった要求事項の計画を示す
 *  - 値は承認済みだけ。収集項目の初期値は URL の値を照合してから使う
 *  - 節ごとに AI 草案（候補）と本文を分け、押せない操作は理由を文で示す。権限に応じて操作を出さない
 *  - 状態のバッジはラベルとアイコン（読み上げない）を併記する
 */

const shellState = vi.hoisted(() => ({ shell: null as unknown }));

vi.mock('@/lib/services/shell', () => ({
  loadEnterpriseShell: async () => shellState.shell,
}));
vi.mock('@/app/enterprise/disclosures/csrd/plans/actions', () => ({
  updateCsrdActionPlanAction: vi.fn(),
}));
vi.mock('@/app/enterprise/disclosures/csrd/collection/actions', () => ({
  createCsrdCollectionItemAction: vi.fn(),
}));
vi.mock('@/app/enterprise/disclosures/csrd/draft/actions', () => ({
  generateCsrdDraftAction: vi.fn(),
  adoptCsrdDraftAction: vi.fn(),
  saveCsrdDraftBodyAction: vi.fn(),
  confirmCsrdDraftAction: vi.fn(),
}));

const { default: CsrdPlansPage } = await import('@/app/enterprise/disclosures/csrd/plans/page');
const { default: CsrdCollectionPage } =
  await import('@/app/enterprise/disclosures/csrd/collection/page');
const { default: CsrdDraftPage } = await import('@/app/enterprise/disclosures/csrd/draft/page');

let fixture: FixtureDb;
let db: DemoDbClient;

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
/** 開示の編集はできるが、指標の管理・AI の実行はできない */
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
/** 開示を読めるが編集できない */
const approver = () => ctxFor('approver@demo.local', ['approver']);
/** 開示を読めない */
const siteUser = () => ctxFor('site-user@demo.local', ['site_contributor']);

function useShell(ctx: AuthorizationContext): void {
  const organizationId = ctx.workspace.organizationId;
  shellState.shell = {
    db,
    session: null as never,
    ctx,
    periods: fixture.periods.filter((p) => p.organizationId === organizationId),
    currentPeriod: fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!,
    units: fixture.units
      .filter((u) => u.organizationId === organizationId && u.deletedAt === null)
      .sort((a, b) => a.sortOrder - b.sortOrder),
    metrics: fixture.metrics.filter((m) => m.organizationId === organizationId),
    unreadNotifications: 0,
  } satisfies EnterpriseShell;
}

type Query = Record<string, string>;
const renderPlans = async (query: Query = {}) =>
  render(await CsrdPlansPage({ searchParams: Promise.resolve(query) }));
const renderCollection = async (query: Query = {}) =>
  render(await CsrdCollectionPage({ searchParams: Promise.resolve(query) }));
const renderDraft = async (query: Query = {}) =>
  render(await CsrdDraftPage({ searchParams: Promise.resolve(query) }));

/** 行（見出しを除く） */
function bodyRows(table: HTMLElement): HTMLElement[] {
  return within(table).getAllByRole('row').slice(1);
}

function expectIconsHidden(element: HTMLElement): void {
  const icons = element.querySelectorAll('svg');
  expect(icons.length).toBeGreaterThan(0);
  for (const icon of icons) expect(icon.getAttribute('aria-hidden')).toBe('true');
}

async function decideG1AndConfirmDma(): Promise<void> {
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

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  useShell(manager());
  // happy-dom には window があり OpenAI の設定を読めない。決定論的な Mock を直接使う
  setAiProviderForTesting(new MockAIProvider());
});

afterEach(() => {
  setAiProviderForTesting(null);
});

describe('CSRD 対応計画', () => {
  it('CSRD の計画 2 件だけを並べ（SSBJ の計画は出さない）、要求事項の詳細へリンクする', async () => {
    await renderPlans();
    const table = screen.getByRole('table', { name: 'CSRD 対応計画の一覧' });
    const plans = fixture.csrdActionPlans.filter((p) => p.organizationId === ORG_IDS.aomi);
    expect(bodyRows(table)).toHaveLength(plans.length);
    expect(plans).toHaveLength(2);
    for (const ssbjPlan of fixture.ssbjActionPlans) {
      expect(table.textContent).not.toContain(ssbjPlan.title);
    }
    const e14 = within(table).getByRole('link', { name: /ESRS-E1-4/ });
    expect(e14.getAttribute('href')).toBe(
      `/enterprise/disclosures/csrd/requirements/${CSRD_IDS.items['ESRS-E1-4']}`,
    );
    // DMA 確定前の適用は暫定と併記する
    expect(table.textContent).toContain('適用（インパクト・財務）');
    expect(table.textContent).toContain('暫定（DMA 確定前）');
    expect(table.textContent).not.toContain('対象外の要求事項');
    expectIconsHidden(table);
  });

  it('編集できる人は担当者・対応状況を更新できる（計画ごとに名前の付いた選択肢）', async () => {
    await renderPlans();
    for (const plan of fixture.csrdActionPlans.filter((p) => p.organizationId === ORG_IDS.aomi)) {
      const status = screen.getByRole('combobox', { name: `${plan.title} の対応状況` });
      expect((status as HTMLSelectElement).value).toBe(plan.status);
      expect(screen.getByRole('combobox', { name: `${plan.title} の担当者` })).toBeTruthy();
      expect(screen.getByRole('button', { name: `${plan.title} を更新` })).toBeTruthy();
    }
  });

  it('計画の後に重要でないと判断した事項の計画に「対象外の要求事項」を付ける', async () => {
    await decideCsrdDmaMatter(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      topic: 'E1',
      impactAssessment: 'not_material',
      impactRationale: '見直し（テスト）',
      financialAssessment: 'not_material',
      financialRationale: '見直し（テスト）',
      stakeholderNote: '',
    });
    await renderPlans();
    const row = document.getElementById(`csrd-plan-${CSRD_IDS.plans.e1Target}`)!;
    expect(row.textContent).toContain('対象外の要求事項');
    expect(row.textContent).toContain('対象外（重要でない）');
    const other = document.getElementById(`csrd-plan-${CSRD_IDS.plans.s1FemaleManagers}`)!;
    expect(other.textContent).not.toContain('対象外の要求事項');
  });

  it('閲覧のみの役割には更新の操作を出さず、読めない役割には権限なしと示す', async () => {
    useShell(approver());
    const { unmount } = await renderPlans();
    expect(screen.queryAllByRole('combobox')).toEqual([]);
    expect(screen.getByRole('table', { name: 'CSRD 対応計画の一覧' }).textContent).toContain(
      '対応中',
    );
    unmount();

    useShell(siteUser());
    await renderPlans();
    expect(screen.getByRole('alert').textContent).toContain('アクセス権限がありません');
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('CSRD データ収集', () => {
  it('評価対象の要求事項 × 指標 × 拠点を並べ、値は承認済みだけを出す', async () => {
    const collection = await loadCsrdDataCollection(
      db,
      manager(),
      fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!,
    );
    await renderCollection();
    const table = screen.getByRole('table', {
      name: '評価対象の要求事項 × 指標 × 拠点の当期の状況',
    });
    const rows = bodyRows(table);
    expect(rows).toHaveLength(collection.requirementRows.length);
    // 対象外（E5-5）・未判定（G1）の要求事項は出さない
    expect(table.textContent).not.toContain('ESRS-E5-5');
    expect(table.textContent).not.toContain('ESRS-G1');
    // 承認済みの値（本社の女性管理職比率 18.3%）は出し、レビュー中の行は値を出さない
    const ratioHq = rows.find(
      (r) => r.textContent!.includes('female_manager_ratio') && r.textContent!.includes('本社'),
    )!;
    expect(ratioHq.textContent).toContain('18.3');
    const inReview = collection.requirementRows.find((r) => r.state === 'in_review')!;
    const inReviewRow = rows.find(
      (r) =>
        r.textContent!.includes(inReview.metric.code) &&
        r.textContent!.includes(inReview.unit!.name) &&
        r.textContent!.includes('レビュー中'),
    )!;
    const cells = within(inReviewRow).getAllByRole('cell');
    expect(cells.some((c) => c.textContent === '—')).toBe(true);
    expectIconsHidden(table);
  });

  it('計画から作った収集項目（S1-9 の EU・JV）を並べる', async () => {
    await renderCollection();
    const table = screen.getByRole('table', { name: '計画から作成した収集項目' });
    const rows = bodyRows(table);
    expect(rows).toHaveLength(2);
    for (const unitId of [UNIT_IDS.eu, UNIT_IDS.jv]) {
      const name = fixture.units.find((u) => u.id === unitId)!.name;
      expect(rows.some((r) => r.textContent!.includes(name))).toBe(true);
    }
    expect(rows.every((r) => r.textContent!.includes('未入力'))).toBe(true);
  });

  it('作成できる計画は指標未結び付け・未完了・評価対象のものだけ。計画の無い要求事項は計画へ誘導する', async () => {
    await renderCollection();
    const select = screen.getByRole('combobox', { name: '対象の対応計画' }) as HTMLSelectElement;
    // S1-9 の計画は指標を結び付け済みなので出さない
    expect([...select.options].map((o) => o.value)).toEqual([CSRD_IDS.plans.e1Target]);
    expect(select.options[0]!.textContent).toContain('【開示】ESRS-E1-4');
    // E1-6 には計画が無い → 「対応計画を立てる」（要求事項の詳細へ）
    const table = screen.getByRole('table', {
      name: '評価対象の要求事項 × 指標 × 拠点の当期の状況',
    });
    const scope2Location = bodyRows(table).find((r) => r.textContent!.includes('scope2_location'))!;
    expect(
      within(scope2Location).getByRole('link', { name: '対応計画を立てる' }).getAttribute('href'),
    ).toBe(`/enterprise/disclosures/csrd/requirements/${CSRD_IDS.items['ESRS-E1-6']}`);
  });

  it('E1-6 に計画を立てると「収集項目を作成」から計画・指標を引き継いだ初期値で開ける', async () => {
    const plan = await createCsrdActionPlan(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      itemId: CSRD_IDS.items['ESRS-E1-6']!,
      gapKind: 'data',
      title: 'Scope2 ロケーション基準の排出量を集める（テスト）',
      detail: '',
      actionType: 'data_collection',
      department: '環境管理部',
      assigneeUserId: null,
      dueDate: null,
      priority: 'high',
    });
    const first = await renderCollection();
    const table = screen.getByRole('table', {
      name: '評価対象の要求事項 × 指標 × 拠点の当期の状況',
    });
    const row = bodyRows(table).find((r) => r.textContent!.includes('scope2_location'))!;
    const href = within(row).getByRole('link', { name: '収集項目を作成' }).getAttribute('href')!;
    const query = Object.fromEntries(new URLSearchParams(href.split('?')[1]!.split('#')[0]));
    expect(query).toEqual({ plan: plan.id, metric: 'scope2_location' });
    // データの観点の計画を先頭に並べる
    const select = screen.getByRole('combobox', { name: '対象の対応計画' }) as HTMLSelectElement;
    expect(select.options[0]!.value).toBe(plan.id);
    first.unmount();

    await renderCollection({ ...query, unit: UNIT_IDS.east });
    expect(
      (screen.getByRole('combobox', { name: '対象の対応計画' }) as HTMLSelectElement).value,
    ).toBe(plan.id);
    expect(
      (screen.getByRole('combobox', { name: 'データ項目コード' }) as HTMLInputElement).value,
    ).toBe('scope2_location');
    expect((screen.getByRole('textbox', { name: 'データ項目名' }) as HTMLInputElement).value).toBe(
      'Scope2 排出量（ロケーション基準）',
    );
    expect((screen.getByRole('textbox', { name: '単位' }) as HTMLInputElement).value).toBe(
      't-CO2e',
    );
    expect(
      (screen.getByRole('combobox', { name: '集計対象範囲（拠点）' }) as HTMLSelectElement).value,
    ).toBe(UNIT_IDS.east);
    expect((screen.getByRole('textbox', { name: '担当部署' }) as HTMLInputElement).value).toBe(
      '環境管理部',
    );
  });

  it('URL の初期値は照合してから使う（知らない指標・計画・拠点は使わない）', async () => {
    await renderCollection({ metric: 'not_a_metric', plan: 'forged', unit: 'forged' });
    expect(
      (screen.getByRole('combobox', { name: 'データ項目コード' }) as HTMLInputElement).value,
    ).toBe('');
    expect(
      (screen.getByRole('combobox', { name: '対象の対応計画' }) as HTMLSelectElement).value,
    ).toBe(CSRD_IDS.plans.e1Target);
  });

  it('状況で絞り込める（承認済みだけ）', async () => {
    await renderCollection({ state: 'approved' });
    const rows = bodyRows(
      screen.getByRole('table', { name: '評価対象の要求事項 × 指標 × 拠点の当期の状況' }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.textContent!.includes('承認済み'))).toBe(true);
    expect(screen.getByRole('link', { name: '絞込を解除' })).toBeTruthy();
  });

  it('指標の管理権限が無い役割には作成フォームを出さない', async () => {
    useShell(reviewer());
    await renderCollection();
    expect(screen.queryByRole('combobox', { name: '対象の対応計画' })).toBeNull();
    expect(
      screen.getByText(/収集項目の作成には、開示の編集権限と指標の管理権限の両方が必要です/),
    ).toBeTruthy();
  });
});

describe('CSRD 開示ドラフト', () => {
  it('節（ESRS 2・E1・E3・E5・S1・G1）ごとに名前の付いた領域を作り、右上に定性情報へのリンクを置く', async () => {
    await renderDraft();
    for (const name of [
      'ESRS 2 全般開示',
      'E1 気候変動',
      'E3 水・海洋資源',
      'E5 資源利用と循環経済',
      'S1 自社の労働力',
      'G1 企業行動',
    ]) {
      expect(screen.getByRole('region', { name })).toBeTruthy();
    }
    expect(screen.queryByRole('region', { name: 'E2 汚染' })).toBeNull();
    expect(screen.getByRole('link', { name: '定性情報' }).getAttribute('href')).toBe(
      '/enterprise/narratives',
    );
    expect(document.body.textContent).toContain('ダブル・マテリアリティ評価（DMA）が未確定です');
  });

  it('対象外（E5）・未評価（G1）の節は草案を作れず、理由を示す', async () => {
    await renderDraft();
    const e5 = screen.getByRole('region', { name: 'E5 資源利用と循環経済' });
    expect(e5.textContent).toContain(
      '重要でないと判断した事項の節のため、草案は作れません（対象外）',
    );
    expect(within(e5).queryByRole('button')).toBeNull();
    const g1 = screen.getByRole('region', { name: 'G1 企業行動' });
    expect(g1.textContent).toContain('事項の重要性が未評価のため');
    expect(within(g1).queryByRole('button')).toBeNull();
  });

  it('E1 は草案を作れる。S1 は AI 草案（候補）と空の本文を分けて見せ、DMA 確定前は確定できない理由を示す', async () => {
    await renderDraft();
    const e1 = screen.getByRole('region', { name: 'E1 気候変動' });
    expect(within(e1).getByRole('button', { name: 'AI 草案を作成（デモ生成）' })).toBeTruthy();
    expect(within(e1).queryByRole('textbox')).toBeNull();

    const s1 = screen.getByRole('region', { name: 'S1 自社の労働力' });
    expect(s1.textContent).toContain('AI 草案（候補・デモ生成）');
    expect(s1.textContent).toContain('インパクトと財務の両面で重要と判断');
    expect(within(s1).getByRole('button', { name: '本文に採用' })).toBeTruthy();
    const body = within(s1).getByRole('textbox', { name: 'S1 自社の労働力の本文' });
    expect((body as HTMLTextAreaElement).value).toBe('');
    expect(s1.textContent).toContain(
      '確定できません: ダブル・マテリアリティ評価（DMA）を確定してから確定してください。',
    );
    expect(within(s1).queryByRole('button', { name: '保存済みの本文で確定' })).toBeNull();
    expectIconsHidden(s1);
  });

  it('節の要求事項と書けなかった箇所のコードは、その要求事項の詳細へリンクする', async () => {
    await renderDraft();
    const detail = (code: string) =>
      `/enterprise/disclosures/csrd/requirements/${CSRD_IDS.items[code]}`;
    const s1 = screen.getByRole('region', { name: 'S1 自社の労働力' });
    // S1-6 は節の要求事項の一覧にだけ、S1-9 は一覧と書けなかった箇所（Fixture の gaps）の両方に出る
    expect(
      within(s1)
        .getAllByRole('link', { name: 'ESRS-S1-6' })
        .map((a) => a.getAttribute('href')),
    ).toEqual([detail('ESRS-S1-6')]);
    expect(
      within(s1)
        .getAllByRole('link', { name: 'ESRS-S1-9' })
        .map((a) => a.getAttribute('href')),
    ).toEqual([detail('ESRS-S1-9'), detail('ESRS-S1-9')]);
    const esrs2 = screen.getByRole('region', { name: 'ESRS 2 全般開示' });
    expect(within(esrs2).getByRole('link', { name: 'ESRS2-GOV-1' }).getAttribute('href')).toBe(
      detail('ESRS2-GOV-1'),
    );
  });

  it('ESRS 2 は確定済み（確定者と日時）で、作り直せない理由を示す', async () => {
    await renderDraft();
    const esrs2 = screen.getByRole('region', { name: 'ESRS 2 全般開示' });
    expect(esrs2.textContent).toContain('確定済み');
    expect(esrs2.textContent).toContain('（海野 みどり）');
    expect(esrs2.textContent).toContain('確定済みの節は作り直せません');
    expect(within(esrs2).queryByRole('button', { name: /AI 草案を/ })).toBeNull();
  });

  it('DMA の確定後、採用・保存した本文は「保存済みの本文で確定」できる', async () => {
    const period = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
    const generated = await generateCsrdDraft(db, manager(), period, 'E1');
    await adoptCsrdDraft(db, manager(), generated.id);
    await saveCsrdDraftBody(db, manager(), generated.id, `${generated.aiBody}（加筆）`);
    await decideG1AndConfirmDma();
    await renderDraft();
    expect(document.body.textContent).toContain('ダブル・マテリアリティ評価（DMA）は確定済みです');
    const e1 = screen.getByRole('region', { name: 'E1 気候変動' });
    expect(within(e1).getByRole('button', { name: '保存済みの本文で確定' })).toBeTruthy();
    expect(e1.textContent).toContain('AI 草案から担当者が修正');
    expect(e1.textContent).toContain('本文あり・未確定');
    // 作り直しは AI 草案だけを置き換える
    expect(within(e1).getByRole('button', { name: 'AI 草案を作り直す（デモ生成）' })).toBeTruthy();
    expect(e1.textContent).toContain('作り直しても本文は変わりません');
  });

  it('AI の実行権限が無い役割には生成を出さず、閲覧のみの役割には編集・採用・確定を出さない', async () => {
    useShell(reviewer());
    const first = await renderDraft();
    const e1 = screen.getByRole('region', { name: 'E1 気候変動' });
    expect(within(e1).queryByRole('button', { name: /AI 草案を/ })).toBeNull();
    expect(e1.textContent).toContain('AI の実行権限が無いため、草案は作れません。');
    first.unmount();

    useShell(approver());
    await renderDraft();
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.queryAllByRole('textbox')).toEqual([]);
    expect(screen.getByRole('region', { name: 'S1 自社の労働力' }).textContent).toContain(
      '本文はまだありません。',
    );
  });
});
