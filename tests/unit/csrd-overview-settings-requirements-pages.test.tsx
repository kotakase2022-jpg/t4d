import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRD_REQUIREMENT_DATA_COLS } from '@/app/enterprise/disclosures/csrd/requirements/form-input';
import { setAiProviderForTesting } from '@/lib/ai';
import { MockAIProvider } from '@/lib/ai/mock-provider';
import { CSRD_IDS } from '@/lib/fixtures/csrd';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { CSRD_GAP_KIND_QUESTION } from '@/lib/domain/csrd';
import { confirmCsrdDma, decideCsrdDmaMatter } from '@/lib/services/csrd/settings';
import type { EnterpriseShell } from '@/lib/services/shell';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * CSRD 対応状況・設定（ダブル・マテリアリティ）・要求事項（一覧・詳細）の画面（docs/disclosure-first.md §9.4）。
 * Server Component のページをそのまま呼び、Fixture の DB で描画する（Action は呼ばない）。
 *  - 対応状況: 表を置かない（ギャップ分析表は同じ母集団の要求事項の一覧へ寄せた。plan T8）。件数は絞り込んだ一覧へ
 *  - 設定: インパクト重要性・財務的重要性の 2 観点、会社が決めた閾値、マトリクス、SSBJ との違い、人の確定
 *    （段階の UI。?step= の手順だけを出し、既定は未完了の最初の手順。確定は確認ダイアログを通す）
 *  - 要求事項: 行ごとに適用と、適用になった観点（列で出す）。暫定の併記。URL の絞り込み。データ・回答の列
 *  - 詳細: 適用の根拠、AI の候補（デモ生成）と人の確定、回答（版・承認）への導線。主操作は状態で 1 つ
 *  - 権限: 閲覧だけの役割には操作を出さない。開示を読めない役割には権限なしと示す
 *  - 文字量（§10.4）: 説明・算定式・補助の一覧は既定で閉じ、誠実さの注記（架空・未発効・暫定・AI は候補）・
 *    分母付きの主要数値・表・図・フォームは閉じない。閉じた中身は DOM にあるため、details の内外で確かめる
 */

const shellState = vi.hoisted(() => ({ shell: null as unknown }));

vi.mock('@/lib/services/shell', () => ({
  loadEnterpriseShell: async () => shellState.shell,
}));
vi.mock('@/app/enterprise/actions', () => ({ runConsistencyCheckAction: vi.fn() }));
vi.mock('@/app/enterprise/disclosures/csrd/settings/actions', () => ({
  saveCsrdBoundaryAction: vi.fn(),
  saveCsrdMethodAction: vi.fn(),
  confirmCsrdDmaAction: vi.fn(),
  upsertCsrdDmaIroAction: vi.fn(),
  deleteCsrdDmaIroAction: vi.fn(),
  decideCsrdDmaMatterAction: vi.fn(),
}));
vi.mock('@/app/enterprise/disclosures/csrd/requirements/actions', () => ({
  saveCsrdAssessmentAction: vi.fn(),
  runCsrdGapAnalysisAction: vi.fn(),
  reviewCsrdAssessmentAction: vi.fn(),
  reviewCsrdAssessmentFormAction: vi.fn(),
  createCsrdActionPlanAction: vi.fn(),
}));
// 一覧のフィルターは URL を書き換える Client Component（App Router が要る）。ここでは件数だけ見せる
vi.mock('@/components/shared/filter-bar', () => ({
  FilterBar: ({ total }: { total: number }) => <p data-testid="filter-bar">{total} 件</p>,
}));
// 一覧の表（列 ▾・並べ替え・表示件数）とパンくずはクライアントのフックを使う。notFound などはそのまま使う
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => '/enterprise/disclosures/csrd',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const { default: CsrdOverviewPage } = await import('@/app/enterprise/disclosures/csrd/page');
const { default: CsrdSettingsPage } =
  await import('@/app/enterprise/disclosures/csrd/settings/page');
const { default: CsrdMatterPage } =
  await import('@/app/enterprise/disclosures/csrd/settings/matters/[topic]/page');
const { default: CsrdRequirementsPage } =
  await import('@/app/enterprise/disclosures/csrd/requirements/page');
const { default: CsrdRequirementDetailPage } =
  await import('@/app/enterprise/disclosures/csrd/requirements/[itemId]/page');

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

type Query = Record<string, string | string[]>;
const sp = (query: Query = {}) => Promise.resolve(query);
const renderOverview = async (query: Query = {}) =>
  render(await CsrdOverviewPage({ searchParams: sp(query) }));
const renderSettings = async (query: Query = {}) =>
  render(await CsrdSettingsPage({ searchParams: sp(query) }));
const renderMatter = async (topic: string, query: Query = {}) =>
  render(await CsrdMatterPage({ params: Promise.resolve({ topic }), searchParams: sp(query) }));
const renderRequirements = async (query: Query = {}) =>
  render(await CsrdRequirementsPage({ searchParams: sp(query) }));
const renderDetail = async (itemId: string, query: Query = {}) =>
  render(
    await CsrdRequirementDetailPage({
      params: Promise.resolve({ itemId }),
      searchParams: sp(query),
    }),
  );

/** 見えている主操作（data-variant="primary"）の名前。ダイアログの外だけを数える（plan §1.6） */
function primaryLabels(): string[] {
  return [...document.querySelectorAll('[data-variant="primary"]')]
    .filter((el) => el.closest('[role="dialog"]') === null)
    .map((el) => el.textContent?.trim() ?? '');
}

/** 行（見出しを除く） */
function bodyRows(table: HTMLElement): HTMLElement[] {
  return within(table).getAllByRole('row').slice(1);
}

function rowWith(table: HTMLElement, text: string): HTMLElement {
  const row = bodyRows(table).find((r) => r.textContent?.includes(text));
  if (!row) throw new Error(`${text} の行が無い`);
  return row;
}

function expectIconsHidden(element: HTMLElement): void {
  const icons = element.querySelectorAll('svg');
  expect(icons.length).toBeGreaterThan(0);
  for (const icon of icons) expect(icon.getAttribute('aria-hidden')).toBe('true');
}

/** 既定で閉じた折りたたみの中か（§10.4。閉じた中は画面に見えない） */
function inClosedDetails(element: Element): boolean {
  const details = element.closest('details');
  return details !== null && !details.open;
}

/** 要素を含む折りたたみの要点の 1 行（Collapsible・MoreInfo の summary） */
function summaryOf(element: Element): string {
  return (
    element.closest('details')?.querySelector('summary [data-collapsible-summary]')?.textContent ??
    ''
  );
}

/** 閉じていない（details の外にある）。誠実さの注記・エラー・主要数値・主表に使う */
function expectOutsideDetails(element: Element): void {
  expect(element.closest('details')).toBeNull();
}

async function notFoundDigest(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return String((error as { digest?: unknown }).digest ?? '');
  }
}

async function decideG1FinancialOnly(): Promise<void> {
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

const item = (code: string) => CSRD_IDS.items[code]!;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  useShell(manager());
  setAiProviderForTesting(new MockAIProvider());
});

afterEach(() => {
  setAiProviderForTesting(null);
});

describe('CSRD 対応状況', () => {
  it('見出し・初年度対応・サンプル（架空）とダブル・マテリアリティの表示を保つ', async () => {
    await renderOverview();
    expect(screen.getByRole('heading', { level: 1, name: 'CSRD 開示対応（ESRS）' })).toBeTruthy();
    expect(screen.getAllByText(/初年度対応/)).toHaveLength(1);
    expect(screen.getByText('サンプル（架空）')).toBeTruthy();
    expect(screen.getByText('ダブル・マテリアリティ')).toBeTruthy();
  });

  it('表は置かず（ギャップ分析表は要求事項の一覧へ寄せた）、件数から絞り込んだ一覧へ進める', async () => {
    const first = await renderOverview();
    // 同じ母集団（12 項目）の表を 2 つ置かない（plan T8）
    expect(screen.queryAllByRole('table')).toHaveLength(0);
    const dataView = (filter: string) =>
      `/enterprise/disclosures/csrd/requirements?${filter}&cols=${encodeURIComponent(CSRD_REQUIREMENT_DATA_COLS)}`;
    expect(screen.getByRole('link', { name: /^データあり（承認済み）/ }).getAttribute('href')).toBe(
      dataView('data=full'),
    );
    expect(screen.getByRole('link', { name: /^回答済み/ }).getAttribute('href')).toBe(
      dataView('answer=answered'),
    );
    expect(screen.getByRole('link', { name: /^必須項目の準備/ }).getAttribute('href')).toBe(
      dataView('required=1'),
    );
    expect(screen.getByRole('link', { name: '要求事項の評価の一覧' }).getAttribute('href')).toBe(
      `/enterprise/disclosures/csrd/requirements?cols=${encodeURIComponent(CSRD_REQUIREMENT_DATA_COLS)}`,
    );
    first.unmount();

    // 寄せた先の一覧（データ・回答の列を出したもの）: 12 行。コードは要求事項の詳細へ、適用を併記する
    await renderRequirements({ cols: CSRD_REQUIREMENT_DATA_COLS });
    const table = screen.getByRole('table', { name: 'CSRD 要求事項の評価' });
    expect(bodyRows(table)).toHaveLength(12);
    expect(
      within(table)
        .getByRole('link', { name: /^ESRS-E1-5 / })
        .getAttribute('href'),
    ).toBe(`/enterprise/disclosures/csrd/requirements/${item('ESRS-E1-5')}`);
    expect(rowWith(table, 'ESRS-E3-4').textContent).toContain('適用（インパクト）');
    expect(rowWith(table, 'ESRS-E5-5').textContent).toContain('対象外（重要でない）');
    expect(rowWith(table, 'ESRS-G1-1').textContent).toContain('未判定');
    // ギャップ分析表にあった表示（データの揃い具合・回答の状況）は列として残す
    expect(table.textContent).toContain('データあり');
    expect(table.textContent).toContain('承認済みデータなし');
    expect(table.textContent).toContain('未着手');
    expectIconsHidden(table);
  });

  it('工程 ①〜⑤・DMA の要約（n / 10 事項・未確定）・適用の内訳（n / 12）', async () => {
    await renderOverview();
    const main = document.body;
    expect(main.textContent).toContain('DMA 未確定 ／ 判断済み 9 / 10 事項');
    expect(main.textContent).toContain('評価対象 9 / 12 件 ／ 確認待ち 3 件');
    const outcomes = screen.getByRole('list', { name: '事項の結果（人の判断）' });
    expect(outcomes.textContent).toContain('両面で重要');
    expect(outcomes.textContent).toContain('1 / 10 事項');
    const kinds = screen.getByRole('list', { name: '適用の内訳' });
    expect(kinds.textContent).toContain('ESRS 2（常に適用）');
    expect(kinds.textContent).toContain('2 / 12 件');
    expect(kinds.textContent).toContain('7 / 12 件');
    expect(main.textContent).toContain('暫定（DMA 確定前）');
    expectIconsHidden(outcomes);
    // 重み付きの対応度（%）は出さない
    expect(screen.queryByText(/準拠率/)).toBeNull();
  });

  it('開示を読めない役割には権限なしと示す', async () => {
    useShell(siteUser());
    await renderOverview();
    expect(screen.getByRole('alert').textContent).toContain('アクセス権限がありません');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('文字量を減らす（§10.4）: SSBJ との違いは 1 行＋閉じた全文、件数は内訳の図、使い方は「この画面について」', async () => {
    await renderOverview();
    const short = screen.getByText(
      'SSBJ は財務的重要性のみ（シングル）。CSRD はインパクトか財務のどちらかで重要なら適用（ダブル）',
    );
    expectOutsideDetails(short);
    const full = screen.getByText(/投資家の意思決定に影響する情報/);
    expect(inClosedDetails(full)).toBe(true);
    expect(summaryOf(full)).toBe('SSBJ との違い');

    // 結果・適用は積み上げの帯（読み上げない）＋凡例の一覧（名前付き・分母付き）
    for (const name of ['事項の結果（人の判断）', '適用の内訳']) {
      const list = screen.getByRole('list', { name });
      expectOutsideDetails(list);
      expect(list.previousElementSibling?.getAttribute('aria-hidden')).toBe('true');
    }
    const kinds = screen.getByRole('list', { name: '適用の内訳' });
    expect(
      within(kinds).getByRole('link', { name: '対象外（重要でない）' }).getAttribute('href'),
    ).toBe('/enterprise/disclosures/csrd/requirements?applicability=not_material');
    // 3 観点は観点ごとに積み上げ 1 本。件数は評価対象（9 件）を分母に書く
    for (const label of [
      '開示',
      'データ',
      '業務プロセス・内部統制',
      '総合（最も遅れている観点）',
    ]) {
      const list = screen.getByRole('list', { name: `${label}の内訳` });
      expect(list.textContent).toContain('/ 9 件');
      expectIconsHidden(list);
    }

    // 架空の縮小マスター・DMA 未確定・暫定と、分母付きの評価対象は閉じない
    for (const text of [
      /架空の縮小マスター/,
      /DMA が未確定のため、テーマ別の要求事項の適用は暫定です/,
      /10 \/ 12 件の適用は DMA 確定前の暫定です/,
    ]) {
      expectOutsideDetails(screen.getByText(text));
    }
    expectOutsideDetails(screen.getByText(/評価対象（常に適用・重要）/));

    // 件数のリンクの行き先の説明は「この画面について」（既定で閉じる）
    const hint = screen.getByText(/件数を選ぶと、その条件で絞った一覧を開きます/);
    expect(inClosedDetails(hint)).toBe(true);
    expect(summaryOf(hint)).toBe('この画面について');
  });

  it('Attention（要対応）→ 工程の次の作業（主操作 1 つ）→ 件数の順。0 件の注意は出さない', async () => {
    await renderOverview();
    const attention = screen.getByRole('region', { name: '要対応' });
    // Fixture: 確認待ち 3 件・未評価の事項 1 件（G1）。整合チェックはまだ実行していないので出さない
    expect(attention.textContent).toContain('AI の候補を担当者が未確認3 件');
    expect(attention.textContent).toContain('人の判断が未評価の事項1 件');
    expect(attention.textContent).toContain('DMA 未確定のため暫定の適用10 件');
    expect(attention.textContent).not.toContain('整合チェックの指摘');
    expect(
      within(attention)
        .getByRole('link', { name: /AI の候補を担当者が未確認/ })
        .getAttribute('href'),
    ).toBe('/enterprise/disclosures/csrd/requirements?review=awaiting');
    // DMA が未確定なので、主操作は工程①（設定）の次の作業。見えている primary は 1 つだけ
    expect(primaryLabels()).toEqual(['事項を判断して DMA を確定する']);
    expect(
      screen.getByRole('link', { name: '事項を判断して DMA を確定する' }).getAttribute('href'),
    ).toBe('/enterprise/disclosures/csrd/settings');
    // 整合チェック（AI）は secondary。以前の画面下部の工程のボタンは「その他」に残す
    expect(screen.getByRole('button', { name: '整合チェックを実行' }).dataset.variant).toBe(
      'secondary',
    );
    expect(screen.getByRole('button', { name: 'その他' })).toBeTruthy();
  });

  it('閲覧だけの役割には主操作を置かない（工程の画面へのリンクは残す）', async () => {
    useShell(approver());
    await renderOverview();
    expect(primaryLabels()).toEqual([]);
    expect(screen.getByRole('link', { name: '要求事項の評価' }).getAttribute('href')).toBe(
      '/enterprise/disclosures/csrd/requirements',
    );
  });
});

describe('CSRD 設定（ダブル・マテリアリティ）', () => {
  it('段階の UI: 既定は未完了の最初の手順（③）。手順の帯は現在の手順に aria-current="step"、未完了には残りを文字で', async () => {
    await renderSettings();
    const steps = screen.getByRole('navigation', { name: 'CSRD 設定の手順' });
    const links = within(steps).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/enterprise/disclosures/csrd/settings?step=boundary',
      '/enterprise/disclosures/csrd/settings?step=method',
      '/enterprise/disclosures/csrd/settings?step=dma',
    ]);
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual([null, null, 'step']);
    // ①②は完了、③は G1 が未評価（残りを文字で示す）
    expect(links[0]!.getAttribute('data-step-state')).toBe('done');
    expect(links[2]!.textContent).toContain('未評価: G1 企業行動');
    // 1 画面に 1 つの手順だけ（③の表を出し、①②のフォームは出さない）
    expect(screen.queryByRole('button', { name: '報告範囲を保存' })).toBeNull();
    expect(screen.queryByLabelText('インパクトの閾値（インパクト重要性）')).toBeNull();
    expect(
      screen.getByRole('table', { name: 'サステナビリティ事項のダブル・マテリアリティ評価' }),
    ).toBeTruthy();
    // 主操作は手順ごとに 1 つ
    expect(primaryLabels()).toEqual(['DMA を確定する']);
  });

  it('手順ごとの主操作: ①報告範囲を保存／②評価方法を保存（どちらも 1 つだけ）', async () => {
    const boundary = await renderSettings({ step: 'boundary' });
    expect(screen.getByRole('combobox', { name: 'バリューチェーンの扱い' })).toBeTruthy();
    expect(primaryLabels()).toEqual(['報告範囲を保存']);
    expect(
      screen.queryByRole('table', { name: 'サステナビリティ事項のダブル・マテリアリティ評価' }),
    ).toBeNull();
    boundary.unmount();
    await renderSettings({ step: 'method' });
    expect(primaryLabels()).toEqual(['評価方法を保存']);
  });

  it('2 観点・SSBJ との違い・会社が決めた閾値・10 事項・マトリクス', async () => {
    // 閾値と評価方法は手順②
    const method = await renderSettings({ step: 'method' });
    expect(screen.getByText('SSBJ: シングル・マテリアリティ')).toBeTruthy();
    expect(screen.getByText('CSRD: ダブル・マテリアリティ')).toBeTruthy();
    expect(document.body.textContent).toContain('ESRS は重要性の数値の閾値を定めていません');
    expect(
      (screen.getByLabelText('インパクトの閾値（インパクト重要性）') as HTMLInputElement).value,
    ).toBe('3.0');
    expect((screen.getByLabelText('財務の閾値（財務的重要性）') as HTMLInputElement).value).toBe(
      '3.0',
    );
    method.unmount();

    // 10 事項とマトリクスは手順③（既定）
    await renderSettings();
    expect(screen.getByText('SSBJ: シングル・マテリアリティ')).toBeTruthy();
    const table = screen.getByRole('table', {
      name: 'サステナビリティ事項のダブル・マテリアリティ評価',
    });
    expect(bodyRows(table)).toHaveLength(10);
    const e1 = rowWith(table, '気候変動');
    expect(e1.textContent).toContain('4.0 ≥ 閾値 3.0');
    expect(e1.textContent).toContain('両面で重要');
    const g1 = rowWith(table, '企業行動');
    expect(g1.textContent).toContain('提案財務のみ');
    expect(g1.textContent).toContain('未評価');
    expect(g1.textContent).toContain('未判断');
    expect(within(e1).getByRole('link').getAttribute('href')).toBe(
      '/enterprise/disclosures/csrd/settings/matters/E1',
    );
    expect(screen.getByRole('img', { name: /ダブル・マテリアリティ・マトリクス/ })).toBeTruthy();
  });

  it('G1 が未評価の間は確定できず理由を示す。判断すると確定できる（人の操作・確認ダイアログを通す）', async () => {
    const { unmount } = await renderSettings();
    const button = screen.getByRole('button', { name: 'DMA を確定する' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(document.body.textContent).toContain('未評価の事項があります: G1 企業行動');
    unmount();

    await decideG1FinancialOnly();
    await renderSettings();
    const ready = screen.getByRole('button', { name: 'DMA を確定する' }) as HTMLButtonElement;
    expect(ready.disabled).toBe(false);
    expect(document.body.textContent).toContain('AI は DMA の判断・確定を行いません');
    // 押すと確定の前に確認ダイアログ（範囲 1 行と結果を本文に。確定は人が押す。plan §1.16 区分 1）
    await userEvent.setup().click(ready);
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('[data-confirm-scope]')?.textContent).toContain(
      'DMA（10 事項の人の判断・報告範囲・評価方法）を確定します',
    );
    expect(dialog.textContent).toContain('確定は取り消されます');
    expect(within(dialog).getByRole('button', { name: '確定する' })).toBeTruthy();
    const form = within(dialog).getByRole('button', { name: '確定する' }).closest('form')!;
    expect((form.querySelector('input[name="reportingPeriodId"]') as HTMLInputElement).value).toBe(
      PERIOD_IDS.fy2026,
    );
  });

  it('閲覧だけの役割には保存・確定の操作を出さない。読めない役割には権限なし', async () => {
    useShell(approver());
    const dma = await renderSettings();
    expect(screen.queryByRole('button', { name: 'DMA を確定する' })).toBeNull();
    dma.unmount();
    const boundary = await renderSettings({ step: 'boundary' });
    expect(screen.getByRole('combobox', { name: 'バリューチェーンの扱い' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '報告範囲を保存' })).toBeNull();
    boundary.unmount();
    const { unmount } = await renderSettings({ step: 'method' });
    expect(screen.queryByRole('button', { name: '評価方法を保存' })).toBeNull();
    expect(
      (screen.getByLabelText('インパクトの閾値（インパクト重要性）') as HTMLInputElement).disabled,
    ).toBe(true);
    unmount();

    useShell(siteUser());
    await renderSettings();
    expect(screen.getByRole('alert').textContent).toContain('アクセス権限がありません');
  });

  it('文字量を減らす（§10.4）: SSBJ／CSRD の見出しは見せ、考え方の詳細・算定式・マトリクスの読み方は閉じる。未発効は summary に見せる', async () => {
    // 手順②: 算定式は閉じる。「ESRS は数値の閾値を定めていない」ことは summary に見せる
    const method = await renderSettings({ step: 'method' });
    const formula = screen.getByText(/√\(発生可能性 × 財務影響の大きさ\)/);
    expect(inClosedDetails(formula)).toBe(true);
    expect(summaryOf(formula)).toContain('ESRS は数値の閾値を定めていません');
    expectOutsideDetails(screen.getByLabelText('インパクトの閾値（インパクト重要性）'));
    // DMA が未確定の間は、取り消す確定が無いので「確定が取り消される」とは書かない
    expect(document.body.textContent).not.toContain('保存すると DMA の確定は取り消されます');
    method.unmount();
    const boundary = await renderSettings({ step: 'boundary' });
    expect(document.body.textContent).not.toContain('保存すると DMA の確定は取り消されます');
    // 確定は人だけが行うこと（AI は判断・確定しない）は、どの手順でも閉じずに見せる
    expectOutsideDetails(screen.getByText(/AI は DMA の判断・確定を行いません/));
    boundary.unmount();

    // 手順③（既定）
    await renderSettings();
    for (const name of ['SSBJ: シングル・マテリアリティ', 'CSRD: ダブル・マテリアリティ']) {
      expectOutsideDetails(screen.getByRole('heading', { level: 2, name }));
    }
    // 改正 ESRS が未発効であることは、閉じていても summary で見える
    const revised = screen.getByText(
      /2026-07-03 採択の改正（簡素化）ESRS は官報掲載の報道あり（一次資料で確認中）・未発効/,
    );
    expect(inClosedDetails(revised)).toBe(true);
    expect(summaryOf(revised)).toContain(
      '改正 ESRS（2026-07-03 採択）は未発効・本サンプルに未反映',
    );
    // 閾値がデモ既定で、ESRS が数値の閾値を定めていないことは手順③でも閉じずに見せる
    expectOutsideDetails(screen.getByText(/ESRS は数値の閾値を定めていません。変更は/));
    // マトリクスの読み方・事項ごとの一覧（表と同じ内容）は閉じる。要点の件数は summary に
    const reading = screen.getByText(/閾値の線より上ならインパクト重要性/);
    expect(inClosedDetails(reading)).toBe(true);
    expect(summaryOf(reading)).toBe(
      'マトリクスの読み方・事項ごとの判断（提案と人の判断が違う事項 1 件）',
    );

    // 確定の不足一覧・AI は判断しない旨・表・図・フォームは閉じない
    expectOutsideDetails(screen.getByText('未評価の事項があります: G1 企業行動'));
    expectOutsideDetails(screen.getByText(/AI は DMA の判断・確定を行いません/));
    expectOutsideDetails(
      screen.getByRole('table', { name: 'サステナビリティ事項のダブル・マテリアリティ評価' }),
    );
    expectOutsideDetails(screen.getByRole('img', { name: /ダブル・マテリアリティ・マトリクス/ }));
  });

  it('DMA の確定後は、保存で確定が取り消されることを各フォームの横に見せる', async () => {
    await decideG1FinancialOnly();
    await confirmCsrdDma(db, manager(), PERIOD_IDS.fy2026);
    // すべて完了したので既定は③。確定済みの表示があり、確定の操作は出さない
    const dma = await renderSettings();
    expect(screen.getByText('DMA 確定済み')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'DMA を確定する' })).toBeNull();
    dma.unmount();
    const boundary = await renderSettings({ step: 'boundary' });
    expectOutsideDetails(
      screen.getByText('保存すると DMA の確定は取り消されます（前提が変わるため）。'),
    );
    boundary.unmount();
    await renderSettings({ step: 'method' });
    expectOutsideDetails(
      screen.getByText('保存すると DMA の確定は取り消されます（人の判断は変わりません）。'),
    );
  });
});

describe('CSRD サステナビリティ事項', () => {
  it('ESRS のテーマ以外は 404', async () => {
    expect(await notFoundDigest(() => renderMatter('X9'))).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(await notFoundDigest(() => renderMatter('ESRS2'))).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
  });

  it('IRO の一覧（入力・深刻度・スコア）・追加と編集・観点ごとの判断（提案を横に示す）', async () => {
    // IRO の追加は「IRO を追加」から開く枠（?new=1）
    await renderMatter('S1', { new: '1' });
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'S1 自社の労働力（ダブル・マテリアリティ評価）',
      }),
    ).toBeTruthy();
    const table = screen.getByRole('table', { name: 'S1 自社の労働力 の IRO' });
    expect(bodyRows(table)).toHaveLength(2);
    const impact = rowWith(table, '長時間労働');
    expect(impact.textContent).toContain(
      '潜在・負・人権 ／ 規模 4・範囲 3・回復困難性 3・可能性 3',
    );
    expect(impact.textContent).toContain('3.3');
    // 削除は行の「操作 ▾」の中（開いてから確かめる）。行ごとに読み上げ名の付いた操作がある
    const rowMenus = within(table).getAllByRole('button', { name: /^IRO「.+」 の操作$/ });
    expect(rowMenus).toHaveLength(2);
    await userEvent
      .setup()
      .click(within(impact).getByRole('button', { name: /^IRO「.+」 の操作$/ }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      '編集',
      '削除…',
    ]);
    // 編集フォームは表の外（IRO ごと）。保存済みの値を初期値にする
    expect(screen.getAllByText(/^(インパクト|リスク|機会)「.+」を編集$/)).toHaveLength(2);
    expect(
      screen.getAllByRole('button', { name: 'IRO を更新' }).length +
        screen.getAllByRole('button', { name: 'IRO を追加' }).length,
    ).toBe(3);
    expect(screen.getByText('IRO を追加する')).toBeTruthy();
    expect(document.body.textContent).toContain('算定結果（提案）: 3.3 ≥ 閾値 3.0（重要）');
    expect(document.body.textContent).toContain('算定結果（提案）: 3.5 ≥ 閾値 3.0（重要）');
    const material = screen.getAllByRole('radio', { name: '重要' }) as HTMLInputElement[];
    expect(material.map((r) => [r.name, r.checked])).toEqual([
      ['impactAssessment', true],
      ['financialAssessment', true],
    ]);
    expect(screen.getByRole('button', { name: '判断を保存' })).toBeTruthy();
    // 主操作は「判断を保存」1 つ（IRO の保存は secondary。plan S12）
    expect(primaryLabels()).toEqual(['判断を保存']);
  });

  it('IRO の削除は確認ダイアログを通す（論理削除・DMA の確定を取り消すことを本文に）', async () => {
    await renderMatter('S1');
    const user = userEvent.setup();
    const table = screen.getByRole('table', { name: 'S1 自社の労働力 の IRO' });
    await user.click(
      within(rowWith(table, '長時間労働')).getByRole('button', { name: /^IRO「.+」 の操作$/ }),
    );
    await user.click(screen.getByRole('menuitem', { name: '削除…' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('[data-confirm-scope]')?.textContent).toContain(
      'S1 自社の労働力 のインパクト「長時間労働',
    );
    expect(dialog.textContent).toContain('論理削除です（履歴は残り、算定からは外れます）。');
    expect(dialog.textContent).toContain('DMA を確定していた場合は、確定を取り消します。');
    const confirm = within(dialog).getByRole('button', { name: '削除する' });
    // 取り消せない操作の確定はダイアログの中の danger だけ
    expect(confirm.dataset.variant).toBe('danger');
    const form = confirm.closest('form')!;
    expect((form.querySelector('input[name="topic"]') as HTMLInputElement).value).toBe('S1');
    expect((form.querySelector('input[name="iroId"]') as HTMLInputElement).value).not.toBe('');
  });

  it('行の「編集」は ?edit= でその IRO の編集欄を開いて描く', async () => {
    const iro = fixture.csrdDmaIros.find((i) => i.description.startsWith('長時間労働'))!;
    await renderMatter('S1', { edit: iro.id });
    const editors = [...document.querySelectorAll<HTMLDetailsElement>('details[id^="iro-edit-"]')];
    expect(editors).toHaveLength(2);
    expect(editors.filter((d) => d.open).map((d) => d.id)).toEqual([`iro-edit-${iro.id}`]);
  });

  it('閲覧だけの役割には IRO と判断の操作を出さない', async () => {
    useShell(approver());
    await renderMatter('S1', { new: '1' });
    expect(screen.queryByRole('button', { name: '判断を保存' })).toBeNull();
    expect(screen.queryByText('IRO を追加する')).toBeNull();
    expect(screen.queryAllByText(/を編集$/)).toEqual([]);
    expect(screen.queryAllByRole('button', { name: /を削除$/ })).toEqual([]);
    expect(document.body.textContent).toContain('判断を変えるには開示対応の編集権限が必要です');
  });

  it('文字量を減らす（§10.4）: 「AI は判断しません」は見せ、判断の決まり・削除の扱いは閉じる', async () => {
    await renderMatter('S1');
    const ai = screen.getByText(/AI は判断しません/);
    expectOutsideDetails(ai);
    // DMA が未確定なので、確定の取り消しは書かない
    expect(ai.textContent).not.toContain('確定は取り消されます');
    const rules = screen.getByText(/算定結果（提案）と違う判断もできます/);
    expect(inClosedDetails(rules)).toBe(true);
    expect(summaryOf(rules)).toBe('判断の決まり');
    const deletion = screen.getByText(/削除は論理削除です/);
    expect(inClosedDetails(deletion)).toBe(true);
    expect(summaryOf(deletion)).toBe('削除の扱い');
    // 閾値がデモ既定で ESRS が数値の閾値を定めていないことは閉じない
    expectOutsideDetails(screen.getByText(/ESRS\s*は数値の閾値を定めていません/));
  });
});

describe('CSRD 要求事項の評価', () => {
  it('既定の列は 要求事項・適用・総合・優先度・担当者の確認。ほかの列は「列 ▾」（URL の cols）で出す', async () => {
    await renderRequirements();
    const table = screen.getByRole('table', { name: 'CSRD 要求事項の評価' });
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((th) => th.textContent?.trim());
    expect(headers).toEqual(['要求事項', '適用', '総合', '優先度', '担当者の確認']);
    expect(bodyRows(table)).toHaveLength(12);
  });

  it('データ・回答・必須でも絞り込める（ギャップ分析表と同じ数え方）', async () => {
    const none = await renderRequirements({ data: 'none', cols: CSRD_REQUIREMENT_DATA_COLS });
    const rows = bodyRows(screen.getByRole('table', { name: 'CSRD 要求事項の評価' }));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.textContent?.includes('承認済みデータなし'))).toBe(true);
    none.unmount();
    await renderRequirements({ required: '1', cols: CSRD_REQUIREMENT_DATA_COLS });
    const required = bodyRows(screen.getByRole('table', { name: 'CSRD 要求事項の評価' }));
    expect(required.length).toBeGreaterThan(0);
    expect(required.length).toBeLessThan(12);
    expect(required.every((r) => r.textContent?.includes('必須'))).toBe(true);
  });

  it('12 行。行ごとに適用と、適用になった観点。DMA 確定前は暫定と示す', async () => {
    // 適用になった観点は「列 ▾」から出す列
    await renderRequirements({ cols: 'applicability,perspectives,combined,priority,review' });
    const table = screen.getByRole('table', { name: 'CSRD 要求事項の評価' });
    expect(bodyRows(table)).toHaveLength(12);
    const e34 = rowWith(table, 'ESRS-E3-4');
    expect(e34.textContent).toContain('適用（インパクト）');
    expect(e34.textContent).toContain('暫定（DMA 確定前）');
    expect(within(e34).getAllByText('インパクト').length).toBeGreaterThan(0);
    const gov = rowWith(table, 'ESRS2-GOV-1');
    expect(gov.textContent).toContain('ESRS 2（常に適用）');
    expect(gov.textContent).toContain('重要性に関わらず');
    expect(gov.textContent).not.toContain('暫定');
    expect(rowWith(table, 'ESRS-E5-5').textContent).toContain('評価対象外');
    expect(rowWith(table, 'ESRS2-SBM-3').textContent).toContain('確認待ち');
    expect(document.body.textContent).toContain(
      'ダブル・マテリアリティ評価（DMA）が未確定のため、テーマ別の要求事項の適用は暫定です（10 / 12 件）',
    );
    expectIconsHidden(table);
  });

  it('URL の絞り込み（適用・観点・検索語）', async () => {
    const { unmount } = await renderRequirements({ applicability: 'always' });
    expect(bodyRows(screen.getByRole('table', { name: 'CSRD 要求事項の評価' }))).toHaveLength(2);
    unmount();

    await decideG1FinancialOnly();
    const second = await renderRequirements({ perspective: 'financial', q: 'G1' });
    const table = screen.getByRole('table', { name: 'CSRD 要求事項の評価' });
    expect(bodyRows(table).map((r) => r.textContent?.match(/ESRS-G1-\d/)?.[0])).toEqual([
      'ESRS-G1-1',
      'ESRS-G1-4',
    ]);
    expect(rowWith(table, 'ESRS-G1-1').textContent).toContain('適用（財務）');
    second.unmount();
  });

  it('文字量を減らす（§10.4）: SSBJ との違いは 1 行（未発効を含む）＋閉じた全文、件数の流れは図、架空の縮小サンプルと AI 候補の扱いは見せる', async () => {
    await renderRequirements();
    const line = screen.getByText(/改正 ESRS（2026-07-03 採択）は未発効・本サンプルに未反映/);
    expectOutsideDetails(line);
    expect(line.textContent).toContain('SSBJ は財務的重要性のみ（シングル）');
    expect(
      inClosedDetails(screen.getByText(/官報掲載の報道あり（一次資料で確認中）・未発効/)),
    ).toBe(true);

    const funnel = screen.getByRole('list', { name: '評価対象の件数の流れ' });
    expectOutsideDetails(funnel);
    expect([...funnel.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'サンプル（架空）マスター12 項目',
      '未判定を除く10 件',
      '対象外を除く（評価対象）9 件',
    ]);
    expect(
      within(funnel).getByRole('link', { name: '対象外を除く（評価対象）' }).getAttribute('href'),
    ).toBe('/enterprise/disclosures/csrd/requirements?applicability=always&applicability=material');
    const breakdown = screen.getByText(/ESRS 2（常に適用）2 件＋重要と判断 7 件/);
    expect(inClosedDetails(breakdown)).toBe(true);
    expect(summaryOf(breakdown)).toBe('件数の内訳');

    // DMA 未確定の注記・架空の縮小サンプル・AI の候補は確定値に入れないことは閉じない
    expectOutsideDetails(screen.getByText(/DMA）が未確定のため/));
    expectOutsideDetails(screen.getByText(/収録は ESRS の架空の縮小サンプル 12 項目/));
    expectOutsideDetails(screen.getByText(/列に分け、確定値には入れません/));
    // コードの行き先の説明は「この画面について」
    const hint = screen.getByText(/コードを選ぶと、適用の根拠/);
    expect(summaryOf(hint)).toBe('この画面について');
  });
});

describe('CSRD 要求事項の詳細', () => {
  it('適用の根拠・AI 分析（デモ生成）・指標の当期データ・計画の追加・回答への導線', async () => {
    // 対応計画の追加は「対応計画を立てる」から開く枠（?new=1）
    await renderDetail(item('ESRS-E1-6'), { new: '1' });
    expect(screen.getByRole('heading', { level: 1, name: /^ESRS-E1-6/ })).toBeTruthy();
    expect(document.body.textContent).toContain('E1 気候変動');
    expect(document.body.textContent).toContain('根拠: 製造拠点の排出は継続的に生じており');
    expect(screen.getByRole('link', { name: '回答を編集（版・承認）' }).getAttribute('href')).toBe(
      `/enterprise/disclosures/csrd/${item('ESRS-E1-6')}`,
    );
    expect(screen.getByRole('link', { name: '事項の IRO と判断を見る' }).getAttribute('href')).toBe(
      '/enterprise/disclosures/csrd/settings/matters/E1',
    );
    expect(screen.getByRole('button', { name: 'AI ギャップ分析を実行（デモ生成）' })).toBeTruthy();
    // 値は承認済みだけ（レビュー中の拠点は値を出さない）。当期の行が無い指標は「未入力」（0 にしない）
    const data = screen.getByRole('table', { name: '対応付いた指標の当期データ' });
    const euScope1 = bodyRows(data).find(
      (r) => r.textContent?.includes('scope1') && r.textContent.includes('欧州販売子会社'),
    )!;
    expect(euScope1.textContent).toContain('レビュー中');
    expect(within(euScope1).getAllByRole('cell').at(-1)!.textContent).toBe('—データを見る');
    expect(rowWith(data, 'scope2_location').textContent).toContain('未入力');
    expect(rowWith(data, 'scope2_location').textContent).toContain('全社（行なし）');
    expect(screen.getByRole('button', { name: '対応計画に追加' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '担当者の入力として確定' })).toBeTruthy();
    // 候補が無く未確定: 主操作は「担当者の入力として確定」だけ（AI の実行・計画の追加は secondary）
    expect(primaryLabels()).toEqual(['担当者の入力として確定']);
    expect(
      screen.getByRole('button', { name: 'AI ギャップ分析を実行（デモ生成）' }).dataset.variant,
    ).toBe('secondary');
  });

  it('対応計画の追加は枠（CreatePanel）で開き、期限は提出期限・担当部署は評価の担当部署・担当者は本人が初期値', async () => {
    const closed = await renderDetail(item('ESRS-E1-6'));
    // 既定では枠を開かない（一覧の上に作成フォームを常設しない）
    expect(screen.queryByRole('button', { name: '対応計画に追加' })).toBeNull();
    const open = screen.getByRole('link', { name: '対応計画を立てる' });
    expect(open.getAttribute('href')).toBe(
      `/enterprise/disclosures/csrd/requirements/${item('ESRS-E1-6')}?new=1#csrd-plan-create`,
    );
    closed.unmount();

    await renderDetail(item('ESRS-E1-6'), { new: '1' });
    const form = screen.getByRole('button', { name: '対応計画に追加' }).closest('form')!;
    const period = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
    expect((form.querySelector('input[name="dueDate"]') as HTMLInputElement).value).toBe(
      period.submissionDueDate ?? '',
    );
    expect((form.querySelector('input[name="department"]') as HTMLInputElement).value).toBe(
      'サステナビリティ推進部',
    );
    expect((form.querySelector('select[name="assigneeUserId"]') as HTMLSelectElement).value).toBe(
      userId('sustainability@demo.local'),
    );
    // 枠を開いている間は開く操作を出さない
    expect(screen.queryByRole('link', { name: '対応計画を立てる' })).toBeNull();
  });

  it('担当者が確定済みでギャップが残る要求事項は、次の作業「対応計画を立てる」が主操作', async () => {
    await renderDetail(item('ESRS2-GOV-1'));
    expect(primaryLabels()).toEqual(['対応計画を立てる']);
    expect(screen.queryByRole('button', { name: '候補を採用' })).toBeNull();
    // 確定し直す・担当部署を変える入力は閉じた折りたたみから使える
    const manual = screen.getByRole('button', { name: '担当者の入力として確定' });
    expect(inClosedDetails(manual)).toBe(true);
    expect(manual.dataset.variant).toBe('secondary');
  });

  it('AI の候補だけの要求事項は「候補を採用」「修正して確定」で人が確定する', async () => {
    await renderDetail(item('ESRS2-SBM-3'), { new: '1' });
    expect(screen.getByText('デモ生成（Mock）')).toBeTruthy();
    expect(screen.getAllByText('確認待ち').length).toBeGreaterThan(0);
    const adopt = screen.getByRole('button', { name: '候補を採用' });
    // 「候補を採用」は表示した候補の実行日時を送る（分析がやり直された後の見ていない候補を確定しない）
    const candidate = fixture.csrdAssessments.find(
      (a) => a.id === CSRD_IDS.assessments['ESRS2-SBM-3'],
    )!;
    expect(
      (adopt.closest('form')!.querySelector('input[name="aiEvaluatedAt"]') as HTMLInputElement)
        .value,
    ).toBe(candidate.aiEvaluatedAt);
    const modify = screen.getByRole('button', { name: '修正して確定' });
    // 修正の理由は送る前にブラウザでも必須（空のまま送れない）
    expect(
      (modify.closest('form')!.querySelector('input[name="comment"]') as HTMLInputElement).required,
    ).toBe(true);
    // AI の候補がある要求事項の担当者の入力は、候補と違う値なら理由が必須と示す
    expect(document.body.textContent).toContain(
      'コメント（AI の候補と違う値で確定するときは理由が必須。履歴に残ります）',
    );
    expect(document.body.textContent).toContain('重要性に関わらず適用（ESRS 2 全般開示）');
    // 主となる操作（primary）は「候補を採用」だけ。回答への導線・計画の追加は outline
    expect(screen.getByRole('link', { name: '回答を編集（版・承認）' }).className).toContain(
      'border-line',
    );
    expect(screen.getByRole('button', { name: '対応計画に追加' }).className).toContain(
      'border-line',
    );
    expect(primaryLabels()).toEqual(['候補を採用']);
  });

  it('評価対象でない要求事項（対象外）は AI・計画・入力の操作を出さず、理由を示す', async () => {
    await renderDetail(item('ESRS-E5-5'), { new: '1' });
    expect(screen.getByText('評価対象ではありません')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /AI ギャップ分析/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '対応計画に追加' })).toBeNull();
    expect(screen.queryByRole('button', { name: '担当者の入力として確定' })).toBeNull();
    // 回答（版・承認）への導線は残す
    expect(screen.getByRole('link', { name: '回答を編集（版・承認）' })).toBeTruthy();
  });

  it('閲覧だけの役割には操作を出さない。CSRD 以外の要求事項は 404', async () => {
    useShell(approver());
    const { unmount } = await renderDetail(item('ESRS2-SBM-3'), { new: '1' });
    expect(screen.queryByRole('button', { name: '候補を採用' })).toBeNull();
    expect(screen.queryByRole('button', { name: /AI ギャップ分析/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '対応計画に追加' })).toBeNull();
    unmount();

    useShell(manager());
    const ssbjItem = fixture.disclosureItems.find((i) => i.code.startsWith('気候-'))!;
    expect(await notFoundDigest(() => renderDetail(ssbjItem.id))).toBe(
      'NEXT_HTTP_ERROR_FALLBACK;404',
    );
  });

  it('文字量を減らす（§10.4）: 候補の注記・承認の制約・架空の要求事項は見せ、3 観点の問い・回答画面の説明は閉じる。「確認待ち」は 1 つだけ', async () => {
    await renderDetail(item('ESRS2-SBM-3'));
    expectOutsideDetails(screen.getByText(/この判定は候補です/));
    expectOutsideDetails(screen.getByText(/AI の下書きのままでは承認できません/));
    expectOutsideDetails(screen.getByText(/架空の縮小サンプルの要求事項です/));
    // 「確認待ち」と完全一致する表示を新しく作らない（E2E がその数で確認待ちの有無を確かめる）
    expect(screen.getAllByText('確認待ち')).toHaveLength(1);

    const question = screen.getByText(CSRD_GAP_KIND_QUESTION.data);
    expect(inClosedDetails(question)).toBe(true);
    expect(summaryOf(question)).toBe('3 観点が問うこと');
    const answer = screen.getByText(/回答本文の作成・版の履歴/);
    expect(inClosedDetails(answer)).toBe(true);
    expect(summaryOf(answer)).toBe('回答画面でできること');
  });

  it('文字量を減らす（§10.4）: 評価対象外の優先度は 1 行で示し、付け方の説明は閉じる', async () => {
    await renderDetail(item('ESRS-E5-5'));
    expectOutsideDetails(screen.getByText('優先度なし（評価対象外）'));
    const rule = screen.getByText(
      '優先度は評価対象（常に適用・重要と判断した事項）の要求事項だけに付けます。',
    );
    expect(inClosedDetails(rule)).toBe(true);
    expect(summaryOf(rule)).toBe('優先度の付け方');
  });
});
