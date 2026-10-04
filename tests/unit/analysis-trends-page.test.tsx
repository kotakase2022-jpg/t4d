import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import type { EnterpriseShell } from '@/lib/services/shell';
import type { AuthorizationContext, RoleKey, Uuid } from '@/types/domain';

/**
 * 自社経年比較の画面（docs/disclosure-first.md §10.2）。Server Component のページをそのまま呼び、
 * Fixture の DB で描画する。
 *  - 表は 1 つ（名前付き）。年度の列見出しはヘッダーの年度を終点に 3 つ、前年比の列は隣り合う年度ごと
 *  - 確定値だけを数値で出し、集計中・未入力は状態の文字（未入力を 0 と書かない）。前年比は中立の矢印＋符号
 *  - 要約は分母付きの件数（総合点・準拠率なし）。データの無い指標は既定で隠し、「表示」で出す
 *  - 文字量（§10.4）: 比較の決まりと行ごとの内訳は既定で閉じ、窓の注記・要約・表は閉じない。
 *    「比較条件の確認が必要」で絞ったときは理由のある内訳を開いて描く
 *  - 状態のバッジはラベル＋アイコン（アイコンは読み上げない）
 */

const shellState = vi.hoisted(() => ({ shell: null as unknown }));

vi.mock('@/lib/services/shell', () => ({
  loadEnterpriseShell: async () => shellState.shell,
}));
// 一覧のフィルターは URL を書き換える Client Component（App Router が要る）。ここでは件数だけ見せる
vi.mock('@/components/shared/filter-bar', () => ({
  FilterBar: ({ total }: { total: number }) => <p data-testid="filter-bar">{total} 件</p>,
}));

const { default: TrendsPage } = await import('@/app/enterprise/analysis/trends/page');

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

function useShell(ctx: AuthorizationContext, periodId: Uuid = PERIOD_IDS.fy2026): void {
  const organizationId = ctx.workspace.organizationId;
  shellState.shell = {
    db,
    session: null as never,
    ctx,
    // シェルと同じくコードの降順（窓は開始日で決まる）
    periods: fixture.periods
      .filter((p) => p.organizationId === organizationId)
      .sort((a, b) => (a.code < b.code ? 1 : -1)),
    currentPeriod: fixture.periods.find((p) => p.id === periodId)!,
    units: fixture.units.filter((u) => u.organizationId === organizationId),
    metrics: fixture.metrics.filter((m) => m.organizationId === organizationId),
    unreadNotifications: 0,
  } satisfies EnterpriseShell;
}

type Query = Record<string, string | string[]>;
const renderPage = async (query: Query = {}) =>
  render(await TrendsPage({ searchParams: Promise.resolve(query) }));

const table = () => screen.getByRole('table', { name: /^指標ごとの確定値/ });

/** 指標の行（行見出しの指標名で探す） */
function rowOf(name: string): HTMLElement {
  const row = within(table())
    .getAllByRole('row')
    .find((r) => r.querySelector('th[scope="row"]')?.textContent?.startsWith(name));
  if (!row) throw new Error(`${name} の行が無い`);
  return row;
}

/** 指標の行のすぐ下の「内訳」の行（行見出しの外に分けている） */
function detailOf(name: string): HTMLElement {
  const row = rowOf(name);
  const detail = row.nextElementSibling as HTMLElement | null;
  if (
    !detail ||
    detail.getAttribute('data-trend-detail') !== row.getAttribute('data-metric-code')
  ) {
    throw new Error(`${name} の内訳の行が無い`);
  }
  return detail;
}

/** 年度・推移・前年比のセル（行見出しを除く） */
const cellsOf = (row: HTMLElement) => within(row).getAllByRole('cell');

function inClosedDetails(element: Element): boolean {
  const details = element.closest('details');
  return details !== null && !details.open;
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  useShell(manager());
});

describe('自社経年比較の画面', () => {
  it('見出し・パンくず・名前付きの表 1 つ。年度の列は FY2024〜FY2026、前年比は隣り合う年度ごと', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: '自社経年比較' })).toBeTruthy();
    const crumbs = screen.getByRole('navigation', { name: 'パンくず' });
    expect(
      within(crumbs)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['企業ワークスペース', '分析', '自社経年比較']);
    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(table().querySelector('caption')?.textContent).toMatch(
      /^指標ごとの確定値（FY2024〜FY2026・21 指標）$/,
    );
    const headers = within(table())
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual([
      '指標（単位）',
      'FY2024',
      'FY2025',
      'FY2026',
      '推移',
      '前年比 FY2024→FY2025',
      '前年比 FY2025→FY2026',
    ]);
    // 群の見出し行（GHG → 環境 → 社会 → ガバナンス）
    const groups = within(table())
      .getAllByRole('rowheader')
      .filter((th) => th.getAttribute('scope') === 'rowgroup')
      .map((th) => th.textContent);
    expect(groups).toEqual([
      'GHG（3 指標）',
      '環境（3 指標）',
      expect.stringMatching(/^社会（\d+ 指標）$/),
      expect.stringMatching(/^ガバナンス（\d+ 指標）$/),
    ]);
    expect(document.body.textContent).not.toContain('準拠率');
  });

  it('scope1: 確定値 2 年と集計中、前年比は中立の矢印＋符号（FY2026 は理由つきで出さない）', async () => {
    await renderPage();
    const row = rowOf('Scope1 排出量');
    const [fy2024, fy2025, fy2026, trend, change1, change2] = cellsOf(row);
    expect(fy2024!.textContent).toBe('9,735.4t-CO2e（確定）');
    expect(fy2025!.textContent).toBe('8,931.6t-CO2e（確定）');
    expect(fy2026!.textContent).toBe('集計中（承認済み 3/4 拠点）');
    // 推移の小さな棒は装飾（値は隣のセル）
    expect(trend!.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(change1!.textContent).toBe('−8.3%（−803.8 t-CO2e）');
    // 色で良し悪しを示さない（成功・危険の色を使わない）
    expect(change1!.innerHTML).not.toMatch(/text-(success|danger)/);
    expect(change2!.textContent).toBe('—前年比なし: FY2026 の確定値がありません。');
    for (const svg of row.querySelectorAll('td svg')) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('内訳は既定で閉じ、年度ごとの承認・途中集計（比較に使わない）・リンクが入る', async () => {
    await renderPage();
    const detail = detailOf('Scope1 排出量');
    const summary = within(detail).getByText('内訳');
    expect(summary.closest('summary')?.textContent).toContain('承認済み 4/4・4/4・3/4 拠点');
    // 行見出しから離れるため、読み上げではどの指標の内訳かを名前に含める
    expect(summary.closest('[data-collapsible-summary]')?.textContent).toBe('Scope1 排出量の内訳');
    const details = summary.closest('details')!;
    expect(details.open).toBe(false);
    const body = within(details);
    expect(body.getByText(/^承認済み分のみの途中集計（比較に使いません）/)).toBeTruthy();
    expect(body.getByText(/^参考: 推計込み/)).toBeTruthy();
    expect(body.getByRole('link', { name: /ESG経営の KPI/ }).getAttribute('href')).toBe(
      '/enterprise/esg/scope1',
    );
    expect(body.getByRole('link', { name: /GHG 排出量/ }).getAttribute('href')).toBe(
      '/enterprise/ghg',
    );
    expect(body.getByText('FY2025→FY2026')).toBeTruthy();
    // 内訳の行は表の幅いっぱい（列を増やさない）
    expect(detail.querySelector('td')?.getAttribute('colspan')).toBe('7');
  });

  it('行見出しは指標名と単位だけ（内訳の文を行見出しの名前に含めない）', async () => {
    await renderPage({ change: 'needs_check' });
    // 内訳を開いて描く絞込でも、行見出しの中に details・リンク・理由を置かない
    for (const header of within(table()).getAllByRole('rowheader')) {
      if (header.getAttribute('scope') !== 'row') continue;
      expect(header.querySelector('details')).toBeNull();
      expect(header.querySelector('a')).toBeNull();
    }
    expect(within(rowOf('Scope3 Category 1')).getByRole('rowheader').textContent).toBe(
      'Scope3 Category 1（購入した製品・サービス）（t-CO2e）',
    );
  });

  it('scope3_cat1 の FY2025→FY2026 は比較条件の確認（理由は内訳）。その絞込では内訳を開いて描く', async () => {
    await renderPage();
    const row = rowOf('Scope3 Category 1');
    const change2 = cellsOf(row)[5]!;
    expect(change2.textContent).toContain('比較条件の確認が必要');
    const reason = within(detailOf('Scope3 Category 1')).getByText(
      /内部取引の控除が FY2026 だけにあります/,
    );
    expect(inClosedDetails(reason)).toBe(true);

    document.body.innerHTML = '';
    await renderPage({ change: 'needs_check' });
    expect(table().querySelector('caption')?.textContent).toContain('・1 指標）');
    expect(
      inClosedDetails(
        within(detailOf('Scope3 Category 1')).getByText(/内部取引の控除が FY2026 だけにあります/),
      ),
    ).toBe(false);
  });

  it('全社値を算定できない指標は状態の文字で示し、拠点値は内訳に出す', async () => {
    await renderPage();
    const row = rowOf('離職率');
    const [fy2024, fy2025, fy2026] = cellsOf(row);
    for (const cell of [fy2024, fy2025, fy2026]) {
      expect(cell!.textContent).toBe('全社値は算定不可');
      expect(cell!.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    }
    const detail = detailOf('離職率');
    const units = within(detail).getByRole('list', { name: 'FY2025 の拠点の値' });
    expect(units.textContent).toContain('本社: 6.8 %');
    // 算定できない理由（ESG経営と同じ文）は内訳の中（既定で閉じる）
    const reason = within(detail).getAllByText(/分子・分母が登録されていないため算定できません/);
    expect(reason.length).toBeGreaterThan(0);
    expect(reason.every((el) => inClosedDetails(el))).toBe(true);
    expect(within(detail).getByText(/^全社値は算定不可（集計方法: 加重平均/)).toBeTruthy();
    // 行見出しには理由を含めない
    expect(within(row).getByRole('rowheader').textContent).toBe('離職率（%）');
  });

  it('% の指標は加重平均を小数 2 桁で示し、前年比は % ポイント', async () => {
    await renderPage();
    const row = rowOf('女性管理職比率');
    const [fy2024, fy2025, fy2026, , change1, change2] = cellsOf(row);
    expect(fy2024!.textContent).toBe('14.04%（確定）');
    expect(fy2025!.textContent).toBe('15%（確定）');
    expect(fy2026!.textContent).toBe('18.25%（確定）');
    expect(change1!.textContent).toBe('+0.96 pt');
    expect(change2!.textContent).toBe('+3.25 pt');
  });

  it('要約は分母付きのチップで絞込を兼ねる（総合点なし）。最新年度の集計中は件数だけ', async () => {
    await renderPage();
    const chips = screen.getByRole('list', { name: '経年比較の要約' });
    const items = within(chips)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(items).toEqual([
      '比較できた指標15 / 21 指標',
      '大きな変化0 / 21 指標',
      '比較条件の確認が必要1 / 21 指標',
      '最新年度（FY2026）が集計中9 / 21 指標',
    ]);
    expect(
      within(chips)
        .getByRole('link', { name: /^比較できた指標/ })
        .getAttribute('href'),
    ).toBe('/enterprise/analysis/trends?change=compared');
    expect(within(chips).getAllByRole('link')).toHaveLength(3);

    // 押したチップは現在の絞込として示し、もう一度押すと外れる（ほかの絞込は保つ）
    document.body.innerHTML = '';
    await renderPage({ change: 'compared', group: 'ghg' });
    const active = within(screen.getByRole('list', { name: '経年比較の要約' })).getByRole('link', {
      name: /^比較できた指標/,
    });
    expect(active.getAttribute('aria-current')).toBe('true');
    expect(active.getAttribute('href')).toBe('/enterprise/analysis/trends?group=ghg');
  });

  it('データが 1 年もない指標は既定で隠し（0 ではないと書く）、「表示」で出す。未入力を 0 と書かない', async () => {
    await renderPage();
    const note = screen.getByText(/^データが 1 年もない指標 \d+ 件（0 ではありません）/);
    const show = within(note).getByRole('link', { name: '表示' });
    expect(show.getAttribute('href')).toBe('/enterprise/analysis/trends?empty=1');
    expect(within(table()).queryByText(/^Scope2 排出量（ロケーション基準）/)).toBeNull();

    document.body.innerHTML = '';
    await renderPage({ empty: '1' });
    const row = rowOf('Scope2 排出量（ロケーション基準）');
    const [fy2024, fy2025, fy2026, , change1, change2] = cellsOf(row);
    for (const cell of [fy2024, fy2025, fy2026]) expect(cell!.textContent).toBe('未入力');
    // 前年比も数値にしない（見えるのは「—」だけ。理由は読み上げ用）
    for (const cell of [change1, change2]) {
      expect(cell!.querySelector('[aria-hidden="true"]')?.textContent).toBe('—');
      expect(cell!.textContent).toMatch(/^—前年比なし: FY20\d\d の確定値がありません。$/);
    }
    expect(
      within(screen.getByText(/^データが 1 年もない指標/))
        .getByRole('link', { name: '隠す' })
        .getAttribute('href'),
    ).toBe('/enterprise/analysis/trends');
  });

  it('比較の決まりは既定で閉じる（要点は summary に見える）', async () => {
    await renderPage();
    const summary = screen.getByText(/^比較の決まり: 確定値だけ/);
    const details = summary.closest('details')!;
    expect(details.open).toBe(false);
    expect(within(details).getByText(/Scope3 全体ではありません/)).toBeTruthy();
    expect(within(details).getByText(/マーケット基準とロケーション基準は別の指標/)).toBeTruthy();
  });

  it('ヘッダーが FY2025 なら 2 年窓で、年数と理由を閉じずに示す', async () => {
    useShell(manager(), PERIOD_IDS.fy2025);
    await renderPage();
    const note = screen.getByRole('note');
    expect(note.textContent).toBe('比較できる年度は 2 年分（それ以前の報告期間なし）');
    expect(inClosedDetails(note)).toBe(false);
    expect(
      within(table())
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['指標（単位）', 'FY2024', 'FY2025', '推移', '前年比 FY2024→FY2025']);
  });

  it('データの閲覧権限が無ければ権限なしと示し、値を出さない', async () => {
    // 役割の無い利用者（enterprise.data.read を持たない）
    useShell(ctxFor('site-user@demo.local', []));
    await renderPage();
    expect(screen.getByText('アクセス権限がありません')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(document.body.textContent).not.toContain('9,735.4');
  });

  it('データがまだ無い組織（絞り込みなし）: 「絞り込み解除」を案内せず、データが無いことを示す', async () => {
    // 新しいテナント相当: 指標はあるが、窓のどの年度にもデータが無い
    const others = fixture.dataPoints.filter((d) => d.organizationId !== ORG_IDS.aomi);
    fixture.dataPoints.splice(0, fixture.dataPoints.length, ...others);
    await renderPage();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('比較できるデータがまだありません')).toBeTruthy();
    expect(
      screen.getByText(
        'FY2024〜FY2026 のどの年度にも、指標のデータが登録されていません（0 ではありません）。データを登録すると、確定値を年度ごとに並べます。',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'データ取込' }).getAttribute('href')).toBe(
      '/enterprise/imports',
    );
    // 絞り込んでいないので、無い操作（絞り込み解除）を案内しない
    expect(document.body.textContent).not.toContain('絞り込み解除');
    expect(document.body.textContent).not.toContain('該当する指標がありません');
  });

  it('絞り込みで 0 件になったときだけ「絞り込みの条件を変えるか、絞り込み解除」を案内する', async () => {
    await renderPage({ q: '存在しない指標名' });
    expect(screen.getByText('該当する指標がありません')).toBeTruthy();
    expect(
      screen.getByText('絞り込みの条件を変えるか、「絞り込み解除」を押してください。'),
    ).toBeTruthy();
  });

  it('数値の指標が 1 つも無い組織: 指標マスターへの導線を示す', async () => {
    const others = fixture.metrics.filter((m) => m.organizationId !== ORG_IDS.aomi);
    fixture.metrics.splice(0, fixture.metrics.length, ...others);
    await renderPage();
    expect(screen.getByText('数値の指標が登録されていません')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: '組織・拠点（指標マスター）' }).getAttribute('href'),
    ).toBe('/enterprise/organizations');
    expect(document.body.textContent).not.toContain('絞り込み解除');
  });
});
