import type { MembershipStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/** メンバーの状態。所有: Stage B6 */
export const membership: Record<MembershipStatus, StatusEntry> = {
  invited: { label: '招待中', semantic: 'draft' },
  active: { label: '有効', semantic: 'done' },
  suspended: { label: '停止中', semantic: 'error' },
};
