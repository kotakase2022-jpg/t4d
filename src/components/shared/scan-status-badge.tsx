import { ShieldAlert, ShieldCheck, ShieldOff, ShieldQuestion } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  SCAN_STATUS_LABELS,
  SCAN_STATUS_TONES,
  type ScanStatus,
} from '@/lib/domain/evidence-limits';

const ICONS = {
  pending: ShieldQuestion,
  clean: ShieldCheck,
  infected: ShieldAlert,
  skipped: ShieldOff,
} as const;

/** ウイルススキャンの状態（DB の値をそのまま出さず、ラベル＋アイコンで示す） */
export function ScanStatusBadge({ status }: { status: ScanStatus }) {
  const Icon = ICONS[status];
  return (
    <Badge tone={SCAN_STATUS_TONES[status]}>
      <Icon className="size-3" aria-hidden="true" />
      {SCAN_STATUS_LABELS[status]}
    </Badge>
  );
}
