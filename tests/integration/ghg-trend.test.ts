import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { loadConsolidatedTrend } from '@/lib/services/aggregation';
import type { AuthorizationContext } from '@/types/domain';

/**
 * GHG 連結値の「直近3年の推移」。
 *
 * 確かめたいこと:
 *  - FY2024（過年度 Fixture）が closed・承認済みで存在し、古い年 → 新しい年の順に 3 期間返る
 *  - 連結値が Fixture の基準値 × 規模係数 × 年度比率から再計算した値と一致する
 *  - FY2024 は GHG 3 指標に限定されている（他指標の過年度を作らない）
 */

let db: DemoDbClient;
let fixture: FixtureDb;

function manager(): AuthorizationContext {
  return {
    userId: userId('sustainability@demo.local'),
    email: 'sustainability@demo.local',
    displayName: 'sustainability',
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys: ['sustainability_manager'],
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('直近3年の連結推移', () => {
  it('FY2024 → FY2025 → FY2026 の順に 3 期間返り、連結値が再計算と一致する', async () => {
    const periods = fixture.periods.filter((p) => p.organizationId === ORG_IDS.aomi);
    const trend = await loadConsolidatedTrend(db, manager(), periods, [
      'scope1',
      'scope2',
      'scope3_cat1',
    ]);

    expect(trend.map((t) => t.period.code)).toEqual(['FY2024', 'FY2025', 'FY2026']);

    const metricOf = (index: number, code: string) =>
      trend[index]!.metrics.find((m) => m.metric.code === code);

    // FY2024 scope1: HQ 1352.1 + EAST 4326.9 + WEST 3245.1 + EU 811.3（JV は持分法で除外）
    expect(metricOf(0, 'scope1')?.consolidated).toBe(9735.4);
    // FY2025 scope1: 1240.5 + 3969.6 + 2977.2 + 744.3
    expect(metricOf(1, 'scope1')?.consolidated).toBe(8931.6);
    // scope1 は減少トレンド（FY2024 > FY2025 > FY2026 推計込み）
    expect(metricOf(0, 'scope1')!.consolidatedWithEstimates).toBeGreaterThan(
      metricOf(1, 'scope1')!.consolidatedWithEstimates,
    );

    // scope3_cat1 は HQ のみ。FY2024 = 48,210 × 0.93
    expect(metricOf(0, 'scope3_cat1')?.consolidated).toBe(44835.3);
    // FY2026 は内部取引控除後（50,620.5 − 2,490.5）
    expect(metricOf(2, 'scope3_cat1')?.consolidated).toBe(48130);

    // 過年度（FY2024/FY2025）は全拠点承認済みのため推計補完が無い
    expect(metricOf(0, 'scope1')?.estimates).toEqual([]);
    expect(metricOf(1, 'scope1')?.estimates).toEqual([]);
  });

  it('作成直後の空の年度や変則コードの年度は、実績のある 3 年を押し出さない', async () => {
    // 報告年度の追加フォームを模す: 実績ゼロの planning 年度＋変則コード
    fixture.periods.push(
      {
        id: 'p-fy2027',
        organizationId: ORG_IDS.aomi,
        code: 'FY2027',
        label: '2027年度',
        startDate: '2027-04-01',
        endDate: '2028-03-31',
        status: 'planning',
        submissionDueDate: null,
        createdAt: '2027-04-01T00:00:00.000Z',
        updatedAt: '2027-04-01T00:00:00.000Z',
        createdBy: null,
        updatedBy: null,
      },
      {
        id: 'p-r9',
        organizationId: ORG_IDS.aomi,
        code: '2028年度（変則）',
        label: '2028年度',
        startDate: '2028-04-01',
        endDate: '2029-03-31',
        status: 'planning',
        submissionDueDate: null,
        createdAt: '2027-04-01T00:00:00.000Z',
        updatedAt: '2027-04-01T00:00:00.000Z',
        createdBy: null,
        updatedBy: null,
      },
    );

    const periods = fixture.periods.filter((p) => p.organizationId === ORG_IDS.aomi);
    const trend = await loadConsolidatedTrend(db, manager(), periods, [
      'scope1',
      'scope2',
      'scope3_cat1',
    ]);

    // 承認済み実績の無い年度は載らず、開始日順の実績 3 年のまま
    expect(trend.map((t) => t.period.code)).toEqual(['FY2024', 'FY2025', 'FY2026']);
  });

  it('FY2024 の Data Point は GHG 3 指標に限定され、すべて承認済み', async () => {
    const fy2024 = fixture.periods.find((p) => p.code === 'FY2024');
    expect(fy2024?.status).toBe('closed');

    const rows = fixture.dataPoints.filter((dp) => dp.reportingPeriodId === fy2024!.id);
    const codes = new Set(
      rows.map((dp) => fixture.metrics.find((m) => m.id === dp.metricId)?.code),
    );
    expect([...codes].sort()).toEqual(['scope1', 'scope2', 'scope3_cat1']);
    expect(rows.every((dp) => dp.status === 'approved')).toBe(true);
    // 承認済みで Evidence 必須の指標なので、全行に Evidence リンクが付く
    for (const dp of rows) {
      expect(
        fixture.evidenceLinks.some((link) => link.targetId === dp.id),
        `${dp.id} に Evidence リンクが無い`,
      ).toBe(true);
    }
  });
});
