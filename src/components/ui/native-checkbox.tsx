import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * ネイティブのチェックボックス（plan §3.1 NativeCheckbox）。label を渡すと、押せる範囲を文字まで広げる。
 */
export const NativeCheckbox = React.forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> & { label?: React.ReactNode }
>(function NativeCheckbox({ className, label, ...props }, ref) {
  const input = (
    <input
      ref={ref}
      type="checkbox"
      className={cn('size-3.5 shrink-0 accent-brand-700', !label && className)}
      {...props}
    />
  );
  if (!label) return input;
  return (
    <label className={cn('inline-flex items-center gap-1.5 text-small text-ink', className)}>
      {input}
      {label}
    </label>
  );
});
