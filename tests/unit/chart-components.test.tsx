import { render, screen, within } from '@testing-library/react';
import { CircleCheck, CircleDashed, Clock, TriangleAlert } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { BarChart } from '@/components/charts/bar-chart';
import { CategoryGrid } from '@/components/charts/category-grid';
import { ChartFrame } from '@/components/charts/chart-frame';
import { FractionBar } from '@/components/charts/fraction-bar';
import { FunnelSteps } from '@/components/charts/funnel-steps';
import { LineChart } from '@/components/charts/line-chart';
import { MiniBars } from '@/components/charts/mini-bars';
import { StatusBreakdown } from '@/components/charts/status-breakdown';

/**
 * 共通の図の部品（docs/disclosure-first.md §10.4）。
 * 図だけで意味を伝えない: ラベル＋数値を文字で書き、SVG は role="img" と要点の名前を持つ。
 * null は「未入力」（0 と書かない）、件数は「n / N 件」を独立した要素で書く。
 */

describe('FractionBar', () => {
  it('「n / N 単位」を独立した要素で書き、帯は role="img" で同じ内容を名前に持つ。% は既定で出さない', () => {
    const { container } = render(
      <FractionBar label="承認済み" numerator={3} denominator={4} unit="拠点" />,
    );
    expect(screen.getByText('3 / 4 拠点')).toBeInTheDocument();
    expect(screen.getByText('承認済み')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '承認済み: 3 / 4 拠点' })).toBeInTheDocument();
    expect(container.textContent).not.toContain('%');
  });

  it('showPercent で（n%）を添える。単位の既定は「件」', () => {
    render(<FractionBar label="確定" numerator={9} denominator={12} showPercent />);
    expect(screen.getByText('9 / 12 件')).toBeInTheDocument();
    expect(screen.getByText('（75%）')).toBeInTheDocument();
  });

  it('format を渡すと、見える分数と帯の名前の両方が同じ書式になる', () => {
    render(
      <FractionBar
        label="基準年度からの削減"
        numerator={2268.4}
        denominator={3360}
        unit="t-CO2e"
        format={(n) => n.toLocaleString('ja-JP')}
      />,
    );
    expect(screen.getByText('2,268.4 / 3,360 t-CO2e')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: '基準年度からの削減: 2,268.4 / 3,360 t-CO2e' }),
    ).toBeInTheDocument();
  });

  it('分母 0 は帯を描かず「対象なし」（0% と書かない）。分数の文字は残す', () => {
    const { container } = render(
      <FractionBar label="承認済み" numerator={0} denominator={0} showPercent />,
    );
    expect(screen.getByText('0 / 0 件')).toBeInTheDocument();
    expect(screen.getByText('対象なし')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.textContent).not.toContain('%');
  });
});

describe('StatusBreakdown', () => {
  const items = [
    { key: 'approved', label: '承認済み', count: 120, icon: CircleCheck },
    { key: 'review', label: 'レビュー中', count: 1, icon: Clock, href: '/enterprise/workflows' },
    { key: 'none', label: '未提出', count: 0, icon: CircleDashed },
    { key: 'error', label: 'エラー', count: 9, icon: TriangleAlert },
  ];

  it('凡例のリスト（名前＝label）に、各項目のラベル（独立した要素・既存の文言）と件数を書く。% は出さない', () => {
    const { container } = render(<StatusBreakdown label="拠点別の状況" items={items} />);
    const list = screen.getByRole('list', { name: '拠点別の状況' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    for (const [index, [label, count]] of [
      ['承認済み', '120 件'],
      ['レビュー中', '1 件'],
      ['未提出', '0 件'],
      ['エラー', '9 件'],
    ].entries()) {
      const row = rows[index]!;
      // ラベルは独立した要素で、文言そのもの（正規表現 ^…$ で取れる）
      expect(within(row).getByText(new RegExp(`^${label}$`))).toBeInTheDocument();
      expect(within(row).getByText(count!)).toBeInTheDocument();
      // アイコンは装飾
      for (const svg of row.querySelectorAll('svg')) {
        expect(svg).toHaveAttribute('aria-hidden', 'true');
      }
    }
    expect(container.textContent).not.toContain('%');
    expect(within(list).getByRole('link', { name: 'レビュー中' })).toHaveAttribute(
      'href',
      '/enterprise/workflows',
    );
  });

  it('帯は凡例と同じ内容なので読み上げない（aria-hidden）。0 件の項目は帯に出さない', () => {
    const { container } = render(<StatusBreakdown label="内訳" items={items} />);
    const bar = container.querySelector('[aria-hidden="true"].flex');
    expect(bar).not.toBeNull();
    expect(bar?.children).toHaveLength(3);
  });

  it('denominator を渡すと件数を「n / N 単位」で書く（例: 10 事項のうち）', () => {
    render(
      <StatusBreakdown
        label="事項の結果（人の判断）"
        unit="事項"
        denominator={10}
        items={[
          { key: 'both', label: '両面で重要', count: 1 },
          { key: 'none', label: '未評価', count: 9 },
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: '事項の結果（人の判断）' });
    expect(list.textContent).toContain('両面で重要');
    expect(list.textContent).toContain('1 / 10 事項');
    expect(list.textContent).toContain('9 / 10 事項');
  });

  it('showPercent のときだけ（n%）を添える', () => {
    const { container } = render(
      <StatusBreakdown
        label="内訳"
        showPercent
        items={[
          { key: 'a', label: 'A', count: 1 },
          { key: 'b', label: 'B', count: 3 },
        ]}
      />,
    );
    expect(container.textContent).toContain('（25%）');
    expect(container.textContent).toContain('（75%）');
  });
});

describe('BarChart', () => {
  it('figure と題（figcaption）、SVG は role="img" で全数値を名前に持つ（12 個まで）。null は「未入力」', () => {
    const { container } = render(
      <BarChart
        title="Scope1 の推移"
        unit="t-CO2e"
        categories={['FY2024', 'FY2025', 'FY2026']}
        series={[{ label: 'Scope1', values: [9735.4, 8931.6, null] }]}
      />,
    );
    const figure = container.querySelector('figure');
    expect(figure?.querySelector('figcaption')?.textContent).toContain('Scope1 の推移');
    expect(figure?.querySelector('figcaption')?.textContent).toContain('単位: t-CO2e');
    const img = screen.getByRole('img', {
      name: 'Scope1 の推移（単位: t-CO2e）。FY2024 9,735.4、FY2025 8,931.6、FY2026 未入力。',
    });
    expect(img.tagName.toLowerCase()).toBe('svg');
    expect(img.getAttribute('viewBox')).toMatch(/^0 0 \d+(\.\d+)? \d+(\.\d+)?$/);
    expect(img.getAttribute('class')).toContain('w-full');
    // 数値は棒の隣に書く。null の年は棒を描かず「未入力」と書く（0 と書かない）
    const svgTexts = [...img.querySelectorAll('text')].map((t) => t.textContent);
    expect(svgTexts).toContain('9,735.4');
    expect(svgTexts).toContain('8,931.6');
    expect(svgTexts).toContain('未入力');
    expect(img.querySelectorAll('rect')).toHaveLength(2);
  });

  it('既定で「数値を表で見る」（閉じた折りたたみ）に区分 × 系列の表を置く。null は「未入力」', () => {
    const { container } = render(
      <BarChart
        title="Scope1 の推移"
        unit="t-CO2e"
        categoryLabel="年度"
        categories={['FY2024', 'FY2025', 'FY2026']}
        series={[{ label: 'Scope1', values: [9735.4, 8931.6, null] }]}
      />,
    );
    const details = container.querySelector('details');
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toContain('数値を表で見る');
    const table = within(details!).getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((c) => c.textContent),
    ).toEqual(['年度', 'Scope1']);
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((c) => c.textContent),
    ).toEqual(['FY2024', 'FY2025', 'FY2026']);
    expect(within(table).getByText('未入力')).toBeInTheDocument();
  });

  it('2 系列以上は凡例（HTML のラベル）を出す。積み上げの表には合計の列', () => {
    render(
      <BarChart
        title="年次の影響"
        unit="百万円"
        stacked
        categories={['FY2026', 'FY2027']}
        series={[
          { label: 'P1 化石燃料賦課金', values: [0, -8.9] },
          { label: 'P6 採用単価', values: [-0.4, -0.8] },
        ]}
      />,
    );
    const legend = screen.getByRole('list', { name: '年次の影響の凡例' });
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['P1 化石燃料賦課金', 'P6 採用単価']);
    const table = screen.getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((c) => c.textContent),
    ).toEqual(['区分', 'P1 化石燃料賦課金', 'P6 採用単価', '合計']);
    // 合計（−9.7）は図にも書く
    expect(screen.getByRole('img').textContent).toContain('−9.7');
  });

  it('table={false} でも、数値が 12 個を超える図は表を出す（名前に全数値を書けないため）', () => {
    const categories = Array.from({ length: 10 }, (_, i) => `FY${2026 + i}`);
    const { container } = render(
      <BarChart
        title="年次の影響"
        unit="百万円"
        table={false}
        categories={categories}
        series={[
          { label: 'P1', values: categories.map((_, i) => -i) },
          { label: 'P2', values: categories.map(() => 1) },
        ]}
      />,
    );
    expect(container.querySelector('table')).not.toBeNull();
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('「数値を表で見る」');

    const small = render(
      <BarChart
        title="小"
        unit="件"
        table={false}
        categories={['a']}
        series={[{ label: 's', values: [1] }]}
      />,
    );
    expect(small.container.querySelector('table')).toBeNull();
  });

  it('明るい色の系列には枠を付ける（白い背景に溶けない）', () => {
    const { container } = render(
      <BarChart
        title="系列"
        unit="件"
        categories={['a']}
        series={[0, 1, 2].map((i) => ({ label: `s${i}`, values: [i + 1] }))}
      />,
    );
    const rects = [...container.querySelectorAll('svg[role="img"] rect')];
    expect(rects[2]?.getAttribute('class')).toContain('stroke-brand-700');
    expect(rects[0]?.getAttribute('class')).not.toContain('stroke-brand-700');
  });
});

describe('LineChart', () => {
  it('null で線を切り、どの系列にも値が無い年は「未入力」。role="img" の名前に全数値', () => {
    const { container } = render(
      <LineChart
        title="Scope1 の推移"
        unit="t-CO2e"
        xLabels={['FY2024', 'FY2025', 'FY2026']}
        series={[{ label: 'Scope1', values: [9735.4, 8931.6, null] }]}
      />,
    );
    const img = screen.getByRole('img', {
      name: 'Scope1 の推移（単位: t-CO2e）。FY2024 9,735.4、FY2025 8,931.6、FY2026 未入力。',
    });
    expect(img.querySelectorAll('polyline')).toHaveLength(1);
    expect(img.querySelector('polyline')?.getAttribute('points')?.split(' ')).toHaveLength(2);
    expect([...img.querySelectorAll('text')].map((t) => t.textContent)).toContain('未入力');
    // 1 系列は凡例を出さない（題が名前）
    expect(container.querySelector('ul')).toBeNull();
  });

  it('2 系列は線種と点の形を変え、凡例に線種を文字でも書く', () => {
    const { container } = render(
      <LineChart
        title="10 年累計"
        unit="百万円"
        xLabels={['FY2026', 'FY2027']}
        series={[
          { label: '現状維持', values: [-1, -2] },
          { label: '目標達成', values: [-1, -1.5], dashed: true },
        ]}
      />,
    );
    const lines = [...container.querySelectorAll('svg[role="img"] polyline')];
    expect(lines[0]?.getAttribute('stroke-dasharray')).toBeNull();
    expect(lines[1]?.getAttribute('stroke-dasharray')).not.toBeNull();
    const legend = screen.getByRole('list', { name: '10 年累計の凡例' });
    expect(legend.textContent).toContain('現状維持（実線）');
    expect(legend.textContent).toContain('目標達成（破線）');
    // 点の形が違う（丸と四角）
    const svg = container.querySelector('svg[role="img"]')!;
    expect(svg.querySelectorAll('circle').length).toBeGreaterThan(0);
    expect(svg.querySelectorAll('rect').length).toBeGreaterThan(0);
  });
});

describe('MiniBars', () => {
  it('decorative は aria-hidden（値は隣のセル）。null は破線の空枠', () => {
    const { container } = render(
      <MiniBars
        decorative
        values={[9735.4, 8931.6, null]}
        labels={['FY2024', 'FY2025', 'FY2026']}
      />,
    );
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg.getAttribute('role')).toBeNull();
    expect(svg.querySelectorAll('rect[stroke-dasharray]')).toHaveLength(1);
  });

  it('decorative でなければ role="img" と全年度の値（null は「未入力」）の名前', () => {
    render(
      <MiniBars
        label="Scope1 の推移"
        unit="t-CO2e"
        values={[9735.4, 8931.6, null]}
        labels={['FY2024', 'FY2025', 'FY2026']}
      />,
    );
    expect(
      screen.getByRole('img', {
        name: 'Scope1 の推移: FY2024 9,735.4 t-CO2e、FY2025 8,931.6 t-CO2e、FY2026 未入力',
      }),
    ).toBeInTheDocument();
  });
});

describe('CategoryGrid・FunnelSteps・ChartFrame', () => {
  it('CategoryGrid: 区分ごとに名前・状態の文字（アイコンは装飾）・値。値の無い区分に 0 を書かない', () => {
    render(
      <CategoryGrid
        label="Scope3 のカテゴリ"
        items={[
          {
            key: 'cat1',
            label: 'Cat.1 購入した製品・サービス',
            stateLabel: '算定済み',
            icon: CircleCheck,
            filled: true,
            value: '1,234.5 t-CO2e',
          },
          {
            key: 'cat2',
            label: 'Cat.2 資本財',
            stateLabel: '未算定',
            icon: CircleDashed,
            filled: false,
          },
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: 'Scope3 のカテゴリ' });
    const [first, second] = within(list).getAllByRole('listitem');
    expect(within(first!).getByText('算定済み')).toBeInTheDocument();
    expect(within(first!).getByText('1,234.5 t-CO2e')).toBeInTheDocument();
    expect(within(second!).getByText('未算定')).toBeInTheDocument();
    expect(second!.textContent).not.toMatch(/\b0\b/);
    expect(first).toHaveAttribute('data-filled', 'true');
    expect(second).toHaveAttribute('data-filled', 'false');
    for (const svg of list.querySelectorAll('svg')) {
      expect(svg).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('FunnelSteps: 段ごとに名前と件数の文字（帯は装飾）', () => {
    render(
      <FunnelSteps
        label="要求事項の絞り込み"
        steps={[
          { label: '収録', count: 133 },
          { label: '適用', count: 40, href: '/enterprise/disclosures/ssbj/requirements' },
          { label: '評価対象', count: 0, unit: '項目' },
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: '要求事項の絞り込み' });
    const steps = within(list).getAllByRole('listitem');
    expect(steps.map((s) => s.textContent)).toEqual(['収録133 件', '適用40 件', '評価対象0 項目']);
    expect(within(list).getByRole('link', { name: '適用' })).toHaveAttribute(
      'href',
      '/enterprise/disclosures/ssbj/requirements',
    );
  });

  it('ChartFrame: figure＋figcaption、SVG は viewBox・w-full・role="img"＋名前、表は閉じた「数値を表で見る」', () => {
    const { container } = render(
      <ChartFrame
        title="経路図"
        summary="起点 3 つから財務項目 4 つへの経路"
        width={720}
        height={320}
        note="定量化できた経路のみ（7 / 10 経路）"
        table={{
          caption: '経路の一覧',
          columns: [{ label: '経路' }, { label: 'FY2030', align: 'right' }],
          rows: [{ key: 'P1', cells: ['P1', '−17.9'] }],
        }}
      >
        <rect x={0} y={0} width={10} height={10} />
      </ChartFrame>,
    );
    const figure = container.querySelector('figure')!;
    expect(figure.firstElementChild?.tagName.toLowerCase()).toBe('figcaption');
    expect(figure.querySelector('figcaption')?.textContent).toContain(
      '定量化できた経路のみ（7 / 10 経路）',
    );
    const svg = screen.getByRole('img', { name: '起点 3 つから財務項目 4 つへの経路' });
    expect(svg).toHaveAttribute('viewBox', '0 0 720 320');
    expect(svg.getAttribute('class')).toContain('w-full');
    const details = figure.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(within(details).getByRole('table')).toHaveTextContent('経路の一覧');
    expect(within(details).getByRole('rowheader', { name: 'P1' })).toBeInTheDocument();
  });
});
