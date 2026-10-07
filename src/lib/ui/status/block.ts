import { BLOCK_STATUS_LABELS } from '@/lib/domain/disclosure-status';
import type { BlockStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/** 社内の承認であることを省かない（第三者保証と誤読させない） */
const INTERNAL_APPROVAL = '社内承認。第三者保証ではありません';

/** 開示原稿の節の状態。所有: Stage B4 */
export const block: Record<BlockStatus, StatusEntry> = {
  draft: { label: BLOCK_STATUS_LABELS.draft, semantic: 'draft' },
  review_requested: { label: BLOCK_STATUS_LABELS.review_requested, semantic: 'in_review' },
  returned: { label: BLOCK_STATUS_LABELS.returned, semantic: 'returned' },
  approval_pending: { label: BLOCK_STATUS_LABELS.approval_pending, semantic: 'pending' },
  approved: {
    label: BLOCK_STATUS_LABELS.approved,
    semantic: 'done',
    description: INTERNAL_APPROVAL,
  },
};
