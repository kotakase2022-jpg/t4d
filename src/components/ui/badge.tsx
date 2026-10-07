import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-t4d border px-1.5 py-0.5 text-caption font-medium leading-4 whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'border-line bg-surface-muted text-ink-muted',
        brand: 'border-brand-200 bg-brand-100 text-brand-900',
        success: 'border-success/30 bg-success-soft text-success',
        warning: 'border-warning/40 bg-warning-soft text-warning-ink',
        danger: 'border-danger/30 bg-danger-soft text-danger',
        outline: 'border-line bg-surface text-ink',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

// ref を受ける: Hint（Radix Tooltip の asChild）で包んだときに位置を取れるようにする
export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, tone, ...props },
  ref,
) {
  return <span ref={ref} className={cn(badgeVariants({ tone }), className)} {...props} />;
});

export { badgeVariants };
