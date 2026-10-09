import { beforeEach, describe, expect, it } from 'vitest';
import { ORG_IDS, at, userId } from '@/lib/fixtures/dataset';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { memberActivity } from '@/lib/services/audit-log';
import type { AuditEvent, AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * 利用状況（トライアル対応 NF-37・plan int:member-activity）。
 *
 *  - 監査ログを読める人（common.audit.read）だけ。持たない人には出さない（null）
 *  - 最終ログイン＝この組織のワークスペースに入った最後の記録。操作数＝直近 30 日の自社名義の操作
 *    （ログイン・ワークスペースの選択・ログアウトは数えない）
 *  - 他テナントの名義の記録は数えない
 */

let fixture: FixtureDb;
let db: DemoDbClient;

function enterprise(email: string, roleKeys: RoleKey[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const admin = () => enterprise('enterprise-admin@demo.local', ['enterprise_admin']);
const manager = () => enterprise('sustainability@demo.local', ['sustainability_manager']);
const NOW = new Date(at(0, 12));
const SUSTAINABILITY = userId('sustainability@demo.local');

let seq = 0;
function event(eventType: AuditEvent['eventType'], daysAgo: number, org = ORG_IDS.aomi) {
  seq += 1;
  fixture.auditEvents.push({
    id: fid('audit_event', `activity/${seq}`),
    actorUserId: SUSTAINABILITY,
    actorOrganizationId: org,
    eventType,
    resourceType: null,
    resourceId: null,
    engagementId: null,
    clientIpHash: null,
    userAgent: null,
    beforeSummary: null,
    afterSummary: null,
    metadata: {},
    createdAt: at(daysAgo, 3),
  });
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  // Fixture の記録（22 日前の資料依頼への回答）は数えたうえで、足した分を確かめる
  fixture.auditEvents = fixture.auditEvents.filter((e) => e.actorUserId !== SUSTAINABILITY);
  event('workspace_selected', 5);
  event('workspace_selected', 2);
  event('data_updated', 1);
  event('data_submitted', 10);
  event('data_updated', 40); // 30 日より前
  event('login_success', 1); // ログインは操作に数えない
  event('data_updated', 1, ORG_IDS.soten); // 他テナントの名義
});

describe('利用状況', () => {
  it('監査ログの閲覧権限が無い人には出さない', async () => {
    expect(await memberActivity(db, manager(), { now: NOW })).toBeNull();
  });

  it('最終ログインはこの組織に入った最後の記録、操作数は直近 30 日の自社名義の操作', async () => {
    const activity = await memberActivity(db, admin(), { now: NOW });
    expect(activity).not.toBeNull();
    expect(activity!.get(SUSTAINABILITY)).toEqual({ lastActiveAt: at(2, 3), actions30d: 2 });
  });

  it('記録の無いメンバーは「記録なし」（null・0）。メンバーでない人は含めない', async () => {
    const activity = (await memberActivity(db, admin(), { now: NOW }))!;
    const memberIds = fixture.memberships
      .filter((m) => m.organizationId === ORG_IDS.aomi)
      .map((m) => m.userId);
    expect([...activity.keys()].sort()).toEqual([...new Set(memberIds)].sort());
    const reviewer = activity.get(userId('reviewer@demo.local'))!;
    expect(reviewer.lastActiveAt).toBeNull();
    expect(activity.has(userId('other-enterprise-admin@demo.local'))).toBe(false);
  });
});
