'use client';

import * as React from 'react';
import { AlertTriangle, Inbox, Lock, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * 全 Component が Loading / Empty / Permission Denied / Error の
 * 4 状態を持てるよう、共通の表示部品をここへ集約する（指示書 9 章末）。
 */

export function LoadingState({
  rows = 6,
  label = '読み込み中',
  className,
}: {
  rows?: number;
  label?: string;
  className?: string;
}) {
  return (
    <div className={cn('p-3', className)} role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div className="space-y-1.5">
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-4 py-10 text-center',
        className,
      )}
    >
      <div className="rounded-full bg-brand-50 p-2 text-brand-600">
        {icon ?? <Inbox className="size-5" aria-hidden="true" />}
      </div>
      <p className="text-[13px] font-medium text-ink">{title}</p>
      {description && <p className="max-w-md text-[12px] text-ink-muted">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = 'データを取得できませんでした',
  description,
  onRetry,
  retryHref,
  className,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  retryHref?: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-4 py-10 text-center',
        className,
      )}
    >
      <div className="rounded-full bg-danger-soft p-2 text-danger">
        <AlertTriangle className="size-5" aria-hidden="true" />
      </div>
      <p className="text-[13px] font-medium text-ink">{title}</p>
      {description && <p className="max-w-md text-[12px] text-ink-muted">{description}</p>}
      <RetryAction onRetry={onRetry} href={retryHref} />
    </div>
  );
}

export function RetryAction({ onRetry, href }: { onRetry?: () => void; href?: string }) {
  if (href) {
    return (
      <Button variant="outline" size="sm" asChild>
        <a href={href}>
          <RotateCcw aria-hidden="true" />
          再試行
        </a>
      </Button>
    );
  }
  if (!onRetry) return null;
  return (
    <Button variant="outline" size="sm" onClick={onRetry}>
      <RotateCcw aria-hidden="true" />
      再試行
    </Button>
  );
}

export function PermissionDeniedState({
  description = 'この情報を閲覧する権限がありません。必要な場合は管理者へ依頼してください。',
  className,
}: {
  description?: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-4 py-10 text-center',
        className,
      )}
    >
      <div className="rounded-full bg-surface-muted p-2 text-ink-muted">
        <Lock className="size-5" aria-hidden="true" />
      </div>
      <p className="text-[13px] font-medium text-ink">アクセス権限がありません</p>
      <p className="max-w-md text-[12px] text-ink-muted">{description}</p>
    </div>
  );
}
