import { stackedBarSegmentClass } from '@/components/ui/stacked-bar';
import type { MarkerShape } from '@/lib/charts/line-layout';
import { cn } from '@/lib/utils';

/**
 * 図の系列の色と印（docs/disclosure-first.md §10.4 図の規則）。
 *
 * - 系列色は StackedBar（stackedBarSegmentClass）と同じ順。凡例のチップと図の塗りが一致する
 * - 明るい色（brand-100〜300）は白い背景に溶けるため、brand-700 の 1px 枠を付ける
 * - 色は系列の識別だけに使い、良し悪し（success・warning・danger）を示さない。識別は必ずラベルと一緒
 * - 折れ線は白い背景で 3:1 以上の濃さの色だけを使い、線種と点の形でも区別する
 * Tailwind は文字列のクラス名しか拾わないため、クラスは配列にそのまま書く。
 */

const FILL_CLASSES = [
  'fill-brand-700',
  'fill-brand-500',
  'fill-brand-300',
  'fill-brand-800',
  'fill-brand-400',
  'fill-brand-200',
  'fill-brand-600',
  'fill-brand-100',
] as const;

/** 枠を付ける（明るい）色の位置。FILL_CLASSES と stackedBarSegmentClass の同じ位置 */
const LIGHT_INDEXES = new Set([2, 5, 7]);

const LINE_STROKE_CLASSES = [
  'stroke-brand-700',
  'stroke-brand-500',
  'stroke-brand-900',
  'stroke-brand-400',
] as const;

const LINE_FILL_CLASSES = [
  'fill-brand-700',
  'fill-brand-500',
  'fill-brand-900',
  'fill-brand-400',
] as const;

export function seriesFillClass(index: number): string {
  return FILL_CLASSES[index % FILL_CLASSES.length] ?? 'fill-brand-500';
}

/** 明るい色で、枠（stroke-brand-700 の 1px）が要るか */
export function seriesNeedsOutline(index: number): boolean {
  return LIGHT_INDEXES.has(index % FILL_CLASSES.length);
}

export function lineStrokeClass(index: number): string {
  return LINE_STROKE_CLASSES[index % LINE_STROKE_CLASSES.length] ?? 'stroke-brand-700';
}

export function lineFillClass(index: number): string {
  return LINE_FILL_CLASSES[index % LINE_FILL_CLASSES.length] ?? 'fill-brand-700';
}

/** 凡例の色チップ（HTML）。隣に必ずラベルを書く（色だけで表さない） */
export function SeriesSwatch({ index }: { index: number }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-2.5 shrink-0 rounded-[3px]',
        stackedBarSegmentClass(index),
        seriesNeedsOutline(index) && 'border border-brand-700',
      )}
    />
  );
}

/** 点の形（SVG）。cx・cy を中心に描く */
export function MarkerGlyph({
  shape,
  cx,
  cy,
  size = 4,
  className,
}: {
  shape: MarkerShape;
  cx: number;
  cy: number;
  size?: number;
  className?: string;
}) {
  switch (shape) {
    case 'square':
      return (
        <rect
          x={cx - size}
          y={cy - size}
          width={size * 2}
          height={size * 2}
          className={className}
        />
      );
    case 'triangle':
      return (
        <polygon
          points={`${cx},${cy - size - 1} ${cx + size + 1},${cy + size} ${cx - size - 1},${cy + size}`}
          className={className}
        />
      );
    case 'diamond':
      return (
        <polygon
          points={`${cx},${cy - size - 1} ${cx + size + 1},${cy} ${cx},${cy + size + 1} ${cx - size - 1},${cy}`}
          className={className}
        />
      );
    default:
      return <circle cx={cx} cy={cy} r={size} className={className} />;
  }
}

/** 凡例の線と点の見本（SVG・装飾）。隣に必ずラベルを書く */
export function LineSwatch({
  index,
  dash,
  shape,
}: {
  index: number;
  dash: string | null;
  shape: MarkerShape;
}) {
  return (
    <svg viewBox="0 0 24 10" aria-hidden="true" focusable="false" className="h-2.5 w-6 shrink-0">
      <line
        x1={1}
        x2={23}
        y1={5}
        y2={5}
        strokeWidth={2}
        strokeDasharray={dash ?? undefined}
        className={lineStrokeClass(index)}
      />
      <MarkerGlyph shape={shape} cx={12} cy={5} size={3} className={lineFillClass(index)} />
    </svg>
  );
}
