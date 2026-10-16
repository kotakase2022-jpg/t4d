import type { GhgRuleStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/** 区分規則の状態（0062。提案者と承認者は別人） */
export const ghgRule: Record<GhgRuleStatus, StatusEntry> = {
  proposed: {
    label: '承認待ち',
    semantic: 'pending',
    description: '承認されるまで、算定は既定区分（GHG プロトコル）のままです。',
  },
  approved: { label: '承認済み', semantic: 'done' },
  withdrawn: { label: '取り下げ', semantic: 'excluded' },
};
