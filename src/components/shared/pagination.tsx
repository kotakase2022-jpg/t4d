import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * サーバーサイドページング（指示書 21 章「主要一覧は Server Pagination / 全件 Client Load を避ける」）。
 */
export function Pagination({
  page,
  pageSize,
  total,
  basePath,
  searchParams,
}: {
  page: number;
  pageSize: number;
  total: number;
  basePath: string;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  const href = (target: number) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams)) {
      if (key === 'page' || value === undefined) continue;
      if (Array.isArray(value)) for (const v of value) params.append(key, v);
      else params.set(key, value);
    }
    params.set('page', String(target));
    return `${basePath}?${params.toString()}`;
  };

  const linkClass = (disabled: boolean) =>
    cn(
      'inline-flex h-6 items-center gap-0.5 rounded-t4d border border-line px-1.5 text-[12px]',
      disabled
        ? 'pointer-events-none opacity-40'
        : 'text-ink hover:border-brand-300 hover:bg-brand-50',
    );

  return (
    <nav
      aria-label="ページ送り"
      className="flex items-center justify-between gap-3 border-t border-line bg-surface px-3 py-1.5"
    >
      <p className="text-[12px] text-ink-muted">
        {total.toLocaleString('ja-JP')} 件中 {from.toLocaleString('ja-JP')}–
        {to.toLocaleString('ja-JP')} 件を表示
      </p>
      <div className="flex items-center gap-1">
        <Link
          href={href(page - 1)}
          aria-disabled={page <= 1}
          tabIndex={page <= 1 ? -1 : undefined}
          className={linkClass(page <= 1)}
        >
          <ChevronLeft className="size-3.5" aria-hidden="true" />
          前へ
        </Link>
        <span className="tnum px-1 text-[12px] text-ink-muted">
          {page} / {totalPages}
        </span>
        <Link
          href={href(page + 1)}
          aria-disabled={page >= totalPages}
          tabIndex={page >= totalPages ? -1 : undefined}
          className={linkClass(page >= totalPages)}
        >
          次へ
          <ChevronRight className="size-3.5" aria-hidden="true" />
        </Link>
      </div>
    </nav>
  );
}
