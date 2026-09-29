import type { ComponentType } from 'react';
import {
  AlertTriangle,
  CheckCheck,
  CheckCircle2,
  FilePen,
  FileQuestion,
  Hourglass,
  Send,
  Undo2,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { BLOCK_STATUS_LABELS, REVIEW_REQUEST_STATUS_LABELS } from '@/lib/domain/disclosure-status';
import type { BlockStatus, ReviewRequestStatus } from '@/types/domain';

/**
 * 原稿・レビュー・参照の鮮度のバッジ。色だけで状態を表さず、必ずラベルとアイコンを併記する。
 * 企業内の承認であり、第三者保証を意味しない（「保証」と表示しない）。
 */

const BLOCK_TONE: Record<BlockStatus, 'neutral' | 'brand' | 'danger' | 'warning' | 'success'> = {
  draft: 'neutral',
  review_requested: 'brand',
  returned: 'danger',
  approval_pending: 'warning',
  approved: 'success',
};

const BLOCK_ICON: Record<BlockStatus, ComponentType<{ className?: string }>> = {
  draft: FilePen,
  review_requested: Send,
  returned: Undo2,
  approval_pending: Hourglass,
  approved: CheckCircle2,
};

export function BlockStatusBadge({ status }: { status: BlockStatus }) {
  const Icon = BLOCK_ICON[status];
  return (
    <Badge tone={BLOCK_TONE[status]}>
      <Icon className="size-3" aria-hidden="true" />
      {BLOCK_STATUS_LABELS[status]}
      {status === 'approved' && (
        <span className="sr-only">（社内承認。第三者保証ではありません）</span>
      )}
    </Badge>
  );
}

export type FreshnessBadgeStatus =
  'current' | 'upstream_updated' | 'evidence_invalid' | 'rechecked' | 'version_unavailable';

const FRESHNESS: Record<
  FreshnessBadgeStatus,
  {
    label: string;
    tone: 'success' | 'warning' | 'danger' | 'neutral';
    Icon: ComponentType<{ className?: string }>;
  }
> = {
  current: { label: '現行', tone: 'success', Icon: CheckCircle2 },
  upstream_updated: { label: '上流に新版あり', tone: 'warning', Icon: AlertTriangle },
  evidence_invalid: { label: '根拠失効', tone: 'danger', Icon: XCircle },
  rechecked: { label: '再確認済み', tone: 'neutral', Icon: CheckCheck },
  // 版を読めない（Demo Mode で別のサーバーが作った版など）。「現行」と誤って示さない
  version_unavailable: { label: '版を読み込めません', tone: 'warning', Icon: FileQuestion },
};

export function FreshnessBadge({ status }: { status: FreshnessBadgeStatus }) {
  const { label, tone, Icon } = FRESHNESS[status];
  return (
    <Badge tone={tone}>
      <Icon className="size-3" aria-hidden="true" />
      参照: {label}
    </Badge>
  );
}

const REQUEST_TONE: Record<
  ReviewRequestStatus,
  'neutral' | 'brand' | 'danger' | 'warning' | 'success'
> = {
  open: 'brand',
  returned: 'danger',
  reviewed: 'warning',
  approved: 'success',
  withdrawn: 'neutral',
};

const REQUEST_ICON: Record<ReviewRequestStatus, ComponentType<{ className?: string }>> = {
  open: Send,
  returned: Undo2,
  reviewed: Hourglass,
  approved: CheckCircle2,
  withdrawn: XCircle,
};

export function ReviewRequestStatusBadge({ status }: { status: ReviewRequestStatus }) {
  const Icon = REQUEST_ICON[status];
  return (
    <Badge tone={REQUEST_TONE[status]}>
      <Icon className="size-3" aria-hidden="true" />
      {REVIEW_REQUEST_STATUS_LABELS[status]}
    </Badge>
  );
}
