/**
 * URL・フォームから受け取った ID が UUID の形か。
 *
 * Supabase Mode では uuid 列に UUID でない値を渡すと PostgREST が 22P02（invalid uuid）で失敗し、
 * 「見つからない」ではなく内部エラー（500）になる。Demo Mode は単に見つからないだけなので、
 * 形を先に確かめて両モードとも「見つからない」にそろえる。
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
