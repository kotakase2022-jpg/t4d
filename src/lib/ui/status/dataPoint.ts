import type { DataPointStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/** 非財務データ（Data Point）の状態。所有: Stage B1（文言の見直しは B1 が行う） */
export const dataPoint: Record<DataPointStatus, StatusEntry> = {
  not_started: { label: '未着手', semantic: 'todo' },
  draft: { label: '入力中', semantic: 'draft' },
  submitted: { label: '提出済み', semantic: 'in_review', description: 'レビュー待ちです。' },
  in_review: { label: 'レビュー中', semantic: 'in_review' },
  returned: { label: '差戻し', semantic: 'returned', description: '修正して再提出してください。' },
  approved: { label: '承認済み', semantic: 'done' },
};
