/**
 * 取込プレビューで「いったん画面に出さない」と決めた警告。
 *
 * 「指標を特定できませんでした。手動で選択してください。」は、指標マスターに
 * 当たらなかった行すべてに付く。実務のファイルにはそういう行がいくらでも混ざるため、
 * プレビューが同じ文言で埋まり、単位違い・二重計上（合計行）・数値未検出といった
 * **本当に読んでほしい警告**がその山に埋もれていた。
 *
 * 指標欄が空であることは行を見れば分かるし、状態バッジも「要確認」のままなので、
 * この文言は無くても人が取るべき操作（指標を選ぶ）は変わらない。
 *
 * 判定そのものは消していない。行に保存された警告は今までどおりで、落とすのは表示だけ。
 * 出し直すときはこの配列から外せば戻る（発注者の指示は 2026-08-28 の「いったんすべて非表示」）。
 */

/** 指標が特定できなかった行に付く警告 */
export const METRIC_UNIDENTIFIED_WARNING = '指標を特定できませんでした。手動で選択してください。';

const HIDDEN_ROW_WARNINGS: readonly string[] = [METRIC_UNIDENTIFIED_WARNING];

/**
 * 画面へ出す警告だけを残す。
 *
 * 表示の直前で通すこと。取込時に落としてしまうと、Supabase に保存済みの行や、
 * ブラウザの sessionStorage に残っている取込プレビュー（`preview-store.ts`）には効かず、
 * 「前に取り込んだぶんだけ出続ける」ことになる。
 */
export function visibleRowWarnings(warnings: readonly string[]): string[] {
  return warnings.filter((warning) => !HIDDEN_ROW_WARNINGS.includes(warning));
}
