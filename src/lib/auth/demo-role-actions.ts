'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { recordAuditEvent } from '@/lib/audit/logger';
import { getAppMode } from '@/lib/config';
import { withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import { safeAppLinkOrNull } from '@/lib/security/safe-link';
import { resolveDemoRoleSwitch } from './demo-role';
import { DEMO_USER_COOKIE, homePathFor, requireContext } from './session';

/** demoLoginAction（./actions.ts）と同じ Cookie 属性。有効期限もログインと揃える */
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 60 * 60 * 8,
} as const;

/**
 * デモの役割切替（ヘッダーのメニューから呼ぶ）。
 *
 * - Supabase Mode では画面に出さないだけでなく、ここでも拒否する（直接呼ばれても通さない）
 * - 切替先の検証は resolveDemoRoleSwitch（同じ組織・@demo.local のみ）
 * - ワークスペース Cookie は残す（同じ組織のままなので選び直させない）
 * - デモ操作の持ち回り Cookie（t4d.demo-edits）には触れない（切替の前後でデモの状態が続く）
 * - 戻り先は /enterprise/ 配下の安全なパスだけ（外部 URL へは飛ばさない）
 */
export async function switchDemoRoleAction(formData: FormData): Promise<void> {
  if (getAppMode() !== 'demo') {
    throw new Error('役割の切替はデモ環境でのみ利用できます。');
  }
  const ctx = await requireContext();
  const db = await getDb();
  const home = homePathFor(ctx.workspace.organizationType);
  const returnTo = safeAppLinkOrNull(String(formData.get('returnTo') ?? '')) ?? home;

  await withUserFacingError(returnTo, async () => {
    const target = await resolveDemoRoleSwitch(db, ctx, String(formData.get('email') ?? ''));

    const cookieStore = await cookies();
    cookieStore.set(DEMO_USER_COOKIE, target.email, COOKIE_OPTS);

    await recordAuditEvent(db, null, {
      eventType: 'login_success',
      resourceType: 'profile',
      resourceId: target.userId,
      metadata: { mode: 'demo', method: 'demo_role_switch', fromUserId: ctx.userId },
    });

    redirect(returnTo);
  });
}
