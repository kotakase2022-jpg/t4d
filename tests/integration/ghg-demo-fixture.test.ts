import { describe, expect, it } from 'vitest';
import { itemVerdict } from '@/lib/domain/ghg/attribution';
import { calculateRun, recalculate } from '@/lib/domain/ghg/calculate';
import { selectCalculationInputs } from '@/lib/domain/ghg/select-inputs';
import { UNIT_IDS } from '@/lib/fixtures/dataset';
import {
  GHG_FIXTURE_IDS,
  GHG_VERIFICATION_UNIT_IDS,
  ghgSourceRowsFromFixture,
} from '@/lib/fixtures/ghg-verification';
import { createFixtureDb } from '@/lib/fixtures/store';
import type { ReconciliationItem } from '@/types/domain';

/**
 * 算定の検証の架空の Fixture（plan §2.6・int:ghg-demo-fixture）。
 *  - 照合 R-1 の画面に 6 種の原因（係数・丸め・単位換算・対象範囲・区分・原因不明〔残差〕）が別々の項目として出る
 *  - 仕込みの無い項目（EAST の電力など）は「許容差内」
 *  - 算定の記録 R-1 は Fixture の入力から作り直すと同じ（入力ハッシュ・行）
 *  - US1 の差は仮説の再計算（係数セット 2024 年版）で閉じる
 *  - 値はすべて架空（係数のセットの出所は fixture）
 */

const db = createFixtureDb();
const recon = db.ghgReconciliations.find((r) => r.id === GHG_FIXTURE_IDS.reconciliation)!;
const items = recon.result!.items;
const U = GHG_FIXTURE_IDS.units;

const pick = (pred: (i: ReconciliationItem) => boolean) => {
  const found = items.filter(pred);
  expect(found.length).toBeGreaterThan(0);
  return found;
};

describe('架空の Fixture の形', () => {
  it('検証拠点は国内 1（東日本工場）＋海外 4（TH・VN・MX・US）。海外の拠点は Data Point を持たない', () => {
    const units = GHG_VERIFICATION_UNIT_IDS.map((id) => db.units.find((u) => u.id === id)!);
    expect(units.map((u) => u.countryCode)).toEqual(['JP', 'TH', 'VN', 'MX', 'US']);
    for (const id of Object.values(U)) {
      expect(db.dataPoints.some((dp) => dp.unitId === id)).toBe(false);
    }
  });

  it('期間 CY2025 は暦年で、既定の現在期間（collecting の FY2026）を変えない', () => {
    const cy = db.periods.find((p) => p.id === GHG_FIXTURE_IDS.period)!;
    expect(cy).toMatchObject({
      code: 'CY2025',
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      status: 'reviewing',
    });
    const sorted = db.periods
      .filter((p) => p.organizationId === cy.organizationId)
      .sort((a, b) => (a.code < b.code ? 1 : -1));
    expect(sorted.at(-1)!.code).toBe('CY2025');
    expect(sorted.find((p) => p.status === 'collecting')!.code).toBe('FY2026');
  });

  it('係数のセットはどちらも架空（origin=fixture）で有効。区分規則 LOGI-01 は承認待ち', () => {
    expect(db.emissionFactorSets.map((s) => [s.code, s.origin, s.status])).toEqual([
      ['ORG-2025', 'fixture', 'active'],
      ['ORG-2024', 'fixture', 'active'],
    ]);
    const rule = db.ghgClassificationRules[0]!;
    expect(rule).toMatchObject({
      code: 'LOGI-01',
      status: 'proposed',
      protocolScope: 'scope3_cat4',
      reportedScope: 'scope1',
    });
    expect(rule.rationale).toContain('（架空）');
  });

  it('委託物流 24 行（積載率なし 4 行・5% の行 1 行・最大積載量 25,000kg の行 1 行）', () => {
    const contracted = db.ghgActivityLines.filter((l) => l.carrierKind === 'contracted');
    expect(contracted).toHaveLength(24);
    expect(contracted.filter((l) => l.loadFactorPct === null)).toHaveLength(4);
    expect(contracted.filter((l) => l.loadFactorPct === 5)).toHaveLength(1);
    expect(contracted.filter((l) => l.maxPayloadKg === 25000)).toHaveLength(1);
    const lines = db.ghgCalculationLines.filter((l) => l.activityCode === 'contracted');
    expect(lines.filter((l) => l.warnings.includes('default_load_factor'))).toHaveLength(4);
    expect(lines.filter((l) => l.warnings.includes('load_floored'))).toHaveLength(1);
    expect(lines.filter((l) => l.warnings.includes('payload_out_of_range'))).toHaveLength(1);
    expect(
      lines.every((l) => l.protocolScope === 'scope3_cat4' && l.reportedScope === 'scope3_cat4'),
    ).toBe(true);
  });
});

describe('算定の記録 R-1', () => {
  it('Fixture の入力から作り直すと同じ（入力ハッシュ・行の数・要約）', () => {
    const run = db.ghgCalculationRuns[0]!;
    const period = db.periods.find((p) => p.id === GHG_FIXTURE_IDS.period)!;
    const inputs = selectCalculationInputs(ghgSourceRowsFromFixture(db, period), run.unitIds)!;
    const again = calculateRun(inputs, { runId: run.id, createdAt: run.createdAt });
    expect(again.inputHash).toBe(run.inputHash);
    expect(again.lines).toEqual(db.ghgCalculationLines.filter((l) => l.runId === run.id));
    expect(again.summary).toEqual(run.summary);
    expect(run.lineCount).toBe(again.lines.length);
  });
});

describe('照合 R-1: 6 種の原因が別々の項目として出る', () => {
  it('① 係数（VN1 の電力）', () => {
    for (const item of pick((i) => i.unitId === U.vn && i.activityKind === 'electricity')) {
      expect(item.mainCause).toBe('factor');
      expect(item.residual).toBe(0);
    }
  });

  it('② 丸め（TH1 は月ごとに kg で切り捨て）', () => {
    const th = pick((i) => i.unitId === U.th);
    expect(th.filter((i) => i.mainCause === 'rounding').length).toBeGreaterThan(0);
    expect(th.every((i) => i.residual === 0)).toBe(true);
  });

  it('③ 単位換算（EAST の都市ガス）', () => {
    for (const item of pick((i) => i.unitId === UNIT_IDS.east && i.activityCode === 'city_gas')) {
      expect(item.mainCause).toBe('conversion');
      expect(item.withinTolerance).toBe(false);
    }
  });

  it('④ 対象範囲・片側のみ（MX1 の 12 月の軽油）', () => {
    const [item] = pick(
      (i) => i.unitId === U.mx && i.activityCode === 'diesel' && i.month === '2025-12-01',
    );
    expect(item!.oneSided).toBe('t4d_only');
    expect(item!.mainCause).toBe('coverage');
    expect(itemVerdict(item!, [])).toBe('one_sided');
  });

  it('⑤ 区分（EAST の委託物流: 既存は Scope1、T4D は Scope3 カテゴリ4）', () => {
    const contracted = pick((i) => i.unitId === UNIT_IDS.east && i.activityCode === 'contracted');
    expect(contracted.every((i) => i.mainCause === 'classification' && i.oneSided === null)).toBe(
      true,
    );
    expect(contracted.some((i) => i.scope === 'scope1')).toBe(true);
    expect(contracted.some((i) => i.scope === 'scope3_cat4')).toBe(true);
  });

  it('⑥ 原因不明（残差）（US1 は合計だけ）', () => {
    const us = pick((i) => i.unitId === U.us);
    expect(us.every((i) => i.month === null && i.activityKind === null)).toBe(true);
    const unexplained = us.filter((i) => itemVerdict(i, []) === 'unexplained');
    expect(unexplained.length).toBeGreaterThan(0);
    expect(unexplained.every((i) => i.mainCause === null && i.residual !== 0)).toBe(true);
  });

  it('仕込みの無い項目は許容差内（EAST の電力・軽油）', () => {
    const east = pick(
      (i) =>
        i.unitId === UNIT_IDS.east &&
        (i.activityKind === 'electricity' || i.activityCode === 'diesel'),
    );
    expect(
      east.every(
        (i) => i.withinTolerance && i.diff === 0 && itemVerdict(i, []) === 'within_tolerance',
      ),
    ).toBe(true);
  });

  it('全項目で Σ寄与＋残差＝既存−T4D', () => {
    for (const item of items) {
      const sum = item.steps.reduce((a, s) => a + s.delta, 0) + item.residual;
      expect(sum, item.key).toBeCloseTo(item.diff, 9);
    }
  });

  it('US1 の差は仮説の再計算（係数セット 2024 年版）で閉じる', () => {
    const run = db.ghgCalculationRuns[0]!;
    const period = db.periods.find((p) => p.id === GHG_FIXTURE_IDS.period)!;
    const inputs = selectCalculationInputs(ghgSourceRowsFromFixture(db, period), run.unitIds)!;
    const alt = recalculate(
      inputs,
      { factorSetId: GHG_FIXTURE_IDS.sets.org2024 },
      {
        runId: `${run.id}#whatif`,
        createdAt: run.createdAt,
      },
    );
    const baseline = db.ghgBaselineResults[0]!;
    for (const row of baseline.rows.filter((r) => r.unitId === U.us)) {
      const site = alt.summary.reported.sites.find(
        (s) => s.unitId === U.us && s.scope === row.scope,
      )!;
      expect(site.rounded).toBe(row.emissions);
    }
  });
});
