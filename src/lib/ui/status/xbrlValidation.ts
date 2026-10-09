import type { StatusEntry } from './types';

/** XBRL の簡易検査（V01〜V16）の結果。公式の検証ではない（トライアル対応 NF-42） */
export const XBRL_VALIDATION_STATES = ['passed', 'warning', 'error', 'note'] as const;
export type XbrlValidationState = (typeof XBRL_VALIDATION_STATES)[number];

export const xbrlValidation: Record<XbrlValidationState, StatusEntry> = {
  passed: { label: '合格', semantic: 'done' },
  warning: { label: '警告', semantic: 'blocked' },
  error: { label: 'エラー', semantic: 'error' },
  note: { label: '注記', semantic: 'info' },
};
