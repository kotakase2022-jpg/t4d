import type { StatusEntry } from './types';

/**
 * 無償の範囲と別途協議の信号（トライアル概要。2026-10-16 の要望 ④）。目安を超えても操作は止めない。
 * 「目安を超過」は別途協議の候補であって確定ではない
 */
export const TRIAL_SCOPE_SIGNAL_STATES = [
  'within',
  'over',
  'no_threshold',
  'not_measured',
] as const;
export type TrialScopeSignalState = (typeof TRIAL_SCOPE_SIGNAL_STATES)[number];

export const trialScopeSignal: Record<TrialScopeSignalState, StatusEntry> = {
  within: { label: '目安の範囲内', semantic: 'done' },
  over: {
    label: '別途協議の目安を超過',
    semantic: 'blocked',
    description: '別途協議の対象になりうる利用です（操作は止めません）。',
  },
  no_threshold: { label: '目安なし', semantic: 'todo' },
  not_measured: {
    label: '数えられない',
    semantic: 'info',
    description: '製品に機能が無いため件数を数えていません。要望は改善管理表に記録します。',
  },
};
