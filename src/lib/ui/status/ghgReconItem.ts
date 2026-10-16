import type { GhgReconVerdict } from '@/types/domain';
import type { StatusEntry } from './types';

/**
 * 照合の項目の判定（0065）。「一致」を判定に使わない（plan K8）。許容差は利用者が入れた値
 */
export const ghgReconItem: Record<GhgReconVerdict, StatusEntry> = {
  within_tolerance: { label: '許容差内', semantic: 'done' },
  needs_review: { label: '要確認', semantic: 'pending' },
  cause_confirmed: {
    label: '原因を確認済み',
    semantic: 'done',
    description: '確認者が差異の原因を記録しました。',
  },
  unexplained: {
    label: '原因不明（残差）',
    semantic: 'question',
    description: '既存の算定結果に情報が無く、原因を分けられない差です。',
  },
  one_sided: {
    label: '片側のみ',
    semantic: 'blocked',
    description: 'T4D と既存の算定結果のどちらか一方にしか無い項目です。',
  },
};
