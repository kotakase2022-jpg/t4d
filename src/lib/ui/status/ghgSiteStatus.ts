import type { GhgSiteStatus } from '@/lib/domain/ghg/verification-status';
import type { StatusEntry } from './types';

/** 拠点ごとの算定の検証の状況（status.ts。トライアル概要・算定の概要・ホームで同じ語） */
export const ghgSiteStatus: Record<GhgSiteStatus, StatusEntry> = {
  not_started: { label: '未着手', semantic: 'todo' },
  input_missing: {
    label: '入力不足',
    semantic: 'blocked',
    description: '活動量の月が欠けているか、係数が割り当てられていない行があります。',
  },
  calculated: { label: '算定済み', semantic: 'in_review' },
  recalc_needed: {
    label: '再算定が必要',
    semantic: 'returned',
    description: '最新の算定の後に入力（係数・算定ルール・活動量）が変わりました。',
  },
  reconciliation_review: { label: '照合（要確認）', semantic: 'pending' },
  reconciled: {
    label: '照合済み',
    semantic: 'done',
    description: '照合の全項目が許容差内か、原因を確認済みです。',
  },
};
