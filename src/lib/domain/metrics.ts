import type {
  AggregationMethod,
  MetricCategory,
  MetricDataType,
  MetricDefinition,
  MetricFrameworkKey,
} from '@/types/domain';

/**
 * 指標マスターの表示ラベルと、開示基準ごとの充足状況。
 *
 * 指標マスターは長らく自社都合の一覧でしかなく、SSBJ・CDP・CSRD のどれが
 * その指標を求めているのかがどこにも無かった。出所を指標へ持たせたことで、
 * 「基準が求めているのに社内に値が無い」を数えられるようになる。
 */

export const METRIC_CATEGORY_LABEL: Record<MetricCategory, string> = {
  ghg: '温室効果ガス',
  energy: 'エネルギー',
  water: '水',
  waste: '廃棄物',
  human_capital: '人的資本',
  governance: 'ガバナンス',
  climate_transition: '気候関連の財務影響',
};

export const METRIC_DATA_TYPE_LABEL: Record<MetricDataType, string> = {
  number: '数値',
  integer: '整数',
  ratio: '比率',
  text: '文章',
  boolean: '該否',
};

export const AGGREGATION_METHOD_LABEL: Record<AggregationMethod, string> = {
  sum: '合計',
  average: '平均',
  weighted_average: '加重平均',
  ratio: '比率計算',
  latest: '最新値',
  none: '集計しない',
};

export const METRIC_FRAMEWORK_LABEL: Record<MetricFrameworkKey, string> = {
  ssbj: 'SSBJ',
  cdp: 'CDP',
  csrd: 'CSRD',
};

export const MATERIALITY_LABEL: Record<MetricDefinition['materiality'], string> = {
  high: '高',
  medium: '中',
  low: '低',
};

export interface FrameworkCoverage {
  framework: MetricFrameworkKey;
  label: string;
  /** その基準が求める指標の数 */
  required: number;
  /** うち、当年度に値が入っている指標の数 */
  collected: number;
  /** 充足率（%）。要求 0 件なら 0 */
  rate: number;
}

/**
 * 基準ごとに「求められている指標のうち、何件に値があるか」を数える。
 *
 * 開示の可否は最終的にこの充足率で決まる。要求事項の文章を読んだだけでは
 * 「数字が無いから書けない」に気づけないため、指標の側からも見えるようにする。
 */
export function summarizeFrameworkCoverage(
  metrics: MetricDefinition[],
  metricIdsWithValue: ReadonlySet<string>,
  frameworks: readonly MetricFrameworkKey[],
): FrameworkCoverage[] {
  return frameworks.map((framework) => {
    const required = metrics.filter((m) => m.frameworks.includes(framework));
    const collected = required.filter((m) => metricIdsWithValue.has(m.id));
    return {
      framework,
      label: METRIC_FRAMEWORK_LABEL[framework],
      required: required.length,
      collected: collected.length,
      rate: required.length === 0 ? 0 : Math.round((collected.length / required.length) * 100),
    };
  });
}
