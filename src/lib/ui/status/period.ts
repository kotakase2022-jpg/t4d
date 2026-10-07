import { PERIOD_STATUS_LABELS } from '@/lib/domain/disclosure-status';
import type { PeriodStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/** 報告期間の状態。所有: Stage B5 */
export const period: Record<PeriodStatus, StatusEntry> = {
  planning: { label: PERIOD_STATUS_LABELS.planning, semantic: 'todo' },
  collecting: { label: PERIOD_STATUS_LABELS.collecting, semantic: 'in_review' },
  reviewing: { label: PERIOD_STATUS_LABELS.reviewing, semantic: 'in_review' },
  closed: { label: PERIOD_STATUS_LABELS.closed, semantic: 'done' },
};
