import { describe, expect, it } from 'vitest';
import {
  applyRoundingStages,
  cleanFloat,
  roundDecimal,
  roundEmission,
  roundSignificant,
} from '@/lib/domain/ghg/rounding';
import type { RoundingRule } from '@/types/domain';

/**
 * 10 進の丸め（plan §2.2 rounding.ts・CR-04）。2 進小数の誤差で .x5 が下がらないこと、5 方式の違い、
 * 有効数字の丸め、段の丸め後の値を次の段で足すこと。
 */

describe('roundDecimal（10 進で丸める）', () => {
  it('2 進誤差のある値も 10 進の表記どおりに四捨五入する（2.675→2.68・1.005→1.01）', () => {
    expect(roundDecimal(2.675, 2, 'half_up')).toBe(2.68);
    expect(roundDecimal(1.005, 2, 'half_up')).toBe(1.01);
    // Math.round では 1.00 になる例（比較のため）
    expect(Math.round(1.005 * 100) / 100).toBe(1);
  });

  it('half_up は 0 から遠い側、half_even は偶数側', () => {
    expect(roundDecimal(-2.5, 0, 'half_up')).toBe(-3);
    expect(roundDecimal(2.5, 0, 'half_up')).toBe(3);
    expect(roundDecimal(0.125, 2, 'half_even')).toBe(0.12);
    expect(roundDecimal(0.135, 2, 'half_even')).toBe(0.14);
    expect(roundDecimal(2.5, 0, 'half_even')).toBe(2);
    expect(roundDecimal(-2.5, 0, 'half_even')).toBe(-2);
  });

  it('floor と truncate は負数で異なる。ceil は大きい側', () => {
    expect(roundDecimal(-2.51, 1, 'floor')).toBe(-2.6);
    expect(roundDecimal(-2.51, 1, 'truncate')).toBe(-2.5);
    expect(roundDecimal(2.51, 1, 'floor')).toBe(2.5);
    expect(roundDecimal(2.51, 1, 'truncate')).toBe(2.5);
    expect(roundDecimal(2.51, 1, 'ceil')).toBe(2.6);
    expect(roundDecimal(-2.59, 1, 'ceil')).toBe(-2.5);
  });

  it('桁より細かい端数が無ければそのまま。指数表記・負の桁も扱う', () => {
    expect(roundDecimal(1.25, 3, 'half_up')).toBe(1.25);
    expect(roundDecimal(1e-7, 6, 'half_up')).toBe(0);
    expect(roundDecimal(5e-7, 6, 'half_up')).toBe(0.000001);
    expect(roundDecimal(1234.5, -2, 'half_up')).toBe(1200);
    expect(roundDecimal(1250, -2, 'half_even')).toBe(1200);
    expect(roundDecimal(0, 2, 'half_up')).toBe(0);
  });

  it('数でない値は丸めない（例外）', () => {
    expect(() => roundDecimal(Number.NaN, 2, 'half_up')).toThrow();
    expect(() => roundDecimal(Number.POSITIVE_INFINITY, 2, 'half_up')).toThrow();
  });
});

describe('roundSignificant（有効数字）', () => {
  it('原単位を有効 3 桁に丸める（research §5 の値）', () => {
    expect(roundSignificant(0.1074408711, 3, 'half_up')).toBe(0.107);
    expect(roundSignificant(0.041931331, 3, 'half_up')).toBe(0.0419);
    expect(roundSignificant(0.1076505636, 3, 'half_up')).toBe(0.108);
    expect(roundSignificant(0.1916430517, 3, 'half_up')).toBe(0.192);
  });

  it('繰り上がりで桁が変わっても有効桁を保つ・大きな値・負の値', () => {
    expect(roundSignificant(0.09996, 3, 'half_up')).toBe(0.1);
    expect(roundSignificant(123456, 3, 'half_up')).toBe(123000);
    expect(roundSignificant(-0.0374546641, 3, 'half_up')).toBe(-0.0375);
    expect(roundSignificant(0, 3, 'half_up')).toBe(0);
  });
});

describe('roundEmission（kg・t の単位）', () => {
  it('kg の整数は t の小数 3 桁と同じ（掛け算の誤差を作らない）', () => {
    expect(roundEmission(1.2345, { digits: 0, unit: 'kg', method: 'half_up' })).toBe(1.235);
    expect(roundEmission(1.2345, { digits: 0, unit: 'kg', method: 'truncate' })).toBe(1.234);
    expect(roundEmission(1.25, { digits: 1, unit: 't', method: 'half_even' })).toBe(1.2);
  });
});

describe('cleanFloat', () => {
  it('足し算の 2 進誤差を 15 桁で落とす（丸めの前に使う）', () => {
    expect(cleanFloat(0.1 + 0.2)).toBe(0.3);
    expect(cleanFloat(1.0049999999999999)).toBe(1.005);
  });
});

describe('applyRoundingStages（段の丸め後の値を次の段で足す）', () => {
  const items = [
    {
      unitId: 'u1',
      month: '2025-01-01',
      activityKind: 'fuel' as const,
      scope: 'scope1' as const,
      value: 0.1234,
    },
    {
      unitId: 'u1',
      month: '2025-01-01',
      activityKind: 'fuel' as const,
      scope: 'scope1' as const,
      value: 0.1234,
    },
    {
      unitId: 'u1',
      month: '2025-02-01',
      activityKind: 'fuel' as const,
      scope: 'scope1' as const,
      value: 0.0004,
    },
    {
      unitId: 'u1',
      month: '2025-01-01',
      activityKind: 'electricity' as const,
      scope: 'scope2' as const,
      value: 1.05,
    },
    {
      unitId: 'u2',
      month: '2025-01-01',
      activityKind: 'fuel' as const,
      scope: 'scope1' as const,
      value: 2,
    },
  ];

  it('規則が無ければ未丸めの合計のまま', () => {
    const result = applyRoundingStages(items, []);
    expect(result.siteScopes.find((s) => s.unitId === 'u1' && s.scope === 'scope1')).toMatchObject({
      unrounded: 0.2472,
      rounded: 0.2472,
    });
    expect(result.totals.find((t) => t.scope === 'scope1')).toMatchObject({ rounded: 2.2472 });
  });

  it('月の段で kg 切り捨て → 拠点の段は丸めた月の和（0.246 + 0）', () => {
    const rules: RoundingRule[] = [{ stage: 'month', digits: 0, unit: 'kg', method: 'truncate' }];
    const result = applyRoundingStages(items, rules);
    const site = result.siteScopes.find((s) => s.unitId === 'u1' && s.scope === 'scope1');
    expect(site?.unrounded).toBe(0.2472);
    expect(site?.rounded).toBe(0.246);
    const months = result.months.filter((m) => m.unitId === 'u1' && m.scope === 'scope1');
    expect(months.map((m) => m.rounded)).toEqual([0.246, 0]);
  });

  it('拠点×区分の段の丸めは合計の段に引き継がれる。区分（scope1・scope2）は足さない', () => {
    const rules: RoundingRule[] = [
      { stage: 'site_activity', digits: 3, unit: 't', method: 'half_up' },
      { stage: 'site_scope', digits: 1, unit: 't', method: 'half_up' },
    ];
    const result = applyRoundingStages(items, rules);
    expect(result.siteScopes.map((s) => [s.unitId, s.scope, s.rounded])).toEqual([
      ['u1', 'scope1', 0.2],
      ['u1', 'scope2', 1.1],
      ['u2', 'scope1', 2],
    ]);
    expect(result.totals).toEqual([
      { scope: 'scope1', unrounded: 2.2472, rounded: 2.2 },
      { scope: 'scope2', unrounded: 1.05, rounded: 1.1 },
    ]);
  });

  it('行の段の丸めは行ごとに付く', () => {
    const rules: RoundingRule[] = [{ stage: 'line', digits: 2, unit: 't', method: 'half_up' }];
    const result = applyRoundingStages(items, rules);
    expect(result.lines.map((l) => l.rounded)).toEqual([0.12, 0.12, 0, 1.05, 2]);
    expect(result.siteScopes[0]?.rounded).toBe(0.24);
  });
});
