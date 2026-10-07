import type { AiRunStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/**
 * AI の実行記録の状態。AI の出力は候補で、採用・不採用は人が決める（CLAUDE.md §0-4）。
 * 所有: Stage B5
 */
export const aiRun: Record<AiRunStatus, StatusEntry> = {
  running: { label: '実行中', semantic: 'in_review' },
  succeeded: {
    label: '生成済み（未確認）',
    semantic: 'pending',
    description: '出力は候補です。人が確認して採用・不採用を決めます。',
  },
  failed: { label: '失敗', semantic: 'error' },
  accepted: { label: '採用', semantic: 'done' },
  rejected: { label: '不採用', semantic: 'excluded' },
};
