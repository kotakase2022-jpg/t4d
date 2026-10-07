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

/** 結果の通知・エラーの引数は、もう一度開いたときに同じ通知を出さないよう外す */
const TRANSIENT_PARAMS = ['flash', 'error'] as const;

export function sanitizeRecentHref(pathname: string, search: string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
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
