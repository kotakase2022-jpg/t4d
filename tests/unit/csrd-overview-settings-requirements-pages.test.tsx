import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAiProviderForTesting } from '@/lib/ai';
import { MockAIProvider } from '@/lib/ai/mock-provider';
import { CSRD_IDS } from '@/lib/fixtures/csrd';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { decideCsrdDmaMatter } from '@/lib/services/csrd/settings';
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
    expect(screen.getByRole('button', { name: '候補を採用' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '修正して確定' })).toBeTruthy();
    expect(document.body.textContent).toContain('重要性に関わらず適用（ESRS 2 全般開示）');
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
});
