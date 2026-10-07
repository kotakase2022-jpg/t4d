import { beforeEach, describe, expect, it } from 'vitest';
import { listDemoRoleChoices, resolveDemoRoleSwitch } from '@/lib/auth/demo-role';
import { AuthorizationError } from '@/lib/authorization/can';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * デモ専用の役割切替（指示書 §14.1「役割切替はデモ専用機構を利用し、本番の認可を弱めない」）。
 *
 * 切替先は「いま開いている組織の有効なメンバー」かつ「@demo.local」に限り、
 * Supabase Mode（本番）では候補も切替も出さない。権限は切替先のロールから通常どおり決まる。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  options: { demo?: boolean; organizationId?: string } = {},
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: options.organizationId ?? ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: options.demo ?? true,
  };
}

const author = (options?: { demo?: boolean }) =>
  ctxFor('sustainability@demo.local', ['sustainability_manager'], options);

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('切替候補', () => {
  it('同じ組織のデモ利用者を、実演の順（作成担当 → レビュアー → 最終承認者 → 管理者 → 拠点担当）で返す', async () => {
    const choices = await listDemoRoleChoices(db, author(), 'demo');
    expect(choices.map((c) => [c.displayName, c.demoRole, c.current])).toEqual([
      ['海野 みどり', '作成担当', true],
      ['検見川 涼', 'レビュアー', false],
      ['承 花子', '最終承認者', false],
      ['青海 太郎', '管理者', false],
      ['東 一郎', '拠点担当', false],
    ]);
    expect(choices.every((c) => c.email.endsWith('@demo.local'))).toBe(true);
    // ロール名は切替先のロールそのもの（切替で権限を付け足さない）
    expect(choices.find((c) => c.displayName === '承 花子')?.roleKeys).toEqual([
      'approver',
      'reviewer',
    ]);
  });

  it('監査法人でも、同じ法人のデモ利用者を実演の順（契約責任者 → マネージャー → 担当者 → 法人管理者）で返す', async () => {
    const manager: AuthorizationContext = {
      ...ctxFor('assurance-manager@demo.local', ['assurance_manager'], {
        organizationId: ORG_IDS.aoba,
      }),
    };
    manager.workspace = { ...manager.workspace, organizationType: 'assurance_firm' };
    const choices = await listDemoRoleChoices(db, manager, 'demo');
    expect(choices.map((c) => [c.displayName, c.demoRole, c.current])).toEqual([
      ['保 統括', '契約責任者', false],
      ['青葉 健', 'マネージャー', true],
      ['若葉 新', '担当者', false],
      ['法人 管理', '法人管理者', false],
    ]);
    // 別法人（くろべ）の利用者は候補に出さない
    expect(choices.some((c) => c.email === 'other-assurance-manager@demo.local')).toBe(false);
  });

  it('停止中のメンバーは候補に出さない', async () => {
    const index = fixture.memberships.findIndex(
      (m) => m.userId === userId('reviewer@demo.local') && m.organizationId === ORG_IDS.aomi,
    );
    fixture.memberships[index] = { ...fixture.memberships[index]!, status: 'suspended' };
    const choices = await listDemoRoleChoices(db, author(), 'demo');
    expect(choices.map((c) => c.displayName)).not.toContain('検見川 涼');
  });

  it('Supabase Mode（本番）では候補を返さない', async () => {
    expect(await listDemoRoleChoices(db, author(), 'supabase')).toEqual([]);
  });

  it('デモではないコンテキストでは候補を返さない', async () => {
    expect(await listDemoRoleChoices(db, author({ demo: false }), 'demo')).toEqual([]);
  });
});

describe('切替の可否（サーバー側の検査）', () => {
  it('同じ組織のデモ利用者へは切り替えられる（大文字小文字・前後の空白は無視）', async () => {
    const target = await resolveDemoRoleSwitch(db, author(), '  Reviewer@demo.local ', 'demo');
    expect(target.userId).toBe(userId('reviewer@demo.local'));
    expect(target.demoRole).toBe('レビュアー');
  });

  it('Supabase Mode（本番）では拒否する', async () => {
    await expect(
      resolveDemoRoleSwitch(db, author(), 'reviewer@demo.local', 'supabase'),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('デモではないコンテキストでは拒否する', async () => {
    await expect(
      resolveDemoRoleSwitch(db, author({ demo: false }), 'reviewer@demo.local', 'demo'),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it.each([
    ['別テナントの企業管理者', 'other-enterprise-admin@demo.local'],
    ['監査法人の利用者', 'assurance-manager@demo.local'],
    ['存在しないデモアカウント', 'nobody@demo.local'],
  ])('%sへは切り替えられない', async (_label, email) => {
    await expect(resolveDemoRoleSwitch(db, author(), email, 'demo')).rejects.toThrow(
      '同じ組織のデモアカウントにのみ切り替えられます。',
    );
  });

  it('@demo.local 以外のアカウントへは切り替えられない', async () => {
    await expect(
      resolveDemoRoleSwitch(db, author(), 'someone@example.com', 'demo'),
    ).rejects.toThrow('デモアカウント（@demo.local）以外へは切り替えられません。');
  });
});
