import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, NotFoundError } from '@/lib/authorization/can';
import { roleLabel } from '@/lib/authorization/roles';
// 入力の誤り・重複は利用者に理由を見せる（本番で digest に化けさせない。withUserFacingError が ?error= に載せる）
import { ValidationError } from '@/lib/errors/user-facing';
import { randomUUID } from 'node:crypto';
import { fid } from '@/lib/fixtures/ids';
import { FICTIONAL_MEMBER_EMAIL_SUFFIX } from '@/lib/fixtures/trial-ids';
import { ASSURANCE_ROLES, ENTERPRISE_ROLES } from '@/types/domain';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  Invitation,
  MembershipRole,
  MembershipStatus,
  OrganizationMembership,
  Profile,
  RoleKey,
  Uuid,
} from '@/types/domain';

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

/** 画面から届く ID の形（Supabase Mode で UUID でない文字列を DB に渡すと内部エラーに見えるため先に確かめる） */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** 組織の種類ごとに付けられる役割（画面の一覧は見た目の制限にすぎない。サーバーで必ず確かめる） */
function allowedRolesFor(ctx: AuthorizationContext): readonly string[] {
  return ctx.workspace.organizationType === 'assurance_firm' ? ASSURANCE_ROLES : ENTERPRISE_ROLES;
}

/** 役割の一覧を確かめる（1 つ以上・この組織の種類の役割だけ・重複なし） */
function validRoleKeys(ctx: AuthorizationContext, roleKeys: readonly RoleKey[]): RoleKey[] {
  const unique = [...new Set(roleKeys)];
  if (unique.length === 0) {
    throw new ValidationError('ロールを 1 つ以上選んでください。');
  }
  // 企業テナントへ監査法人ロールや platform_admin を混ぜられると、受諾・保存した時点でその権限を持ってしまう
  const allowedRoles = allowedRolesFor(ctx);
  const invalid = unique.filter((role) => !allowedRoles.includes(role));
  if (invalid.length > 0) {
    throw new ValidationError(
      `このワークスペースでは指定できないロールです: ${invalid.join(', ')}`,
    );
  }
  return unique;
}

/**
 * 担当拠点を確かめる（この組織の、削除していない拠点だけ。空は全社）。
 * 拠点スコープは RLS（t4d.unit_in_scope）が書込を絞る根拠なので、別組織の拠点を混ぜさせない
 */
async function validUnitScope(
  db: DbClient,
  ctx: AuthorizationContext,
  unitScopeIds: readonly Uuid[] | undefined,
): Promise<Uuid[]> {
  const ids = [...new Set((unitScopeIds ?? []).map((id) => id.trim()).filter((id) => id !== ''))];
  if (ids.length === 0) return [];
  if (ctx.workspace.organizationType !== 'enterprise') {
    throw new ValidationError('担当拠点は企業のワークスペースでだけ指定できます。');
  }
  const units = await db.select('units', {
    where: {
      organizationId: ctx.workspace.organizationId,
      id: { in: ids },
      deletedAt: { isNull: true },
    },
  });
  if (units.length !== ids.length) {
    throw new ValidationError(
      '選んだ担当拠点が見つかりません。画面を開き直して選び直してください。',
    );
  }
  return ids;
}

export async function createInvitation(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { email: string; roleKeys: RoleKey[]; unitScopeIds?: Uuid[] },
): Promise<Invitation> {
  assertCan(ctx, 'enterprise.member.manage');
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationError('メールアドレスの形式が正しくありません。');
  }
  const roleKeys = validRoleKeys(ctx, input.roleKeys);
  const unitScopeIds = await validUnitScope(db, ctx, input.unitScopeIds);
  const organizationId = ctx.workspace.organizationId;

  // 既存メンバー・有効な招待との重複を防ぐ
  const existingProfiles = await db.select('profiles', { where: { email }, limit: 1 });
  if (existingProfiles[0]) {
    const membership = await db.select('memberships', {
      where: { organizationId, userId: existingProfiles[0].id, status: 'active' },
      limit: 1,
    });
    if (membership[0]) throw new ValidationError('このメールアドレスは既にメンバーです。');
  }
  const pending = await db.select('invitations', {
    where: { organizationId, email, status: 'pending' },
    limit: 1,
  });
  if (pending[0]) throw new ValidationError('このメールアドレスへの招待が既に有効です。');

  const now = new Date();
  const invitation: Invitation = {
    // リンクの秘匿性はこの ID だけに依存するため、決定論的 fid ではなく CSPRNG を使う
    // （fid は組織 ID＋メール＋作成時刻から計算でき、推測・総当たりが成立してしまう）。
    id: randomUUID(),
    organizationId,
    email,
    roleKeys,
    status: 'pending',
    // 招待の時点で担当拠点を決める（0056）。受諾で membership へ写す。空は全社
    unitScopeIds,
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
    afterSummary: `メンバーを招待（アプリ内リンク発行・メール送信なし）: ロール ${roleKeys.join(',')}／${scopeSummary(unitScopeIds)}`,
  });
  return invitation;
}

/** 監査ログの要約に載せる担当範囲（拠点の名前は入れず件数だけ） */
function scopeSummary(unitScopeIds: readonly Uuid[]): string {
  return unitScopeIds.length === 0 ? '担当範囲 全社' : `担当拠点 ${unitScopeIds.length} 件`;
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

// ----------------------------------------------------------------------
// メンバーの役割・担当拠点の変更、利用の停止・再開（トライアル対応 NF-25）
// ----------------------------------------------------------------------

/** Demo Mode のログイン利用者は変えない（誰でも使うデモの入口を、誰かの操作で壊させない） */
export const DEMO_MEMBER_PROTECTED_MESSAGE =
  'デモの利用者は変更できません。架空のメンバー（ログインしない利用者）で操作を試せます。';

export const LAST_ADMIN_MESSAGE =
  '最後の管理者は外せません。先に別のメンバーを管理者にしてから変更してください。';

export const SELF_SUSPEND_MESSAGE = '自分自身の利用は停止できません。';

const MEMBERSHIP_STATUS_LABEL: Record<MembershipStatus, string> = {
  active: '有効',
  invited: '招待中',
  suspended: '停止中',
};

/** 変更できるメンバーか（Demo Mode では架空のメンバーだけ。画面の出し分けとサービスで同じ判定） */
export function isProtectedDemoMember(mode: DbClient['mode'], email: string | undefined): boolean {
  return mode === 'demo' && !(email ?? '').endsWith(FICTIONAL_MEMBER_EMAIL_SUFFIX);
}

export interface UpdateMembershipInput {
  membershipId: Uuid;
  /** 省略時は変えない */
  roleKeys?: RoleKey[];
  /** 省略時は変えない。空配列は全社 */
  unitScopeIds?: Uuid[];
  /** 省略時は変えない */
  status?: 'active' | 'suspended';
}

export interface UpdateMembershipResult {
  membership: OrganizationMembership;
  roleKeys: RoleKey[];
  /** 実際に変わったか（同じ内容の再送では監査ログを書かない） */
  changed: boolean;
}

function adminRoleOf(ctx: AuthorizationContext): RoleKey {
  return ctx.workspace.organizationType === 'assurance_firm'
    ? 'assurance_admin'
    : 'enterprise_admin';
}

function membershipSummary(
  roleKeys: readonly RoleKey[],
  unitScopeIds: readonly Uuid[],
  status: MembershipStatus,
): string {
  const roles = roleKeys.map((role) => roleLabel(role)).join('・') || '役割なし';
  return `役割: ${roles}／${scopeSummary(unitScopeIds)}／状態: ${MEMBERSHIP_STATUS_LABEL[status]}`;
}

/**
 * 役割の行を消す。membership_roles は主キーが (membership_id, role_key) で、リポジトリの共通の操作
 * （id で更新・論理削除）では外せない。
 *  - Supabase Mode: 利用者の JWT のクライアントで消す（RLS membership_roles_write が member.manage を検査する）
 *  - Demo Mode: このリクエストの Fixture から外す。役割は Cookie で持ち回さない（主キーが無いため。
 *    demo-trial-checks.ts）ので、変更は同じインスタンスのメモリにだけ残る（画面にもそう出す）
 */
async function removeMembershipRoles(
  db: DbClient,
  membershipId: Uuid,
  roleKeys: readonly RoleKey[],
): Promise<void> {
  if (roleKeys.length === 0) return;
  if (db.mode === 'supabase') {
    const { createSupabaseServerClient } = await import('@/lib/supabase/server');
    const client = await createSupabaseServerClient();
    const { error } = await client
      .from('membership_roles')
      .delete()
      .eq('membership_id', membershipId)
      .in('role_key', [...roleKeys]);
    if (error) throw new Error(`delete membership_roles: ${error.message}`);
    return;
  }
  const { demoFixtureForRequest } = await import('@/lib/repositories/demo-fresh-fixture');
  const { db: fixture } = await demoFixtureForRequest();
  for (let i = fixture.membershipRoles.length - 1; i >= 0; i -= 1) {
    const row = fixture.membershipRoles[i];
    if (row && row.membershipId === membershipId && roleKeys.includes(row.roleKey)) {
      fixture.membershipRoles.splice(i, 1);
    }
  }
}

/**
 * メンバーの役割・担当拠点・利用の状態を変える（enterprise.member.manage）。
 *
 *  - 他の組織のメンバーは「見つかりません」（ID を知っていても存在を区別させない）
 *  - Demo Mode ではログイン利用者を変えない（架空のメンバーだけ。DEMO_MEMBER_PROTECTED_MESSAGE）
 *  - 最後の有効な管理者から管理者の役割を外す・停止することはできない（組織を管理できる人が居なくなる）
 *  - 自分自身は停止できない（自分を締め出す操作を 1 回の押し間違いで起こさない）
 *  - 停止は削除ではない。行は残り、再開で元に戻る（セッションは有効なメンバーシップだけを読む）
 * 監査ログは permission_changed（前後の役割・担当拠点の件数・状態。氏名・メールは入れない）
 */
export async function updateMembership(
  db: DbClient,
  ctx: AuthorizationContext,
  input: UpdateMembershipInput,
): Promise<UpdateMembershipResult> {
  assertCan(ctx, 'enterprise.member.manage');
  const organizationId = ctx.workspace.organizationId;
  const membership = UUID_PATTERN.test(input.membershipId)
    ? await db.findById('memberships', input.membershipId)
    : null;
  if (!membership || membership.organizationId !== organizationId) {
    throw new NotFoundError('メンバーが見つかりません。');
  }
  const profile = await db.findById('profiles', membership.userId);
  if (isProtectedDemoMember(db.mode, profile?.email)) {
    throw new ValidationError(DEMO_MEMBER_PROTECTED_MESSAGE);
  }
  if (input.status !== undefined && input.status !== 'active' && input.status !== 'suspended') {
    throw new ValidationError('利用の状態が正しくありません。');
  }
  if (input.status === 'suspended' && membership.userId === ctx.userId) {
    throw new ValidationError(SELF_SUSPEND_MESSAGE);
  }

  const currentRoles = (
    await db.select('membershipRoles', { where: { membershipId: membership.id } })
  ).map((r: MembershipRole) => r.roleKey);
  const nextRoles = input.roleKeys ? validRoleKeys(ctx, input.roleKeys) : currentRoles;
  const nextScope =
    input.unitScopeIds !== undefined
      ? await validUnitScope(db, ctx, input.unitScopeIds)
      : membership.unitScopeIds;
  const nextStatus: MembershipStatus = input.status ?? membership.status;

  // 最後の有効な管理者を外さない
  const adminRole = adminRoleOf(ctx);
  const wasAdmin = membership.status === 'active' && currentRoles.includes(adminRole);
  const staysAdmin = nextStatus === 'active' && nextRoles.includes(adminRole);
  if (wasAdmin && !staysAdmin) {
    const others = await db.select('memberships', {
      where: { organizationId, status: 'active', id: { neq: membership.id } },
    });
    const otherAdminRoles =
      others.length > 0
        ? await db.select('membershipRoles', {
            where: { membershipId: { in: others.map((m) => m.id) }, roleKey: adminRole },
          })
        : [];
    if (otherAdminRoles.length === 0) throw new ValidationError(LAST_ADMIN_MESSAGE);
  }

  const added = nextRoles.filter((role) => !currentRoles.includes(role));
  const removed = currentRoles.filter((role) => !nextRoles.includes(role));
  const scopeChanged =
    nextScope.length !== membership.unitScopeIds.length ||
    nextScope.some((id) => !membership.unitScopeIds.includes(id));
  const statusChanged = nextStatus !== membership.status;
  const changed = added.length > 0 || removed.length > 0 || scopeChanged || statusChanged;
  if (!changed) return { membership, roleKeys: currentRoles, changed: false };

  const now = new Date().toISOString();
  const updated =
    scopeChanged || statusChanged
      ? await db.update('memberships', membership.id, {
          ...(scopeChanged ? { unitScopeIds: nextScope } : {}),
          ...(statusChanged ? { status: nextStatus } : {}),
          updatedAt: now,
          updatedBy: ctx.userId,
        })
      : membership;
  if (added.length > 0) {
    await db.insert(
      'membershipRoles',
      added.map((roleKey) => ({
        membershipId: membership.id,
        roleKey,
        grantedAt: now,
        grantedBy: ctx.userId,
      })),
    );
  }
  await removeMembershipRoles(db, membership.id, removed);

  await recordAuditEvent(db, ctx, {
    eventType: 'permission_changed',
    resourceType: 'organization_membership',
    resourceId: membership.id,
    beforeSummary: membershipSummary(currentRoles, membership.unitScopeIds, membership.status),
    afterSummary: membershipSummary(nextRoles, nextScope, nextStatus),
    metadata: { addedRoles: added, removedRoles: removed, statusChanged, scopeChanged },
  });
  return { membership: updated, roleKeys: nextRoles, changed: true };
}

// ----------------------------------------------------------------------
// 担当の一覧（引継ぎ。読むだけ。一括の付け替えは作らない: plan 付録 E）
// ----------------------------------------------------------------------

export type MemberAssignmentKind =
  | 'project'
  | 'block'
  | 'review'
  | 'requirement'
  | 'ssbj_plan'
  | 'csrd_plan'
  | 'collection'
  | 'response'
  | 'task';

export const MEMBER_ASSIGNMENT_KIND_LABELS: Record<MemberAssignmentKind, string> = {
  project: '開示プロジェクト',
  block: '原稿の節',
  review: '未完了のレビュー・承認の指名',
  requirement: '要求事項の判断',
  ssbj_plan: 'SSBJ の対応計画',
  csrd_plan: 'CSRD の対応計画',
  collection: '収集項目',
  response: '開示回答（CDP・CSRD）',
  task: 'タスク',
};

export interface MemberAssignment {
  kind: MemberAssignmentKind;
  /** 担当の名前（節の題名・計画の題名など） */
  title: string;
  /** 担当の立場（例: 担当・レビュー担当・最終承認者） */
  role: string;
  href: string;
}

export interface MemberAssignments {
  membership: OrganizationMembership;
  displayName: string;
  items: MemberAssignment[];
}

/**
 * その人が担当になっている未完了の仕事（異動・引継ぎのときに、誰に何を渡すかを確かめる）。
 * enterprise.member.manage。書き込みはしない
 */
export async function listMemberAssignments(
  db: DbClient,
  ctx: AuthorizationContext,
  membershipId: Uuid,
): Promise<MemberAssignments> {
  assertCan(ctx, 'enterprise.member.manage');
  const organizationId = ctx.workspace.organizationId;
  const membership = UUID_PATTERN.test(membershipId)
    ? await db.findById('memberships', membershipId)
    : null;
  if (!membership || membership.organizationId !== organizationId) {
    throw new NotFoundError('メンバーが見つかりません。');
  }
  const uid = membership.userId;
  const profile = await db.findById('profiles', uid);

  const [
    projects,
    blocks,
    reviews,
    assessments,
    ssbjPlans,
    csrdPlans,
    assignments,
    responses,
    tasks,
  ] = await Promise.all([
    db.select('disclosureProjects', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('disclosureBlocks', {
      where: { organizationId, ownerUserId: uid, deletedAt: { isNull: true } },
    }),
    db.select('reviewRequests', {
      where: { organizationId, status: { in: ['open', 'reviewed'] } },
    }),
    db.select('projectRequirementAssessments', { where: { organizationId, ownerUserId: uid } }),
    db.select('ssbjActionPlans', { where: { organizationId, assigneeUserId: uid } }),
    db.select('csrdActionPlans', { where: { organizationId, assigneeUserId: uid } }),
    db.select('metricAssignments', { where: { organizationId } }),
    db.select('disclosureResponses', { where: { organizationId } }),
    db.select('tasks', { where: { organizationId, assigneeUserId: uid } }),
  ]);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const items: MemberAssignment[] = [];
  const projectHref = (id: Uuid, tab?: string) =>
    `/enterprise/disclosure-projects/${id}${tab ? `?tab=${tab}` : ''}`;

  for (const project of projects) {
    const roles = [
      project.ownerUserId === uid ? '責任者' : null,
      project.reviewerUserId === uid ? 'レビュー担当' : null,
      project.finalApproverUserId === uid ? '最終承認者' : null,
    ].filter((r): r is string => r !== null);
    if (roles.length > 0) {
      items.push({
        kind: 'project',
        title: project.name,
        role: roles.join('・'),
        href: projectHref(project.id),
      });
    }
  }
  for (const block of blocks) {
    if (block.status === 'approved') continue;
    const project = projectById.get(block.projectId);
    items.push({
      kind: 'block',
      title: project ? `${project.name}／${block.title}` : block.title,
      role: '担当',
      href: `${projectHref(block.projectId)}/blocks/${block.id}`,
    });
  }
  for (const review of reviews) {
    const role =
      review.status === 'open' && review.reviewerUserId === uid
        ? 'レビュー担当'
        : review.status === 'reviewed' && review.approverUserId === uid
          ? '最終承認者'
          : null;
    if (!role) continue;
    const project = projectById.get(review.projectId);
    items.push({
      kind: 'review',
      title: project?.name ?? '開示プロジェクト',
      role,
      href: projectHref(review.projectId, 'reviews'),
    });
  }
  if (assessments.length > 0) {
    const frameworks = await db.select('projectFrameworks', {
      where: {
        organizationId,
        id: { in: [...new Set(assessments.map((a) => a.projectFrameworkId))] },
      },
    });
    const projectOfFramework = new Map(frameworks.map((f) => [f.id, f.projectId]));
    const items$ = await db.select('disclosureItems', {
      where: { id: { in: [...new Set(assessments.map((a) => a.itemId))] } },
    });
    const codeOf = new Map(items$.map((i) => [i.id, i.code]));
    for (const assessment of assessments) {
      const projectId = projectOfFramework.get(assessment.projectFrameworkId);
      if (!projectId) continue;
      items.push({
        kind: 'requirement',
        title: `${projectById.get(projectId)?.name ?? '開示プロジェクト'}／${codeOf.get(assessment.itemId) ?? '要求事項'}`,
        role: '担当',
        href: projectHref(projectId, 'requirements'),
      });
    }
  }
  for (const plan of ssbjPlans) {
    if (plan.status === 'done') continue;
    items.push({
      kind: 'ssbj_plan',
      title: plan.title,
      role: '担当',
      href: '/enterprise/disclosures/ssbj/plans',
    });
  }
  for (const plan of csrdPlans) {
    if (plan.status === 'done') continue;
    items.push({
      kind: 'csrd_plan',
      title: plan.title,
      role: '担当',
      href: '/enterprise/disclosures/csrd/plans',
    });
  }
  const mine = assignments.filter((a) => a.ownerUserId === uid || a.reviewerUserId === uid);
  if (mine.length > 0) {
    const [metrics, units] = await Promise.all([
      db.select('metrics', { where: { organizationId } }),
      db.select('units', { where: { organizationId } }),
    ]);
    const metricName = new Map(metrics.map((m) => [m.id, m.name]));
    const unitName = new Map(units.map((u) => [u.id, u.name]));
    for (const a of mine) {
      items.push({
        kind: 'collection',
        title: `${metricName.get(a.metricId) ?? '指標'}／${unitName.get(a.unitId) ?? '拠点'}`,
        role: a.ownerUserId === uid ? '入力担当' : 'レビュー担当',
        href: '/enterprise/data',
      });
    }
  }
  const myResponses = responses.filter(
    (r) => r.status !== 'approved' && (r.ownerUserId === uid || r.reviewerUserId === uid),
  );
  if (myResponses.length > 0) {
    const responseItems = await db.select('disclosureItems', {
      where: { id: { in: [...new Set(myResponses.map((r) => r.itemId))] } },
    });
    const versions = await db.select('frameworkVersions', {
      where: { id: { in: [...new Set(responseItems.map((i) => i.frameworkVersionId))] } },
    });
    const frameworks = await db.select('frameworks', {
      where: { id: { in: [...new Set(versions.map((v) => v.frameworkId))] } },
    });
    const keyOfVersion = new Map(
      versions.map((v) => [v.id, frameworks.find((f) => f.id === v.frameworkId)?.key]),
    );
    for (const response of myResponses) {
      const item = responseItems.find((i) => i.id === response.itemId);
      if (!item) continue;
      const key = keyOfVersion.get(item.frameworkVersionId);
      const base =
        key === 'cdp'
          ? '/enterprise/disclosures/cdp'
          : key === 'csrd'
            ? '/enterprise/disclosures/csrd'
            : null;
      if (!base) continue;
      items.push({
        kind: 'response',
        title: `${key === 'cdp' ? 'CDP' : 'CSRD'} ${item.code}`,
        role: response.ownerUserId === uid ? '回答担当' : 'レビュー担当',
        href: `${base}/${item.id}`,
      });
    }
  }
  for (const task of tasks) {
    if (task.status === 'done' || task.status === 'cancelled') continue;
    items.push({ kind: 'task', title: task.title, role: '担当', href: '/enterprise/workflows' });
  }

  return { membership, displayName: profile?.displayName ?? 'メンバー', items };
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
    throw new ValidationError(`パスワードは ${MIN_PASSWORD_LENGTH} 文字以上で設定してください。`);
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
    throw new ValidationError(
      'アカウントを作成できませんでした。管理者へ再発行を依頼してください。',
    );
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
    throw new ValidationError('この招待は期限切れです。管理者へ再発行を依頼してください。');
  }
  const displayName = input.displayName.trim();
  if (!displayName) throw new ValidationError('氏名を入力してください。');

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
      // 招待で決めた担当拠点をそのまま写す（受諾した人が範囲を広げられない。空は全社）
      unitScopeIds: [...(invitation.unitScopeIds ?? [])],
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
