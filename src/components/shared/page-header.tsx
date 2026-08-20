import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface Crumb {
  label: string;
  href?: string;
}

export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  breadcrumbs?: Crumb[];
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('border-b border-line bg-surface px-4 py-2.5', className)}>
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="パンくず" className="mb-1">
          <ol className="flex flex-wrap items-center gap-1 text-[11px] text-ink-muted">
            {breadcrumbs.map((crumb, index) => (
              <li key={`${crumb.label}-${index}`} className="flex items-center gap-1">
                {index > 0 && <ChevronRight className="size-3" aria-hidden="true" />}
                {crumb.href ? (
                  <Link href={crumb.href} className="hover:text-brand-700 hover:underline">
                    {crumb.label}
                  </Link>
                ) : (
                  <span aria-current="page">{crumb.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-semibold text-ink">{title}</h1>
          {description && <div className="mt-0.5 text-[12px] text-ink-muted">{description}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
    </div>
  );
}

/** KPI カード（クリックで対象一覧へ Filter 付き遷移する前提）。 */
export function KpiCard({
  label,
  value,
  suffix,
  href,
  tone = 'neutral',
  hint,
}: {
  label: string;
  value: string | number;
  suffix?: string;
  href: string;
  tone?: 'neutral' | 'brand' | 'warning' | 'danger' | 'success';
  hint?: string;
}) {
  const toneClass =
    tone === 'danger'
      ? 'text-danger'
      : tone === 'warning'
        ? 'text-[#8a5d00]'
        : tone === 'success'
          ? 'text-success'
          : tone === 'brand'
            ? 'text-brand-800'
            : 'text-ink';

  return (
    <Link
      href={href}
      className="group flex min-w-0 flex-col justify-between rounded-t4d-lg border border-line bg-surface px-3 py-2 transition-colors hover:border-brand-300 hover:bg-brand-50"
    >
      <span className="truncate text-[11px] font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </span>
      <span className={cn('mt-1 flex items-baseline gap-1', toneClass)}>
        <span className="tnum text-[22px] font-semibold leading-7">{value}</span>
        {suffix && <span className="text-[12px] text-ink-muted">{suffix}</span>}
      </span>
      {hint && <span className="mt-0.5 truncate text-[11px] text-ink-muted">{hint}</span>}
    </Link>
  );
}

/** セクション見出し（一覧やパネルの上部）。 */
export function SectionTitle({
  title,
  action,
  className,
}: {
  title: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-2 px-3 py-2', className)}>
      <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
      {action}
    </div>
  );
}
