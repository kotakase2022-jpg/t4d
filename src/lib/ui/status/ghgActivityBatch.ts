import type { GhgBatchStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/** 活動量の取込のまとまりの状態（0063。確定後は行を変えない） */
export const ghgActivityBatch: Record<GhgBatchStatus, StatusEntry> = {
  draft: { label: '確認中', semantic: 'draft' },
  confirmed: { label: '確定', semantic: 'done' },
  superseded: {
    label: '差し替え済み',
    semantic: 'excluded',
    description: '新しいバッチで差し替えたため、算定には使いません。',
  },
  discarded: { label: '破棄', semantic: 'excluded' },
};
