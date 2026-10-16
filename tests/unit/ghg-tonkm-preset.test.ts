import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fuelToCo2 } from '@/lib/domain/ghg/fuel-co2';
import { fuelIntensity, type IntensityRow } from '@/lib/domain/ghg/tonkm';
import {
  GUIDELINE_MIN_LOAD_PCT,
  PRESET_FUEL_CO2,
  PRESET_TABLE_EXCEPTIONS,
  TONKM_PRESET_CONFIRMED_ON,
  TONKM_PRESET_FUELS,
  TONKM_PRESET_SOURCES,
  payloadRangeLabel,
  presetDefaultParams,
  presetFormulaParams,
  verifyPresetDefaultTable,
} from '@/lib/domain/ghg/tonkm-preset';
import { GHG_FIXED_NOTICES } from '@/components/shared/ghg-notices';
import { createFixtureDb } from '@/lib/fixtures/store';
import type { TonKmPolicy } from '@/types/domain';

/**
 * 改良トンキロ法の公的参照プリセット（plan CR-19・unit:ghg-tonkm-preset）。
 *  - 告示 別表第3 の全セルを、区分の中央値・見なし積載率を告示式に入れて検算する。一致しないのは
 *    出典の注記どおりの 2 セル（軽油 1,000〜2,000kg の 2022年度基準）だけ
 *  - 告示の 7 式・対数式・算定省令の値で、調査メモ（research-tonkm.md §5）の計算例を再現する
 *  - 既定では適用しない（算定・Fixture・サービスがこのモジュールを読まない）
 */

const POLICY: TonKmPolicy = {
  shape: 'kokuji',
  minLoadPct: GUIDELINE_MIN_LOAD_PCT,
  over100: 'error',
  payloadRangeKg: { min: null, max: null },
  payloadOutOfRange: 'warn',
  overseas: 'warn',
  intensityRounding: null,
};

const row = (over: Partial<IntensityRow>): IntensityRow => ({
  fuelEconomyClass: 'unverified',
  maxPayloadKg: 4000,
  loadFactorPct: 55,
  vehicleUse: 'commercial',
  overseas: false,
  ...over,
});

function intensity(
  fuel: 'diesel' | 'gasoline',
  r: IntensityRow,
  policy: TonKmPolicy = POLICY,
): number {
  const result = fuelIntensity(
    r.loadFactorPct === null
      ? { defaults: presetDefaultParams(fuel), policy }
      : { formula: presetFormulaParams(fuel), policy },
    r,
  );
  if ('error' in result) throw new Error(result.error);
  return result.raw;
}

const relClose = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected) / expected).toBeLessThan(1e-9);

describe('別表第3 の検算', () => {
  const checks = verifyPresetDefaultTable();

  it('全セル（揮発油 18・軽油 56）を式で検算する', () => {
    expect(checks).toHaveLength(74);
    expect(checks.filter((c) => c.fuel === 'gasoline')).toHaveLength(18);
    expect(checks.filter((c) => c.fuel === 'diesel')).toHaveLength(56);
  });

  it('一致しないのは注記どおりの 2 セルだけ（表の値を使う）', () => {
    const mismatches = checks.filter((c) => !c.matches);
    expect(mismatches).toEqual([
      expect.objectContaining({
        fuel: 'diesel',
        vehicleUse: 'commercial',
        minKg: 1000,
        maxKg: 2000,
        economyClass: 'y2022',
        table: 0.286,
        formula: 0.279,
        knownException: true,
      }),
      expect.objectContaining({
        fuel: 'diesel',
        vehicleUse: 'private',
        minKg: 1000,
        maxKg: 2000,
        economyClass: 'y2022',
        table: 0.602,
        formula: 0.586,
        knownException: true,
      }),
    ]);
    expect(checks.filter((c) => c.knownException)).toHaveLength(PRESET_TABLE_EXCEPTIONS.length);
  });

  it('表に区分が無い燃費区分（「—」）は値を持たない', () => {
    const gasoline = TONKM_PRESET_FUELS.gasoline.defaults;
    expect(gasoline.every((r) => r.values.y2025 === undefined)).toBe(true);
    const diesel = TONKM_PRESET_FUELS.diesel.defaults;
    // 2022年度基準は 2,000kg 未満だけ、2025年度基準は 1,000kg 以上だけ（共同ガイドライン 表 II-21）
    for (const r of diesel) {
      expect(r.values.y2022 !== undefined, `${r.vehicleUse} ${r.minKg}`).toBe(
        r.maxKg !== null && r.maxKg <= 2000,
      );
      expect(r.values.y2025 !== undefined, `${r.vehicleUse} ${r.minKg}`).toBe(
        r.minKg !== null && r.minKg >= 1000,
      );
    }
  });
});

describe('告示の 7 式と対数式', () => {
  it('揮発油 3 式・軽油 4 式。S は揮発油 0.927・軽油 0.812', () => {
    const gasoline = TONKM_PRESET_FUELS.gasoline;
    const diesel = TONKM_PRESET_FUELS.diesel;
    expect(gasoline.S).toBe(0.927);
    expect(diesel.S).toBe(0.812);
    expect(gasoline.formulas.map((f) => [f.item, f.economyClass, f.A, f.B])).toEqual([
      ['①', 'y2022', 6.96, 0.612],
      ['②', 'y2015', 6.23, 0.565],
      ['③', 'unverified', 14.4, 0.648],
    ]);
    expect(diesel.formulas.map((f) => [f.item, f.economyClass, f.A, f.B])).toEqual([
      ['④', 'y2025', 8.83, 0.623],
      ['⑤', 'y2022', 10.8, 0.654],
      ['⑥', 'y2015', 14.0, 0.658],
      ['⑦', 'unverified', 15.0, 0.654],
    ]);
    // 対数式は燃費基準未確認の式と同じ B（定数だけが違う: e^2.71 = 15.029…、e^2.67 = 14.440…）
    expect(diesel.log).toEqual({ lnA: 2.71, B: 0.654 });
    expect(gasoline.log).toEqual({ lnA: 2.67, B: 0.648 });
  });

  it('公式の計算例（軽油・2025年度基準・10,000kg・62%）の原単位 raw 0.041931331', () => {
    // 出典の値は小数 9 桁までなので、その桁で比べる
    expect(
      intensity(
        'diesel',
        row({ fuelEconomyClass: 'y2025', maxPayloadKg: 10000, loadFactorPct: 62 }),
      ),
    ).toBeCloseTo(0.041931331, 9);
  });

  it('例1（軽油・未確認・4,000kg・55%）は告示式 0.1074408711、対数式 0.1076505636', () => {
    relClose(intensity('diesel', row({})), 0.1074408711);
    relClose(intensity('diesel', row({}), { ...POLICY, shape: 'log' }), 0.1076505636);
  });

  it('例2（揮発油・未確認・1,000kg・45%）は告示式 0.3434270441、対数式 0.3443802733', () => {
    const r = row({ maxPayloadKg: 1000, loadFactorPct: 45 });
    relClose(intensity('gasoline', r), 0.3434270441);
    relClose(intensity('gasoline', r, { ...POLICY, shape: 'log' }), 0.3443802733);
  });

  it('積載率 5% はガイドラインの下限 10% で算定する（0.4288881280。下限なしなら 0.7529746949）', () => {
    relClose(intensity('diesel', row({ loadFactorPct: 5 })), 0.428888128);
    relClose(
      intensity('diesel', row({ loadFactorPct: 5 }), { ...POLICY, minLoadPct: 0 }),
      0.7529746949,
    );
  });

  it('2022年度基準の式は 2,000kg 以上では範囲外（区分が無い）として印を付ける', () => {
    const result = fuelIntensity(
      { formula: presetFormulaParams('diesel'), policy: POLICY },
      row({ fuelEconomyClass: 'y2022', maxPayloadKg: 3000 }),
    );
    expect('error' in result ? result.error : result.warnings).toEqual(['payload_out_of_range']);
    const blocked = fuelIntensity(
      { formula: presetFormulaParams('diesel'), policy: { ...POLICY, payloadOutOfRange: 'error' } },
      row({ fuelEconomyClass: 'y2022', maxPayloadKg: 3000 }),
    );
    expect(blocked).toEqual({ error: 'payload_out_of_range' });
  });
});

describe('見なし積載率の原単位表（積載率が無い行）', () => {
  it('軽油・事業用・2,000〜4,000kg・未確認は表の 0.192（見なし積載率 34%）', () => {
    const result = fuelIntensity(
      { defaults: presetDefaultParams('diesel'), policy: POLICY },
      row({ maxPayloadKg: 3000, loadFactorPct: null }),
    );
    if ('error' in result) throw new Error(result.error);
    expect(result).toMatchObject({
      raw: 0.192,
      source: 'default_table',
      loadFactorUsed: 34,
      loadFactorSource: 'default',
    });
  });

  it('軽油 1,000〜2,000kg の 2022年度基準は表の 0.286（式の 0.279 ではない）', () => {
    expect(
      intensity(
        'diesel',
        row({ fuelEconomyClass: 'y2022', maxPayloadKg: 1500, loadFactorPct: null }),
      ),
    ).toBe(0.286);
    expect(
      intensity(
        'diesel',
        row({
          fuelEconomyClass: 'y2022',
          maxPayloadKg: 1500,
          loadFactorPct: null,
          vehicleUse: 'private',
        }),
      ),
    ).toBe(0.602);
  });

  it('自家用は見なし積載率が違う（軽油 2,000〜4,000kg は事業用 34%・自家用 23%）', () => {
    const table = presetDefaultParams('diesel').table;
    const pick = (use: 'commercial' | 'private') =>
      table.find((r) => r.vehicleUse === use && r.minKg === 2000)!.loadPct;
    expect([pick('commercial'), pick('private')]).toEqual([34, 23]);
  });
});

describe('算定省令の値（燃料 → CO2）', () => {
  const co2 = (fuel: 'diesel' | 'gasoline', applies: string) =>
    PRESET_FUEL_CO2.find((v) => v.fuel === fuel && v.applies === applies)!;

  it('令和5年度実績以降は 軽油 38.0・0.0188、揮発油 33.4・0.0187', () => {
    expect(co2('diesel', '令和5年度実績以降')).toMatchObject({ calorific: 38.0, carbon: 0.0188 });
    expect(co2('gasoline', '令和5年度実績以降')).toMatchObject({ calorific: 33.4, carbon: 0.0187 });
  });

  it('例1 の CO2 は 0.1114493611 t（旧係数 37.7・0.0187 なら 0.1099813621 t）', () => {
    const liters = 2.2 * 180 * intensity('diesel', row({}));
    const now = co2('diesel', '令和5年度実績以降');
    const old = co2('diesel', '平成21年度実績〜令和4年度実績');
    relClose(
      fuelToCo2({ amountKl: liters / 1000, calorific: now.calorific, carbon: now.carbon }).tco2,
      0.1114493611,
    );
    relClose(
      fuelToCo2({ amountKl: liters / 1000, calorific: old.calorific, carbon: old.carbon }).tco2,
      0.1099813621,
    );
  });

  it('例2 の CO2 は 0.0424705373 t（旧係数 34.6・0.0183 なら 0.0430553249 t）', () => {
    const liters =
      0.45 * 120 * intensity('gasoline', row({ maxPayloadKg: 1000, loadFactorPct: 45 }));
    const now = co2('gasoline', '令和5年度実績以降');
    const old = co2('gasoline', '平成21年度実績〜令和4年度実績');
    relClose(
      fuelToCo2({ amountKl: liters / 1000, calorific: now.calorific, carbon: now.carbon }).tco2,
      0.0424705373,
    );
    relClose(
      fuelToCo2({ amountKl: liters / 1000, calorific: old.calorific, carbon: old.carbon }).tco2,
      0.0430553249,
    );
  });
});

describe('出典と既定の扱い', () => {
  it('確認日は固定文 N10 と同じ。出典は告示・ガイドライン・算定省令の一覧（URL 付き）', () => {
    expect(GHG_FIXED_NOTICES.N10).toContain(TONKM_PRESET_CONFIRMED_ON);
    for (const source of Object.values(TONKM_PRESET_SOURCES)) {
      expect(source.label).not.toBe('');
      expect(source.url).toMatch(/^https:\/\//);
    }
    expect(TONKM_PRESET_SOURCES.kokuji.edition).toContain('令和4年');
  });

  it('既定では適用しない: 算定・サービス・Fixture・Demo の持ち回しはこのモジュールを読まない', () => {
    const roots = [
      'src/lib/domain',
      'src/lib/services',
      'src/lib/fixtures',
      'src/lib/repositories',
    ];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (
          /\.tsx?$/.test(name) &&
          !path.replace(/\\/g, '/').endsWith('ghg/tonkm-preset.ts')
        ) {
          if (readFileSync(path, 'utf8').includes('tonkm-preset')) offenders.push(path);
        }
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });

  it('デモの係数セットは架空の値（告示の値をそのまま使っていない）', () => {
    const db = createFixtureDb();
    const formulas = db.emissionFactors.filter((f) => f.activityKind === 'transport_formula');
    expect(formulas.length).toBeGreaterThan(0);
    const presetA = new Set(TONKM_PRESET_FUELS.diesel.formulas.map((f) => f.A));
    for (const factor of formulas) {
      const classes = (factor.params as { classes?: Record<string, { A: number }> }).classes ?? {};
      for (const c of Object.values(classes)) expect(presetA.has(c.A)).toBe(false);
    }
  });

  it('最大積載量の区分の語', () => {
    expect(payloadRangeLabel(2000, 4000)).toBe('2,000kg 以上 4,000kg 未満');
    expect(payloadRangeLabel(null, 500)).toBe('500kg 未満');
    expect(payloadRangeLabel(17000, null)).toBe('17,000kg 以上');
    expect(payloadRangeLabel(null, null)).toBe('すべて');
  });
});
