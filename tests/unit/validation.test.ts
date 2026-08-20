import { describe, expect, it } from 'vitest';
import { summarizeValidations, validateDataPoints } from '@/lib/validation/data-point-rules';
import { createFixtureDb } from '@/lib/fixtures/store';
import { ORG_IDS, PERIOD_IDS, dataPointId } from '@/lib/fixtures/dataset';

/**
 * Data Point 検証ルール（指示書 7.1-9 / DQ-P0-001, DQ-P0-002）。
 * 異常 Fixture（指示書 18 章）を実際に検出できることを確認する。
 */

function buildInput() {
  const db = createFixtureDb();
  const metrics = db.metrics.filter((m) => m.organizationId === ORG_IDS.aomi);
  const units = db.units.filter((u) => u.organizationId === ORG_IDS.aomi);
  const dataPoints = db.dataPoints.filter((dp) => dp.reportingPeriodId === PERIOD_IDS.fy2026);
  const previous = db.dataPoints.filter((dp) => dp.reportingPeriodId === PERIOD_IDS.fy2025);

  const evidenceCountByDataPoint = new Map<string, number>();
  for (const link of db.evidenceLinks) {
    if (link.targetType !== 'data_point') continue;
    evidenceCountByDataPoint.set(
      link.targetId,
      (evidenceCountByDataPoint.get(link.targetId) ?? 0) + 1,
    );
  }

  return {
    dataPoints,
    metrics,
    units,
    periods: db.periods,
    evidenceCountByDataPoint,
    previousPeriodDataPoints: previous,
    detectedAt: '2026-08-14T00:00:00.000Z',
  };
}

const results = validateDataPoints(buildInput());

function rulesFor(dpId: string): string[] {
  return results.filter((r) => r.dataPointId === dpId).map((r) => r.ruleKey);
}

describe('異常 Fixture の検出', () => {
  it('女性役員数が役員総数を超えるケースを error として検出する', () => {
    const ratioDp = dataPointId('HQ', 'female_officer_ratio', 'FY2026');
    expect(rulesFor(ratioDp)).toContain('ratio_numerator_exceeds_denominator');
    const hit = results.find(
      (r) => r.dataPointId === ratioDp && r.ruleKey === 'ratio_numerator_exceeds_denominator',
    );
    expect(hit?.severity).toBe('error');
    expect(hit?.message).toContain('女性役員数');
  });

  it('前年比 10 倍のケースを検出する', () => {
    const waterDp = dataPointId('WEST', 'water', 'FY2026');
    expect(rulesFor(waterDp)).toContain('yoy_deviation');
    const hit = results.find((r) => r.dataPointId === waterDp && r.ruleKey === 'yoy_deviation');
    // 変化率 > 100% なので error
    expect(hit?.severity).toBe('error');
    expect(hit?.message).toContain('前年比');
  });

  it('単位が t と kg で混在しているケースを検出する', () => {
    const wasteDp = dataPointId('EAST', 'waste', 'FY2026');
    const rules = rulesFor(wasteDp);
    expect(rules).toContain('unit_mismatch');
    expect(rules).toContain('unit_inconsistent_across_units');
  });

  it('Evidence 必須の指標で Evidence がないケースを検出する', () => {
    const euScope1 = dataPointId('EU', 'scope1', 'FY2026');
    expect(rulesFor(euScope1)).toContain('missing_evidence');
  });

  it('承認後に変更されたケースを warning として検出する', () => {
    const scope2 = dataPointId('HQ', 'scope2', 'FY2026');
    expect(rulesFor(scope2)).toContain('changed_after_approval');
    const hit = results.find(
      (r) => r.dataPointId === scope2 && r.ruleKey === 'changed_after_approval',
    );
    expect(hit?.severity).toBe('warning');
  });
});

describe('正常系', () => {
  it('問題のない Data Point には検証結果が付かない', () => {
    const ok = dataPointId('HQ', 'scope1', 'FY2026');
    expect(rulesFor(ok)).toEqual([]);
  });

  it('error と warning を区別して集計できる', () => {
    const summary = summarizeValidations(results);
    expect(summary.errorCount).toBeGreaterThan(0);
    expect(summary.warningCount).toBeGreaterThan(0);
    expect(summary.errorCount + summary.warningCount).toBeLessThanOrEqual(results.length);
  });
});

describe('個別ルール', () => {
  const base = buildInput();

  it('整数型の指標に小数を入れると error', () => {
    const target = base.dataPoints.find((dp) => {
      const metric = base.metrics.find((m) => m.id === dp.metricId);
      return metric?.code === 'employees';
    });
    expect(target).toBeDefined();
    if (!target) return;

    const modified = base.dataPoints.map((dp) =>
      dp.id === target.id ? { ...dp, value: 480.5 } : dp,
    );
    const out = validateDataPoints({ ...base, dataPoints: modified });
    expect(out.filter((r) => r.dataPointId === target.id).map((r) => r.ruleKey)).toContain(
      'data_type',
    );
  });

  it('下限を下回ると error', () => {
    const target = base.dataPoints.find((dp) => {
      const metric = base.metrics.find((m) => m.id === dp.metricId);
      return metric?.code === 'scope1';
    });
    if (!target) throw new Error('fixture missing');

    const modified = base.dataPoints.map((dp) => (dp.id === target.id ? { ...dp, value: -1 } : dp));
    const out = validateDataPoints({ ...base, dataPoints: modified });
    expect(out.filter((r) => r.dataPointId === target.id).map((r) => r.ruleKey)).toContain('range');
  });

  it('提出済みなのに値が空だと required エラー', () => {
    const target = base.dataPoints.find((dp) => dp.status === 'submitted');
    if (!target) throw new Error('fixture missing');

    const modified = base.dataPoints.map((dp) =>
      dp.id === target.id ? { ...dp, value: null } : dp,
    );
    const out = validateDataPoints({ ...base, dataPoints: modified });
    expect(out.filter((r) => r.dataPointId === target.id).map((r) => r.ruleKey)).toContain(
      'required',
    );
  });
});
