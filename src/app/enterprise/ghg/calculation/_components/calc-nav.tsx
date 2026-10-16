import { NavTabs, type NavTabItem } from '@/components/shared/nav-tabs';
import type { GhgVerificationStatus } from '@/lib/services/ghg/status';

/**
 * Scope1・2 の算定の作業領域のタブ（plan K2）。メニューの葉は「Scope1・2算定」1 つだけにし、
 * 下位の画面（係数・ルール・活動量・照合）はここから届かせる。
 * 件数は要対応のときだけ出す（「要対応 n」。色だけにしない）。数え方は services/ghg/status.ts と同じ
 */
export const CALC_TAB_KEYS = [
  'overview',
  'factors',
  'rules',
  'activity',
  'reconciliation',
] as const;
export type CalcTabKey = (typeof CALC_TAB_KEYS)[number];

export const CALC_BASE_PATH = '/enterprise/ghg/calculation';

// 行き先は文字列のまま書く（tests/unit/route-reachability.test.ts がリンクの文字列から到達性を数える）
const TAB_PATH: Record<CalcTabKey, string> = {
  overview: '/enterprise/ghg/calculation',
  factors: '/enterprise/ghg/calculation/factors',
  rules: '/enterprise/ghg/calculation/rules',
  activity: '/enterprise/ghg/calculation/activity',
  reconciliation: '/enterprise/ghg/calculation/reconciliation',
};

/** 詳細画面の行き先（P92・P95・P96・P98。スライスの一覧の行から使う） */
export const CALC_DETAIL_HREF = {
  factorSet: (setId: string) => `/enterprise/ghg/calculation/factors/${encodeURIComponent(setId)}`,
  activityBatch: (batchId: string) =>
    `/enterprise/ghg/calculation/activity/${encodeURIComponent(batchId)}`,
  run: (runId: string) => `/enterprise/ghg/calculation/runs/${encodeURIComponent(runId)}`,
  reconciliation: (id: string) =>
    `/enterprise/ghg/calculation/reconciliation/${encodeURIComponent(id)}`,
} as const;

const TAB_LABEL: Record<CalcTabKey, string> = {
  overview: '概要',
  factors: '排出係数',
  rules: '算定ルール',
  activity: '活動量',
  reconciliation: '照合',
};

/** タブの行き先（期間を引き継ぐ。トライアルの検証期間と違う期間を見ているときに戻されないように） */
export function calcTabHref(key: CalcTabKey, periodId?: string | null): string {
  const path = TAB_PATH[key];
  return periodId ? `${path}?period=${encodeURIComponent(periodId)}` : path;
}

/** タブの件数（要対応だけ）。status が無い（読めない）ときは件数を出さない */
export function calcTabItems(
  attention: GhgVerificationStatus['attention'] | null,
  periodId?: string | null,
): NavTabItem[] {
  const counts: Partial<Record<CalcTabKey, number>> = attention
    ? {
        factors: attention.unresolvedLines,
        rules: attention.pendingRules,
        activity: attention.draftBatches,
        reconciliation: attention.reconciliationNeedsReview,
      }
    : {};
  return CALC_TAB_KEYS.map((key) => {
    const count = counts[key] ?? 0;
    return {
      key,
      label: TAB_LABEL[key],
      href: calcTabHref(key, periodId),
      ...(count > 0 ? { count, attention: true } : {}),
    };
  });
}

export function CalcNav({
  current,
  periodId,
  attention,
}: {
  current: CalcTabKey;
  periodId?: string | null;
  attention: GhgVerificationStatus['attention'] | null;
}) {
  return (
    <NavTabs
      ariaLabel="Scope1・2算定の画面"
      items={calcTabItems(attention, periodId)}
      current={current}
    />
  );
}
