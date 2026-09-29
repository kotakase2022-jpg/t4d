/**
 * 業務上の「今日」（期限・超過の判定の基準日）を 1 か所で決める
 * （docs/disclosure-first.md §2-5）。
 *
 * - Demo Mode（テストを含む）: `FIXTURE_TODAY`。
 *   Fixture の期限・日付はこの日を基準に作られているため、実時計で判定すると
 *   「あと 3 日」の作業が 45 日超過に見えるなど、デモの筋書きが崩れる。
 * - Supabase Mode: 実時計を組織のタイムゾーン（既定 Asia/Tokyo）の暦日にしたもの。
 *   これまで Supabase Mode でも `FIXTURE_TODAY` で判定しており、本番で期限を誤っていた
 *   （W0 棚卸し O5）。
 *
 * ここで決めるのは「期限の判定に使う暦日」だけ。記録の時刻（createdAt など）は
 * 従来どおり実時計の UTC で持つ（基準日を記録に混ぜると監査証跡の時刻が偽になる）。
 */

import { DEFAULT_TIMEZONE, FIXTURE_TODAY, getAppMode, type AppMode } from '@/lib/config';
import type { IsoDate } from '@/types/domain';

export interface ReferenceDateOptions {
  /** 組織のタイムゾーン（IANA 名）。未指定は Asia/Tokyo */
  timeZone?: string;
  /** 現在時刻の差し替え（テスト用）。未指定は実時計 */
  now?: Date;
}

/** 指定したタイムゾーンでの暦日（YYYY-MM-DD） */
export function todayInTimeZone(now: Date, timeZone: string = DEFAULT_TIMEZONE): IsoDate {
  // en-CA は年-月-日の並びで数値を返すため、部品から組み立てても桁が揃う
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: 'year' | 'month' | 'day') => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * 期限・超過の判定に使う基準日。
 * `mode` を省略すると現在の動作モード（`getAppMode()`）で決める。
 */
export function getReferenceDate(
  mode: AppMode = getAppMode(),
  options: ReferenceDateOptions = {},
): IsoDate {
  if (mode === 'demo') return FIXTURE_TODAY;
  return todayInTimeZone(options.now ?? new Date(), options.timeZone ?? DEFAULT_TIMEZONE);
}

/** 業務上の今日。組織のタイムゾーンを持つ呼び出し向けの入口（モードは省略可） */
export function businessToday(options: ReferenceDateOptions & { mode?: AppMode } = {}): IsoDate {
  return getReferenceDate(options.mode ?? getAppMode(), options);
}

export interface ReferenceDateInfo {
  date: IsoDate;
  /** fixture = デモの基準日（固定）／ clock = 実時計 */
  source: 'fixture' | 'clock';
  /** 画面に出す表示。デモでは基準日が固定であることを必ず示す。実時計では出さない */
  label: string | null;
}

/** 基準日と、その出所の表示（デモでは「デモ基準日 2026-08-14」） */
export function describeReferenceDate(
  mode: AppMode = getAppMode(),
  options: ReferenceDateOptions = {},
): ReferenceDateInfo {
  const date = getReferenceDate(mode, options);
  return mode === 'demo'
    ? { date, source: 'fixture', label: `デモ基準日 ${date}` }
    : { date, source: 'clock', label: null };
}
