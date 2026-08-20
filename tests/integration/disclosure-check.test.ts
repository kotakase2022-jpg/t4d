import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import {
  loadConsistencyCheck,
  runDisclosureConsistencyCheck,
} from '@/lib/services/disclosure-check';
import type { AuthorizationContext, ReportingPeriod, RoleKey } from '@/types/domain';

/**
 * 開示回答の整合チェック（CDP-P0-006）の Integration テスト。
 * Server Action と同じ Service を通す。Demo Mode なので Provider は決定論的 Mock。
 */

let db: DemoDbClient;
let fixture: FixtureDb;
let periods: ReportingPeriod[];
let current: ReportingPeriod;

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

const manager = () => ctxFor('sustainability@demo.local', ORG_IDS.aomi, ['sustainability_manager']);
const otherOrg = () =>
  ctxFor('other-enterprise-admin@demo.local', ORG_IDS.soten, ['enterprise_admin']);

beforeEach(async () => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  periods = await db.select('periods', { where: { organizationId: ORG_IDS.aomi } });
  current = periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
});

describe('整合チェック（CDP-P0-006）', () => {
  it('実行すると AI Run が記録され、指摘が返る', async () => {
    const ctx = manager();
    const before = await db.count('aiRuns', { where: { organizationId: ORG_IDS.aomi } });

    const { run, issues } = await runDisclosureConsistencyCheck(db, ctx, 'cdp', current, periods);

    expect(run.featureType).toBe('inconsistencyCheck');
    expect(run.organizationId).toBe(ORG_IDS.aomi);
    expect(run.status).toBe('succeeded');
    // 根拠（回答・前年回答）が provenance として残る
    expect(run.sourceReferences.length).toBeGreaterThan(0);

    const after = await db.count('aiRuns', { where: { organizationId: ORG_IDS.aomi } });
    expect(after).toBe(before + 1);

    // Fixture には未記入・Evidence 無しの回答が含まれるため、必ず 1 件以上検出される
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(['high', 'medium', 'low']).toContain(issue.severity);
      expect(issue.subject).not.toBe('');
      expect(issue.detail).not.toBe('');
    }
  });

  it('AI は回答も状態も書き換えない（候補の提示のみ）', async () => {
    const ctx = manager();
    const before = await db.select('disclosureResponses', {
      where: { organizationId: ORG_IDS.aomi },
      orderBy: { column: 'id' },
    });
    const beforeVersions = await db.count('disclosureResponseVersions', {
      where: { organizationId: ORG_IDS.aomi },
    });

    await runDisclosureConsistencyCheck(db, ctx, 'cdp', current, periods);

    const after = await db.select('disclosureResponses', {
      where: { organizationId: ORG_IDS.aomi },
      orderBy: { column: 'id' },
    });
    const afterVersions = await db.count('disclosureResponseVersions', {
      where: { organizationId: ORG_IDS.aomi },
    });

    expect(after.map((r) => `${r.id}:${r.status}:${r.answerText ?? ''}`)).toEqual(
      before.map((r) => `${r.id}:${r.status}:${r.answerText ?? ''}`),
    );
    expect(afterVersions).toBe(beforeVersions);
  });

  it('結果を runId で読み直せる', async () => {
    const ctx = manager();
    const { run, issues } = await runDisclosureConsistencyCheck(db, ctx, 'cdp', current, periods);

    const reloaded = await loadConsistencyCheck(db, ctx, run.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.run.id).toBe(run.id);
    expect(reloaded!.issues).toHaveLength(issues.length);
  });

  it('他組織の実行結果は読めない（テナント分離）', async () => {
    const { run } = await runDisclosureConsistencyCheck(db, manager(), 'cdp', current, periods);
    const leaked = await loadConsistencyCheck(db, otherOrg(), run.id);
    expect(leaked).toBeNull();
  });

  it('inconsistencyCheck 以外の AI Run を runId 指定で読み出せない', async () => {
    const ctx = manager();
    const otherRuns = await db.select('aiRuns', {
      where: { organizationId: ORG_IDS.aomi, featureType: 'cdpDraftGeneration' },
      limit: 1,
    });
    if (otherRuns.length > 0) {
      expect(await loadConsistencyCheck(db, ctx, otherRuns[0]!.id)).toBeNull();
    }
    // 存在しない ID も null
    expect(await loadConsistencyCheck(db, ctx, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('AI 実行権限が無いロールは実行できない', async () => {
    const viewer = ctxFor('site-user@demo.local', ORG_IDS.aomi, ['viewer']);
    await expect(
      runDisclosureConsistencyCheck(db, viewer, 'cdp', current, periods),
    ).rejects.toThrow();
  });
});
