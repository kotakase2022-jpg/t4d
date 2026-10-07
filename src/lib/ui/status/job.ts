import type { JobStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/** 取込ジョブの状態。所有: Stage B1 */
export const job: Record<JobStatus, StatusEntry> = {
  queued: { label: '待機中', semantic: 'todo' },
  processing: { label: '処理中', semantic: 'in_review' },
  needs_review: {
    label: '要確認',
    semantic: 'pending',
    description: '取込内容を確認して確定してください。',
  },
  completed: { label: '完了', semantic: 'done' },
  failed: { label: '失敗', semantic: 'error' },
  cancelled: { label: '中止', semantic: 'excluded' },
};
