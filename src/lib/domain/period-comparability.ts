import type { ReportingPeriod } from '@/types/domain';

/**
 * 期間の比べ方（plan K10・CR-17）。純関数。
 *
 * 同じ組織に年度（4〜3 月）と暦年（1〜12 月）の期間が並ぶと、「前年」「推移」を開始日・終了日の順だけで決めたとき
 * 暦年の期間が年度の推移・前年比に入り込む（例: FY2025 の前年が CY2025 になる）。前年・推移は
 * **決算月（終了日の月日）が同じ期間どうし**に限る。
 */

type PeriodLike = Pick<ReportingPeriod, 'id' | 'organizationId' | 'startDate' | 'endDate'>;

/** 決算月（終了日の月日。例 '03-31'） */
export function fiscalYearEnd(period: Pick<ReportingPeriod, 'endDate'>): string {
  return period.endDate.slice(5);
}

/** 決算月が同じか */
export function sameFiscalYearEnd(
  a: Pick<ReportingPeriod, 'endDate'>,
  b: Pick<ReportingPeriod, 'endDate'>,
): boolean {
  return fiscalYearEnd(a) === fiscalYearEnd(b);
}

/**
 * 前年の期間: 同じ組織・同じ決算月で、`by` の比べ方で前にある期間のうち最新。
 *  - 'end': 終了日が現在の期間の開始日より前（集計・前年の複写）
 *  - 'start': 開始日が現在の期間の開始日より前（検証・開示の前年）
 */
export function previousComparablePeriod<T extends PeriodLike>(
  period: PeriodLike,
  periods: readonly T[],
  by: 'end' | 'start' = 'end',
): T | null {
  const candidates = periods.filter(
    (p) =>
      p.id !== period.id &&
      p.organizationId === period.organizationId &&
      sameFiscalYearEnd(p, period) &&
      (by === 'end' ? p.endDate < period.startDate : p.startDate < period.startDate),
  );
  candidates.sort((a, b) =>
    by === 'end' ? (a.endDate < b.endDate ? 1 : -1) : a.startDate < b.startDate ? 1 : -1,
  );
  return candidates[0] ?? null;
}
