import 'server-only';

import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { getServiceRoleKey, getSupabasePublicConfig } from '@/lib/config';

/**
 * Server Component / Server Action / Route Handler 用の Supabase クライアント。
 * ユーザーの JWT で動作するため **RLS が有効**。
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const config = getSupabasePublicConfig();
  if (!config) {
    throw new Error(
      'Supabase 環境変数が設定されていません。NEXT_PUBLIC_APP_MODE=demo で起動するか、.env.local を設定してください。',
    );
  }
  const cookieStore = await cookies();
  return createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(
        cookiesToSet: Array<{ name: string; value: string; options?: Record<string, unknown> }>,
      ) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Component からの呼び出しでは set が禁止される。
          // middleware 側でセッション更新するため無視してよい。
        }
      },
    },
  });
}

/**
 * Service Role クライアント。**RLS をバイパスする**ため使用箇所を厳しく限定する。
 *
 * 許可される用途（指示書 11-14）:
 *  - 監査ログの追記（audit_events）
 *  - 非同期 Job のワーカー処理
 *  - Signed URL 発行前の権限検証済みアクセス
 *
 * 呼び出し側は必ず事前にアプリ層の認可（assertCan*）を通すこと。
 */
export function createSupabaseServiceRoleClient(): SupabaseClient {
  const config = getSupabasePublicConfig();
  const serviceRoleKey = getServiceRoleKey();
  if (!config || !serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY が設定されていません。');
  }
  // ファイル冒頭の `import 'server-only'` により、Client Bundle へ混入した場合は
  // ビルド時点で失敗する。
  return createClient(config.url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
