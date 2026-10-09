import type { CostClass } from '@/types/domain';
import type { StatusEntry } from './types';

/** 改善の費用区分（トライアル対応 NF-34） */
export const costClass: Record<CostClass, StatusEntry> = {
  maintenance: { label: '保守範囲内', semantic: 'done' },
  separate_estimate: { label: '別途見積', semantic: 'pending' },
  undecided: { label: '未判断', semantic: 'todo' },
};
