import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * 区分の格子（例: Scope3 の 15 カテゴリ。docs/disclosure-first.md §10.4）。
 * 状態は文字＋アイコンで書き（色だけで示さない）、値のある区分は塗り、無い区分は破線の枠にする。
 * 値の無い区分に「0」を書かない（呼び出し側は value を渡さない）。
 */

export interface CategoryGridItem {
  key: string;
  /** 区分の名前（例「Cat.1 購入した製品・サービス」） */
  label: string;
  /** 状態の文字（例「算定済み」「未算定」） */
  stateLabel: string;
  icon: LucideIcon;
  /** 値・データがある区分か（塗りと枠の形を変える。意味は stateLabel が伝える） */
  filled: boolean;
  /** 書式済みの値（例「12,345.6 t-CO2e」）。無い区分は渡さない */
  value?: string;
  href?: string;
}

const COLUMN_CLASSES: Record<number, string> = {
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
  5: 'grid-cols-5',
  6: 'grid-cols-6',
};

export function CategoryGrid({
  label,
  items,
  columns = 5,
  className,
}: {
  /** 格子のリストの名前（getByRole('list', { name: label })） */
  label: string;
  items: readonly CategoryGridItem[];
  /** 列の数（2〜6。既定 5） */
  columns?: number;
  className?: string;
}) {
  return (
    <ul
      aria-label={label}
      className={cn('grid gap-1.5', COLUMN_CLASSES[columns] ?? 'grid-cols-5', className)}
    >
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <li
            key={item.key}
            data-filled={item.filled ? 'true' : 'false'}
            className={cn(
              'min-w-0 rounded-t4d px-2 py-1.5 text-[11px]',
              item.filled
                ? 'border border-brand-300 bg-brand-50'
                : 'border border-dashed border-ink-muted bg-surface',
            )}
          >
            <div className="truncate font-medium text-ink" title={item.label}>
              {item.href ? (
                <Link href={item.href} className="text-brand-700 hover:underline">
                  {item.label}
                </Link>
              ) : (
                item.label
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-ink-muted">
              <Icon aria-hidden="true" className="size-3.5 shrink-0" />
              <span>{item.stateLabel}</span>
            </div>
            {item.value !== undefined && (
              <div className="tnum mt-0.5 font-medium text-ink">{item.value}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
