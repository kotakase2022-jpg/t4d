import * as React from 'react';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * 小さな「説明を開く」折りたたみ（docs/disclosure-first.md §10.4）。脚注・規則一覧・画面の説明用。
 *
 * - Info アイコン＋label（何の説明か。例「件数の数え方」）だけを見せ、本文は既定で閉じる
 * - ネイティブの <details>。Server Component から使え、開閉は保存しない
 * - 誠実さ・安全の注記（架空・未発効・試算・権限なし など）はここに入れない（Collapsible と同じ規則）
 * - フォーカスリングは globals.css の :focus-visible をそのまま使う
 */
export function MoreInfo({
  label,
  children,
  defaultOpen = false,
  className,
}: {
  /** 何の説明か（必須。「詳細」のような中身の分からない語にしない） */
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <details open={defaultOpen} data-collapsible="" className={cn('min-w-0', className)}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-t4d text-caption text-ink-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        <Info aria-hidden="true" className="size-3.5 shrink-0" />
        <span data-collapsible-summary="">{label}</span>
      </summary>
      <div className="mt-1 space-y-1 border-l-2 border-line pl-2 text-small leading-relaxed text-ink-muted">
        {children}
      </div>
    </details>
  );
}
