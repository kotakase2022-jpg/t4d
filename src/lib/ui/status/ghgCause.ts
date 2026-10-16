import { GHG_CAUSES, type GhgCause } from '@/types/domain';
import type { StatusEntry } from './types';

/** 差異の原因（照合の寄与・確認の記録）。原因を分けられない差は「原因不明（残差）」 */
export const GHG_CAUSE_STATES = [...GHG_CAUSES, 'residual'] as const;
export type GhgCauseState = GhgCause | 'residual';

export const ghgCause: Record<GhgCauseState, StatusEntry> = {
  classification: { label: '区分', semantic: 'info' },
  coverage: { label: '対象範囲（行の有無）', semantic: 'info' },
  activity: { label: '活動量', semantic: 'info' },
  conversion: { label: '単位換算', semantic: 'info' },
  factor: { label: '排出係数（値・年度・版）', semantic: 'info' },
  method: { label: '算定方法', semantic: 'info' },
  rounding: { label: '丸め', semantic: 'info' },
  other: { label: 'その他', semantic: 'info' },
  residual: { label: '原因不明（残差）', semantic: 'question' },
};
