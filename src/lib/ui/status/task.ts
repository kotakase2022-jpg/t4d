import type { TaskStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/** タスクの状態。所有: Stage B1 */
export const task: Record<TaskStatus, StatusEntry> = {
  open: { label: '未着手', semantic: 'todo' },
  in_progress: { label: '対応中', semantic: 'in_review' },
  blocked: { label: '保留（阻害あり）', semantic: 'blocked' },
  done: { label: '完了', semantic: 'done' },
  cancelled: { label: '取消', semantic: 'excluded' },
};
