import * as React from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * 作成フォームの置き場所（plan §1.13・§3.1 CreatePanel）。一覧の上に作成フォームを常設しない。
 *
 * - `?new=1`（openParam）のときだけ開いて描く。JS 不要（Server Component）。リロード・共有でも同じ表示
 * - 開く操作は見出しの primary（「… を登録」）のリンク。閉じる＝パラメータを外したリンク
 * - 入力エラーで戻ってきたとき（?error= と new=1 が一緒）も開いたまま描く（入力の場所を失わせない）
 * - 10 項目を超える作成は専用ページにする（ここに詰め込まない。§1.13-4）
 */
export type SearchParamsRecord = Record<string, string | string[] | undefined>;

/** 開いているか */
export function isCreatePanelOpen(searchParams: SearchParamsRecord, openParam = 'new'): boolean {
  const value = searchParams[openParam];
  return value === '1' || (Array.isArray(value) && value.includes('1'));
}

/** 今の URL の引数を保ったまま、作成パネルを開く／閉じるリンク */
export function createPanelHref(
  basePath: string,
  searchParams: SearchParamsRecord,
  { open, openParam = 'new' }: { open: boolean; openParam?: string },
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    // 開閉の引数と、結果・エラーの通知は引き継がない
    if (key === openParam || key === 'flash' || key === 'error' || value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) params.append(key, v);
    else params.set(key, value);
  }
  if (open) params.set(openParam, '1');
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

export function CreatePanel({
  id,
  title,
  openParam = 'new',
  searchParams,
  closeHref,
  description,
  className,
  children,
}: {
  id: string;
  title: string;
  openParam?: string;
  searchParams: SearchParamsRecord;
  /** 閉じるリンクの行き先（通常は createPanelHref(basePath, searchParams, { open: false })） */
  closeHref: string;
  description?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  if (!isCreatePanelOpen(searchParams, openParam)) return null;
  const titleId = `${id}-title`;
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      data-create-panel=""
      className={cn('rounded-t4d-lg border border-brand-200 bg-surface', className)}
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h2 id={titleId} className="text-body font-semibold text-ink">
          {title}
        </h2>
        <Link
          href={closeHref}
          scroll={false}
          className="inline-flex items-center gap-1 rounded-t4d px-1.5 py-0.5 text-small text-ink-muted hover:bg-brand-50 hover:text-ink"
        >
          <X className="size-3.5" aria-hidden="true" />
          閉じる
        </Link>
      </div>
      <div className="space-y-2 px-3 py-2.5">
        {description && <p className="text-small text-ink-muted">{description}</p>}
        {children}
      </div>
    </section>
  );
}
