import { describe, expect, it } from 'vitest';
import {
  ENTITY_SCHEME_URIS,
  contextIdOf,
  entityFor,
  nextDay,
  oimPeriod,
  periodRelation,
  shiftYears,
} from '@/lib/xbrl/context';
import { SAMPLE_ENTITY_SCHEME_URI } from '@/lib/xbrl/sample-taxonomy';
import {
  decimalString,
  groupedDecimal,
  leadingNumber,
  mapUnit,
  measureClass,
  normalizeUnit,
  representableAt,
  scaleValue,
  shiftDecimal,
  unitIdOf,
} from '@/lib/xbrl/unit-map';

/**
 * 単位の換算（10 の累乗だけ。文字列で桁を動かす）と、OIM の期間・コンテキストの ID・提出者（plan §3.6 unit）
 */

describe('単位の換算', () => {
  it('GHG は utr:tCO2e に正規化する（千 t・kg は桁を換算）', () => {
    expect(mapUnit('t-CO2e')).toEqual({ measure: 'utr:tCO2e', exponent: 0 });
    expect(mapUnit('tCO2e')).toEqual({ measure: 'utr:tCO2e', exponent: 0 });
    // 全角・下付きの 2 も同じ単位として読む
    expect(mapUnit('ｔ－ＣＯ₂ｅ')).toEqual({ measure: 'utr:tCO2e', exponent: 0 });
    expect(mapUnit('千t-CO2e')).toEqual({ measure: 'utr:tCO2e', exponent: 3 });
    expect(mapUnit('kg-CO2e')).toEqual({ measure: 'utr:tCO2e', exponent: -3 });
    expect(normalizeUnit(' 千 t-CO2e ')).toBe('千t-co2e');
  });

  it('金額は iso4217:JPY、% は pure（×10^-2）、人・件は pure', () => {
    expect(mapUnit('百万円')).toEqual({ measure: 'iso4217:JPY', exponent: 6 });
    expect(mapUnit('千円')).toEqual({ measure: 'iso4217:JPY', exponent: 3 });
    expect(mapUnit('%')).toEqual({ measure: 'xbrli:pure', exponent: -2 });
    expect(mapUnit('人')).toEqual({ measure: 'xbrli:pure', exponent: 0 });
    expect(measureClass('iso4217:JPY')).toBe('currency');
    expect(measureClass('xbrli:pure')).toBe('pure');
    expect(measureClass('utr:tCO2e')).toBe('ghg');
    expect(measureClass('utr:MWh')).toBe('other');
    expect(unitIdOf('utr:tCO2e')).toBe('u-tCO2e');
  });

  it('表に無い単位は換算しない（推測しない）', () => {
    expect(mapUnit('t-CO2e/百万円')).toBeNull();
    expect(mapUnit('GJ')).toBeNull();
    expect(mapUnit('')).toBeNull();
    expect(mapUnit(null)).toBeNull();
  });

  it('桁の移動は文字列で行い、2 進の誤差を出さない', () => {
    expect(12.3 * 0.01).not.toBe(0.123);
    expect(scaleValue(12.3, -2)).toBe('0.123');
    expect(scaleValue(1234, 6)).toBe('1234000000');
    expect(scaleValue(1.5, 3)).toBe('1500');
    expect(scaleValue(-0.5, -2)).toBe('-0.005');
    expect(scaleValue(0, 6)).toBe('0');
    expect(decimalString(1e-7)).toBe('0.0000001');
    expect(decimalString(1.5e21)).toBe('1500000000000000000000');
    expect(shiftDecimal('1240.50', 0)).toBe('1240.5');
  });

  it('精度（decimals）で値を失わずに表せるか', () => {
    expect(representableAt('1240.5', 0)).toBe(false);
    expect(representableAt('1240.5', 1)).toBe(true);
    expect(representableAt('1234000000', -6)).toBe(true);
    expect(representableAt('1234500000', -6)).toBe(false);
    expect(representableAt('0', -3)).toBe(true);
  });

  it('表示の数（3 桁区切り・丸めない）と、表示の文字列の先頭の数', () => {
    expect(groupedDecimal('1240.5')).toBe('1,240.5');
    expect(groupedDecimal('-1234567.125')).toBe('-1,234,567.125');
    expect(leadingNumber('1,240.5 t-CO2e')).toBe('1240.5');
    expect(leadingNumber('1,240.50 t-CO2e（推計）')).toBe('1240.5');
    expect(leadingNumber('（未入力）')).toBeNull();
  });
});

describe('OIM の期間とコンテキスト', () => {
  const report = { start: '2025-04-01', end: '2026-03-31' };

  it('期間は終了日の翌日 0 時（2026-03-31 終了 → 2026-04-01T00:00:00）', () => {
    expect(oimPeriod({ type: 'duration', start: '2025-04-01', end: '2026-03-31' })).toBe(
      '2025-04-01T00:00:00/2026-04-01T00:00:00',
    );
    expect(oimPeriod({ type: 'instant', instant: '2026-03-31' })).toBe('2026-04-01T00:00:00');
    expect(nextDay('2024-02-28')).toBe('2024-02-29');
    expect(nextDay('2025-12-31')).toBe('2026-01-01');
    expect(shiftYears('2024-02-29', -1)).toBe('2023-02-28');
  });

  it('当年・前年・それ以外の関係と、決定的なコンテキストの ID', () => {
    expect(periodRelation(report, report)).toBe('current');
    expect(periodRelation({ start: '2024-04-01', end: '2025-03-31' }, report)).toBe('prior1');
    expect(periodRelation({ start: '2019-04-01', end: '2020-03-31' }, report)).toBe('earlier');
    expect(contextIdOf({ type: 'duration', ...report }, report, {})).toBe('CurrentYearDuration');
    expect(
      contextIdOf({ type: 'instant', instant: '2025-03-31' }, report, {
        SampleConsolidationAxis: 'SampleConsolidatedMember',
      }),
    ).toBe('Prior1YearInstant_SampleConsolidatedMember');
    expect(
      contextIdOf({ type: 'duration', start: '2019-04-01', end: '2020-03-31' }, report, {
        B: 'SecondMember',
        A: 'FirstMember',
      }),
    ).toBe('Period20190401to20200331Duration_FirstMember_SecondMember');
  });
});

describe('提出者の識別子', () => {
  const ids = [
    { scheme: 'sample' as const, value: 'SAMPLE-X-1' },
    { scheme: 'edinet_code' as const, value: 'E99999' },
  ];

  it('SAMPLE の出力には架空の識別子だけを使う（実在の識別子を混ぜない）', () => {
    const entity = entityFor('sample', ids)!;
    expect(entity).toMatchObject({ scheme: 'sample', value: 'SAMPLE-X-1', isSample: true });
    expect(entity.schemeUri).toBe(SAMPLE_ENTITY_SCHEME_URI);
    expect(entityFor('sample', [{ scheme: 'edinet_code', value: 'E99999' }])).toBeNull();
  });

  it('EDINET のプロファイルは EDINET コード（scheme は EDINET の URI）', () => {
    const entity = entityFor('edinet_ssbj', ids)!;
    expect(entity.schemeUri).toBe(ENTITY_SCHEME_URIS.edinet_code);
    expect(entity.isSample).toBe(false);
    expect(entityFor('esrs', ids)).toBeNull();
  });
});
