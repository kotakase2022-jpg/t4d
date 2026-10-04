import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError } from '@/lib/authorization/can';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { computeConsolidatedAggregation } from '@/lib/services/aggregation';
import { loadEsgDashboard, loadMetricYearStates, type MetricYearRow } from '@/lib/services/kpi';
import type { AuthorizationContext, RoleKey, Uuid } from '@/types/domain';
import { WriteDetectingDbClient } from '../support/write-detecting-db';

/**
 * 指標 × 年度の集計状態（loadMetricYearStates。docs/disclosure-first.md §10.2）。
 * 自社経年比較・財務影響分析の値の源で、ESG経営の KPI と同じ規則（承認済みの連結値・比率は加重平均・
 * 確定は全拠点承認済み）で読む。隣り合う年度の比較は ESG経営の前年比と同じ補助関数。読むだけ（書かない）。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  organizationId: Uuid = ORG_IDS.aomi,
  organizationType: 'enterprise' | 'assurance_firm' = 'enterprise',
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType,
      organizationName: 'テスト',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const siteUser = () => ctxFor('site-user@demo.local', ['site_contributor']);
const otherTenant = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);
const auditor = () =>
  ctxFor('assurance-manager@demo.local', ['assurance_manager'], ORG_IDS.aoba, 'assurance_firm');

const THREE_YEARS = [PERIOD_IDS.fy2024, PERIOD_IDS.fy2025, PERIOD_IDS.fy2026];

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

function rowOf(rows: MetricYearRow[], code: string): MetricYearRow {
  const row = rows.find((r) => r.metric.code === code);
  if (!row) throw new Error(`${code} の行が無い`);
  return row;
}

describe('年度の並びと指標の並び', () => {
  it('期間は startDate 昇順（渡した順に関わらない）、行は渡した指標コードの順（重複・無い指標は除く）', async () => {
    const result = await loadMetricYearStates(db, manager(), {
      metricCodes: ['female_manager_ratio', 'scope1', 'scope1', 'no_such_metric'],
      periodIds: [PERIOD_IDS.fy2026, PERIOD_IDS.fy2024, PERIOD_IDS.fy2025],
    });
    expect(result.periods.map((p) => p.id)).toEqual(THREE_YEARS);
    expect(result.rows.map((r) => r.metric.code)).toEqual(['female_manager_ratio', 'scope1']);
    for (const row of result.rows) {
      expect(row.years.map((y) => y.period.id)).toEqual(THREE_YEARS);
      expect(row.changes).toHaveLength(2);
    }
  });

  it('他組織の期間 ID を混ぜても、この組織の期間だけを使う', async () => {
    const result = await loadMetricYearStates(db, manager(), {
      metricCodes: ['scope1'],
      periodIds: [PERIOD_IDS.sotenFy2026, PERIOD_IDS.fy2025],
    });
    expect(result.periods.map((p) => p.id)).toEqual([PERIOD_IDS.fy2025]);
    expect(rowOf(result.rows, 'scope1').changes).toEqual([]);
  });
});

describe('scope1 の 3 年（合計 = 承認済みの連結値）', () => {
  it('FY2024 9,735.4・FY2025 8,931.6 は確定、FY2026 は集計中（承認済み 3/4 拠点）で値は比較に使わない', async () => {
    const { rows } = await loadMetricYearStates(db, manager(), {
      metricCodes: ['scope1'],
      periodIds: THREE_YEARS,
    });
    const scope1 = rowOf(rows, 'scope1');
    const [fy2024, fy2025, fy2026] = scope1.years;
    expect(fy2024!.state.complete).toBe(true);
    expect(fy2024!.state.approvedValue).toBeCloseTo(9735.4, 1);
    expect(fy2025!.state.complete).toBe(true);
    expect(fy2025!.state.approvedValue).toBeCloseTo(8931.6, 1);
    expect(fy2026!.state.complete).toBe(false);
    expect(fy2026!.display.label).toBe('集計中（承認済み 3/4 拠点）');

    // FY2024 → FY2025: 同条件で −8.3%
    const [first, second] = scope1.changes;
    expect(first?.status).toBe('ok');
    if (first?.status === 'ok') {
      expect(first.previousPeriod.id).toBe(PERIOD_IDS.fy2024);
      expect(first.previousValue).toBeCloseTo(9735.4, 1);
      expect(first.diff).toBeCloseTo(8931.6 - 9735.4, 1);
      expect(first.diffRate).toBeCloseTo(-8.3, 1);
    }
    // FY2025 → FY2026: FY2026 が未確定なので比べない（途中合計を前年と比べない）
    expect(second).toEqual({ status: 'unavailable', reason: 'FY2026 の確定値がありません。' });
  });

  it('値は GHG 画面の連結値（computeConsolidatedAggregation）と一致する', async () => {
    const ctx = manager();
    const { periods, rows } = await loadMetricYearStates(db, ctx, {
      metricCodes: ['scope1'],
      periodIds: THREE_YEARS,
    });
    for (const [index, period] of periods.slice(0, 2).entries()) {
      const aggregation = await computeConsolidatedAggregation(db, ctx, period, periods, [
        'scope1',
      ]);
      expect(rowOf(rows, 'scope1').years[index]!.state.approvedValue).toBe(
        aggregation.metrics[0]!.consolidated,
      );
    }
  });

  it('ESG経営の Scope1 カードと同じ前年比（同じ補助関数）', async () => {
    const dashboard = await loadEsgDashboard(db, manager(), { periodId: PERIOD_IDS.fy2026 });
    const card = dashboard.cards.find((c) => c.spec.key === 'scope1')!;
    const { rows } = await loadMetricYearStates(db, manager(), {
      metricCodes: ['scope1'],
      periodIds: THREE_YEARS,
    });
    // カードの実績は最新の確定年度（FY2025）とその前年（FY2024）の比較
    expect(card.confirmed?.period.id).toBe(PERIOD_IDS.fy2025);
    expect(rowOf(rows, 'scope1').changes[0]).toEqual(card.yoy);
  });
});

describe('比率 = 分子・分母の加重平均', () => {
  it('female_manager_ratio: FY2024 16/114・FY2025 18/120・FY2026 23/126 の加重平均で、差は % ポイント', async () => {
    const { rows } = await loadMetricYearStates(db, manager(), {
      metricCodes: ['female_manager_ratio'],
      periodIds: THREE_YEARS,
    });
    const ratio = rowOf(rows, 'female_manager_ratio');
    const [fy2024, fy2025, fy2026] = ratio.years;
    // FY2024（closed の過年度。2026-10-02 に収集 21 指標へ広げた Fixture）: 16 ÷ 114 × 100 = 14.04
    expect(fy2024!.state.complete).toBe(true);
    expect(fy2024!.state.approvedValue).toBeCloseTo(14.04, 2);
    expect(fy2024!.display.label).toBe('確定（全拠点承認済み）');
    const first = ratio.changes[0];
    expect(first?.status).toBe('ok');
    if (first?.status === 'ok') {
      expect(first.previousPeriod.id).toBe(PERIOD_IDS.fy2024);
      expect(first.diff).toBeCloseTo(15 - 14.04, 2);
    }
    expect(fy2025!.state.complete).toBe(true);
    expect(fy2025!.state.approvedValue).toBeCloseTo(15, 2);
    expect(fy2026!.state.complete).toBe(true);
    expect(fy2026!.state.approvedValue).toBeCloseTo(18.25, 2);
    const change = ratio.changes[1];
    expect(change?.status).toBe('ok');
    if (change?.status === 'ok') expect(change.diff).toBeCloseTo(3.25, 2);
  });

  it('前年が未入力なら値は null（0 にしない）で、前年比を出さない', async () => {
    // FY2024 の比率・分子・分母の行を消し、過年度に値の無い指標を作る
    const codes = new Set(['female_manager_ratio', 'female_managers', 'managers_total']);
    const removed = new Set(fixture.metrics.filter((m) => codes.has(m.code)).map((m) => m.id));
    for (let i = fixture.dataPoints.length - 1; i >= 0; i -= 1) {
      const dp = fixture.dataPoints[i]!;
      if (dp.reportingPeriodId === PERIOD_IDS.fy2024 && removed.has(dp.metricId)) {
        fixture.dataPoints.splice(i, 1);
      }
    }
    const { rows } = await loadMetricYearStates(db, manager(), {
      metricCodes: ['female_manager_ratio'],
      periodIds: THREE_YEARS,
    });
    const ratio = rowOf(rows, 'female_manager_ratio');
    const [fy2024] = ratio.years;
    expect(fy2024!.state.hasData).toBe(false);
    expect(fy2024!.state.approvedValue).toBeNull();
    expect(fy2024!.display.label).toBe('未入力');
    expect(ratio.changes[0]).toEqual({
      status: 'unavailable',
      reason: '前年（FY2024）の確定値がありません。',
    });
    expect(ratio.changes[1]?.status).toBe('ok');
  });
});

describe('権限・テナント・書込', () => {
  it('監査法人のワークスペースからは読めない', async () => {
    await expect(
      loadMetricYearStates(db, auditor(), { metricCodes: ['scope1'], periodIds: THREE_YEARS }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('拠点担当（enterprise.data.read あり）も読める', async () => {
    const { rows } = await loadMetricYearStates(db, siteUser(), {
      metricCodes: ['scope1'],
      periodIds: THREE_YEARS,
    });
    expect(rows).toHaveLength(1);
  });

  it('他テナント（蒼天）の値が混ざらない: 青海の期間 ID では行の値が全部無い', async () => {
    const { periods, rows } = await loadMetricYearStates(db, otherTenant(), {
      metricCodes: ['scope1'],
      periodIds: THREE_YEARS,
    });
    expect(periods).toEqual([]);
    for (const row of rows) {
      expect(row.metric.organizationId).toBe(ORG_IDS.soten);
      expect(row.years).toEqual([]);
    }
  });

  it('読むだけで書かない（書込検知ラッパーで例外が出ない）', async () => {
    const spy = new WriteDetectingDbClient(db);
    await loadMetricYearStates(spy, manager(), {
      metricCodes: ['scope1', 'scope2', 'scope3_cat1', 'female_manager_ratio', 'turnover_rate'],
      periodIds: THREE_YEARS,
    });
    expect(spy.writes).toEqual([]);
  });
});
