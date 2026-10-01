import { Ban, CircleCheck, CircleDashed, CircleDot, Eye } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ACTION_STATUS_LABEL, ACTION_STATUS_TONE } from '@/lib/domain/ssbj';
import type { SsbjActionStatus } from '@/types/domain';

// 優先度のバッジは、要求事項の一覧・詳細と共通（csrd-badges）
export { PlanPriorityBadge } from '../../_components/csrd-badges';

/**
 * CSRD 対応計画の状態バッジ。色だけで状態を表さない（ラベルとアイコンを併記する。CLAUDE.md §2）。
 * アイコンは装飾なので読み上げない。
 */

const STATUS_ICON: Record<SsbjActionStatus, typeof Eye> = {
  not_started: CircleDashed,
  in_progress: CircleDot,
  in_review: Eye,
  done: CircleCheck,
};

export function ActionStatusBadge({ status }: { status: SsbjActionStatus }) {
  const Icon = STATUS_ICON[status];
  return (
    <Badge tone={ACTION_STATUS_TONE[status]}>
      <Icon className="size-3" aria-hidden="true" />
      {ACTION_STATUS_LABEL[status]}
    </Badge>
  );
}

/** 計画を立てた後に DMA の判断が変わり、評価対象から外れた要求事項の計画 */
export function OutOfScopeRequirementBadge() {
  return (
    <Badge tone="warning" title="DMA の判断が変わり、この要求事項は評価対象ではなくなりました">
      <Ban className="size-3" aria-hidden="true" />
      対象外の要求事項
    </Badge>
  );
}
