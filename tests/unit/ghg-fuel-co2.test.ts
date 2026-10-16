import { describe, expect, it } from 'vitest';
import { CO2_PER_C, fuelToCo2 } from '@/lib/domain/ghg/fuel-co2';
import { roundSignificant } from '@/lib/domain/ghg/rounding';
import {
  fuelIntensity,
  transportFuelLiters,
  type TransportFormulaParams,
} from '@/lib/domain/ghg/tonkm';
import type { TonKmPolicy } from '@/types/domain';

/**
 * 燃料使用量から CO2（plan §2.2 fuel-co2.ts）。t-CO2 = kL × GJ/kL × tC/GJ × 44/12（44/12 だけがコードの定数）。
 * 期待値は research-tonkm.md §5。係数（単位発熱量・炭素排出係数）は年度付きのテストの入力として渡す
 * （算定省令の新しい値 38.0・0.0188／33.4・0.0187、旧い値 37.7・0.0187／34.6・0.0183）。
 */

const rel = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(1e-9);

const DIESEL_NEW = { calorific: 38.0, carbon: 0.0188 };
const DIESEL_OLD = { calorific: 37.7, carbon: 0.0187 };
const GASOLINE_NEW = { calorific: 33.4, carbon: 0.0187 };
const GASOLINE_OLD = { calorific: 34.6, carbon: 0.0183 };

const POLICY: TonKmPolicy = {
  shape: 'kokuji',
  minLoadPct: 10,
  over100: 'error',
  payloadRangeKg: { min: null, max: null },
  payloadOutOfRange: 'warn',
  overseas: 'warn',
  intensityRounding: null,
};
const DIESEL: TransportFormulaParams = {
  S: 0.812,
  classes: { y2025: { A: 8.83, B: 0.623 }, unverified: { A: 15.0, B: 0.654, lnA: 2.71 } },
};
const GASOLINE: TransportFormulaParams = {
  S: 0.927,
  classes: { unverified: { A: 14.4, B: 0.648, lnA: 2.67 } },
};

function intensity(
  formula: TransportFormulaParams,
  payload: number,
  load: number,
  economy: 'y2025' | 'unverified',
  policy: TonKmPolicy = POLICY,
) {
  const r = fuelIntensity(
    { formula, policy },
    {
      fuelEconomyClass: economy,
      maxPayloadKg: payload,
      loadFactorPct: load,
      vehicleUse: 'commercial',
      overseas: false,
    },
  );
  if (!('raw' in r)) throw new Error(r.error);
  return r;
}

describe('44/12 だけがコードの定数', () => {
  it('CO2_PER_C = 44/12', () => {
    expect(CO2_PER_C).toBe(44 / 12);
  });
});

describe('公式例（GL3.2 p.61。軽油・2025 年度基準・10,000kg・62%・341 t·km）', () => {
  it('原単位を 3 桁にしてから: 0.0374266778 → 3 桁 0.0374', () => {
    const x = intensity(DIESEL, 10000, 62, 'y2025', {
      ...POLICY,
      intensityRounding: { significant: 3, method: 'half_up' },
    });
    expect(x.value).toBe(0.0419);
    const r = fuelToCo2({ amountKl: transportFuelLiters(341, x.value) / 1000, ...DIESEL_NEW });
    rel(r.tco2, 0.0374266778);
    expect(roundSignificant(r.tco2, 3, 'half_up')).toBe(0.0374);
  });

  it('原単位を丸めないと 0.0374546641 → 3 桁 0.0375（丸める位置で 3 桁目が変わる）', () => {
    const x = intensity(DIESEL, 10000, 62, 'y2025');
    const r = fuelToCo2({ amountKl: transportFuelLiters(341, x.raw) / 1000, ...DIESEL_NEW });
    rel(r.tco2, 0.0374546641);
    expect(roundSignificant(r.tco2, 3, 'half_up')).toBe(0.0375);
  });
});

describe('例1（軽油・未確認・4,000kg・55%・396 t·km）', () => {
  const tkm = 2.2 * 180;

  it('raw 0.1114493611 t（燃料 42.5465850 L・熱量 1.61677023 GJ・炭素 0.0303952803 tC）', () => {
    const x = intensity(DIESEL, 4000, 55, 'unverified');
    const liters = transportFuelLiters(tkm, x.raw);
    rel(liters, 42.546585);
    const r = fuelToCo2({ amountKl: liters / 1000, ...DIESEL_NEW });
    rel(r.gj!, 1.61677023);
    rel(r.tc!, 0.0303952803);
    rel(r.tco2, 0.1114493611);
  });

  it('旧係数（37.7・0.0187）なら 0.1099813621、x を 3 桁にしてから 0.1109920416', () => {
    const x = intensity(DIESEL, 4000, 55, 'unverified');
    rel(
      fuelToCo2({ amountKl: transportFuelLiters(tkm, x.raw) / 1000, ...DIESEL_OLD }).tco2,
      0.1099813621,
    );
    const x3 = roundSignificant(x.raw, 3, 'half_up');
    rel(
      fuelToCo2({ amountKl: transportFuelLiters(tkm, x3) / 1000, ...DIESEL_NEW }).tco2,
      0.1109920416,
    );
  });

  it('対数式 raw 0.1116668769、3 桁 × 参考値 2.62 tCO2/kL なら 0.11101464（1 段係数）', () => {
    const log = intensity(DIESEL, 4000, 55, 'unverified', { ...POLICY, shape: 'log' });
    rel(
      fuelToCo2({ amountKl: transportFuelLiters(tkm, log.raw) / 1000, ...DIESEL_NEW }).tco2,
      0.1116668769,
    );
    const x3 = roundSignificant(intensity(DIESEL, 4000, 55, 'unverified').raw, 3, 'half_up');
    rel(
      fuelToCo2({ amount: transportFuelLiters(tkm, x3) / 1000, directFactor: 2.62 }).tco2,
      0.11101464,
    );
  });
});

describe('例2（揮発油・未確認・1,000kg・45%・54 t·km）', () => {
  it('raw 0.0424705373 t、旧係数（34.6・0.0183）なら 0.0430553249', () => {
    const x = intensity(GASOLINE, 1000, 45, 'unverified');
    const kl = transportFuelLiters(0.45 * 120, x.raw) / 1000;
    rel(fuelToCo2({ amountKl: kl, ...GASOLINE_NEW }).tco2, 0.0424705373);
    rel(fuelToCo2({ amountKl: kl, ...GASOLINE_OLD }).tco2, 0.0430553249);
  });
});

describe('見なし積載率の原単位表', () => {
  it('0.192 × 1,250 t·km = 240 L → 0.628672 t（12 桁で比べる）', () => {
    const r = fuelToCo2({ amountKl: transportFuelLiters(1250, 0.192) / 1000, ...DIESEL_NEW });
    expect(r.tco2).toBeCloseTo(0.628672, 12);
  });
});

describe('入力の検査', () => {
  it('数でない値は例外（黙って 0 にしない）', () => {
    expect(() => fuelToCo2({ amountKl: Number.NaN, ...DIESEL_NEW })).toThrow();
    expect(() => fuelToCo2({ amount: 1, directFactor: Number.NaN })).toThrow();
  });
});
