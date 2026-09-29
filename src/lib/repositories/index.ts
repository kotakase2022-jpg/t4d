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
    // Demo Mode の状態はプロセスのメモリにしか無い（known-limitations D-3）。
    // Vercel で別インスタンスに当たっても直前の操作が消えないよう、
    // Cookie に控えた変更を Fixture へ再適用してから返す。
    const { readDemoEdits, applyDemoEdits, pendingDemoReset, markDemoResetApplied } =
      await import('./demo-persistence');
    const { getDemoDb, createFixtureDb } = await import('@/lib/fixtures/store');
    // 別のインスタンスで開示デモをリセットしていれば、このインスタンスのメモリも同じ範囲を
    // Fixture の初期値へ戻してから Cookie を適用する（リセット前の状態を見せ続けない）
    const reset = await pendingDemoReset();
    if (reset) {
      const { restoreDisclosureDemoTables } = await import('./demo-reset-sync');
      restoreDisclosureDemoTables(
        getDemoDb(),
        pristineFixture(createFixtureDb),
        reset.organizationId,
      );
      markDemoResetApplied(reset);
    }
    const edits = await readDemoEdits();
    if (edits.length > 0) applyDemoEdits(getDemoDb(), edits);
    return new DemoDbClient();
  }
  const { createSupabaseServerClient } = await import('@/lib/supabase/server');
  return new SupabaseDbClient(await createSupabaseServerClient());
}

/** リセットの反映に使う Fixture の初期値（書き換えない。行は写してから使う） */
function pristineFixture<T>(create: () => T): T {
  const g = globalThis as unknown as { __t4dPristineFixture?: T };
  g.__t4dPristineFixture ??= create();
  return g.__t4dPristineFixture;
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
