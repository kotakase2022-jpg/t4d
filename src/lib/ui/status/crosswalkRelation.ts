import type { CrosswalkRelation } from '@/types/domain';
import type { StatusEntry } from './types';

/** 横断対応表の関係（トライアル対応 NF-09）。所有: Stage A（表示は T1） */
export const crosswalkRelation: Record<CrosswalkRelation, StatusEntry> = {
  equivalent: { label: '同等', semantic: 'done' },
  partial: { label: '一部', semantic: 'question' },
  related: { label: '関連', semantic: 'info' },
  no_counterpart: { label: '対応なし', semantic: 'excluded' },
};
