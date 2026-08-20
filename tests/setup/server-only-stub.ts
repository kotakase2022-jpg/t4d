/**
 * `server-only` のテスト用スタブ。
 *
 * 本番ビルドでは `server-only` が Client Component からの import を検出して失敗させる。
 * Vitest（Node / happy-dom）にはその区別がないため、テスト時だけ無害なモジュールへ差し替える。
 * Client Bundle への混入検出は `next build` が担う。
 */
export {};
