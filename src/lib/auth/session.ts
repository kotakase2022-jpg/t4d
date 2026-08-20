import 'server-only';

import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAppMode } from '@/lib/config';
import { getDb } from '@/lib/repositories';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  OrganizationType,
  Profile,
  RoleKey,
  Uuid,
  WorkspaceContext,
} from '@/types/domain';

export const DEMO_USER_COOKIE = 't4d_demo_user';
export const WORKSPACE_COOKIE = 't4d_workspace';

/** ログイン中ユーザーが所属する全ワークスペース。 */
export interface WorkspaceOption {
  organizationId: Uuid;
  organizationName: string;
  organizationType: OrganizationType;
  roleKeys: RoleKey[];
  unitScopeIds: Uuid[];
}

async function loadWorkspaces(db: DbClient, userId: Uuid): Promise<WorkspaceOption[]> {
  const memberships = await db.select('memberships', {
    where: { userId, status: 'active' },
  });
  if (memberships.length === 0) return [];

  const orgIds = memberships.map((m) => m.organizationId);
  const orgs = await db.select('organizations', { where: { id: { in: orgIds } } });
  const roles = await db.select('membershipRoles', {
    where: { membershipId: { in: memberships.map((m) => m.id) } },
  });

  const out: WorkspaceOption[] = [];
  for (const membership of memberships) {
    const org = orgs.find((o) => o.id === membership.organizationId);
    if (!org || org.deletedAt) continue;
    out.push({
      organizationId: org.id,
      organizationName: org.name,
      organizationType: org.type,
      roleKeys: roles.filter((r) => r.membershipId === membership.id).map((r) => r.roleKey),
      unitScopeIds: membership.unitScopeIds ?? [],
    });
  }
  return out.sort((a, b) => a.organizationName.localeCompare(b.organizationName, 'ja'));
}

async function loadEngagementIds(
  db: DbClient,
  userId: Uuid,
  workspace: WorkspaceContext,
): Promise<Uuid[]> {
  if (workspace.organizationType !== 'assurance_firm') return [];
  const members = await db.select('engagementMembers', {
    where: { userId, assuranceFirmId: workspace.organizationId, removedAt: { isNull: true } },
  });
  return members.map((m) => m.engagementId);
}

async function resolveProfile(db: DbClient): Promise<Profile | null> {
  const cookieStore = await cookies();

  if (getAppMode() === 'demo') {
    const email = cookieStore.get(DEMO_USER_COOKIE)?.value;
    if (!email) return null;
    const rows = await db.select('profiles', { where: { email }, limit: 1 });
    return rows[0] ?? null;
  }

  const { createSupabaseServerClient } = await import('@/lib/supabase/server');
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;

  // MFA を登録済みのユーザーは AAL2（コード検証済み）でなければログイン扱いにしない。
  // これが無いと、パスワードだけの AAL1 セッションで URL 直打ちすれば MFA を迂回できてしまう。
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') return null;
  const rows = await db.select('profiles', { where: { id: data.user.id }, limit: 1 });
  return (
    rows[0] ?? {
      id: data.user.id,
      email: data.user.email ?? '',
      displayName: data.user.email ?? 'unknown',
      jobTitle: null,
      locale: 'ja',
      timezone: 'Asia/Tokyo',
      createdAt: new Date().toISOString(),
    }
  );
}

export interface SessionInfo {
  profile: Profile;
  workspaces: WorkspaceOption[];
  /** 選択済みワークスペースが無い場合は null（/workspace で選ばせる）。 */
  context: AuthorizationContext | null;
}

/**
 * 未ログインなら null。
 * React cache() で**リクエスト内は 1 回だけ**解決する。レイアウト・ページ・部品が
 * それぞれ呼んでも Supabase Auth への getUser（ネットワーク往復）は 1 回で済む。
 */
export const getSession = cache(async (): Promise<SessionInfo | null> => {
  const db = await getDb();
  const profile = await resolveProfile(db);
  if (!profile) return null;

  const workspaces = await loadWorkspaces(db, profile.id);
  if (workspaces.length === 0) {
    return { profile, workspaces, context: null };
  }

  const cookieStore = await cookies();
  const selectedId = cookieStore.get(WORKSPACE_COOKIE)?.value;
  const selected =
    workspaces.find((w) => w.organizationId === selectedId) ??
    (workspaces.length === 1 ? workspaces[0] : undefined);
  if (!selected) return { profile, workspaces, context: null };

  const workspace: WorkspaceContext = {
    organizationId: selected.organizationId,
    organizationType: selected.organizationType,
    organizationName: selected.organizationName,
    roleKeys: selected.roleKeys,
    unitScopeIds: selected.unitScopeIds,
  };

  return {
    profile,
    workspaces,
    context: {
      userId: profile.id,
      email: profile.email,
      displayName: profile.displayName,
      workspace,
      engagementIds: await loadEngagementIds(db, profile.id, workspace),
      demo: getAppMode() === 'demo',
    },
  };
});

export type ResolvedSession = SessionInfo & { context: AuthorizationContext };

/** 未ログインなら /login、ワークスペース未選択なら /workspace へリダイレクト。 */
export async function requireSession(): Promise<ResolvedSession> {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.context) redirect('/workspace');
  return session as ResolvedSession;
}

export async function requireContext(): Promise<AuthorizationContext> {
  return (await requireSession()).context;
}

/** 企業ワークスペース必須。種別違いは /workspace へ戻す。 */
export async function requireEnterpriseSession(): Promise<ResolvedSession> {
  const session = await requireSession();
  if (session.context.workspace.organizationType !== 'enterprise') redirect('/workspace');
  return session;
}

export async function requireEnterpriseContext(): Promise<AuthorizationContext> {
  return (await requireEnterpriseSession()).context;
}

/** 監査法人ワークスペース必須。 */
export async function requireAssuranceSession(): Promise<ResolvedSession> {
  const session = await requireSession();
  if (session.context.workspace.organizationType !== 'assurance_firm') redirect('/workspace');
  return session;
}

export async function requireAssuranceContext(): Promise<AuthorizationContext> {
  return (await requireAssuranceSession()).context;
}

/** 既定の遷移先（ワークスペース種別ごとのホーム）。 */
export function homePathFor(type: OrganizationType): string {
  if (type === 'enterprise') return '/enterprise/dashboard';
  if (type === 'assurance_firm') return '/assurance/dashboard';
  return '/workspace';
}
