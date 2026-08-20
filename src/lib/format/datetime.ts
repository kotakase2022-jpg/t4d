import { DEFAULT_LOCALE, DEFAULT_TIMEZONE } from '@/lib/config';
import type { IsoDate, IsoDateTime } from '@/types/domain';

/**
 * DB は UTC（timestamptz）で保存し、表示は必ず Asia/Tokyo。
 * 直接 `toLocaleString()` を呼ばず、本モジュールを経由すること。
 */

const dateTimeFormatter = new Intl.DateTimeFormat(DEFAULT_LOCALE, {
  timeZone: DEFAULT_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dateFormatter = new Intl.DateTimeFormat(DEFAULT_LOCALE, {
  timeZone: DEFAULT_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function formatJst(value: IsoDateTime | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return dateTimeFormatter.format(date).replace(/\//g, '-');
}

export function formatJstDate(value: IsoDateTime | IsoDate | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value.length === 10 ? `${value}T00:00:00+09:00` : value);
  if (Number.isNaN(date.getTime())) return '—';
  return dateFormatter.format(date).replace(/\//g, '-');
}

/**
 * JST 基準の暦日差。`due` が過去なら負。
 * 日付境界（JST 00:00）で切り替わることを保証する。
 */
export function daysUntilJst(due: IsoDate | null | undefined, today: IsoDate): number | null {
  if (!due) return null;
  const dueUtc = Date.UTC(
    Number(due.slice(0, 4)),
    Number(due.slice(5, 7)) - 1,
    Number(due.slice(8, 10)),
  );
  const todayUtc = Date.UTC(
    Number(today.slice(0, 4)),
    Number(today.slice(5, 7)) - 1,
    Number(today.slice(8, 10)),
  );
  return Math.round((dueUtc - todayUtc) / 86_400_000);
}

export function isOverdue(due: IsoDate | null | undefined, today: IsoDate): boolean {
  const diff = daysUntilJst(due, today);
  return diff !== null && diff < 0;
}

/** UTC の ISO 文字列を JST の暦日（YYYY-MM-DD）へ変換する。 */
export function toJstDate(value: IsoDateTime): IsoDate {
  const date = new Date(value);
  const jst = new Date(date.getTime() + 9 * 3_600_000);
  return jst.toISOString().slice(0, 10);
}

const numberFormatter = new Intl.NumberFormat(DEFAULT_LOCALE, { maximumFractionDigits: 3 });

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return numberFormatter.format(value);
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

/**
 * AI 実行の概算コスト（USD）。
 *
 * 0 は「単価表に無い Model のため未算定」を意味する（`openai-provider.ts` の `COST_PER_MTOK`）。
 * `$0` と出すと「無料」と読めてしまうため「—」を返す。
 */
export function formatEstimatedCostUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value) || value === 0) return '—';
  return `$${value}`;
}
