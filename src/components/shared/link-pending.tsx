'use client';

import { useLinkStatus } from 'next/link';
import { Loader2 } from 'lucide-react';

/**
 * リンクを押してから次の画面が届くまでの「読込中」の表示（<Link> の中に置く）。
 *
 * 画面単位の loading.tsx は Next.js 15.5 の不具合（ソフト遷移が止まる。known-limitations S-11）の
 * ため置けない。タブ・目次のように同じ画面の中で切り替えるリンクでは、押しても前の画面のまま
 * 何も起きていないように見え、二度押しや古い内容への操作を招いていた。押したリンクの横にだけ
 * 回転アイコンと読み上げ用の「読込中」を出す（色だけで示さない）。
 */
export function LinkPending({ label = '読込中' }: { label?: string }) {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <span className="ml-1 inline-flex items-center align-middle text-ink-muted">
      <Loader2 className="size-3 animate-spin" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}
