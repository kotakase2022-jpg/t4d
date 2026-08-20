import * as React from 'react';
import { cn } from '@/lib/utils';

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, type = 'text', ...props }, ref) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        'h-7 w-full rounded-t4d border border-line bg-surface px-2 text-[13px] text-ink',
        'placeholder:text-ink-muted/70',
        'focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-100',
        'disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-muted',
        'aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger-soft',
        className,
      )}
      {...props}
    />
  );
});

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, rows = 4, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(
        'w-full rounded-t4d border border-line bg-surface px-2 py-1.5 text-[13px] text-ink',
        'placeholder:text-ink-muted/70',
        'focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-100',
        'disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-muted',
        className,
      )}
      {...props}
    />
  );
});
