/**
 * 一覧の列表示状態（機能要件 UX-P0-004「列表示切替」）。
 *
 * URL の `cols` クエリで「表示する列」を持つ。未指定なら全列表示。
 *
 * この判定は Server Component（一覧ページ）から呼ぶため、
 * `'use client'` を付けた `components/shared/table-controls.tsx` ではなく
 * ここへ置いている（Client モジュールの関数はサーバーから呼べない）。
 */
export function isColumnVisible(
  colsParam: string | undefined,
  key: string,
  alwaysVisible: string[] = [],
): boolean {
  if (alwaysVisible.includes(key)) return true;
  if (!colsParam) return true;
  return colsParam.split(',').includes(key);
}
