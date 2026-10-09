/**
 * トライアルの評価のタブ（NF-32〜NF-36）。キーは URL の ?tab= と同じ。
 * 概要（計画と実績）→ シナリオ → 改善管理表 → 作業時間 → 費用対効果（試算）の順。
 */
export const TRIAL_BASE = '/enterprise/trial';

/** 検証結果・改善管理表の XLSX（企業管理者だけ） */
export const TRIAL_REPORT_HREF = '/api/exports/trial-report';

export const TRIAL_TABS = ['overview', 'scenarios', 'feedback', 'timing', 'roi'] as const;
export type TrialTab = (typeof TRIAL_TABS)[number];

export const TRIAL_TAB_LABELS: Readonly<Record<TrialTab, string>> = {
  overview: '概要',
  scenarios: 'シナリオ',
  feedback: '改善管理表',
  timing: '作業時間',
  roi: '費用対効果',
};

type Params = Record<string, string | string[] | undefined>;

export function resolveTrialTab(params: Params): TrialTab {
  const requested = typeof params.tab === 'string' ? params.tab : '';
  return (TRIAL_TABS as readonly string[]).includes(requested)
    ? (requested as TrialTab)
    : 'overview';
}

/** タブの URL（追加の引数つき） */
export function trialHref(tab: TrialTab, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ tab, ...extra });
  return `${TRIAL_BASE}?${params.toString()}`;
}

/** 開いている作成・編集の欄（?new=1・?edit=1・?cases=1・?decision=1・?triage=1）があるか */
export function isAnyPanelOpen(params: Params): boolean {
  return ['new', 'edit', 'cases', 'decision', 'triage'].some((key) => params[key] === '1');
}
