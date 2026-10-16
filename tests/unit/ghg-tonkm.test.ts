import { describe, expect, it } from 'vitest';
import {
  fuelIntensity,
  tonKm,
  transportFuelLiters,
  type TransportDefaultParams,
  type TransportFormulaParams,
} from '@/lib/domain/ghg/tonkm';
import type { TonKmPolicy } from '@/types/domain';

/**
 * 改良トンキロ法（plan §2.2 tonkm.ts・CR-06）。期待値は調査メモ（research-tonkm.md §5）の計算例。
 * 係数（A・B・S・見なし積載率の原単位表）はすべて引数で渡す（コードに固定しない。plan K5）。
 * ここで渡す値は告示の値（テストの入力）で、Fixture の係数は架空の値。
 */

const rel = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(1e-9);

/** 告示の式の係数（テストの入力。軽油 S=0.812・揮発油 S=0.927） */
const DIESEL: TransportFormulaParams = {
  S: 0.812,
  classes: {
    y2025: { A: 8.83, B: 0.623 },
    y2022: { A: 10.8, B: 0.654 },
    y2015: { A: 14.0, B: 0.658 },
    unverified: { A: 15.0, B: 0.654, lnA: 2.71 },
  },
};
const GASOLINE: TransportFormulaParams = {
  S: 0.927,
  classes: {
    y2022: { A: 6.96, B: 0.612 },
    y2015: { A: 6.23, B: 0.565 },
    unverified: { A: 14.4, B: 0.648, lnA: 2.67 },
  },
};
/** 見なし積載率の原単位表（告示 別表第3 の軽油・事業用の一部。テストの入力） */
const DIESEL_DEFAULTS: TransportDefaultParams = {
  table: [
    {
      vehicleUse: 'commercial',
      minKg: 1000,
      maxKg: 2000,
      loadPct: 25,
      values: { y2025: 0.286, y2022: 0.286, y2015: 0.351, unverified: 0.387 },
    },
    {
      vehicleUse: 'commercial',
      minKg: 2000,
      maxKg: 4000,
      loadPct: 34,
      values: { y2025: 0.145, y2015: 0.173, unverified: 0.192 },
    },
  ],
};

const POLICY: TonKmPolicy = {
  shape: 'kokuji',
  minLoadPct: 10,
  over100: 'error',
  payloadRangeKg: { min: null, max: null },
  payloadOutOfRange: 'warn',
  overseas: 'warn',
  intensityRounding: null,
};

const row = (over: Partial<Parameters<typeof fuelIntensity>[1]> = {}) => ({
  fuelEconomyClass: 'unverified' as const,
  maxPayloadKg: 4000,
  loadFactorPct: 55 as number | null,
  vehicleUse: 'commercial' as const,
  overseas: false,
  ...over,
});

describe('fuelIntensity: 告示の式 x = A ÷ (y/100)^S ÷ z^B', () => {
  it('ガイドラインの公式例（軽油・2025 年度基準・10,000kg・62%）: raw 0.041931331、3 桁 0.0419', () => {
    const raw = fuelIntensity(
      { formula: DIESEL, policy: POLICY },
      row({
        fuelEconomyClass: 'y2025',
        maxPayloadKg: 10000,
        loadFactorPct: 62,
      }),
    );
    if (!('raw' in raw)) throw new Error(raw.error);
    // 調査メモの値は小数 9 桁で示されている（有効 8 桁）。示された桁で比べる
    expect(raw.raw).toBeCloseTo(0.041931331, 9);
    expect(raw.value).toBe(raw.raw);
    expect(raw.source).toBe('formula');
    expect(raw.loadFactorSource).toBe('measured');
    const rounded = fuelIntensity(
      {
        formula: DIESEL,
        policy: { ...POLICY, intensityRounding: { significant: 3, method: 'half_up' } },
      },
      row({ fuelEconomyClass: 'y2025', maxPayloadKg: 10000, loadFactorPct: 62 }),
    );
    if (!('raw' in rounded)) throw new Error(rounded.error);
    expect(rounded.value).toBe(0.0419);
  });

  it('例1（軽油・未確認・4,000kg・55%）: raw 0.1074408711、対数式（lnA 2.71）0.1076505636', () => {
    const r = fuelIntensity({ formula: DIESEL, policy: POLICY }, row());
    if (!('raw' in r)) throw new Error(r.error);
    rel(r.raw, 0.1074408711);
    const log = fuelIntensity({ formula: DIESEL, policy: { ...POLICY, shape: 'log' } }, row());
    if (!('raw' in log)) throw new Error(log.error);
    rel(log.raw, 0.1076505636);
    expect(log.shape).toBe('log');
  });

  it('例2（揮発油・未確認・1,000kg・45%）: raw 0.3434270441、対数式（lnA 2.67）0.3443802733', () => {
    const r = fuelIntensity(
      { formula: GASOLINE, policy: POLICY },
      row({ maxPayloadKg: 1000, loadFactorPct: 45 }),
    );
    if (!('raw' in r)) throw new Error(r.error);
    rel(r.raw, 0.3434270441);
    const log = fuelIntensity(
      { formula: GASOLINE, policy: { ...POLICY, shape: 'log' } },
      row({ maxPayloadKg: 1000, loadFactorPct: 45 }),
    );
    if (!('raw' in log)) throw new Error(log.error);
    rel(log.raw, 0.3443802733);
  });

  it('積載率の下限: 5% は 10% として 0.4288881280（floored）。下限なしなら 0.7529746949', () => {
    const r = fuelIntensity({ formula: DIESEL, policy: POLICY }, row({ loadFactorPct: 5 }));
    if (!('raw' in r)) throw new Error(r.error);
    rel(r.raw, 0.428888128);
    expect(r.loadFactorUsed).toBe(10);
    expect(r.loadFactorSource).toBe('floored');
    expect(r.warnings).toContain('load_floored');
    const none = fuelIntensity(
      { formula: DIESEL, policy: { ...POLICY, minLoadPct: 0 } },
      row({ loadFactorPct: 5 }),
    );
    if (!('raw' in none)) throw new Error(none.error);
    rel(none.raw, 0.7529746949);
    expect(none.loadFactorSource).toBe('measured');
  });

  it('積載率 100% 超は方針どおり: error なら止める、cap なら 100% として警告', () => {
    expect(fuelIntensity({ formula: DIESEL, policy: POLICY }, row({ loadFactorPct: 120 }))).toEqual(
      {
        error: 'load_over_100',
      },
    );
    const capped = fuelIntensity(
      { formula: DIESEL, policy: { ...POLICY, over100: 'cap' } },
      row({ loadFactorPct: 120 }),
    );
    if (!('raw' in capped)) throw new Error(capped.error);
    expect(capped.loadFactorUsed).toBe(100);
    expect(capped.warnings).toContain('load_capped');
  });

  it('最大積載量の範囲外は方針どおり（warn は警告して算定、error は止める）', () => {
    const range = { ...POLICY, payloadRangeKg: { min: 350, max: 20500 } };
    const warned = fuelIntensity({ formula: DIESEL, policy: range }, row({ maxPayloadKg: 25000 }));
    if (!('raw' in warned)) throw new Error(warned.error);
    expect(warned.warnings).toContain('payload_out_of_range');
    expect(
      fuelIntensity(
        { formula: DIESEL, policy: { ...range, payloadOutOfRange: 'error' } },
        row({ maxPayloadKg: 25000 }),
      ),
    ).toEqual({ error: 'payload_out_of_range' });
  });

  it('海外拠点の輸送は方針どおり（warn は警告、block は止める）', () => {
    const warned = fuelIntensity({ formula: DIESEL, policy: POLICY }, row({ overseas: true }));
    if (!('raw' in warned)) throw new Error(warned.error);
    expect(warned.warnings).toContain('overseas_transport');
    expect(
      fuelIntensity(
        { formula: DIESEL, policy: { ...POLICY, overseas: 'block' } },
        row({ overseas: true }),
      ),
    ).toEqual({ error: 'overseas_blocked' });
  });

  it('係数の無い燃費区分・対数式の係数が無いときはエラー（代わりを使わない）', () => {
    expect(
      fuelIntensity({ formula: GASOLINE, policy: POLICY }, row({ fuelEconomyClass: 'y2025' })),
    ).toEqual({ error: 'no_formula_for_class' });
    expect(
      fuelIntensity(
        { formula: DIESEL, policy: { ...POLICY, shape: 'log' } },
        row({ fuelEconomyClass: 'y2015' }),
      ),
    ).toEqual({ error: 'no_log_coefficient' });
    expect(fuelIntensity({ policy: POLICY }, row())).toEqual({ error: 'no_formula' });
  });
});

describe('fuelIntensity: 積載率が不明なら見なし積載率の原単位表', () => {
  it('軽油・事業用・2,000〜4,000kg・未確認 → 0.192（default）', () => {
    const r = fuelIntensity(
      { defaults: DIESEL_DEFAULTS, policy: POLICY },
      row({ loadFactorPct: null, maxPayloadKg: 3000 }),
    );
    if (!('raw' in r)) throw new Error(r.error);
    expect(r.value).toBe(0.192);
    expect(r.source).toBe('default_table');
    expect(r.loadFactorSource).toBe('default');
    expect(r.loadFactorUsed).toBe(34);
    expect(r.warnings).toContain('default_load_factor');
  });

  it('1,000〜2,000kg の 2022 年度基準は表の 0.286（式の 0.279 ではない）', () => {
    const r = fuelIntensity(
      { defaults: DIESEL_DEFAULTS, policy: POLICY },
      row({ loadFactorPct: null, maxPayloadKg: 1500, fuelEconomyClass: 'y2022' }),
    );
    if (!('raw' in r)) throw new Error(r.error);
    expect(r.value).toBe(0.286);
  });

  it('表に区分が無い（—）・最大積載量が無い・表が無いときはエラー', () => {
    expect(
      fuelIntensity(
        { defaults: DIESEL_DEFAULTS, policy: POLICY },
        row({ loadFactorPct: null, maxPayloadKg: 3000, fuelEconomyClass: 'y2022' }),
      ),
    ).toEqual({ error: 'no_default_value' });
    expect(
      fuelIntensity(
        { defaults: DIESEL_DEFAULTS, policy: POLICY },
        row({ loadFactorPct: null, maxPayloadKg: null }),
      ),
    ).toEqual({ error: 'no_payload' });
    expect(fuelIntensity({ policy: POLICY }, row({ loadFactorPct: null }))).toEqual({
      error: 'no_default_table',
    });
  });
});

describe('tonKm・transportFuelLiters', () => {
  it('重量×距離（2.2t × 180km = 396.00000000000006 を相対誤差で比べる）か、入力の t·km', () => {
    const value = tonKm({ cargoWeightT: 2.2, distanceKm: 180, tonKm: null });
    if (typeof value !== 'number') throw new Error('t·km を計算できるはず');
    rel(value, 396);
    expect(tonKm({ cargoWeightT: null, distanceKm: null, tonKm: 1250 })).toBe(1250);
    expect(tonKm({ cargoWeightT: null, distanceKm: 100, tonKm: null })).toEqual({
      error: 'no_ton_km',
    });
  });

  it('燃料 L = t·km × 原単位', () => {
    // 調査メモの値（42.5465850 L）は小数 7 桁で示されている
    expect(transportFuelLiters(396, 0.1074408711)).toBeCloseTo(42.546585, 7);
    expect(transportFuelLiters(1250, 0.192)).toBe(240);
  });
});
