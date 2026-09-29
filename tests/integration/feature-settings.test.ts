import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError } from '@/lib/authorization/can';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS } from '@/lib/fixtures/disclosure-first';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  getFeatureSettings,
  isDisclosureFirstEnabled,
  setDisclosureFirst,
} from '@/lib/services/feature-settings';
import type { AuthorizationContext, OrganizationType, RoleKey } from '@/types/domain';

/**
 * 組織単位の機能設定（開示優先モード。docs/disclosure-first.md §2-1、指示書 §4.1）。
 *
 * A01: 企業管理者が有効化でき、有効・無効がメニューとホームの分岐に使われる。
 * 権限: 変更は enterprise.org.manage のみ。別テナントの設定には影響しない。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  organizationId: string = ORG_IDS.aomi,
  organizationType: OrganizationType = 'enterprise',
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType,
      organizationName: 'テスト組織',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const admin = () => ctxFor('enterprise-admin@demo.local', ['enterprise_admin']);
const author = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const otherTenantAdmin = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('機能設定の既定値', () => {
  it('主役の企業は行があり false（従来ナビ・従来ホームのまま）', async () => {
    const settings = await getFeatureSettings(db, admin());
    expect(settings.disclosureFirst).toBe(false);
    expect(settings.row?.id).toBe(DISCLOSURE_FIRST_IDS.featureSettings);
  });

  it('行が無い組織（別テナント）は既定値 false として扱う', async () => {
    const settings = await getFeatureSettings(db, otherTenantAdmin());
    expect(settings).toEqual({ disclosureFirst: false, row: null });
  });

  it('監査法人ワークスペースは企業の機能設定を読まない（既定値のまま）', async () => {
    const assurance = ctxFor(
      'assurance-manager@demo.local',
      ['assurance_manager'],
      ORG_IDS.aoba,
      'assurance_firm',
    );
    expect(await isDisclosureFirstEnabled(db, assurance)).toBe(false);
  });
});

describe('A01: 開示優先モードの切替', () => {
  it('企業管理者が有効化・無効化でき、変更は監査ログに残る', async () => {
    const saved = await setDisclosureFirst(db, admin(), true);
    expect(saved.disclosureFirst).toBe(true);
    expect(saved.updatedBy).toBe(userId('enterprise-admin@demo.local'));
    expect(await isDisclosureFirstEnabled(db, author())).toBe(true);

    await setDisclosureFirst(db, admin(), false);
    expect(await isDisclosureFirstEnabled(db, author())).toBe(false);

    const events = fixture.auditEvents.filter(
      (e) =>
        e.eventType === 'settings_changed' && e.resourceId === DISCLOSURE_FIRST_IDS.featureSettings,
    );
    expect(events.map((e) => [e.beforeSummary, e.afterSummary])).toEqual([
      ['開示優先モード: 無効', '開示優先モード: 有効'],
      ['開示優先モード: 有効', '開示優先モード: 無効'],
    ]);
    // 行は 1 組織 1 行のまま（切替のたびに増やさない）
    expect(
      fixture.organizationFeatureSettings.filter((r) => r.organizationId === ORG_IDS.aomi),
    ).toHaveLength(1);
  });

  it.each([
    ['本社サステナビリティ担当', author],
    ['レビュー担当', reviewer],
  ])('%s（enterprise.org.manage なし）は変更できない', async (_label, ctx) => {
    await expect(setDisclosureFirst(db, ctx(), true)).rejects.toBeInstanceOf(AuthorizationError);
    expect(await isDisclosureFirstEnabled(db, admin())).toBe(false);
    expect(fixture.auditEvents.some((e) => e.eventType === 'settings_changed')).toBe(false);
  });

  it('行が無い組織は初回の変更で行を作り、他の組織の設定には影響しない', async () => {
    await setDisclosureFirst(db, otherTenantAdmin(), true);

    const soten = fixture.organizationFeatureSettings.filter(
      (r) => r.organizationId === ORG_IDS.soten,
    );
    expect(soten).toHaveLength(1);
    expect(soten[0]?.disclosureFirst).toBe(true);
    expect(soten[0]?.createdBy).toBe(userId('other-enterprise-admin@demo.local'));
    // 主役の企業は無効のまま（テナントを混ぜない）
    expect(await isDisclosureFirstEnabled(db, admin())).toBe(false);
  });
});
