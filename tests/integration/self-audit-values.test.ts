import { beforeEach, describe, expect, it } from 'vitest';
import { ORG_IDS, PERIOD_IDS, dataPointId, metricId, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { consolidatedTrendSeries, loadConsolidatedTrend } from '@/lib/services/aggregation';
import { loadEsgDashboard, type KpiCardView, type KpiKey } from '@/lib/services/kpi';
import {
  TARGET_KIND_SWITCH_ERROR,
  validateQuantitativeImport,
} from '@/lib/services/quantitative-import';
import type { AuthorizationContext, RoleKey, Uuid, ValueKind } from '@/types/domain';

/**
 * 自己監査（2026-09-29）: 数値の区分（実績・推計・目標）と「値なし」を 0 にしない規則の回帰テスト。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

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

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);

async function card(key: KpiKey, periodId: Uuid = PERIOD_IDS.fy2026): Promise<KpiCardView> {
  const dashboard = await loadEsgDashboard(db, manager(), { periodId });
  const found = dashboard.cards.find((c) => c.spec.key === key);
  if (!found) throw new Error(`card ${key}`);
  return found;
}

/** FY2025 の Scope1 の全拠点の行の区分を書き換える（承認済みのまま） */
function setScope1Kind(kind: ValueKind, units: string[] = ['HQ', 'EAST', 'WEST', 'EU']) {
  for (const unit of units) {
    const dp = fixture.dataPoints.find((d) => d.id === dataPointId(unit, 'scope1', 'FY2025'));
    if (!dp) continue;
    dp.valueKind = kind;
    const version = fixture.dataPointVersions.find((v) => v.id === dp.currentVersionId);
    if (version) version.valueKind = kind;
  }
}

describe('INV-F1 承認済みでも推計・目標は確定した実績に数えない（0 を実績として示さない）', () => {
  it('全拠点が推計の年度は確定年度にならず、実績は前の確定年度の値のまま', async () => {
    setScope1Kind('estimate');
    const scope1 = await card('scope1', PERIOD_IDS.fy2025);
    expect(scope1.current?.complete).toBe(false);
    expect(scope1.current?.approvedValue).toBeNull();
    expect(scope1.current?.estimateUnits.length).toBeGreaterThan(0);
    expect(scope1.dataState.label).not.toContain('確定');
    expect(scope1.dataState.details.join('')).toContain('当年の推計値');
    expect(scope1.dataState.details.join('')).not.toContain('前年値での補完');
    // 実績は FY2024 の確定値（0 にはならない）
    expect(scope1.confirmed?.period.code).toBe('FY2024');
    expect(scope1.actualValue).toBeCloseTo(9735.4);
    expect(scope1.actualValue).not.toBe(0);
    if (scope1.progress.status === 'ok') {
      expect(scope1.progress.rate).toBeLessThan(100);
    }
  });

  it('一部の拠点だけ推計でも、その年度を確定した実績（途中の合計）として示さない', async () => {
    setScope1Kind('estimate', ['EAST']);
    const scope1 = await card('scope1', PERIOD_IDS.fy2025);
    expect(scope1.current?.complete).toBe(false);
    expect(scope1.current?.estimateUnits).toEqual(['東日本工場']);
    expect(scope1.confirmed?.period.code).toBe('FY2024');
    expect(scope1.dataState.label).toContain('推計を含む');
  });

  it('目標値だけの年度も確定した実績にしない', async () => {
    setScope1Kind('target');
    const scope1 = await card('scope1', PERIOD_IDS.fy2025);
    expect(scope1.current?.complete).toBe(false);
    expect(scope1.current?.approvedValue).toBeNull();
    expect(scope1.current?.targetOnlyUnits.length).toBeGreaterThan(0);
    expect(scope1.confirmed?.period.code).toBe('FY2024');
    expect(scope1.dataState.details.join('')).toContain('目標値だけで実績の無い拠点');
  });
});

describe('INV-F11 目標と実績の算定方法が違えば達成率を出さない', () => {
  it('目標の前提にした算定方法と実績の算定方法が一致しなければ「比較条件の確認が必要」', async () => {
    const before = await card('scope1');
    expect(before.target?.comparable).toBe(true);
    const target = fixture.kpiTargets.find((t) => t.id === IDS.kpiTargets.scope1)!;
    target.actualMethodology = '燃料購入量からの推計（冷媒の漏えいを含む）';
    const after = await card('scope1');
    expect(after.target?.comparable).toBe(false);
    expect(after.progress).toMatchObject({ status: 'unavailable', code: 'not_comparable' });
    expect(after.target?.comparabilityReasons.join('')).toContain('算定方法');
  });

  it('目標に算定方法が登録されていなければ、同じとみなさない', async () => {
    const target = fixture.kpiTargets.find((t) => t.id === IDS.kpiTargets.scope1)!;
    target.actualMethodology = null;
    const scope1 = await card('scope1');
    expect(scope1.target?.comparable).toBe(false);
    expect(scope1.target?.comparabilityReasons.join('')).toContain('登録されていません');
  });
});

describe('INV-F4 GHG の推移は、値の無い年度を 0 として描かない', () => {
  it('ある指標だけ値の無い年度は null（未入力）', async () => {
    const base = fixture.dataPoints.find((d) => d.id === dataPointId('HQ', 'scope2', 'FY2026'))!;
    fixture.dataPoints.push({
      ...base,
      id: fid('data_point', 'test/hq/scope2_location/FY2026'),
      metricId: metricId('AOMI', 'scope2_location'),
      value: 1000,
      status: 'approved',
      valueKind: 'actual',
      availabilityStatus: 'value_present',
    });
    const periods = fixture.periods.filter((p) => p.organizationId === ORG_IDS.aomi);
    const trend = await loadConsolidatedTrend(db, manager(), periods, [
      'scope1',
      'scope2_location',
    ]);
    const series = consolidatedTrendSeries(trend, 'scope2_location');
    expect(series.map((p) => p.period.code)).toEqual(['FY2024', 'FY2025', 'FY2026']);
    expect(series.map((p) => p.value)).toEqual([null, null, 1000]);
    // 実績のある指標は値のまま
    expect(consolidatedTrendSeries(trend, 'scope1').every((p) => p.value !== null)).toBe(true);
  });
});

describe('INV-F7 標準 CSV の目標値で、同じ枠の実績を置き換えない', () => {
  const HEADER =
    'metric_code,period_start,period_end,entity_code,boundary_code,value,unit,value_kind,availability_status,absence_reason,methodology_code,breakdown_key,source_reference';

  it('既存の実績と同じ業務キーの目標値の行はエラーにし、確定の対象にしない', async () => {
    const preview = await validateQuantitativeImport(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      source: {
        kind: 'file',
        fileName: 'target.csv',
        bytes: new TextEncoder().encode(
          [HEADER, 'scope1,2026-04-01,2027-03-31,HQ,連結,900,t-CO2e,target,,,,,'].join('\r\n'),
        ),
      },
    });
    const row = preview.rows[0]!;
    expect(row.diffKind).toBe('error');
    expect(row.errors).toContain(TARGET_KIND_SWITCH_ERROR);
    // 既存の実績はそのまま
    const hq = fixture.dataPoints.find((d) => d.id === dataPointId('HQ', 'scope1', 'FY2026'))!;
    expect(hq.valueKind).toBe('actual');
  });
});
