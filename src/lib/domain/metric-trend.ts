import { AGGREGATION_METHOD_LABEL } from '@/lib/domain/metrics';
import { formatNumber } from '@/lib/format/datetime';
import type { AggregationMethod, MetricCategory, MetricDataType } from '@/types/domain';

/**
 * 自社経年比較（docs/disclosure-first.md §10.2）の純関数。
 *
 * 値の源は ESG経営と同じ年度ごとの集計状態（kpi.ts の loadMetricYearStates）で、ここはその状態を
 * 表のセル・前年比・絞込・要約に写すだけ。services を import しない（入力は構造型で受ける）ので、
 * 画面・サービス・テストが同じ規則を使える。`server-only` を付けない。
 *
 * 誠実さの規則:
 *  - 値の欄に出すのは「確定（対象の全拠点が承認済み）」の値だけ。未入力・集計中・推計・目標・途中合計は
 *    数値にせず状態の文字で示す（0 と書かない）
 *  - 前年比は隣り合う 2 年度がともに確定し、比較条件（対象拠点・境界・算定方法〔kpi.ts〕と
 *    内部取引の控除・単位・期間〔basisChangeReasons〕）が同じときだけ出す
 *  - 良し悪しは指標によって逆になるため、増減を色で示さない（矢印＋符号＋文字）
 *  - 単一の総合点を作らない（要約は分母付きの件数だけ）
 */

// ======================================================================
// 群（表の見出し行）
// ======================================================================

export const TREND_GROUPS = ['ghg', 'environment', 'social', 'governance'] as const;
export type TrendGroup = (typeof TREND_GROUPS)[number];

export const TREND_GROUP_LABEL: Record<TrendGroup, string> = {
  ghg: 'GHG',
  environment: '環境',
  social: '社会',
  governance: 'ガバナンス',
};

/** 指標の分類 → 表の群（気候関連の財務影響の指標は環境に入れる） */
export function trendGroupOf(category: MetricCategory): TrendGroup {
  switch (category) {
    case 'ghg':
      return 'ghg';
    case 'energy':
    case 'water':
    case 'waste':
    case 'climate_transition':
      return 'environment';
    case 'human_capital':
      return 'social';
    case 'governance':
      return 'governance';
  }
}

/** 経年比較に並べる指標のデータ型（文章・該否は数値の推移が無いので対象外） */
export const TREND_DATA_TYPES: readonly MetricDataType[] = ['number', 'integer', 'ratio'];

export function isTrendMetric(metric: { dataType: MetricDataType }): boolean {
  return TREND_DATA_TYPES.includes(metric.dataType);
}

// ======================================================================
// セルの状態
// ======================================================================

export const TREND_CELL_KINDS = [
  'confirmed',
  'incomplete',
  'estimate_included',
  'not_entered',
  'not_computable',
  'not_applicable',
  'no_actual',
  'unit_mismatch',
] as const;
export type TrendCellKind = (typeof TREND_CELL_KINDS)[number];

/** 拠点の行（kpi.ts の UnitContribution と同じ形の一部） */
export interface TrendContributionInput {
  unitName: string;
  status: string;
  boundary: string;
  /** 連結係数（持分法・対象外の拠点は 0。連結値に入らない） */
  factor: number;
  value: number | null;
  unitOfMeasure: string;
}

export interface TrendPeriodInput {
  code: string;
  startDate: string;
  endDate: string;
}

/** 年度ごとの集計状態（kpi.ts の MetricPeriodState と同じ形の一部） */
export interface TrendStateInput {
  metric: { unit: string };
  period: TrendPeriodInput;
  hasData: boolean;
  computable: boolean;
  approvedValue: number | null;
  complete: boolean;
  expectedUnitCount: number;
  approvedUnits: readonly string[];
  pendingUnits: readonly unknown[];
  missingUnits: readonly string[];
  notApplicableUnits: readonly string[];
  estimateUnits: readonly string[];
  targetOnlyUnits: readonly string[];
  contributions: readonly TrendContributionInput[];
}

export interface TrendCell {
  kind: TrendCellKind;
  /** 確定値。confirmed のときだけ数値で、それ以外は null（0 にしない） */
  value: number | null;
  /** 状態の文字（confirmed は読み上げ用の「確定」） */
  label: string;
  /** 承認済み（対象外と判断を含む）の拠点数 / 対象の拠点数（ESG経営の「集計中（承認済み n/N 拠点）」と同じ数え方） */
  approvedCount: number;
  expectedCount: number;
}

/** 内部取引（連結時に控除する明細行）の境界 */
export const INTERCOMPANY_BOUNDARY = '内部取引';

/** 連結値に入った承認済みの行のうち、単位が指標の単位と違うもの（桁違いの合計になりうる） */
function mismatchedUnitRows(state: TrendStateInput): TrendContributionInput[] {
  return state.contributions.filter(
    (c) =>
      c.status === 'approved' &&
      c.factor > 0 &&
      c.value !== null &&
      c.unitOfMeasure !== state.metric.unit,
  );
}

/**
 * 1 年度のセル。順に: 行なし → 未入力、合計できない集計方法 → 全社値は算定不可、
 * 承認済みの寄与行の単位違い → 単位の確認が必要（値を出さない）、確定 → 数値、
 * 全拠点が対象外と判断 → 対象外と判断、承認済みだが実績値なし → 承認済みの実績なし、
 * 推計の拠点だけが残る → 推計を含む、それ以外 → 集計中
 */
export function trendCellOf(state: TrendStateInput): TrendCell {
  const approvedCount = state.approvedUnits.length + state.notApplicableUnits.length;
  const expectedCount = state.expectedUnitCount;
  const cell = (kind: TrendCellKind, label: string, value: number | null = null): TrendCell => ({
    kind,
    value,
    label,
    approvedCount,
    expectedCount,
  });

  if (!state.hasData) return cell('not_entered', '未入力');
  if (!state.computable) return cell('not_computable', '全社値は算定不可');
  if (mismatchedUnitRows(state).length > 0) return cell('unit_mismatch', '単位の確認が必要');
  if (state.complete) {
    if (state.approvedValue !== null) return cell('confirmed', '確定', state.approvedValue);
    if (expectedCount > 0 && state.notApplicableUnits.length === expectedCount) {
      return cell('not_applicable', '対象外と判断');
    }
    return cell('no_actual', '承認済みの実績なし');
  }
  const nothingPending = state.pendingUnits.length === 0 && state.missingUnits.length === 0;
  if (nothingPending && state.estimateUnits.length > 0 && state.targetOnlyUnits.length === 0) {
    return cell('estimate_included', `推計を含む（実績 ${approvedCount}/${expectedCount} 拠点）`);
  }
  if (
    nothingPending &&
    state.estimateUnits.length === 0 &&
    state.targetOnlyUnits.length > 0 &&
    state.approvedUnits.length === 0
  ) {
    return cell('no_actual', '承認済みの実績なし');
  }
  return cell('incomplete', `集計中（承認済み ${approvedCount}/${expectedCount} 拠点）`);
}

// ======================================================================
// 比較の前提の違い（経年比較だけで使う）
// ======================================================================

export const BASIS_CHANGE_KINDS = [
  'intercompany',
  'unit',
  'period_length',
  'fiscal_end',
  'period_gap',
] as const;
export type BasisChangeKind = (typeof BASIS_CHANGE_KINDS)[number];

export interface BasisChangeReason {
  kind: BasisChangeKind;
  text: string;
}

function hasApprovedIntercompany(state: TrendStateInput): boolean {
  return state.contributions.some(
    (c) =>
      c.status === 'approved' &&
      c.boundary === INTERCOMPANY_BOUNDARY &&
      c.factor > 0 &&
      c.value !== null,
  );
}

function ymdOf(date: string): { y: number; m: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]) };
}

/** 報告期間の月数（開始月から終了月まで。2024-04-01〜2025-03-31 は 12） */
export function periodMonthsOf(period: TrendPeriodInput): number | null {
  const start = ymdOf(period.startDate);
  const end = ymdOf(period.endDate);
  if (!start || !end) return null;
  return (end.y - start.y) * 12 + (end.m - start.m) + 1;
}

/** 決算月（終了日の月） */
export function fiscalEndMonthOf(period: TrendPeriodInput): number | null {
  return ymdOf(period.endDate)?.m ?? null;
}

/** 前の期間の終了日の翌日が次の期間の開始日か（間に空きがあれば「前年比」にしない） */
function isContiguous(previous: TrendPeriodInput, current: TrendPeriodInput): boolean {
  const end = Date.parse(`${previous.endDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(end)) return false;
  return new Date(end + 86_400_000).toISOString().slice(0, 10) === current.startDate.slice(0, 10);
}

/**
 * 隣り合う 2 年度を同じ前提で比べられない理由（空なら同じ前提）。kpi.ts の比較条件（対象拠点・境界・
 * 算定方法）に加えて、経年比較で確かめるもの:
 *  (a) 承認済みの内部取引の行（控除）が片方の年度だけにある。控除の有無が違うと増減の向きまで変わる
 *      （例: Scope3 Cat.1 の FY2025 → FY2026 は素の比較で −0.2%、控除をそろえると約 +5%）
 *  (b) 連結値に入った承認済みの行の単位が指標の単位と違う
 *  (c) 報告期間の月数・決算月が違う、または期間が連続していない
 */
export function basisChangeReasons(
  previous: TrendStateInput,
  current: TrendStateInput,
): BasisChangeReason[] {
  const reasons: BasisChangeReason[] = [];
  const prevCode = previous.period.code;
  const curCode = current.period.code;

  const icPrevious = hasApprovedIntercompany(previous);
  const icCurrent = hasApprovedIntercompany(current);
  if (icPrevious !== icCurrent) {
    const withDeduction = icCurrent ? curCode : prevCode;
    const without = icCurrent ? prevCode : curCode;
    reasons.push({
      kind: 'intercompany',
      text: `内部取引の控除が ${withDeduction} だけにあります（${without} は控除なし）。控除の有無をそろえないと、増減の大きさや向きが変わることがあります。`,
    });
  }

  for (const state of [previous, current]) {
    for (const row of mismatchedUnitRows(state)) {
      reasons.push({
        kind: 'unit',
        text: `${state.period.code} ${row.unitName}: 単位「${row.unitOfMeasure}」が指標の単位「${state.metric.unit}」と異なります。`,
      });
    }
  }

  const monthsPrevious = periodMonthsOf(previous.period);
  const monthsCurrent = periodMonthsOf(current.period);
  if (monthsPrevious !== monthsCurrent) {
    reasons.push({
      kind: 'period_length',
      text: `報告期間の長さが異なります（${prevCode} ${monthsPrevious ?? '—'} か月／${curCode} ${monthsCurrent ?? '—'} か月）。`,
    });
  }
  const endPrevious = fiscalEndMonthOf(previous.period);
  const endCurrent = fiscalEndMonthOf(current.period);
  if (endPrevious !== endCurrent) {
    reasons.push({
      kind: 'fiscal_end',
      text: `決算月が異なります（${prevCode} ${endPrevious ?? '—'} 月／${curCode} ${endCurrent ?? '—'} 月）。`,
    });
  }
  if (!isContiguous(previous.period, current.period)) {
    reasons.push({
      kind: 'period_gap',
      text: `報告期間が連続していません（${prevCode} と ${curCode} の間に期間の空きがあります）。`,
    });
  }
  return reasons;
}

// ======================================================================
// 前年比の表示
// ======================================================================

/** 隣り合う年度の比較（kpi.ts の YoyResult と同じ形の一部） */
export type TrendYoyInput =
  | {
      status: 'ok';
      previousValue: number;
      diff: number;
      diffRate: number | null;
      notes: readonly string[];
    }
  | { status: 'needs_check'; reasons: readonly string[]; notes: readonly string[] }
  | { status: 'unavailable'; reason: string };

export type ChangeDirection = 'up' | 'down' | 'flat';

export type TrendChangeView =
  | {
      kind: 'value';
      direction: ChangeDirection;
      /** 符号付きの文字（「−8.3%（−803.8 t-CO2e）」「+3.25 pt」） */
      text: string;
      /** 大きな変化（|差| / |前年| が指標の前年比の許容幅を超える） */
      large: boolean;
      /** 前年の値の遡及修正（比べられるが、確かめられるよう内訳に出す） */
      notes: string[];
    }
  | { kind: 'needs_check'; reasons: string[] }
  | { kind: 'unavailable'; reason: string };

const MINUS = '−';

function signOf(value: number): string {
  if (value > 0) return '+';
  if (value < 0) return MINUS;
  return '±';
}

/** 浮動小数の誤差（803.8000000000002 等）を表示の前に落とす */
function clean(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * 前年比の文字。単位が % の指標は差を % ポイントで示し、相対 % を出さない（比率の比率は誤読される）。
 * それ以外は「±x.x%（±差 単位）」、前年が 0 なら差だけ（割らない）
 */
export function formatTrendChange(input: {
  diff: number;
  diffRate: number | null;
  previousValue: number;
  unit: string;
}): string {
  const diff = clean(input.diff);
  const sign = signOf(diff);
  if (input.unit === '%') return `${sign}${Math.abs(diff).toFixed(2)} pt`;
  const amount = `${sign}${formatNumber(Math.abs(diff))} ${input.unit}`.trim();
  if (input.previousValue === 0 || input.diffRate === null) return amount;
  return `${sign}${Math.abs(clean(input.diffRate)).toFixed(1)}%（${amount}）`;
}

/**
 * 大きな変化か。検証規則（data-point-rules.ts の前年差）と同じく |差| / |前年| > 許容幅。
 * 許容幅の無い指標・前年 0 は常に false（決めていない閾値を作らない）
 */
export function isLargeChange(
  previousValue: number,
  diff: number,
  yoyWarningRatio: number | null,
): boolean {
  if (yoyWarningRatio === null || previousValue === 0) return false;
  return Math.abs(diff) / Math.abs(previousValue) > yoyWarningRatio;
}

/**
 * 前年比のセル。数値を出すのは kpi.ts の比較が ok で、かつ basisChangeReasons が空のときだけ。
 * 前提の違いがあれば「比較条件の確認が必要」（理由は内訳）、どちらかが未確定なら出さない（理由つき）
 */
export function changeViewOf(
  change: TrendYoyInput,
  basis: readonly BasisChangeReason[],
  metric: { unit: string; yoyWarningRatio: number | null },
): TrendChangeView {
  if (change.status === 'unavailable') return { kind: 'unavailable', reason: change.reason };
  if (change.status === 'needs_check') {
    return {
      kind: 'needs_check',
      reasons: [...new Set([...change.reasons, ...basis.map((b) => b.text)])],
    };
  }
  if (basis.length > 0) return { kind: 'needs_check', reasons: basis.map((b) => b.text) };
  const diff = clean(change.diff);
  return {
    kind: 'value',
    direction: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat',
    text: formatTrendChange({
      diff: change.diff,
      diffRate: change.diffRate,
      previousValue: change.previousValue,
      unit: metric.unit,
    }),
    large: isLargeChange(change.previousValue, change.diff, metric.yoyWarningRatio),
    notes: [...change.notes],
  };
}

// ======================================================================
// 行
// ======================================================================

export interface TrendMetricInput {
  code: string;
  name: string;
  unit: string;
  category: MetricCategory;
  yoyWarningRatio: number | null;
}

export interface TrendRowInput<M extends TrendMetricInput> {
  metric: M;
  /** 古い年度 → 新しい年度 */
  years: ReadonlyArray<{ state: TrendStateInput }>;
  /** changes[i] は years[i] → years[i+1] */
  changes: readonly TrendYoyInput[];
}

export interface MetricTrendRowView<M extends TrendMetricInput> {
  metric: M;
  group: TrendGroup;
  /** years と同じ順 */
  cells: TrendCell[];
  /** changes[i] は cells[i] → cells[i+1] */
  changes: TrendChangeView[];
  /** 前提の違い（changes と同じ順。前年比を出さなかった年度の理由も内訳に出す） */
  basisReasons: BasisChangeReason[][];
  /** どれかの年度に行がある（無い指標は既定で隠す。0 ではない） */
  hasAnyData: boolean;
}

export function buildTrendRow<M extends TrendMetricInput>(
  input: TrendRowInput<M>,
): MetricTrendRowView<M> {
  const cells = input.years.map((y) => trendCellOf(y.state));
  const basisReasons: BasisChangeReason[][] = [];
  const changes: TrendChangeView[] = [];
  for (let i = 1; i < input.years.length; i += 1) {
    const previous = input.years[i - 1]!.state;
    const current = input.years[i]!.state;
    const basis = basisChangeReasons(previous, current);
    basisReasons.push(basis);
    const change = input.changes[i - 1] ?? {
      status: 'unavailable' as const,
      reason: '比較の結果がありません。',
    };
    changes.push(changeViewOf(change, basis, input.metric));
  }
  return {
    metric: input.metric,
    group: trendGroupOf(input.metric.category),
    cells,
    changes,
    basisReasons,
    hasAnyData: input.years.some((y) => y.state.hasData),
  };
}

/** 群の順（GHG → 環境 → 社会 → ガバナンス）に並べる。群の中は渡した順のまま */
export function sortTrendRows<T extends { group: TrendGroup }>(rows: readonly T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        TREND_GROUPS.indexOf(a.row.group) - TREND_GROUPS.indexOf(b.row.group) || a.index - b.index,
    )
    .map((entry) => entry.row);
}

// ======================================================================
// 絞込（URL: group・change・q・empty）
// ======================================================================

export const TREND_CHANGE_FILTERS = ['compared', 'large', 'needs_check'] as const;
export type TrendChangeFilter = (typeof TREND_CHANGE_FILTERS)[number];

export const TREND_CHANGE_FILTER_LABEL: Record<TrendChangeFilter, string> = {
  compared: '前年比を出せた',
  large: '大きな変化',
  needs_check: '比較条件の確認が必要',
};

export interface TrendFilters {
  group: TrendGroup | null;
  change: TrendChangeFilter | null;
  q: string;
  /** データが 1 年もない指標も出す（既定は隠す） */
  empty: boolean;
}

export const NO_TREND_FILTERS: TrendFilters = { group: null, change: null, q: '', empty: false };

function firstOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** URL の値を絞込に写す。知らない値は無視する（例外にしない） */
export function parseTrendFilters(
  params: Readonly<Record<string, string | string[] | undefined>>,
): TrendFilters {
  const group = firstOf(params.group);
  const change = firstOf(params.change);
  return {
    group: (TREND_GROUPS as readonly string[]).includes(group ?? '') ? (group as TrendGroup) : null,
    change: (TREND_CHANGE_FILTERS as readonly string[]).includes(change ?? '')
      ? (change as TrendChangeFilter)
      : null,
    q: (firstOf(params.q) ?? '').trim(),
    empty: firstOf(params.empty) === '1',
  };
}

export interface TrendRowForFilter {
  metric: { code: string; name: string };
  group: TrendGroup;
  hasAnyData: boolean;
  changes: readonly TrendChangeView[];
}

function matchesChange(row: TrendRowForFilter, change: TrendChangeFilter): boolean {
  switch (change) {
    case 'compared':
      return row.changes.some((c) => c.kind === 'value');
    case 'large':
      return row.changes.some((c) => c.kind === 'value' && c.large);
    case 'needs_check':
      return row.changes.some((c) => c.kind === 'needs_check');
  }
}

/**
 * 絞込を URL のクエリ（先頭の ? なし）に戻す。既定値は書かない（共有する URL を短く保つ）。
 * 要約のチップ・「表示／隠す」のリンクが、ほかの絞込を保ったまま 1 つだけ変えるのに使う
 */
export function trendFilterQuery(filters: TrendFilters): string {
  const params = new URLSearchParams();
  if (filters.group) params.set('group', filters.group);
  if (filters.change) params.set('change', filters.change);
  if (filters.q) params.set('q', filters.q);
  if (filters.empty) params.set('empty', '1');
  return params.toString();
}

export function filterMetricTrendRows<T extends TrendRowForFilter>(
  rows: readonly T[],
  filters: TrendFilters,
): T[] {
  const q = filters.q.toLowerCase();
  return rows.filter((row) => {
    if (!filters.empty && !row.hasAnyData) return false;
    if (filters.group && row.group !== filters.group) return false;
    if (filters.change && !matchesChange(row, filters.change)) return false;
    if (
      q &&
      !row.metric.name.toLowerCase().includes(q) &&
      !row.metric.code.toLowerCase().includes(q)
    ) {
      return false;
    }
    return true;
  });
}

/**
 * 表が空のときの理由（空の状態の文言を決める）。
 *  - no_metrics: 数値の指標が 1 つも無い
 *  - no_data: どの指標にも窓の年度のデータが無い（既定でデータの無い指標を隠しているだけで、
 *    絞り込みの問題ではない。「絞り込み解除」を案内しない）
 *  - filtered: 区分・前年比・検索の絞込で 0 件になった
 */
export type TrendEmptyReason = 'no_metrics' | 'no_data' | 'filtered';

export function trendEmptyReason(
  filters: TrendFilters,
  counts: { rowCount: number; dataMetricCount: number },
): TrendEmptyReason {
  if (counts.rowCount === 0) return 'no_metrics';
  if (counts.dataMetricCount === 0 && !filters.empty) return 'no_data';
  return 'filtered';
}

// ======================================================================
// 要約（分母付きの件数。総合点は作らない）
// ======================================================================

export interface TrendSummary {
  /** データのある指標（どれかの年度に行がある数値指標）＝ 比較できた指標の分母 */
  dataMetricCount: number;
  /** 隣り合う年度のどこかで前年比を数値で出せた指標 */
  comparedCount: number;
  /** 大きな変化のある指標 */
  largeCount: number;
  /** 比較条件の確認が必要な指標 */
  needsCheckCount: number;
  /** 最新年度（窓の終点）が集計中の指標 */
  latestIncompleteCount: number;
  /** データが 1 年もない指標（既定で隠す。0 ではない） */
  emptyCount: number;
}

export function summarizeTrends(
  rows: ReadonlyArray<TrendRowForFilter & { cells: readonly TrendCell[] }>,
): TrendSummary {
  const withData = rows.filter((r) => r.hasAnyData);
  return {
    dataMetricCount: withData.length,
    comparedCount: withData.filter((r) => matchesChange(r, 'compared')).length,
    largeCount: withData.filter((r) => matchesChange(r, 'large')).length,
    needsCheckCount: withData.filter((r) => matchesChange(r, 'needs_check')).length,
    latestIncompleteCount: withData.filter(
      (r) => r.cells[r.cells.length - 1]?.kind === 'incomplete',
    ).length,
    emptyCount: rows.length - withData.length,
  };
}

// ======================================================================
// 表示の補助
// ======================================================================

/**
 * 確定値の表示。単位が % の指標は小数 2 桁まで（分子・分母の加重平均は 14.035… のような端数になる。
 * 丸めは表示だけで、前年比の計算は丸める前の値）。それ以外は桁区切り（小数は 3 桁まで）
 */
export function formatTrendValue(value: number, unit: string): string {
  return formatNumber(unit === '%' ? Math.round(value * 100) / 100 : value);
}

/**
 * 全社値の決め方（内訳の「定義と集計方法」）。kpi.ts の metricPeriodState と同じ分け方:
 * 合計 → 連結値、分子・分母のある指標 → 加重平均、それ以外 → 全社値は算定不可
 */
export function aggregationNoteOf(metric: {
  aggregationMethod: AggregationMethod;
  numeratorMetricCode: string | null;
  denominatorMetricCode: string | null;
}): string {
  if (metric.aggregationMethod === 'sum') {
    return '合計: 承認済みの連結値（持分調整・内部取引の控除後。持分法の拠点は含めない）';
  }
  if (metric.numeratorMetricCode && metric.denominatorMetricCode) {
    return `比率: 分子（${metric.numeratorMetricCode}）・分母（${metric.denominatorMetricCode}）の承認済みの合計から計算（加重平均。拠点の比率の単純平均は使わない）`;
  }
  return `全社値は算定不可（集計方法: ${AGGREGATION_METHOD_LABEL[metric.aggregationMethod]}。拠点の値は内訳に年度ごとに示す）`;
}

/** 窓が 3 年度に満たないときの注記（満ちていれば null） */
export const TREND_WINDOW_YEARS = 3;

export function trendWindowNote(yearCount: number): string | null {
  if (yearCount >= TREND_WINDOW_YEARS) return null;
  return `比較できる年度は ${yearCount} 年分（それ以前の報告期間なし）`;
}
