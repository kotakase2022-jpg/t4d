import * as React from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * 既定で閉じる折りたたみ（docs/disclosure-first.md §10.4）。説明文・注記・算定方法・補助表などの文字量を減らす。
 *
 * - ネイティブの <details>／<summary>。JavaScript なしで開閉でき、Server Component から使える
 * - summary は 1 行で、要点の数値を含める（閉じたままでも何が入っているか分かるように）
 * - summary にリンク・ボタン・見出し・入力を置かない（summary 自体が操作の対象。中の操作が届かなくなる）
 * - 開閉は保存しない。URL の絞込・フラッシュ・入力エラーが中身を指すときは呼び出し側が open を渡す
 *   （ハッシュは閉じた details を開かない）
 * - 誠実さ・安全の注記（架空・サンプル・デモ生成・未発効・権限なし・試算 など）とエラーは
 *   この中に入れない（少なくとも 1 行は外に見せる）
 *
 * 開閉の印（シェブロン・「開く／閉じる」）は `group-open:` ではなく任意バリアント
 * `[details[open]>summary_&]:` で切り替える: 入れ子の details で外側が開いているだけで
 * 内側の印まで「閉じる」にならないよう、自分の summary の直上の details だけを見る。
 * フォーカスリングは globals.css の :focus-visible をそのまま使う（消さない）。
 */

export type CollapsibleVariant = 'card' | 'plain';

/** summary の既定の三角（▶）を消すクラス（Chrome・Safari・Firefox） */
const SUMMARY_RESET = 'list-none [&::-webkit-details-marker]:hidden';

export interface CollapsibleProps {
  /** 閉じたときに見える 1 行。要点の数値を含める（リンク・ボタン・見出し・入力を入れない） */
  summary: React.ReactNode;
  /** summary の右に添える補足（件数など） */
  meta?: React.ReactNode;
  /** 最初に開いておくか（既定 false） */
  defaultOpen?: boolean;
  /** 開いて描く（URL の絞込・フラッシュ・入力エラーが中身を指すとき）。defaultOpen より優先 */
  open?: boolean;
  /** details の id（ページ内リンクの行き先） */
  id?: string;
  /** card: 枠付きの箱。plain: 枠なしの小さな行（本文の途中・表の下など） */
  variant?: CollapsibleVariant;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}

/** 開閉の印（シェブロンと「開く／閉じる」）。自分の summary の直上の details の開閉だけを見る */
function DisclosureMarker({ placement }: { placement: 'chevron' | 'text' }) {
  if (placement === 'chevron') {
    return (
      <ChevronRight
        aria-hidden="true"
        className="size-3.5 shrink-0 text-ink-muted transition-transform [details[open]>summary_&]:rotate-90"
      />
    );
  }
  return (
    <span className="shrink-0 text-[11px] font-normal text-ink-muted">
      <span className="[details[open]>summary_&]:hidden">開く</span>
      <span className="hidden [details[open]>summary_&]:inline">閉じる</span>
    </span>
  );
}

export function Collapsible({
  summary,
  meta,
  defaultOpen = false,
  open,
  id,
  variant = 'card',
  className,
  bodyClassName,
  children,
}: CollapsibleProps) {
  const card = variant === 'card';
  return (
    <details
      id={id}
      open={open ?? defaultOpen}
      data-collapsible=""
      className={cn(
        card && 'rounded-t4d-lg border border-line bg-surface',
        !card && 'min-w-0',
        className,
      )}
    >
      <summary
        className={cn(
          SUMMARY_RESET,
          'flex cursor-pointer items-center gap-1.5 rounded-t4d',
          card
            ? 'px-3 py-2 text-[13px] font-semibold text-ink hover:bg-brand-50'
            : 'py-1 text-[12px] text-ink-muted hover:text-ink',
        )}
      >
        <DisclosureMarker placement="chevron" />
        <span data-collapsible-summary="" className="min-w-0 flex-1">
          {summary}
        </span>
        {meta !== undefined && meta !== null && (
          <span className="shrink-0 text-[12px] font-normal text-ink-muted">{meta}</span>
        )}
        <DisclosureMarker placement="text" />
      </summary>
      <div
        className={cn(
          card ? 'border-t border-line px-3 py-2.5' : 'pt-1 pb-1 pl-5',
          'text-[12px] text-ink',
          bodyClassName,
        )}
      >
        {children}
      </div>
    </details>
  );
}

export interface CollapsibleSectionProps {
  /** section の id。見出しの id は `${id}-title` */
  id: string;
  /** h2。details の外に置き、閉じていても見える（getByRole('heading') が通る） */
  title: React.ReactNode;
  /** 折りたたみの 1 行（要点の数値を含める） */
  summary: React.ReactNode;
  /** 見出しの右に置く主操作（details の外。閉じていても押せる） */
  actions?: React.ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}

/**
 * 見出しと主操作は常に見せ、中身だけを折りたたむ節。`<section aria-labelledby>` で
 * 見出しの名前が付いた領域になる（getByRole('region', { name: title })）
 */
export function CollapsibleSection({
  id,
  title,
  summary,
  actions,
  defaultOpen = false,
  open,
  className,
  bodyClassName,
  children,
}: CollapsibleSectionProps) {
  const titleId = `${id}-title`;
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      className={cn('rounded-t4d-lg border border-line bg-surface', className)}
    >
      <div className="flex items-center justify-between gap-2 px-3 pt-2">
        <h2 id={titleId} className="text-[13px] font-semibold text-ink">
          {title}
        </h2>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      <Collapsible
        variant="plain"
        summary={summary}
        defaultOpen={defaultOpen}
        open={open}
        className="px-3 pb-2"
        bodyClassName={bodyClassName}
      >
        {children}
      </Collapsible>
    </section>
  );
}
