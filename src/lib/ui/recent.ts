import { isRecord } from './local-store';

/**
 * 最近使った画面（plan §1.9 Recognition over Recall）。どこにあったかを覚えさせず、
 * Command Palette の先頭に出す。端末ごと・利用者ごと（localStorage）。
 */

export interface RecentItem {
  href: string;
  /** 画面の見出し（main の h1） */
  label: string;
  /** 開いた日時（ISO 8601） */
  at: string;
}

export const RECENT_LIMIT = 20;

/**
 * 一度きりの引数。最近の画面から開き直したときに、頼んでいない確認ダイアログ（?confirm=）・
 * 作成／編集の欄（?new= ?edit= ?team=）・結果の通知（?flash= ?snapshotCreated= ?outputError=）・
 * エラー（?error= と合言葉 ?et=）をもう一度出さないよう外す。
 * 絞り込み・並べ替え・タブ・列など、画面の見え方を決める引数は残す
 */
const TRANSIENT_PARAMS = [
  'flash',
  'error',
  'et',
  'confirm',
  'new',
  'edit',
  'team',
  'snapshotCreated',
  'outputError',
  'imported',
  'linked',
] as const;

/** 結果の通知（?flash=）に添えて送る引数。flash と一緒のときだけ外す（単独では別の意味のことがある） */
const FLASH_COMPANION_PARAMS = [
  'added',
  'ai',
  'analyzed',
  'copied',
  'count',
  'decision',
  'grantId',
  'impacted',
  'name',
  'no',
  'notified',
  'recheck',
  'removed',
  'restored',
  'rows',
  'state',
  'v',
  'version',
  'warnings',
] as const;

export function sanitizeRecentHref(pathname: string, search: string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (params.has('flash')) for (const key of FLASH_COMPANION_PARAMS) params.delete(key);
  // 出力タブの「作成しました」の種類（snapshotCreated と組で使う）
  if (params.has('snapshotCreated')) params.delete('kind');
  for (const key of TRANSIENT_PARAMS) params.delete(key);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** 新しいものを先頭に足し、同じ行き先は 1 つにまとめ、上限で切る */
export function addRecentItem(
  list: readonly RecentItem[],
  item: RecentItem,
  limit = RECENT_LIMIT,
): RecentItem[] {
  return [item, ...list.filter((existing) => existing.href !== item.href)].slice(0, limit);
}

/** localStorage から読んだ値を検証する（壊れた値・古い形は捨てる） */
export function parseRecentItems(raw: unknown): RecentItem[] | null {
  if (!Array.isArray(raw)) return null;
  return raw
    .filter(
      (value): value is RecentItem =>
        isRecord(value) &&
        typeof value.href === 'string' &&
        value.href.startsWith('/') &&
        !value.href.startsWith('//') &&
        typeof value.label === 'string' &&
        value.label.trim() !== '' &&
        typeof value.at === 'string',
    )
    .slice(0, RECENT_LIMIT);
}
