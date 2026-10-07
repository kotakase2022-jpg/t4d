import type { ReportingPeriod } from '@/types/domain';

/**
 * 報告年度の追加フォームの既定値（plan §1.8 D12: 次の報告年度は最新の期間＋1 年）。
 * システムが知っている値（前年の年度コード・期間・提出期限）を人に打たせない。
 * 最新は開始日が最も新しい期間。値はすべて上書きできる（既定値は推測しない範囲に留める）。
 */
export interface PeriodDefaults {
  code: string;
  label: string;
  startDate: string;
  endDate: string;
  submissionDueDate: string;
}

const EMPTY: PeriodDefaults = {
  code: '',
  label: '',
  startDate: '',
  endDate: '',
  submissionDueDate: '',
};

/** 文字列の中の 4 桁の西暦をすべて 1 年進める（FY2026 → FY2027、2026年度（2026-04-01〜…）） */
function bumpYears(text: string): string {
  return text.replace(/(?<!\d)(\d{4})(?!\d)/g, (year) => String(Number(year) + 1));
}

function parseDate(iso: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function format(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 1 年後の同じ日（2 月 29 日は翌年に無いので 2 月 28 日） */
function addOneYear(iso: string | null): string {
  const date = iso ? parseDate(iso) : null;
  if (!date) return '';
  const y = date.y + 1;
  return format(y, date.m, Math.min(date.d, daysInMonth(y, date.m)));
}

/** 翌日 */
function nextDay(iso: string): string {
  const date = parseDate(iso);
  if (!date) return '';
  const next = new Date(Date.UTC(date.y, date.m - 1, date.d + 1));
  return format(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

export function nextPeriodDefaults(periods: readonly ReportingPeriod[]): PeriodDefaults {
  const latest = [...periods].sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
  if (!latest) return EMPTY;
  return {
    code: bumpYears(latest.code),
    label: bumpYears(latest.label),
    startDate: nextDay(latest.endDate),
    endDate: addOneYear(latest.endDate),
    submissionDueDate: addOneYear(latest.submissionDueDate),
  };
}
