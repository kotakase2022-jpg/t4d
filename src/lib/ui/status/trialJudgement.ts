import { TRIAL_JUDGEMENTS, type TrialJudgement } from '@/types/domain';
import type { StatusEntry } from './types';

/** 検証シナリオの評価者の判定（トライアル対応 NF-33）。判定の記録が無いシナリオは未判定 */
export const TRIAL_JUDGEMENT_STATES = [...TRIAL_JUDGEMENTS, 'not_judged'] as const;
export type TrialJudgementState = TrialJudgement | 'not_judged';

export const trialJudgement: Record<TrialJudgementState, StatusEntry> = {
  pass: { label: '合格', semantic: 'done' },
  fail: { label: '不合格', semantic: 'error' },
  hold: { label: '保留', semantic: 'pending' },
  not_judged: { label: '未判定', semantic: 'todo' },
};
