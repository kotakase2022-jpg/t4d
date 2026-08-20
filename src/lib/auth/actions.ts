'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { recordAuditEvent } from '@/lib/audit/logger';
import { getAppMode } from '@/lib/config';
import { getDb } from '@/lib/repositories';
import { DEMO_USER_COOKIE, WORKSPACE_COOKIE, getSession, homePathFor } from './session';

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 60 * 60 * 8,
} as const;

/**
 * Demo ログイン。**Demo Mode でのみ有効**。
 * 本番 Auth（Supabase Auth）とは完全に別経路（assumptions C-7）。
 */
export async function demoLoginAction(formData: FormData): Promise<void> {
  if (getAppMode() !== 'demo') {
    throw new Error('Demo ログインは Demo Mode でのみ利用できます。');
  }
  const email = String(formData.get('email') ?? '').trim();
  if (!email.endsWith('@demo.local')) {
    throw new Error('Demo アカウント（@demo.local）を選択してください。');
  }

  const db = await getDb();
  const profiles = await db.select('profiles', { where: { email }, limit: 1 });
  const profile = profiles[0];
  if (!profile) {
    await recordAuditEvent(db, null, {
      eventType: 'login_failure',
      resourceType: 'profile',
      metadata: { reason: 'unknown_demo_account' },
    });
    throw new Error('該当する Demo アカウントが見つかりません。');
  }

  const cookieStore = await cookies();
  cookieStore.set(DEMO_USER_COOKIE, email, COOKIE_OPTS);
  cookieStore.delete(WORKSPACE_COOKIE);

  await recordAuditEvent(db, null, {
    eventType: 'login_success',
    resourceType: 'profile',
    resourceId: profile.id,
    metadata: { mode: 'demo' },
  });

  redirect('/workspace');
}

/**
 * Supabase Auth（メール + パスワード）でのログイン。
 * Supabase Mode でのみ有効。セッション Cookie は @supabase/ssr が設定する。
 */
export async function supabaseLoginAction(formData: FormData): Promise<void> {
  if (getAppMode() !== 'supabase') {
    throw new Error('このログイン方法は Supabase Mode でのみ利用できます。');
  }

  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!email || !password) {
    throw new Error('メールアドレスとパスワードを入力してください。');
  }

  const { createSupabaseServerClient } = await import('@/lib/supabase/server');
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  const db = await getDb();
  if (error || !data.session) {
    await recordAuditEvent(db, null, {
      eventType: 'login_failure',
      resourceType: 'profile',
      // メールアドレス自体は PII のため保存しない
      metadata: { reason: 'invalid_credentials' },
    });
    throw new Error('メールアドレスまたはパスワードが正しくありません。');
  }

  await recordAuditEvent(db, null, {
    eventType: 'login_success',
    resourceType: 'profile',
    resourceId: data.user.id,
    metadata: { mode: 'supabase' },
  });

  // MFA 登録済みなら、コード検証（AAL2）を済ませるまでワークスペースへ入れない
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
    redirect('/mfa');
  }

  redirect('/workspace');
}

export async function logoutAction(): Promise<void> {
  const db = await getDb();
  const session = await getSession();
  await recordAuditEvent(db, session?.context ?? null, { eventType: 'logout' });

  const cookieStore = await cookies();
  cookieStore.delete(DEMO_USER_COOKIE);
  cookieStore.delete(WORKSPACE_COOKIE);

  if (getAppMode() === 'supabase') {
    const { createSupabaseServerClient } = await import('@/lib/supabase/server');
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  }

  redirect('/login');
}

export async function selectWorkspaceAction(formData: FormData): Promise<void> {
  const organizationId = String(formData.get('organizationId') ?? '');
  const session = await getSession();
  if (!session) redirect('/login');

  const target = session.workspaces.find((w) => w.organizationId === organizationId);
  if (!target) {
    throw new Error('選択されたワークスペースへのアクセス権がありません。');
  }

  const cookieStore = await cookies();
  cookieStore.set(WORKSPACE_COOKIE, organizationId, COOKIE_OPTS);

  const db = await getDb();
  await recordAuditEvent(
    db,
    {
      userId: session.profile.id,
      email: session.profile.email,
      displayName: session.profile.displayName,
      workspace: {
        organizationId: target.organizationId,
        organizationType: target.organizationType,
        organizationName: target.organizationName,
        roleKeys: target.roleKeys,
        unitScopeIds: target.unitScopeIds,
      },
      engagementIds: [],
      demo: getAppMode() === 'demo',
    },
    { eventType: 'workspace_selected', resourceType: 'organization', resourceId: organizationId },
  );

  redirect(homePathFor(target.organizationType));
}

/**
 * 招待の受諾（AUTH-P0-001）。
 * Demo Mode では受諾と同時にログインさせる（@demo.local のみ。Demo ログインの制約に合わせる）。
 * Supabase Mode ではメンバー登録のみ行い、ログインは通常の認証を通す。
 */
export async function acceptInvitationAction(formData: FormData): Promise<void> {
  const { acceptInvitation } = await import('@/lib/services/identity');
  const { getInvitationAcceptDb } = await import('@/lib/repositories');
  // 受諾者はまだメンバーではないため RLS 下では profiles / memberships を書けない。
  // 招待 ID を唯一の資格として、この経路だけ RLS を越えて処理する。
  const db = await getInvitationAcceptDb();

  const password = String(formData.get('password') ?? '');
  const result = await acceptInvitation(db, {
    invitationId: String(formData.get('invitationId') ?? ''),
    displayName: String(formData.get('displayName') ?? ''),
    password: password || undefined,
  });

  if (getAppMode() === 'demo' && result.email.endsWith('@demo.local')) {
    const cookieStore = await cookies();
    cookieStore.set(DEMO_USER_COOKIE, result.email, COOKIE_OPTS);
    cookieStore.delete(WORKSPACE_COOKIE);
    redirect('/workspace');
  }
  redirect('/login?joined=1');
}
