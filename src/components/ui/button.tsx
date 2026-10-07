'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * ボタン（plan §3.1・§1.6 One Screen, One Primary）。
 *
 * - 既定は secondary。primary は「その画面の仕事」1 つにだけ付ける（画面ごとに明示する）
 * - variant と size を常に DOM（data-variant・data-size）へ出す: E2E の primary 監査
 *   （tests/e2e/primary-action-audit.spec.ts）が「見えている primary は 1 画面に 1 つ以下」を数える
 * - secondary は枠付き（旧 outline）、quiet は選択中のトグルなどの淡い塗り（旧 secondary）
 * - danger は破壊的な操作の確定（確認ダイアログの中）にだけ使う
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-t4d text-body font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-brand-700 text-white hover:bg-brand-800 active:bg-brand-900',
        secondary:
          'border border-line bg-surface text-ink hover:bg-brand-50 hover:border-brand-300',
        quiet: 'bg-brand-100 text-brand-900 hover:bg-brand-200',
        ghost: 'text-ink hover:bg-brand-50',
        danger: 'bg-danger text-white hover:brightness-95',
        link: 'text-brand-700 underline-offset-2 hover:underline',
      },
      size: {
        xs: 'h-6 px-2 text-small [&_svg]:size-3',
        sm: 'h-7 px-2.5 [&_svg]:size-3.5',
        md: 'h-8 px-3 [&_svg]:size-4',
        /** 非推奨（Stage C で md へ寄せる） */
        lg: 'h-9 px-4 [&_svg]:size-4',
        /** 非推奨（IconButton を使う。Stage C で置き換える） */
        icon: 'h-7 w-7 [&_svg]:size-4',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'sm' },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>['size']>;

export const BUTTON_VARIANTS: readonly ButtonVariant[] = [
  'primary',
  'secondary',
  'quiet',
  'ghost',
  'danger',
  'link',
];

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, type, ...props },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  const resolvedVariant: ButtonVariant = variant ?? 'secondary';
  const resolvedSize: ButtonSize = size ?? 'sm';
  return (
    <Comp
      ref={ref}
      className={cn(buttonVariants({ variant: resolvedVariant, size: resolvedSize }), className)}
      type={asChild ? undefined : (type ?? 'button')}
      data-variant={resolvedVariant}
      data-size={resolvedSize}
      {...props}
    />
  );
});

export { buttonVariants };
