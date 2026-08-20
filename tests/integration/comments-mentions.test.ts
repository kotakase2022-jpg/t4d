import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { dataPointId, ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { addComment, listMentionCandidates, resolveMentions } from '@/lib/services/comments';
import { transitionDataPoint } from '@/lib/services/data-point-workflow';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * コメント・メンション（WF-P0-002）の Integration テスト。
 * 解決（純関数）→ 保存 → 通知 → テナント分離まで検証する。
 */

let db: DemoDbClient;
let fixture: FixtureDb;

function ctxFor(email: string, organizationId: string, roleKeys: RoleKey[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email === 'sustainability@demo.local' ? '海野 みどり' : email,
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

const manager = () => ctxFor('sustainability@demo.local', ORG_IDS.aomi, ['sustainability_manager']);
const otherOrg = () =>
  ctxFor('other-enterprise-admin@demo.local', ORG_IDS.soten, ['enterprise_admin']);

// 本社 Scope1 FY2026（Fixture に存在する Data Point）
const DP = dataPointId('HQ', 'scope1', 'FY2026');

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('resolveMentions（純関数）', () => {
  const members = [
    { userId: 'u1', displayName: '青海 太郎' },
    { userId: 'u2', displayName: '海野 みどり' },
    { userId: 'u3', displayName: '青海 太' }, // 前方一致の誤爆チェック用
  ];

  it('空白を除いた表示名で照合できる（@青海太郎 → 青海 太郎）', () => {
    expect(resolveMentions('確認お願いします @青海太郎', members)).toEqual(['u1']);
  });

  it('複数メンション・重複は一意化される', () => {
    expect(resolveMentions('@青海太郎 @海野みどり @青海太郎', members).sort()).toEqual([
      'u1',
      'u2',
    ]);
  });

  it('存在しない名前は無視される（勝手に近い人へ通知しない）', () => {
    expect(resolveMentions('@存在しない人 に連絡', members)).toEqual([]);
  });

  it('句読点で区切られていても照合できる', () => {
    expect(resolveMentions('@海野みどり、確認してください。', members)).toEqual(['u2']);
  });

  it('完全一致のみ（@青海太 は 青海 太 にだけ一致し、青海 太郎 には一致しない）', () => {
    expect(resolveMentions('@青海太 さん', members)).toEqual(['u3']);
  });
});

describe('addComment（保存と通知）', () => {
  it('メンション付きコメントが保存され、本人へ通知が作られる', async () => {
    const ctx = manager();
    const comment = await addComment(db, ctx, {
      targetType: 'data_point',
      targetId: DP,
      body: '@青海太郎 数値の根拠を確認してください',
      href: `/enterprise/data/${DP}`,
    });

    expect(comment.mentions).toEqual([userId('enterprise-admin@demo.local')]);

    // 通知はメンションされた本人にだけ作られる
    const notifications = await db.select('notifications', {
      where: { userId: userId('enterprise-admin@demo.local') },
    });
    const mention = notifications.find((n) => n.title.includes('メンション'));
    expect(mention).toBeDefined();
    expect(mention!.href).toBe(`/enterprise/data/${DP}`);
    expect(mention!.readAt).toBeNull();
  });

  it('自分自身へのメンションは通知しない', async () => {
    const ctx = manager();
    await addComment(db, ctx, {
      targetType: 'data_point',
      targetId: DP,
      body: '@海野みどり メモ',
      href: `/enterprise/data/${DP}`,
    });
    const own = await db.select('notifications', {
      where: { userId: ctx.userId },
    });
    expect(own.filter((n) => n.title.includes('メンション'))).toHaveLength(0);
  });

  it('空コメント・2000 文字超は拒否する', async () => {
    const ctx = manager();
    await expect(
      addComment(db, ctx, {
        targetType: 'data_point',
        targetId: DP,
        body: '   ',
        href: '/enterprise/data/x',
      }),
    ).rejects.toThrow(/入力/);
    await expect(
      addComment(db, ctx, {
        targetType: 'data_point',
        targetId: DP,
        body: 'あ'.repeat(2001),
        href: '/enterprise/data/x',
      }),
    ).rejects.toThrow(/2000/);
  });

  it('他組織の Data Point にはコメントできない（テナント分離）', async () => {
    await expect(
      addComment(db, otherOrg(), {
        targetType: 'data_point',
        targetId: DP,
        body: '越権コメント',
        href: '/enterprise/data/x',
      }),
    ).rejects.toThrow(/見つかりません/);
  });

  it('遷移（差戻し等）のコメントでもメンションが解決され通知される', async () => {
    const ctx = manager();
    // submitted の Data Point を差戻す（Fixture に submitted がある前提を確認）
    const submitted = await db.select('dataPoints', {
      where: { organizationId: ORG_IDS.aomi, status: 'submitted' },
      limit: 1,
    });
    expect(submitted.length, 'Fixture に submitted の Data Point が必要').toBeGreaterThan(0);

    await transitionDataPoint(db, ctx, {
      dataPointId: submitted[0]!.id,
      to: 'returned',
      comment: '@東一郎 単位を確認して再提出してください',
    });

    const comments = await db.select('comments', {
      where: { targetType: 'data_point', targetId: submitted[0]!.id },
    });
    const withMention = comments.find((c) => c.body.includes('@東一郎'));
    expect(withMention?.mentions).toEqual([userId('site-user@demo.local')]);

    const notified = await db.select('notifications', {
      where: { userId: userId('site-user@demo.local') },
    });
    expect(notified.some((n) => n.title.includes('メンション'))).toBe(true);
  });

  it('メンション候補は自組織のメンバーのみ', async () => {
    const candidates = await listMentionCandidates(db, manager());
    expect(candidates.length).toBeGreaterThan(0);
    // 別テナント（蒼天・監査法人）のユーザーが混ざらない
    const names = candidates.map((c) => c.displayName);
    expect(names).not.toContain('蒼天 次郎');
    expect(names).not.toContain('青葉 健');
  });
});
