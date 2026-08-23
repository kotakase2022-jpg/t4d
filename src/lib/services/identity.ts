import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, NotFoundError } from '@/lib/authorization/can';
import { randomUUID } from 'node:crypto';
import { fid } from '@/lib/fixtures/ids';
import { ASSURANCE_ROLES, ENTERPRISE_ROLES } from '@/types/domain';
import type { DbClient } from '@/lib/repositories/types';
import type { AuthorizationContext, Invitation, Profile, RoleKey, Uuid } from '@/types/domain';

/**
 * メンバー招待（AUTH-P0-001）。
 *
 * **外部メール送信は行わない**（恒久制約）。招待は「アプリ内リンクの発行」方式:
 * 管理者が招待を作成 → 招待リンクを画面でコピー → 社内チャット等で本人へ手渡し →
 * 本人がリンクを開いて参加。招待の作成・失効・受諾はすべて監査ログへ残る。
 *
 * リンクの秘匿性は招待 ID（crypto.randomUUID の CSPRNG・122bit）に依存する。
 * 本番運用ではハッシュ化トークン＋短期失効へ強化する（docs/known-limitations.md）。
 */

const INVITATION_TTL_DAYS = 14;

export interface MemberEntry {
  userId: Uuid;
  displayName: string;
  email: string;
  roleKeys: RoleKey[];
  joinedAt: string | null;
}

/** 組織のアクティブメンバー一覧（ロール付き）。 */
export async function listMembers(db: DbClient, ctx: AuthorizationContext): Promise<MemberEntry[]> {
  const memberships = await db.select('memberships', {
    where: { organizationId: ctx.workspace.organizationId, status: 'active' },
  });
  if (memberships.length === 0) return [];
  const [profiles, roles] = await Promise.all([
    db.select('profiles', { where: { id: { in: memberships.map((m) => m.userId) } } }),
    db.select('membershipRoles', {
      where: { membershipId: { in: memberships.map((m) => m.id) } },
    }),
  ]);
  const profileById = new Map(profiles.map((p: Profile) => [p.id, p]));
  const rolesByMembership = new Map<string, RoleKey[]>();
  for (const r of roles) {
    const list = rolesByMembership.get(r.membershipId) ?? [];
    list.push(r.roleKey);
    rolesByMembership.set(r.membershipId, list);
  }
  return memberships
    .map((m) => {
      const profile = profileById.get(m.userId);
      if (!profile) return null;
      return {
        userId: m.userId,
        displayName: profile.displayName,
        email: profile.email,
        roleKeys: rolesByMembership.get(m.id) ?? [],
        joinedAt: m.joinedAt,
      };
    })
    .filter((m): m is MemberEntry => m !== null);
}

export async function listInvitations(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<Invitation[]> {
  assertCan(ctx, 'enterprise.member.manage');
  return db.select('invitations', {
    where: { organizationId: ctx.workspace.organizationId },
    orderBy: { column: 'createdAt', dir: 'desc' },
  });
}

export async function createInvitation(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { email: string; roleKeys: RoleKey[] },
): Promise<Invitation> {
  assertCan(ctx, 'enterprise.member.manage');
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('メールアドレスの形式が正しくありません。');
  }
  if (input.roleKeys.length === 0) {
    throw new Error('ロールを 1 つ以上選んでください。');
  }
  // 画面のロール一覧は見た目の制限にすぎない。サーバー側で必ず確かめる。
  // 企業テナントへ監査法人ロールや platform_admin を混ぜられると、
  // 受諾した時点でその権限を持ってしまう。
  const allowedRoles: readonly string[] =
    ctx.workspace.organizationType === 'assurance_firm' ? ASSURANCE_ROLES : ENTERPRISE_ROLES;
  const invalid = input.roleKeys.filter((role) => !allowedRoles.includes(role));
  if (invalid.length > 0) {
    throw new Error(`このワークスペースでは指定できないロールです: ${invalid.join(', ')}`);
  }
  const organizationId = ctx.workspace.organizationId;

  // 既存メンバー・有効な招待との重複を防ぐ
  const existingProfiles = await db.select('profiles', { where: { email }, limit: 1 });
  if (existingProfiles[0]) {
    const membership = await db.select('memberships', {
      where: { organizationId, userId: existingProfiles[0].id, status: 'active' },
      limit: 1,
    });
    if (membership[0]) throw new Error('このメールアドレスは既にメンバーです。');
  }
  const pending = await db.select('invitations', {
    where: { organizationId, email, status: 'pending' },
    limit: 1,
  });
  if (pending[0]) throw new Error('このメールアドレスへの招待が既に有効です。');

  const now = new Date();
  const invitation: Invitation = {
    // リンクの秘匿性はこの ID だけに依存するため、決定論的 fid ではなく CSPRNG を使う
    // （fid は組織 ID＋メール＋作成時刻から計算でき、推測・総当たりが成立してしまう）。
    id: randomUUID(),
    organizationId,
    email,
    roleKeys: input.roleKeys,
    status: 'pending',
    expiresAt: new Date(now.getTime() + INVITATION_TTL_DAYS * 24 * 3600 * 1000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  };
  await db.insert('invitations', [invitation]);

  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'invitation',
    resourceId: invitation.id,
    afterSummary: `メンバーを招待（アプリ内リンク発行・メール送信なし）: ロール ${input.roleKeys.join(',')}`,
  });
  return invitation;
}

export async function revokeInvitation(
  db: DbClient,
  ctx: AuthorizationContext,
  invitationId: Uuid,
): Promise<void> {
  assertCan(ctx, 'enterprise.member.manage');
  const invitation = await db.findById('invitations', invitationId);
  if (!invitation || invitation.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('招待が見つかりません。');
  }
  await db.update('invitations', invitationId, {
    status: 'revoked',
    updatedAt: new Date().toISOString(),
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'invitation',
    resourceId: invitationId,
    afterSummary: '招待を失効',
  });
}

export interface AcceptResult {
  profileId: Uuid;
  email: string;
  organizationId: Uuid;
}

/** Supabase Mode で必要な最小パスワード長。Supabase の既定（6）より厳しくする。 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * 招待受諾時の認証ユーザー確保（Supabase Mode 専用。Demo Mode では null を返す）。
 *
 * `createUser` は**確認メールを送らない** Admin API で、`email_confirm: true` を
 * 付けることで送信なしに有効化できる。恒久制約（外部メール送信禁止）と両立する。
 */
async function ensureAuthUser(email: string, password: string | undefined): Promise<Uuid | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null; // Demo Mode（パスワードレス）

  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`パスワードは ${MIN_PASSWORD_LENGTH} 文字以上で設定してください。`);
  }

  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // 別組織へ既に参加している利用者は auth ユーザーを再利用する（パスワードは変更しない）
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const found = list?.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (found) return found.id;

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error('アカウントを作成できませんでした。管理者へ再発行を依頼してください。');
  }
  return data.user.id;
}

/**
 * 招待の受諾。リンクを開いた本人が氏名（Supabase Mode ではパスワードも）を入れて参加する。
 * pending かつ期限内のみ受諾でき、受諾後は accepted として再利用できない。
 */
export async function acceptInvitation(
  db: DbClient,
  input: { invitationId: Uuid; displayName: string; password?: string },
): Promise<AcceptResult> {
  const invitation = await db.findById('invitations', input.invitationId);
  if (!invitation || invitation.status !== 'pending') {
    throw new NotFoundError('この招待は使用できません（無効・受諾済み・失効）。');
  }
  if (invitation.expiresAt < new Date().toISOString()) {
    await db.update('invitations', invitation.id, { status: 'expired' });
    throw new Error('この招待は期限切れです。管理者へ再発行を依頼してください。');
  }
  const displayName = input.displayName.trim();
  if (!displayName) throw new Error('氏名を入力してください。');

  const now = new Date().toISOString();

  // 既存プロフィールがあれば流用し、無ければ作成する。
  // Supabase Mode では profiles.id が auth.users(id) への FK なので、
  // 先に認証ユーザーを作り（**確認メールは送らない**）、その id を使う。
  const existing = await db.select('profiles', { where: { email: invitation.email }, limit: 1 });
  const authUserId = existing[0] ? null : await ensureAuthUser(invitation.email, input.password);
  const profileId = existing[0]?.id ?? authUserId ?? fid('user', invitation.email);
  if (!existing[0]) {
    await db.insert('profiles', [
      {
        id: profileId,
        email: invitation.email,
        displayName,
        jobTitle: null,
        locale: 'ja',
        timezone: 'Asia/Tokyo',
        createdAt: now,
      },
    ]);
  }

  const membershipId = fid('membership', `${invitation.organizationId}/${profileId}`);
  await db.insert('memberships', [
    {
      id: membershipId,
      organizationId: invitation.organizationId,
      userId: profileId,
      status: 'active',
      unitScopeIds: [],
      invitedBy: invitation.createdBy,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
      createdBy: profileId,
      updatedBy: profileId,
    },
  ]);
  await db.insert(
    'membershipRoles',
    invitation.roleKeys.map((roleKey) => ({
      membershipId,
      roleKey,
      grantedAt: now,
      grantedBy: invitation.createdBy,
    })),
  );
  await db.update('invitations', invitation.id, { status: 'accepted', updatedAt: now });

  await recordAuditEvent(db, null, {
    eventType: 'data_updated',
    resourceType: 'invitation',
    resourceId: invitation.id,
    afterSummary: '招待を受諾しメンバーとして参加',
  });

  return { profileId, email: invitation.email, organizationId: invitation.organizationId };
}

/**
 * パスワード再設定リンクの発行（AUTH-P0-001。Supabase Mode 専用）。
 *
 * **メールは送らない**。Supabase Admin API の generateLink は「リンクを生成するだけで
 * 送信しない」ため、恒久制約（外部メール送信禁止）と両立する。
 * 管理者が画面でリンクをコピーし、社内チャット等で本人へ手渡す運用。
 */
export async function issuePasswordResetLink(
  db: DbClient,
  ctx: AuthorizationContext,
  targetEmail: string,
  appOrigin: string,
): Promise<string> {
  assertCan(ctx, 'enterprise.member.manage');
  const email = targetEmail.trim().toLowerCase();

  // 対象が**自組織のアクティブメンバー**であることを必ずサーバー側で照合する。
  // generateLink は Service Role で auth.users 全体（他テナント・監査法人を含む）に
  // 到達できるため、ここを省くと管理者が他テナントの回復リンクを取得でき、
  // アカウント乗っ取りが成立する。
  const members = await listMembers(db, ctx);
  const target = members.find((m) => m.email.toLowerCase() === email);
  if (!target) {
    throw new NotFoundError(
      'そのメールアドレスの利用者は自組織のメンバーに見つかりません（他組織の利用者には発行できません）。',
    );
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      'パスワード再設定は Supabase Mode でのみ利用できます（Demo Mode はパスワードレスです）。',
    );
  }

  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data, error } = await admin.auth.admin.generateLink({
    type: 'recovery',
    email,
    options: { redirectTo: `${appOrigin}/reset` },
  });
  if (error || !data.properties?.action_link) {
    throw new Error('再設定リンクを発行できませんでした。対象ユーザーの存在を確認してください。');
  }

  // 発行は「他人の認証情報を変更できる操作」なので必ず監査ログへ残す。
  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'profile',
    resourceId: target.userId,
    afterSummary: 'パスワード再設定リンクを発行（メール送信なし・アプリ内手渡し）',
  });

  return data.properties.action_link;
}
