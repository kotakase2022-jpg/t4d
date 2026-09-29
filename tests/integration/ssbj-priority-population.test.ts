import { beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_TODAY } from '@/lib/config';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  filterRequirements,
  isOpenHighPriority,
  loadActionPlans,
  loadSsbjOverview,
  loadSsbjRequirementViews,
  OPEN_HIGH_PRIORITY_QUERY,
  TOP_PRIORITY_LIMIT,
} from '@/lib/services/ssbj-gap';
import type { AuthorizationContext, ReportingPeriod, RoleKey } from '@/types/domain';

/**
 * SSBJ の優先度「高」の件数と、期限の基準日（W0 棚卸し O1・O5、指示書 §2.3）。
 *
 * O1: 対応状況画面の優先度「高」は、表示用に上位 8 件へ切り詰めた一覧から数えていたため
 *     8 を超えなかった。要求事項画面は対象外を含む全件から数えていた（母集団が違う）。
 * O5: 期限の残り日数は src/lib/clock.ts の基準日で計算する（差し替え可能）。
 */

let db: DemoDbClient;
let fixture: FixtureDb;
let period: ReportingPeriod;

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

/** URL の絞り込み（OPEN_HIGH_PRIORITY_QUERY）を filterRequirements の引数へ直す */
function filtersFromQuery(query: string) {
  const params = new URLSearchParams(query);
  return {
    priority: params.getAll('priority'),
    scope: params.getAll('scope'),
    coverage: params.getAll('coverage'),
  };
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  period = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
});

describe('O1: 優先度「高」の件数は表示の上限に縛られない', () => {
  it('件数は評価対象・未対応の全件から数え、上位 8 件の一覧とは別に持つ', async () => {
    const overview = (await loadSsbjOverview(db, manager(), period, '出所'))!;
    const loaded = (await loadSsbjRequirementViews(db, manager(), period))!;

    const expected = loaded.views.filter(
      (v) =>
        v.assessment.applicability === 'applicable' &&
        v.assessment.materiality !== 'not_material' &&
        v.combined !== 'covered' &&
        v.priority.priority === 'high',
    ).length;
    expect(overview.counts.highPriority).toBe(expected);

    // 表示は上位 8 件に切り詰めたまま。件数はそれを超えうる（Fixture では超える）
    expect(overview.topPriorities).toHaveLength(TOP_PRIORITY_LIMIT);
    expect(overview.counts.highPriority).toBeGreaterThan(TOP_PRIORITY_LIMIT);
    const highInTop = overview.topPriorities.filter((v) => v.priority.priority === 'high').length;
    expect(overview.counts.highPriority).not.toBe(highInTop);
  });

  it('要求事項画面の工程 4 のリンク先の絞り込みは、同じ母集団・同じ件数になる', async () => {
    const overview = (await loadSsbjOverview(db, manager(), period, '出所'))!;
    const loaded = (await loadSsbjRequirementViews(db, manager(), period))!;

    const viaLink = filterRequirements(loaded.views, filtersFromQuery(OPEN_HIGH_PRIORITY_QUERY));
    expect(viaLink.length).toBe(overview.counts.highPriority);
    expect(viaLink.every(isOpenHighPriority)).toBe(true);
    expect(loaded.views.filter(isOpenHighPriority).length).toBe(overview.counts.highPriority);
  });

  it('対象外・重要性なしの要求事項は、優先度が高くても件数に入らない', async () => {
    const loaded = (await loadSsbjRequirementViews(db, manager(), period))!;
    // 全件の priority=high（以前の要求事項画面の数え方）は、対象外を含みうる
    const allHigh = filterRequirements(loaded.views, { priority: ['high'] });
    const outOfScopeHigh = allHigh.filter(
      (v) =>
        v.assessment.applicability === 'not_applicable' ||
        v.assessment.materiality === 'not_material',
    );
    for (const view of outOfScopeHigh) expect(isOpenHighPriority(view)).toBe(false);
    // scope=in_scope の絞り込みで外れる
    const inScopeOnly = filterRequirements(loaded.views, {
      priority: ['high'],
      scope: ['in_scope'],
    });
    expect(inScopeOnly.length).toBe(allHigh.length - outOfScopeHigh.length);
  });
});

describe('O5: 期限の基準日を 1 か所から受け取る', () => {
  it('既定（テスト＝デモ）は FIXTURE_TODAY 基準、差し替えた日付では残り日数が変わる', async () => {
    const atFixture = (await loadSsbjRequirementViews(db, manager(), period))!;
    const atLater = (await loadSsbjRequirementViews(db, manager(), period, {
      referenceDate: '2026-09-29',
    }))!;
    const deadlineOf = (views: typeof atFixture.views) =>
      views[0]!.priority.factors.find((f) => f.label === '対応期限')!.judgement;

    // FY2026 の提出期限は基準日 2026-08-14 の 30 日後
    expect(period.submissionDueDate).toBeTruthy();
    expect(deadlineOf(atFixture.views)).toContain('残り 30 日');
    expect(deadlineOf(atLater.views)).toContain('残り -16 日');
    expect(FIXTURE_TODAY).toBe('2026-08-14');
  });

  it('対応計画の残り日数も同じ基準日で求める', async () => {
    const plans = await loadActionPlans(db, manager(), period);
    const later = await loadActionPlans(db, manager(), period, { referenceDate: '2026-09-29' });
    const withDue = plans.find((p) => p.plan.dueDate !== null);
    expect(withDue, 'Fixture に期限付きの対応計画がある').toBeDefined();
    const same = later.find((p) => p.plan.id === withDue!.plan.id)!;
    // 2026-08-14 → 2026-09-29 は 46 日
    expect(withDue!.daysLeft! - same.daysLeft!).toBe(46);
  });
});
