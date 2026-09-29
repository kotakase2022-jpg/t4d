import { beforeEach, describe, expect, it } from 'vitest';
import { dataPointId, metricId, ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  computeConsolidatedAggregation,
  summarizeMetricTotals,
  summarizeScope3,
} from '@/lib/services/aggregation';
import { loadDisclosureWorkspace } from '@/lib/services/disclosure';
import { loadSsbjRequirementViews } from '@/lib/services/ssbj-gap';
import { validateDataPoints } from '@/lib/validation/data-point-rules';
import type {
  AuthorizationContext,
  DataPoint,
  MetricDefinition,
  ReportingPeriod,
  RoleKey,
} from '@/types/domain';

/**
 * 実績ゼロと未入力の区別（W0 棚卸し O4、指示書 §7.1・§7.2 / 受入 A07〜A10）。
 *
 * 以前は `dp.value ?? 0` で足しており、Data Point の無い Scope2（ロケーション基準）・
 * Scope3 合計が GHG 画面で「0」と表示されていた。逆に開示の当年値は合計が 0 なら
 * 「データなし」にしていた（実績ゼロが消える）。
 */

let db: DemoDbClient;
let fixture: FixtureDb;
let fy2026: ReportingPeriod;
let metrics: MetricDefinition[];

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

const fy2026Rows = () =>
  fixture.dataPoints.filter(
    (dp) => dp.organizationId === ORG_IDS.aomi && dp.reportingPeriodId === PERIOD_IDS.fy2026,
  );

/** 本社の Scope1（FY2026）を複製して、指定の指標・値の行を足す（テスト用の架空行） */
function addHqRow(metricCode: string, patch: Partial<DataPoint>): DataPoint {
  const base = fixture.dataPoints.find((dp) => dp.id === dataPointId('HQ', 'scope1', 'FY2026'))!;
  const row: DataPoint = {
    ...base,
    id: `${base.id.slice(0, 24)}${String(fixture.dataPoints.length).padStart(12, '0')}`,
    metricId: metricId('AOMI', metricCode),
    currentVersionId: null,
    changedAfterApproval: false,
    ...patch,
  };
  fixture.dataPoints.push(row);
  return row;
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  fy2026 = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
  metrics = fixture.metrics.filter((m) => m.organizationId === ORG_IDS.aomi);
});

describe('O4 / A07: 行が無い・値が無い指標は 0 にならない', () => {
  it('FY2026 の Scope2（ロケーション基準）と Scope3 合計は、合計が null（未入力）', () => {
    for (const code of ['scope2_location', 'scope3_total']) {
      const rows = fy2026Rows().filter((dp) => dp.metricId === metricId('AOMI', code));
      const totals = summarizeMetricTotals(rows);
      expect(totals.count, code).toBe(0);
      expect(totals.total, code).toBeNull();
      expect(totals.approvedTotal, code).toBeNull();
    }
    // 値のある指標は従来どおり合計が出る
    const scope1 = summarizeMetricTotals(
      fy2026Rows().filter((dp) => dp.metricId === metricId('AOMI', 'scope1')),
    );
    expect(scope1.total).not.toBeNull();
    expect(scope1.total!).toBeGreaterThan(0);
  });

  it('実績ゼロは 0、未入力・対象外は数えず、推計・目標は実績の合計に入れない', () => {
    const base = { status: 'approved' as const, boundary: '連結' };
    const zero = { ...base, value: 0, availabilityStatus: 'value_present' as const };
    const rows = [
      addHqRow('scope3_cat2', { ...zero, valueKind: 'actual' }),
      addHqRow('scope3_cat2', {
        ...base,
        value: null,
        availabilityStatus: 'not_applicable',
        absenceReason: '該当する資本財の購入なし（架空）',
      }),
      addHqRow('scope3_cat2', { ...base, value: 12, valueKind: 'estimate' }),
      addHqRow('scope3_cat2', { ...base, value: 999, valueKind: 'target' }),
    ];
    const totals = summarizeMetricTotals(rows);
    expect(totals.total).toBe(0);
    expect(totals.valueCount).toBe(1);
    expect(totals.estimateTotal).toBe(12);
    expect(totals.absentByStatus).toEqual({ not_applicable: 1 });
    expect(totals.count).toBe(4);
  });

  it('連結集計: 値の無い承認済み行を 0 として足さず、前年の承認済み実績で補完（推計）する', async () => {
    const before = await computeConsolidatedAggregation(db, manager(), fy2026, fixture.periods, [
      'scope1',
    ]);
    const hq = fixture.dataPoints.find((dp) => dp.id === dataPointId('HQ', 'scope1', 'FY2026'))!;
    const hqValue = hq.value!;
    hq.value = null;
    hq.availabilityStatus = 'not_entered';

    const after = await computeConsolidatedAggregation(db, manager(), fy2026, fixture.periods, [
      'scope1',
    ]);
    const agg = after.metrics[0]!;
    // 本社分が実績から外れる（0 を足したのではなく、行を数えない）
    expect(agg.valueCount).toBe(before.metrics[0]!.valueCount - 1);
    expect(agg.simpleSum).toBeCloseTo(before.metrics[0]!.simpleSum - hqValue, 1);
    // 本社は前年値で補完され、推計として別掲される（実績とは混ぜない）
    const hqEstimate = agg.estimates.find((e) => e.unitId === hq.unitId);
    expect(hqEstimate?.basis).toContain('前年');
    expect(agg.consolidatedWithEstimates).toBeGreaterThan(agg.consolidated);
  });

  it('連結集計: 承認済みの値が 1 件も無い指標は valueCount 0（画面は「未入力」）', async () => {
    const result = await computeConsolidatedAggregation(db, manager(), fy2026, fixture.periods, [
      'scope2',
      'scope2_location',
    ]);
    const byCode = new Map(result.metrics.map((m) => [m.metric.code, m]));
    expect(byCode.get('scope2')!.valueCount).toBeGreaterThan(0);
    expect(byCode.get('scope2_location')!.valueCount).toBe(0);
  });

  it('開示の当年値は行の有無で「データなし」を決める（実績ゼロは 0 のまま）', async () => {
    for (const dp of fy2026Rows()) {
      if (dp.metricId === metricId('AOMI', 'energy') && dp.status === 'approved') dp.value = 0;
    }
    const periods = fixture.periods.filter((p) => p.organizationId === ORG_IDS.aomi);
    const ws = await loadDisclosureWorkspace(db, manager(), 'csrd', fy2026, periods, metrics);
    const e15 = ws!.rows.find((r) => r.item.code === 'ESRS-E1-5')!;
    expect(e15.currentValue).toBe(0);
    expect(e15.dataCoverage).toBe('full');
  });

  it('検証: 対象外・未取得・未算定に理由があれば「値が入力されていない」エラーにしない', () => {
    const units = fixture.units.filter((u) => u.organizationId === ORG_IDS.aomi);
    const common = { status: 'draft' as const, value: null, textValue: null };
    const declared = addHqRow('scope3_cat3', {
      ...common,
      availabilityStatus: 'not_calculated',
      absenceReason: '算定方法を検討中（架空）',
    });
    const noReason = addHqRow('scope3_cat4', {
      ...common,
      availabilityStatus: 'not_obtained',
      absenceReason: null,
    });
    const blank = addHqRow('scope3_cat5', { ...common, availabilityStatus: 'not_entered' });
    const results = validateDataPoints({
      dataPoints: [declared, noReason, blank],
      metrics,
      units,
      periods: fixture.periods,
      evidenceCountByDataPoint: new Map(),
      previousPeriodDataPoints: [],
      detectedAt: '2026-08-14T00:00:00.000Z',
    });
    const required = (id: string) =>
      results.filter((r) => r.dataPointId === id && r.ruleKey === 'required');
    expect(required(declared.id)).toHaveLength(0);
    expect(required(noReason.id).map((r) => r.severity)).toEqual(['warning']);
    expect(required(blank.id).map((r) => r.severity)).toEqual(['error']);
  });
});

describe('A08: Scope2 の 2 方式は足さない', () => {
  it('ロケーション基準とマーケット基準は別の指標・別の集計行で、合算した値を作らない', async () => {
    addHqRow('scope2_location', { status: 'approved', value: 21000.5 });
    const result = await computeConsolidatedAggregation(db, manager(), fy2026, fixture.periods, [
      'scope2',
      'scope2_location',
    ]);
    const market = result.metrics.find((m) => m.metric.code === 'scope2')!;
    const location = result.metrics.find((m) => m.metric.code === 'scope2_location')!;
    expect(location.consolidated).toBe(21000.5);
    // マーケット基準の値はロケーション基準の行を追加しても変わらない
    const marketOnly = await computeConsolidatedAggregation(
      db,
      manager(),
      fy2026,
      fixture.periods,
      ['scope2'],
    );
    expect(market.consolidated).toBe(marketOnly.metrics[0]!.consolidated);
  });
});

describe('A09 / A10: Scope3 はカテゴリー別の状況を出し、合計とは照合するだけ', () => {
  it('Cat.1 だけが登録された状態を Scope3 全体の完成として扱わない', () => {
    const status = summarizeScope3(metrics, fy2026Rows());
    expect(status.categories).toHaveLength(15);
    expect(status.categories[0]!.state).toBe('value_present');
    expect(status.presentCount).toBe(1);
    expect(status.pendingCount).toBe(14);
    expect(status.categories.slice(1).every((c) => c.state === 'not_entered')).toBe(true);
    expect(status.completeness).toBe('incomplete');
    // Scope3 合計は未登録。Cat.1 の値を合計として出さない
    expect(status.total.value).toBeNull();
    expect(status.reconciliation).toBeNull();
  });

  it('対象外の判断と理由はカテゴリーの状態として残り、未入力とは区別される', () => {
    addHqRow('scope3_cat14', {
      value: null,
      availabilityStatus: 'not_applicable',
      absenceReason: 'フランチャイズ事業なし（架空）',
    });
    const status = summarizeScope3(metrics, fy2026Rows());
    const cat14 = status.categories.find((c) => c.category === 14)!;
    expect(cat14.state).toBe('not_applicable');
    expect(cat14.reasons).toEqual(['フランチャイズ事業なし（架空）']);
    expect(status.notApplicableCount).toBe(1);
    expect(status.pendingCount).toBe(13);
  });

  it('合計とカテゴリーが両方あれば、差を示し（丸め差を超えれば要確認）、足さない', () => {
    const cat1 = summarizeScope3(metrics, fy2026Rows()).categories[0]!.total!;
    addHqRow('scope3_cat4', { value: 1200.4 });
    addHqRow('scope3_total', { value: Math.round((cat1 + 1200.4) * 10) / 10 });

    const matched = summarizeScope3(metrics, fy2026Rows());
    expect(matched.total.value).toBe(Math.round((cat1 + 1200.4) * 10) / 10);
    expect(matched.reconciliation!.categorySum).toBeCloseTo(cat1 + 1200.4, 1);
    expect(matched.reconciliation!.withinTolerance).toBe(true);

    // 差異が丸めを超える（合計側に 500 t の未説明差）→ 要確認
    fixture.dataPoints.find((dp) => dp.metricId === metricId('AOMI', 'scope3_total'))!.value =
      Math.round((cat1 + 1700.4) * 10) / 10;
    const mismatched = summarizeScope3(metrics, fy2026Rows());
    expect(mismatched.reconciliation!.difference).toBeCloseTo(500, 1);
    expect(mismatched.reconciliation!.withinTolerance).toBe(false);
    // 合計はあくまで登録された scope3_total の値（カテゴリーを足した値ではない）
    expect(mismatched.total.value).toBe(Math.round((cat1 + 1700.4) * 10) / 10);
  });

  it('SSBJ 気候-47(3)（Scope3 絶対総量）は Scope3 合計に対応し、Cat.1 の値で「データあり」にならない', async () => {
    const loaded = (await loadSsbjRequirementViews(db, manager(), fy2026))!;
    const byCode = new Map(loaded.views.map((v) => [v.item.code, v]));
    const scope3 = byCode.get('気候-47(3)')!;
    expect(scope3.hasDataLink).toBe(false);
    expect(scope3.dataCoverage).toBe('none');
    expect(scope3.missingMetrics.map((m) => m.code)).toEqual(['scope3_total']);
    // Scope1 は値があるので従来どおり「データあり」
    expect(byCode.get('気候-47(1)')!.hasDataLink).toBe(true);
    expect(byCode.get('気候-47(1)')!.dataCoverage).toBe('full');
  });
});
