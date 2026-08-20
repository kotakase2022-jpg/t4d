import 'server-only';

import { getAppMode } from '@/lib/config';
import { DemoDbClient } from './demo-client';
import { SupabaseDbClient } from './supabase-client';
import type { DbClient } from './types';

/**
 * 動作モードに応じた DbClient を返す。
 * 呼び出し側（Service 層）は具象を知らない。
 */
export async function getDb(): Promise<DbClient> {
  if (getAppMode() === 'demo') {
    return new DemoDbClient();
  }
  const { createSupabaseServerClient } = await import('@/lib/supabase/server');
  return new SupabaseDbClient(await createSupabaseServerClient());
}

/**
 * **RLS をバイパスする** DbClient。用途を招待受諾フロー（未認証の入口）に限定する。
 *
 * 招待リンクを開くのは「まだこの組織のメンバーではない人」なので、RLS 下の anon /
 * 他組織ユーザーでは招待行を読めず、profiles / memberships も書けない。
 * 招待 ID（CSPRNG の UUID）を知っていることを唯一の資格として、
 * サーバー側でのみ RLS を越えて処理する。
 *
 * 呼び出し側は「招待 ID の有効性（pending・期限内）」以外の入力を信頼しないこと。
 */
export async function getInvitationAcceptDb(): Promise<DbClient> {
  if (getAppMode() === 'demo') {
    return new DemoDbClient();
  }
  const { createSupabaseServiceRoleClient } = await import('@/lib/supabase/server');
  return new SupabaseDbClient(createSupabaseServiceRoleClient());
}

export { DemoDbClient, SupabaseDbClient };
export type { DbClient } from './types';
