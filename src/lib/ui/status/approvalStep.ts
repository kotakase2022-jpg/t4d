import type { ApprovalStepStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/** 承認経路の段階の状態。所有: Stage B1 */
export const approvalStep: Record<ApprovalStepStatus, StatusEntry> = {
  waiting: { label: '未着手', semantic: 'todo', description: '前の段階の承認を待っています。' },
  pending: { label: '承認待ち', semantic: 'pending' },
  approved: { label: '承認済み', semantic: 'done' },
  returned: { label: '差戻し', semantic: 'returned' },
};
