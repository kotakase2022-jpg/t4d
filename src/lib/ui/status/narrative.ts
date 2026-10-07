import { NARRATIVE_STATUS_LABELS } from '@/lib/domain/disclosure-status';
import type { NarrativeStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/** 定性情報の状態。所有: Stage B4 */
export const narrative: Record<NarrativeStatus, StatusEntry> = {
  draft: { label: NARRATIVE_STATUS_LABELS.draft, semantic: 'draft' },
  confirmed: { label: NARRATIVE_STATUS_LABELS.confirmed, semantic: 'done' },
  needs_recheck: { label: NARRATIVE_STATUS_LABELS.needs_recheck, semantic: 'blocked' },
};
