import type { FeedbackSeverity } from '@/types/domain';
import type { StatusEntry } from './types';

/** 不具合の重大度（トライアル対応 NF-34。「必須要件 × 重大 × 未解決」は本導入の条件） */
export const severity: Record<FeedbackSeverity, StatusEntry> = {
  critical: { label: '重大', semantic: 'error' },
  major: { label: '中', semantic: 'blocked' },
  minor: { label: '軽微', semantic: 'info' },
};
