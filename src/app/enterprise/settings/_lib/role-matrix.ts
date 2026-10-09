import { PERMISSION_LABELS } from '@/lib/authorization/permission-labels';
import { ROLE_DEFINITIONS, ROLE_PERMISSIONS } from '@/lib/authorization/roles';
import {
  ENTERPRISE_ROLES,
  PERMISSION_KEYS,
  type EnterpriseRole,
  type MembershipRole,
  type OrganizationMembership,
  type PermissionKey,
} from '@/types/domain';

/**
 * 役割と権限の一覧（トライアル対応 NF-27。設定の「役割と権限」タブ。読み取り専用）。
 *
 * アプリ層の定義（roles.ts の ROLE_PERMISSIONS）だけから作る。DB 側（0002 の role_permissions）と
 * 一致することは tests/unit/authorization.test.ts が自動で検査している（画面にもそう書く）。
 * 権限キーは画面に出さず、PERMISSION_LABELS の名前で出す。React に依存しない（unit で検査する）。
 */

export interface RoleColumn {
  key: EnterpriseRole;
  name: string;
  description: string;
}

export interface RoleMatrixRow {
  permission: PermissionKey;
  /** 権限の名前（例: 開示の閲覧） */
  label: string;
  /** 役割ごとに、その権限を持つか */
  allowed: Record<EnterpriseRole, boolean>;
}

export interface RoleMatrix {
  roles: RoleColumn[];
  rows: RoleMatrixRow[];
}

/** 企業の役割 × できること。企業のどの役割も持たない権限（監査法人の権限）は行にしない */
export function enterpriseRoleMatrix(): RoleMatrix {
  const roles: RoleColumn[] = ENTERPRISE_ROLES.map((key) => {
    const definition = ROLE_DEFINITIONS.find((d) => d.key === key);
    return { key, name: definition?.name ?? key, description: definition?.description ?? '' };
  });
  const rows = PERMISSION_KEYS.filter((permission) =>
    ENTERPRISE_ROLES.some((role) => ROLE_PERMISSIONS[role].includes(permission)),
  ).map((permission) => ({
    permission,
    label: PERMISSION_LABELS[permission].label,
    allowed: Object.fromEntries(
      ENTERPRISE_ROLES.map((role) => [role, ROLE_PERMISSIONS[role].includes(permission)]),
    ) as Record<EnterpriseRole, boolean>,
  }));
  return { roles, rows };
}

/** 役割ごとの有効なメンバーの人数（停止中・招待中は数えない。複数の役割を持つ人はそれぞれに数える） */
export function roleMemberCounts(
  memberships: readonly Pick<OrganizationMembership, 'id' | 'status'>[],
  membershipRoles: readonly Pick<MembershipRole, 'membershipId' | 'roleKey'>[],
): Record<EnterpriseRole, number> {
  const active = new Set(memberships.filter((m) => m.status === 'active').map((m) => m.id));
  const counts = Object.fromEntries(ENTERPRISE_ROLES.map((role) => [role, 0])) as Record<
    EnterpriseRole,
    number
  >;
  const seen = new Set<string>();
  for (const role of membershipRoles) {
    if (!active.has(role.membershipId)) continue;
    if (!(ENTERPRISE_ROLES as readonly string[]).includes(role.roleKey)) continue;
    const key = `${role.membershipId}/${role.roleKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    counts[role.roleKey as EnterpriseRole] += 1;
  }
  return counts;
}
