import type { IsoDate } from '@/types/domain';

/**
 * 返却・削除とバックアップの残存（2026-10-16 の要望 ⑦・plan CR-26）。DB にも画面にも依存しない純関数だけ。
 *
 *  - 消去の見込み日 = 削除日 + 残存期間（暦日）。DB の終了処理（0060 の t4d.offboard_organization）と同じ足し方
 *    （JST の日付に日数を足す）。日付だけを扱い、時刻・時差を持ち込まない
 *  - 残存期間が未合意（null）なら見込み日を出さない（推測しない）
 *  - 文はデータの取扱い・トライアル概要・返却の README・削除完了の報告で同じものを使う
 */

/** バックアップの残存期間の上限（0060 の CHECK と同じ） */
export const BACKUP_RESIDUAL_DAYS_MAX = 400;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** 0〜400 の整数か（0060 の CHECK と同じ） */
export function isBackupResidualDays(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= BACKUP_RESIDUAL_DAYS_MAX
  );
}

/** 実在する日付（YYYY-MM-DD）か。2027-02-29 などは偽 */
export function isCalendarDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** 日付に暦日を足す（月末・うるう年は暦どおり） */
export function addCalendarDays(date: IsoDate, days: number): IsoDate {
  if (!isCalendarDate(date)) throw new RangeError(`日付を読めません: ${date}`);
  if (!Number.isInteger(days)) throw new RangeError(`日数は整数にしてください: ${days}`);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(
    t.getUTCDate(),
  ).padStart(2, '0')}`;
}

/**
 * バックアップから消える見込み日（削除日 + 残存期間）。削除日か残存期間が無ければ null（推測しない）。
 * 残存期間が 0〜400 の整数でなければ null（DB の CHECK の外の値で日付を作らない）
 */
export function backupPurgeDueOn(
  deletedOn: IsoDate | null | undefined,
  days: number | null | undefined,
): IsoDate | null {
  if (!deletedOn || days === null || days === undefined) return null;
  if (!isBackupResidualDays(days) || !isCalendarDate(deletedOn)) return null;
  return addCalendarDays(deletedOn, days);
}

/** 削除の後のバックアップの扱い（固定の文。合意した日数を入れる。未合意ならそう書く） */
export function backupResidualText(days: number | null | undefined): string {
  return isBackupResidualDays(days)
    ? `削除の後も、バックアップには通常の保存期間（合意: ${days} 日）残ります。期間の終了後に消え、それまで秘密情報として管理します。`
    : '削除の後も、バックアップには通常の保存期間残ります（残存期間は未合意です）。期間の終了後に消え、それまで秘密情報として管理します。';
}

/** 日数の表示（「35 日」／「未合意」） */
export function backupResidualLabel(days: number | null | undefined): string {
  return isBackupResidualDays(days) ? `${days} 日` : '未合意';
}
