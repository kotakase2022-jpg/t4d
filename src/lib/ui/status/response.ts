import type { ResponseStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/**
 * 開示の回答（CDP・CSRD の question-view）の状態。所有: Stage B2。
 * draft はデータの「入力中」と区別して「下書き」と書く（plan §1.17 (4): 同じ状態は同じ語）
 */
export const response: Record<ResponseStatus, StatusEntry> = {
  not_started: { label: '未着手', semantic: 'todo' },
  draft: { label: '下書き', semantic: 'draft' },
  in_review: { label: 'レビュー中', semantic: 'in_review' },
  returned: { label: '差戻し', semantic: 'returned' },
  approved: { label: '承認済み', semantic: 'done' },
};
