/**
 * 一覧の列表示状態（機能要件 UX-P0-004「列表示切替」・plan §1.12・§3.2 DataTable）。
 *
 * URL の `cols` クエリで「表示する列」を持つ（URL が正。サーバー描画で外した列は DOM に出さない）。
 *
 * この判定は Server Component（一覧ページ）から呼ぶため、
 * `'use client'` を付けた `components/shared/table-controls.tsx` ではなく
 * ここへ置いている（Client モジュールの関数はサーバーから呼べない）。
 */

/** 旧来の一覧（ColumnSelector）の判定: 未指定なら全列表示 */
export function isColumnVisible(
  colsParam: string | undefined,
  key: string,
  alwaysVisible: string[] = [],
): boolean {
  if (alwaysVisible.includes(key)) return true;
  if (!colsParam) return true;
  return colsParam.split(',').includes(key);
}

// ----------------------------------------------------------------------
// DataTable の列（importance で既定の表示を決める）
// ----------------------------------------------------------------------

export type ColumnImportance = 'primary' | 'secondary' | 'detail';

export interface ColumnVisibilitySpec {
  key: string;
  importance: ColumnImportance;
  /** 外せない列（例: 指標名） */
  lockVisible?: boolean;
}

/** 既定の表示列（primary と secondary。detail は「列 ▾」から出す） */
export function defaultColumnKeys(columns: readonly ColumnVisibilitySpec[]): string[] {
  return columns.filter((c) => c.importance !== 'detail' || c.lockVisible).map((c) => c.key);
}

/**
 * URL の cols から表示する列を決める。
 *  - cols が無い・空・知らない列だけ → 既定の列
 *  - 外せない列（lockVisible）は常に含める
 *  - 並びは列の定義の順（URL の順に左右されない）
 */
export function visibleColumnKeys(
  columns: readonly ColumnVisibilitySpec[],
  colsParam: string | string[] | undefined,
): string[] {
  const raw = Array.isArray(colsParam) ? colsParam.join(',') : (colsParam ?? '');
  const known = new Set(columns.map((c) => c.key));
  const requested = new Set(
    raw
      .split(',')
      .map((key) => key.trim())
      .filter((key) => known.has(key)),
  );
  if (requested.size === 0) return defaultColumnKeys(columns);
  return columns.filter((c) => c.lockVisible || requested.has(c.key)).map((c) => c.key);
}

/**
 * 表示する列の集合から cols の値を作る。既定と同じなら null（URL に cols を付けない）
 */
export function colsParamFor(
  columns: readonly ColumnVisibilitySpec[],
  visible: ReadonlySet<string>,
): string | null {
  const keys = columns.filter((c) => c.lockVisible || visible.has(c.key)).map((c) => c.key);
  const defaults = defaultColumnKeys(columns);
  const same = keys.length === defaults.length && keys.every((key, i) => key === defaults[i]);
  return same ? null : keys.join(',');
}

// ----------------------------------------------------------------------
// 表示件数（plan D9）
// ----------------------------------------------------------------------

export const DEFAULT_PAGE_SIZES = [25, 50, 100] as const;

/** ?size= から表示件数を決める（候補に無い値は既定） */
export function parsePageSize(
  sizeParam: string | string[] | undefined,
  sizes: readonly number[] = DEFAULT_PAGE_SIZES,
  fallback: number = sizes[0] ?? 25,
): number {
  const value = Number(Array.isArray(sizeParam) ? sizeParam[0] : sizeParam);
  return sizes.includes(value) ? value : fallback;
}

/** ?page= から 1 始まりのページ番号を決める（不正な値は 1） */
export function parsePage(pageParam: string | string[] | undefined): number {
  const value = Number(Array.isArray(pageParam) ? pageParam[0] : pageParam);
  return Number.isInteger(value) && value >= 1 ? value : 1;
}
