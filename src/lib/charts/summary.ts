import { stackTotals, MISSING_LABEL } from './bar-layout';
import { formatChartNumber, isChartNumber, type ChartValue } from './scale';

/**
 * 図の文字の代替（role="img" の aria-label。docs/disclosure-first.md §10.4）。
 * 12 個までの数値は全部書き、それより多いときは要点（区分数・最大・最小・未入力の数）だけを書いて
 * 全数値は「数値を表で見る」に任せる。null は「未入力」と書く（0 と書かない）。
 */

export const SUMMARY_FULL_LIMIT = 12;

export interface SummarySeries {
  label: string;
  values: readonly ChartValue[];
}

export function chartSummary({
  title,
  unit,
  categories,
  series,
  stacked = false,
  format = formatChartNumber,
}: {
  title: string;
  unit: string;
  categories: readonly string[];
  series: readonly SummarySeries[];
  stacked?: boolean;
  format?: (value: number) => string;
}): string {
  const head = `${title}（単位: ${unit}）。`;
  const text = (value: ChartValue | undefined) =>
    isChartNumber(value) ? format(value) : MISSING_LABEL;
  const cellCount = categories.length * series.length;
  if (cellCount === 0) return `${head}データがありません。`;

  if (cellCount <= SUMMARY_FULL_LIMIT) {
    const parts = categories.map((category, index) => {
      if (series.length === 1) return `${category} ${text(series[0]?.values[index])}`;
      const inner = series.map((s) => `${s.label} ${text(s.values[index])}`).join('、');
      return `${category}: ${inner}`;
    });
    return `${head}${parts.join(series.length === 1 ? '、' : '／')}。`;
  }

  const cells = series.flatMap((s) =>
    categories.map((category, index) => ({ category, series: s.label, value: s.values[index] })),
  );
  const present = cells.filter((cell): cell is typeof cell & { value: number } =>
    isChartNumber(cell.value),
  );
  const missing = cells.length - present.length;
  const parts = [`${categories.length} 区分 × ${series.length} 系列`];
  if (stacked && categories.length <= SUMMARY_FULL_LIMIT) {
    const totals = stackTotals(categories, series);
    parts.push(
      `合計: ${categories.map((category, index) => `${category} ${text(totals[index]?.total ?? null)}`).join('、')}`,
    );
  } else if (present.length > 0) {
    const max = present.reduce((a, b) => (b.value > a.value ? b : a));
    const min = present.reduce((a, b) => (b.value < a.value ? b : a));
    parts.push(`最大 ${format(max.value)}（${max.category}・${max.series}）`);
    parts.push(`最小 ${format(min.value)}（${min.category}・${min.series}）`);
  }
  if (missing > 0) parts.push(`${MISSING_LABEL} ${missing} 件`);
  return `${head}${parts.join('。')}。全数値は「数値を表で見る」にあります。`;
}
