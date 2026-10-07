import type { PbcStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/** 資料依頼（PBC）の状態。所有: Stage B6 */
export const pbc: Record<PbcStatus, StatusEntry> = {
  draft: { label: '下書き', semantic: 'draft' },
  sent: { label: '送付済み', semantic: 'in_review' },
  acknowledged: { label: '受領確認', semantic: 'in_review' },
  submitted: { label: '提出済み', semantic: 'in_review' },
  under_review: { label: '確認中', semantic: 'in_review' },
  accepted: { label: '受理', semantic: 'done' },
  rejected: { label: '差戻し', semantic: 'returned' },
  overdue: { label: '期限超過', semantic: 'error' },
  closed: { label: 'クローズ', semantic: 'excluded' },
};
