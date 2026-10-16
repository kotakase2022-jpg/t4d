import type { ReportingPeriod } from '@/types/domain';

/**
 * 期間の比べ方（plan K10・CR-17）。純関数。
 *
 * 同じ組織に年度（4〜3 月）と暦年（1〜12 月）の期間が並ぶと、「前年」「推移」を開始日・終了日の順だけで決めたとき
 * 暦年の期間が年度の推移・前年比に入り込む（例: FY2025 の前年が CY2025 になる）。前年・推移は
 * **決算日（終了日の月日）が同じ期間どうし**に限る。
 *
 * 決算日は文字列の一致ではなく、1 年の中の位置の近さ（前後 FISCAL_YEAR_END_TOLERANCE_DAYS 日以内）で比べる。
 * 2 月末決算はうるう年に 02-29 になり、52/53 週の年度（例: 1 月末〜2 月初めの土曜日）は決算日が年ごとに数日ずれる。
 * 文字列で比べると、これらの組織では前年が 2 年前になったり、前年が無いことになったりする（自己監査 F3）。
 */

type PeriodLike = Pick<ReportingPeriod, 'id' | 'organizationId' | 'startDate' | 'endDate'>;

/** 同じ決算日とみなす近さ（日）。52/53 週の年度のずれ（最大 6 日）と、うるう年の 2 月末（1 日）が入る */
export const FISCAL_YEAR_END_TOLERANCE_DAYS = 7;

/** うるう年の暦で数えた月初の日の位置（0 始まり）。02-29 も 1 つの位置を持つ */
const MONTH_OFFSETS = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
const DAYS_IN_CYCLE = 366;

/** 決算日（終了日の月日。例 '03-31'） */
export function fiscalYearEnd(period: Pick<ReportingPeriod, 'endDate'>): string {
  return period.endDate.slice(5, 10);
}

/** 月日の 1 年の中の位置（うるう年の暦で 0〜365）。読めなければ null */
function positionInYear(monthDay: string): number | null {
  const match = /^(\d{2})-(\d{2})$/.exec(monthDay);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const offset = MONTH_OFFSETS[month - 1];
  if (offset === undefined || day < 1 || day > 31) return null;
  return offset + day - 1;
}

/** 決算日が同じか（1 年の中の位置の差が前後 FISCAL_YEAR_END_TOLERANCE_DAYS 日以内。年をまたぐ差も数える） */
export function sameFiscalYearEnd(
  a: Pick<ReportingPeriod, 'endDate'>,
  b: Pick<ReportingPeriod, 'endDate'>,
): boolean {
  const pa = positionInYear(fiscalYearEnd(a));
  const pb = positionInYear(fiscalYearEnd(b));
  if (pa === null || pb === null) return fiscalYearEnd(a) === fiscalYearEnd(b);
  const diff = Math.abs(pa - pb);
  return Math.min(diff, DAYS_IN_CYCLE - diff) <= FISCAL_YEAR_END_TOLERANCE_DAYS;
}

/**
 * 前年の期間: 同じ組織・同じ決算日で、`by` の比べ方で前にある期間のうち最新。
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
