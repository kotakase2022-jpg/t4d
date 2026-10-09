import type { TrialCompletion } from '@/types/domain';
import type { StatusEntry } from './types';

/** シナリオの実施の完遂区分（トライアル対応 NF-33） */
export const trialCompletion: Record<TrialCompletion, StatusEntry> = {
  self: { label: '自力で完了', semantic: 'done' },
  with_help: { label: '支援を受けて完了', semantic: 'question' },
  not_completed: { label: '完了できず', semantic: 'error' },
};
