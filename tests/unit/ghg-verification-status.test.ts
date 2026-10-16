import { describe, expect, it } from 'vitest';
import { monthsBetween, siteStatuses, type SiteInput } from '@/lib/domain/ghg/verification-status';
import type { ReconciliationItem } from '@/types/domain';

/**
 * 拠点ごとの検証の進み具合（plan §2.2 verification-status.ts・CR-20）。算定済みは「最新の記録が拠点を含み、
 * 入力ハッシュが現在と同じ」。入力が変われば再算定が必要。照合済みは全項目が許容差内か原因を確認済み。
 */

const MONTHS = Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}-01`);
const site = (over: Partial<SiteInput> = {}): SiteInput => ({
  unitId: 'u1',
  monthsWithActivity: MONTHS,
  monthsInPeriod: 12,
  unresolvedLines: 0,
  hasBaseline: true,
  ...over,
});

const item = (over: Partial<ReconciliationItem>): ReconciliationItem => ({
  key: 'u1|scope1|fuel:diesel|2025-01-01',
  unitId: 'u1',
  scope: 'scope1',
  activityKind: 'fuel',
  activityCode: 'diesel',
  month: '2025-01-01',
  shipmentRef: null,
  t4d: 1,
  baseline: 1,
  diff: 0,
  diffPct: 0,
  steps: [],
  single: [],
  residual: 0,
  oneSided: null,
  withinTolerance: true,
  mainCause: null,
  ...over,
});

const run = { id: 'r1', unitIds: ['u1'], inputHash: 'h1' };

describe('siteStatuses', () => {
  it('活動量が無ければ未着手、月が欠ける・係数が無ければ入力不足', () => {
    expect(siteStatuses([site({ monthsWithActivity: [] })], null, null, null, [])[0]!.overall).toBe(
      'not_started',
    );
    const partial = siteStatuses(
      [site({ monthsWithActivity: MONTHS.slice(0, 11) })],
      null,
      null,
      null,
      [],
    )[0]!;
    expect(partial.overall).toBe('input_missing');
    expect(partial.activity).toEqual({ months: 11, of: 12, state: 'partial' });
    expect(siteStatuses([site({ unresolvedLines: 2 })], null, null, null, [])[0]!.overall).toBe(
      'input_missing',
    );
  });

  it('入力が揃って算定が無ければ未着手、入力ハッシュが同じなら算定済み、違えば再算定が必要', () => {
    expect(siteStatuses([site()], null, null, null, [])[0]!.overall).toBe('not_started');
    expect(siteStatuses([site()], run, 'h1', null, [])[0]).toMatchObject({
      calculation: 'current',
      overall: 'calculated',
    });
    expect(siteStatuses([site()], run, 'h2', null, [])[0]).toMatchObject({
      calculation: 'stale',
      overall: 'recalc_needed',
    });
  });

  it('照合: 要確認の項目があれば照合（要確認）、原因を記録すれば照合済み', () => {
    const recon = {
      id: 'c1',
      runId: 'r1',
      result: {
        items: [item({ withinTolerance: false, diff: 1, mainCause: 'factor' })],
        totals: [],
      },
    };
    expect(siteStatuses([site()], run, 'h1', recon, [])[0]!.overall).toBe('reconciliation_review');
    expect(
      siteStatuses([site()], run, 'h1', recon, [
        {
          id: 'n1',
          itemKey: 'u1|scope1|fuel:diesel|2025-01-01',
          supersedesId: null,
          reconciliationId: 'c1',
        },
      ])[0]!.overall,
    ).toBe('reconciled');
  });

  it('別の記録の照合・作り直せない照合（result が null）は数えない', () => {
    const other = { id: 'c1', runId: 'r0', result: { items: [item({})], totals: [] } };
    expect(siteStatuses([site()], run, 'h1', other, [])[0]!.reconciliation).toBe('none');
    const lost = { id: 'c1', runId: 'r1', result: null };
    expect(siteStatuses([site()], run, 'h1', lost, [])[0]!.reconciliation).toBe('none');
  });
});

describe('monthsBetween', () => {
  it('暦年は 12 か月、年度（4〜3 月）も 12 か月', () => {
    expect(monthsBetween('2025-01-01', '2025-12-31')).toBe(12);
    expect(monthsBetween('2025-04-01', '2026-03-31')).toBe(12);
  });
});
