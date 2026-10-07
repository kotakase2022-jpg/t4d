import * as React from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { RequirementTag } from './field';

/**
 * フォームの節（plan §1.13・§3.2 FormSection）。巨大なフォームを 1 画面に並べない（指示書 §12）。
 *
 * - kind="required": 必須の項目の節。常に開いている（fieldset＋legend）。フォームの先頭に置く
 * - kind="optional": 任意の項目の節。既定で閉じる（<details>。JS なしで開閉）。値が入っているとき・
 *   入力エラーが中を指すときは呼び出し側が open を渡して開いて描く
 * 閉じた節の中の入力も送信される（details は表示を隠すだけで、フォームの一部のまま）
 */
export function FormSection({
  title,
  kind,
  description,
  open,
  className,
  children,
}: {
  title: string;
  kind: 'required' | 'optional';
  description?: React.ReactNode;
  /** optional を開いて描く（値がある・エラーがある） */
  open?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  if (kind === 'required') {
    return (
      <fieldset className={cn('space-y-2', className)} data-form-section="required">
        <legend className="mb-1 flex items-center gap-1.5 text-body font-semibold text-ink">
          {title}
          <RequirementTag required />
        </legend>
        {description && <p className="text-caption text-ink-muted">{description}</p>}
        {children}
      </fieldset>
    );
  }
  return (
    <details
      open={open}
      data-form-section="optional"
      data-collapsible=""
      className={cn('rounded-t4d border border-line', className)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-t4d px-2 py-1.5 text-body font-semibold text-ink hover:bg-brand-50 focus-visible:outline-offset-[-2px] [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 shrink-0 text-ink-muted transition-transform [details[open]>summary_&]:rotate-90"
        />
        <span data-collapsible-summary="">{title}</span>
        <RequirementTag required={false} />
      </summary>
      <div className="space-y-2 border-t border-line px-2 py-2">
        {description && <p className="text-caption text-ink-muted">{description}</p>}
        {children}
      </div>
    </details>
  );
}
