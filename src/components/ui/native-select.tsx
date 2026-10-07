import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * ネイティブの選択（plan §3.1 NativeSelect）。Server Action のフォームを JS なしで送れるよう、
 * Radix の Select ではなく <select> を使う（素の select 100 か所の見た目をそろえる先）。
 * フォーカスリングは globals.css の :focus-visible をそのまま使う（消さない）。
 */
export const NATIVE_SELECT_SIZE = {
  xs: 'h-6 text-small',
  sm: 'h-7 text-body',
  md: 'h-8 text-body',
} as const;

export const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> & {
    size?: keyof typeof NATIVE_SELECT_SIZE;
    invalid?: boolean;
  }
>(function NativeSelect({ className, size = 'sm', invalid, ...props }, ref) {
  return (
    <select
      ref={ref}
      aria-invalid={invalid || props['aria-invalid'] || undefined}
      className={cn(
        'w-full rounded-t4d border border-line bg-surface px-2 text-ink',
        'focus-visible:border-brand-500',
        'disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-muted',
        'aria-[invalid=true]:border-danger',
        NATIVE_SELECT_SIZE[size],
        className,
      )}
      {...props}
    />
  );
});
