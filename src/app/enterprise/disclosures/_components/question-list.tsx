'use client';

import * as React from 'react';
import Link from 'next/link';
import { CircleCheck } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface QuestionListItem {
  id: string;
  code: string;
  text: string;
  href: string;
  /** 前年からの変化（新規・変更だけ印を付ける） */
  change: 'new' | 'changed' | null;
  approved: boolean;
}

/**
 * 回答画面の左の質問一覧（plan S6）。コード・質問文で絞り込める。
 *
 * - 行に data-t4d-record を付け、j/k で移動・Enter で開けるようにする（record-shortcuts）
 * - 新規・変更・承認済みは色だけでなく語とアイコンで示す
 * - 絞り込みは表示だけ（URL に載せない。質問は 1 枠組みで数十件までのため）
 */
export function QuestionList({
  items,
  currentId,
}: {
  items: readonly QuestionListItem[];
  currentId: string;
}) {
  const [query, setQuery] = React.useState('');
  const needle = query.trim().toLowerCase();
  const shown =
    needle === ''
      ? items
      : items.filter(
          (item) =>
            item.code.toLowerCase().includes(needle) || item.text.toLowerCase().includes(needle),
        );

  return (
    <div className="space-y-1.5">
      <Input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="コード・質問文で絞り込む"
        aria-label="質問を絞り込む"
        className="h-7 text-small"
      />
      {shown.length === 0 ? (
        <p className="px-1 py-2 text-caption text-ink-muted">一致する質問がありません。</p>
      ) : (
        <ul className="max-h-[calc(100vh-240px)] divide-y divide-line overflow-y-auto">
          {shown.map((item) => {
            const current = item.id === currentId;
            return (
              <li key={item.id} data-t4d-record="">
                <Link
                  href={item.href}
                  aria-current={current ? 'page' : undefined}
                  className={cn(
                    'block px-2 py-1.5 text-small transition-colors',
                    current
                      ? 'bg-brand-100 font-medium text-brand-900'
                      : 'text-ink hover:bg-brand-50',
                  )}
                >
                  <span className="flex items-center justify-between gap-1">
                    <span className="font-mono">{item.code}</span>
                    <span className="flex items-center gap-1 text-caption">
                      {item.change === 'new' && <span className="text-warning-ink">新規</span>}
                      {item.change === 'changed' && <span className="text-brand-700">変更</span>}
                      {item.approved && (
                        <span className="inline-flex items-center gap-0.5 text-success">
                          <CircleCheck className="size-3" aria-hidden="true" />
                          承認済み
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="block truncate text-caption text-ink-muted">{item.text}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
