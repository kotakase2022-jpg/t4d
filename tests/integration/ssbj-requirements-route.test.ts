import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { isInScope, loadSsbjRequirementViews } from '@/lib/services/ssbj-gap';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * GET /api/exports/ssbj-requirements（要求事項一覧の CSV）が画面と同じ絞り込みを通すこと。
 *
 * 要求事項画面の CSV リンクは `scope=in_scope`（評価対象だけ）を渡す（W0 O1）。
 * Route Handler がこれを落とすと、画面で見えていない対象外の行まで CSV に入り、
 * 画面の件数と CSV の行数が食い違う。
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

const { GET } = await import('@/app/api/exports/ssbj-requirements/route');

let fixture: FixtureDb;

function ctxFor(email: string, roleKeys: RoleKey[]): AuthorizationContext {
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

const manager = () =>
  ctxFor('sustainability@demo.local', ['sustainability_manager', 'enterprise_admin']);

async function csvLines(query: string): Promise<string[]> {
  const response = await GET(
    new Request(`http://localhost/api/exports/ssbj-requirements?${query}`),
  );
  expect(response.status).toBe(200);
  return (await response.text()).trimEnd().split('\r\n');
}

beforeEach(() => {
  fixture = createFixtureDb();
  state.db = new DemoDbClient(fixture);
  state.ctx = manager();
});

describe('SSBJ 要求事項 CSV の Route Handler', () => {
  it('scope=in_scope を渡すと、評価対象（対象外・重要性なしを除く）の行だけを出す', async () => {
    const period = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
    const loaded = (await loadSsbjRequirementViews(state.db!, manager(), period))!;
    const inScope = loaded.views.filter(isInScope);
    // 前提: Fixture に評価対象外の要求事項がある（無いと絞り込みの有無を区別できない）
    expect(inScope.length).toBeLessThan(loaded.views.length);

    const all = await csvLines(`period=${PERIOD_IDS.fy2026}`);
    const scoped = await csvLines(`period=${PERIOD_IDS.fy2026}&scope=in_scope`);
    expect(all.length).toBe(loaded.views.length + 1);
    expect(scoped.length).toBe(inScope.length + 1);
  });

  it('画面の未対応リンクと同じ条件（scope と coverage の併用）で絞られる', async () => {
    const period = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
    const loaded = (await loadSsbjRequirementViews(state.db!, manager(), period))!;
    const expected = loaded.views.filter(
      (v) => isInScope(v) && (v.combined === 'not_covered' || v.combined === 'unconfirmed'),
    );
    const lines = await csvLines(
      `period=${PERIOD_IDS.fy2026}&scope=in_scope&coverage=not_covered&coverage=unconfirmed`,
    );
    expect(lines.length).toBe(expected.length + 1);
  });
});
