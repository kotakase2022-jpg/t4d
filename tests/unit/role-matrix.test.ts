import { describe, expect, it } from 'vitest';
import { enterpriseRoleMatrix, roleMemberCounts } from '@/app/enterprise/settings/_lib/role-matrix';
import { PERMISSION_LABELS } from '@/lib/authorization/permission-labels';
import { ROLE_PERMISSIONS } from '@/lib/authorization/roles';
import { ENTERPRISE_ROLES, PERMISSION_KEYS } from '@/types/domain';

/**
 * 設定「役割と権限」タブの一覧（トライアル対応 NF-27・plan unit:role-matrix）。
 * アプリ層の定義（ROLE_PERMISSIONS）とそのまま一致し、権限キーではなく権限の名前で出す。
 * DB 側（0002 の role_permissions）との一致は tests/unit/authorization.test.ts が検査する。
 */

describe('役割 × できること', () => {
  const matrix = enterpriseRoleMatrix();

  it('列は企業の全役割（監査法人・運営の役割は出さない）', () => {
    expect(matrix.roles.map((r) => r.key)).toEqual([...ENTERPRISE_ROLES]);
    for (const role of matrix.roles) {
      expect(role.name).not.toBe(role.key);
      expect(role.description).not.toBe('');
    }
  });

  it('各役割の「できる」は ROLE_PERMISSIONS と一致する（漏れ・余分なし）', () => {
    for (const role of ENTERPRISE_ROLES) {
      const allowed = matrix.rows.filter((row) => row.allowed[role]).map((row) => row.permission);
      expect([...allowed].sort(), role).toEqual([...ROLE_PERMISSIONS[role]].sort());
    }
  });

  it('行は企業のどれかの役割が持つ権限だけ。名前は権限の表示名（権限キーを出さない）', () => {
    const enterprisePermissions = PERMISSION_KEYS.filter((p) =>
      ENTERPRISE_ROLES.some((role) => ROLE_PERMISSIONS[role].includes(p)),
    );
    expect(matrix.rows.map((r) => r.permission)).toEqual(enterprisePermissions);
    expect(matrix.rows.some((r) => r.permission.startsWith('assurance.'))).toBe(false);
    for (const row of matrix.rows) {
      expect(row.label).toBe(PERMISSION_LABELS[row.permission].label);
      expect(row.label).not.toContain('.');
    }
    // 監査ログの閲覧は企業管理者だけ
    const audit = matrix.rows.find((r) => r.permission === 'common.audit.read')!;
    expect(ENTERPRISE_ROLES.filter((role) => audit.allowed[role])).toEqual(['enterprise_admin']);
  });
});

describe('役割ごとの人数', () => {
  it('有効なメンバーだけを数え、同じ人の同じ役割は 1 回だけ', () => {
    const counts = roleMemberCounts(
      [
        { id: 'm1', status: 'active' },
        { id: 'm2', status: 'active' },
        { id: 'm3', status: 'suspended' },
        { id: 'm4', status: 'invited' },
      ],
      [
        { membershipId: 'm1', roleKey: 'enterprise_admin' },
        { membershipId: 'm1', roleKey: 'reviewer' },
        { membershipId: 'm2', roleKey: 'reviewer' },
        { membershipId: 'm2', roleKey: 'reviewer' },
        { membershipId: 'm3', roleKey: 'reviewer' },
        { membershipId: 'm4', roleKey: 'approver' },
        { membershipId: 'm1', roleKey: 'assurance_manager' },
      ],
    );
    expect(counts.enterprise_admin).toBe(1);
    expect(counts.reviewer).toBe(2);
    expect(counts.approver).toBe(0);
    expect(Object.keys(counts).sort()).toEqual([...ENTERPRISE_ROLES].sort());
  });
});
