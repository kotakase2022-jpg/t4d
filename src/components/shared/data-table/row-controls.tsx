'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * DataTable のクライアントの小さな部品（すべて選択・行の展開・表示件数）。
 */

/** 見出しの「すべて選択」。同じ表の行の選択（form= が同じもの）をまとめて切り替える */
export function SelectAllCheckbox({
  formId,
  name,
  label = 'このページの行をすべて選択',
}: {
  formId: string;
  name: string;
  label?: string;
}) {
  const ref = React.useRef<HTMLInputElement>(null);
  const [state, setState] = React.useState<'none' | 'some' | 'all'>('none');

  const boxes = React.useCallback(
    () =>
      [
        ...document.querySelectorAll<HTMLInputElement>(
          `input[type="checkbox"][data-t4d-select][form="${formId}"][name="${name}"]`,
        ),
      ].filter((box) => !box.disabled),
    [formId, name],
  );

  React.useEffect(() => {
    const update = () => {
      const all = boxes();
      const checked = all.filter((box) => box.checked).length;
      setState(checked === 0 ? 'none' : checked === all.length ? 'all' : 'some');
    };
    update();
    document.addEventListener('change', update);
    return () => document.removeEventListener('change', update);
  }, [boxes]);

  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);

  return (
    <NativeCheckbox
      ref={ref}
      aria-label={label}
      checked={state === 'all'}
      onChange={(event) => {
        const next = event.target.checked;
        for (const box of boxes()) {
          if (box.checked !== next) {
            box.checked = next;
            box.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      }}
    />
  );
}

/** 行の展開（理由・阻害条件などの詳細を次の行に出す）。開閉は保存しない */
export function ExpandToggle({
  controls,
  rowLabel,
  defaultOpen = false,
}: {
  /** 詳細の行の id */
  controls: string;
  rowLabel: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  React.useEffect(() => {
    const detail = document.getElementById(controls);
    if (detail) detail.hidden = !open;
  }, [controls, open]);
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      aria-label={`${rowLabel} の詳細を${open ? '閉じる' : '開く'}`}
      onClick={() => setOpen((v) => !v)}
      className="flex size-6 items-center justify-center rounded-t4d text-ink-muted hover:bg-brand-50 hover:text-ink"
    >
      {open ? (
        <ChevronDown className="size-3.5" aria-hidden="true" />
      ) : (
        <ChevronRight className="size-3.5" aria-hidden="true" />
      )}
    </button>
  );
}

/** 「表示件数 ▾」（plan D9。L2 に置く）。?size= を変え、1 ページ目へ戻す */
export function PageSizeMenu({ sizes, current }: { sizes: readonly number[]; current: number }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const hrefFor = (size: number) => {
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.set('size', String(size));
    params.delete('page');
    return `${pathname}?${params.toString()}`;
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" data-t4d-page-size="">
          表示件数 {current}
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>1 ページの件数</DropdownMenuLabel>
        {sizes.map((size) => (
          <DropdownMenuItem key={size} asChild>
            <Link
              href={hrefFor(size)}
              aria-current={size === current ? 'true' : undefined}
              className={cn(size === current && 'font-semibold')}
            >
              {size} 件
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
