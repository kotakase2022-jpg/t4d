import type { ReviewNoteStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/** レビューNote の状態（画面では生の enum が出ていた。plan §1.17）。所有: Stage B6 */
export const reviewNote: Record<ReviewNoteStatus, StatusEntry> = {
  open: { label: '未対応', semantic: 'pending' },
  responded: { label: '回答済み', semantic: 'in_review' },
  cleared: { label: 'クリア済み', semantic: 'done' },
};
