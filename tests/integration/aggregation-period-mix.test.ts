import { beforeEach, describe, expect, it } from 'vitest';
import { previousComparablePeriod } from '@/lib/domain/period-comparability';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, metricId, userId } from '@/lib/fixtures/dataset';
import { GHG_FIXTURE_IDS } from '@/lib/fixtures/ghg-verification';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { computeConsolidatedAggregation, loadConsolidatedTrend } from '@/lib/services/aggregation';
import type { AuthorizationContext, DataPoint } from '@/types/domain';

/**
 * 期間の混在対策（plan K10・CR-17・int:aggregation-period-mix）。暦年（CY2025）を足しても、年度（4〜3 月）の
 * 推移・前年は決算月が同じ期間どうしに限る。CY2025 に承認済みの実績があっても FY の推移・前年に入らない。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

const ctx: AuthorizationContext = {
  userId: userId('sustainability@demo.local'),
  email: 'sustainability@demo.local',
  displayName: 'テスト',
  workspace: {
    organizationId: ORG_IDS.aomi,
    organizationType: 'enterprise',
    organizationName: 'テスト',
    roleKeys: ['sustainability_manager'],
    unitScopeIds: [],
  },
  engagementIds: [],
  demo: true,
};

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  // CY2025 に承認済みの Scope1 の実績を足す（Data Point の下書きの反映を承認した後の状態を想定）
  for (const unitId of [UNIT_IDS.hq, UNIT_IDS.east, UNIT_IDS.west, UNIT_IDS.eu]) {
    const template = fixture.dataPoints.find(
      (d) =>
        d.unitId === unitId &&
        d.metricId === metricId('AOMI', 'scope1') &&
        d.reportingPeriodId === PERIOD_IDS.fy2025,
    )!;
    const row: DataPoint = {
      ...template,
      id: `${template.id.slice(0, -4)}cy25`,
      reportingPeriodId: GHG_FIXTURE_IDS.period,
      currentVersionId: null,
      value: 1,
    };
    fixture.dataPoints.push(row);
  }
});

describe('前年は決算月が同じ期間', () => {
  it('FY2025 の前年は FY2024（CY2025 ではない）。FY2026 の前年は FY2025', async () => {
    const periods = fixture.periods.filter((p) => p.organizationId === ORG_IDS.aomi);
    const fy2025 = periods.find((p) => p.id === PERIOD_IDS.fy2025)!;
    const fy2026 = periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
    expect(previousComparablePeriod(fy2025, periods, 'start')?.code).toBe('FY2024');
    expect(previousComparablePeriod(fy2025, periods, 'end')?.code).toBe('FY2024');
    expect(previousComparablePeriod(fy2026, periods, 'end')?.code).toBe('FY2025');
    const cy = periods.find((p) => p.id === GHG_FIXTURE_IDS.period)!;
    expect(previousComparablePeriod(cy, periods, 'end')).toBeNull();
    const aggregation = await computeConsolidatedAggregation(db, ctx, fy2025, periods, ['scope1']);
    expect(aggregation.previousPeriod?.code).toBe('FY2024');
  });
});

describe('推移は決算月が同じ期間だけ', () => {
  it('CY2025 に実績があっても FY の推移（既定の基準・FY2026 を基準）に入らない', async () => {
    const periods = fixture.periods.filter((p) => p.organizationId === ORG_IDS.aomi);
    const fy2026 = periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
    const byDefault = await loadConsolidatedTrend(db, ctx, periods, ['scope1']);
    expect(byDefault.map((e) => e.period.code)).toEqual(['FY2024', 'FY2025', 'FY2026']);
    const anchored = await loadConsolidatedTrend(db, ctx, periods, ['scope1'], 3, fy2026);
    expect(anchored.map((e) => e.period.code)).toEqual(['FY2024', 'FY2025', 'FY2026']);
  });

  it('CY2025 を基準にすると暦年の期間だけ', async () => {
    const periods = fixture.periods.filter((p) => p.organizationId === ORG_IDS.aomi);
    const cy = periods.find((p) => p.id === GHG_FIXTURE_IDS.period)!;
    const trend = await loadConsolidatedTrend(db, ctx, periods, ['scope1'], 3, cy);
    expect(trend.map((e) => e.period.code)).toEqual(['CY2025']);
  });
});
