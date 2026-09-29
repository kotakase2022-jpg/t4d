import { beforeEach, describe, expect, it } from 'vitest';
import { dataPointId, ORG_IDS, PERIOD_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  loadDataPointPage,
  loadEnterpriseDashboard,
  loadPeriodDataset,
  buildDataPointRows,
} from '@/lib/services/enterprise-data';
import {
  createActionPlan,
  createDataCollectionItem,
  loadSsbjRequirementViews,
} from '@/lib/services/ssbj-gap';
import { recomputePeriodValidations } from '@/lib/services/validation-store';
import { daysUntilJst } from '@/lib/format/datetime';
import type {
  AuthorizationContext,
  MetricDefinition,
  OrganizationUnit,
  ReportingPeriod,
  RoleKey,
} from '@/types/domain';

/**
 * ホームの件数・アラートの報告期間（W0 棚卸し O2・O3・O5、指示書 §2.3 / 受入 A02）。
 *
 * O2: 検証結果の表は報告期間を持たず、FY2026 のホームに FY2025 の検証エラー
 *     （労働災害度数率の証跡不足）が混ざっていた。KPI の件数とリンク先の一覧の件数も食い違っていた。
 * O3: 承認後に証跡不足が見つかった行は「承認済み・要再確認」と数える（DB の状態は変えない）。
 * O5: 期限の判定は src/lib/clock.ts の基準日（差し替え可能）で行う。
 */

let db: DemoDbClient;
let fixture: FixtureDb;
let fy2026: ReportingPeriod;
let fy2025: ReportingPeriod;
let units: OrganizationUnit[];
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

/** FY2025 の承認済みの行から証跡を外し、承認後の証跡不足（error）を作る */
async function detachFy2025Evidence(): Promise<string> {
  const target = dataPointId('HQ', 'ltifr', 'FY2025');
  fixture.evidenceLinks = fixture.evidenceLinks.filter(
    (l) => !(l.targetType === 'data_point' && l.targetId === target),
  );
  await recomputePeriodValidations(db, manager(), fy2025);
  return target;
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  fy2026 = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
  fy2025 = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2025)!;
  units = fixture.units.filter((u) => u.organizationId === ORG_IDS.aomi);
  metrics = fixture.metrics.filter((m) => m.organizationId === ORG_IDS.aomi);
});

describe('O2 / A02: ホームの検証エラーは表示中の報告期間に限る', () => {
  it('重要アラートはすべて FY2026 の Data Point で、過年度のエラーは混ざらない', async () => {
    const pastTarget = await detachFy2025Evidence();
    const data = await loadEnterpriseDashboard(db, manager(), fy2026, units, metrics);

    expect(data.topAlerts.length).toBeGreaterThan(0);
    const periodOf = new Map(fixture.dataPoints.map((dp) => [dp.id, dp.reportingPeriodId]));
    for (const alert of data.topAlerts) {
      expect(periodOf.get(alert.dataPointId)).toBe(PERIOD_IDS.fy2026);
    }
    expect(data.topAlerts.some((a) => a.dataPointId === pastTarget)).toBe(false);

    // 同じ条件で FY2025 を開けば、FY2025 のエラーとして出る
    const past = await loadEnterpriseDashboard(db, manager(), fy2025, units, metrics);
    expect(past.topAlerts.some((a) => a.dataPointId === pastTarget)).toBe(true);
  });

  it('KPI の件数は、リンク先の一覧（期間で絞り込み済み）の件数と一致する', async () => {
    await detachFy2025Evidence();
    for (const period of [fy2026, fy2025]) {
      const data = await loadEnterpriseDashboard(db, manager(), period, units, metrics);
      const errors = await loadDataPointPage(
        db,
        manager(),
        period,
        metrics,
        units,
        { flag: 'validation_error' },
        1,
        200,
      );
      const missing = await loadDataPointPage(
        db,
        manager(),
        period,
        metrics,
        units,
        { flag: 'missing_evidence' },
        1,
        200,
      );
      expect(data.validationErrorCount, period.code).toBe(errors.total);
      expect(data.missingEvidenceCount, period.code).toBe(missing.total);
    }
  });
});

describe('O3: 承認済み・要再確認（表示上の状態）', () => {
  it('Fixture の承認済みの証跡必須データには証跡がある（意図した異常を除く）', () => {
    const metricById = new Map(metrics.map((m) => [m.id, m]));
    const linked = new Set(
      fixture.evidenceLinks.filter((l) => l.targetType === 'data_point').map((l) => l.targetId),
    );
    const approvedWithout = fixture.dataPoints.filter(
      (dp) =>
        dp.organizationId === ORG_IDS.aomi &&
        dp.status === 'approved' &&
        metricById.get(dp.metricId)?.requiresEvidence &&
        !linked.has(dp.id),
    );
    // 労働災害度数率の証跡キーが無く、FY2025 の承認済み 5 件が証跡なしだった
    expect(approvedWithout.map((dp) => dp.id)).toEqual([]);
  });

  it('承認後に証跡が外れた行は、一覧で要再確認になり、DB の状態は承認済みのまま', async () => {
    const target = await detachFy2025Evidence();

    const dataset = await loadPeriodDataset(db, manager(), fy2025, metrics, units, []);
    const rows = buildDataPointRows(dataset, fy2025, manager());
    const row = rows.find((r) => r.dataPoint.id === target)!;
    expect(row.dataPoint.status).toBe('approved');
    expect(row.needsRecheck).toBe(true);
    // 証跡のある承認済みの行は要再確認にならない
    expect(rows.filter((r) => r.needsRecheck).map((r) => r.dataPoint.id)).toEqual([target]);

    const page = await loadDataPointPage(
      db,
      manager(),
      fy2025,
      metrics,
      units,
      { status: ['approved'] },
      1,
      200,
    );
    expect(page.rows.find((r) => r.dataPoint.id === target)?.needsRecheck).toBe(true);

    const data = await loadEnterpriseDashboard(db, manager(), fy2025, units, metrics);
    expect(data.approvedNeedsRecheckCount).toBe(1);
    const current = await loadEnterpriseDashboard(db, manager(), fy2026, units, metrics);
    expect(current.approvedNeedsRecheckCount).toBe(0);
  });

  it('承認後に指標を証跡必須へ変えると、証跡の無い承認済みの行が要再確認になる', async () => {
    // 取締役数（HQ・FY2026 承認済み）は証跡必須ではなく、証跡も紐付いていない
    const target = dataPointId('HQ', 'directors_count', 'FY2026');
    const metric = metrics.find((m) => m.code === 'directors_count')!;
    expect(metric.requiresEvidence).toBe(false);
    expect(fixture.dataPoints.find((dp) => dp.id === target)!.status).toBe('approved');

    const loaded = (await loadSsbjRequirementViews(db, manager(), fy2026))!;
    const plan = await createActionPlan(db, manager(), {
      assessmentId: loaded.views[0]!.assessment.id,
      gapKind: 'data',
      title: '取締役数の根拠資料を揃える（架空）',
      detail: '',
      actionType: 'data_collection',
      department: '総務部',
      assigneeUserId: null,
      dueDate: '2026-12-31',
      priority: 'medium',
    });
    await createDataCollectionItem(db, manager(), {
      planId: plan.id,
      metricCode: 'directors_count',
      metricName: metric.name,
      unit: metric.unit,
      unitId: UNIT_IDS.hq,
      ownerUserId: null,
      dueDate: '2026-11-30',
      requiresEvidence: true,
      department: '総務部',
    });

    const dataset = await loadPeriodDataset(db, manager(), fy2026, metrics, units, []);
    const row = buildDataPointRows(dataset, fy2026, manager()).find(
      (r) => r.dataPoint.id === target,
    )!;
    // 承認の記録は残したまま（DB の状態は承認済み）、表示だけ要再確認にする
    expect(row.dataPoint.status).toBe('approved');
    expect(row.needsRecheck).toBe(true);
  });
});

describe('O5: ホームの期限判定は基準日を 1 か所から受け取る', () => {
  it('既定はデモ基準日。2026-09-29 を渡すと「7 日以内」の作業は超過へ移る', async () => {
    const atFixture = await loadEnterpriseDashboard(db, manager(), fy2026, units, metrics);
    expect(atFixture.referenceDate).toBe('2026-08-14');
    expect(atFixture.todaysTasks.length).toBeGreaterThan(0);

    const later = await loadEnterpriseDashboard(db, manager(), fy2026, units, metrics, {
      referenceDate: '2026-09-29',
    });
    expect(later.referenceDate).toBe('2026-09-29');
    for (const task of later.todaysTasks) {
      const diff = daysUntilJst(task.dueDate, '2026-09-29')!;
      expect(diff).toBeGreaterThanOrEqual(0);
      expect(diff).toBeLessThanOrEqual(7);
    }
    // デモ基準日で「あと数日」だった作業は、2026-09-29 では超過として数える
    const soonIds = new Set(atFixture.todaysTasks.map((t) => t.id));
    expect(later.overdueCount).toBeGreaterThan(atFixture.overdueCount);
    expect(later.todaysTasks.some((t) => soonIds.has(t.id))).toBe(false);
  });
});
