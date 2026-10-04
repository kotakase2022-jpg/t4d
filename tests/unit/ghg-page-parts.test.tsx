import { render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { GhgTrendMetric, yoyPercent, yoyText } from '@/app/enterprise/ghg/_components/ghg-trend';
import {
  Scope3CategoryGrid,
  scope3CategoryLabel,
  scope3GridItems,
} from '@/app/enterprise/ghg/_components/scope3-category-grid';
import { ORG_IDS, PERIOD_IDS } from '@/lib/fixtures/dataset';
import { createFixtureDb } from '@/lib/fixtures/store';
import type { Scope3CategoryStatus, TrendPoint } from '@/lib/services/aggregation';
import type { MetricDefinition, ReportingPeriod } from '@/types/domain';

/**
 * GHG 画面の図の部品（docs/disclosure-first.md §10.4 B5）。
 *  - 直近 3 年の推移は小さな折れ線。値の無い年は線を切り「未入力」と書く（0 にしない）
 *  - 前年比は矢印＋符号＋数値。増減の良し悪しを赤緑で示さない。片方の年に値が無ければ比べない
 *  - Scope3 の 15 カテゴリーは格子。状態は文字＋アイコン、値の無いカテゴリーに 0 を書かない
 */

let fy2024: ReportingPeriod;
let fy2025: ReportingPeriod;
let fy2026: ReportingPeriod;
let scope1: MetricDefinition;
let cat2: MetricDefinition;

beforeAll(() => {
  const fixture = createFixtureDb();
  const periodOf = (id: string) => fixture.periods.find((p) => p.id === id)!;
  fy2024 = periodOf(PERIOD_IDS.fy2024);
  fy2025 = periodOf(PERIOD_IDS.fy2025);
  fy2026 = periodOf(PERIOD_IDS.fy2026);
  const metricOf = (code: string) =>
    fixture.metrics.find((m) => m.organizationId === ORG_IDS.aomi && m.code === code)!;
  scope1 = metricOf('scope1');
  cat2 = metricOf('scope3_cat2');
});

describe('前年比（GHG の推移）', () => {
  it('両年に値があり前年が 0 でないときだけ、小数 1 桁の % で出す', () => {
    expect(yoyPercent(9_735.4, 8_931.6)).toBe(-8.3);
    expect(yoyPercent(100, 102.14)).toBe(2.1);
    expect(yoyPercent(null, 8_931.6)).toBeNull();
    expect(yoyPercent(9_735.4, null)).toBeNull();
    expect(yoyPercent(0, 10)).toBeNull();
  });

  it('文字は符号付き（既存の表示と同じ ASCII の符号）', () => {
    expect(yoyText(-8.3)).toBe('-8.3%');
    expect(yoyText(2.1)).toBe('+2.1%');
    expect(yoyText(0)).toBe('0%');
  });
});

describe('GhgTrendMetric', () => {
  const series = (): TrendPoint[] => [
    { period: fy2024, metric: scope1, value: 9_735.4, estimated: false },
    { period: fy2025, metric: scope1, value: 8_931.6, estimated: false },
    { period: fy2026, metric: scope1, value: null, estimated: false },
  ];

  it('折れ線は role=img で、名前に全数値。点の隣に数値を書き、値の無い年は「未入力」（0 にしない）', () => {
    const { container } = render(<GhgTrendMetric series={series()} />);
    const chart = screen.getByRole('img');
    const label = chart.getAttribute('aria-label') ?? '';
    expect(label).toContain(scope1.name);
    expect(label).toContain('9,735.4');
    expect(label).toContain('8,931.6');
    const svgText = [...chart.querySelectorAll('text')].map((t) => t.textContent);
    expect(svgText).toContain('9,735.4');
    expect(svgText).toContain('8,931.6');
    expect(svgText).toContain('未入力');
    expect(svgText).not.toContain('0.0');
    // 図と同じ数値の表は出さない（数値は 3 つで、名前と点の隣に全部ある）
    expect(container.querySelector('table')).toBeNull();
  });

  it('前年比は矢印＋符号＋数値。比べられない年は「—」と理由（読み上げ用）。赤緑の色を付けない', () => {
    const { container } = render(<GhgTrendMetric series={series()} />);
    expect(screen.getByText('-8.3%')).toBeTruthy();
    expect(screen.getByText('（前年か当年の値が無いため比べません）')).toBeTruthy();
    const yoyLine = screen.getByText('前年比').parentElement!;
    for (const icon of yoyLine.querySelectorAll('svg')) {
      expect(icon.getAttribute('aria-hidden')).toBe('true');
    }
    expect(container.innerHTML).not.toMatch(/text-(danger|success)/);
  });

  it('推計を含む年度は「推計込み」のバッジ（ラベル＋アイコン）', () => {
    const withEstimate = series().map((row, index) =>
      index === 2 ? { ...row, value: 8_500, estimated: true } : row,
    );
    render(<GhgTrendMetric series={withEstimate} />);
    const badge = screen.getByText(`${fy2026.code} 推計込み`);
    expect(badge.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('どの年度にも指標が無ければ描かない', () => {
    const { container } = render(
      <GhgTrendMetric series={[{ period: fy2024, metric: null, value: null, estimated: false }]} />,
    );
    expect(container.innerHTML).toBe('');
  });
});

describe('Scope3 カテゴリーの格子', () => {
  const category = (overrides: Partial<Scope3CategoryStatus>): Scope3CategoryStatus => ({
    category: 2,
    code: 'scope3_cat2',
    metric: cat2,
    state: 'not_entered',
    total: null,
    estimateTotal: null,
    count: 0,
    reasons: [],
    ...overrides,
  });

  it('名前は「Cat.n 区分名」。指標が無ければ「Cat.n」', () => {
    expect(scope3CategoryLabel(category({}))).toBe(`Cat.2 ${cat2.name.match(/（(.+)）$/)?.[1]}`);
    expect(scope3CategoryLabel(category({ metric: null }))).toBe('Cat.2');
  });

  it('状態は既存のバッジと同じ文言。値のあるカテゴリーだけ塗り、値を書く（無いカテゴリーに 0 を書かない）', () => {
    const items = scope3GridItems([
      category({ category: 1, code: 'scope3_cat1', state: 'value_present', total: 50_620.5 }),
      category({ state: 'not_entered' }),
      category({ category: 3, code: 'scope3_cat3', state: 'not_applicable', reasons: ['対象外'] }),
      category({ category: 4, code: 'scope3_cat4', state: 'not_calculated' }),
      category({
        category: 5,
        code: 'scope3_cat5',
        state: 'value_present',
        total: 12,
        estimateTotal: 3.5,
      }),
    ]);
    expect(items.map((i) => [i.stateLabel, i.filled, i.value])).toEqual([
      ['値あり', true, '50,620.5 t-CO2e'],
      ['未入力', false, undefined],
      ['対象外', false, undefined],
      ['未算定', false, undefined],
      ['値あり', true, '12 t-CO2e・推計 3.5'],
    ]);
  });

  it('状態を持たない古い行は「値あり」として読む（バッジと同じ）', () => {
    const legacy = category({ state: undefined as unknown as Scope3CategoryStatus['state'] });
    expect(scope3GridItems([legacy])[0]?.stateLabel).toBe('値あり');
  });

  it('格子は名前付きのリスト。状態は文字とアイコン（読み上げない）で示す', () => {
    render(
      <Scope3CategoryGrid
        categories={[
          category({ category: 1, code: 'scope3_cat1', state: 'value_present', total: 10 }),
          category({}),
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: 'Scope3 カテゴリー別の状況' });
    const cells = within(list).getAllByRole('listitem');
    expect(cells).toHaveLength(2);
    expect(cells[1]?.textContent).toContain('未入力');
    expect(cells[1]?.getAttribute('data-filled')).toBe('false');
    for (const icon of list.querySelectorAll('svg')) {
      expect(icon.getAttribute('aria-hidden')).toBe('true');
    }
  });
});
