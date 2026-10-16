import { render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { GhgTrendMetric, yoyPercent, yoyText } from '@/app/enterprise/ghg/_components/ghg-trend';
import {
  Scope3CategoryGrid,
  scope3CategoryLabel,
  scope3GridItems,
} from '@/app/enterprise/ghg/_components/scope3-category-grid';
import {
  consolidationMetricCodes,
  factorOriginCounts,
  intercompanyTrendNote,
} from '@/app/enterprise/ghg/_components/summary-parts';
import { ORG_IDS, PERIOD_IDS } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
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

/**
 * 表示の誠実さ（plan CR-16・GE-15）: 連結集計の指標・内部取引控除の年度の文・係数の「架空値」の印を
 * コードに固定せず、指標マスター・集計ルール・推移の控除の有無・係数の出所から導く
 */
describe('GHG 算定サマリーの表示の誠実さ（CR-16）', () => {
  let db: FixtureDb;
  beforeAll(() => {
    db = createFixtureDb();
  });

  it('連結集計の指標は、拠点で集める GHG の指標＋集計ルールを持つ指標（Fixture では従来の 4 指標と同じ）', () => {
    const metrics = db.metrics.filter((m) => m.organizationId === ORG_IDS.aomi);
    const rules = db.aggregationRules.filter((r) => r.organizationId === ORG_IDS.aomi);
    expect(consolidationMetricCodes(metrics, rules)).toEqual([
      'scope1',
      'scope2',
      'scope2_location',
      'scope3_cat1',
    ]);
    // 集計ルールが無ければ本社だけで集める Scope3 の指標は並べない。比率の指標（原単位）は並べない
    expect(consolidationMetricCodes(metrics, [])).toEqual(['scope1', 'scope2', 'scope2_location']);
    // 組織が足した拠点の GHG の指標・集計ルールを足した Scope3 の指標は並ぶ（コードに固定しない）
    const custom = {
      ...metrics.find((m) => m.code === 'scope1')!,
      id: 'm-ch4',
      code: 'scope1_ch4',
    };
    const cat2 = metrics.find((m) => m.code === 'scope3_cat2')!;
    expect(
      consolidationMetricCodes([...metrics, custom], [...rules, { metricId: cat2.id }]),
    ).toEqual(['scope1', 'scope1_ch4', 'scope2', 'scope2_location', 'scope3_cat1', 'scope3_cat2']);
  });

  it('内部取引控除の文は推移の年度ごとの控除の有無から作る（固定の年度を書かない）', () => {
    const entry = (code: string, eliminated: number) => ({
      period: { code },
      metrics: [{ intercompanyEliminated: 0 }, { intercompanyEliminated: eliminated }],
    });
    expect(
      intercompanyTrendNote([entry('FY2024', 0), entry('FY2025', 0), entry('FY2026', 2490.5)]),
    ).toBe('内部取引控除は FY2026 から適用（過年度は控除前の値）。');
    expect(
      intercompanyTrendNote([entry('FY2024', 0), entry('FY2025', 10), entry('FY2026', 20)]),
    ).toBe('内部取引控除は FY2025 から適用（過年度は控除前の値）。');
    expect(intercompanyTrendNote([entry('FY2025', 1), entry('FY2026', 2)])).toBe(
      '内部取引控除は表示した全年度（FY2025・FY2026）に適用しています。',
    );
    expect(
      intercompanyTrendNote([entry('FY2024', 5), entry('FY2025', 0), entry('FY2026', 2)]),
    ).toBe('内部取引控除は FY2024・FY2026 に適用（FY2025 は控除前の値）。');
    // 控除がどの年度にも無ければ文を出さない
    expect(intercompanyTrendNote([entry('FY2025', 0), entry('FY2026', 0)])).toBeNull();
    expect(intercompanyTrendNote([])).toBeNull();
  });

  it('係数の出所: セットの origin、セットに属さない係数は出典の Fixture の印。組織指定を「架空」に数えない', () => {
    const cat1 = db.emissionFactors.filter(
      (f) => f.organizationId === ORG_IDS.aomi && f.factorSetId === null,
    );
    const sets = db.emissionFactorSets.filter((s) => s.organizationId === ORG_IDS.aomi);
    expect(cat1.length).toBeGreaterThan(0);
    expect(factorOriginCounts(cat1, sets)).toEqual({
      fixture: cat1.length,
      customer_specified: 0,
      public_reference: 0,
      unclassified: 0,
    });
    const own = { ...sets[0]!, id: 'set-own', origin: 'customer_specified' as const };
    const counts = factorOriginCounts(
      [
        { factorSetId: 'set-own', factorSource: '組織の係数表 2025' },
        { factorSetId: null, factorSource: '社内の係数表（2025 年版）' },
        { factorSetId: null, factorSource: 'FIXTURE（架空値・実係数ではありません）' },
      ],
      [...sets, own],
    );
    expect(counts).toEqual({
      fixture: 1,
      customer_specified: 1,
      public_reference: 0,
      unclassified: 1,
    });
  });
});
