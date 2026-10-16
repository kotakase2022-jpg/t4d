import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ATTRIBUTION_ORDER,
  attribute,
  attributionLinesFrom,
  itemVerdict,
} from '@/lib/domain/ghg/attribution';
import { calculateRun } from '@/lib/domain/ghg/calculate';
import { roundEmission } from '@/lib/domain/ghg/rounding';
import type { BaselineRow, GhgCalculationLine, ReconciliationItem } from '@/types/domain';
import { baseInputs, rule } from './ghg-test-builders';

/**
 * 照合と差異の原因の分解（plan §2.2 attribution.ts・CR-12）。
 *  - Σ寄与 ＋ 残差 ＝ 既存 − T4D（全項目・全ケースで）
 *  - 係数・丸め・単位換算・対象範囲・区分の差が、それぞれの原因として分かれて出る
 *  - 既存が合計だけの拠点は原因を分けられず残差（原因不明）
 *  - 判定の語に「一致」を使わない（判定は within_tolerance など）
 */

const OPTS = { runId: 'run-1', createdAt: '2026-10-16T00:00:00.000Z' };
const SHIPMENTS: Record<string, string> = { L6: 'S-001', L7: 'S-002' };
const TOLERANCE = {
  scope1: { absoluteT: 0.05, relativePct: 0.1 },
  scope2: { absoluteT: 0.05, relativePct: 0.1 },
  scope2_location: { absoluteT: 0.05, relativePct: 0.1 },
  scope3_cat4: { absoluteT: 0.05, relativePct: 0.1 },
};

function calc(withRule = false) {
  const out = calculateRun(baseInputs(withRule ? { rules: [rule()] } : {}), OPTS);
  expect(out.errors).toEqual([]);
  return out.lines;
}

/** T4D の算定行と同じ前提の既存の行（月の粒度・出荷番号つき） */
function mirror(lines: readonly GhgCalculationLine[], code: Record<string, string>): BaselineRow[] {
  return lines.map((l, i) => ({
    rowNo: i + 1,
    siteCode: code[l.unitId] ?? l.unitId,
    unitId: l.unitId,
    scope: l.reportedScope,
    activityKind: l.activityKind,
    activityCode: l.activityCode,
    month: l.month,
    shipmentRef: SHIPMENTS[l.activityLineId] ?? null,
    activityAmount: l.activityAmount,
    activityUnit: l.activityUnit,
    convertedAmount: l.convertedAmount,
    convertedUnit: l.convertedUnit,
    factorValue: Number(l.methodDetail.effectiveFactorT),
    factorUnit: `t-CO2/${l.convertedUnit}`,
    factorYear: l.factorYear,
    method: l.method,
    emissions: l.emissionsUnrounded,
    emissionsUnit: 't-CO2',
    rounding: null,
    roundingNote: '',
  }));
}

const CODES = { 'u-jp': 'JP1', 'u-th': 'TH1' };

function run(lines: GhgCalculationLine[], rows: BaselineRow[]) {
  return attribute(
    attributionLinesFrom(lines, (id) => SHIPMENTS[id] ?? null),
    rows,
    { t4dRounding: [], tolerance: TOLERANCE },
  );
}

function expectInvariant(items: readonly ReconciliationItem[]) {
  for (const item of items) {
    const sum = item.steps.reduce((a, s) => a + s.delta, 0) + item.residual;
    expect(sum, item.key).toBeCloseTo(item.diff, 9);
  }
}

const find = (items: readonly ReconciliationItem[], pred: (i: ReconciliationItem) => boolean) => {
  const found = items.filter(pred);
  expect(found.length).toBeGreaterThan(0);
  return found;
};

describe('同じ前提の既存結果', () => {
  it('全項目が許容差内で差 0、原因なし。項目は拠点×報告区分×活動×月（×出荷番号）', () => {
    const lines = calc();
    const result = run(lines, mirror(lines, CODES));
    expect(result.items).toHaveLength(10);
    expect(
      result.items.every((i) => i.diff === 0 && i.withinTolerance && i.mainCause === null),
    ).toBe(true);
    expect(result.items.every((i) => itemVerdict(i, []) === 'within_tolerance')).toBe(true);
    expectInvariant(result.items);
    expect(result.items.find((i) => i.shipmentRef === 'S-001')?.key).toBe(
      'u-jp|scope3_cat4|transport:contracted|2025-01-01|S-001',
    );
  });
});

describe('仕込んだ差が原因ごとに分かれる', () => {
  const lines = calc();
  const rows = mirror(lines, CODES);
  const factorRow = rows.find((r) => r.unitId === 'u-th' && r.scope === 'scope2_location')!;
  // ① 係数: タイの電力（ロケーション基準）を 2024 年版（0.52 kg/kWh）で
  factorRow.factorValue = 0.52;
  factorRow.factorUnit = 'kg-CO2/kWh';
  factorRow.factorYear = 2024;
  factorRow.emissions = (5000 * 0.52) / 1000;
  // ② 単位換算: 都市ガスを m3 のまま Nm3 として（換算なし）
  const gasRow = rows.find((r) => r.activityCode === 'city_gas')!;
  gasRow.convertedAmount = 1;
  gasRow.emissions = 1 * 2.1;
  // ③ 丸め: 国内の軽油を月ごとに kg で切り捨て
  const dieselRow = rows.find((r) => r.unitId === 'u-jp' && r.activityCode === 'diesel')!;
  dieselRow.rounding = { stage: 'month', unit: 'kg', digits: 0, method: 'truncate' };
  dieselRow.roundingNote = '月ごと・kg・切り捨て';
  dieselRow.emissions = roundEmission(dieselRow.emissions, {
    digits: 0,
    unit: 'kg',
    method: 'truncate',
  });
  // ④ 対象範囲: タイの軽油の行が無い
  const withoutTh = rows.filter((r) => !(r.unitId === 'u-th' && r.activityCode === 'diesel'));
  // ⑤ 区分: 委託物流を Scope1 に計上
  for (const r of withoutTh) if (r.activityCode === 'contracted') r.scope = 'scope1';
  // 既存の側にしか無い行（タイの揮発油）
  withoutTh.push({
    ...rows[0]!,
    rowNo: 99,
    siteCode: 'TH1',
    unitId: 'u-th',
    scope: 'scope1',
    activityKind: 'fuel',
    activityCode: 'gasoline',
    month: '2025-01-01',
    emissions: 0.5,
  });
  const result = run(lines, withoutTh);

  it('Σ寄与＋残差＝既存−T4D（全項目）', () => {
    expectInvariant(result.items);
  });

  it('① 係数', () => {
    const [item] = find(result.items, (i) => i.unitId === 'u-th' && i.scope === 'scope2_location');
    expect(item!.mainCause).toBe('factor');
    expect(item!.residual).toBe(0);
    expect(item!.diff).toBeCloseTo(0.1, 12);
    expect(item!.withinTolerance).toBe(false);
    expect(itemVerdict(item!, [])).toBe('needs_review');
  });

  it('② 単位換算', () => {
    const [item] = find(result.items, (i) => i.activityCode === 'city_gas');
    expect(item!.mainCause).toBe('conversion');
    expect(item!.residual).toBe(0);
    expect(item!.single.find((s) => s.cause === 'conversion')!.delta).toBeCloseTo(item!.diff, 12);
  });

  it('③ 丸め（許容差内でも原因は丸め）', () => {
    const [item] = find(result.items, (i) => i.unitId === 'u-jp' && i.activityCode === 'diesel');
    expect(item!.mainCause).toBe('rounding');
    expect(item!.residual).toBe(0);
    expect(item!.withinTolerance).toBe(true);
  });

  it('④ 対象範囲（T4D の側だけ）', () => {
    const [item] = find(result.items, (i) => i.unitId === 'u-th' && i.activityCode === 'diesel');
    expect(item!.oneSided).toBe('t4d_only');
    expect(item!.baseline).toBeNull();
    expect(item!.mainCause).toBe('coverage');
    expect(itemVerdict(item!, [])).toBe('one_sided');
  });

  it('⑤ 区分: Scope1 の項目に足され、Scope3 カテゴリ4 の項目から引かれる（片側だけではない）', () => {
    const scope1 = find(
      result.items,
      (i) => i.activityCode === 'contracted' && i.scope === 'scope1',
    );
    const scope3 = find(
      result.items,
      (i) => i.activityCode === 'contracted' && i.scope === 'scope3_cat4',
    );
    for (const item of [...scope1, ...scope3]) {
      expect(item.mainCause).toBe('classification');
      expect(item.oneSided).toBeNull();
      expect(item.residual).toBe(0);
    }
    expect(scope1.every((i) => i.t4d === 0 && i.diff > 0)).toBe(true);
    expect(scope3.every((i) => i.baseline === 0 && i.diff < 0)).toBe(true);
  });

  it('既存の側だけの行は baseline_only（原因は対象範囲）', () => {
    const [item] = find(result.items, (i) => i.activityCode === 'gasoline');
    expect(item!.oneSided).toBe('baseline_only');
    expect(item!.t4d).toBeNull();
    expect(item!.mainCause).toBe('coverage');
  });

  it('仕込みの無い項目は許容差内（国内の電力）', () => {
    const items = find(
      result.items,
      (i) => i.unitId === 'u-jp' && i.activityKind === 'electricity',
    );
    expect(items.every((i) => i.withinTolerance && i.diff === 0)).toBe(true);
  });

  it('区分ごとの合計（既存・T4D・差）', () => {
    const scope1 = result.totals.find((t) => t.scope === 'scope1')!;
    const items = result.items.filter((i) => i.scope === 'scope1');
    expect(scope1.diff).toBeCloseTo(
      items.reduce((a, i) => a + i.diff, 0),
      9,
    );
  });
});

describe('既存が拠点×区分の合計だけ', () => {
  it('原因を分けられず残差（原因不明）。判定は unexplained', () => {
    const lines = calc();
    const thLines = lines.filter((l) => l.unitId === 'u-th');
    const scope2loc = thLines.filter((l) => l.reportedScope === 'scope2_location');
    const total = scope2loc.reduce((a, l) => a + l.emissionsUnrounded, 0);
    const rows: BaselineRow[] = [
      {
        rowNo: 1,
        siteCode: 'TH1',
        unitId: 'u-th',
        scope: 'scope2_location',
        activityKind: null,
        activityCode: null,
        month: null,
        shipmentRef: null,
        activityAmount: null,
        activityUnit: null,
        convertedAmount: null,
        convertedUnit: null,
        factorValue: null,
        factorUnit: null,
        factorYear: null,
        method: null,
        emissions: total * 1.04,
        emissionsUnit: 't-CO2',
        rounding: null,
        roundingNote: '',
      },
    ];
    const result = run(thLines, rows);
    const item = result.items.find((i) => i.key === 'u-th|scope2_location|')!;
    expect(item.mainCause).toBeNull();
    expect(item.residual).toBeCloseTo(total * 0.04, 9);
    expect(item.steps.filter((s) => s.applicable).map((s) => s.cause)).toEqual(['coverage']);
    expect(itemVerdict(item, [])).toBe('unexplained');
    expectInvariant(result.items);
  });
});

describe('itemVerdict', () => {
  it('人が原因を記録した項目は cause_confirmed（差し替えられた記録は数えない）', () => {
    const item = {
      key: 'k',
      withinTolerance: false,
      oneSided: null,
      mainCause: 'factor' as const,
      residual: 0,
      diff: 1,
    };
    expect(itemVerdict(item, [{ id: 'n1', itemKey: 'k', supersedesId: null }])).toBe(
      'cause_confirmed',
    );
    expect(itemVerdict(item, [{ id: 'n1', itemKey: 'other', supersedesId: null }])).toBe(
      'needs_review',
    );
  });
});

describe('順序', () => {
  it('既定の順は 区分→対象範囲→活動量→単位換算→係数→算定方法→丸め', () => {
    expect(DEFAULT_ATTRIBUTION_ORDER).toEqual([
      'classification',
      'coverage',
      'activity',
      'conversion',
      'factor',
      'method',
      'rounding',
    ]);
  });

  it('順序を変えても Σ寄与＋残差＝総差（配分は変わりうる）', () => {
    const lines = calc();
    const rows = mirror(lines, CODES);
    const row = rows.find((r) => r.unitId === 'u-th' && r.scope === 'scope2_location')!;
    row.factorValue = 0.52;
    row.factorUnit = 'kg-CO2/kWh';
    row.activityAmount = 5100;
    row.rounding = { stage: 'month', unit: 't', digits: 1, method: 'floor' };
    row.emissions = Math.floor((5100 * 0.52) / 100) / 10;
    const reversed = attribute(
      attributionLinesFrom(lines, (id) => SHIPMENTS[id] ?? null),
      rows,
      { t4dRounding: [], tolerance: TOLERANCE, order: [...DEFAULT_ATTRIBUTION_ORDER].reverse() },
    );
    expectInvariant(reversed.items);
    const item = reversed.items.find((i) => i.unitId === 'u-th' && i.scope === 'scope2_location')!;
    expect(item.residual).toBe(0);
  });
});

describe('区分規則が承認された後の照合', () => {
  it('委託物流の区分が既存と同じになり、区分の差が消える', () => {
    const lines = calc(true);
    const rows = mirror(lines, CODES);
    const result = run(lines, rows);
    expect(
      result.items
        .filter((i) => i.activityCode === 'contracted')
        .every((i) => i.scope === 'scope1'),
    ).toBe(true);
    expect(result.items.every((i) => i.diff === 0)).toBe(true);
  });
});
