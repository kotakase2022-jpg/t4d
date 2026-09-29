import 'server-only';

import { can } from '@/lib/authorization/can';
import { getAppMode } from '@/lib/config';
import type { AuthorizationContext } from '@/types/domain';
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
    const { readDemoEdits, applyDemoEdits, ensureDemoResetBaseline } =
      await import('./demo-persistence');
    const { getDemoDb } = await import('@/lib/fixtures/store');
    // リセットの基準時刻は、メモリが Cookie の操作を受け取り始める前に決める。これより後のリセットの印は、
    // このインスタンスのメモリに入った操作より新しいので反映が要る
    ensureDemoResetBaseline();
    // 別のインスタンスで行った開示デモのリセットは、ここでは反映しない。印は署名の無い Cookie で、
    // ログイン前に反映すると、誰でも任意の組織のデモ状態を消せてしまう（applyPendingDemoResetFor）
    const edits = await readDemoEdits();
    if (edits.length > 0) applyDemoEdits(getDemoDb(), edits);
    return new DemoDbClient();
  }
  const { createSupabaseServerClient } = await import('@/lib/supabase/server');
  return new SupabaseDbClient(await createSupabaseServerClient());
}

/**
 * 別のインスタンスで行った開示デモのリセットを、このインスタンスのメモリにも反映する（Demo Mode のみ）。
 *
 * 印（t4d.demo-reset）は署名の無い Cookie のため、ログインした利用者の組織が印の組織と同じで、
 * その組織で開示の編集権限（リセットの操作と同じ enterprise.disclosure.write）を持つときだけ反映する。
 * getSession が利用者を解決した後に呼ぶ。戻したあと、この利用者の Cookie の操作（リセット後の操作）を
 * 改めて適用する（getDb が先に適用した分は、戻したときに消えるため）
 */
export async function applyPendingDemoResetFor(ctx: AuthorizationContext): Promise<boolean> {
  if (getAppMode() !== 'demo') return false;
  const { pendingDemoReset, markDemoResetApplied, readDemoEdits, applyDemoEdits } =
    await import('./demo-persistence');
  const reset = await pendingDemoReset();
  if (!reset) return false;
  if (
    ctx.workspace.organizationId !== reset.organizationId ||
    !can(ctx, 'enterprise.disclosure.write')
  ) {
    return false;
  }
  const { getDemoDb, createFixtureDb } = await import('@/lib/fixtures/store');
  const { restoreDisclosureDemoTables } = await import('./demo-reset-sync');
  const db = getDemoDb();
  restoreDisclosureDemoTables(db, pristineFixture(createFixtureDb), reset.organizationId, {
    includeDataPoints: reset.includesDataPoints === true,
  });
  const edits = await readDemoEdits();
  if (edits.length > 0) applyDemoEdits(db, edits);
  markDemoResetApplied(reset);
  return true;
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
