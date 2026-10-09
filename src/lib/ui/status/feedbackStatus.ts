import type { FeedbackStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/** 改善管理表の状態（トライアル対応 NF-34） */
export const feedbackStatus: Record<FeedbackStatus, StatusEntry> = {
  open: { label: '未着手', semantic: 'todo' },
  triaged: { label: '方針決定済み', semantic: 'pending' },
  in_progress: { label: '対応中', semantic: 'in_review' },
  resolved: { label: '解決済み', semantic: 'done' },
  wont_fix: { label: '対応しない', semantic: 'excluded' },
  verified: { label: '再検証済み', semantic: 'done' },
};
