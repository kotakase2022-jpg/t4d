import {
  layoutBarChart,
  stackTotals,
  MISSING_LABEL,
  type BarOrientation,
} from '@/lib/charts/bar-layout';
import { formatChartNumber, isChartNumber, type ChartValue } from '@/lib/charts/scale';
import { chartSummary, SUMMARY_FULL_LIMIT } from '@/lib/charts/summary';
import { cn } from '@/lib/utils';
import { ChartFrame, type ChartTable } from './chart-frame';
import { SeriesSwatch, seriesFillClass, seriesNeedsOutline } from './series';

/**
 * 棒グラフ（縦・横、積み上げ可。docs/disclosure-first.md §10.4）。Server Component で動く。
 *
 * - 負の値は 0 軸の下（横向きは左）。null は棒を描かず「未入力」と書く（0 にしない）
 * - 数値は棒の隣に書く（積み上げは区分ごとの合計）。全数値は「数値を表で見る」
 * - 2 系列以上は凡例（HTML のラベル）。系列色は StackedBar と同じ順で、良し悪しを色で示さない
 */

export interface BarChartSeries {
  label: string;
  /** categories と同じ順。null は未入力・未定量（0 ではない） */
  values: readonly ChartValue[];
}

export interface BarChartProps {
  /** 図の題（figcaption。aria-label の先頭にも使う） */
  title: string;
  categories: readonly string[];
  series: readonly BarChartSeries[];
  /** 値の単位（例「t-CO2e」「百万円」）。題の下と表・aria-label に出す */
  unit: string;
  orientation?: BarOrientation;
  stacked?: boolean;
  /** 数値の書式（既定: 桁区切り・小数 1 桁まで。負は「−」） */
  valueFormat?: (value: number) => string;
  /** 棒の隣に数値を書くか（既定 true） */
  showValues?: boolean;
  /**
   * 「数値を表で見る」。既定（true）は区分 × 系列から自動で作る。false で出さない
   * （ただし数値が 12 個を超える図は aria-label に全数値を書けないため、false でも出す）
   */
  table?: boolean | ChartTable;
  /** 表の先頭列の見出し（既定「区分」） */
  categoryLabel?: string;
  /** aria-label を自分で書くとき（既定は数値から自動で作る） */
  summary?: string;
  /** 題の下の補足（単位の後ろに続ける） */
  note?: React.ReactNode;
  /**
   * viewBox の幅（既定 640）。表示の幅に近い値にする（本文の全幅 ≈ 960、2 列の片方 ≈ 480）。
   * 表示より大きいと文字が縮み、小さいと 1.25 倍まで拡大する
   */
  width?: number;
  /** 縦向きの viewBox の高さ（既定 240）。横向きは区分の数から決まる */
  height?: number;
  className?: string;
}

export function BarChart({
  title,
  categories,
  series,
  unit,
  orientation = 'vertical',
  stacked = false,
  valueFormat = formatChartNumber,
  showValues = true,
  table = true,
  categoryLabel = '区分',
  summary,
  note,
  width,
  height,
  className,
}: BarChartProps) {
  const layout = layoutBarChart({
    categories,
    series,
    orientation,
    stacked,
    showValues,
    format: valueFormat,
    width,
    height,
  });
  const vertical = orientation === 'vertical';
  const cellCount = categories.length * series.length;
  const text = (value: ChartValue | undefined) =>
    isChartNumber(value) ? valueFormat(value) : MISSING_LABEL;

  let dataTable: ChartTable | undefined;
  if (typeof table === 'object') {
    dataTable = table;
  } else if (table || cellCount > SUMMARY_FULL_LIMIT) {
    const totals = stacked ? stackTotals(categories, series) : [];
    dataTable = {
      caption: `${title}（単位: ${unit}）`,
      columns: [
        { label: categoryLabel, align: 'left' },
        ...series.map((s) => ({ label: s.label, align: 'right' as const })),
        ...(stacked ? [{ label: '合計', align: 'right' as const }] : []),
      ],
      rows: categories.map((category, index) => ({
        key: `${category}-${index}`,
        cells: [
          category,
          ...series.map((s) => text(s.values[index])),
          ...(stacked ? [text(totals[index]?.total ?? null)] : []),
        ],
      })),
    };
  }

  const legend =
    series.length >= 2 ? (
      <ul
        aria-label={`${title}の凡例`}
        className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink"
      >
        {series.map((s, index) => (
          <li key={`${s.label}-${index}`} className="flex items-center gap-1">
            <SeriesSwatch index={index} />
            <span>{s.label}</span>
          </li>
        ))}
      </ul>
    ) : undefined;

  const { plot } = layout;
  return (
    <ChartFrame
      title={title}
      summary={
        summary ?? chartSummary({ title, unit, categories, series, stacked, format: valueFormat })
      }
      width={layout.width}
      height={layout.height}
      note={
        <>
          単位: {unit}
          {note ? <span className="ml-2">{note}</span> : null}
        </>
      }
      legend={legend}
      table={dataTable}
      className={className}
    >
      {/* 目盛りと格子（控えめ）。0 軸だけ濃くする */}
      {layout.ticks.map((tick) =>
        vertical ? (
          <g key={`tick-${tick.value}`}>
            <line
              x1={plot.left}
              x2={plot.right}
              y1={tick.position}
              y2={tick.position}
              className="stroke-line"
              strokeWidth={1}
            />
            <text
              x={plot.left - 6}
              y={tick.position + 4}
              textAnchor="end"
              fontSize={11}
              className="fill-ink-muted"
            >
              {tick.text}
            </text>
          </g>
        ) : (
          <g key={`tick-${tick.value}`}>
            <line
              x1={tick.position}
              x2={tick.position}
              y1={plot.top}
              y2={plot.bottom}
              className="stroke-line"
              strokeWidth={1}
            />
            <text
              x={tick.position}
              y={plot.bottom + 15}
              textAnchor="middle"
              fontSize={11}
              className="fill-ink-muted"
            >
              {tick.text}
            </text>
          </g>
        ),
      )}

      {layout.bars
        .filter((bar) => bar.width > 0 && bar.height > 0)
        .map((bar) => (
          <rect
            key={`bar-${bar.categoryIndex}-${bar.seriesIndex}`}
            x={bar.x}
            y={bar.y}
            width={bar.width}
            height={bar.height}
            rx={1}
            strokeWidth={seriesNeedsOutline(bar.seriesIndex) ? 1 : 0}
            className={cn(
              seriesFillClass(bar.seriesIndex),
              seriesNeedsOutline(bar.seriesIndex) && 'stroke-brand-700',
            )}
          />
        ))}

      {vertical ? (
        <line
          x1={plot.left}
          x2={plot.right}
          y1={layout.zero}
          y2={layout.zero}
          className="stroke-ink-muted"
          strokeWidth={1}
        />
      ) : (
        <line
          x1={layout.zero}
          x2={layout.zero}
          y1={plot.top}
          y2={plot.bottom}
          className="stroke-ink-muted"
          strokeWidth={1}
        />
      )}

      {layout.categoryLabels.map((label, index) => (
        <text
          key={`category-${index}`}
          x={label.x}
          y={label.y}
          textAnchor={label.anchor}
          fontSize={11}
          className="fill-ink"
        >
          {label.text}
        </text>
      ))}

      {layout.valueLabels.map((label) => (
        <text
          key={`value-${label.categoryIndex}-${label.seriesIndex ?? 'total'}`}
          x={label.x}
          y={label.y}
          textAnchor={label.anchor}
          fontSize={11}
          className="tnum fill-ink"
        >
          {label.text}
        </text>
      ))}

      {layout.missing.map((label) => (
        <text
          key={`missing-${label.categoryIndex}-${label.seriesIndex ?? 'all'}`}
          x={label.x}
          y={label.y}
          textAnchor={label.anchor}
          fontSize={11}
          className="fill-ink-muted"
        >
          {label.text}
        </text>
      ))}
    </ChartFrame>
  );
}
