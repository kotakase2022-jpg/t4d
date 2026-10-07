'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  CircleCheck,
  Home,
  Inbox,
  Lock,
  MinusCircle,
  RotateCcw,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PERMISSION_LABELS } from '@/lib/authorization/permission-labels';
import type { PermissionKey } from '@/types/domain';
import { cn } from '@/lib/utils';

/**
 * 全 Component が Loading / Empty / Permission Denied / Error の
 * 4 状態を持てるよう、共通の表示部品をここへ集約する（指示書 9 章末・plan §1.18）。
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

// ----------------------------------------------------------------------
// 空状態（plan §1.18・§3.2）
// ----------------------------------------------------------------------

export type EmptyStateSize = 'compact' | 'page';

interface EmptyBase {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  className?: string;
  /** compact は表の中（py-4）、page は画面・節の空（py-10。既定） */
  size?: EmptyStateSize;
}

/**
 * 空状態の種類:
 *  - no-data: まだ何も無い。次の操作（action）が必須（「データがありません」だけにしない。指示書 §20）
 *  - filtered: 絞り込みの結果が 0 件。「絞り込みを解除」を自動で付ける
 *  - not-applicable: この利用者・この状態では対象が無い（説明だけ）
 *  - done: 前向きな空（例「今日やることはありません」）
 *  - kind 無し: 旧来の呼び出し（Stage B で種類を付ける。tests/unit/ui-ratchet.test.ts が件数を数える）
 */
export type EmptyStateProps =
  | (EmptyBase & { kind: 'no-data'; action: React.ReactNode })
  | {
      kind: 'filtered';
      title?: string;
      description?: string;
      resetHref: string;
      icon?: React.ReactNode;
      className?: string;
      size?: EmptyStateSize;
    }
  | (EmptyBase & { kind: 'not-applicable' | 'done'; action?: React.ReactNode })
  | (EmptyBase & { kind?: undefined; action?: React.ReactNode });

export function EmptyState(props: EmptyStateProps) {
  const size = props.size ?? 'page';
  const title = props.title ?? '条件に一致するものがありません';
  const defaultIcon =
    props.kind === 'done' ? (
      <CircleCheck className="size-5" aria-hidden="true" />
    ) : props.kind === 'not-applicable' ? (
      <MinusCircle className="size-5" aria-hidden="true" />
    ) : (
      <Inbox className="size-5" aria-hidden="true" />
    );
  const action =
    props.kind === 'filtered' ? (
      <Button variant="secondary" size="xs" asChild>
        <Link href={props.resetHref}>
          <X aria-hidden="true" />
          絞り込みを解除
        </Link>
      </Button>
    ) : (
      props.action
    );
  return (
    <div
      data-empty-kind={props.kind ?? 'legacy'}
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-4 text-center',
        size === 'compact' ? 'py-4' : 'py-10',
        props.className,
      )}
    >
      <div
        className={cn(
          'rounded-full p-2',
          props.kind === 'done' ? 'bg-success-soft text-success' : 'bg-brand-50 text-brand-600',
        )}
      >
        {props.icon ?? defaultIcon}
      </div>
      <p className="text-body font-medium text-ink">{title}</p>
      {props.description && (
        <p className="max-w-md text-small text-ink-muted">{props.description}</p>
      )}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

// ----------------------------------------------------------------------
// エラー（何が・なぜ・どうする。指示書 §21）
// ----------------------------------------------------------------------

export interface ErrorStateProps {
  /** 何が起きたか（例: 処理を完了できませんでした） */
  what?: string;
  /** なぜ（分かる範囲で。例: サーバーで予期しないエラーが発生しました） */
  why?: string;
  /** どうすればよいか（例: 再試行してください。続く場合は識別子を添えて管理者へ） */
  how?: string;
  /** 本番の識別子（管理者へ伝える） */
  digest?: string;
  onRetry?: () => void;
  retryHref?: string;
  /** 戻る先（ワークスペースのホーム） */
  homeHref?: string;
  className?: string;
  /** 旧来の呼び出し（what と同じ） */
  title?: string;
  /** 旧来の呼び出し（why と同じ） */
  description?: string;
}

export function ErrorState({
  what,
  why,
  how,
  digest,
  onRetry,
  retryHref,
  homeHref,
  className,
  title,
  description,
}: ErrorStateProps) {
  const heading = what ?? title ?? 'データを取得できませんでした';
  const reason = why ?? description;
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
      <p className="text-body font-medium text-ink">{heading}</p>
      {reason && <p className="max-w-md text-small text-ink-muted">{reason}</p>}
      {how && <p className="max-w-md text-small text-ink">{how}</p>}
      {digest && (
        <p className="text-caption text-ink-muted">
          識別子: <span className="font-mono">{digest}</span>
        </p>
      )}
      <div className="flex items-center gap-2">
        <RetryAction onRetry={onRetry} href={retryHref} />
        {homeHref && (
          <Button variant="ghost" size="sm" asChild>
            <Link href={homeHref}>
              <Home aria-hidden="true" />
              ホームへ戻る
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}

export function RetryAction({ onRetry, href }: { onRetry?: () => void; href?: string }) {
  if (href) {
    return (
      <Button variant="secondary" size="sm" asChild>
        <a href={href}>
          <RotateCcw aria-hidden="true" />
          再試行
        </a>
      </Button>
    );
  }
  if (!onRetry) return null;
  return (
    <Button variant="secondary" size="sm" onClick={onRetry}>
      <RotateCcw aria-hidden="true" />
      再試行
    </Button>
  );
}

// ----------------------------------------------------------------------
// 権限なし
// ----------------------------------------------------------------------

export function PermissionDeniedState({
  description = 'この情報を閲覧する権限がありません。必要な場合は管理者へ依頼してください。',
  permission,
  className,
}: {
  description?: string;
  /** 足りない権限。渡すと「誰に頼むか」（その権限を持つ役割）を添える */
  permission?: PermissionKey;
  className?: string;
}) {
  const label = permission ? PERMISSION_LABELS[permission] : null;
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
      <p className="text-body font-medium text-ink">アクセス権限がありません</p>
      <p className="max-w-md text-small text-ink-muted">{description}</p>
      {label && (
        <p className="max-w-md text-small text-ink">
          必要な権限: 「{label.label}」。{label.holders}に依頼してください。
        </p>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------
// スケルトン（固定の高さ。読み込みの前後で画面をずらさない）
// ----------------------------------------------------------------------

export function TableSkeleton({
  rows = 8,
  columns = 5,
  label = '一覧を読み込み中',
  className,
}: {
  rows?: number;
  columns?: number;
  label?: string;
  className?: string;
}) {
  return (
    <div role="status" aria-busy="true" className={cn('w-full', className)}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">
        <div className="flex h-8 items-center gap-2 border-b border-line px-2">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton key={c} className="h-3 flex-1" />
          ))}
        </div>
        {Array.from({ length: rows }).map((_, r) => (
          // 行の高さは表の行と同じ（--spacing-row）
          <div key={r} className="flex h-row items-center gap-2 border-b border-line px-2">
            {Array.from({ length: columns }).map((_, c) => (
              <Skeleton key={c} className="h-3.5 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function PanelSkeleton({
  lines = 3,
  label = '読み込み中',
  className,
}: {
  lines?: number;
  label?: string;
  className?: string;
}) {
  return (
    <div role="status" aria-busy="true" className={cn('space-y-1.5 p-3', className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={cn('h-4', i === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}
