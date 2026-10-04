import { describe, expect, it } from 'vitest';
import {
  aggregationNoteOf,
  basisChangeReasons,
  buildTrendRow,
  changeViewOf,
  filterMetricTrendRows,
  fiscalEndMonthOf,
  formatTrendChange,
  formatTrendValue,
  isLargeChange,
  isTrendMetric,
  NO_TREND_FILTERS,
  parseTrendFilters,
  periodMonthsOf,
  sortTrendRows,
  summarizeTrends,
  trendCellOf,
  trendFilterQuery,
  trendGroupOf,
  trendWindowNote,
  type TrendContributionInput,
  type TrendPeriodInput,
  type TrendStateInput,
} from '@/lib/domain/metric-trend';
import { METRIC_CATEGORIES } from '@/types/domain';

/**
 * 自社経年比較の純関数（docs/disclosure-first.md §10.2）。
 * 群の対応・セルの各状態・前年比（pt と %・前年 0・大きな変化）・比較の前提の違い 3 種・絞込と要約。
 */

const FY2024: TrendPeriodInput = { code: 'FY2024', startDate: '2024-04-01', endDate: '2025-03-31' };
const FY2025: TrendPeriodInput = { code: 'FY2025', startDate: '2025-04-01', endDate: '2026-03-31' };
const FY2026: TrendPeriodInput = { code: 'FY2026', startDate: '2026-04-01', endDate: '2027-03-31' };

function row(overrides: Partial<TrendContributionInput> = {}): TrendContributionInput {
  return {
    unitName: '本社',
    status: 'approved',
    boundary: '連結',
    factor: 1,
    value: 100,
    unitOfMeasure: 't-CO2e',
    ...overrides,
  };
}

/** 4 拠点すべて承認済み・値ありの確定した年度（上書きで各状態を作る） */
function state(overrides: Partial<TrendStateInput> = {}): TrendStateInput {
  return {
    metric: { unit: 't-CO2e' },
    period: FY2025,
    hasData: true,
    computable: true,
    approvedValue: 400,
    complete: true,
    expectedUnitCount: 4,
    approvedUnits: ['本社', '東日本工場', '西日本工場', '欧州販売子会社'],
    pendingUnits: [],
    missingUnits: [],
    notApplicableUnits: [],
    estimateUnits: [],
    targetOnlyUnits: [],
    contributions: [
      row(),
      row({ unitName: '東日本工場' }),
      row({ unitName: '西日本工場' }),
      row({ unitName: '欧州販売子会社' }),
    ],
    ...overrides,
  };
}

describe('群の対応（trendGroupOf）', () => {
  it('ghg → GHG、energy・water・waste・climate_transition → 環境、human_capital → 社会、governance → ガバナンス', () => {
    expect(Object.fromEntries(METRIC_CATEGORIES.map((c) => [c, trendGroupOf(c)]))).toEqual({
      ghg: 'ghg',
      energy: 'environment',
      water: 'environment',
      waste: 'environment',
      climate_transition: 'environment',
      human_capital: 'social',
      governance: 'governance',
    });
  });

  it('文章・該否の指標は経年比較に並べない', () => {
    expect(isTrendMetric({ dataType: 'number' })).toBe(true);
    expect(isTrendMetric({ dataType: 'integer' })).toBe(true);
    expect(isTrendMetric({ dataType: 'ratio' })).toBe(true);
    expect(isTrendMetric({ dataType: 'text' })).toBe(false);
    expect(isTrendMetric({ dataType: 'boolean' })).toBe(false);
  });
});

describe('セルの状態（trendCellOf）', () => {
  it('確定（全拠点承認済み・値あり）だけが数値を持つ', () => {
    expect(trendCellOf(state())).toEqual({
      kind: 'confirmed',
      value: 400,
      label: '確定',
      approvedCount: 4,
      expectedCount: 4,
    });
  });

  it('行が無ければ「未入力」で値は null（0 にしない）', () => {
    const cell = trendCellOf(
      state({
        hasData: false,
        complete: false,
        approvedValue: null,
        approvedUnits: [],
        missingUnits: ['本社', '東日本工場', '西日本工場', '欧州販売子会社'],
        contributions: [],
      }),
    );
    expect(cell.kind).toBe('not_entered');
    expect(cell.label).toBe('未入力');
    expect(cell.value).toBeNull();
  });

  it('集計方法が合計できない指標は「全社値は算定不可」（拠点値があっても全社値にしない）', () => {
    const cell = trendCellOf(state({ computable: false, approvedValue: null }));
    expect(cell).toMatchObject({ kind: 'not_computable', label: '全社値は算定不可', value: null });
  });

  it('未承認・未入力の拠点が残れば「集計中（承認済み n/N 拠点）」で、途中合計を値にしない', () => {
    const cell = trendCellOf(
      state({
        complete: false,
        approvedValue: 300,
        approvedUnits: ['本社', '東日本工場', '西日本工場'],
        pendingUnits: [{ unitName: '欧州販売子会社', status: 'submitted' }],
      }),
    );
    expect(cell).toMatchObject({
      kind: 'incomplete',
      label: '集計中（承認済み 3/4 拠点）',
      value: null,
      approvedCount: 3,
      expectedCount: 4,
    });
  });

  it('推計の拠点だけが残れば「推計を含む（実績 n/N 拠点）」', () => {
    const cell = trendCellOf(
      state({
        complete: false,
        approvedUnits: ['本社', '東日本工場', '西日本工場'],
        estimateUnits: ['欧州販売子会社'],
      }),
    );
    expect(cell).toMatchObject({ kind: 'estimate_included', label: '推計を含む（実績 3/4 拠点）' });
    expect(cell.value).toBeNull();
  });

  it('全拠点が対象外と判断なら「対象外と判断」、承認済みでも実績値が無ければ「承認済みの実績なし」', () => {
    const allNa = trendCellOf(
      state({
        approvedValue: null,
        approvedUnits: [],
        notApplicableUnits: ['本社', '東日本工場', '西日本工場', '欧州販売子会社'],
      }),
    );
    expect(allNa).toMatchObject({ kind: 'not_applicable', label: '対象外と判断', value: null });

    const targetOnly = trendCellOf(
      state({
        complete: false,
        approvedValue: null,
        expectedUnitCount: 1,
        approvedUnits: [],
        targetOnlyUnits: ['本社'],
        contributions: [row()],
      }),
    );
    expect(targetOnly).toMatchObject({ kind: 'no_actual', label: '承認済みの実績なし' });

    const noValue = trendCellOf(state({ approvedValue: null }));
    expect(noValue.kind).toBe('no_actual');
  });

  it('承認済みで連結値に入る行の単位が指標と違えば「単位の確認が必要」で値を出さない', () => {
    const cell = trendCellOf(
      state({ contributions: [row(), row({ unitName: '東日本工場', unitOfMeasure: 'kg' })] }),
    );
    expect(cell).toMatchObject({ kind: 'unit_mismatch', label: '単位の確認が必要', value: null });
  });

  it('単位違いでも、未承認の行・連結値に入らない拠点（持分法）は単位の確認にしない', () => {
    const pending = trendCellOf(
      state({ contributions: [row(), row({ status: 'in_review', unitOfMeasure: 'kg' })] }),
    );
    expect(pending.kind).toBe('confirmed');
    const equity = trendCellOf(
      state({ contributions: [row(), row({ factor: 0, unitOfMeasure: 'kg' })] }),
    );
    expect(equity.kind).toBe('confirmed');
  });
});

describe('前年比の表示（changeViewOf・formatTrendChange）', () => {
  const ghg = { unit: 't-CO2e', yoyWarningRatio: 0.3 };

  it('合計の指標は「±x.x%（±差 単位）」。マイナスは「−」', () => {
    const view = changeViewOf(
      { status: 'ok', previousValue: 9735.4, diff: 8931.6 - 9735.4, diffRate: -8.2564, notes: [] },
      [],
      ghg,
    );
    expect(view).toEqual({
      kind: 'value',
      direction: 'down',
      text: '−8.3%（−803.8 t-CO2e）',
      large: false,
      notes: [],
    });
  });

  it('単位が % の指標は % ポイントの差だけ（相対 % を出さない）', () => {
    expect(formatTrendChange({ diff: 3.25, diffRate: 21.67, previousValue: 15, unit: '%' })).toBe(
      '+3.25 pt',
    );
    expect(
      formatTrendChange({ diff: 14.04 - 15, diffRate: -6.4, previousValue: 15, unit: '%' }),
    ).toBe('−0.96 pt');
  });

  it('前年が 0 なら差だけ（割らない）。差が 0 なら「±」', () => {
    expect(formatTrendChange({ diff: 5, diffRate: null, previousValue: 0, unit: '人' })).toBe(
      '+5 人',
    );
    expect(formatTrendChange({ diff: 0, diffRate: 0, previousValue: 12, unit: '人' })).toBe(
      '±0.0%（±0 人）',
    );
    const flat = changeViewOf(
      { status: 'ok', previousValue: 12, diff: 0, diffRate: 0, notes: [] },
      [],
      { unit: '人', yoyWarningRatio: null },
    );
    expect(flat).toMatchObject({ kind: 'value', direction: 'flat' });
  });

  it('大きな変化は |差|/|前年| が許容幅を超えたときだけ（許容幅の無い指標・前年 0 は常に false）', () => {
    expect(isLargeChange(100, 31, 0.3)).toBe(true);
    expect(isLargeChange(100, -31, 0.3)).toBe(true);
    expect(isLargeChange(100, 30, 0.3)).toBe(false);
    expect(isLargeChange(12, -9, null)).toBe(false);
    expect(isLargeChange(0, 5, 0.3)).toBe(false);
    const view = changeViewOf(
      {
        status: 'ok',
        previousValue: 100,
        diff: 45,
        diffRate: 45,
        notes: ['FY2025 本社: 版 2 で訂正'],
      },
      [],
      ghg,
    );
    expect(view).toMatchObject({
      kind: 'value',
      direction: 'up',
      text: '+45.0%（+45 t-CO2e）',
      large: true,
      notes: ['FY2025 本社: 版 2 で訂正'],
    });
  });

  it('比較が ok でも前提の違いがあれば数値を出さず「比較条件の確認が必要」', () => {
    const view = changeViewOf(
      { status: 'ok', previousValue: 48210, diff: -79.5, diffRate: -0.16, notes: [] },
      [{ kind: 'intercompany', text: '内部取引の控除が FY2026 だけにあります' }],
      { unit: 't-CO2e', yoyWarningRatio: 0.4 },
    );
    expect(view).toEqual({
      kind: 'needs_check',
      reasons: ['内部取引の控除が FY2026 だけにあります'],
    });
  });

  it('kpi.ts の比較が needs_check なら理由をそのまま（前提の違いも重複なく足す）、unavailable は理由だけ', () => {
    expect(
      changeViewOf(
        { status: 'needs_check', reasons: ['境界が変わっています'], notes: [] },
        [{ kind: 'unit', text: '単位が違います' }],
        ghg,
      ),
    ).toEqual({ kind: 'needs_check', reasons: ['境界が変わっています', '単位が違います'] });
    expect(
      changeViewOf({ status: 'unavailable', reason: 'FY2026 の確定値がありません。' }, [], ghg),
    ).toEqual({ kind: 'unavailable', reason: 'FY2026 の確定値がありません。' });
  });
});

describe('比較の前提の違い（basisChangeReasons）', () => {
  it('同じ前提なら空', () => {
    expect(basisChangeReasons(state({ period: FY2024 }), state({ period: FY2025 }))).toEqual([]);
  });

  it('(a) 承認済みの内部取引の行が片方の年度だけにある', () => {
    const withIc = state({
      period: FY2026,
      contributions: [row(), row({ boundary: '内部取引', value: 1850 })],
    });
    const reasons = basisChangeReasons(state({ period: FY2025 }), withIc);
    expect(reasons.map((r) => r.kind)).toEqual(['intercompany']);
    expect(reasons[0]!.text).toContain(
      '内部取引の控除が FY2026 だけにあります（FY2025 は控除なし）',
    );

    // 両年度にあれば同じ前提。未承認・持分法（係数 0）の内部取引行は控除に入らないので数えない
    expect(basisChangeReasons({ ...withIc, period: FY2025 }, withIc)).toEqual([]);
    const pendingIc = state({
      period: FY2026,
      contributions: [row(), row({ boundary: '内部取引', status: 'in_review' })],
    });
    expect(basisChangeReasons(state(), pendingIc)).toEqual([]);
    const equityIc = state({
      period: FY2026,
      contributions: [row(), row({ boundary: '内部取引', factor: 0 })],
    });
    expect(basisChangeReasons(state(), equityIc)).toEqual([]);
  });

  it('(b) 連結値に入った承認済みの行の単位が指標の単位と違う', () => {
    const kg = state({
      period: FY2026,
      contributions: [row(), row({ unitName: '東日本工場', unitOfMeasure: 'kg' })],
    });
    const reasons = basisChangeReasons(state(), kg);
    expect(reasons).toEqual([
      {
        kind: 'unit',
        text: 'FY2026 東日本工場: 単位「kg」が指標の単位「t-CO2e」と異なります。',
      },
    ]);
  });

  it('(c) 期間の月数・決算月が違う、期間が連続していない', () => {
    // 決算期の変更（4 月〜12 月の 9 か月）
    const shortYear = state({
      period: { code: 'FY2026', startDate: '2026-04-01', endDate: '2026-12-31' },
    });
    expect(periodMonthsOf(shortYear.period)).toBe(9);
    expect(fiscalEndMonthOf(shortYear.period)).toBe(12);
    expect(basisChangeReasons(state(), shortYear).map((r) => r.kind)).toEqual([
      'period_length',
      'fiscal_end',
    ]);
    expect(basisChangeReasons(state(), shortYear)[0]!.text).toBe(
      '報告期間の長さが異なります（FY2025 12 か月／FY2026 9 か月）。',
    );

    // FY2023 が無く FY2022 → FY2024 を並べたら「前年比」にしない
    const fy2022 = state({
      period: { code: 'FY2022', startDate: '2022-04-01', endDate: '2023-03-31' },
    });
    expect(basisChangeReasons(fy2022, state({ period: FY2024 })).map((r) => r.kind)).toEqual([
      'period_gap',
    ]);
  });
});

describe('行・絞込・要約', () => {
  const metric = (code: string, category: 'ghg' | 'human_capital' | 'governance' | 'water') => ({
    code,
    name: `${code} の名前`,
    unit: 't-CO2e',
    category,
    yoyWarningRatio: 0.3,
  });

  it('行: 隣り合う年度ごとに前提を確かめ、内部取引の控除の違いは数値にしない', () => {
    const view = buildTrendRow({
      metric: metric('scope3_cat1', 'ghg'),
      years: [
        { state: state({ period: FY2024 }) },
        { state: state({ period: FY2025 }) },
        {
          state: state({
            period: FY2026,
            contributions: [row(), row({ boundary: '内部取引' })],
          }),
        },
      ],
      changes: [
        { status: 'ok', previousValue: 400, diff: 0, diffRate: 0, notes: [] },
        { status: 'ok', previousValue: 400, diff: -1, diffRate: -0.25, notes: [] },
      ],
    });
    expect(view.group).toBe('ghg');
    // 値は 3 年とも確定（控除の有無はセルではなく前年比で示す）
    expect(view.cells.map((c) => c.kind)).toEqual(['confirmed', 'confirmed', 'confirmed']);
    expect(view.changes.map((c) => c.kind)).toEqual(['value', 'needs_check']);
    expect(view.basisReasons[0]).toEqual([]);
    expect(view.basisReasons[1]!.map((r) => r.kind)).toEqual(['intercompany']);
    expect(view.hasAnyData).toBe(true);
  });

  const rows = [
    {
      ...buildTrendRow({
        metric: metric('female_managers', 'human_capital'),
        years: [{ state: state({ period: FY2025 }) }, { state: state({ period: FY2026 }) }],
        changes: [{ status: 'ok', previousValue: 100, diff: 50, diffRate: 50, notes: [] }],
      }),
    },
    {
      ...buildTrendRow({
        metric: metric('scope1', 'ghg'),
        years: [
          { state: state({ period: FY2025 }) },
          {
            state: state({
              period: FY2026,
              complete: false,
              pendingUnits: [{ unitName: '欧州販売子会社', status: 'submitted' }],
            }),
          },
        ],
        changes: [{ status: 'unavailable', reason: 'FY2026 の確定値がありません。' }],
      }),
    },
    {
      ...buildTrendRow({
        metric: metric('officers_total', 'governance'),
        years: [{ state: state({ period: FY2025 }) }, { state: state({ period: FY2026 }) }],
        changes: [{ status: 'needs_check', reasons: ['境界が変わっています'], notes: [] }],
      }),
    },
    {
      ...buildTrendRow({
        metric: metric('water_discharge', 'water'),
        years: [
          { state: state({ period: FY2025, hasData: false, contributions: [] }) },
          { state: state({ period: FY2026, hasData: false, contributions: [] }) },
        ],
        changes: [{ status: 'unavailable', reason: 'FY2026 の確定値がありません。' }],
      }),
    },
  ];

  it('群の順（GHG → 環境 → 社会 → ガバナンス）に並べ、群の中は元の順', () => {
    expect(sortTrendRows(rows).map((r) => r.metric.code)).toEqual([
      'scope1',
      'water_discharge',
      'female_managers',
      'officers_total',
    ]);
  });

  it('既定ではデータが 1 年もない指標を隠し、empty で出す', () => {
    const codes = (filters: typeof NO_TREND_FILTERS) =>
      filterMetricTrendRows(rows, filters).map((r) => r.metric.code);
    expect(codes(NO_TREND_FILTERS)).toEqual(['female_managers', 'scope1', 'officers_total']);
    expect(codes({ ...NO_TREND_FILTERS, empty: true })).toHaveLength(4);
    expect(codes({ ...NO_TREND_FILTERS, group: 'social' })).toEqual(['female_managers']);
    expect(codes({ ...NO_TREND_FILTERS, change: 'compared' })).toEqual(['female_managers']);
    expect(codes({ ...NO_TREND_FILTERS, change: 'large' })).toEqual(['female_managers']);
    expect(codes({ ...NO_TREND_FILTERS, change: 'needs_check' })).toEqual(['officers_total']);
    // 指標名・コードの部分一致（大文字小文字を区別しない）
    expect(codes({ ...NO_TREND_FILTERS, q: 'SCOPE' })).toEqual(['scope1']);
    expect(codes({ ...NO_TREND_FILTERS, q: 'officers_total の名' })).toEqual(['officers_total']);
  });

  it('URL の値を絞込に写し、知らない値は無視する', () => {
    expect(
      parseTrendFilters({ group: 'social', change: 'large', q: ' 女性 ', empty: '1' }),
    ).toEqual({ group: 'social', change: 'large', q: '女性', empty: true });
    expect(parseTrendFilters({ group: 'all', change: 'best', empty: 'yes' })).toEqual(
      NO_TREND_FILTERS,
    );
    expect(parseTrendFilters({ group: ['ghg', 'social'] }).group).toBe('ghg');
  });

  it('要約は分母付きの件数だけ（データのある指標が分母。総合点を作らない）', () => {
    expect(summarizeTrends(rows)).toEqual({
      dataMetricCount: 3,
      comparedCount: 1,
      largeCount: 1,
      needsCheckCount: 1,
      latestIncompleteCount: 1,
      emptyCount: 1,
    });
  });

  it('窓が 3 年度に満たなければ年数と理由を示す', () => {
    expect(trendWindowNote(3)).toBeNull();
    expect(trendWindowNote(2)).toBe('比較できる年度は 2 年分（それ以前の報告期間なし）');
    expect(trendWindowNote(1)).toBe('比較できる年度は 1 年分（それ以前の報告期間なし）');
  });

  it('絞込を URL に戻す（既定値は書かない）と、読み直して同じ絞込になる', () => {
    expect(trendFilterQuery(NO_TREND_FILTERS)).toBe('');
    const filters = { group: 'social', change: 'large', q: '女性 管理職', empty: true } as const;
    const query = trendFilterQuery(filters);
    expect(query).toBe(
      'group=social&change=large&q=%E5%A5%B3%E6%80%A7+%E7%AE%A1%E7%90%86%E8%81%B7&empty=1',
    );
    expect(parseTrendFilters(Object.fromEntries(new URLSearchParams(query)))).toEqual(filters);
    expect(trendFilterQuery({ ...NO_TREND_FILTERS, change: 'needs_check' })).toBe(
      'change=needs_check',
    );
  });
});

describe('表示の補助', () => {
  it('値: 単位が % の指標は小数 2 桁まで（加重平均の端数を表示だけ丸める）、それ以外は桁区切り', () => {
    expect(formatTrendValue((16 / 114) * 100, '%')).toBe('14.04');
    expect(formatTrendValue(15, '%')).toBe('15');
    expect(formatTrendValue(18.25, '%')).toBe('18.25');
    expect(formatTrendValue(9735.4, 't-CO2e')).toBe('9,735.4');
    expect(formatTrendValue(0, 't')).toBe('0');
  });

  it('集計方法: 合計は連結値、分子・分母のある比率は加重平均、それ以外は全社値は算定不可', () => {
    expect(
      aggregationNoteOf({
        aggregationMethod: 'sum',
        numeratorMetricCode: null,
        denominatorMetricCode: null,
      }),
    ).toBe('合計: 承認済みの連結値（持分調整・内部取引の控除後。持分法の拠点は含めない）');
    expect(
      aggregationNoteOf({
        aggregationMethod: 'weighted_average',
        numeratorMetricCode: 'female_managers',
        denominatorMetricCode: 'managers_total',
      }),
    ).toBe(
      '比率: 分子（female_managers）・分母（managers_total）の承認済みの合計から計算（加重平均。拠点の比率の単純平均は使わない）',
    );
    expect(
      aggregationNoteOf({
        aggregationMethod: 'average',
        numeratorMetricCode: null,
        denominatorMetricCode: null,
      }),
    ).toBe('全社値は算定不可（集計方法: 平均。拠点の値は内訳に年度ごとに示す）');
    // 比率の集計方法でも分子・分母が無ければ算定しない（kpi.ts と同じ）
    expect(
      aggregationNoteOf({
        aggregationMethod: 'ratio',
        numeratorMetricCode: null,
        denominatorMetricCode: null,
      }),
    ).toBe('全社値は算定不可（集計方法: 比率計算。拠点の値は内訳に年度ごとに示す）');
  });
});
