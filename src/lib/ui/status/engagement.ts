import type { EngagementStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/** 保証案件の状態（画面では fieldwork などの生の enum が出ていた。plan §1.17）。所有: Stage B6 */
export const engagement: Record<EngagementStatus, StatusEntry> = {
  planning: { label: '計画中', semantic: 'todo' },
  fieldwork: { label: '手続の実施中', semantic: 'in_review' },
  review: { label: 'レビュー中', semantic: 'in_review' },
  completed: { label: '完了', semantic: 'done' },
  archived: { label: 'アーカイブ済み', semantic: 'excluded' },
};
