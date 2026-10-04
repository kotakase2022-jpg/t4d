import { ChartFrame, type ChartTable } from '@/components/charts/chart-frame';
import { SeriesSwatch, seriesFillClass, seriesNeedsOutline } from '@/components/charts/series';
import { fitText } from '@/lib/charts/flow-layout';
import { linearScale, valueExtent } from '@/lib/charts/scale';
import { formatMillionYen, type SensitivityResult } from '@/lib/domain/financial-impact';
import { formatNumber } from '@/lib/format/datetime';
import { cn } from '@/lib/utils';

/**
 * 感度（トルネード図。docs/disclosure-first.md §10.3）。数値の仮定を 1 つずつ ±20%（他は固定）にしたときの
 * 10 年累計の幅を、幅の大きい順に上位 8 件。縦線は今の仮定での 10 年累計。
 * 系列（−20%／+20%）は色に加えて凡例の文字と、棒の端の数値で区別する。良し悪しを色で示さない。
 */

const WIDTH = 900;
const ROW_HEIGHT = 34;
const TOP = 24;
const LABEL_WIDTH = 250;
const VALUE_MARGIN = 78;
const LOW_SERIES = 0;
const HIGH_SERIES = 2;

export function Tornado({ result }: { result: SensitivityResult }) {
  const percent = Math.round(result.ratio * 100);
  if (result.rows.length === 0 || result.baseCumulative === null) {
    return (
      <p className="text-[12px] text-ink-muted">
        感度を示せる仮定がありません（定量化できた経路が無いか、動かしても 10
        年累計が変わりません）。
      </p>
    );
  }
  const base = result.baseCumulative / 1_000_000;
  const values = result.rows.flatMap((row) => [
    (row.lowCumulative ?? result.baseCumulative!) / 1_000_000,
    (row.highCumulative ?? result.baseCumulative!) / 1_000_000,
  ]);
  const [min, max] = valueExtent([...values, base], { includeZero: false });
  const left = LABEL_WIDTH + VALUE_MARGIN;
  const right = WIDTH - VALUE_MARGIN;
  const x = linearScale([min, max], [left, right]);
  const height = TOP + result.rows.length * ROW_HEIGHT + 8;

  const summary = `感度（数値の仮定を 1 つずつ ±${percent}%、他は固定）。10 年累計（百万円）の幅の大きい順: ${result.rows
    .map(
      (row) =>
        `${row.label} ${formatNumber(row.low)}〜${formatNumber(row.high)} ${row.unit} で ${formatMillionYen(row.lowCumulative ?? 0)}〜${formatMillionYen(row.highCumulative ?? 0)}`,
    )
    .join('、')}。今の仮定での 10 年累計 ${formatMillionYen(result.baseCumulative)}。`;

  const table: ChartTable = {
    caption: `感度（±${percent}%、10 年累計、百万円）`,
    columns: [
      { label: '仮定', align: 'left' },
      { label: `−${percent}% の値`, align: 'right' },
      { label: `+${percent}% の値`, align: 'right' },
      { label: `−${percent}% の 10 年累計`, align: 'right' },
      { label: `+${percent}% の 10 年累計`, align: 'right' },
      { label: '幅', align: 'right' },
    ],
    rows: result.rows.map((row) => ({
      key: row.key,
      cells: [
        row.label,
        `${formatNumber(row.low)} ${row.unit}`,
        `${formatNumber(row.high)} ${row.unit}`,
        row.lowCumulative === null ? '未定量' : formatMillionYen(row.lowCumulative),
        row.highCumulative === null ? '未定量' : formatMillionYen(row.highCumulative),
        formatMillionYen(row.width).replace(/^\+/, ''),
      ],
    })),
  };

  const legend = (
    <ul aria-label="感度の凡例" className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink">
      <li className="flex items-center gap-1">
        <SeriesSwatch index={LOW_SERIES} />
        <span>仮定を −{percent}% にしたとき</span>
      </li>
      <li className="flex items-center gap-1">
        <SeriesSwatch index={HIGH_SERIES} />
        <span>仮定を +{percent}% にしたとき</span>
      </li>
      <li className="flex items-center gap-1">
        <span aria-hidden="true" className="inline-block h-3 w-0 border-l-2 border-ink" />
        <span>今の仮定での 10 年累計（{formatMillionYen(result.baseCumulative)} 百万円）</span>
      </li>
    </ul>
  );

  return (
    <ChartFrame
      title={`感度（数値の仮定を 1 つずつ ±${percent}%、他は固定）`}
      summary={summary}
      width={WIDTH}
      height={height}
      note={
        <>
          単位: 百万円（10 年累計）。幅の大きい順に上位 {result.rows.length} 件
          {result.omitted > 0 &&
            `。動かしても累計が変わらない・未入力・0 の仮定など ${result.omitted} 件は省略`}
        </>
      }
      legend={legend}
      table={table}
    >
      {result.rows.map((row, index) => {
        const y = TOP + index * ROW_HEIGHT;
        const barY = y + 8;
        const barHeight = ROW_HEIGHT - 16;
        const segments = [
          { series: LOW_SERIES, value: row.lowCumulative },
          { series: HIGH_SERIES, value: row.highCumulative },
        ];
        return (
          <g key={row.key}>
            <text x={0} y={y + 14} fontSize={11} className="fill-ink">
              {fitText(row.label, LABEL_WIDTH - 8)}
            </text>
            <text x={0} y={y + 27} fontSize={11} className="fill-ink-muted">
              {fitText(
                `${formatNumber(row.low)}〜${formatNumber(row.high)} ${row.unit}`,
                LABEL_WIDTH - 8,
              )}
            </text>
            {segments.map(({ series, value }) => {
              if (value === null) return null;
              const end = x(value / 1_000_000);
              const start = x(base);
              // 範囲の端で止まって累計が変わらない側（例: 燃料由来 100% の +20%）は棒も数値も描かない
              // （数値は表にある）。もう一方の棒の数値と重ならないように
              if (Math.abs(end - start) < 0.5) return null;
              const outward = end < start ? 'end' : 'start';
              return (
                <g key={series}>
                  <rect
                    x={Math.min(start, end)}
                    y={barY}
                    width={Math.abs(end - start)}
                    height={barHeight}
                    rx={1}
                    strokeWidth={seriesNeedsOutline(series) ? 1 : 0}
                    className={cn(
                      seriesFillClass(series),
                      seriesNeedsOutline(series) && 'stroke-brand-700',
                    )}
                  />
                  <text
                    x={outward === 'end' ? end - 4 : end + 4}
                    y={barY + barHeight / 2 + 4}
                    textAnchor={outward}
                    fontSize={11}
                    className="tnum fill-ink"
                  >
                    {formatMillionYen(value)}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })}
      <line
        x1={x(base)}
        x2={x(base)}
        y1={TOP - 4}
        y2={height - 4}
        strokeWidth={2}
        className="stroke-ink"
      />
    </ChartFrame>
  );
}
