'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ChevronDown, ListFilter, Search, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { ViewMenu } from './data-table/view-menu';

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
 * 一覧共通のフィルター（指示書 UX-P0-004・plan §1.12-4）。
 * 状態は URL クエリに持つ（URL State 方針・共有可能・戻る操作に強い）。
 *
 * - よく使う 2 群まではチップ（groups）、残りは「絞り込み ▾」（overflowGroups）へ（平置きの約 24 チップを減らす）
 * - userViews を渡すと、利用者の保存ビュー・既定ビュー（端末ごと）のメニューを出す
 */
export function FilterBar({
  groups,
  overflowGroups = [],
  searchPlaceholder = '指標名・組織名で検索',
  total,
  savedViews,
  userViews,
  extra,
}: {
  groups: FilterGroup[];
  /** 「絞り込み ▾」に入れる群（頻度の低い条件） */
  overflowGroups?: FilterGroup[];
  searchPlaceholder?: string;
  total: number;
  savedViews?: Array<{ label: string; query: string; description?: string }>;
  /** 利用者の保存ビュー（tableId は保存の鍵、basePath は既定ビューの索引） */
  userViews?: { tableId: string; basePath: string };
  /** 件数の右に置く表の操作（列 ▾ など） */
  extra?: React.ReactNode;
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

  const activeCount = [...groups, ...overflowGroups].reduce(
    (sum, g) => sum + searchParams.getAll(g.key).length,
    0,
  );
  const overflowActive = overflowGroups.reduce(
    (sum, g) => sum + searchParams.getAll(g.key).length,
    0,
  );
  const hasFilters = activeCount > 0 || Boolean(searchParams.get('q'));

  // 「絞り込み解除」は絞り込み（検索・チップ・絞り込み ▾）とページ・通知だけを外す。タブ（?tab=）・列（cols）・
  // 並べ替え・表示件数は保つ（DataTable の resetFiltersHref と同じ規則。タブの中の一覧で解除してもタブが変わらない）
  const filterKeys = [...groups, ...overflowGroups].map((g) => g.key);
  const filterKeysKey = filterKeys.join(',');
  const resetHref = React.useMemo(() => {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of ['q', 'page', 'flash', 'error', ...filterKeysKey.split(',')]) {
      params.delete(key);
    }
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  }, [filterKeysKey, pathname, searchParams]);

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
            <span className="text-caption text-ink-muted">{group.label}</span>
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
                      'rounded-t4d border px-1.5 py-0.5 text-caption transition-colors',
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

        {overflowGroups.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="xs" data-t4d-filter-overflow="">
                <ListFilter aria-hidden="true" />
                絞り込み{overflowActive > 0 ? `（${overflowActive} 件適用中）` : ''}
                <ChevronDown aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="max-h-[60vh] min-w-[240px] overflow-y-auto"
            >
              {overflowGroups.map((group, index) => (
                <React.Fragment key={group.key}>
                  {index > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
                  {group.options.map((option) => (
                    <DropdownMenuCheckboxItem
                      key={option.value}
                      checked={searchParams.getAll(group.key).includes(option.value)}
                      onSelect={(event) => {
                        // 複数の条件を続けて選べるよう、メニューを閉じない
                        event.preventDefault();
                        toggle(group.key, option.value, group.multiple ?? true);
                      }}
                    >
                      {option.label}
                    </DropdownMenuCheckboxItem>
                  ))}
                </React.Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <div className="ml-auto flex items-center gap-2">
          <span className="text-small text-ink-muted">{total.toLocaleString('ja-JP')} 件</span>
          {extra}
          {hasFilters && (
            <Button variant="ghost" size="xs" asChild>
              <Link href={resetHref}>
                <X aria-hidden="true" />
                絞り込み解除
              </Link>
            </Button>
          )}
        </div>
      </div>

      {userViews && (
        <ViewMenu tableId={userViews.tableId} basePath={userViews.basePath} userViews />
      )}

      {savedViews && savedViews.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-caption text-ink-muted">保存ビュー</span>
          {savedViews.map((view) => (
            <Link
              key={view.label}
              href={`${pathname}?${view.query}`}
              title={view.description}
              className="rounded-t4d border border-line bg-surface-muted px-1.5 py-0.5 text-caption text-ink-muted hover:border-brand-300 hover:text-brand-800"
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
      <span className="text-caption text-ink-muted">適用中:</span>
      {labels.map((label) => (
        <Badge key={label} tone="brand">
          {label}
        </Badge>
      ))}
    </div>
  );
}
