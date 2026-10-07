import type { IssueStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/** 指摘・例外の状態（画面では生の enum が出ていた。plan §1.17）。所有: Stage B6 */
export const issue: Record<IssueStatus, StatusEntry> = {
  open: { label: '未解決', semantic: 'pending' },
  management_response: { label: '経営者の回答あり', semantic: 'in_review' },
  resolved: { label: '解消', semantic: 'done' },
  closed: { label: 'クローズ', semantic: 'done' },
};
