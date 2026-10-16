import type { CostClass } from '@/types/domain';
import type { StatusEntry } from './types';

/**
 * 改善の費用区分（トライアル対応 NF-34）。語は「標準機能の範囲は無償、追加開発等は別途協議」の整理に揃える
 * （2026-10-16 の要望 ④）。DB の値は変えない（maintenance・separate_estimate・undecided）
 */
export const costClass: Record<CostClass, StatusEntry> = {
  maintenance: { label: '標準の範囲内', semantic: 'done' },
  separate_estimate: { label: '別途協議', semantic: 'pending' },
  undecided: { label: '未判断', semantic: 'todo' },
};
