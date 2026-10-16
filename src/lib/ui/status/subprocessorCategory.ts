import type { SubprocessorCategory } from '@/types/domain';
import type { StatusEntry } from './types';

/** 処理を委ねる先の区分（データの取扱い。2026-10-16 の要望 ⑥） */
export const subprocessorCategory: Record<SubprocessorCategory, StatusEntry> = {
  contractor: { label: '業務委託先', semantic: 'info' },
  cloud: { label: 'クラウドサービス提供者', semantic: 'info' },
  ai: { label: 'AI サービス提供者', semantic: 'info' },
  other: { label: 'その他', semantic: 'info' },
};
