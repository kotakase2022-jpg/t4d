import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { stackedBarSegmentClass } from '@/components/ui/stacked-bar';
import { countText, fractionText, layoutBreakdown, wholePercent } from '@/lib/charts/breakdown';
import { cn } from '@/lib/utils';
import { SeriesSwatch, seriesNeedsOutline } from './series';

/**
 * 状態の内訳（積み上げの帯＋凡例。docs/disclosure-first.md §10.4）。
 *
 * - 凡例 `<ul aria-label={label}>` が文字の本体: 各項目は 色チップ・アイコン・ラベル（独立した要素。
 *   既存の画面の文言をそのまま渡す）・件数。帯は凡例と同じ内容なので aria-hidden（読み上げを重ねない）
 * - 件数 0 の項目も凡例には出す（帯には出さない）。0 でない区分は最小幅を持つ
 * - % は既定で出さない（分析系は割合だけを見せない）。denominator を渡すと件数を「n / N 件」で書く
 * - 色は区分の識別だけ（StackedBar と同じ順）。良し悪しを色で示さない
 */

export interface StatusBreakdownItem {
  key: string;
  /** 画面の既存の文言そのまま（例「承認済み」「レビュー中」）。独立した要素で描く */
  label: string;
  count: number;
  icon?: LucideIcon;
  /** その状態の一覧へのリンク（ラベルがリンクになる） */
  href?: string;
}

export function StatusBreakdown({
  label,
  items,
  unit = '件',
  showPercent = false,
  denominator,
  className,
}: {
  /** 凡例のリストの名前（getByRole('list', { name: label })） */
  label: string;
  items: readonly StatusBreakdownItem[];
  unit?: string;
  showPercent?: boolean;
  /** 渡すと各件数を「n / N 単位」で書く（例: 10 事項のうち） */
  denominator?: number;
  className?: string;
}) {
  const layout = layoutBreakdown(items);
  const total = denominator ?? layout.total;
  return (
    <div className={cn('min-w-0 space-y-1.5', className)}>
      <div
        aria-hidden="true"
        className="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-line"
      >
        {layout.segments.map((segment) => (
          <div
            key={segment.key}
            className={cn(
              'h-full',
              stackedBarSegmentClass(segment.index),
              seriesNeedsOutline(segment.index) && 'border border-brand-700',
            )}
            style={{ width: `${segment.width}%` }}
          />
        ))}
      </div>
      <ul aria-label={label} className="flex flex-wrap gap-x-3 gap-y-1 text-small">
        {items.map((item, index) => {
          const Icon = item.icon;
          const percent = showPercent ? wholePercent(item.count, total) : null;
          return (
            <li key={item.key} className="flex items-center gap-1">
              <SeriesSwatch index={index} />
              {Icon && <Icon aria-hidden="true" className="size-3.5 shrink-0 text-ink-muted" />}
              {item.href ? (
                <Link href={item.href} className="text-brand-700 hover:underline">
                  <span>{item.label}</span>
                </Link>
              ) : (
                <span className="text-ink">{item.label}</span>
              )}
              <span className="tnum font-medium text-ink">
                {denominator !== undefined
                  ? fractionText(item.count, denominator, unit)
                  : countText(item.count, unit)}
              </span>
              {percent !== null && (
                <span className="tnum text-caption text-ink-muted">（{percent}%）</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
