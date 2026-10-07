import Link from 'next/link';
import { MoreInfo } from '@/components/ui/more-info';
import { cn } from '@/lib/utils';
import { BreadcrumbList, NavBreadcrumbs, type Crumb } from './nav-breadcrumbs';

export type { Crumb };

/**
 * 画面の見出し。description は 1 行（40 字程度まで）にし、画面の使い方・数え方などの長い説明は
 * help に渡す（既定で閉じた「この画面について」。docs/disclosure-first.md §10.4）。
 * 誠実さ・安全の注記（架空・未発効・試算 など）は help に入れず、画面の本文に見せる。
 *
 * パンくず（plan §1.4）: `breadcrumbsTail`（または `autoBreadcrumbs`）を渡すと、描画中のメニューから経路を
 * 作り（NavBreadcrumbs）、末尾に対象名を足す。手書きの `breadcrumbs` は互換のため残す。どちらでも
 * aria-current は末尾の 1 つだけ（N-15）。
 * 操作（`actions`）には PageActions を渡す（primary 1・secondary ≤2・その他。plan §1.6）。
 */
export function PageHeader({
  title,
  description,
  context,
  help,
  breadcrumbs,
  breadcrumbsTail,
  autoBreadcrumbs = false,
  actions,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  /** h1 の下の 1 行（対象の識別: 案件コード・クライアント・期間など） */
  context?: React.ReactNode;
  /** 「この画面について」（既定で閉じる）の中身 */
  help?: React.ReactNode;
  /** 手書きのパンくず（互換） */
  breadcrumbs?: Crumb[];
  /** メニューから作るパンくずの末尾に足す項目（詳細画面の対象名など） */
  breadcrumbsTail?: Crumb[];
  /** メニューから作るパンくずを出す（末尾は画面名） */
  autoBreadcrumbs?: boolean;
  actions?: React.ReactNode;
  className?: string;
}) {
  const manual = breadcrumbs && breadcrumbs.length > 0;
  return (
    <div className={cn('border-b border-line bg-surface px-4 py-2.5', className)}>
      {manual ? (
        <BreadcrumbList crumbs={breadcrumbs} />
      ) : breadcrumbsTail || autoBreadcrumbs ? (
        <NavBreadcrumbs tail={breadcrumbsTail} />
      ) : null}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-title font-semibold text-ink">{title}</h1>
          {context && <div className="mt-0.5 text-small text-ink">{context}</div>}
          {description && <div className="mt-0.5 text-small text-ink-muted">{description}</div>}
          {help && (
            <MoreInfo label="この画面について" className="mt-1">
              {help}
            </MoreInfo>
          )}
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
        ? 'text-warning-ink'
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
      <span className="truncate text-caption font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </span>
      <span className={cn('mt-1 flex items-baseline gap-1', toneClass)}>
        <span className="tnum text-figure-lg font-semibold leading-7">{value}</span>
        {suffix && <span className="text-small text-ink-muted">{suffix}</span>}
      </span>
      {hint && <span className="mt-0.5 truncate text-caption text-ink-muted">{hint}</span>}
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
      <h2 className="text-body font-semibold text-ink">{title}</h2>
      {action}
    </div>
  );
}
