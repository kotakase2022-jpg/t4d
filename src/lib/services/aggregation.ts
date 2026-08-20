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
}

export interface ExcludedUnitEntry {
  unitName: string;
  method: 'equity' | 'excluded';
  ownershipPercent: number;
  reason: string | null;
}

export interface MetricAggregate {
  metric: MetricDefinition;
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

const round2 = (n: number) => Math.round(n * 100) / 100;

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

  const sumFor = (rows: DataPoint[], metricId: Uuid, counted: boolean) =>
    rows
      .filter(
        (dp) =>
          dp.metricId === metricId && (counted ? isCountedInTotals(dp) : !isCountedInTotals(dp)),
      )
      .reduce((sum, dp) => sum + (dp.value ?? 0), 0);

  const results: MetricAggregate[] = [];
  for (const code of metricCodes) {
    const metric = metricByCode.get(code);
    if (!metric) continue;
    const rule = ruleByMetricId.get(metric.id);

    const rows = current.filter((dp) => dp.metricId === metric.id && isCountedInTotals(dp));
    const simpleSum = rows.reduce((sum, dp) => sum + (dp.value ?? 0), 0);
    const ownershipAdjusted = rows.reduce((sum, dp) => {
      const unit = unitById.get(dp.unitId);
      return sum + (dp.value ?? 0) * (unit ? consolidationFactor(unit) : 1);
    }, 0);

    // 内部取引控除（ルールで有効な指標のみ）。明細行にも連結係数を掛ける
    const intercompanyEliminated = rule?.eliminateIntercompany
      ? current
          .filter((dp) => dp.metricId === metric.id && !isCountedInTotals(dp))
          .reduce((sum, dp) => {
            const unit = unitById.get(dp.unitId);
            return sum + (dp.value ?? 0) * (unit ? consolidationFactor(unit) : 1);
          }, 0)
      : 0;

    const consolidated = ownershipAdjusted - intercompanyEliminated;

    // 推計: 当年に承認済みデータの無い連結対象拠点を、前年の承認済み値で補完する
    const estimates: EstimatedEntry[] = [];
    const unitsWithData = new Set(rows.map((dp) => dp.unitId));
    for (const unit of units) {
      if (unit.unitType === 'supplier') continue; // サプライヤーは連結対象外
      if (consolidationFactor(unit) === 0) continue;
      if (unitsWithData.has(unit.id)) continue;
      const prevValue = prev
        .filter((dp) => dp.metricId === metric.id && dp.unitId === unit.id && isCountedInTotals(dp))
        .reduce((sum, dp) => sum + (dp.value ?? 0), 0);
      if (prevValue === 0) continue;
      estimates.push({
        unitId: unit.id,
        unitName: unit.name,
        value: round2(prevValue * consolidationFactor(unit)),
        basis: `前年（${previous?.code ?? '—'}）の承認済み値で補完`,
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
        const num = sumFor(current, numMetric.id, true);
        const den = sumFor(current, denMetric.id, true);
        weightedAverage = den === 0 ? null : round2((num / den) * 100);
      }
      const ratioValues = rows.map((dp) => dp.value ?? 0);
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
