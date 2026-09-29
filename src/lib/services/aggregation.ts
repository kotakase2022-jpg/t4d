import 'server-only';

import { INTERCOMPANY_BOUNDARY, isCountedInTotals } from '@/lib/domain/boundaries';

import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  DataPoint,
  MetricDefinition,
  OrganizationUnit,
  ReportingPeriod,
  Uuid,
} from '@/types/domain';

/**
 * 連結集計（DATA-P0-006）。
 *
 * 合計・加重平均・比率（分子/分母）・連結係数（持分）・内部取引控除・除外・推計を
 * 1 か所で計算する。すべて**承認済みデータのみ**を根拠にする。
 *
 * - 「内部取引」boundary の行はグループ内取引由来の二重計上分の**明細**。
 *   通常の合計からは除外し（`isCountedInTotals`）、連結集計で控除額として表示する。
 * - 推計は「当年に承認済みデータが無い拠点を前年の承認済み値で補完」する。
 *   推計値は必ずラベル付きで別掲し、確定値と混ぜない。
 */

// 判定そのものは Fixture 生成（Node CLI）からも使うため server-only でない
// src/lib/domain/boundaries.ts に置き、ここでは再エクスポートする。
export { INTERCOMPANY_BOUNDARY, isCountedInTotals };

const round2 = (n: number) => Math.round(n * 100) / 100;

// ----------------------------------------------------------------------
// 値の有無（0039）を踏まえた足し算（W0 O4 / 指示書 §7.1）
//
// 以前は `dp.value ?? 0` で足していたため、未入力・対象外の行が 0 として合計に入り、
// 行が 1 件も無い指標まで「0」と表示されていた。実績ゼロと未入力を区別するため、
//  - 値あり（value_present）かつ数値を持つ行だけを足す
//  - 足した行が 1 件も無ければ合計は null（画面は「未入力」等を出す）
//  - 目標値（value_kind = target）は実績の合計に入れない。推計は別に数える
// ----------------------------------------------------------------------

type ValueRow = Pick<DataPoint, 'value' | 'availabilityStatus' | 'valueKind'>;

/**
 * 行の区分。0039 より前に Demo の Cookie へ残った行は区分・状態を持たないため、
 * 0039 の backfill と同じ既定（実績・値あり）として読む
 */
const kindOf = (dp: ValueRow) => dp.valueKind ?? 'actual';

/** 実績（value_kind = actual）として集計に使える値を持つ行か（推計・目標は実績に数えない） */
export function isActualValue(dp: ValueRow): dp is ValueRow & { value: number } {
  return hasUsableValue(dp) && kindOf(dp) === 'actual';
}

/** 行の区分（0039 より前の行は実績として読む） */
export function valueKindOf(dp: ValueRow): NonNullable<ValueRow['valueKind']> {
  return kindOf(dp);
}

/** 集計に使える値を持つ行か（値あり・数値あり・目標値ではない） */
export function hasUsableValue(dp: ValueRow): dp is ValueRow & { value: number } {
  return (
    dp.value !== null &&
    Number.isFinite(dp.value) &&
    (dp.availabilityStatus ?? 'value_present') === 'value_present' &&
    kindOf(dp) !== 'target'
  );
}

export interface ValueSum {
  /** 値を足した結果（丸めない）。足せる行が 1 件も無ければ null（0 と区別する） */
  total: number | null;
  /** 足した行の数 */
  valueCount: number;
}

/**
 * 値あり（実績・推計）の行だけを足す。`kind` で実績だけ／推計だけに絞れる。
 * `weight` は行ごとの係数（連結係数など）。丸めは呼び出し側で行う
 * （途中で丸めると、差し引きの結果が従来の値と 0.01 ずれる）。
 */
export function sumValues<R extends ValueRow>(
  rows: R[],
  kind: 'actual' | 'estimate' | 'any' = 'any',
  weight: (row: R) => number = () => 1,
): ValueSum {
  let total = 0;
  let valueCount = 0;
  for (const row of rows) {
    if (!hasUsableValue(row)) continue;
    if (kind !== 'any' && kindOf(row) !== kind) continue;
    total += row.value * weight(row);
    valueCount += 1;
  }
  return { total: valueCount === 0 ? null : total, valueCount };
}

export interface MetricTotals {
  /** Data Point の行数（値の有無を問わない） */
  count: number;
  /** 合計（内部取引の明細行を除く・実績のみ）。値が無ければ null */
  total: number | null;
  valueCount: number;
  approvedCount: number;
  /** 承認済みの合計（同上）。値が無ければ null */
  approvedTotal: number | null;
  /** 推計値の合計（実績と混ぜない）。推計が無ければ null */
  estimateTotal: number | null;
  /** 値の無い行の状態別件数（未入力・未取得・対象外・未算定） */
  absentByStatus: Partial<Record<DataPoint['availabilityStatus'], number>>;
}

/** GHG 画面「Scope 別集計」の 1 行。未登録を 0 と表示しないための集計 */
export function summarizeMetricTotals(rows: DataPoint[]): MetricTotals {
  const counted = rows.filter(isCountedInTotals);
  const approved = rows.filter((dp) => dp.status === 'approved');
  const absentByStatus: MetricTotals['absentByStatus'] = {};
  for (const row of rows) {
    // 値を持つ行（目標値を含む）は「値が無い」に数えない
    const availability = row.availabilityStatus ?? 'value_present';
    if (availability === 'value_present' && row.value !== null) continue;
    const status = availability === 'value_present' ? 'not_entered' : availability;
    absentByStatus[status] = (absentByStatus[status] ?? 0) + 1;
  }
  const actual = sumValues(counted, 'actual');
  return {
    count: rows.length,
    total: actual.total,
    valueCount: actual.valueCount,
    approvedCount: approved.length,
    approvedTotal: sumValues(approved.filter(isCountedInTotals), 'actual').total,
    estimateTotal: sumValues(counted, 'estimate').total,
    absentByStatus,
  };
}

// ----------------------------------------------------------------------
// Scope3 のカテゴリー別の状況と合計の照合（指示書 §7.2 / A09・A10）
// ----------------------------------------------------------------------

export const SCOPE3_TOTAL_CODE = 'scope3_total';
export const SCOPE3_CATEGORY_CODES = Array.from(
  { length: 15 },
  (_, i) => `scope3_cat${i + 1}`,
) as readonly string[];

/** カテゴリーの状態。Data Point が 1 件も無ければ not_entered（未入力） */
export type Scope3CategoryState = DataPoint['availabilityStatus'];

export interface Scope3CategoryStatus {
  category: number;
  code: string;
  metric: MetricDefinition | null;
  state: Scope3CategoryState;
  /** 値あり行の合計（実績）。値が無ければ null */
  total: number | null;
  /** 推計値の合計（実績と混ぜない）。無ければ null */
  estimateTotal: number | null;
  /** Data Point の行数（値の有無を問わない） */
  count: number;
  /** 値が無い理由（未取得・対象外・未算定で人が書いたもの） */
  reasons: string[];
}

export interface Scope3Status {
  categories: Scope3CategoryStatus[];
  /** 値のあるカテゴリーの数 */
  presentCount: number;
  /** 対象外と判断したカテゴリーの数 */
  notApplicableCount: number;
  /** 値も対象外判断も無いカテゴリーの数（未入力・未取得・未算定） */
  pendingCount: number;
  /** Scope3 合計（scope3_total）の行。未登録なら value は null */
  total: { metric: MetricDefinition | null; value: number | null; count: number };
  /**
   * 合計とカテゴリーの照合。合計とカテゴリーの両方に値があるときだけ出す。
   * **足し合わせない**（合計はカテゴリーの和を置き換えるものではなく、照合の相手）
   */
  reconciliation: {
    categorySum: number;
    difference: number;
    /** 許容する丸め差（t-CO2e）。各値の表示桁（0.1）の半分 × 値の数 */
    tolerance: number;
    withinTolerance: boolean;
  } | null;
  /**
   * 全体の状態。
   *  - complete: 全 15 カテゴリーに値か対象外判断がある
   *  - incomplete: 一部だけ（Cat.1 だけ等）。Scope3 全体の完成として扱わない
   *  - none: 何も無い
   */
  completeness: 'complete' | 'incomplete' | 'none';
}

/** 表示値の桁（0.1 t）の半分。丸めた値を n 個足すと最大 n × これだけずれる */
const SCOPE3_ROUNDING_HALF_UNIT = 0.05;

function dominantAbsentState(rows: DataPoint[]): Scope3CategoryState {
  // 値の無い行の状態。人が判断した状態（対象外・未算定・未取得）を未入力より優先して見せる
  const order: Scope3CategoryState[] = [
    'not_applicable',
    'not_calculated',
    'not_obtained',
    'not_entered',
  ];
  for (const state of order) {
    if (rows.some((dp) => dp.availabilityStatus === state)) return state;
  }
  return 'not_entered';
}

/**
 * Scope3 のカテゴリー 1〜15 の状況と、合計（scope3_total）との照合。
 * Cat.1 だけが登録された状態を Scope3 全体として見せないための集計（A09）。
 * 合計とカテゴリーが両方あるときは差を示すだけで、両者を足さない（A10）。
 */
export function summarizeScope3(
  metrics: MetricDefinition[],
  dataPoints: DataPoint[],
): Scope3Status {
  const metricByCode = new Map(metrics.map((m) => [m.code, m]));
  const rowsOf = (metric: MetricDefinition | null) =>
    metric ? dataPoints.filter((dp) => dp.metricId === metric.id && isCountedInTotals(dp)) : [];

  const categories: Scope3CategoryStatus[] = SCOPE3_CATEGORY_CODES.map((code, index) => {
    const metric = metricByCode.get(code) ?? null;
    const rows = rowsOf(metric);
    const actual = sumValues(rows, 'actual');
    const estimate = sumValues(rows, 'estimate');
    const hasValue = actual.valueCount > 0 || estimate.valueCount > 0;
    return {
      category: index + 1,
      code,
      metric,
      state: hasValue ? 'value_present' : dominantAbsentState(rows),
      total: actual.total === null ? null : round2(actual.total),
      estimateTotal: estimate.total === null ? null : round2(estimate.total),
      count: rows.length,
      reasons: rows.map((dp) => dp.absenceReason?.trim() ?? '').filter((reason) => reason !== ''),
    };
  });

  const totalMetric = metricByCode.get(SCOPE3_TOTAL_CODE) ?? null;
  const totalRows = rowsOf(totalMetric);
  const totalSum = sumValues(totalRows, 'actual');
  const totalValue = totalSum.total === null ? null : round2(totalSum.total);

  const withValues = categories.filter((c) => c.total !== null);
  const presentCount = categories.filter((c) => c.state === 'value_present').length;
  const notApplicableCount = categories.filter((c) => c.state === 'not_applicable').length;
  const pendingCount = categories.length - presentCount - notApplicableCount;

  let reconciliation: Scope3Status['reconciliation'] = null;
  if (totalValue !== null && withValues.length > 0) {
    const categorySum = round2(withValues.reduce((sum, c) => sum + (c.total ?? 0), 0));
    const difference = round2(totalValue - categorySum);
    const tolerance = round2(SCOPE3_ROUNDING_HALF_UNIT * (withValues.length + 1));
    reconciliation = {
      categorySum,
      difference,
      tolerance,
      withinTolerance: Math.abs(difference) <= tolerance,
    };
  }

  return {
    categories,
    presentCount,
    notApplicableCount,
    pendingCount,
    total: { metric: totalMetric, value: totalValue, count: totalRows.length },
    reconciliation,
    completeness:
      pendingCount === 0
        ? 'complete'
        : presentCount + notApplicableCount === 0 && totalValue === null
          ? 'none'
          : 'incomplete',
  };
}

/**
 * 要求事項に対応付いた指標のデータの揃い具合（W0 O7）。
 * 1 つの指標に値があるだけで、複数の指標を求める要求事項全体を「データあり」としない。
 *  - full: 対応付いた指標すべてに値がある
 *  - partial: 一部の指標にだけ値がある（missing が不足分）
 *  - none: どの指標にも値が無い
 *  - not_mapped: 指標が対応付いていない（記述式）
 */
export type DataCoverage = 'full' | 'partial' | 'none' | 'not_mapped';

export function evaluateDataCoverage<M extends { id: Uuid }>(
  mappedMetrics: M[],
  metricIdsWithValue: ReadonlySet<Uuid>,
): { coverage: DataCoverage; missing: M[] } {
  if (mappedMetrics.length === 0) return { coverage: 'not_mapped', missing: [] };
  const missing = mappedMetrics.filter((m) => !metricIdsWithValue.has(m.id));
  if (missing.length === 0) return { coverage: 'full', missing };
  return { coverage: missing.length === mappedMetrics.length ? 'none' : 'partial', missing };
}

/** 連結方法・持分から集計係数を返す。equity / excluded は連結値に足さない（別掲）。 */
export function consolidationFactor(
  unit: Pick<OrganizationUnit, 'consolidationMethod' | 'ownershipPercent'>,
): number {
  switch (unit.consolidationMethod) {
    case 'full':
      return 1;
    case 'proportionate':
      return unit.ownershipPercent / 100;
    case 'equity':
    case 'excluded':
      return 0;
  }
}

export interface EstimatedEntry {
  unitId: Uuid;
  unitName: string;
  value: number;
  basis: string;
  /**
   * 推計の出所。current_estimate … 当年に推計値（value_kind = estimate）として承認された値／
   * prior_year … 当年のデータが無い拠点を前年の承認済み実績で補完した値。画面の説明を出所ごとに変える
   */
  source: 'current_estimate' | 'prior_year';
}

export interface ExcludedUnitEntry {
  unitName: string;
  method: 'equity' | 'excluded';
  ownershipPercent: number;
  reason: string | null;
}

export interface MetricAggregate {
  metric: MetricDefinition;
  /**
   * 合計に使った当年の実績値の行数。0 なら各合計は「値なし」であり、
   * 画面は 0 ではなく「未入力」と表示する（W0 O4）
   */
  valueCount: number;
  /** 全拠点の単純合計（係数・控除前） */
  simpleSum: number;
  /** 連結係数（持分）適用後 */
  ownershipAdjusted: number;
  /** 内部取引の控除額（ルールで有効な指標のみ > 0） */
  intercompanyEliminated: number;
  /** 連結値 = 係数適用後 − 内部取引控除 */
  consolidated: number;
  /** 推計による補完（当年データが無い拠点を前年値で補完） */
  estimates: EstimatedEntry[];
  /** 推計込み連結値 */
  consolidatedWithEstimates: number;
  /** 比率指標のみ: 分子合計 ÷ 分母合計（加重平均） */
  weightedAverage: number | null;
  /** 比率指標のみ: 拠点値の単純平均（加重平均との比較用） */
  simpleAverage: number | null;
  excludedUnits: ExcludedUnitEntry[];
}

export interface ConsolidatedAggregation {
  period: ReportingPeriod;
  previousPeriod: ReportingPeriod | null;
  metrics: MetricAggregate[];
}

export async function computeConsolidatedAggregation(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  periods: ReportingPeriod[],
  metricCodes: string[],
): Promise<ConsolidatedAggregation> {
  const organizationId = ctx.workspace.organizationId;
  const previous =
    periods
      .filter((p) => p.organizationId === organizationId && p.endDate < period.startDate)
      .sort((a, b) => (a.endDate < b.endDate ? 1 : -1))[0] ?? null;

  const [metrics, units, rules, current, prev] = await Promise.all([
    db.select('metrics', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('units', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('aggregationRules', { where: { organizationId } }),
    db.select('dataPoints', {
      where: {
        organizationId,
        reportingPeriodId: period.id,
        status: 'approved',
        deletedAt: { isNull: true },
      },
    }),
    previous
      ? db.select('dataPoints', {
          where: {
            organizationId,
            reportingPeriodId: previous.id,
            status: 'approved',
            deletedAt: { isNull: true },
          },
        })
      : Promise.resolve([]),
  ]);

  const unitById = new Map(units.map((u) => [u.id, u]));
  const metricByCode = new Map(metrics.map((m) => [m.code, m]));
  const ruleByMetricId = new Map(rules.map((r) => [r.metricId, r]));

  const factorOf = (dp: DataPoint) => {
    const unit = unitById.get(dp.unitId);
    return unit ? consolidationFactor(unit) : 1;
  };
  /** 指標の実績値の合計（内部取引の明細行を除く）。値が無ければ null */
  const actualSumFor = (rows: DataPoint[], metricId: Uuid) =>
    sumValues(
      rows.filter((dp) => dp.metricId === metricId && isCountedInTotals(dp)),
      'actual',
    ).total;

  const results: MetricAggregate[] = [];
  for (const code of metricCodes) {
    const metric = metricByCode.get(code);
    if (!metric) continue;
    const rule = ruleByMetricId.get(metric.id);

    // 未入力・対象外などの行は足さない（`?? 0` で 0 として足していた。W0 O4）
    const rows = current.filter((dp) => dp.metricId === metric.id && isCountedInTotals(dp));
    const actual = sumValues(rows, 'actual');
    const simpleSum = actual.total ?? 0;
    const ownershipAdjusted = sumValues(rows, 'actual', factorOf).total ?? 0;

    // 内部取引控除（ルールで有効な指標のみ）。明細行にも連結係数を掛ける
    const intercompanyEliminated = rule?.eliminateIntercompany
      ? (sumValues(
          current.filter((dp) => dp.metricId === metric.id && !isCountedInTotals(dp)),
          'actual',
          factorOf,
        ).total ?? 0)
      : 0;

    const consolidated = ownershipAdjusted - intercompanyEliminated;

    // 推計は実績と混ぜず、推計込みの値にだけ足す（ラベル「推計」で別掲する）
    const estimates: EstimatedEntry[] = [];
    // 当年に推計値（value_kind = estimate）として承認された行
    for (const dp of rows) {
      if (!hasUsableValue(dp) || kindOf(dp) !== 'estimate') continue;
      estimates.push({
        unitId: dp.unitId,
        unitName: unitById.get(dp.unitId)?.name ?? '—',
        value: round2(dp.value * factorOf(dp)),
        basis: '当年の推計値（承認済み）',
        source: 'current_estimate',
      });
    }

    // 当年に承認済みデータの無い連結対象拠点を、前年の承認済み実績で補完する。
    // 実績・推計のある拠点と、対象外と判断した拠点は補完しない（二重計上・判断の上書きになる）
    const unitsWithData = new Set(
      rows
        .filter((dp) => hasUsableValue(dp) || dp.availabilityStatus === 'not_applicable')
        .map((dp) => dp.unitId),
    );
    for (const unit of units) {
      if (unit.unitType === 'supplier') continue; // サプライヤーは連結対象外
      if (consolidationFactor(unit) === 0) continue;
      if (unitsWithData.has(unit.id)) continue;
      // 前年の値が無い（行が無い・未入力）なら補完しない。前年が真に 0 なら 0 で補完する
      const prevSum = sumValues(
        prev.filter(
          (dp) => dp.metricId === metric.id && dp.unitId === unit.id && isCountedInTotals(dp),
        ),
        'actual',
      );
      if (prevSum.total === null) continue;
      estimates.push({
        unitId: unit.id,
        unitName: unit.name,
        value: round2(prevSum.total * consolidationFactor(unit)),
        basis: `前年（${previous?.code ?? '—'}）の承認済み値で補完`,
        source: 'prior_year',
      });
    }
    const consolidatedWithEstimates = consolidated + estimates.reduce((sum, e) => sum + e.value, 0);

    // 加重平均（比率指標）: 分子合計 ÷ 分母合計。単純平均と並べて出す
    let weightedAverage: number | null = null;
    let simpleAverage: number | null = null;
    if (metric.dataType === 'ratio' && metric.numeratorMetricCode && metric.denominatorMetricCode) {
      const numMetric = metricByCode.get(metric.numeratorMetricCode);
      const denMetric = metricByCode.get(metric.denominatorMetricCode);
      if (numMetric && denMetric) {
        const num = actualSumFor(current, numMetric.id);
        const den = actualSumFor(current, denMetric.id);
        weightedAverage =
          num === null || den === null || den === 0 ? null : round2((num / den) * 100);
      }
      const ratioValues = rows
        .filter((dp) => hasUsableValue(dp) && kindOf(dp) === 'actual')
        .map((dp) => dp.value as number);
      simpleAverage =
        ratioValues.length === 0
          ? null
          : round2(ratioValues.reduce((s, v) => s + v, 0) / ratioValues.length);
    }

    const excludedUnits: ExcludedUnitEntry[] = units
      .filter(
        (u) =>
          u.unitType !== 'supplier' &&
          (u.consolidationMethod === 'equity' || u.consolidationMethod === 'excluded'),
      )
      .map((u) => ({
        unitName: u.name,
        method: u.consolidationMethod as 'equity' | 'excluded',
        ownershipPercent: u.ownershipPercent,
        reason: u.exclusionReason,
      }));

    results.push({
      metric,
      valueCount: actual.valueCount,
      simpleSum: round2(simpleSum),
      ownershipAdjusted: round2(ownershipAdjusted),
      intercompanyEliminated: round2(intercompanyEliminated),
      consolidated: round2(consolidated),
      estimates,
      consolidatedWithEstimates: round2(consolidatedWithEstimates),
      weightedAverage,
      simpleAverage,
      excludedUnits,
    });
  }

  return { period, previousPeriod: previous, metrics: results };
}

export interface ConsolidatedTrendEntry {
  period: ReportingPeriod;
  /** metricCodes の順に並ぶ（存在しない指標は除かれる） */
  metrics: MetricAggregate[];
}

export interface TrendPoint {
  period: ReportingPeriod;
  metric: MetricDefinition | null;
  /**
   * 推計込み連結値。その年度にこの指標の実績も推計も無ければ null（「0」として描かない）。
   * 推移の年度は「どれかの指標に実績がある年度」で決まるため、指標ごとには値の無い年度が混ざる
   */
  value: number | null;
  /** 推計を含む値か */
  estimated: boolean;
}

/** 直近の推移の 1 指標分。値の無い年度は value = null（画面は「未入力」と示し、0 のバーを描かない） */
export function consolidatedTrendSeries(
  trend: readonly ConsolidatedTrendEntry[],
  code: string,
): TrendPoint[] {
  return trend.map((entry) => {
    const agg = entry.metrics.find((m) => m.metric.code === code) ?? null;
    const hasValue = agg !== null && (agg.valueCount > 0 || agg.estimates.length > 0);
    return {
      period: entry.period,
      metric: agg?.metric ?? null,
      value: hasValue ? agg.consolidatedWithEstimates : null,
      estimated: hasValue && agg.estimates.length > 0,
    };
  });
}

/**
 * 直近 N 年の連結集計（GHG 画面の「直近3年の推移」用）。
 *
 * 「対象指標の承認済み実績を持つ年度」だけを開始日順に並べ、末尾 N 件を返す。
 * 期間コードは自由入力なのでコード順には頼らない。実績の無い年度
 * （作成直後の planning 年度など）を含めると、前年補完によって
 * 「実データゼロなのに全部推計のバー」が描かれてしまうため除外する。
 */
export async function loadConsolidatedTrend(
  db: DbClient,
  ctx: AuthorizationContext,
  periods: ReportingPeriod[],
  metricCodes: string[],
  count = 3,
): Promise<ConsolidatedTrendEntry[]> {
  const organizationId = ctx.workspace.organizationId;

  const [metrics, approved] = await Promise.all([
    db.select('metrics', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('dataPoints', {
      where: { organizationId, status: 'approved', deletedAt: { isNull: true } },
    }),
  ]);
  const metricIds = new Set(
    metricCodes
      .map((code) => metrics.find((m) => m.code === code)?.id)
      .filter((id): id is string => Boolean(id)),
  );
  // 値の無い行（未入力・対象外など）しか無い年度は「実績あり」に数えない
  const periodsWithData = new Set(
    approved
      .filter((dp) => metricIds.has(dp.metricId) && hasUsableValue(dp))
      .map((dp) => dp.reportingPeriodId),
  );

  const recent = periods
    .filter((p) => p.organizationId === organizationId && periodsWithData.has(p.id))
    .sort((a, b) => (a.startDate < b.startDate ? -1 : 1))
    .slice(-count);
  return Promise.all(
    recent.map(async (period) => {
      const aggregation = await computeConsolidatedAggregation(
        db,
        ctx,
        period,
        periods,
        metricCodes,
      );
      return { period, metrics: aggregation.metrics };
    }),
  );
}
