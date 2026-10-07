import * as React from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { StatusSemantic } from '@/lib/ui/status/registry';
import { cn } from '@/lib/utils';
import { StatusIcon } from './status-badge';

/**
 * 注意の帯（plan §1.14 Attention・§3.1 AttentionStrip）。放置すると問題になる事実だけを 1 行で並べ、
 * 押すと絞り込んだ一覧へ移る。0 件の項目は出さない（注意が無いことを読ませない）。
 * 1 件も無ければ何も描かない。
 */
export interface AttentionItem {
  key: string;
  /** 何が起きているか（例「差し戻されたデータ」） */
  label: string;
  count: number;
  href: string;
  semantic: StatusSemantic;
}

export function AttentionStrip({
  items,
  label = '要対応',
  className,
}: {
  items: readonly AttentionItem[];
  /** 帯の名前（読み上げの領域名） */
  label?: string;
  className?: string;
}) {
  const shown = items.filter((item) => item.count > 0);
  if (shown.length === 0) return null;
  return (
    <section
      aria-label={label}
      data-attention-strip=""
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-t4d border border-warning/40 bg-warning-soft px-3 py-1.5',
        className,
      )}
    >
      <span className="text-small font-semibold text-ink">{label}</span>
      <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {shown.map((item) => (
          <li key={item.key}>
            <Link
              href={item.href}
              data-attention-key={item.key}
              className="inline-flex items-center gap-1 text-small text-ink hover:underline"
            >
              <StatusIcon semantic={item.semantic} className="size-3.5" />
              {item.label}
              <span className="tnum font-semibold">{item.count.toLocaleString('ja-JP')} 件</span>
              <ArrowRight className="size-3 text-ink-muted" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
