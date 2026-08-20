'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Search, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterGroup {
  /** URL クエリのキー */
  key: string;
  label: string;
  options: FilterOption[];
  multiple?: boolean;
}

/**
 * 一覧共通のフィルター（指示書 UX-P0-004）。
 * 状態は URL クエリに持つ（URL State 方針・共有可能・戻る操作に強い）。
 */
export function FilterBar({
  groups,
  searchPlaceholder = '指標名・組織名で検索',
  total,
  savedViews,
}: {
  groups: FilterGroup[];
  searchPlaceholder?: string;
  total: number;
  savedViews?: Array<{ label: string; query: string; description?: string }>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [search, setSearch] = React.useState(searchParams.get('q') ?? '');

  React.useEffect(() => {
    setSearch(searchParams.get('q') ?? '');
  }, [searchParams]);

  // 検索は Debounce（指示書 21 章）
  React.useEffect(() => {
    const current = searchParams.get('q') ?? '';
    if (search === current) return;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (search) params.set('q', search);
      else params.delete('q');
      params.delete('page');
      router.replace(`${pathname}?${params.toString()}`);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search, searchParams, pathname, router]);

  const toggle = (key: string, value: string, multiple: boolean) => {
    const params = new URLSearchParams(searchParams.toString());
    const current = params.getAll(key);
    params.delete(key);
    if (multiple) {
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      for (const v of next) params.append(key, v);
    } else if (!current.includes(value)) {
      params.set(key, value);
    }
    params.delete('page');
    router.replace(`${pathname}?${params.toString()}`);
  };

  const activeCount = groups.reduce((sum, g) => sum + searchParams.getAll(g.key).length, 0);
  const hasFilters = activeCount > 0 || Boolean(searchParams.get('q'));

  return (
    <div className="flex flex-col gap-1.5 border-b border-line bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-[280px]">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted"
            aria-hidden="true"
          />
          <Input
            data-t4d-list-search
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`${searchPlaceholder}（/ でフォーカス）`}
            aria-label="一覧内検索"
            className="pl-7"
          />
        </div>

        {groups.map((group) => (
          <div key={group.key} className="flex items-center gap-1">
            <span className="text-[11px] text-ink-muted">{group.label}</span>
            <div className="flex flex-wrap gap-1">
              {group.options.map((option) => {
                const active = searchParams.getAll(group.key).includes(option.value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggle(group.key, option.value, group.multiple ?? true)}
                    className={cn(
                      'rounded-t4d border px-1.5 py-0.5 text-[11px] transition-colors',
                      active
                        ? 'border-brand-500 bg-brand-100 font-medium text-brand-900'
                        : 'border-line bg-surface text-ink-muted hover:border-brand-300 hover:text-ink',
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        <div className="ml-auto flex items-center gap-2">
          <span className="text-[12px] text-ink-muted">{total.toLocaleString('ja-JP')} 件</span>
          {hasFilters && (
            <Button variant="ghost" size="xs" asChild>
              <Link href={pathname}>
                <X aria-hidden="true" />
                絞り込み解除
              </Link>
            </Button>
          )}
        </div>
      </div>

      {savedViews && savedViews.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-ink-muted">保存ビュー</span>
          {savedViews.map((view) => (
            <Link
              key={view.label}
              href={`${pathname}?${view.query}`}
              title={view.description}
              className="rounded-t4d border border-line bg-surface-muted px-1.5 py-0.5 text-[11px] text-ink-muted hover:border-brand-300 hover:text-brand-800"
            >
              {view.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function ActiveFilterSummary({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 px-3 py-1.5">
      <span className="text-[11px] text-ink-muted">適用中:</span>
      {labels.map((label) => (
        <Badge key={label} tone="brand">
          {label}
        </Badge>
      ))}
    </div>
  );
}
