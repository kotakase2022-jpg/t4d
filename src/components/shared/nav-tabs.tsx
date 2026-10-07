import * as React from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * URL で切り替えるタブと絞り込み（plan §3.1 NavTabs・SegmentedFilter）。
 * タブ 2 種・チップ 7 種（IC §4.8）を 2 つの部品へ寄せる。
 *
 * - 状態は URL（?tab=・?filter=）に持つ: 共有でき、戻るで戻り、JS 無しで動く（Server Component から使える）
 * - タブは aria-current="page"、絞り込みは aria-current="true"（どちらもリンク）
 * - 件数・要対応は文字で併記する（「原稿 要対応 3」。色だけにしない）
 */
export interface NavTabItem {
  key: string;
  label: string;
  href: string;
  count?: number;
  /** 要対応がある（件数の前に「要対応」の語を付ける） */
  attention?: boolean;
  /** 権限が無いなど、出さないタブ */
  hidden?: boolean;
}

function Count({ count, attention }: { count?: number; attention?: boolean }) {
  if (count === undefined) return null;
  return (
    <span
      className={cn(
        'tnum ml-1 rounded-t4d px-1 text-caption',
        attention ? 'bg-warning-soft text-warning-ink' : 'bg-surface-muted text-ink-muted',
      )}
    >
      {attention ? `要対応 ${count}` : count}
    </span>
  );
}

export function NavTabs({
  ariaLabel,
  items,
  current,
  className,
}: {
  ariaLabel: string;
  items: readonly NavTabItem[];
  current: string;
  className?: string;
}) {
  return (
    <nav aria-label={ariaLabel} className={cn('border-b border-line bg-surface px-4', className)}>
      <ul className="flex flex-wrap items-center gap-0.5">
        {items
          .filter((item) => !item.hidden)
          .map((item) => {
            const active = item.key === current;
            return (
              <li key={item.key}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  data-tab-key={item.key}
                  className={cn(
                    '-mb-px inline-flex items-center border-b-2 px-2.5 py-1.5 text-body transition-colors',
                    active
                      ? 'border-brand-700 font-medium text-brand-800'
                      : 'border-transparent text-ink-muted hover:text-ink',
                  )}
                >
                  {item.label}
                  <Count count={item.count} attention={item.attention} />
                </Link>
              </li>
            );
          })}
      </ul>
    </nav>
  );
}

/** 一覧の上の絞り込み（すべて／自分の担当／差戻し など。件数付き） */
export function SegmentedFilter({
  ariaLabel,
  items,
  current,
  className,
}: {
  ariaLabel: string;
  items: readonly NavTabItem[];
  current: string;
  className?: string;
}) {
  return (
    <nav aria-label={ariaLabel} className={className}>
      <ul className="inline-flex flex-wrap items-center gap-1">
        {items
          .filter((item) => !item.hidden)
          .map((item) => {
            const active = item.key === current;
            return (
              <li key={item.key}>
                <Link
                  href={item.href}
                  aria-current={active ? 'true' : undefined}
                  data-filter-key={item.key}
                  className={cn(
                    'inline-flex items-center rounded-t4d border px-2 py-0.5 text-small transition-colors',
                    active
                      ? 'border-brand-500 bg-brand-100 font-medium text-brand-900'
                      : 'border-line bg-surface text-ink-muted hover:border-brand-300 hover:text-ink',
                  )}
                >
                  {item.label}
                  <Count count={item.count} attention={item.attention} />
                </Link>
              </li>
            );
          })}
      </ul>
    </nav>
  );
}
