import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { ORG_IDS, UNIT_IDS, dataPointId, userId } from '@/lib/fixtures/dataset';
import { fid } from '@/lib/fixtures/ids';
import { resetDemoDb, type FixtureDb } from '@/lib/fixtures/store';
import { TRIAL_FICTIONAL_MEMBERS, trialMemberUserId } from '@/lib/fixtures/trial-case';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import type { DbClient } from '@/lib/repositories/types';
import { updateDataPointValue } from '@/lib/services/data-point-workflow';
import {
  acceptInvitation,
  createInvitation,
  DEMO_MEMBER_PROTECTED_MESSAGE,
  LAST_ADMIN_MESSAGE,
  listMemberAssignments,
  SELF_SUSPEND_MESSAGE,
  updateMembership,
} from '@/lib/services/identity';
import type { AuthorizationContext, RoleKey, Uuid } from '@/types/domain';

/**
 * 担当拠点つき招待・役割と担当拠点の変更・利用の停止・引継ぎ一覧（トライアル対応 NF-25・plan int:membership-admin）。
 *
 *  - 招待で決めた担当拠点が受諾でメンバーへ写る（これまでは常に全社だった）
 *  - 担当拠点を絞ると、ほかの拠点のデータは書けない（既存の拠点スコープの検査が効く）
 *  - 最後の管理者を外せない・自分を停止できない・Demo のログイン利用者は変えられない
 *  - 他の組織のメンバーは「見つかりません」
 * 役割の行（membership_roles）は Demo Mode ではリクエストの Fixture から外すため、プロセス共有の Fixture を使う
 */

let fixture: FixtureDb;
let db: DemoDbClient;

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  unitScopeIds: Uuid[] = [],
  organizationId: Uuid = ORG_IDS.aomi,
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType: 'enterprise',
      organizationName: '組織',
      roleKeys,
      unitScopeIds,
    },
    engagementIds: [],
    demo: true,
  };
}

const admin = () => ctxFor('enterprise-admin@demo.local', ['enterprise_admin']);
const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const otherAdmin = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], [], ORG_IDS.soten);

const [WEST_MEMBER, REVIEWER_MEMBER] = TRIAL_FICTIONAL_MEMBERS;

function membershipOf(email: string) {
  const uid = email.endsWith('@fictional.invalid') ? trialMemberUserId(email) : userId(email);
  const m = fixture.memberships.find(
    (row) => row.userId === uid && row.organizationId === ORG_IDS.aomi,
  );
  if (!m) throw new Error(`membership not found: ${email}`);
  return m;
}

function rolesOf(membershipId: Uuid): RoleKey[] {
  return fixture.membershipRoles
    .filter((r) => r.membershipId === membershipId)
    .map((r) => r.roleKey)
    .sort();
}

/**
 * Supabase Mode と同じ判定（Demo のログイン利用者の保護が掛からない）で、行は同じ Fixture に書く。
 * 書込の前に止まる検査（最後の管理者・自分の停止）を確かめるためだけに使う
 */
function asSupabaseMode(inner: DemoDbClient): DbClient {
  return {
    mode: 'supabase',
    select: (table, query) => inner.select(table, query),
    count: (table, query) => inner.count(table, query),
    findById: (table, id) => inner.findById(table, id),
    insert: (table, rows) => inner.insert(table, rows),
    update: (table, id, patch) => inner.update(table, id, patch),
    softDelete: (table, id, at) => inner.softDelete(table, id, at),
  };
}

beforeEach(() => {
  fixture = resetDemoDb();
  db = new DemoDbClient();
});

describe('担当拠点つきの招待', () => {
  it('招待で選んだ担当拠点が、受諾でメンバーの担当範囲へ写る', async () => {
    const invitation = await createInvitation(db, admin(), {
      email: 'scoped-new@demo.local',
      roleKeys: ['site_contributor'],
      unitScopeIds: [UNIT_IDS.west],
    });
    expect(invitation.unitScopeIds).toEqual([UNIT_IDS.west]);

    const accepted = await acceptInvitation(db, {
      invitationId: invitation.id,
      displayName: '担当 拠点',
    });
    const membership = fixture.memberships.find(
      (m) => m.userId === accepted.profileId && m.organizationId === ORG_IDS.aomi,
    )!;
    expect(membership.unitScopeIds).toEqual([UNIT_IDS.west]);
  });

  it('選ばなければ全社（空）。他の組織の拠点は担当拠点にできない', async () => {
    const all = await createInvitation(db, admin(), {
      email: 'all-units@demo.local',
      roleKeys: ['viewer'],
    });
    expect(all.unitScopeIds).toEqual([]);

    const sotenUnit = fixture.units.find((u) => u.organizationId === ORG_IDS.soten)!;
    await expect(
      createInvitation(db, admin(), {
        email: 'cross-tenant@demo.local',
        roleKeys: ['viewer'],
        unitScopeIds: [sotenUnit.id],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fixture.invitations.some((i) => i.email === 'cross-tenant@demo.local')).toBe(false);
  });
});

describe('役割・担当拠点の変更', () => {
  it('担当拠点を絞ると、ほかの拠点のデータは書けない', async () => {
    const target = membershipOf(REVIEWER_MEMBER.email);
    await updateMembership(db, admin(), {
      membershipId: target.id,
      roleKeys: ['site_contributor'],
      unitScopeIds: [UNIT_IDS.east],
    });
    const updated = fixture.memberships.find((m) => m.id === target.id)!;
    expect(updated.unitScopeIds).toEqual([UNIT_IDS.east]);
    expect(rolesOf(target.id)).toEqual(['site_contributor']);

    // 保存した範囲で作った認可（セッションと同じく、メンバーシップと役割から）
    const ctx: AuthorizationContext = {
      ...ctxFor('site-user@demo.local', rolesOf(target.id), updated.unitScopeIds),
      userId: trialMemberUserId(REVIEWER_MEMBER.email),
      email: REVIEWER_MEMBER.email,
    };
    await expect(
      updateDataPointValue(db, ctx, {
        dataPointId: dataPointId('WEST', 'water', 'FY2026'),
        value: 1,
        unitOfMeasure: 'm3',
        changeReason: '担当外の拠点（架空）',
      }),
    ).rejects.toThrow('担当外の組織・拠点のデータは操作できません。');
    // 担当拠点のデータは書ける（拒否の理由が担当範囲であることの対照）
    const eastWater = fixture.dataPoints.find(
      (dp) => dp.id === dataPointId('EAST', 'water', 'FY2026'),
    )!;
    await expect(
      updateDataPointValue(db, ctx, {
        dataPointId: eastWater.id,
        value: (eastWater.value ?? 0) + 1,
        unitOfMeasure: eastWater.unitOfMeasure,
        changeReason: '担当拠点の値の訂正（架空）',
      }),
    ).resolves.toBeDefined();
  });

  it('変更は監査ログ permission_changed に前後の役割・担当拠点の件数・状態で残る（氏名・メールは入れない）', async () => {
    const target = membershipOf(WEST_MEMBER.email);
    await updateMembership(db, admin(), {
      membershipId: target.id,
      roleKeys: ['site_contributor', 'reviewer'],
      unitScopeIds: [],
    });
    const event = fixture.auditEvents.find(
      (e) => e.eventType === 'permission_changed' && e.resourceId === target.id,
    )!;
    expect(event).toBeDefined();
    expect(event.beforeSummary).toContain('担当拠点 1 件');
    expect(event.afterSummary).toContain('担当範囲 全社');
    expect(event.afterSummary).toContain('レビュー担当');
    for (const text of [event.beforeSummary, event.afterSummary]) {
      expect(text).not.toContain(WEST_MEMBER.email);
      expect(text).not.toContain(WEST_MEMBER.displayName);
    }
  });

  it('同じ内容の再送では何も書かない', async () => {
    const target = membershipOf(WEST_MEMBER.email);
    const before = fixture.auditEvents.length;
    const result = await updateMembership(db, admin(), {
      membershipId: target.id,
      roleKeys: [...WEST_MEMBER.roleKeys],
      unitScopeIds: [...WEST_MEMBER.unitScopeIds],
    });
    expect(result.changed).toBe(false);
    expect(fixture.auditEvents.length).toBe(before);
  });

  it('企業の役割でない値・他の組織の拠点は拒否し、何も変えない', async () => {
    const target = membershipOf(WEST_MEMBER.email);
    await expect(
      updateMembership(db, admin(), {
        membershipId: target.id,
        roleKeys: ['assurance_manager' as RoleKey],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const sotenUnit = fixture.units.find((u) => u.organizationId === ORG_IDS.soten)!;
    await expect(
      updateMembership(db, admin(), { membershipId: target.id, unitScopeIds: [sotenUnit.id] }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fixture.memberships.find((m) => m.id === target.id)?.unitScopeIds).toEqual([
      ...WEST_MEMBER.unitScopeIds,
    ]);
  });

  it('Demo Mode ではログイン利用者を変えられない', async () => {
    const target = membershipOf('site-user@demo.local');
    await expect(
      updateMembership(db, admin(), { membershipId: target.id, unitScopeIds: [] }),
    ).rejects.toThrow(DEMO_MEMBER_PROTECTED_MESSAGE);
    await expect(
      updateMembership(db, admin(), { membershipId: target.id, status: 'suspended' }),
    ).rejects.toThrow(DEMO_MEMBER_PROTECTED_MESSAGE);
  });

  it('最後の有効な管理者から管理者の役割を外せない・停止できない', async () => {
    const supabaseLike = asSupabaseMode(db);
    const adminMembership = membershipOf('enterprise-admin@demo.local');
    await expect(
      updateMembership(supabaseLike, otherAdminOfAomi(), {
        membershipId: adminMembership.id,
        roleKeys: ['sustainability_manager'],
      }),
    ).rejects.toThrow(LAST_ADMIN_MESSAGE);
    await expect(
      updateMembership(supabaseLike, otherAdminOfAomi(), {
        membershipId: adminMembership.id,
        status: 'suspended',
      }),
    ).rejects.toThrow(LAST_ADMIN_MESSAGE);
    expect(rolesOf(adminMembership.id)).toContain('enterprise_admin');
  });

  it('別の人を管理者にすれば、元の管理者から管理者の役割を外せる', async () => {
    const successor = membershipOf(REVIEWER_MEMBER.email);
    await updateMembership(db, admin(), {
      membershipId: successor.id,
      roleKeys: ['reviewer', 'enterprise_admin'],
    });
    expect(rolesOf(successor.id)).toEqual(['enterprise_admin', 'reviewer']);

    const supabaseLike = asSupabaseMode(db);
    const adminMembership = membershipOf('enterprise-admin@demo.local');
    // 役割の行の削除は Supabase Mode では RLS 付きの別の経路のため、ここでは検査が通ることだけを確かめる
    await expect(
      updateMembership(supabaseLike, otherAdminOfAomi(), {
        membershipId: adminMembership.id,
        status: 'suspended',
      }),
    ).resolves.toMatchObject({ changed: true });
    expect(fixture.memberships.find((m) => m.id === adminMembership.id)?.status).toBe('suspended');
  });

  it('自分自身は停止できない', async () => {
    const supabaseLike = asSupabaseMode(db);
    const self = membershipOf('enterprise-admin@demo.local');
    await expect(
      updateMembership(supabaseLike, admin(), { membershipId: self.id, status: 'suspended' }),
    ).rejects.toThrow(SELF_SUSPEND_MESSAGE);
  });

  it('メンバーの管理の権限が無い人は変えられない。他の組織のメンバーは「見つかりません」', async () => {
    const target = membershipOf(WEST_MEMBER.email);
    await expect(
      updateMembership(db, manager(), { membershipId: target.id, status: 'suspended' }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      updateMembership(db, otherAdmin(), { membershipId: target.id, status: 'suspended' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(fixture.memberships.find((m) => m.id === target.id)?.status).toBe('active');
  });
});

describe('利用の停止と再開', () => {
  it('停止すると状態が停止中になり、再開で元に戻る（行は消えない）', async () => {
    const target = membershipOf(WEST_MEMBER.email);
    await updateMembership(db, admin(), { membershipId: target.id, status: 'suspended' });
    expect(fixture.memberships.find((m) => m.id === target.id)?.status).toBe('suspended');
    expect(rolesOf(target.id)).toEqual(['site_contributor']);

    await updateMembership(db, admin(), { membershipId: target.id, status: 'active' });
    expect(fixture.memberships.find((m) => m.id === target.id)?.status).toBe('active');
  });
});

describe('担当の一覧（引継ぎ）', () => {
  it('その人が担当の未完了の仕事を、画面へのリンク付きで返す（書き込まない）', async () => {
    const target = membershipOf('sustainability@demo.local');
    const before = JSON.stringify(fixture.disclosureBlocks);
    const result = await listMemberAssignments(db, admin(), target.id);
    expect(result.displayName).toBeTruthy();
    const ownedBlocks = fixture.disclosureBlocks.filter(
      (b) =>
        b.ownerUserId === target.userId &&
        !b.deletedAt &&
        b.status !== 'approved' &&
        b.organizationId === ORG_IDS.aomi,
    );
    expect(result.items.filter((i) => i.kind === 'block')).toHaveLength(ownedBlocks.length);
    for (const item of result.items) expect(item.href.startsWith('/enterprise/')).toBe(true);
    expect(JSON.stringify(fixture.disclosureBlocks)).toBe(before);
  });

  it('他の組織のメンバーは「見つかりません」', async () => {
    const target = membershipOf(WEST_MEMBER.email);
    await expect(listMemberAssignments(db, otherAdmin(), target.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

/**
 * 同じ組織の別の管理者（最後の管理者の検査を、本人以外の操作で確かめる）。Fixture には居ないので、
 * 認可の文脈だけを作る（検査は対象のメンバーシップの役割で判定する）
 */
function otherAdminOfAomi(): AuthorizationContext {
  return {
    ...admin(),
    userId: fid('user', 'another-admin@fictional.invalid'),
    email: 'another-admin@fictional.invalid',
  };
}
