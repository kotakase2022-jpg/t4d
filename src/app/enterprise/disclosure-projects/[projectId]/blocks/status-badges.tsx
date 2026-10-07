import type { ComponentType } from 'react';
import { AlertTriangle, CheckCheck, CheckCircle2, FileQuestion, XCircle } from 'lucide-react';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import type { BlockStatus, ReviewRequestStatus } from '@/types/domain';

/**
 * 原稿・レビュー・参照の鮮度のバッジ。色だけで状態を表さず、必ずラベルとアイコンを併記する。
 * 企業内の承認であり、第三者保証を意味しない（「保証」と表示しない）。
 *
 * 原稿とレビュー依頼の状態は状態登録簿（src/lib/ui/status の block・review）から描く
 * （同じ「差戻し」が画面ごとに別の色・アイコンにならないように。plan §3.2）。
 */

/** 承認済みには「社内承認。第三者保証ではありません」を添える（登録簿の description。読み上げと Hint） */
export function BlockStatusBadge({ status }: { status: BlockStatus }) {
  return <StatusBadge domain="block" value={status} />;
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

export function ReviewRequestStatusBadge({ status }: { status: ReviewRequestStatus }) {
  return <StatusBadge domain="review" value={status} />;
}
