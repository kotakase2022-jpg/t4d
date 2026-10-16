import { describe, expect, it } from 'vitest';
import { extractActivityRows } from '@/lib/domain/ghg/activity-parse';
import { extractBaselineRows, granularityOf } from '@/lib/domain/ghg/baseline-parse';
import { parseActivity, parseMonth, parseRoundingNote, parseScope } from '@/lib/domain/ghg/labels';
import { parseNumberWithSeparator, unreadableNumberMessage } from '@/lib/domain/ghg/number-format';

/**
 * 既存の算定結果・活動量の表から行を取り出す（plan §2.2 baseline-parse.ts・activity-parse.ts）。
 * 読めない値は推測で埋めずにエラー。粒度は列の有無から。丸めの記述は構造化し、読めなければ不明（null）。
 */

function table(headers: string[], rows: string[][]) {
  return {
    headers,
    rows: rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']))),
    rowNumbers: rows.map((_, i) => i + 2),
  };
}

describe('語の読み取り', () => {
  it('区分・活動・月', () => {
    expect(parseScope('Scope1')).toBe('scope1');
    expect(parseScope('スコープ2（ロケーション基準）')).toBe('scope2_location');
    expect(parseScope('Scope2（マーケット基準）')).toBe('scope2');
    expect(parseScope('Scope3 カテゴリ4')).toBe('scope3_cat4');
    expect(parseScope('不明')).toBeNull();
    expect(parseActivity('軽油')).toEqual({ kind: 'fuel', code: 'diesel' });
    expect(parseActivity('都市ガス')).toEqual({ kind: 'gas', code: 'city_gas' });
    expect(parseActivity('委託物流')).toEqual({ kind: 'transport', code: 'contracted' });
    expect(parseActivity('fuel:kerosene')).toEqual({ kind: 'fuel', code: 'kerosene' });
    expect(parseActivity('謎の燃料')).toBeNull();
    expect(parseMonth('2025/03')).toBe('2025-03-01');
    expect(parseMonth('2025年12月')).toBe('2025-12-01');
    expect(parseMonth('2025-13')).toBeNull();
  });

  it('丸めの記述（段・単位・方式。どれかが読めなければ不明）', () => {
    expect(parseRoundingNote('月ごと・kg・切り捨て')).toEqual({
      stage: 'month',
      unit: 'kg',
      digits: 0,
      method: 'truncate',
    });
    expect(parseRoundingNote('行ごと・t・小数3桁・四捨五入')).toEqual({
      stage: 'line',
      unit: 't',
      digits: 3,
      method: 'half_up',
    });
    expect(parseRoundingNote('適宜')).toBeNull();
    expect(parseRoundingNote('')).toBeNull();
  });
});

describe('extractBaselineRows', () => {
  const headers = ['拠点', '区分', '活動', '月', '活動量', '単位', '排出量', '単位(排出)', '丸め'];
  const mapping = {
    siteCode: '拠点',
    scope: '区分',
    activity: '活動',
    month: '月',
    activityAmount: '活動量',
    activityUnit: '単位',
    emissions: '排出量',
    emissionsUnit: '単位(排出)',
    rounding: '丸め',
  };

  it('行の粒度で読み、拠点は利用者の対応付けだけで決める（未対応の拠点コードを返す）', () => {
    const result = extractBaselineRows(
      table(headers, [
        [
          'TH1',
          'Scope1',
          '軽油',
          '2025-01',
          '1,200',
          'L',
          '3,210',
          'kg-CO2',
          '月ごと・kg・切り捨て',
        ],
        ['XX9', 'Scope2（ロケーション基準）', '電力', '2025-01', '5000', 'kWh', '2.5', 't-CO2', ''],
      ]),
      mapping,
      { TH1: 'u-th' },
    );
    expect(result.errors).toEqual([]);
    expect(result.granularity).toBe('line');
    expect(result.unmappedSiteCodes).toEqual(['XX9']);
    expect(result.rows[0]).toMatchObject({
      rowNo: 2,
      unitId: 'u-th',
      scope: 'scope1',
      activityKind: 'fuel',
      activityCode: 'diesel',
      month: '2025-01-01',
      activityAmount: 1200,
      emissions: 3210,
      emissionsUnit: 'kg-CO2',
      rounding: { stage: 'month', unit: 'kg', digits: 0, method: 'truncate' },
    });
    expect(result.rows[1]!.unitId).toBeNull();
    expect(result.rows[1]!.rounding).toBeNull();
  });

  it('読めない値は行番号付きのエラー（0 にしない）。必須の列が無ければ全体のエラー', () => {
    const result = extractBaselineRows(
      table(headers, [['TH1', 'Scope9', '軽油', '2025-01', 'たくさん', 'L', '', 't-CO2', '']]),
      mapping,
      { TH1: 'u-th' },
    );
    expect(result.rows).toEqual([]);
    expect(result.errors[0]!.rowNo).toBe(2);
    expect(result.errors[0]!.message).toContain('区分「Scope9」を読めません');
    expect(result.errors[0]!.message).toContain('排出量「」を数として読めません');
    expect(result.errors[0]!.message).toContain('活動量「たくさん」を数として読めません');
    const missing = extractBaselineRows(table(['拠点'], [['TH1']]), mapping, {});
    expect(missing.errors[0]!.message).toBe('列「区分」が見つかりません。');
  });

  it('粒度: 合計だけ → site_scope、活動まで → site_activity', () => {
    const scopeOnly = extractBaselineRows(
      table(['拠点', '区分', '排出量'], [['US1', 'Scope1', '120.5']]),
      { siteCode: '拠点', scope: '区分', emissions: '排出量' },
      { US1: 'u-us' },
      { defaultEmissionsUnit: 't-CO2e' },
    );
    expect(scopeOnly.granularity).toBe('site_scope');
    expect(scopeOnly.rows[0]!.emissionsUnit).toBe('t-CO2e');
    expect(
      granularityOf([{ ...scopeOnly.rows[0]!, activityKind: 'fuel', activityCode: 'diesel' }]),
    ).toBe('site_activity');
  });
});

describe('extractBaselineRows: 排出量の単位は推測しない（自己監査 F5）', () => {
  const headers = ['拠点', '区分', '排出量', '単位(排出)'];
  const mapping = {
    siteCode: '拠点',
    scope: '区分',
    emissions: '排出量',
    emissionsUnit: '単位(排出)',
    decimalSeparator: 'dot' as const,
  };

  it('単位の列を選んだら、空の欄は行のエラー（既定の単位・t-CO2e で埋めない）', () => {
    const result = extractBaselineRows(
      table(headers, [
        ['TH1', 'Scope1', '1520', 'kg-CO2e'],
        ['TH1', 'Scope2', '1520', ''],
      ]),
      mapping,
      { TH1: 'u-th' },
      // 列を選んだときに画面が送らない既定の単位を渡しても、空の欄には使わない
      { defaultEmissionsUnit: 't-CO2e' },
    );
    expect(result.rows.map((r) => [r.scope, r.emissions, r.emissionsUnit])).toEqual([
      ['scope1', 1520, 'kg-CO2e'],
    ]);
    expect(result.errors).toEqual([
      { rowNo: 3, message: '排出量の単位が空です（推測しません。単位を入れてください）' },
    ]);
  });

  it('単位の列も、ファイル全体の単位も無ければエラー（t-CO2e と見なさない）', () => {
    const result = extractBaselineRows(
      table(['拠点', '区分', '排出量'], [['TH1', 'Scope1', '1520']]),
      { siteCode: '拠点', scope: '区分', emissions: '排出量', decimalSeparator: 'dot' },
      { TH1: 'u-th' },
    );
    expect(result.rows).toEqual([]);
    expect(result.errors[0]!.message).toContain('排出量の単位がありません');
  });
});

describe('extractActivityRows', () => {
  it('エネルギー: 月・活動・量・単位が必須。読めない単位はエラー', () => {
    const result = extractActivityRows(
      table(
        ['月', '活動', '量', '単位'],
        [
          ['2025-01', '電力', '42,000', 'kWh'],
          ['2025-02', '軽油', '120', 'ドラム缶'],
        ],
      ),
      'energy',
      { month: '月', activity: '活動', amount: '量', unit: '単位' },
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      month: '2025-01-01',
      activityKind: 'electricity',
      activityCode: 'grid',
      amount: 42000,
      unit: 'kWh',
    });
    expect(result.errors).toEqual([{ rowNo: 3, message: '単位を読めません' }]);
  });

  it('輸送: 重量×距離か t·km が必須。最大積載量 ≤ 30・積載率 ≤ 1 は単位の警告', () => {
    const headers = [
      '月',
      '担い手',
      '燃料',
      '重量',
      '距離',
      't·km',
      '最大積載量',
      '積載率',
      '燃費区分',
      '出荷番号',
    ];
    const mapping = {
      month: '月',
      carrierKind: '担い手',
      fuel: '燃料',
      cargoWeightT: '重量',
      distanceKm: '距離',
      tonKm: 't·km',
      maxPayloadKg: '最大積載量',
      loadFactorPct: '積載率',
      fuelEconomyClass: '燃費区分',
      shipmentRef: '出荷番号',
    };
    const result = extractActivityRows(
      table(headers, [
        ['2025-01', '委託', '軽油', '2.2', '180', '', '4000', '55', '未確認', 'S-001'],
        ['2025-01', '委託', '軽油', '', '', '', '4', '0.55', '未確認', 'S-002'],
        ['2025-01', '委託', '軽油', '', '', '1250', '25', '0.5', '2025年度基準', 'S-003'],
      ]),
      'transport',
      mapping,
    );
    expect(result.rows.map((r) => r.shipmentRef)).toEqual(['S-001', 'S-003']);
    expect(result.rows[0]).toMatchObject({
      activityKind: 'transport',
      activityCode: 'contracted',
      carrierKind: 'contracted',
      vehicleUse: 'commercial',
      fuelEconomyClass: 'unverified',
      fuelCode: 'diesel',
    });
    expect(result.errors).toEqual([
      { rowNo: 3, message: '重量×距離か t·km（燃料法なら燃料の量と単位）が必要です' },
    ]);
    expect(result.warnings.map((w) => w.message)).toEqual([
      '最大積載量 25 は kg です。単位が t ではありませんか',
      '積載率 0.5 は % です。割合ではなく % で入れてください',
    ]);
  });
});

describe('小数点の記号（取込の列の対応付けで利用者が選ぶ）', () => {
  it('選ばなければ「3.741」は曖昧なので読まず、選ぶよう促す', () => {
    expect(parseNumberWithSeparator('3.741', undefined)).toBeNull();
    expect(unreadableNumberMessage('排出量', '3.741', undefined)).toContain('小数点の記号を選ぶ');
    expect(parseNumberWithSeparator('2.5', undefined)).toBe(2.5);
  });

  it('「.」を選ぶと日英式で読む（桁区切りの「,」・単位の後置語を落とす）', () => {
    expect(parseNumberWithSeparator('3.741', 'dot')).toBe(3.741);
    expect(parseNumberWithSeparator('1,234.5 t-CO2e', 'dot')).toBe(1234.5);
    expect(parseNumberWithSeparator('1.234.5', 'dot')).toBeNull();
    expect(parseNumberWithSeparator('△12.5', 'dot')).toBe(-12.5);
  });

  it('「,」を選ぶと独仏式で読む', () => {
    expect(parseNumberWithSeparator('3.741', 'comma')).toBe(3741);
    expect(parseNumberWithSeparator('1.234,5', 'comma')).toBe(1234.5);
    expect(parseNumberWithSeparator('1 234,5', 'comma')).toBe(1234.5);
    expect(parseNumberWithSeparator('1,2,3', 'comma')).toBeNull();
  });

  it('既存結果・活動量の取込は選んだ記号で読む（選ばなければ曖昧な行はエラー）', () => {
    const headers = ['拠点', '区分', '排出量'];
    const rows = [['TH1', 'Scope1', '3.741']];
    const without = extractBaselineRows(
      table(headers, rows),
      { siteCode: '拠点', scope: '区分', emissions: '排出量' },
      { TH1: 'u-th' },
    );
    expect(without.rows).toHaveLength(0);
    expect(without.errors[0]?.message).toContain('小数点の記号を選ぶ');
    const withDot = extractBaselineRows(
      table(headers, rows),
      { siteCode: '拠点', scope: '区分', emissions: '排出量', decimalSeparator: 'dot' },
      { TH1: 'u-th' },
      { defaultEmissionsUnit: 't-CO2e' },
    );
    expect(withDot.rows[0]?.emissions).toBe(3.741);

    const energy = extractActivityRows(
      table(['月', '活動', '量', '単位'], [['2025-01', '電力', '1.250', 'kWh']]),
      'energy',
      { month: '月', activity: '活動', amount: '量', unit: '単位', decimalSeparator: 'comma' },
    );
    expect(energy.errors).toEqual([]);
    expect(energy.rows[0]?.amount).toBe(1250);
  });
});
