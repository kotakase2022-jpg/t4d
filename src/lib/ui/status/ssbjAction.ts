import { ACTION_STATUS_LABEL } from '@/lib/domain/ssbj';
import type { SsbjActionStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/** SSBJ 対応計画の状態。所有: Stage B2 */
export const ssbjAction: Record<SsbjActionStatus, StatusEntry> = {
  not_started: { label: ACTION_STATUS_LABEL.not_started, semantic: 'todo' },
  in_progress: { label: ACTION_STATUS_LABEL.in_progress, semantic: 'in_review' },
  in_review: { label: ACTION_STATUS_LABEL.in_review, semantic: 'pending' },
  done: { label: ACTION_STATUS_LABEL.done, semantic: 'done' },
};
