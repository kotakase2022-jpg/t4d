import { isRecord, LOCAL_KEYS, readLocal, writeLocal } from '@/lib/ui/local-store';

/**
 * 一覧の保存ビューと既定ビュー（plan §1.9・§3.2 DataTable・D8）。端末ごと・利用者ごと（localStorage）。
 *
 * - 保存ビュー: 利用者が名前を付けた URL の条件（絞り込み・並べ替え・列・表示件数）。共有は URL のコピー
 * - 既定ビュー: その一覧を「アプリ内のリンクから開いたとき」に付ける条件。描画の後に URL を書き換えない
 *   （サーバー描画と食い違ってずれる）。サイドバー・パレット・ホームのリンクを押した時点で付けて遷移する
 *   （useListNavigation）。直接の URL・ブックマークは既定の表示のまま
 * - 読み書きは try/catch（使えない環境でも描画は同じ）
 */

export interface TableViewStore {
  /** 既定ビューの条件（? の後ろ。空なら既定なし） */
  defaultQuery?: string;
  views: Array<{ name: string; query: string }>;
}

/** 一覧のパス → 既定ビューの条件（リンクを押したときに引くための索引） */
export type ListDefaultsIndex = Record<string, string>;

export const MAX_USER_VIEWS = 20;

/** 保存してよい条件か（引数の文字列だけ。ページ番号・通知・エラー・作成パネルは除く） */
export function sanitizeViewQuery(query: string): string {
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  for (const key of ['page', 'flash', 'error', 'new', 'confirm']) params.delete(key);
  return params.toString();
}

export function parseTableViewStore(raw: unknown): TableViewStore | null {
  if (!isRecord(raw)) return null;
  const views = Array.isArray(raw.views)
    ? raw.views
        .filter(
          (v): v is { name: string; query: string } =>
            isRecord(v) &&
            typeof v.name === 'string' &&
            v.name.trim() !== '' &&
            typeof v.query === 'string',
        )
        .slice(0, MAX_USER_VIEWS)
    : [];
  const defaultQuery = typeof raw.defaultQuery === 'string' ? raw.defaultQuery : undefined;
  return { views, ...(defaultQuery ? { defaultQuery } : {}) };
}

export function parseListDefaultsIndex(raw: unknown): ListDefaultsIndex | null {
  if (!isRecord(raw)) return null;
  const out: ListDefaultsIndex = {};
  for (const [path, query] of Object.entries(raw)) {
    if (path.startsWith('/') && typeof query === 'string' && query !== '') out[path] = query;
  }
  return out;
}

const DEFAULTS_INDEX_KEY = (viewerKey: string) => `t4d.table-defaults.v1.${viewerKey}`;

export function readTableViews(viewerKey: string, tableId: string): TableViewStore {
  return readLocal(LOCAL_KEYS.table(viewerKey, tableId), parseTableViewStore) ?? { views: [] };
}

export function writeTableViews(
  viewerKey: string,
  tableId: string,
  basePath: string,
  store: TableViewStore,
): void {
  writeLocal(LOCAL_KEYS.table(viewerKey, tableId), store);
  const index = readLocal(DEFAULTS_INDEX_KEY(viewerKey), parseListDefaultsIndex) ?? {};
  if (store.defaultQuery) index[basePath] = store.defaultQuery;
  else delete index[basePath];
  writeLocal(DEFAULTS_INDEX_KEY(viewerKey), index);
}

export function readListDefaults(viewerKey: string): ListDefaultsIndex {
  return readLocal(DEFAULTS_INDEX_KEY(viewerKey), parseListDefaultsIndex) ?? {};
}

/**
 * アプリ内のリンクの行き先に既定ビューを付ける。条件の無いリンク（例 /enterprise/data）だけに付ける
 * （条件付きのリンク＝タスク動詞の絞り込みなどは、その条件を優先する）
 */
export function applyListDefault(href: string, index: ListDefaultsIndex): string {
  const [pathAndQuery, hash] = href.split('#');
  const [path, query] = (pathAndQuery ?? '').split('?');
  if (!path || query) return href;
  const defaultQuery = index[path];
  if (!defaultQuery) return href;
  return `${path}?${defaultQuery}${hash !== undefined ? `#${hash}` : ''}`;
}
