import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
 *  - 対応状況: 表は既存のギャップ分析表 1 つだけ（名前付き・12 行）。コードは要求事項の詳細へ
 *  - 設定: インパクト重要性・財務的重要性の 2 観点、会社が決めた閾値、マトリクス、SSBJ との違い、人の確定
 *  - 要求事項: 行ごとに適用と、適用になった観点。暫定の併記。URL の絞り込み
 *  - 詳細: 適用の根拠、AI の候補（デモ生成）と人の確定、回答（版・承認）への導線
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
const renderMatter = async (topic: string) =>
  render(await CsrdMatterPage({ params: Promise.resolve({ topic }), searchParams: sp() }));
const renderRequirements = async (query: Query = {}) =>
  render(await CsrdRequirementsPage({ searchParams: sp(query) }));
const renderDetail = async (itemId: string) =>
  render(
    await CsrdRequirementDetailPage({ params: Promise.resolve({ itemId }), searchParams: sp() }),
  );

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

  it('表はギャップ分析表 1 つだけ（12 行）。コードは要求事項の詳細へ、適用を併記する', async () => {
    await renderOverview();
    expect(screen.getAllByRole('table')).toHaveLength(1);
    const table = screen.getByRole('table', { name: 'ESRS 要求事項とデータの対応' });
    expect(bodyRows(table)).toHaveLength(12);
    expect(within(table).getByRole('link', { name: 'ESRS-E1-5' }).getAttribute('href')).toBe(
      `/enterprise/disclosures/csrd/requirements/${item('ESRS-E1-5')}`,
    );
    expect(rowWith(table, 'ESRS-E3-4').textContent).toContain('適用（インパクト）');
    expect(rowWith(table, 'ESRS-E5-5').textContent).toContain('対象外（重要でない）');
    expect(rowWith(table, 'ESRS-G1-1').textContent).toContain('未判定');
    // 既存の表示（データの揃い具合・回答の状況）は残す
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

    // 表のコードの行き先の説明は「この画面について」（既定で閉じる）
    const hint = screen.getByText(/ギャップ分析表のコードを選ぶと/);
    expect(inClosedDetails(hint)).toBe(true);
    expect(summaryOf(hint)).toBe('この画面について');
  });
});

describe('CSRD 設定（ダブル・マテリアリティ）', () => {
  it('2 観点・SSBJ との違い・会社が決めた閾値・10 事項・マトリクス', async () => {
    await renderSettings();
    expect(screen.getByText('SSBJ: シングル・マテリアリティ')).toBeTruthy();
    expect(screen.getByText('CSRD: ダブル・マテリアリティ')).toBeTruthy();
    expect(document.body.textContent).toContain('ESRS は重要性の数値の閾値を定めていません');
    expect(
      (screen.getByLabelText('インパクトの閾値（インパクト重要性）') as HTMLInputElement).value,
    ).toBe('3.0');
    expect((screen.getByLabelText('財務の閾値（財務的重要性）') as HTMLInputElement).value).toBe(
      '3.0',
    );
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

  it('G1 が未評価の間は確定できず理由を示す。判断すると確定できる（人の操作）', async () => {
    const { unmount } = await renderSettings();
    const button = screen.getByRole('button', { name: 'DMA を確定する' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(document.body.textContent).toContain('未評価の事項があります: G1 企業行動');
    unmount();

    await decideG1FinancialOnly();
    await renderSettings();
    expect(
      (screen.getByRole('button', { name: 'DMA を確定する' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(document.body.textContent).toContain('AI は DMA の判断・確定を行いません');
  });

  it('閲覧だけの役割には保存・確定の操作を出さない。読めない役割には権限なし', async () => {
    useShell(approver());
    const { unmount } = await renderSettings();
    expect(screen.queryByRole('button', { name: 'DMA を確定する' })).toBeNull();
    expect(screen.queryByRole('button', { name: '報告範囲を保存' })).toBeNull();
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
    await renderSettings();
    for (const name of ['SSBJ: シングル・マテリアリティ', 'CSRD: ダブル・マテリアリティ']) {
      expectOutsideDetails(screen.getByRole('heading', { level: 2, name }));
    }
    // 改正 ESRS が未発効であることは、閉じていても summary で見える
    const revised = screen.getByText(/2026-07-03 採択の改正（簡素化）ESRS は官報掲載まで未発効/);
    expect(inClosedDetails(revised)).toBe(true);
    expect(summaryOf(revised)).toContain(
      '改正 ESRS（2026-07-03 採択）は未発効・本サンプルに未反映',
    );
    // 算定式は閉じる。「ESRS は数値の閾値を定めていない」ことは summary に見せる
    const formula = screen.getByText(/√\(発生可能性 × 財務影響の大きさ\)/);
    expect(inClosedDetails(formula)).toBe(true);
    expect(summaryOf(formula)).toContain('ESRS は数値の閾値を定めていません');
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
    expectOutsideDetails(screen.getByLabelText('インパクトの閾値（インパクト重要性）'));
    // DMA が未確定の間は、取り消す確定が無いので「確定が取り消される」とは書かない
    expect(document.body.textContent).not.toContain('保存すると DMA の確定は取り消されます');
  });

  it('DMA の確定後は、保存で確定が取り消されることを各フォームの横に見せる', async () => {
    await decideG1FinancialOnly();
    await confirmCsrdDma(db, manager(), PERIOD_IDS.fy2026);
    await renderSettings();
    expectOutsideDetails(
      screen.getByText('保存すると DMA の確定は取り消されます（前提が変わるため）。'),
    );
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
    await renderMatter('S1');
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
    expect(within(table).getAllByRole('button', { name: /^IRO「.+」を削除$/ })).toHaveLength(2);
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
  });

  it('閲覧だけの役割には IRO と判断の操作を出さない', async () => {
    useShell(approver());
    await renderMatter('S1');
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
  it('12 行。行ごとに適用と、適用になった観点。DMA 確定前は暫定と示す', async () => {
    await renderRequirements();
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
    expect(inClosedDetails(screen.getByText(/官報掲載まで未発効/))).toBe(true);

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
    await renderDetail(item('ESRS-E1-6'));
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
  });

  it('AI の候補だけの要求事項は「候補を採用」「修正して確定」で人が確定する', async () => {
    await renderDetail(item('ESRS2-SBM-3'));
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
  });

  it('評価対象でない要求事項（対象外）は AI・計画・入力の操作を出さず、理由を示す', async () => {
    await renderDetail(item('ESRS-E5-5'));
    expect(screen.getByText('評価対象ではありません')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /AI ギャップ分析/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '対応計画に追加' })).toBeNull();
    expect(screen.queryByRole('button', { name: '担当者の入力として確定' })).toBeNull();
    // 回答（版・承認）への導線は残す
    expect(screen.getByRole('link', { name: '回答を編集（版・承認）' })).toBeTruthy();
  });

  it('閲覧だけの役割には操作を出さない。CSRD 以外の要求事項は 404', async () => {
    useShell(approver());
    const { unmount } = await renderDetail(item('ESRS2-SBM-3'));
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
