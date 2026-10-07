import { APPLICABILITY_STATUS_LABELS } from '@/lib/domain/disclosure-status';
import type { ApplicabilityStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/** 開示プロジェクトの基準の適用判断。所有: Stage B4 */
export const applicabilityProject: Record<ApplicabilityStatus, StatusEntry> = {
  not_assessed: { label: APPLICABILITY_STATUS_LABELS.not_assessed, semantic: 'todo' },
  candidate: { label: APPLICABILITY_STATUS_LABELS.candidate, semantic: 'pending' },
  applicable: { label: APPLICABILITY_STATUS_LABELS.applicable, semantic: 'done' },
  not_applicable: { label: APPLICABILITY_STATUS_LABELS.not_applicable, semantic: 'excluded' },
  voluntary: { label: APPLICABILITY_STATUS_LABELS.voluntary, semantic: 'done' },
  awaiting_confirmation: {
    label: APPLICABILITY_STATUS_LABELS.awaiting_confirmation,
    semantic: 'pending',
  },
};
