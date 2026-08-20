'use client';

import { HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

const SHORTCUTS: Array<{ keys: string; description: string }> = [
  { keys: 'Ctrl / Cmd + K', description: 'コマンドパレットを開く' },
  { keys: '/', description: '一覧の検索ボックスへフォーカス' },
  { keys: 'j / k', description: '一覧の次 / 前のレコードへ移動' },
  { keys: 'e', description: 'Evidence セクションへ移動' },
  { keys: 'c', description: 'コメント入力へフォーカス' },
  { keys: 's', description: '下書きを保存（提出・承認には割り当てていません）' },
  { keys: 'Esc', description: 'Drawer / ダイアログを閉じる' },
];

export function HelpDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="ヘルプとキーボードショートカット">
          <HelpCircle aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>キーボードショートカット</DialogTitle>
          <DialogDescription>
            連続レビューを高速化するための共通操作です。入力欄にフォーカスがある間は無効になります。
          </DialogDescription>
        </DialogHeader>
        <div className="p-4">
          <dl className="divide-y divide-line">
            {SHORTCUTS.map((s) => (
              <div key={s.keys} className="flex items-center justify-between gap-4 py-1.5">
                <dt className="text-[13px] text-ink">{s.description}</dt>
                <dd>
                  <kbd className="rounded border border-line bg-surface-muted px-1.5 py-0.5 text-[11px] text-ink-muted">
                    {s.keys}
                  </kbd>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </DialogContent>
    </Dialog>
  );
}
