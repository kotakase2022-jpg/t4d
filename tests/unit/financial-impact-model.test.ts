import { describe, expect, it } from 'vitest';
import {
  ASSUMPTION_SPECS,
  CARBON_PRICE_START_YEAR,
  PATHWAY_IDS,
  carbonPrice,
  compareWithBau,
  defaultImpactParams,
  describeFormula,
  driverValueAt,
  emptyAssumptionValues,
  gxEtsReferenceNote,
  formatMillionYen,
  lagBandOf,
  parseImpactParams,
  presentValue,
  referenceYearOf,
  sensitivity,
  serializeImpactParams,
  simulateFinancialImpact,
  targetAlreadyAchieved,
  type AssumptionValues,
  type PathwayId,
  type PathwayResult,
  type SimulationInput,
  type SimulationResult,
} from '@/lib/domain/financial-impact';
import {
  DEMO_ASSUMPTION_DEFAULTS,
  DEMO_FINANCIAL_BASELINE,
  assumptionDefaultsFor,
} from '@/lib/financial-impact/demo-assumptions';

/**
 * 財務影響分析の試算モデル（docs/disclosure-first.md §10.3）。
 *
 * 期待値は §10.3 の表から手で計算した円（浮動小数は toBeCloseTo(x, 0)）。起点はデモの FY2025 の
 * 確定連結値（scope1 8,931.6・scope2 22,897.4 等。integration で loadMetricYearStates と一致を確かめる）。
 * 炭素価格 P(t) は FY2028 に 1,000 円/t、以後 +500 円/t・年（P(2030) = 2,000、P(2033) = 3,500）。
 */

const BASE_YEAR = 2025;

/** デモの FY2025 の確定連結値（起点） */
const DEMO_ORIGINS = {
  scope1: 8931.6,
  scope2: 22897.4,
  energy: 46224,
  water: 277200,
  waste: 2972.2,
  new_hires: 302,
  scope3_cat1: 48210,
} as const;

function input(overrides: Partial<SimulationInput> = {}): SimulationInput {
  return {
    baseYear: BASE_YEAR,
    origins: { ...DEMO_ORIGINS },
    // Scope1 の目標（2030 年 7,840 t。比較可）だけ。Scope2 の目標は比較不可のため渡さない
    targets: { scope1: { targetYear: 2030, targetValue: 7840 } },
    scenario: 'bau',
    assumptions: { ...DEMO_ASSUMPTION_DEFAULTS },
    growthRates: {},
    enabled: defaultImpactParams(DEMO_ASSUMPTION_DEFAULTS).enabled,
    ...overrides,
  };
}

function pathway(result: SimulationResult, id: PathwayId): PathwayResult {
  const found = result.pathways.find((p) => p.pathway.id === id);
  if (!found) throw new Error(`${id} が無い`);
  return found;
}

function valueAt(result: SimulationResult, id: PathwayId, year: number): number | null {
  const cell = pathway(result, id).years.find((y) => y.year === year);
  if (!cell) throw new Error(`${id} の ${year} が無い`);
  return cell.value;
}

function noteAt(result: SimulationResult, id: PathwayId, year: number) {
  return pathway(result, id).years.find((y) => y.year === year)?.note ?? null;
}

describe('試算期間と炭素価格', () => {
  it('試算期間は B+1〜B+10（デモ FY2026〜FY2035）', () => {
    const result = simulateFinancialImpact(input());
    expect(result.years).toEqual([2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034, 2035]);
    for (const p of result.pathways) expect(p.years.map((y) => y.year)).toEqual(result.years);
  });

  it('炭素価格は開始年（FY2028）に 1,000 円/t、以後 +500 円/t・年。開始前は 0', () => {
    const a = DEMO_ASSUMPTION_DEFAULTS;
    expect(CARBON_PRICE_START_YEAR).toBe(2028);
    expect(carbonPrice(a, 2027)).toBe(0);
    expect(carbonPrice(a, 2028)).toBe(1000);
    expect(carbonPrice(a, 2030)).toBe(2000);
    expect(carbonPrice(a, 2033)).toBe(3500);
    // 仮定が未入力なら価格は無い（0 にしない）
    expect(carbonPrice({ ...a, carbonPriceStart: null }, 2030)).toBeNull();
  });

  it('参照年は FY2030（試算期間に入るとき）', () => {
    expect(referenceYearOf(2025)).toBe(2030);
    expect(referenceYearOf(2024)).toBe(2030);
    // 2030 が期間外なら B+5
    expect(referenceYearOf(2030)).toBe(2035);
  });
});

describe('P1 Scope1 → 化石燃料賦課金の転嫁（現状維持）', () => {
  const bau = simulateFinancialImpact(input());

  it('FY2027 は制度開始前で 0（null ではない）', () => {
    expect(valueAt(bau, 'P1', 2026)).toBe(0);
    expect(valueAt(bau, 'P1', 2027)).toBe(0);
    expect(noteAt(bau, 'P1', 2027)).toBe('pre_start');
  });

  it('FY2028 = −8,931,600 円、FY2030 = −17,863,200 円（減益は負）', () => {
    expect(valueAt(bau, 'P1', 2028)).toBeCloseTo(-8_931_600, 0);
    expect(valueAt(bau, 'P1', 2030)).toBeCloseTo(-17_863_200, 0);
    expect(noteAt(bau, 'P1', 2028)).toBeNull();
  });

  it('値を埋めた式は FY2030 の値で示す', () => {
    const text = describeFormula(pathway(bau, 'P1'), input(), 2030);
    expect(text).toContain('8,931.6');
    expect(text).toContain('2,000 円/t');
    expect(text).toContain('−17,863,200 円');
  });
});

describe('目標達成シナリオ（比較可の目標だけ、基準年度の実績から目標年まで直線、以後一定）', () => {
  const target = simulateFinancialImpact(input({ scenario: 'target' }));

  it('Scope1 FY2028 = 8,276.64 t、FY2030 = 7,840 t、以後一定', () => {
    const i = input({ scenario: 'target' });
    expect(driverValueAt(i, 'scope1', 2025)).toBeCloseTo(8931.6, 6);
    expect(driverValueAt(i, 'scope1', 2028)).toBeCloseTo(8276.64, 6);
    expect(driverValueAt(i, 'scope1', 2030)).toBeCloseTo(7840, 6);
    expect(driverValueAt(i, 'scope1', 2035)).toBeCloseTo(7840, 6);
  });

  it('P1 FY2030 = −15,680,000 円', () => {
    expect(valueAt(target, 'P1', 2030)).toBeCloseTo(-15_680_000, 0);
  });

  it('目標の無い起点（比較不可の Scope2 など）は一定のまま', () => {
    const i = input({ scenario: 'target' });
    expect(driverValueAt(i, 'scope2', 2030)).toBe(22897.4);
    expect(valueAt(target, 'P2', 2034)).toBeCloseTo(-40_070_450, 0);
  });

  it('基準年度の実績が既に達成している目標（削減 9,500 t・実績 8,931.6 t）で起点を目標値へ戻さない', () => {
    const beaten = input({
      scenario: 'target',
      targets: { scope1: { targetYear: 2030, targetValue: 9500, direction: 'reduce' } },
    });
    expect(
      targetAlreadyAchieved(8931.6, { targetYear: 2030, targetValue: 9500, direction: 'reduce' }),
    ).toBe(true);
    expect(driverValueAt(beaten, 'scope1', 2030)).toBe(8931.6);
    const bau = simulateFinancialImpact(input());
    const target = simulateFinancialImpact(beaten);
    expect(valueAt(target, 'P1', 2030)).toBeCloseTo(valueAt(bau, 'P1', 2030)!, 6);
    // 回避コストは負にならない（「目標達成」で悪化させない）
    const comparison = compareWithBau(bau, target, beaten);
    expect(comparison.avoided).toBe(0);
    expect(comparison.abatement).toBe(0);

    // 未達の削減目標は従来どおり直線（向きを渡しても変わらない）
    const reduce = input({
      scenario: 'target',
      targets: { scope1: { targetYear: 2030, targetValue: 7840, direction: 'reduce' } },
    });
    expect(driverValueAt(reduce, 'scope1', 2028)).toBeCloseTo(8276.64, 6);
  });

  it('増加の目標も向きで判断する（新規採用 302 人: 目標 200 人は達成済みで一定、400 人へは直線）', () => {
    const achieved = input({
      scenario: 'target',
      targets: { new_hires: { targetYear: 2030, targetValue: 200, direction: 'increase' } },
    });
    expect(driverValueAt(achieved, 'new_hires', 2030)).toBe(302);
    const notYet = input({
      scenario: 'target',
      targets: { new_hires: { targetYear: 2030, targetValue: 400, direction: 'increase' } },
    });
    expect(driverValueAt(notYet, 'new_hires', 2030)).toBeCloseTo(400, 6);
    // 向きの無い目標は判断しない（従来どおり直線）
    expect(targetAlreadyAchieved(302, { targetYear: 2030, targetValue: 200 })).toBe(false);
  });

  it('目標年が基準年度以前の目標は使わない（一定）', () => {
    const i = input({
      scenario: 'target',
      targets: { scope1: { targetYear: 2024, targetValue: 5000 } },
    });
    expect(driverValueAt(i, 'scope1', 2030)).toBe(8931.6);
  });
});

describe('P2 Scope2 → 発電事業者の負担金の転嫁（L=1）', () => {
  const bau = simulateFinancialImpact(input());

  it('FY2033 は 0（負担金は FY2033 から、転嫁は 1 年遅れ）、FY2034 = −40,070,450 円', () => {
    // 制度が無い FY2032 までは「制度開始前」。FY2033 は制度が始まっているので「時間差」
    // （制度の表・経路の「制度の開始 FY2033」と食い違う「制度開始前」と書かない）
    expect(noteAt(bau, 'P2', 2032)).toBe('pre_start');
    expect(valueAt(bau, 'P2', 2033)).toBe(0);
    expect(noteAt(bau, 'P2', 2033)).toBe('lag');
    expect(describeFormula(pathway(bau, 'P2'), input(), 2033)).toBe(
      'FY2033 は時間差（1 年）のため未反映（0 円）',
    );
    // 22,897.4 t × P(2033) 3,500 円/t × 転嫁率 50%
    expect(valueAt(bau, 'P2', 2034)).toBeCloseTo(-40_070_450, 0);
  });

  it('時間差（L）を変えると効き始めがずれる', () => {
    const lag0 = simulateFinancialImpact(
      input({ assumptions: { ...DEMO_ASSUMPTION_DEFAULTS, lag_P2: 0 } }),
    );
    expect(valueAt(lag0, 'P2', 2032)).toBe(0);
    expect(valueAt(lag0, 'P2', 2033)).toBeCloseTo(-22897.4 * 3500 * 0.5, 0);
    expect(pathway(lag0, 'P2').firstEffectYear).toBe(2033);
    expect(pathway(bau, 'P2').firstEffectYear).toBe(2034);

    const p1Lag2 = simulateFinancialImpact(
      input({ assumptions: { ...DEMO_ASSUMPTION_DEFAULTS, lag_P1: 2 } }),
    );
    expect(valueAt(p1Lag2, 'P1', 2028)).toBe(0);
    expect(valueAt(p1Lag2, 'P1', 2029)).toBe(0);
    expect(valueAt(p1Lag2, 'P1', 2030)).toBeCloseTo(-8_931_600, 0);
    expect(pathway(p1Lag2, 'P1').firstEffectYear).toBe(2030);
    // 制度は FY2028 に始まっている。0 の理由は時間差（制度開始前ではない）
    expect(noteAt(p1Lag2, 'P1', 2027)).toBe('pre_start');
    expect(noteAt(p1Lag2, 'P1', 2028)).toBe('lag');
    expect(noteAt(p1Lag2, 'P1', 2029)).toBe('lag');
    expect(noteAt(p1Lag2, 'P1', 2030)).toBeNull();
  });

  it('P10（L=3）は炭素価格が始まる FY2028 以降の 0 を「時間差」、FY2027 までを「制度開始前」と書く', () => {
    const result = simulateFinancialImpact(
      input({
        enabled: { ...defaultImpactParams(DEMO_ASSUMPTION_DEFAULTS).enabled, P10: true },
        assumptions: { ...DEMO_ASSUMPTION_DEFAULTS, passThroughSupplier: 10 },
      }),
    );
    expect(noteAt(result, 'P10', 2027)).toBe('pre_start');
    for (const year of [2028, 2029, 2030]) {
      expect(noteAt(result, 'P10', year)).toBe('lag');
      expect(valueAt(result, 'P10', year)).toBe(0);
    }
    expect(noteAt(result, 'P10', 2031)).toBeNull();
  });
});

describe('水準の経路（P1・P2・P9・P10）は基準年度に計上済みの分を差し引く', () => {
  const productInputs = {
    productRevenue: 1_000_000_000,
    productMarginRate: 30,
    productRampYears: 1,
  } as const;

  it('P9: 販売開始が基準年度以前（FY2024）なら、基準年度の売上に含まれるため増減は 0', () => {
    const i = input({
      assumptions: { ...DEMO_ASSUMPTION_DEFAULTS, ...productInputs, productStartYear: 2024 },
    });
    const result = simulateFinancialImpact(i);
    const p9 = pathway(result, 'P9');
    expect(p9.status).toBe('quantified');
    for (const y of p9.years) {
      expect(y.value).toBe(0);
      expect(y.note).toBeNull();
    }
    expect(p9.cumulative).toBe(0);
    // 式に、差し引いた基準年度の分を書く
    expect(describeFormula(p9, i, 2030)).toBe(
      '+1,000,000,000 円 × 30% × 立上り 1 = 300,000,000 円 − 基準年度 FY2025 に計上済みの分（300,000,000 円）= 0 円',
    );
  });

  it('P9: 時間差は曲線をずらすだけで、効き始めた後の年を 0 にしない（FY2024 開始・L=2）', () => {
    const result = simulateFinancialImpact(
      input({
        assumptions: {
          ...DEMO_ASSUMPTION_DEFAULTS,
          ...productInputs,
          productStartYear: 2024,
          lag_P9: 2,
        },
      }),
    );
    const p9 = pathway(result, 'P9');
    // 基準年度 FY2025 の損益には FY2023 の水準（販売前 = 0）が入っている。FY2026 から FY2024 の売上が効く
    for (const y of p9.years) {
      expect(y.value).toBeCloseTo(300_000_000, 0);
      expect(y.note).toBeNull();
    }
    expect(p9.cumulative).toBeCloseTo(3_000_000_000, 0);
  });

  it('P9: 基準年度に立上り途中なら、基準年度の水準からの増分だけ（FY2025 開始・立上り 3 年）', () => {
    const result = simulateFinancialImpact(
      input({
        assumptions: {
          ...DEMO_ASSUMPTION_DEFAULTS,
          ...productInputs,
          productRevenue: 900_000_000,
          productStartYear: 2025,
          productRampYears: 3,
        },
      }),
    );
    // 水準: FY2025 = 270M × 1/3、FY2026 = 270M × 2/3、FY2027 以降 = 270M
    expect(valueAt(result, 'P9', 2026)).toBeCloseTo(90_000_000, 0);
    expect(valueAt(result, 'P9', 2027)).toBeCloseTo(180_000_000, 0);
    expect(valueAt(result, 'P9', 2035)).toBeCloseTo(180_000_000, 0);
  });

  it('P9: 販売開始 FY2027・L=1 は FY2026 が販売開始前、FY2027 が時間差（販売開始前と書かない）', () => {
    const result = simulateFinancialImpact(
      input({
        assumptions: {
          ...DEMO_ASSUMPTION_DEFAULTS,
          ...productInputs,
          productStartYear: 2027,
          productRampYears: 2,
          lag_P9: 1,
        },
      }),
    );
    expect(noteAt(result, 'P9', 2026)).toBe('pre_start');
    expect(noteAt(result, 'P9', 2027)).toBe('lag');
    expect(valueAt(result, 'P9', 2027)).toBe(0);
    expect(valueAt(result, 'P9', 2028)).toBeCloseTo(150_000_000, 0);
    expect(pathway(result, 'P9').firstEffectYear).toBe(2028);
  });

  it('P1: 基準年度が制度の開始後（FY2028）なら、基準年度の負担を差し引く（二重に数えない）', () => {
    const base2028 = input({ baseYear: 2028, targets: {} });
    const result = simulateFinancialImpact(base2028);
    // FY2028 の負担（8,931.6 t × 1,000 円/t）は基準年度の費用構造に入っている。増分は価格の上昇分だけ
    expect(valueAt(result, 'P1', 2029)).toBeCloseTo(-8931.6 * 500, 0);
    expect(valueAt(result, 'P1', 2030)).toBeCloseTo(-8931.6 * 1000, 0);
    expect(noteAt(result, 'P1', 2029)).toBeNull();
    expect(describeFormula(pathway(result, 'P1'), base2028, 2029)).toContain(
      '基準年度 FY2028 に計上済みの分（−8,931,600 円）= −4,465,800 円',
    );
  });

  it('P1: 基準年度 FY2028・L=2 は FY2030 に FY2028 の負担が効く（起点は D(B)。0 にしない）', () => {
    const result = simulateFinancialImpact(
      input({
        baseYear: 2028,
        targets: {},
        assumptions: { ...DEMO_ASSUMPTION_DEFAULTS, lag_P1: 2 },
      }),
    );
    // 基準年度 FY2028 の損益には FY2026 の水準（制度前 = 0）が入っている
    expect(noteAt(result, 'P1', 2029)).toBe('lag');
    expect(valueAt(result, 'P1', 2029)).toBe(0);
    expect(noteAt(result, 'P1', 2030)).toBeNull();
    expect(valueAt(result, 'P1', 2030)).toBeCloseTo(-8_931_600, 0);
    expect(valueAt(result, 'P1', 2031)).toBeCloseTo(-8931.6 * 1500, 0);
  });

  it('不変条件: 注記のある年は 0。暦の年が開始前のときだけ「開始前」。基準年度・時間差を変えても成り立つ', () => {
    const enabled = { ...defaultImpactParams(DEMO_ASSUMPTION_DEFAULTS).enabled, P10: true };
    for (const baseYear of [2025, 2028, 2033]) {
      for (const lag of [0, 1, 3]) {
        const assumptions: AssumptionValues = {
          ...DEMO_ASSUMPTION_DEFAULTS,
          passThroughSupplier: 10,
          injuryCount: 1,
          injuryCost: 1_000_000,
          ...productInputs,
          productStartYear: 2027,
        };
        for (const id of PATHWAY_IDS) assumptions[`lag_${id}`] = lag;
        const result = simulateFinancialImpact(
          input({ baseYear, targets: {}, enabled, assumptions }),
        );
        for (const p of result.pathways) {
          const start = p.pathway.id === 'P9' ? 2027 : p.pathway.startYear;
          for (const y of p.years) {
            if (p.status === 'quantified' && y.note !== null) {
              expect(y.value, `${p.pathway.id} ${y.year}`).toBe(0);
            }
            expect(y.note === 'pre_start', `${p.pathway.id} ${y.year}`).toBe(
              start !== null && y.year < start,
            );
          }
        }
      }
    }
  });
});

describe('P3〜P6', () => {
  it('P3〜P5 は現状維持で 0（基準年度の費用構造から変わらない。未定量ではない）', () => {
    const bau = simulateFinancialImpact(input());
    for (const id of ['P3', 'P4', 'P5'] as const) {
      const p = pathway(bau, id);
      expect(p.status).toBe('quantified');
      expect(p.years.every((y) => y.value === 0)).toBe(true);
      expect(p.cumulative).toBe(0);
    }
  });

  it('カスタムは起点ごとの年率の複利（エネルギー +5%/年 → FY2026 は −57,780,000 円）', () => {
    const custom = simulateFinancialImpact(
      input({ scenario: 'custom', growthRates: { energy: 5, scope1: -10 } }),
    );
    expect(valueAt(custom, 'P3', 2026)).toBeCloseTo(-(46224 * 1.05 - 46224) * 25000, 0);
    expect(valueAt(custom, 'P3', 2026)).toBeCloseTo(-57_780_000, 0);
    expect(valueAt(custom, 'P3', 2027)).toBeCloseTo(-(46224 * 1.05 ** 2 - 46224) * 25000, 0);
    // Scope1 −10%/年の複利: FY2028 は 8,931.6 × 0.9^3
    expect(valueAt(custom, 'P1', 2028)).toBeCloseTo(-8931.6 * 0.9 ** 3 * 1000, 0);
    // 年率を指定しない起点は一定
    expect(valueAt(custom, 'P5', 2030)).toBe(0);
  });

  it('P6 採用単価の上昇（L=1）: FY2026 は 0（時間差）、FY2027 = −5,436,000 円', () => {
    const bau = simulateFinancialImpact(input());
    expect(valueAt(bau, 'P6', 2026)).toBe(0);
    expect(noteAt(bau, 'P6', 2026)).toBe('lag');
    expect(valueAt(bau, 'P6', 2027)).toBeCloseTo(-302 * 0.6 * 1_000_000 * 0.03, 0);
    expect(valueAt(bau, 'P6', 2028)).toBeCloseTo(-302 * 0.6 * 1_000_000 * (1.03 ** 2 - 1), 0);
  });
});

describe('未定量・無効（0 にしない）', () => {
  it('既定では P7〜P9 は入力待ちの未定量（null）、P10 は無効。定量化は 6 / 9 経路', () => {
    const bau = simulateFinancialImpact(input());
    for (const id of ['P7', 'P8', 'P9'] as const) {
      const p = pathway(bau, id);
      expect(p.status).toBe('missing_input');
      expect(p.years.every((y) => y.value === null)).toBe(true);
      expect(p.cumulative).toBeNull();
      expect(p.evidence).toEqual(['unquantified']);
      expect(p.reason).toMatch(/^未定量（入力待ち: /);
    }
    expect(pathway(bau, 'P10').status).toBe('disabled');
    expect(pathway(bau, 'P10').evidence).toEqual(['out_of_scope']);
    expect(bau.quantifiedCount).toBe(6);
    expect(bau.enabledCount).toBe(9);
    expect(bau.pathwayCount).toBe(10);
  });

  it('仮定を消すと、その経路は合計から除かれ n が減る（合計に 0 として足さない）', () => {
    const full = simulateFinancialImpact(input());
    const noPrice = simulateFinancialImpact(
      input({ assumptions: { ...DEMO_ASSUMPTION_DEFAULTS, carbonPriceStart: null } }),
    );
    expect(pathway(noPrice, 'P1').status).toBe('missing_input');
    expect(pathway(noPrice, 'P2').status).toBe('missing_input');
    expect(valueAt(noPrice, 'P1', 2030)).toBeNull();
    expect(noPrice.quantifiedCount).toBe(4);
    // 年合計は定量化できた経路だけ（P1・P2 の分が抜ける）
    const index = full.years.indexOf(2030);
    expect(noPrice.totals[index]).toBeCloseTo(full.totals[index]! - valueAt(full, 'P1', 2030)!, 0);
  });

  it('起点（基準年度の確定値）が無い経路は「未算定（基準年度の確定値なし）」', () => {
    const result = simulateFinancialImpact(input({ origins: { ...DEMO_ORIGINS, scope1: null } }));
    const p1 = pathway(result, 'P1');
    expect(p1.status).toBe('no_origin');
    expect(p1.reason).toBe('未算定（基準年度の確定値なし）');
    expect(p1.years.every((y) => y.value === null)).toBe(true);
  });

  it('P7〜P9 は入力が揃えば定量化（P9 は増益で正、立上り係数）', () => {
    const result = simulateFinancialImpact(
      input({
        assumptions: {
          ...DEMO_ASSUMPTION_DEFAULTS,
          injuryCount: 2,
          injuryCost: 5_000_000,
          floodProbability: 1,
          floodRecoveryCost: 800_000_000,
          floodDowntimeDays: 20,
          floodDailyMargin: 15_000_000,
          productRevenue: 2_000_000_000,
          productMarginRate: 25,
          productStartYear: 2027,
          productRampYears: 3,
        },
      }),
    );
    expect(valueAt(result, 'P7', 2026)).toBeCloseTo(-10_000_000, 0);
    // 1% × (8 億円 + 20 日 × 1,500 万円)
    expect(valueAt(result, 'P8', 2026)).toBeCloseTo(-0.01 * (800_000_000 + 20 * 15_000_000), 0);
    expect(valueAt(result, 'P9', 2026)).toBe(0);
    expect(noteAt(result, 'P9', 2026)).toBe('pre_start');
    expect(valueAt(result, 'P9', 2027)).toBeCloseTo((2_000_000_000 * 0.25) / 3, 0);
    expect(valueAt(result, 'P9', 2029)).toBeCloseTo(2_000_000_000 * 0.25, 0);
    expect(valueAt(result, 'P9', 2035)).toBeCloseTo(2_000_000_000 * 0.25, 0);
    expect(valueAt(result, 'P9', 2029)!).toBeGreaterThan(0);
    expect(result.quantifiedCount).toBe(9);
    expect(pathway(result, 'P7').evidence).toEqual(['assumption']);
    expect(pathway(result, 'P1').evidence).toEqual(['data', 'assumption']);
  });

  it('P10 を有効にしても転嫁率 0% なら 0（Cat.1 のみ・既定は無効）', () => {
    const result = simulateFinancialImpact(
      input({ enabled: { ...defaultImpactParams(DEMO_ASSUMPTION_DEFAULTS).enabled, P10: true } }),
    );
    expect(pathway(result, 'P10').status).toBe('quantified');
    expect(pathway(result, 'P10').cumulative).toBe(0);
    const passed = simulateFinancialImpact(
      input({
        enabled: { ...defaultImpactParams(DEMO_ASSUMPTION_DEFAULTS).enabled, P10: true },
        assumptions: { ...DEMO_ASSUMPTION_DEFAULTS, passThroughSupplier: 10 },
      }),
    );
    // L=3: FY2031 に FY2028 の価格が効く
    expect(valueAt(passed, 'P10', 2030)).toBe(0);
    expect(valueAt(passed, 'P10', 2031)).toBeCloseTo(-48210 * 1000 * 0.1, 0);
  });
});

describe('符号・合計・累計・現在価値', () => {
  const bau = simulateFinancialImpact(input());

  it('費用の経路は負（減益）、合計は年ごとに定量化できた経路だけを足す', () => {
    for (const p of bau.pathways.filter((r) => r.status === 'quantified')) {
      for (const y of p.years) expect(y.value!).toBeLessThanOrEqual(0);
    }
    bau.years.forEach((year, index) => {
      const sum = bau.pathways
        .filter((p) => p.status === 'quantified')
        .reduce((acc, p) => acc + (p.years[index]!.value ?? 0), 0);
      expect(bau.totals[index]).toBeCloseTo(sum, 6);
      expect(year).toBe(BASE_YEAR + 1 + index);
    });
  });

  it('10 年累計は年合計の和、現在価値は (1 + 割引率)^(y − B) で割る', () => {
    const sum = bau.totals.reduce<number>((a, b) => a + (b ?? 0), 0);
    expect(bau.cumulative).toBeCloseTo(sum, 6);
    const pv = bau.totals.reduce<number>(
      (acc, value, index) => acc + (value ?? 0) / 1.05 ** (index + 1),
      0,
    );
    expect(bau.presentValue).toBeCloseTo(pv, 0);
    expect(presentValue(bau.totals, bau.years, BASE_YEAR, 5)).toBeCloseTo(pv, 0);
    expect(presentValue(bau.totals, bau.years, BASE_YEAR, null)).toBeNull();
  });

  it('P1 の 10 年累計（FY2028〜FY2035 の価格 1,000〜4,500 円/t）', () => {
    const prices = [1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500];
    const expected = -prices.reduce((acc, price) => acc + 8931.6 * price, 0);
    expect(pathway(bau, 'P1').cumulative).toBeCloseTo(expected, 0);
  });

  it('目標達成と現状維持の差（回避コスト）と、別枠の削減費用（営業利益に足さない）', () => {
    const targetInput = input({ scenario: 'target' });
    const target = simulateFinancialImpact(targetInput);
    const comparison = compareWithBau(bau, target, targetInput);
    // 回避コスト = 目標達成の累計 − 現状維持の累計（P1 の差だけ）
    expect(comparison.avoided).toBeCloseTo(23_251_080, 0);
    expect(comparison.avoided).toBeCloseTo(target.cumulative! - bau.cumulative!, 6);
    // 削減費用 = Σ max(0, S1_bau − S1_target) × 50,000 円/t（8,732.8 t）
    expect(comparison.abatement).toBeCloseTo(8732.8 * 50_000, 0);
    // 削減費用は年合計に入らない
    expect(target.cumulative).toBeCloseTo(
      target.totals.reduce<number>((a, b) => a + (b ?? 0), 0),
      6,
    );
  });
});

describe('時間帯（初めて効く年 − (B+1)）', () => {
  it('0 → 短期、1〜5 → 中期、6 以上 → 長期、無ければ null', () => {
    expect(lagBandOf(2026, 2025)).toBe('short');
    expect(lagBandOf(2027, 2025)).toBe('medium');
    expect(lagBandOf(2031, 2025)).toBe('medium');
    expect(lagBandOf(2032, 2025)).toBe('long');
    expect(lagBandOf(null, 2025)).toBeNull();
  });

  it('デモ既定: P1 は中期（FY2028）、P2 は長期（FY2034）、P3 は短期、P6 は中期', () => {
    const bau = simulateFinancialImpact(input());
    expect(pathway(bau, 'P1').band).toBe('medium');
    expect(pathway(bau, 'P2').band).toBe('long');
    expect(pathway(bau, 'P3').band).toBe('short');
    expect(pathway(bau, 'P6').band).toBe('medium');
    // 未定量でも時間帯は時間差から決まる（P7 は L=0 → 短期）
    expect(pathway(bau, 'P7').band).toBe('short');
    // P9 は開始年が未入力なので決まらない
    expect(pathway(bau, 'P9').band).toBeNull();
  });
});

describe('感度（±20%、1 つずつ）', () => {
  it('幅の大きい順に最大 8 件。影響しない仮定は省く。範囲の外へは出さない', () => {
    const result = sensitivity(input());
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.length).toBeLessThanOrEqual(8);
    for (let i = 1; i < result.rows.length; i += 1) {
      expect(result.rows[i - 1]!.width).toBeGreaterThanOrEqual(result.rows[i]!.width);
    }
    for (const row of result.rows) expect(row.width).toBeGreaterThan(0);
    // 現状維持では単価（エネルギー・水・廃棄物）は累計に効かない
    const keys = result.rows.map((r) => r.key);
    expect(keys).not.toContain('energyPrice');
    expect(keys).not.toContain('discountRate');
    // 燃料由来 100% の +20% は範囲（0〜100）で止める
    const fuel = result.rows.find((r) => r.key === 'fuelShare')!;
    expect(fuel.low).toBe(80);
    expect(fuel.high).toBe(100);
    expect(result.baseCumulative).toBeCloseTo(simulateFinancialImpact(input()).cumulative!, 6);
  });

  it('炭素価格（開始年）を ±20% 動かした累計は手計算と一致', () => {
    const result = sensitivity(input());
    const row = result.rows.find((r) => r.key === 'carbonPriceStart')!;
    expect(row.low).toBe(800);
    expect(row.high).toBe(1200);
    const low = simulateFinancialImpact(
      input({ assumptions: { ...DEMO_ASSUMPTION_DEFAULTS, carbonPriceStart: 800 } }),
    );
    expect(row.lowCumulative).toBeCloseTo(low.cumulative!, 6);
  });
});

describe('URL の仮定（parse／serialize）', () => {
  const defaults: AssumptionValues = DEMO_ASSUMPTION_DEFAULTS;

  it('何も無ければ既定（現状維持・P10 だけ無効・年率 0）', () => {
    const parsed = parseImpactParams({}, defaults);
    expect(parsed.scenario).toBe('bau');
    expect(parsed.assumptions).toEqual(defaults);
    expect(parsed.enabled.P10).toBe(false);
    expect(PATHWAY_IDS.filter((id) => parsed.enabled[id])).toHaveLength(9);
    expect(parsed.notices).toEqual([]);
    expect(parsed.customized).toBe(false);
  });

  it('範囲外・数値でない値は既定に戻して通知する', () => {
    const parsed = parseImpactParams(
      {
        sc: 'nonsense',
        a_carbonPriceStart: '999999',
        a_energyPrice: 'abc',
        r_scope1: '-50',
        p_P3: 'yes',
        a_lag_P1: '3',
      },
      defaults,
    );
    expect(parsed.scenario).toBe('bau');
    expect(parsed.assumptions.carbonPriceStart).toBe(1000);
    expect(parsed.assumptions.energyPrice).toBe(25000);
    expect(parsed.growthRates.scope1).toBe(0);
    expect(parsed.enabled.P3).toBe(true);
    expect(parsed.assumptions.lag_P1).toBe(3);
    expect(parsed.notices).toHaveLength(5);
    expect(parsed.notices.join('\n')).toContain('範囲');
    expect(parsed.notices.join('\n')).toContain('数値ではない');
    expect(parsed.customized).toBe(true);
  });

  it('受け付けなかった URL の生の値を通知に入れない（細工したリンクで任意の文を画面に出させない）', () => {
    const crafted = {
      sc: 'セッションの有効期限が切れました。https://evil.example/login で再ログインしてください',
      a_carbonPriceStart: 'サポート窓口 03-0000-0000 へ',
      r_energy: 'https://evil.example/r',
      p_P3: '至急 https://evil.example/p へ連絡',
    };
    const parsed = parseImpactParams(crafted, defaults);
    expect(parsed.notices).toHaveLength(4);
    const text = parsed.notices.join('\n');
    for (const value of Object.values(crafted)) expect(text).not.toContain(value);
    for (const fragment of ['evil.example', '03-0000-0000', '再ログイン', '至急']) {
      expect(text).not.toContain(fragment);
    }
    // 項目名と規則は書く（何を既定に戻したかは分かる）
    expect(parsed.notices).toEqual([
      'シナリオの指定が読めないため（現状維持・目標達成・カスタム のどれでもない）、現状維持で表示しています。',
      '「炭素価格（開始年 FY2028）」の値が数値ではないため、既定値（1,000 円/t）に戻しました。',
      '「エネルギー使用量の年率」の値が数値ではないため、0 %/年に戻しました。',
      '経路 P3 の有効・無効の値が読めないため（1 か 0）、既定（有効）に戻しました。',
    ]);
    // 既定に戻した値で試算する
    expect(parsed.scenario).toBe('bau');
    expect(parsed.assumptions.carbonPriceStart).toBe(1000);
    expect(parsed.growthRates.energy).toBe(0);
    expect(parsed.enabled.P3).toBe(true);
  });

  it('桁区切り・全角は数値として読み、桁は仕様の小数桁に丸める。空欄は未入力（null）', () => {
    const parsed = parseImpactParams(
      {
        a_hiringCost: '１,２００,０００',
        a_fuelShare: '87.46',
        a_injuryCount: '',
        a_waterPrice: '',
      },
      defaults,
    );
    expect(parsed.assumptions.hiringCost).toBe(1_200_000);
    expect(parsed.assumptions.fuelShare).toBe(87.5);
    expect(parsed.assumptions.injuryCount).toBeNull();
    expect(parsed.assumptions.waterPrice).toBeNull();
    expect(parsed.notices).toEqual([]);
  });

  it('配列（同じキーが 2 回）は最後の値を使う', () => {
    const parsed = parseImpactParams({ sc: ['bau', 'target'] }, defaults);
    expect(parsed.scenario).toBe('target');
  });

  it('往復一致: serialize → parse で同じ仮定に戻る（既定と同じ値は URL に書かない）', () => {
    expect(serializeImpactParams(defaultImpactParams(defaults), defaults)).toBe('');
    const params = {
      ...defaultImpactParams(defaults),
      scenario: 'custom' as const,
      assumptions: {
        ...defaults,
        carbonPriceStart: 2500,
        passThroughPower: 75.5,
        waterPrice: null,
        injuryCount: 3,
        lag_P2: 2,
      },
      growthRates: { ...defaultImpactParams(defaults).growthRates, energy: -2.5, scope1: 4 },
      enabled: { ...defaultImpactParams(defaults).enabled, P10: true, P4: false },
    };
    const query = serializeImpactParams(params, defaults);
    expect(query).toContain('sc=custom');
    expect(query).toContain('a_carbonPriceStart=2500');
    expect(query).toContain('a_waterPrice=');
    expect(query).not.toContain('a_energyPrice');
    const parsed = parseImpactParams(new URLSearchParams(query), defaults);
    expect(parsed.notices).toEqual([]);
    expect({
      scenario: parsed.scenario,
      assumptions: parsed.assumptions,
      growthRates: parsed.growthRates,
      enabled: parsed.enabled,
    }).toEqual(params);
  });

  it('Supabase 相当（既定値なし）: 単価・価格は空、時間差と経路の有効は構造の既定', () => {
    const none = assumptionDefaultsFor('none');
    expect(none).toEqual(emptyAssumptionValues());
    expect(none.carbonPriceStart).toBeNull();
    expect(none.energyPrice).toBeNull();
    expect(none.lag_P2).toBe(1);
    expect(none.lag_P10).toBe(3);
    const result = simulateFinancialImpact(input({ assumptions: none }));
    // 価格・単価が無いので、データの起点があっても定量化できる経路は無い。合計も 0 にしない
    expect(result.quantifiedCount).toBe(0);
    expect(result.totals.every((t) => t === null)).toBe(true);
    expect(result.cumulative).toBeNull();
    expect(result.presentValue).toBeNull();
  });

  it('仮定の仕様: すべてに範囲と単位があり、デモ既定は範囲の中', () => {
    for (const spec of ASSUMPTION_SPECS) {
      expect(spec.min).toBeLessThanOrEqual(spec.max);
      expect(spec.unit).not.toBe('');
      const value = DEMO_ASSUMPTION_DEFAULTS[spec.key];
      if (value !== null) {
        expect(value).toBeGreaterThanOrEqual(spec.min);
        expect(value).toBeLessThanOrEqual(spec.max);
      }
    }
    expect(assumptionDefaultsFor('demo')).toEqual(DEMO_ASSUMPTION_DEFAULTS);
    // 架空の財務ベースライン（営業利益比の参考表示だけ）
    expect(DEMO_FINANCIAL_BASELINE.revenue).toBe(60_000_000_000);
    expect(DEMO_FINANCIAL_BASELINE.operatingProfit).toBe(5_000_000_000);
  });
});

describe('制度の前提: GX-ETS の参加義務の参考表示', () => {
  const collecting = { code: 'FY2026', closed: false, statusLabel: '収集中' };
  const closed = { code: 'FY2025', closed: true, statusLabel: 'クローズ' };

  it('目安（10 万 t）を大きく下回る規模だけ「直接の義務対象外」と書く（デモ 8,931.6 t）', () => {
    expect(
      gxEtsReferenceNote({ scope1: 8931.6, basePeriodCode: 'FY2025', headerPeriod: collecting }),
    ).toBe(
      '参考: 直接の義務対象外の規模（FY2025 の Scope1 は約 0.9 万 t-CO2e。CO2e であり、FY2026 は収集中のため 3 年平均も出しません）',
    );
  });

  it('10 万 t 以上の会社に「義務対象外」と書かない', () => {
    const text = gxEtsReferenceNote({
      scope1: 250_000,
      basePeriodCode: 'FY2025',
      headerPeriod: collecting,
    });
    expect(text).not.toContain('義務対象外');
    expect(text).toContain('約 25.0 万 t-CO2e');
    expect(text).toContain('参加義務の対象になりえます');
    expect(text).toContain('直近 3 年度平均の直接 CO2');
  });

  it('目安に近い規模（5 万〜10 万 t）は判断できないと書く', () => {
    const text = gxEtsReferenceNote({
      scope1: 80_000,
      basePeriodCode: 'FY2025',
      headerPeriod: collecting,
    });
    expect(text).not.toContain('義務対象外');
    expect(text).toContain('判断できません');
  });

  it('ヘッダーの期間が締め済みなら「収集中」と書かない。確定値が無ければ参考も示さない', () => {
    const text = gxEtsReferenceNote({
      scope1: 8931.6,
      basePeriodCode: 'FY2025',
      headerPeriod: closed,
    });
    expect(text).not.toContain('収集中');
    expect(text).toContain('直接 CO2 の値ではないため、3 年平均も出しません');
    expect(
      gxEtsReferenceNote({ scope1: null, basePeriodCode: 'FY2025', headerPeriod: closed }),
    ).toBe('参考: Scope1 の確定値が無いため、義務対象かの参考も示しません');
  });
});

describe('表示（百万円・小数 1 桁、丸めは表示だけ）', () => {
  it('符号を付ける（負は −）', () => {
    expect(formatMillionYen(-17_863_200)).toBe('−17.9');
    expect(formatMillionYen(23_251_080)).toBe('+23.3');
    expect(formatMillionYen(0)).toBe('0.0');
  });
});
