import { layoutMiniBars, MISSING_LABEL } from '@/lib/charts/bar-layout';
import { formatChartNumber, isChartNumber, type ChartValue } from '@/lib/charts/scale';
import { cn } from '@/lib/utils';

/**
 * 表の中の小さな年次バー（docs/disclosure-first.md §10.4）。0 起点。null は破線の空枠（0 の棒にしない）、
 * 0 は 0 軸上の細い線。
 *
 * decorative（表の隣のセルに数値があるとき）は aria-hidden にして読み上げを重ねない。
 * そうでなければ role="img" と、全年度の値を書いた aria-label を付ける。
 */
export function MiniBars({
  values,
  labels,
  label,
  unit,
  decorative = false,
  valueFormat = formatChartNumber,
  className,
}: {
  /** 古い年度 → 新しい年度の順 */
  values: readonly ChartValue[];
  /** values と同じ順の年度名（例 FY2024） */
  labels: readonly string[];
  /** aria-label の主語（decorative でないときは必須に近い。例「Scope1 の推移」） */
  label?: string;
  unit?: string;
  decorative?: boolean;
  valueFormat?: (value: number) => string;
  className?: string;
}) {
  const layout = layoutMiniBars(values);
  const summary = `${label ?? '推移'}: ${values
    .map((value, index) => {
      const year = labels[index] ?? `${index + 1}`;
      return isChartNumber(value)
        ? `${year} ${valueFormat(value)}${unit ? ` ${unit}` : ''}`
        : `${year} ${MISSING_LABEL}`;
    })
    .join('、')}`;
  const a11y = decorative
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'img', 'aria-label': summary } as const);
  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      focusable="false"
      className={cn('inline-block h-5 w-auto shrink-0 align-middle', className)}
      {...a11y}
    >
      <line
        x1={0}
        x2={layout.width}
        y1={layout.zero}
        y2={layout.zero}
        className="stroke-line"
        strokeWidth={1}
      />
      {layout.bars.map((bar) =>
        bar.value === null ? (
          <rect
            key={bar.index}
            x={bar.x + 0.5}
            y={bar.y + 0.5}
            width={bar.width - 1}
            height={bar.height - 1}
            fill="none"
            strokeDasharray="2 2"
            strokeWidth={1}
            className="stroke-ink-muted"
          />
        ) : (
          <rect
            key={bar.index}
            x={bar.x}
            y={bar.y}
            width={bar.width}
            height={bar.height}
            className={bar.value === 0 ? 'fill-ink-muted' : 'fill-brand-600'}
          />
        ),
      )}
    </svg>
  );
}
