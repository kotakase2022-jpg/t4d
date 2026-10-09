import type { StatusEntry } from './types';

/** 保証側へ共有した開示レポートの写しの状態（トライアル対応 NF-20。取り下げ日時から決まる） */
export const SHARED_REPORT_STATES = ['active', 'withdrawn'] as const;
export type SharedReportState = (typeof SHARED_REPORT_STATES)[number];

export const sharedReport: Record<SharedReportState, StatusEntry> = {
  active: { label: '共有中', semantic: 'in_review' },
  withdrawn: {
    label: '取り下げ済み',
    semantic: 'excluded',
    description: '保証側からは見えません。',
  },
};
