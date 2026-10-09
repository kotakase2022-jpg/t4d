import type { StatusEntry } from './types';

/** 出力の突合の結果（トライアル対応 NF-15）。突合の列が null の出力（以前の出力）は未突合 */
export const RECONCILIATION_STATES = ['matched', 'mismatched', 'not_reconciled'] as const;
export type ReconciliationState = (typeof RECONCILIATION_STATES)[number];

export const reconciliation: Record<ReconciliationState, StatusEntry> = {
  matched: {
    label: '不一致 0 件',
    semantic: 'done',
    description: 'T4D が生成したファイルを読み戻し、承認版と照合した結果です。',
  },
  mismatched: { label: '不一致あり', semantic: 'error' },
  not_reconciled: { label: '未突合', semantic: 'todo' },
};
