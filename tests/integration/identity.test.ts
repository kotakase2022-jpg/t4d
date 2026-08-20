import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import {
  acceptInvitation,
  createInvitation,
  listInvitations,
  listMembers,
  revokeInvitation,
} from '@/lib/services/identity';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * メンバー招待（AUTH-P0-001）の Integration テスト。
 * 外部メール送信なし＝アプリ内リンク方式のライフサイクル全体を検証する。
 */

let db: DemoDbClient;
let fixture: FixtureDb;

function ctxFor(email: string, organizationId: string, roleKeys: RoleKey[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const admin = () => ctxFor('enterprise-admin@demo.local', ORG_IDS.aomi, ['enterprise_admin']);
const nonAdmin = () =>
  ctxFor('sustainability@demo.local', ORG_IDS.aomi, ['sustainability_manager']);
const otherAdmin = () =>
  ctxFor('other-enterprise-admin@demo.local', ORG_IDS.soten, ['enterprise_admin']);

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('招待のライフサイクル', () => {
  it('管理者が招待を作成 → 本人が受諾 → メンバーとロールが付与される', async () => {
    const ctx = admin();
    const invitation = await createInvitation(db, ctx, {
      email: 'new-hire@demo.local',
      roleKeys: ['site_contributor', 'viewer'],
    });
    expect(invitation.status).toBe('pending');
    expect(invitation.expiresAt > new Date().toISOString()).toBe(true);

    const result = await acceptInvitation(db, {
      invitationId: invitation.id,
      displayName: '新戸 参',
    });
    expect(result.organizationId).toBe(ORG_IDS.aomi);

    // メンバー一覧に現れ、ロールが招待どおり付与されている
    const members = await listMembers(db, ctx);
    const joined = members.find((m) => m.email === 'new-hire@demo.local');
    expect(joined).toBeDefined();
    expect(joined!.displayName).toBe('新戸 参');
    expect(joined!.roleKeys.sort()).toEqual(['site_contributor', 'viewer']);

    // 招待は受諾済みになり再利用できない
    const after = await db.findById('invitations', invitation.id);
    expect(after!.status).toBe('accepted');
    await expect(
      acceptInvitation(db, { invitationId: invitation.id, displayName: '別人' }),
    ).rejects.toThrow(/使用できません/);
  });

  it('重複を防ぐ: 既存メンバー・有効な招待済みメールは招待できない', async () => {
    const ctx = admin();
    await expect(
      createInvitation(db, ctx, { email: 'sustainability@demo.local', roleKeys: ['viewer'] }),
    ).rejects.toThrow(/既にメンバー/);

    await createInvitation(db, ctx, { email: 'dup@demo.local', roleKeys: ['viewer'] });
    await expect(
      createInvitation(db, ctx, { email: 'dup@demo.local', roleKeys: ['viewer'] }),
    ).rejects.toThrow(/既に有効/);
  });

  it('形式不正なメール・ロール未選択は拒否する', async () => {
    const ctx = admin();
    await expect(
      createInvitation(db, ctx, { email: 'not-an-email', roleKeys: ['viewer'] }),
    ).rejects.toThrow(/形式/);
    await expect(
      createInvitation(db, ctx, { email: 'x@demo.local', roleKeys: [] }),
    ).rejects.toThrow(/ロール/);
  });

  it('失効した招待は受諾できない', async () => {
    const ctx = admin();
    const invitation = await createInvitation(db, ctx, {
      email: 'revoke-me@demo.local',
      roleKeys: ['viewer'],
    });
    await revokeInvitation(db, ctx, invitation.id);
    await expect(
      acceptInvitation(db, { invitationId: invitation.id, displayName: 'x' }),
    ).rejects.toThrow(/使用できません/);
  });

  it('期限切れの招待は受諾できず expired になる', async () => {
    const ctx = admin();
    const invitation = await createInvitation(db, ctx, {
      email: 'late@demo.local',
      roleKeys: ['viewer'],
    });
    await db.update('invitations', invitation.id, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await expect(
      acceptInvitation(db, { invitationId: invitation.id, displayName: 'x' }),
    ).rejects.toThrow(/期限切れ/);
    const after = await db.findById('invitations', invitation.id);
    expect(after!.status).toBe('expired');
  });

  it('member.manage の無いロールは招待を作成・失効できない', async () => {
    await expect(
      createInvitation(db, nonAdmin(), { email: 'x@demo.local', roleKeys: ['viewer'] }),
    ).rejects.toThrow();
    const invitation = await createInvitation(db, admin(), {
      email: 'y@demo.local',
      roleKeys: ['viewer'],
    });
    await expect(revokeInvitation(db, nonAdmin(), invitation.id)).rejects.toThrow();
  });

  it('他組織の招待は失効できず、一覧にも混ざらない（テナント分離）', async () => {
    const invitation = await createInvitation(db, admin(), {
      email: 'z@demo.local',
      roleKeys: ['viewer'],
    });
    await expect(revokeInvitation(db, otherAdmin(), invitation.id)).rejects.toThrow(
      /見つかりません/,
    );
    const otherList = await listInvitations(db, otherAdmin());
    expect(otherList.find((i) => i.id === invitation.id)).toBeUndefined();
  });
});
