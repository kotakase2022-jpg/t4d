'use client';

import * as React from 'react';
import { useFormStatus } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { Button } from './button';

/**
 * Server Action フォームの送信ボタン。
 *
 * 送信中であることを示さないと、
 *  - 押した手応えが無く、利用者は「効いていない」と思ってもう一度押す
 *  - AI 生成や一括取込のように数秒かかる処理では、二重送信が実害になる
 * ため、`useFormStatus` で pending を拾って無効化し、進行中だと分かる表示にする。
 *
 * 色だけで状態を表さない（回転アイコンとラベルの両方を変える）。
 */
export function SubmitButton({
  children,
  pendingLabel,
  icon,
  ...props
}: React.ComponentProps<typeof Button> & {
  /** 送信中に見せるラベル。省略時は元のラベルのまま */
  pendingLabel?: string;
  /** 通常時に見せるアイコン */
  icon?: React.ReactNode;
}) {
  const { pending } = useFormStatus();

  return (
    <Button {...props} type="submit" disabled={pending || props.disabled} aria-busy={pending}>
      {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : icon}
      {pending ? (pendingLabel ?? children) : children}
    </Button>
  );
}
