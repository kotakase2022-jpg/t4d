'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Columns3 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { colsParamFor, type ColumnImportance } from '@/lib/table/columns';

export interface ColumnMenuColumn {
  key: string;
  header: string;
  importance: ColumnImportance;
  lockVisible?: boolean;
}

/**
 * 「列 ▾」（plan §1.12-2・§3.2）。チェックを外した列は URL の cols から除かれ、サーバー側で描画されない。
 * 既定（cols なし）は importance が primary・secondary の列。detail の列はここから出す。
 * 外せない列は「（常に表示）」として無効のまま見せる。
 */
export function ColumnMenu({
  columns,
  visible,
}: {
  columns: readonly ColumnMenuColumn[];
  /** いま表示している列（サーバーが URL から決めたもの） */
  visible: readonly string[];
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const visibleSet = new Set(visible);
  const hiddenCount = columns.filter((c) => !visibleSet.has(c.key)).length;

  const hrefFor = (next: ReadonlySet<string>) => {
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    const cols = colsParamFor(columns, next);
    if (cols === null) params.delete('cols');
    else params.set('cols', cols);
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  };

  const toggle = (key: string) => {
    const next = new Set(visibleSet);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    // 最低 1 列は残す（全部消すと何も読めなくなる）
    if ([...next].length === 0) return;
    router.push(hrefFor(next), { scroll: false });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="inline-flex items-center gap-1 rounded-t4d border border-line px-2 py-1 text-small text-ink hover:bg-brand-50"
        aria-label="列表示の切替"
        data-t4d-column-selector
      >
        <Columns3 className="size-3.5 text-ink-muted" aria-hidden="true" />列
        {hiddenCount > 0 ? `（${hiddenCount} 列非表示）` : ''}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        <DropdownMenuLabel>表示する列</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {columns.map((column) => {
          const locked = Boolean(column.lockVisible);
          return (
            <DropdownMenuCheckboxItem
              key={column.key}
              checked={locked || visibleSet.has(column.key)}
              disabled={locked}
              onSelect={(event) => {
                // メニューを閉じずに複数列を切り替えられるようにする
                event.preventDefault();
                if (!locked) toggle(column.key);
              }}
            >
              {column.header}
              {locked ? '（常に表示）' : column.importance === 'detail' ? '（詳細）' : ''}
            </DropdownMenuCheckboxItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            const params = new URLSearchParams(searchParams?.toString() ?? '');
            params.delete('cols');
            const query = params.toString();
            router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
          }}
        >
          既定の列に戻す
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
