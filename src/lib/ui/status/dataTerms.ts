import type { StatusEntry } from './types';

/** データ取扱条件の項目の合意の状態（トライアル対応 NF-28。空・未定の項目は推測で埋めず未合意） */
export const DATA_TERMS_STATES = ['agreed', 'not_agreed'] as const;
export type DataTermsState = (typeof DATA_TERMS_STATES)[number];

export const dataTerms: Record<DataTermsState, StatusEntry> = {
  agreed: { label: '合意済み', semantic: 'done' },
  not_agreed: { label: '未合意', semantic: 'blocked' },
};
