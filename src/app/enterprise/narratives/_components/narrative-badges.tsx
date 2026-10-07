import { Quote } from 'lucide-react';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import type { NarrativeStatus } from '@/types/domain';

/** 定性情報の状態バッジ（状態登録簿の narrative から描く。ラベルとアイコンを併記する） */
export function NarrativeStatusBadge({ status }: { status: NarrativeStatus }) {
  return <StatusBadge domain="narrative" value={status} />;
}

/** 資料の抜粋から規則で作った候補（AI ではない） */
export function CandidateBadge() {
  return (
    <Badge tone="warning">
      <Quote className="size-3" aria-hidden="true" />
      候補（資料の抜粋から作成）
    </Badge>
  );
}
