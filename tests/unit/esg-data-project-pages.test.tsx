import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NARRATIVE_STATUS_LABELS, NARRATIVE_THEME_LABELS } from '@/lib/domain/disclosure-status';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { listNarratives } from '@/lib/services/narrative';
import { listProjects } from '@/lib/services/disclosure-project';
import type { EnterpriseShell } from '@/lib/services/shell';
import {
  NARRATIVE_STATUSES,
  NARRATIVE_THEMES,
  type AuthorizationContext,
  type RoleKey,
} from '@/types/domain';
import { progressFraction } from '@/app/enterprise/esg/kpi-card';
import { loadEsgDashboard } from '@/lib/services/kpi';

/**
 * ESG 経営・非財務データ・定性情報・開示プロジェクトの文字量を減らした画面（docs/disclosure-first.md §10.4 B6）。
 * Server Component のページをそのまま呼び、Fixture の DB で描画する（Action は呼ばない）。
 *
 *  - 閉じる: 指標の注記・式・集計の内訳・副指標、数え方の説明、年次の表（図と同じ内容）、脚注
 *  - 閉じない: 実績・目標・進捗率（分母つきの帯）、比較条件の確認と最初の理由、集計中の途中値、
 *    「全社値は算定できません」、状態の内訳（分母つき）、主表
 *  - 閉じた中身は DOM にあるため、details の内外で確かめる（可視性に頼らない）
 */

const shellState = vi.hoisted(() => ({ shell: null as unknown }));

vi.mock('@/lib/services/shell', () => ({
  loadEnterpriseShell: async () => shellState.shell,
}));
vi.mock('@/app/enterprise/actions', () => ({
  carryForwardAction: vi.fn(),
  bulkTransitionAction: vi.fn(),
}));
vi.mock('@/app/enterprise/narratives/actions', () => ({ carryForwardNarrativeAction: vi.fn() }));
// 一覧の絞り込み・列の切替・一括操作は URL を書き換える Client Component（App Router が要る）
vi.mock('@/components/shared/filter-bar', () => ({
  FilterBar: ({ total }: { total: number }) => <p data-testid="filter-bar">{total} 件</p>,
}));
vi.mock('@/components/shared/table-controls', () => ({
  ColumnSelector: () => null,
  SortLink: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock('@/app/enterprise/data/bulk-actions', () => ({ BulkActionBar: () => null }));

const { default: EsgPage } = await import('@/app/enterprise/esg/page');
const { default: KpiDetailPage } = await import('@/app/enterprise/esg/[kpiKey]/page');
const { default: DataListPage } = await import('@/app/enterprise/data/page');
const { default: NarrativesPage } = await import('@/app/enterprise/narratives/page');
const { default: DisclosureProjectsPage } =
  await import('@/app/enterprise/disclosure-projects/page');

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

const sp = (query: Record<string, string> = {}) => Promise.resolve(query);

/** 既定で閉じた折りたたみの中か（閉じた中は画面に見えない） */
function inClosedDetails(element: Element): boolean {
  const details = element.closest('details');
  return details !== null && !details.open;
}

/** 要素を含む折りたたみの要点の 1 行 */
function summaryOf(element: Element): string {
  return (
    element.closest('details')?.querySelector('summary [data-collapsible-summary]')?.textContent ??
    ''
  );
}

/** KPI カード（カードの見出し h2 から、そのカードの枠を探す） */
function kpiCard(title: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 2, name: title });
  const card = heading.closest<HTMLElement>('div.rounded-t4d-lg');
  if (!card) throw new Error(`${title} のカードが無い`);
  return card;
}

/** 凡例のリスト（StatusBreakdown）の各項目の件数を「ラベル → 件数」で読む */
function legendCounts(list: HTMLElement): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of within(list).getAllByRole('listitem')) {
    // 各項目は 色チップ・アイコン・ラベル（独立した要素）・件数（「n 件」）
    const texts = [...item.children]
      .map((child) => child.textContent?.trim() ?? '')
      .filter((text) => text !== '');
    const count = texts.map((t) => /^(\d+) 件$/.exec(t)?.[1]).find(Boolean);
    const label = texts.find((t) => !/^\d+ 件$/.test(t)) ?? '';
    counts.set(label, Number(count));
  }
  return counts;
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  useShell(manager());
});

describe('ESG 経営（KPI カード）', () => {
  it('説明は 1 行＋閉じた「この画面について」、数え方は閉じた説明にする', async () => {
    render(await EsgPage({ searchParams: sp() }));
    expect(screen.getByRole('heading', { level: 1, name: 'ESG 経営' })).toBeTruthy();
    expect(screen.getByText('開示業務で承認した数値で計算した KPI')).toBeTruthy();
    const help = screen.getByText(/KPI\s*用のデータの写しは作らず/);
    expect(inClosedDetails(help)).toBe(true);
    expect(summaryOf(help)).toBe('この画面について');
    const counting = screen.getByText(/実績は、対象の全拠点が承認済みの最新年度の値です/);
    expect(inClosedDetails(counting)).toBe(true);
    expect(summaryOf(counting)).toBe('実績・進捗率・前年差の数え方');
  });

  it('Scope1: 実績・進捗率（基準 → 目標の分母つきの帯）・集計中の途中値は見せ、注記と式は「注記・内訳」に閉じる', async () => {
    render(await EsgPage({ searchParams: sp() }));
    const card = kpiCard('Scope1');
    // 実績（FY2025 の確定値）と進捗率は外
    const actual = within(card).getByText('8,931.6');
    expect(inClosedDetails(actual)).toBe(false);
    // 進捗率の帯: (11,200 − 8,931.6) / (11,200 − 7,840)。分母つきの文字を独立した要素で書く。
    // 量なので実績・目標と同じ桁区切りで書く（帯の名前も同じ文字）
    const bar = within(card).getByRole('img', { name: /^基準からの削減（目標まで）: / });
    expect(bar.getAttribute('aria-label')).toBe(
      '基準からの削減（目標まで）: 2,268.4 / 3,360 t-CO2e',
    );
    expect(within(card).getByText('2,268.4 / 3,360 t-CO2e').closest('details')).toBeNull();
    // 集計中の年度（FY2026）の途中値は外（実績・進捗率に使わないことを読み違えないように）
    const partial = within(card).getByText(/FY2026 は集計中: 承認済み分のみ/);
    expect(inClosedDetails(partial)).toBe(false);
    // 指標の注記・進捗率の式は閉じた「注記・内訳」へ
    const note = within(card).getByText(/GHG 画面と同じ連結値/);
    expect(inClosedDetails(note)).toBe(true);
    expect(summaryOf(note)).toMatch(/^注記・内訳（注記 \d+ 件）$/);
    const formula = within(card).getByText(/^進捗率: .*（式: /);
    expect(inClosedDetails(formula)).toBe(true);
  });

  it('進捗率の帯は目標の向きに揃え、遠ざかった年は分子を負のまま示す（0 に見せかけない）', async () => {
    const dashboard = await loadEsgDashboard(db, manager(), { periodId: PERIOD_IDS.fy2026 });
    const scope1 = dashboard.cards.find((c) => c.spec.key === 'scope1')!;
    expect(progressFraction(scope1)).toEqual({
      label: '基準からの削減（目標まで）',
      numerator: 2268.4,
      denominator: 3360,
      unit: 't-CO2e',
    });
    // 実績が基準より増えた（目標から遠ざかった）場合
    const worse = { ...scope1, actualValue: 11_500 };
    expect(progressFraction(worse)).toMatchObject({ numerator: -300, denominator: 3360 });
    // 比較できない目標（Scope2: 範囲が単体）は帯を出さない
    const scope2 = dashboard.cards.find((c) => c.spec.key === 'scope2_market')!;
    expect(progressFraction(scope2)).toBeNull();
  });

  it('比較条件の確認が必要（Scope2 マーケット）は、バッジと理由を外に見せる', async () => {
    render(await EsgPage({ searchParams: sp() }));
    const card = kpiCard('Scope2（マーケット基準）');
    const badges = within(card).getAllByText('比較条件の確認が必要');
    expect(badges.some((badge) => !inClosedDetails(badge))).toBe(true);
    // 進捗率を出さない理由（目標の範囲が単体）は外
    const reasons = within(card).getAllByText(/比較条件の確認が必要.*単体（国内拠点）/);
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) expect(inClosedDetails(reason)).toBe(false);
  });

  it('男女賃金: 「全社値は算定できません」は外に見せる（拠点値を平均した値を作らない）', async () => {
    render(await EsgPage({ searchParams: sp() }));
    const card = kpiCard('男女賃金');
    const notComputable = within(card).getAllByText('全社値は算定できません');
    expect(notComputable.some((el) => !inClosedDetails(el))).toBe(true);
    // 定義の注記（比率と格差率は別）は閉じた注記・内訳に残る（消さない）
    const note = within(card).getByText(/自動で換算・同一視しません/);
    expect(inClosedDetails(note)).toBe(true);
  });

  it('Scope3: カテゴリは格子（15 区分）で、データの無い区分に「0」を書かず「未算定」と示す', async () => {
    render(await EsgPage({ searchParams: sp() }));
    const card = kpiCard('Scope3');
    const grid = within(card).getByRole('list', { name: 'Scope3 カテゴリ別（FY2026）' });
    expect(inClosedDetails(grid)).toBe(true);
    expect(summaryOf(grid)).toMatch(/カテゴリ 登録あり 1\/15/);
    const items = within(grid).getAllByRole('listitem');
    expect(items).toHaveLength(15);
    expect(items.filter((item) => item.dataset.filled === 'true')).toHaveLength(1);
    expect(within(items[0]!).getByText('Cat.1')).toBeTruthy();
    for (const item of items.slice(1)) {
      expect(item.textContent).toContain('未算定（データなし）');
      expect(item.textContent).not.toMatch(/(^|\D)0(\D|$)/);
    }
    // カテゴリを足して合計にしない旨は残す
    expect(within(card).getByText('カテゴリの値を足して Scope3 合計とはしません。')).toBeTruthy();
  });
});

describe('ESG 経営の詳細（年次の推移）', () => {
  it('推移は図（確定値と集計中を別の系列）にし、年度ごとの表は既定で閉じる', async () => {
    render(
      await KpiDetailPage({
        params: Promise.resolve({ kpiKey: 'scope1' }),
        searchParams: sp({ period: PERIOD_IDS.fy2026 }),
      }),
    );
    const caption = screen.getByText('Scope1 の年次の推移');
    const figure = caption.closest('figure')!;
    const chart = within(figure).getByRole('img');
    // 代替文は年度ごとに値と区分を書く（集計中の年度を「未入力」と書かない）
    const label = chart.getAttribute('aria-label') ?? '';
    expect(label).toContain('FY2024 9,735.4（確定）');
    expect(label).toContain('FY2025 8,931.6（確定）');
    expect(label).toMatch(/FY2026 [\d,.]+（集計中・承認済み分のみ）/);
    expect(label).not.toContain('未入力');
    // 系列は確定値と途中集計に分ける（途中集計を確定値の線でつながない）
    expect(within(figure).getByText(/確定値（全拠点承認済み）/)).toBeTruthy();
    expect(within(figure).getByText(/承認済み分のみ（集計中・比較に使いません）/)).toBeTruthy();

    // 年度ごとの表（図と同じ内容）は閉じた折りたたみ。中身は消さない
    const table = screen.getAllByRole('table')[0]!;
    expect(inClosedDetails(table)).toBe(true);
    expect(summaryOf(table)).toMatch(/^年度ごとの値と前年との連続性（3 年度/);
    expect(within(table).getByText('9,735.4 t-CO2e')).toBeTruthy();
    // 要因の示し方（相関から断定しない）は閉じた説明に残す
    const factor = screen.getByText(/数値の相関から原因を断定する表示はしません/);
    expect(inClosedDetails(factor)).toBe(true);
    expect(summaryOf(factor)).toBe('要因の示し方');
  });

  it('間の年度に承認済みの値が無ければ、その年度を横軸に残して線を切る（FY2024 と FY2026 をつながない）', async () => {
    const scope1 = fixture.metrics.find(
      (m) => m.organizationId === ORG_IDS.aomi && m.code === 'scope1',
    )!;
    const rowsOf = (periodId: string) =>
      fixture.dataPoints.filter(
        (d) => d.metricId === scope1.id && d.reportingPeriodId === periodId,
      );
    // FY2025 は全拠点が差戻し中（承認済みの値なし）。FY2026 は全拠点を承認済みにして確定値にする
    for (const dp of rowsOf(PERIOD_IDS.fy2025)) dp.status = 'returned';
    for (const dp of rowsOf(PERIOD_IDS.fy2026)) dp.status = 'approved';
    render(
      await KpiDetailPage({
        params: Promise.resolve({ kpiKey: 'scope1' }),
        searchParams: sp({ period: PERIOD_IDS.fy2026 }),
      }),
    );
    const figure = screen.getByText('Scope1 の年次の推移').closest('figure')!;
    const chart = within(figure).getByRole('img');
    const label = chart.getAttribute('aria-label') ?? '';
    expect(label).toContain('FY2024 9,735.4（確定）');
    expect(label).toContain('FY2025 承認済みの値なし');
    expect(label).toMatch(/FY2026 [\d,.]+（確定）/);
    // 横軸に FY2025 を残し、値の無い位置に理由を書く。確定値の線は FY2025 で切れる（線分を引かない）
    const svgTexts = [...chart.querySelectorAll('text')].map((t) => t.textContent);
    expect(svgTexts).toEqual(expect.arrayContaining(['FY2024', 'FY2025', 'FY2026']));
    expect(svgTexts).toContain('承認済みの値なし');
    expect(chart.querySelectorAll('polyline')).toHaveLength(0);
    expect(within(figure).getByText(/FY2025: 承認済みの値なし）で線を切っています/)).toBeTruthy();
  });

  it('間の年度にデータが 1 件も無くても、その年度を「未入力」として横軸に残す', async () => {
    const scope1 = fixture.metrics.find(
      (m) => m.organizationId === ORG_IDS.aomi && m.code === 'scope1',
    )!;
    const kept = fixture.dataPoints.filter(
      (d) => !(d.metricId === scope1.id && d.reportingPeriodId === PERIOD_IDS.fy2025),
    );
    fixture.dataPoints.splice(0, fixture.dataPoints.length, ...kept);
    render(
      await KpiDetailPage({
        params: Promise.resolve({ kpiKey: 'scope1' }),
        searchParams: sp({ period: PERIOD_IDS.fy2026 }),
      }),
    );
    const figure = screen.getByText('Scope1 の年次の推移').closest('figure')!;
    const label = within(figure).getByRole('img').getAttribute('aria-label') ?? '';
    expect(label).toContain('FY2024 9,735.4（確定）');
    expect(label).toContain('FY2025 未入力');
    expect(within(figure).getByText(/FY2025: 未入力）で線を切っています/)).toBeTruthy();
  });

  it('全社値を算定できない指標は図にせず、その旨を外に書く', async () => {
    render(
      await KpiDetailPage({
        params: Promise.resolve({ kpiKey: 'gender_pay' }),
        searchParams: sp({ period: PERIOD_IDS.fy2025 }),
      }),
    );
    expect(screen.queryByText('男女賃金 の年次の推移')).toBeNull();
    const message = screen.getByText(
      /^全社値は算定できません（拠点値は組織別の内訳で確認できます）/,
    );
    expect(message.closest('details')).toBeNull();
  });
});

describe('非財務データの一覧', () => {
  it('当期の状態の内訳（6 区分・分母つき）を表の上に置き、件数の合計は一覧の総数と一致する', async () => {
    render(await DataListPage({ searchParams: sp() }));
    const list = screen.getByRole('list', { name: /^FY2026 の状態の内訳（全 \d+ 件）$/ });
    const total = Number(/全 (\d+) 件/.exec(list.getAttribute('aria-label') ?? '')?.[1]);
    const counts = legendCounts(list);
    expect([...counts.keys()]).toEqual([
      '未着手',
      '入力中',
      '提出済み',
      'レビュー中',
      '差戻し',
      '承認済み',
    ]);
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(total);
    // 絞り込みなしの一覧の総数（FilterBar の件数）と同じ母集団
    expect(screen.getByTestId('filter-bar').textContent).toBe(`${total} 件`);
    expect(list.closest('details')).toBeNull();
    // 状態のラベルはリンクにしない（絞り込みは FilterBar の 1 か所）
    expect(within(list).queryAllByRole('link')).toHaveLength(0);
  });
});

describe('定性情報の一覧', () => {
  it('状態別・情報種別別の内訳（全件で数える）を見せ、引継ぎの脚注は閉じた説明にする', async () => {
    const all = await listNarratives(db, manager(), {});
    render(await NarrativesPage({ searchParams: sp() }));
    const byStatus = screen.getByRole('list', { name: `状態別（全 ${all.length} 件）` });
    const statusCounts = legendCounts(byStatus);
    for (const status of NARRATIVE_STATUSES) {
      expect(statusCounts.get(NARRATIVE_STATUS_LABELS[status])).toBe(
        all.filter((row) => row.record.status === status).length,
      );
    }
    const byTheme = screen.getByRole('list', { name: `情報種別別（全 ${all.length} 件）` });
    const themeCounts = legendCounts(byTheme);
    for (const theme of NARRATIVE_THEMES) {
      expect(themeCounts.get(NARRATIVE_THEME_LABELS[theme])).toBe(
        all.filter((row) => row.record.theme === theme).length,
      );
    }
    const footnote = screen.getByText(
      /の下書きの版を作ります。前年の確認（承認）や前年の資料の引用は引き継がず/,
    );
    expect(inClosedDetails(footnote)).toBe(true);
    expect(summaryOf(footnote)).toBe('前年から引継ぎについて');
  });

  it('絞り込んでも内訳は全件のまま（1 区分だけの内訳にしない）', async () => {
    const all = await listNarratives(db, manager(), {});
    render(await NarrativesPage({ searchParams: sp({ status: 'confirmed' }) }));
    expect(screen.getByRole('list', { name: `状態別（全 ${all.length} 件）` })).toBeTruthy();
  });
});

describe('開示プロジェクトの一覧', () => {
  it('承認済みの節は分母つきの帯（n / N 節）で示す', async () => {
    const rows = await listProjects(db, manager());
    const withBlocks = rows.filter((row) => row.blockCount > 0);
    expect(withBlocks.length).toBeGreaterThan(0);
    render(await DisclosureProjectsPage({ searchParams: sp() }));
    const bars = screen.getAllByRole('img', { name: /^承認済み: \d+ \/ \d+ 節$/ });
    expect(bars.map((bar) => bar.getAttribute('aria-label')).sort()).toEqual(
      withBlocks.map((row) => `承認済み: ${row.approvedBlockCount} / ${row.blockCount} 節`).sort(),
    );
    // 原稿の節が無いプロジェクトは 0% と書かず「対象なし」
    expect(screen.queryAllByText('対象なし')).toHaveLength(rows.length - withBlocks.length);
    // 説明は 1 行＋閉じた「この画面について」（基準の版が自動で切り替わらないことは中に残す）
    const help = screen.getByText(/新しい版が出ても自動では切り替わりません/);
    expect(inClosedDetails(help)).toBe(true);
  });
});
