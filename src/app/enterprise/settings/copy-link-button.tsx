'use client';

import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * 招待リンクのコピー（plan S17: 招待 URL はコピーのボタン＋省略表示）。
 * 招待メールは送らない運用なので、管理者はリンクを社内チャット等で本人へ渡す。
 * 長い URL を選択してコピーさせず、1 回の操作で写せるようにする。
 *
 * クリップボードが使えない環境（権限・非 HTTPS）では、失敗を文字で伝える（リンクは画面に残っている）。
 */
export function CopyLinkButton({ path, label }: { path: string; label: string }) {
  const [state, setState] = React.useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${path}`);
      setState('copied');
    } catch {
      setState('failed');
    }
  };

  return (
    <span className="inline-flex items-center gap-1">
      <Button
        size="xs"
        variant="ghost"
        onClick={() => void copy()}
        aria-label={`${label} の招待リンクをコピー`}
      >
        {state === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {state === 'copied' ? 'コピーしました' : 'コピー'}
      </Button>
      {state === 'failed' && (
        <span role="status" className="text-caption text-danger">
          コピーできませんでした。リンクを選択してコピーしてください。
        </span>
      )}
    </span>
  );
}
