import 'server-only';

import type { DbClient } from './types';

/**
 * 共有レポートの写し（shared_report_copies）を書く DbClient。
 *
 * 写しは保証側に「社内承認済み版」として見せる本文なので、利用者の JWT には INSERT を許さない
 * （0059。利用者が PostgREST から自分で書いた内容・ハッシュの写しを作れないようにする）。
 * Supabase Mode では Service Role で書く。Demo Mode は RLS が無いため、そのままの db を使う。
 *
 * 呼び出し側（src/lib/services/report-share.ts の shareReportSnapshot）は、権限・許諾・承認版の整合を
 * 確かめ、写しをサーバーで承認版から作った後にだけ使うこと（指示書 11-14 の Service Role の許可用途:
 * 権限検証済みの書込）。index.ts と分けているのは、getDb を差し替えるテストの mock に影響されないため。
 */
export async function sharedReportCopyWriter(db: DbClient): Promise<DbClient> {
  if (db.mode === 'demo') return db;
  const [{ createSupabaseServiceRoleClient }, { SupabaseDbClient }] = await Promise.all([
    import('@/lib/supabase/server'),
    import('./supabase-client'),
  ]);
  return new SupabaseDbClient(createSupabaseServiceRoleClient());
}
