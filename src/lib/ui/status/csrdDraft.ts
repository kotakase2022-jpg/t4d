import type { StatusEntry } from './types';

/**
 * CSRD 開示ドラフトの節の状態（DB の列ではなく、確定日時・本文・AI 草案の有無から決まる表示上の状態）。
 * domain.ts に enum が無いため、ここを状態の一覧の出所にする（draft-badges.tsx の CsrdDraftState と同じ値）。
 * 所有: Stage B3
 */
export const CSRD_DRAFT_STATES = ['confirmed', 'body_unconfirmed', 'ai_only', 'none'] as const;
export type CsrdDraftStateKey = (typeof CSRD_DRAFT_STATES)[number];

export const csrdDraft: Record<CsrdDraftStateKey, StatusEntry> = {
  confirmed: { label: '確定済み', semantic: 'done' },
  body_unconfirmed: { label: '本文あり・未確定', semantic: 'pending' },
  ai_only: {
    label: 'AI 草案のみ（本文未採用）',
    semantic: 'draft',
    description: 'AI の草案は候補です。本文に採用して確定するのは担当者です。',
  },
  none: { label: '未作成', semantic: 'todo' },
};
