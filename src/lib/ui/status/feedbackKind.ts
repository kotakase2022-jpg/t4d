import type { FeedbackKind } from '@/types/domain';
import type { StatusEntry } from './types';

/** フィードバックの種類（トライアル対応 NF-34） */
export const feedbackKind: Record<FeedbackKind, StatusEntry> = {
  defect: { label: '不具合', semantic: 'error' },
  request: { label: '要望', semantic: 'info' },
  question: { label: '質問', semantic: 'question' },
  positive: { label: '良かった点', semantic: 'done' },
  other: { label: 'その他', semantic: 'info' },
};
