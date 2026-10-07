import { REVIEW_REQUEST_STATUS_LABELS } from '@/lib/domain/disclosure-status';
import type { ReviewRequestStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/** 原稿のレビュー依頼の状態。所有: Stage B4 */
export const review: Record<ReviewRequestStatus, StatusEntry> = {
  open: { label: REVIEW_REQUEST_STATUS_LABELS.open, semantic: 'pending' },
  returned: { label: REVIEW_REQUEST_STATUS_LABELS.returned, semantic: 'returned' },
  reviewed: { label: REVIEW_REQUEST_STATUS_LABELS.reviewed, semantic: 'in_review' },
  approved: {
    label: REVIEW_REQUEST_STATUS_LABELS.approved,
    semantic: 'done',
    // 社内の承認であることを省かない（第三者保証と誤読させない）
    description: '社内承認。第三者保証ではありません',
  },
  withdrawn: { label: REVIEW_REQUEST_STATUS_LABELS.withdrawn, semantic: 'excluded' },
};
