import { describe, expect, it } from 'vitest';
import { convert, parseUnit, sameUnit } from '@/lib/domain/ghg/units';

/**
 * 次元つきの単位換算（plan §2.2 units.ts・CR-03）。Nm3 と m3 は別の次元（換算は組織の方針だけ）、
 * 換算の段（内蔵か組織か）を残し、次元違いはエラー（黙って同一視しない）。
 */

describe('parseUnit', () => {
  it('表記ゆれを同じ単位に読む', () => {
    expect(parseUnit('ℓ')?.code).toBe('L');
    expect(parseUnit('KL')?.code).toBe('kL');
    expect(parseUnit('m³')?.code).toBe('m3');
    expect(parseUnit('N㎥')?.code).toBe('Nm3');
    expect(parseUnit('千Nm3')?.code).toBe('kNm3');
    expect(parseUnit('t·km')?.code).toBe('tkm');
    expect(parseUnit('トンキロ')?.code).toBe('tkm');
    expect(parseUnit('tCO2e')?.code).toBe('t-CO2e');
    expect(parseUnit('kg-CO₂')?.code).toBe('kg-CO2');
    expect(parseUnit('gal')?.code).toBe('gal');
  });

  it('Nm3 と m3 は別の次元', () => {
    expect(parseUnit('Nm3')?.dimension).toBe('std_volume');
    expect(parseUnit('m3')?.dimension).toBe('volume');
    expect(sameUnit('Nm3', 'm3')).toBe(false);
    expect(sameUnit('l', 'L')).toBe(true);
  });

  it('知らない単位は null', () => {
    expect(parseUnit('MMBtu')).toBeNull();
    expect(parseUnit('')).toBeNull();
  });
});

describe('convert', () => {
  it('同じ次元は内蔵の換算（段に builtin を残す）。gal→L は定義値 3.785411784', () => {
    const r = convert(1250, 'L', 'kL', []);
    expect(r).toEqual({
      value: 1.25,
      steps: [{ from: 'L', to: 'kL', factor: 0.001, source: 'builtin' }],
    });
    const g = convert(100, 'gal', 'L', []);
    expect('value' in g && g.value).toBeCloseTo(378.5411784, 9);
    const k = convert(2, 'MWh', 'kWh', []);
    expect('value' in k && k.value).toBe(2000);
  });

  it('同じ単位は換算しない（段なし）', () => {
    expect(convert(3, 'kWh', 'kWh', [])).toEqual({ value: 3, steps: [] });
  });

  it('次元をまたぐ換算は組織の方針だけ。無ければ dimension_mismatch（Nm3 を m3 と同一視しない）', () => {
    expect(convert(1000, 'm3', 'Nm3', [])).toEqual({ error: 'dimension_mismatch' });
    expect(convert(1, 'L', 'kg', [])).toEqual({ error: 'dimension_mismatch' });
    const policy = [{ from: 'm3', to: 'Nm3', multiplier: 0.93, source: '（架空）温度・圧力補正' }];
    const r = convert(1000, 'm3', 'Nm3', policy);
    expect(r).toEqual({
      value: 930,
      steps: [{ from: 'm3', to: 'Nm3', factor: 0.93, source: 'policy:（架空）温度・圧力補正' }],
    });
  });

  it('方針の換算の前後に内蔵の換算をつなぐ（kL→m3→Nm3→千Nm3）', () => {
    const policy = [{ from: 'm3', to: 'Nm3', multiplier: 0.93, source: '補正' }];
    const r = convert(2, 'kL', 'kNm3', policy);
    if (!('value' in r)) throw new Error('換算できるはず');
    expect(r.value).toBeCloseTo(0.00186, 12);
    expect(r.steps.map((s) => s.source)).toEqual(['builtin', 'policy:補正', 'builtin']);
  });

  it('同じ次元の組を結ぶ方針が 2 つ以上あれば ambiguous_conversion（どちらかを黙って選ばない）', () => {
    const policy = [
      { from: 'm3', to: 'Nm3', multiplier: 0.93, source: 'A' },
      { from: 'L', to: 'Nm3', multiplier: 0.00093, source: 'B' },
    ];
    expect(convert(1, 'm3', 'Nm3', policy)).toEqual({ error: 'ambiguous_conversion' });
  });

  it('知らない単位は unknown_unit', () => {
    expect(convert(1, 'MMBtu', 'GJ', [])).toEqual({ error: 'unknown_unit' });
  });
});
