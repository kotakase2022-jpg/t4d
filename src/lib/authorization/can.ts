import { ROLE_PERMISSIONS } from './roles';
import type {
  AuthorizationContext,
  PermissionKey,
  RoleKey,
  Uuid,
  WorkflowStepKey,
} from '@/types/domain';

/** 認可違反。Route Handler / Server Action は 403 相当へ変換する。 */
export class AuthorizationError extends Error {
  readonly code = 'FORBIDDEN';
  constructor(message = 'この操作を行う権限がありません。') {
    super(message);
    this.name = 'AuthorizationError';
  }
}

/** 対象が存在しない、または権限外で存在を秘匿すべき場合。 */
export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(message = '対象が見つかりません。') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export function permissionsFor(roleKeys: readonly RoleKey[]): Set<PermissionKey> {
  const set = new Set<PermissionKey>();
  for (const role of roleKeys) {
    for (const perm of ROLE_PERMISSIONS[role] ?? []) set.add(perm);
  }
  return set;
}

export function can(ctx: AuthorizationContext, permission: PermissionKey): boolean {
  return permissionsFor(ctx.workspace.roleKeys).has(permission);
}

export function canAny(ctx: AuthorizationContext, permissions: readonly PermissionKey[]): boolean {
  const set = permissionsFor(ctx.workspace.roleKeys);
  return permissions.some((p) => set.has(p));
}

export function assertCan(ctx: AuthorizationContext, permission: PermissionKey): void {
  if (!can(ctx, permission)) {
    throw new AuthorizationError(`権限 ${permission} が必要です。`);
  }
}

/**
 * 企業側 Unit スコープ判定。
 * `unitScopeIds` が空 = 全社スコープ。site_contributor / supplier_contributor は
 * 自分の担当 Unit のみ書き込み可（指示書 11-3）。
 */
export function isUnitInScope(ctx: AuthorizationContext, unitId: Uuid): boolean {
  const scope = ctx.workspace.unitScopeIds;
  if (scope.length === 0) return true;
  return scope.includes(unitId);
}

export function assertUnitInScope(ctx: AuthorizationContext, unitId: Uuid): void {
  if (!isUnitInScope(ctx, unitId)) {
    throw new AuthorizationError('担当外の組織・拠点のデータは操作できません。');
  }
}

export function assertEnterpriseWorkspace(ctx: AuthorizationContext): void {
  if (ctx.workspace.organizationType !== 'enterprise') {
    throw new AuthorizationError('企業ワークスペースでのみ実行できます。');
  }
}

export function assertAssuranceWorkspace(ctx: AuthorizationContext): void {
  if (ctx.workspace.organizationType !== 'assurance_firm') {
    throw new AuthorizationError('監査法人ワークスペースでのみ実行できます。');
  }
}

/**
 * Engagement Member であることを要求する。
 * 監査法人管理者であっても未アサイン案件は通さない（指示書 6.4 / 11-6）。
 */
export function assertEngagementMember(ctx: AuthorizationContext, engagementId: Uuid): void {
  assertAssuranceWorkspace(ctx);
  if (!ctx.engagementIds.includes(engagementId)) {
    // 存在自体を秘匿する
    throw new NotFoundError('案件が見つかりません。');
  }
}

/** Workflow Step の操作可否（指示書 11-4 / 11-5）。 */
export function canActOnWorkflowStep(ctx: AuthorizationContext, step: WorkflowStepKey): boolean {
  switch (step) {
    case 'input':
      return can(ctx, 'enterprise.data.write');
    case 'review':
      return can(ctx, 'enterprise.data.review');
    case 'approval':
      return can(ctx, 'enterprise.data.approve');
    default:
      return false;
  }
}

/** Sign-off ステージごとに必要な権限（代理 Sign-off は別途 userId 一致で禁止）。 */
export function canSignoff(
  ctx: AuthorizationContext,
  stage: 'prepared' | 'reviewed' | 'partner_approved',
): boolean {
  switch (stage) {
    case 'prepared':
      return can(ctx, 'assurance.signoff.prepared');
    case 'reviewed':
      return can(ctx, 'assurance.signoff.reviewed');
    case 'partner_approved':
      return can(ctx, 'assurance.signoff.partner');
    default:
      return false;
  }
}
