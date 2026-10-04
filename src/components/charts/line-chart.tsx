import { MISSING_LABEL } from '@/lib/charts/bar-layout';
import { layoutLineChart, type LineValueLabels } from '@/lib/charts/line-layout';
import { formatChartNumber, isChartNumber, type ChartValue } from '@/lib/charts/scale';
import { chartSummary, SUMMARY_FULL_LIMIT } from '@/lib/charts/summary';
import { ChartFrame, type ChartTable } from './chart-frame';
import { LineSwatch, MarkerGlyph, lineFillClass, lineStrokeClass } from './series';

/**
 * 折れ線（docs/disclosure-first.md §10.4）。Server Component で動く。
 *
 * - null で線を切る（補間しない）。どの系列にも値が無い年は「未入力」と書く
 * - 2 系列以上は色に加えて線種（実線・破線）と点の形も変える。二軸にしない
 * - 数値は点の隣に書く（既定: 6 点以下はすべて、それより多いと系列ごとに最後の点）。全数値は表に
 */

/** 凡例に書く線種（色の差だけに頼らず、文字でも区別できるように） */
function lineStyleLabel(dash: string | null): string {
  if (dash === null) return '実線';
  if (dash === '2 3') return '点線';
  return dash === '8 3 2 3' ? '一点鎖線' : '破線';
}

export interface LineChartSeries {
  label: string;
  /** xLabels と同じ順。null は未入力（線を切る） */
  values: readonly ChartValue[];
  /** 破線にするか（例: 目標達成シナリオ）。指定が無ければ系列の順で線種を変える */
  dashed?: boolean;
}

export interface LineChartProps {
  title: string;
  xLabels: readonly string[];
  series: readonly LineChartSeries[];
  unit: string;
  valueFormat?: (value: number) => string;
  /** 点の隣の数値（all・last・none）。既定は 6 点以下なら all、それより多いと last */
  valueLabels?: LineValueLabels;
  /** 縦軸に 0 を含めるか（既定 true） */
  includeZero?: boolean;
  /** 「数値を表で見る」。既定（true）は自動で作る。数値が 12 個を超えると false でも出す */
  table?: boolean | ChartTable;
  /** 表の先頭列の見出し（既定「年度」） */
  categoryLabel?: string;
  summary?: string;
  note?: React.ReactNode;
  /** viewBox の幅（既定 640）。表示の幅に近い値にする（BarChart と同じ） */
  width?: number;
  /** viewBox の高さ（既定 220） */
  height?: number;
  className?: string;
}

export function LineChart({
  title,
  xLabels,
  series,
  unit,
  valueFormat = formatChartNumber,
  valueLabels,
  includeZero = true,
  table = true,
  categoryLabel = '年度',
  summary,
  note,
  width,
  height,
  className,
}: LineChartProps) {
  const layout = layoutLineChart({
    xLabels,
    series,
    format: valueFormat,
    valueLabels,
    includeZero,
    width,
    height,
  });
  const cellCount = xLabels.length * series.length;
  const text = (value: ChartValue | undefined) =>
    isChartNumber(value) ? valueFormat(value) : MISSING_LABEL;

  let dataTable: ChartTable | undefined;
  if (typeof table === 'object') {
    dataTable = table;
  } else if (table || cellCount > SUMMARY_FULL_LIMIT) {
    dataTable = {
      caption: `${title}（単位: ${unit}）`,
      columns: [
        { label: categoryLabel, align: 'left' },
        ...series.map((s) => ({ label: s.label, align: 'right' as const })),
      ],
      rows: xLabels.map((label, index) => ({
        key: `${label}-${index}`,
        cells: [label, ...series.map((s) => text(s.values[index]))],
      })),
    };
  }

  const legend =
    series.length >= 2 ? (
      <ul
        aria-label={`${title}の凡例`}
        className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink"
      >
        {layout.series.map((s) => (
          <li key={`${s.label}-${s.seriesIndex}`} className="flex items-center gap-1">
            <LineSwatch index={s.seriesIndex} dash={s.dash} shape={s.marker} />
            <span>
              {s.label}（{lineStyleLabel(s.dash)}）
            </span>
          </li>
        ))}
      </ul>
    ) : undefined;

  const { plot } = layout;
  return (
    <ChartFrame
      title={title}
      summary={
        summary ?? chartSummary({ title, unit, categories: xLabels, series, format: valueFormat })
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
      {layout.ticks.map((tick) => (
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
      ))}
      {layout.zero !== null && (
        <line
          x1={plot.left}
          x2={plot.right}
          y1={layout.zero}
          y2={layout.zero}
          className="stroke-ink-muted"
          strokeWidth={1}
        />
      )}

      {layout.xLabels.map((label, index) => (
        <text
          key={`x-${index}`}
          x={label.x}
          y={label.y}
          textAnchor={label.anchor}
          fontSize={11}
          className="fill-ink"
        >
          {label.text}
        </text>
      ))}

      {layout.series.map((s) => (
        <g key={`series-${s.seriesIndex}`}>
          {s.segments
            .filter((segment) => segment.length >= 2)
            .map((segment, index) => (
              <polyline
                key={`segment-${index}`}
                points={segment.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={s.dash ?? undefined}
                className={lineStrokeClass(s.seriesIndex)}
              />
            ))}
          {s.points.map((p) => (
            <MarkerGlyph
              key={`point-${p.index}`}
              shape={s.marker}
              cx={p.x}
              cy={p.y}
              className={`${lineFillClass(s.seriesIndex)} stroke-surface`}
            />
          ))}
        </g>
      ))}

      {layout.valueLabels.map((label) => (
        <text
          key={`value-${label.seriesIndex}-${label.index}`}
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
          key={`missing-${label.index}`}
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
