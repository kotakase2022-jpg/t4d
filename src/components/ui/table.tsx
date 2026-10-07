import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * 表。見出しの行はスクロールしても上に残す（stickyHeader。既定 true。plan §1.12-1）。
 * 固定の規則は globals.css の `:where(table[data-sticky-header])`（詳細度 0。th に付けた背景などのクラスが勝つ）
 */
export function Table({
  className,
  stickyHeader = true,
  ...props
}: React.TableHTMLAttributes<HTMLTableElement> & { stickyHeader?: boolean }) {
  return (
    <table
      data-sticky-header={stickyHeader ? '' : undefined}
      className={cn('w-full text-body', className)}
      {...props}
    />
  );
}

export function THead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('', className)} {...props} />;
}

export function TBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('', className)} {...props} />;
}

export function TR({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        'border-b border-line last:border-b-0 hover:bg-brand-50/60 data-[selected=true]:bg-brand-50',
        className,
      )}
      {...props}
    />
  );
}

export function TH({
  className,
  align,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' | 'center' }) {
  return (
    <th
      scope="col"
      className={cn(
        'h-8 whitespace-nowrap border-b border-line px-2 text-caption font-semibold uppercase tracking-wide text-ink-muted',
        align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left',
        className,
      )}
      {...props}
    />
  );
}

export function TD({
  className,
  align,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' | 'center' }) {
  return (
    <td
      className={cn(
        'h-9 px-2 align-middle text-ink',
        align === 'right' ? 'text-right tnum' : align === 'center' ? 'text-center' : 'text-left',
        className,
      )}
      {...props}
    />
  );
}
