import { fid } from '@/lib/fixtures/ids';
import type {
  DataPoint,
  DataPointValidationResult,
  MetricDefinition,
  OrganizationUnit,
  ReportingPeriod,
  Uuid,
  ValidationRuleKey,
  ValidationSeverity,
} from '@/types/domain';

/**
 * Data Point の検証（指示書 7.1-9 / 15 章 DQ-P0-001, DQ-P0-002）。
 *
 * 純関数として実装し、Demo / Supabase いずれのモードでも同じ結果になるようにする。
 * エラー（error）と警告（warning）を明確に区別する。
 */

export interface ValidationInput {
  dataPoints: DataPoint[];
  metrics: MetricDefinition[];
  units: OrganizationUnit[];
  periods: ReportingPeriod[];
  /** dataPointId → 紐付く Evidence 件数 */
  evidenceCountByDataPoint: Map<Uuid, number>;
  /** 前年度の Data Point（YoY 判定用） */
  previousPeriodDataPoints: DataPoint[];
  detectedAt: string;
}

interface RuleHit {
  dataPointId: Uuid;
  ruleKey: ValidationRuleKey;
  severity: ValidationSeverity;
  message: string;
  details: Record<string, unknown>;
}

export function validateDataPoints(input: ValidationInput): DataPointValidationResult[] {
  const metricById = new Map(input.metrics.map((m) => [m.id, m]));
  const metricByCode = new Map(input.metrics.map((m) => [m.code, m]));
  const unitById = new Map(input.units.map((u) => [u.id, u]));
  const hits: RuleHit[] = [];

  // 前年同一キーの索引。boundary を含めないと、内部取引の明細行が前年の連結合計と
  // 突き合わされて虚偽の前年比警告になる（重複検出キー（下）と同じ粒度に揃える）。
  const prevKey = (dp: DataPoint) => `${dp.metricId}|${dp.unitId}|${dp.boundary}`;
  const previousByKey = new Map(input.previousPeriodDataPoints.map((dp) => [prevKey(dp), dp]));

  // 同一報告期間内の (metric, unit) 重複検出
  const seen = new Map<string, Uuid>();

  // 指標コード別・拠点別の単位集合（単位混在の検出）
  const unitsByMetric = new Map<Uuid, Set<string>>();
  for (const dp of input.dataPoints) {
    if (dp.value === null) continue;
    const set = unitsByMetric.get(dp.metricId) ?? new Set<string>();
    set.add(dp.unitOfMeasure);
    unitsByMetric.set(dp.metricId, set);
  }

  // 比率指標の分子・分母を引くための索引
  const valueByCodeAndUnit = new Map<string, number>();
  for (const dp of input.dataPoints) {
    const metric = metricById.get(dp.metricId);
    if (!metric || dp.value === null) continue;
    valueByCodeAndUnit.set(`${metric.code}|${dp.unitId}`, dp.value);
  }

  for (const dp of input.dataPoints) {
    const metric = metricById.get(dp.metricId);
    if (!metric) continue;
    const unit = unitById.get(dp.unitId);
    const unitName = unit?.name ?? '(不明な組織)';

    // 1. 重複
    const key = `${dp.metricId}|${dp.unitId}|${dp.boundary}`;
    const dup = seen.get(key);
    if (dup) {
      hits.push({
        dataPointId: dp.id,
        ruleKey: 'duplicate',
        severity: 'error',
        message: `${unitName} の「${metric.name}」が同一境界で重複登録されています。`,
        details: { duplicateOf: dup },
      });
    } else {
      seen.set(key, dp.id);
    }

    // 2. 必須
    if (dp.value === null && dp.textValue === null && dp.status !== 'not_started') {
      hits.push({
        dataPointId: dp.id,
        ruleKey: 'required',
        severity: 'error',
        message: `${unitName} の「${metric.name}」に値が入力されていません。`,
        details: {},
      });
    }

    if (dp.value !== null) {
      // 3. データ型
      if (metric.dataType === 'integer' && !Number.isInteger(dp.value)) {
        hits.push({
          dataPointId: dp.id,
          ruleKey: 'data_type',
          severity: 'error',
          message: `「${metric.name}」は整数で入力してください（現在値: ${dp.value}）。`,
          details: { value: dp.value },
        });
      }

      // 4. 範囲
      if (metric.minValue !== null && dp.value < metric.minValue) {
        hits.push({
          dataPointId: dp.id,
          ruleKey: 'range',
          severity: 'error',
          message: `「${metric.name}」の値が下限 ${metric.minValue} を下回っています。`,
          details: { value: dp.value, min: metric.minValue },
        });
      }
      if (metric.maxValue !== null && dp.value > metric.maxValue) {
        hits.push({
          dataPointId: dp.id,
          ruleKey: 'range',
          severity: 'error',
          message: `「${metric.name}」の値が上限 ${metric.maxValue} を超えています。`,
          details: { value: dp.value, max: metric.maxValue },
        });
      }

      // 5. 単位
      if (dp.unitOfMeasure !== metric.unit) {
        hits.push({
          dataPointId: dp.id,
          ruleKey: 'unit_mismatch',
          severity: 'error',
          message: `${unitName} の「${metric.name}」の単位が指標定義（${metric.unit}）と異なります（報告単位: ${dp.unitOfMeasure}）。集計時に桁違いとなる可能性があります。`,
          details: { expected: metric.unit, actual: dp.unitOfMeasure },
        });
      }
      const unitSet = unitsByMetric.get(dp.metricId);
      if (unitSet && unitSet.size > 1) {
        hits.push({
          dataPointId: dp.id,
          ruleKey: 'unit_inconsistent_across_units',
          severity: 'warning',
          message: `「${metric.name}」で複数の単位（${[...unitSet].join(' / ')}）が混在しています。`,
          details: { units: [...unitSet] },
        });
      }

      // 6. 前年差
      const prev = previousByKey.get(prevKey(dp));
      if (prev && prev.value !== null && prev.value !== 0 && metric.yoyWarningRatio !== null) {
        const change = Math.abs(dp.value - prev.value) / Math.abs(prev.value);
        if (change > metric.yoyWarningRatio) {
          const times = dp.value / prev.value;
          hits.push({
            dataPointId: dp.id,
            ruleKey: 'yoy_deviation',
            severity: change > 1 ? 'error' : 'warning',
            message: `${unitName} の「${metric.name}」が前年比 ${times.toFixed(1)} 倍（許容 ±${Math.round(metric.yoyWarningRatio * 100)}%）です。単位・桁・対象範囲を確認してください。`,
            details: { current: dp.value, previous: prev.value, ratio: times },
          });
        }
      }

      // 7. 分子 > 分母（人的資本・ガバナンスの打ち間違い検出）
      if (metric.numeratorMetricCode && metric.denominatorMetricCode) {
        const numerator = valueByCodeAndUnit.get(`${metric.numeratorMetricCode}|${dp.unitId}`);
        const denominator = valueByCodeAndUnit.get(`${metric.denominatorMetricCode}|${dp.unitId}`);
        if (numerator !== undefined && denominator !== undefined) {
          const numeratorMetric = metricByCode.get(metric.numeratorMetricCode);
          const denominatorMetric = metricByCode.get(metric.denominatorMetricCode);
          if (numerator > denominator) {
            hits.push({
              dataPointId: dp.id,
              ruleKey: 'ratio_numerator_exceeds_denominator',
              severity: 'error',
              message: `${numeratorMetric?.name ?? metric.numeratorMetricCode}（${numerator}）が ${denominatorMetric?.name ?? metric.denominatorMetricCode}（${denominator}）を超えています。いずれかが誤っています。`,
              details: { numerator, denominator },
            });
          } else if (denominator !== 0) {
            const expected = Math.round((numerator / denominator) * 1000) / 10;
            if (Math.abs(expected - dp.value) > 0.2) {
              hits.push({
                dataPointId: dp.id,
                ruleKey: 'formula_mismatch',
                severity: 'warning',
                message: `「${metric.name}」の報告値 ${dp.value}% は、分子分母から算出される ${expected}% と一致しません。`,
                details: { reported: dp.value, expected },
              });
            }
          }
        }
      }
    }

    // 8. Evidence 不足
    const evidenceCount = input.evidenceCountByDataPoint.get(dp.id) ?? 0;
    if (metric.requiresEvidence && evidenceCount === 0 && dp.status !== 'not_started') {
      hits.push({
        dataPointId: dp.id,
        ruleKey: 'missing_evidence',
        severity: dp.status === 'approved' ? 'error' : 'warning',
        message: `${unitName} の「${metric.name}」に Evidence が紐付いていません（この指標は Evidence 必須です）。`,
        details: {},
      });
    }

    // 9. 承認後変更
    if (dp.changedAfterApproval) {
      hits.push({
        dataPointId: dp.id,
        ruleKey: 'changed_after_approval',
        severity: 'warning',
        message: `${unitName} の「${metric.name}」は承認後に値が変更されています。再承認の要否を確認してください。`,
        details: {},
      });
    }
  }

  return hits.map((hit, index) => ({
    id: fid('validation', `${hit.dataPointId}/${hit.ruleKey}/${index}`),
    dataPointId: hit.dataPointId,
    organizationId: input.dataPoints.find((d) => d.id === hit.dataPointId)?.organizationId ?? '',
    ruleKey: hit.ruleKey,
    severity: hit.severity,
    message: hit.message,
    details: hit.details,
    detectedAt: input.detectedAt,
    resolvedAt: null,
  }));
}

export interface ValidationSummary {
  errorCount: number;
  warningCount: number;
  byDataPoint: Map<Uuid, { errors: number; warnings: number }>;
}

export function summarizeValidations(results: DataPointValidationResult[]): ValidationSummary {
  const byDataPoint = new Map<Uuid, { errors: number; warnings: number }>();
  let errorCount = 0;
  let warningCount = 0;
  for (const r of results) {
    const entry = byDataPoint.get(r.dataPointId) ?? { errors: 0, warnings: 0 };
    if (r.severity === 'error') {
      entry.errors += 1;
      errorCount += 1;
    } else if (r.severity === 'warning') {
      entry.warnings += 1;
      warningCount += 1;
    }
    byDataPoint.set(r.dataPointId, entry);
  }
  return { errorCount, warningCount, byDataPoint };
}
