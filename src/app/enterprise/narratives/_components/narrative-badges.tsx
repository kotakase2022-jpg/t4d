import { Check, CircleDot, Quote, RefreshCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { NARRATIVE_STATUS_LABELS } from '@/lib/domain/disclosure-status';
import type { NarrativeStatus } from '@/types/domain';

/** 定性情報の状態バッジ（ラベルとアイコンを併記する） */
const MAP: Record<
  NarrativeStatus,
  { tone: 'outline' | 'success' | 'warning'; Icon: typeof Check }
> = {
  draft: { tone: 'outline', Icon: CircleDot },
  confirmed: { tone: 'success', Icon: Check },
  needs_recheck: { tone: 'warning', Icon: RefreshCcw },
};

export function NarrativeStatusBadge({ status }: { status: NarrativeStatus }) {
  const s = MAP[status];
  return (
    <Badge tone={s.tone}>
      <s.Icon className="size-3" aria-hidden="true" />
      {NARRATIVE_STATUS_LABELS[status]}
    </Badge>
  );
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
