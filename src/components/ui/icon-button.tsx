'use client';

import * as React from 'react';
import { Hint } from './tooltip';
import { Button, type ButtonProps } from './button';
import { cn } from '@/lib/utils';

/**
 * アイコンだけのボタン（plan §3.1）。`label` は必須で、aria-label とツールチップ（Hint）の両方に出す
 * （CLAUDE.md §2: icon-only のボタンには aria-label を必ず付ける。意味をアイコンだけで伝えない）。
 *
 * 「編集」「削除」のような業務の操作には使わない（文字付きのボタンか行の操作メニューにする）。
 * 閉じる・折りたたむ・ヘルプのような、画面の部品の操作に使う。
 */
export interface IconButtonProps extends Omit<
  ButtonProps,
  'children' | 'variant' | 'size' | 'asChild'
> {
  /** ボタンの名前（必須。読み上げとツールチップに出る） */
  label: string;
  icon: React.ReactNode;
  variant?: 'ghost' | 'secondary' | 'danger';
  size?: 'xs' | 'sm';
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = 'ghost', size = 'sm', className, ...props },
  ref,
) {
  return (
    <Hint label={label}>
      <Button
        ref={ref}
        variant={variant}
        size={size}
        aria-label={label}
        className={cn('px-0', size === 'xs' ? 'w-6' : 'w-7', className)}
        {...props}
      >
        {icon}
      </Button>
    </Hint>
  );
});
