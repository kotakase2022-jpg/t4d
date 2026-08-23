'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3 } from 'lucide-react';
import {
  DropdownMenuCheckboxItem,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * 一覧共通の「並べ替え」と「列表示切替」（機能要件 UX-P0-004）。
 *
 * 状態は URL クエリに持つ（FilterBar と同じ URL State 方針。共有・戻る操作に強い）。
 *  - 並べ替え: `?sort=<key>&dir=asc|desc`
 *  - 列表示  : `?cols=a,b,c`（未指定なら既定の列セット）
 *
 * 並べ替えは**サーバー側**で行う。ページ内だけを並べ替えると
 * 「全体の並び順」と食い違うため、リンク遷移でサーバーへ渡す。
 */

export interface SortableColumn {
  key: string;
  label: string;
}

/** ヘッダーセル内に置く並べ替えリンク。 */
export function SortLink({ column, label }: { column: string; label: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const activeKey = searchParams.get('sort');
  const activeDir = searchParams.get('dir') === 'desc' ? 'desc' : 'asc';
  const isActive = activeKey === column;
  const nextDir = isActive && activeDir === 'asc' ? 'desc' : 'asc';

  const params = new URLSearchParams(searchParams.toString());
  params.set('sort', column);
  params.set('dir', nextDir);
  // 並べ替えたら 1 ページ目へ戻す
  params.delete('page');

  const Icon = !isActive ? ArrowUpDown : activeDir === 'asc' ? ArrowUp : ArrowDown;

  return (
    <Link
      href={`${pathname}?${params.toString()}`}
      className={cn(
        'inline-flex items-center gap-1 rounded-[4px] px-1 py-0.5 hover:bg-brand-50',
        isActive && 'text-brand-800',
      )}
      aria-label={`${label}で並べ替え（${nextDir === 'asc' ? '昇順' : '降順'}）`}
    >
      {label}
      <Icon className="size-3 text-ink-muted" aria-hidden="true" />
    </Link>
  );
}

/**
 * 列表示切替。
 *
 * チェックを外した列は URL の `cols` から除かれ、サーバー側で描画されなくなる。
 * 既定（未指定）ではすべて表示する。
 */
export function ColumnSelector({
  columns,
  alwaysVisible = [],
}: {
  columns: SortableColumn[];
  alwaysVisible?: string[];
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();

  const raw = searchParams.get('cols');
  const visible = raw
    ? new Set(raw.split(',').filter(Boolean))
    : new Set(columns.map((c) => c.key));

  const hrefFor = (key: string): string => {
    const next = new Set(visible);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    // 最低 1 列は残す（全部消すと何も読めなくなる）
    if (next.size === 0) next.add(key);

    const params = new URLSearchParams(searchParams.toString());
    if (next.size === columns.length) params.delete('cols');
    else
      params.set(
        'cols',
        columns
          .map((c) => c.key)
          .filter((k) => next.has(k))
          .join(','),
      );
    return `${pathname}?${params.toString()}`;
  };

  const hiddenCount = columns.length - visible.size;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="inline-flex items-center gap-1 rounded-t4d border border-line px-2 py-1 text-[12px] text-ink hover:bg-brand-50"
        aria-label="列表示の切替"
        data-t4d-column-selector
      >
        <Columns3 className="size-3.5 text-ink-muted" aria-hidden="true" />列
        {hiddenCount > 0 ? `（${hiddenCount} 列非表示）` : ''}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[200px]">
        <DropdownMenuLabel>表示する列</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {/*
          Radix のメニュー項目（DropdownMenuCheckboxItem）を使う。
          素の <Link> や <input> を並べると、矢印キーでの移動も Enter での決定も効かず、
          支援技術にはチェック状態が伝わらない。
        */}
        {columns.map((column) => {
          const locked = alwaysVisible.includes(column.key);
          const checked = visible.has(column.key);
          return (
            <DropdownMenuCheckboxItem
              key={column.key}
              checked={locked ? true : checked}
              disabled={locked}
              onSelect={(event) => {
                // メニューを閉じずに複数列を切り替えられるようにする
                event.preventDefault();
                if (!locked) router.push(hrefFor(column.key), { scroll: false });
              }}
            >
              {column.label}
              {locked ? '（常に表示）' : ''}
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
