import { cn } from '@/lib/utils';

/**
 * 構成比の積み上げバー（Progress の姉妹部品）。
 *
 * 色だけで区別しない: 凡例（名前・数値・%）を必ず併記する前提の部品で、
 * バー自体は role="img" の要約テキストで内容を伝える。
 * 呼び出し側は `stackedBarSegmentClass(index)` で凡例の色チップと
 * バーの区分色を一致させる。
 */

const SEGMENT_CLASSES = [
  'bg-brand-700',
  'bg-brand-500',
  'bg-brand-300',
  'bg-brand-800',
  'bg-brand-400',
  'bg-brand-200',
  'bg-brand-600',
  'bg-brand-100',
] as const;

export function stackedBarSegmentClass(index: number): string {
  return SEGMENT_CLASSES[index % SEGMENT_CLASSES.length] ?? 'bg-brand-500';
}

export interface StackedBarSegment {
  label: string;
  value: number;
}

export function StackedBar({
  segments,
  label,
  unit,
  className,
}: {
  segments: StackedBarSegment[];
  /** 支援技術向けの要約の主語（例: 「Scope3 サプライヤー別内訳」） */
  label: string;
  /** 値の単位（要約テキストに使う） */
  unit: string;
  className?: string;
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const summary =
    total > 0
      ? segments
          .map((s) => `${s.label} ${s.value}${unit}（${Math.round((s.value / total) * 100)}%）`)
          .join('、')
      : 'データなし';

  return (
    <div
      role="img"
      aria-label={`${label}: ${summary}`}
      className={cn('flex h-2.5 w-full overflow-hidden rounded-full bg-line', className)}
    >
      {total > 0 &&
        segments.map((segment, index) => (
          <div
            key={`${segment.label}-${index}`}
            className={cn('h-full', stackedBarSegmentClass(index))}
            style={{ width: `${(segment.value / total) * 100}%` }}
          />
        ))}
    </div>
  );
}

/** 凡例用の色チップ。隣に必ずラベルと数値を書くこと（色だけで表さない） */
export function StackedBarLegendChip({ index }: { index: number }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-2.5 shrink-0 rounded-[3px]', stackedBarSegmentClass(index))}
    />
  );
}
