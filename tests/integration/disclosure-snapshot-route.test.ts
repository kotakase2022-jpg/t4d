import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { createReviewDraftSnapshot } from '@/lib/services/report-snapshot';
import type { AuthorizationContext, OrganizationType, RoleKey, Uuid } from '@/types/domain';

/**
 * GET /api/exports/disclosure-snapshots/[snapshotId] の応答（受入 A29）。
 *
 * 認証・権限・テナントの判定はサービスが行うが、Route Handler がその結果を
 * 「他テナント・存在しない ID は同じ 404」に揃えて返し、存在を漏らさないことを確かめる。
 */

const state: { ctx: AuthorizationContext | null; db: DemoDbClient | null } = {
  ctx: null,
  db: null,
};

vi.mock('@/lib/auth/session', () => ({
  getSession: async () => (state.ctx ? { context: state.ctx } : null),
}));
vi.mock('@/lib/repositories', () => ({
  getDb: async () => state.db,
}));

const { GET } = await import('@/app/api/exports/disclosure-snapshots/[snapshotId]/route');

let fixture: FixtureDb;

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  organizationId: Uuid = ORG_IDS.aomi,
  organizationType: OrganizationType = 'enterprise',
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType,
      organizationName: 'x',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);

async function call(snapshotId: string, query = 'format=csv&audience=internal') {
  const response = await GET(
    new Request(`http://localhost/api/exports/disclosure-snapshots/${snapshotId}?${query}`),
    { params: Promise.resolve({ snapshotId }) },
  );
  return response;
}

let snapshotId: string;

beforeEach(async () => {
  fixture = createFixtureDb();
  state.db = new DemoDbClient(fixture);
  state.ctx = manager();
  snapshotId = (await createReviewDraftSnapshot(state.db, manager(), IDS.projects.fy2026)).id;
});

describe('スナップショット出力の Route Handler', () => {
  it('自組織のスナップショットは出力し、内容ハッシュを応答ヘッダーにも載せる', async () => {
    const response = await call(snapshotId);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/csv');
    expect(response.headers.get('Content-Disposition')).toContain('attachment');
    const snapshot = fixture.reportSnapshots.find((s) => s.id === snapshotId)!;
    expect(response.headers.get('X-T4D-Content-Hash')).toBe(snapshot.contentHash);
    expect(fixture.exportArtifacts).toHaveLength(1);
  });

  it('A29: 他テナントの ID と存在しない ID は同じ 404 で、出力の記録も作らない', async () => {
    state.ctx = ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);
    const other = await call(snapshotId);
    const missing = await call('00000000-0000-4000-8000-000000000000');
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await other.json()).toEqual(await missing.json());
    expect(fixture.exportArtifacts).toHaveLength(0);
  });

  it('監査法人のワークスペースからは存在も示さない（404）', async () => {
    state.ctx = ctxFor(
      'assurance-manager@demo.local',
      ['assurance_manager'],
      ORG_IDS.aoba,
      'assurance_firm',
    );
    expect((await call(snapshotId)).status).toBe(404);
  });

  it('未ログインは 401、出力権限が無ければ 403、未対応の形式は 400', async () => {
    state.ctx = null;
    expect((await call(snapshotId)).status).toBe(401);
    state.ctx = ctxFor('reviewer@demo.local', ['reviewer']);
    expect((await call(snapshotId)).status).toBe(403);
    state.ctx = manager();
    expect((await call(snapshotId, 'format=pdf&audience=internal')).status).toBe(400);
    expect((await call(snapshotId, 'format=xlsx&audience=external')).status).toBe(400);
  });
});
