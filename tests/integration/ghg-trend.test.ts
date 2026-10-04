import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { loadConsolidatedTrend } from '@/lib/services/aggregation';
import { validateDataPoints } from '@/lib/validation/data-point-rules';
import type { AuthorizationContext } from '@/types/domain';

/**
 * GHG 連結値の「直近3年の推移」。
 *
 * 確かめたいこと:
 *  - FY2024（過年度 Fixture）が closed・承認済みで存在し、古い年 → 新しい年の順に 3 期間返る
 *  - 連結値が Fixture の基準値 × 規模係数 × 年度比率から再計算した値と一致する
 *  - FY2024 は FY2025 と同じ収集 21 指標・同じ拠点の承認済み実績を持つ（自社経年比較のため 2026-10-02 に
 *    GHG 3 指標から広げた。GHG の値は変えていない）。基準から取り込んだ未収集の指標には値を作らない
 */

/** もともと社内で収集していた 21 指標（dataset.ts の COLLECTED_METRIC_CODES。昇順） */
const COLLECTED_21 = [
  'avg_tenure',
  'directors_count',
  'employees',
  'energy',
  'female_employees',
  'female_manager_ratio',
  'female_managers',
  'female_officer_ratio',
  'female_officers',
  'gender_pay_gap',
  'ltifr',
  'managers_total',
  'new_hires',
  'officers_total',
  'scope1',
  'scope2',
  'scope3_cat1',
  'training_hours',
  'turnover_rate',
  'waste',
  'water',
];

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

  it('FY2024 の Data Point は FY2025 と同じ収集 21 指標・同じ拠点で、すべて承認済み', async () => {
    const fy2024 = fixture.periods.find((p) => p.code === 'FY2024');
    const fy2025 = fixture.periods.find(
      (p) => p.code === 'FY2025' && p.organizationId === ORG_IDS.aomi,
    );
    expect(fy2024?.status).toBe('closed');

    const rows = fixture.dataPoints.filter((dp) => dp.reportingPeriodId === fy2024!.id);
    const metricOf = (metricId: string) => fixture.metrics.find((m) => m.id === metricId)!;
    const codes = new Set(rows.map((dp) => metricOf(dp.metricId).code));
    expect([...codes].sort()).toEqual(COLLECTED_21);
    // 拠点 × 指標の組も FY2025 とちょうど同じ（過年度だけにある行・欠けた行が無い）
    const keysOf = (periodId: string) =>
      fixture.dataPoints
        .filter((dp) => dp.reportingPeriodId === periodId)
        .map((dp) => `${dp.unitId}|${metricOf(dp.metricId).code}|${dp.boundary}`)
        .sort();
    expect(keysOf(fy2024!.id)).toEqual(keysOf(fy2025!.id));
    expect(rows).toHaveLength(73);
    expect(rows.every((dp) => dp.status === 'approved' && dp.approvedBy !== null)).toBe(true);
    // 承認の記録が版に付いている（承認済みの行はすべて final の承認を持つ）
    for (const dp of rows) {
      expect(
        fixture.approvals.some(
          (a) => a.targetId === dp.id && a.stage === 'final' && a.decision === 'approved',
        ),
        `${dp.id} に承認が無い`,
      ).toBe(true);
    }
    // Evidence 必須の指標は全行に Evidence リンクが付く（FY2024 の書類に紐付く）
    const evidenceRequired = rows.filter((dp) => metricOf(dp.metricId).requiresEvidence);
    expect(evidenceRequired.length).toBeGreaterThan(0);
    for (const dp of evidenceRequired) {
      expect(
        fixture.evidenceLinks.some((link) => link.targetId === dp.id),
        `${dp.id} に Evidence リンクが無い`,
      ).toBe(true);
    }
    // FY2025 の検証は FY2024 を前年として再計算される。過年度を足しても FY2025 に検証結果が出ない
    const fy2025Ids = new Set(
      fixture.dataPoints.filter((dp) => dp.reportingPeriodId === fy2025!.id).map((dp) => dp.id),
    );
    expect(fixture.validations.filter((v) => fy2025Ids.has(v.dataPointId))).toEqual([]);
    // FY2024 自体も検証規則に引っかからない（比率と分子・分母の食い違い・女性 > 総数・証跡なし等が無い）
    const evidenceCountByDataPoint = new Map<string, number>();
    for (const link of fixture.evidenceLinks) {
      if (link.targetType !== 'data_point') continue;
      evidenceCountByDataPoint.set(
        link.targetId,
        (evidenceCountByDataPoint.get(link.targetId) ?? 0) + 1,
      );
    }
    expect(
      validateDataPoints({
        dataPoints: rows,
        metrics: fixture.metrics.filter((m) => m.organizationId === ORG_IDS.aomi),
        units: fixture.units.filter((u) => u.organizationId === ORG_IDS.aomi),
        periods: fixture.periods,
        evidenceCountByDataPoint,
        previousPeriodDataPoints: [],
        detectedAt: '2026-10-02T00:00:00.000Z',
      }),
    ).toEqual([]);
  });
});
