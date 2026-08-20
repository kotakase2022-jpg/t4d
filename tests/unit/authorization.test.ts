import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertEngagementMember,
  can,
  canSignoff,
  isUnitInScope,
  permissionsFor,
} from '@/lib/authorization/can';
import { ROLE_PERMISSIONS } from '@/lib/authorization/roles';
import { PERMISSION_KEYS, type AuthorizationContext, type RoleKey } from '@/types/domain';

function ctx(
  roleKeys: RoleKey[],
  overrides: Partial<AuthorizationContext> = {},
): AuthorizationContext {
  return {
    userId: 'user-1',
    email: 'user@demo.local',
    displayName: 'テスト ユーザー',
    workspace: {
      organizationId: 'org-1',
      organizationType: roleKeys.some(
        (r) => r.startsWith('assurance') || r === 'engagement_partner' || r === 'specialist',
      )
        ? 'assurance_firm'
        : 'enterprise',
      organizationName: 'テスト組織',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
    ...overrides,
  };
}

describe('ロール → 権限', () => {
  it('企業管理者はデータの最終承認権限を持たない（承認者ロールが必要）', () => {
    expect(can(ctx(['enterprise_admin']), 'enterprise.data.approve')).toBe(false);
    expect(can(ctx(['approver']), 'enterprise.data.approve')).toBe(true);
  });

  it('拠点担当はレビュー・承認できない', () => {
    const site = ctx(['site_contributor']);
    expect(can(site, 'enterprise.data.write')).toBe(true);
    expect(can(site, 'enterprise.data.review')).toBe(false);
    expect(can(site, 'enterprise.data.approve')).toBe(false);
  });

  it('閲覧者は書き込み権限を持たない', () => {
    const viewer = ctx(['viewer']);
    expect(can(viewer, 'enterprise.data.read')).toBe(true);
    expect(can(viewer, 'enterprise.data.write')).toBe(false);
  });

  it('監査法人管理者はクライアントデータ系の権限を一切持たない', () => {
    const admin = ctx(['assurance_admin']);
    expect(can(admin, 'assurance.firm.manage')).toBe(true);
    expect(can(admin, 'assurance.engagement.read')).toBe(false);
    expect(can(admin, 'assurance.testing.write')).toBe(false);
    expect(can(admin, 'assurance.snapshot.create')).toBe(false);
  });

  it('platform_admin はクライアントデータへの権限を持たない', () => {
    const platform = ctx(['platform_admin']);
    const perms = permissionsFor(platform.workspace.roleKeys);
    expect([...perms]).toEqual(['common.audit.read']);
  });

  it('複数ロールを持つ場合は和集合になる', () => {
    const both = ctx(['reviewer', 'approver']);
    expect(can(both, 'enterprise.data.review')).toBe(true);
    expect(can(both, 'enterprise.data.approve')).toBe(true);
  });
});

describe('Sign-off 段階の権限', () => {
  it('スタッフは prepared のみ', () => {
    const staff = ctx(['assurance_staff']);
    expect(canSignoff(staff, 'prepared')).toBe(true);
    expect(canSignoff(staff, 'reviewed')).toBe(false);
    expect(canSignoff(staff, 'partner_approved')).toBe(false);
  });

  it('マネージャーは partner_approved を実行できない', () => {
    const manager = ctx(['assurance_manager']);
    expect(canSignoff(manager, 'reviewed')).toBe(true);
    expect(canSignoff(manager, 'partner_approved')).toBe(false);
  });

  it('契約責任者は partner_approved を実行できる', () => {
    expect(canSignoff(ctx(['engagement_partner']), 'partner_approved')).toBe(true);
  });
});

describe('Unit スコープ', () => {
  it('スコープ未設定なら全社', () => {
    expect(isUnitInScope(ctx(['site_contributor']), 'unit-x')).toBe(true);
  });

  it('スコープ設定時は担当 Unit のみ', () => {
    const scoped = ctx(['site_contributor'], {
      workspace: {
        organizationId: 'org-1',
        organizationType: 'enterprise',
        organizationName: 'テスト組織',
        roleKeys: ['site_contributor'],
        unitScopeIds: ['unit-east'],
      },
    });
    expect(isUnitInScope(scoped, 'unit-east')).toBe(true);
    expect(isUnitInScope(scoped, 'unit-west')).toBe(false);
  });
});

describe('Engagement Member 判定', () => {
  it('未アサインの案件は NotFound として扱う（存在を秘匿する）', () => {
    const manager = ctx(['assurance_manager'], { engagementIds: ['eng-1'] });
    expect(() => assertEngagementMember(manager, 'eng-1')).not.toThrow();
    expect(() => assertEngagementMember(manager, 'eng-2')).toThrowError(/見つかりません/);
  });
});

describe('SQL とアプリ層の権限定義が一致している', () => {
  const sql = readFileSync(
    path.resolve(process.cwd(), 'supabase', 'migrations', '0002_identity.sql'),
    'utf8',
  );

  it('permissions マスターが PERMISSION_KEYS と一致する', () => {
    const inSql = new Set([...sql.matchAll(/^\s*\('([a-z]+\.[a-z.]+)',\s*'/gm)].map((m) => m[1]));
    for (const key of PERMISSION_KEYS) {
      expect(inSql.has(key), `SQL の permissions に ${key} がありません`).toBe(true);
    }
  });

  it('role_permissions が ROLE_PERMISSIONS と一致する', () => {
    const block = sql.slice(sql.indexOf('insert into role_permissions'));
    for (const [roleKey, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      const roleMatch = block.match(
        new RegExp(`\\('${roleKey}',\\s*array\\[([\\s\\S]*?)\\]\\)`, 'm'),
      );
      expect(roleMatch, `SQL に ${roleKey} の権限定義がありません`).toBeTruthy();
      if (!roleMatch?.[1]) continue;
      const sqlPermissions = [...roleMatch[1].matchAll(/'([a-z]+\.[a-z.]+)'/g)].map((m) => m[1]);
      expect(new Set(sqlPermissions), `${roleKey} の権限が一致しません`).toEqual(
        new Set(permissions),
      );
    }
  });
});
