import { describe, expect, it } from 'vitest';
import { AuthorizationError, assertCan } from '@/lib/authorization/can';
import {
  PERMISSION_LABELS,
  permissionRequiredMessage,
} from '@/lib/authorization/permission-labels';
import { PERMISSION_KEYS, type AuthorizationContext, type RoleKey } from '@/types/domain';

/**
 * 権限の表示名（plan §1.17・§4 B4）。権限キーを画面に出さず、何が足りないか・誰に頼むかを示す。
 * 権限の定義（roles.ts・0002_identity.sql）は変えない（authorization.test.ts が一致を検査している）。
 */

function ctxWith(roleKeys: RoleKey[]): AuthorizationContext {
  return {
    userId: 'u-1',
    email: 'u@example.com',
    displayName: 'テスト 利用者',
    demo: true,
    workspace: {
      organizationId: 'org-1',
      organizationName: '架空株式会社',
      organizationType: 'enterprise',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
  } as unknown as AuthorizationContext;
}

describe('権限の表示名', () => {
  it.each([...PERMISSION_KEYS])('%s: 業務の言葉の名前と依頼先を持つ', (key) => {
    const entry = PERMISSION_LABELS[key];
    expect(entry.label.trim()).not.toBe('');
    expect(entry.label).not.toContain(key);
    expect(/^[\x20-\x7e]+$/.test(entry.label)).toBe(false);
    expect(entry.holders.trim()).not.toBe('');
  });

  it('依頼先は権限を持つ役割の名前（多いときは「など」で切る）', () => {
    expect(PERMISSION_LABELS['enterprise.org.manage'].holders).toBe('企業管理者');
    expect(PERMISSION_LABELS['enterprise.data.approve'].holders).toBe('最終承認者');
    expect(PERMISSION_LABELS['enterprise.data.read'].holders).toMatch(/など$/);
  });

  it('assertCan の文は権限キーを含まず、「権限」の語と依頼先を含む', () => {
    const ctx = ctxWith(['site_contributor']);
    let error: unknown;
    try {
      assertCan(ctx, 'enterprise.disclosure.read');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AuthorizationError);
    const message = (error as Error).message;
    expect(message).toMatch(/権限/);
    expect(message).not.toContain('enterprise.disclosure.read');
    expect(message).toBe(permissionRequiredMessage('enterprise.disclosure.read'));
    expect(message).toContain('「開示の閲覧」');
    // 調査用に、足りなかった権限キーはエラーの属性として残す
    expect((error as AuthorizationError).permission).toBe('enterprise.disclosure.read');
  });

  it('権限があれば何もしない', () => {
    expect(() => assertCan(ctxWith(['enterprise_admin']), 'enterprise.org.manage')).not.toThrow();
  });
});
