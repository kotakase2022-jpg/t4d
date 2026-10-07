import type { TestStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/** 保証手続（調書）の状態。所有: Stage B6 */
export const test: Record<TestStatus, StatusEntry> = {
  not_started: { label: '未着手', semantic: 'todo' },
  in_progress: { label: '実施中', semantic: 'in_review' },
  prepared: { label: '作成済み', semantic: 'in_review' },
  reviewed: { label: 'レビュー済み', semantic: 'done' },
  exception: { label: '例外あり', semantic: 'error' },
};
