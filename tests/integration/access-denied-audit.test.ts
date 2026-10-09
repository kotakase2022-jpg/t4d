import { beforeEach, describe, expect, it } from 'vitest';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { accessDeniedResponse, recordAccessDenied } from '@/lib/errors/access-denied';
import type { DbClient } from '@/lib/repositories/types';
import type { AuthorizationContext } from '@/types/domain';

/**
 * 権限で断った操作の監査ログ（トライアル対応 NF-27。int:access-denied-audit）。
 * 権限名とルートのパターンだけを残す（ID・クエリ・入力値を入れない）。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

const viewer: AuthorizationContext = {
  userId: userId('enterprise-admin@demo.local'),
  email: 'enterprise-admin@demo.local',
  displayName: 'テスト',
  workspace: {
    organizationId: ORG_IDS.aomi,
    organizationType: 'enterprise',
    organizationName: 'テスト',
    roleKeys: ['viewer'],
    unitScopeIds: [],
  },
  engagementIds: [],
  demo: true,
};

describe('access_denied', () => {
  it('権限名とルートのパターンだけを記録する', async () => {
    const before = fixture.auditEvents.length;
    await recordAccessDenied(db, viewer, {
      permission: 'enterprise.disclosure.write',
      route:
        '/enterprise/disclosure-projects/7f1c2a3b-1d2e-4f5a-8b6c-7d8e9f0a1b2c?tab=requirements',
    });
    expect(fixture.auditEvents).toHaveLength(before + 1);
    const event = fixture.auditEvents.at(-1)!;
    expect(event.eventType).toBe('access_denied');
    expect(event.resourceId).toBeNull();
    expect(event.metadata).toEqual({
      permission: 'enterprise.disclosure.write',
      route: '/enterprise/disclosure-projects/[id]',
    });
    expect(JSON.stringify(event)).not.toContain('7f1c2a3b');
    expect(JSON.stringify(event)).not.toContain('requirements');
  });

  it('出力 API の 403 は既存の形のまま返し、記録する', async () => {
    const response = await accessDeniedResponse(db, viewer, {
      permission: 'enterprise.export.run',
      request: new Request('https://example.invalid/api/exports/data-points?format=csv&period=x'),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
    const event = fixture.auditEvents.at(-1)!;
    expect(event.eventType).toBe('access_denied');
    expect(event.metadata).toEqual({
      permission: 'enterprise.export.run',
      route: '/api/exports/data-points',
    });
  });

  it('記録に失敗しても投げない（断った応答を変えない）', async () => {
    const broken: DbClient = {
      mode: db.mode,
      select: (table, query) => db.select(table, query),
      count: (table, query) => db.count(table, query),
      findById: (table, id) => db.findById(table, id),
      insert: async () => {
        throw new Error('down');
      },
      update: (table, id, patch) => db.update(table, id, patch),
      softDelete: (table, id, by) => db.softDelete(table, id, by),
    };
    await expect(
      recordAccessDenied(broken, viewer, { permission: null, route: '/x' }),
    ).resolves.toBeUndefined();
  });
});
