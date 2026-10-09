import type { StatusEntry } from './types';

/**
 * 保証側のコメントの企業側から見た状態（トライアル対応 NF-21）。保証側の行は企業が更新しないため、
 * 回答の有無と保証側の状態（クリア）から導く
 */
export const CLIENT_NOTE_STATES = ['unanswered', 'answered', 'cleared'] as const;
export type ClientNoteState = (typeof CLIENT_NOTE_STATES)[number];

export const clientNote: Record<ClientNoteState, StatusEntry> = {
  unanswered: { label: '未回答', semantic: 'pending' },
  answered: { label: '回答済み', semantic: 'in_review' },
  cleared: { label: 'クリア', semantic: 'done' },
};
