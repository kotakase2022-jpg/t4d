import { describe, expect, it } from 'vitest';
import {
  extractFactorRows,
  parseBasis,
  parseFactorKind,
  parseIsoDate,
  suggestFactorMapping,
  validateFactorMapping,
  type FactorColumnMapping,
  type FactorImportTable,
} from '@/lib/domain/ghg/factor-import';
import {
  fuelIntensity,
  type TransportDefaultParams,
  type TransportFormulaParams,
} from '@/lib/domain/ghg/tonkm';
import { toCsv } from '@/lib/exports';
import { buildGhgDemoFile } from '@/lib/fixtures/ghg-demo-files';
import { createFixtureDb } from '@/lib/fixtures/store';
import { parseCsv } from '@/lib/imports/parsers';

/**
 * 係数セットの取込（plan §2.4 P91・CR-01・unit:ghg-factor-import）。純関数。
 *  - 架空のサンプル（E20）の列をそのまま対応付けられ、8 行が係数になる
 *  - 数の表記（「0.437」）は小数点の記号を選ぶまで読まない（推測で埋めない）
 *  - 単位の次元・2 段係数の対・電力の基準・国コード・同じコードと年度の重複はエラー（黙って代えない）
 *  - 改良トンキロ法の式・見なし積載率の原単位表は燃費区分ごとの行を 1 つの係数（params）にまとめ、
 *    そのまま算定の関数（tonkm.ts）に渡せる
 * 改良トンキロ法の式の値は告示の値（テストの入力。research-tonkm.md §5 の公式例で検算する）
 */

const rel = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(1e-9);

function sampleTable(): FactorImportTable {
  const file = buildGhgDemoFile('factor-set', createFixtureDb());
  return parseCsv(new TextEncoder().encode(toCsv(file.sheet)));
}

function table(headers: string[], rows: string[][]): FactorImportTable {
  return {
    headers,
    rows: rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']))),
  };
}

const OPTS = { decimalSeparator: 'dot' as const, defaultSource: '（架空）テスト' };

const BASE_HEADERS = [
  '係数コード',
  '名称',
  '種類',
  '活動',
  '国',
  '基準',
  '活動量の単位',
  '単位発熱量',
  '単位発熱量の単位',
  '炭素排出係数',
  '炭素排出係数の単位',
  '排出係数',
  '排出係数の単位',
  '年度',
];

function base(rows: string[][]) {
  const t = table(BASE_HEADERS, rows);
  return extractFactorRows(t, suggestFactorMapping(t.headers), OPTS);
}

describe('列の対応付け', () => {
  it('架空のサンプルの見出しはすべて候補に当たる（同じ見出しを 2 つの項目に当てない）', () => {
    const t = sampleTable();
    const mapping = suggestFactorMapping(t.headers);
    expect(mapping).toEqual({
      code: '係数コード',
      name: '名称',
      kind: '種類',
      activity: '活動',
      country: '国',
      basis: '基準',
      activityUnit: '活動量の単位',
      calorificValue: '単位発熱量',
      calorificUnit: '単位発熱量の単位',
      carbonFactor: '炭素排出係数',
      carbonFactorUnit: '炭素排出係数の単位',
      factorValue: '排出係数',
      factorUnit: '排出係数の単位',
      validFrom: '適用開始',
      validTo: '適用終了',
      source: '出典',
    });
    expect(validateFactorMapping(t.headers, mapping)).toEqual([]);
  });

  it('必須の列が無い・無い見出し・同じ見出しの重複はエラー', () => {
    const headers = ['係数コード', '名称', '種類'];
    const errors = validateFactorMapping(headers, {
      code: '係数コード',
      name: '係数コード',
      kind: '区分',
    } satisfies FactorColumnMapping);
    expect(errors.join('\n')).toContain('「活動（燃料・ガスなど）」の列を選んでください');
    expect(errors.join('\n')).toContain('列「区分」がファイルにありません');
    expect(errors.join('\n')).toContain(
      '列「係数コード」を「係数コード」と「名称」の両方に選んでいます',
    );
    const result = extractFactorRows(
      table(headers, [['A', 'B', '燃料']]),
      { code: '係数コード' },
      OPTS,
    );
    expect(result.factors).toEqual([]);
    expect(result.errors.every((e) => e.line === null)).toBe(true);
  });
});

describe('架空のサンプル（E20）を読む', () => {
  it('小数点の記号を選ばなければ「0.437」のような値を読まない（推測で埋めない）', () => {
    const t = sampleTable();
    const result = extractFactorRows(t, suggestFactorMapping(t.headers), {
      defaultSource: '（架空）',
    });
    const messages = result.errors.map((e) => e.message).join('\n');
    expect(messages).toContain('小数点の記号を選ぶと読める場合があります');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('小数点を「.」にすると 8 行がそのまま係数になる（年度は適用開始から）', () => {
    const t = sampleTable();
    const result = extractFactorRows(t, suggestFactorMapping(t.headers), OPTS);
    expect(result.errors).toEqual([]);
    expect(result.rowCount).toBe(8);
    expect(result.factors).toHaveLength(8);
    expect(result.factors.every((f) => f.factorYear === 2025)).toBe(true);
    const vn = result.factors.find((f) => f.code === 'ORG-2025R-ELEC-LOC-VN')!;
    expect(vn).toMatchObject({
      activityKind: 'electricity',
      activityCode: 'grid',
      basis: 'location',
      countryCode: 'VN',
      factorValue: 0.671,
      factorUnit: 'kg-CO2/kWh',
      activityUnit: 'kWh',
    });
    const gas = result.factors.find((f) => f.code === 'ORG-2025R-CITYGAS')!;
    expect(gas).toMatchObject({
      activityKind: 'gas',
      activityCode: 'city_gas',
      activityUnit: 'kNm3',
      calorificValue: 44.8,
      calorificUnit: 'GJ/千Nm3',
      basis: null,
      countryCode: null,
    });
    // 2 段係数の 1 段にした値は表示用（44.8 × 炭素排出係数 × 44/12）
    rel(gas.factorValue, 44.8 * gas.carbonFactor! * (44 / 12));
    expect(gas.factorUnit).toBe('t-CO2/kNm3');
    const diesel = result.factors.find((f) => f.code === 'ORG-2025R-DIESEL')!;
    expect(diesel).toMatchObject({
      activityKind: 'fuel',
      activityCode: 'diesel',
      activityUnit: 'kL',
    });
    expect(diesel.factorSource).toContain('（架空）');
  });
});

describe('値の検査（黙って代えない）', () => {
  it('単位発熱量は GJ / 活動量の単位、炭素排出係数は tC/GJ か kgC/GJ だけ', () => {
    const r = base([
      ['F1', '軽油', '燃料', '軽油', '', '', 'kL', '38', 'MJ/L', '0.0187', 'tC/GJ', '', '', '2025'],
      [
        'F2',
        '軽油',
        '燃料',
        '軽油',
        '',
        '',
        'kL',
        '38',
        'GJ/kL',
        '0.0187',
        'tCO2/GJ',
        '',
        '',
        '2025',
      ],
    ]);
    expect(r.factors).toEqual([]);
    expect(r.errors.map((e) => e.message).join('\n')).toContain('「GJ/kL」にしてください');
    expect(r.errors.map((e) => e.message).join('\n')).toContain('tC/GJ か kgC/GJ');
  });

  it('2 段係数の片方だけ・係数の値が無い・係数の単位の分母が活動量の単位と違う', () => {
    const r = base([
      ['F1', '軽油', '燃料', '軽油', '', '', 'kL', '38', 'GJ/kL', '', '', '', '', '2025'],
      [
        'F2',
        '電力',
        '電力',
        '電力',
        'JP',
        'ロケーション基準',
        'kWh',
        '',
        '',
        '',
        '',
        '',
        '',
        '2025',
      ],
      [
        'F3',
        '電力',
        '電力',
        '電力',
        'JP',
        'ロケーション基準',
        'kWh',
        '',
        '',
        '',
        '',
        '0.4',
        'kg-CO2/MWh',
        '2025',
      ],
    ]);
    const messages = r.errors.map((e) => `${e.line}:${e.message}`).join('\n');
    expect(messages).toContain('2:2 段係数は単位発熱量と炭素排出係数の両方が要ります');
    expect(messages).toContain('3:係数の値がありません');
    expect(messages).toContain(
      '4:排出係数の単位「kg-CO2/MWh」の分母が活動量の単位（kWh）と違います',
    );
  });

  it('電力は基準が要る・電力以外は基準を書かない・国は ISO の 2 文字', () => {
    const r = base([
      ['E1', '電力', '電力', '電力', 'JP', '', 'kWh', '', '', '', '', '0.4', 'kg-CO2/kWh', '2025'],
      [
        'F1',
        '軽油',
        '燃料',
        '軽油',
        '',
        'ロケーション',
        'kL',
        '',
        '',
        '',
        '',
        '2.6',
        't-CO2/kL',
        '2025',
      ],
      [
        'E2',
        '電力',
        '電力',
        '電力',
        'JPN',
        'ロケーション',
        'kWh',
        '',
        '',
        '',
        '',
        '0.4',
        'kg-CO2/kWh',
        '2025',
      ],
    ]);
    const messages = r.errors.map((e) => e.message).join('\n');
    expect(messages).toContain('電力の係数には基準');
    expect(messages).toContain('基準（ロケーション・マーケット）は電力・熱の係数にだけ書きます');
    expect(messages).toContain('国「JPN」は ISO 3166-1 の 2 文字のコード');
  });

  it('購入した熱も Scope2 の 2 基準で別々に算定するため、基準が要る（基準の無い熱の係数は取り込まない）', () => {
    const missing = base([
      ['H1', '蒸気', '熱', '熱', 'JP', '', 'GJ', '', '', '', '', '0.06', 't-CO2/GJ', '2025'],
    ]);
    expect(missing.factors).toEqual([]);
    expect(missing.errors.map((e) => `${e.line}:${e.message}`)).toContain(
      '2:熱の係数には基準（ロケーション基準・マーケット基準）が要ります。',
    );
    const r = base([
      [
        'H2',
        '蒸気',
        '熱',
        '熱',
        'JP',
        'ロケーション基準',
        'GJ',
        '',
        '',
        '',
        '',
        '0.06',
        't-CO2/GJ',
        '2025',
      ],
    ]);
    expect(r.errors).toEqual([]);
    expect(r.factors.map((f) => [f.code, f.activityKind, f.basis])).toEqual([
      ['H2', 'heat', 'location'],
    ]);
  });

  it('同じコード・年度の重複はエラー、同じコードで年度が違えば別の係数（年度を区別する）', () => {
    const r = base([
      [
        'E1',
        '電力',
        '電力',
        '電力',
        'JP',
        'ロケーション',
        'kWh',
        '',
        '',
        '',
        '',
        '0.4',
        'kg-CO2/kWh',
        '2024',
      ],
      [
        'E1',
        '電力',
        '電力',
        '電力',
        'JP',
        'ロケーション',
        'kWh',
        '',
        '',
        '',
        '',
        '0.41',
        'kg-CO2/kWh',
        '2025',
      ],
    ]);
    expect(r.errors).toEqual([]);
    expect(r.factors.map((f) => [f.code, f.factorYear, f.factorValue])).toEqual([
      ['E1', 2024, 0.4],
      ['E1', 2025, 0.41],
    ]);
    const dup = base([
      [
        'E1',
        '電力',
        '電力',
        '電力',
        'JP',
        'ロケーション',
        'kWh',
        '',
        '',
        '',
        '',
        '0.4',
        'kg-CO2/kWh',
        '2025',
      ],
      [
        'E1',
        '電力',
        '電力',
        '電力',
        'JP',
        'ロケーション',
        'kWh',
        '',
        '',
        '',
        '',
        '0.41',
        'kg-CO2/kWh',
        '2025',
      ],
    ]);
    expect(dup.factors).toEqual([]);
    expect(dup.errors[0]).toMatchObject({ line: 3 });
    expect(dup.errors[0]!.message).toContain('が 2 回あります');
  });

  it('同じ活動・基準・国・年度の係数が 2 つなら警告（止めない）', () => {
    const r = base([
      [
        'E1',
        '電力',
        '電力',
        '電力',
        'JP',
        'ロケーション',
        'kWh',
        '',
        '',
        '',
        '',
        '0.4',
        'kg-CO2/kWh',
        '2025',
      ],
      [
        'E2',
        '電力',
        '電力',
        '電力',
        'JP',
        'ロケーション',
        'kWh',
        '',
        '',
        '',
        '',
        '0.41',
        'kg-CO2/kWh',
        '2025',
      ],
    ]);
    expect(r.errors).toEqual([]);
    expect(r.factors).toHaveLength(2);
    expect(r.warnings[0]!.message).toContain('同じ活動・基準・国・年度');
  });

  it('年度は 年度の列 → 適用開始 → セットの基準年。どれも無ければエラー', () => {
    const headers = [
      '係数コード',
      '名称',
      '種類',
      '活動',
      '活動量の単位',
      '排出係数',
      '排出係数の単位',
    ];
    const t = table(headers, [['F1', '軽油', '燃料', '軽油', 'kL', '2.6', 't-CO2/kL']]);
    const mapping = suggestFactorMapping(headers);
    expect(
      extractFactorRows(t, mapping, { ...OPTS, defaultYear: 2024 }).factors[0]!.factorYear,
    ).toBe(2024);
    const missing = extractFactorRows(t, mapping, OPTS);
    expect(missing.errors[0]!.message).toContain('年度が分かりません');
  });

  it('電力の契約の列があれば活動のコードは契約（マーケット基準の割当の鍵）', () => {
    const headers = [
      '係数コード',
      '名称',
      '種類',
      '活動',
      '契約',
      '基準',
      '活動量の単位',
      '排出係数',
      '排出係数の単位',
      '年度',
    ];
    const r = extractFactorRows(
      table(headers, [
        [
          'M1',
          '契約',
          '電力',
          '電力',
          'PLANT-GREEN-01',
          'マーケット基準',
          'kWh',
          '0.2',
          'kg-CO2/kWh',
          '2025',
        ],
      ]),
      suggestFactorMapping(headers),
      OPTS,
    );
    expect(r.errors).toEqual([]);
    expect(r.factors[0]).toMatchObject({ activityCode: 'PLANT-GREEN-01', basis: 'market' });
  });

  it('行の上限を超えたら読まない', () => {
    const rows = Array.from({ length: 3 }, (_, i) => [
      `F${i}`,
      '軽油',
      '燃料',
      '軽油',
      '',
      '',
      'kL',
      '',
      '',
      '',
      '',
      '2.6',
      't-CO2/kL',
      '2025',
    ]);
    const t = table(BASE_HEADERS, rows);
    const r = extractFactorRows(t, suggestFactorMapping(t.headers), { ...OPTS, maxRows: 2 });
    expect(r.factors).toEqual([]);
    expect(r.errors[0]!.message).toContain('2 行まで');
  });
});

describe('改良トンキロ法の係数（燃費区分ごとの行を 1 つの係数へ）', () => {
  const FORMULA_HEADERS = [
    '係数コード',
    '名称',
    '種類',
    '活動',
    '燃費区分',
    'A',
    'B',
    'S',
    '対数式の定数',
    '最大積載量の下限(kg)',
    '年度',
  ];

  it('式の行をまとめた係数は tonkm.ts にそのまま渡せる（公式例 0.041931331 を再現）', () => {
    const t = table(FORMULA_HEADERS, [
      [
        'TK-D',
        '式（軽油）',
        '改良トンキロ法の式',
        '軽油',
        '2025年度燃費基準',
        '8.83',
        '0.623',
        '0.812',
        '',
        '',
        '2025',
      ],
      [
        'TK-D',
        '式（軽油）',
        '改良トンキロ法の式',
        '軽油',
        '燃費基準未確認',
        '15.0',
        '0.654',
        '0.812',
        '2.71',
        '',
        '2025',
      ],
    ]);
    const mapping = suggestFactorMapping(FORMULA_HEADERS);
    expect(mapping).toMatchObject({
      formulaA: 'A',
      formulaB: 'B',
      formulaS: 'S',
      formulaLnA: '対数式の定数',
      payloadMinKg: '最大積載量の下限(kg)',
      economyClass: '燃費区分',
    });
    const r = extractFactorRows(t, mapping, OPTS);
    expect(r.errors).toEqual([]);
    expect(r.factors).toHaveLength(1);
    const f = r.factors[0]!;
    expect(f).toMatchObject({
      activityKind: 'transport_formula',
      activityCode: 'diesel',
      activityUnit: 'tkm',
      factorUnit: 'L/tkm',
      lines: [2, 3],
    });
    const params = f.params as unknown as TransportFormulaParams;
    expect(params.S).toBe(0.812);
    expect(params.classes.unverified).toEqual({ A: 15, B: 0.654, lnA: 2.71 });
    const intensity = fuelIntensity(
      {
        formula: params,
        policy: {
          shape: 'kokuji',
          minLoadPct: 10,
          over100: 'error',
          payloadRangeKg: { min: null, max: null },
          payloadOutOfRange: 'warn',
          overseas: 'warn',
          intensityRounding: null,
        },
      },
      {
        fuelEconomyClass: 'y2025',
        maxPayloadKg: 10000,
        loadFactorPct: 62,
        vehicleUse: 'commercial',
        overseas: false,
      },
    );
    if ('error' in intensity) throw new Error(intensity.error);
    // 調査メモの値は小数 9 桁で示されている。示された桁で比べる（tests/unit/ghg-tonkm.test.ts と同じ）
    expect(intensity.raw).toBeCloseTo(0.041931331, 9);
  });

  it('S が行で違う・同じ燃費区分が 2 回はエラー', () => {
    const t = table(FORMULA_HEADERS, [
      ['TK-D', '式', '式', '軽油', '2025年度燃費基準', '8.83', '0.623', '0.812', '', '', '2025'],
      ['TK-D', '式', '式', '軽油', '2025年度燃費基準', '8.83', '0.623', '0.9', '', '', '2025'],
    ]);
    const r = extractFactorRows(t, suggestFactorMapping(FORMULA_HEADERS), OPTS);
    expect(r.factors).toEqual([]);
    const messages = r.errors.map((e) => e.message).join('\n');
    expect(messages).toContain('式の係数 S が行によって違います');
    expect(messages).toContain('が 2 回あります');
  });

  const DEFAULT_HEADERS = [
    '係数コード',
    '名称',
    '種類',
    '活動',
    '用途',
    '最大積載量の下限(kg)',
    '最大積載量の上限(kg)',
    '見なし積載率(%)',
    '燃費区分',
    '原単位',
    '年度',
  ];

  it('見なし積載率の原単位表は 用途 × 区分 ごとにまとめ、燃費区分の値を並べる', () => {
    const t = table(DEFAULT_HEADERS, [
      [
        'TD-D',
        '表（軽油）',
        '見なし積載率の原単位表',
        '軽油',
        '事業用',
        '2000',
        '4000',
        '34',
        '燃費基準未確認',
        '0.192',
        '2025',
      ],
      [
        'TD-D',
        '表（軽油）',
        '見なし積載率の原単位表',
        '軽油',
        '事業用',
        '2000',
        '4000',
        '34',
        '2025年度燃費基準',
        '0.145',
        '2025',
      ],
      [
        'TD-D',
        '表（軽油）',
        '見なし積載率の原単位表',
        '軽油',
        '事業用',
        '1000',
        '2000',
        '25',
        '2022年度燃費基準',
        '0.286',
        '2025',
      ],
    ]);
    const r = extractFactorRows(t, suggestFactorMapping(DEFAULT_HEADERS), OPTS);
    expect(r.errors).toEqual([]);
    const params = r.factors[0]!.params as unknown as TransportDefaultParams;
    expect(params.table).toEqual([
      { vehicleUse: 'commercial', minKg: 1000, maxKg: 2000, loadPct: 25, values: { y2022: 0.286 } },
      {
        vehicleUse: 'commercial',
        minKg: 2000,
        maxKg: 4000,
        loadPct: 34,
        values: { unverified: 0.192, y2025: 0.145 },
      },
    ]);
    const intensity = fuelIntensity(
      {
        defaults: params,
        policy: {
          shape: 'kokuji',
          minLoadPct: 10,
          over100: 'error',
          payloadRangeKg: { min: null, max: null },
          payloadOutOfRange: 'warn',
          overseas: 'warn',
          intensityRounding: null,
        },
      },
      {
        fuelEconomyClass: 'unverified',
        maxPayloadKg: 3000,
        loadFactorPct: null,
        vehicleUse: 'commercial',
        overseas: false,
      },
    );
    if ('error' in intensity) throw new Error(intensity.error);
    expect(intensity).toMatchObject({
      raw: 0.192,
      loadFactorSource: 'default',
      loadFactorUsed: 34,
    });
  });

  it('同じ用途で最大積載量の区分が重なればエラー（どちらの値か決まらない）', () => {
    const t = table(DEFAULT_HEADERS, [
      [
        'TD-D',
        '表',
        '原単位表',
        '軽油',
        '事業用',
        '2000',
        '4000',
        '34',
        '燃費基準未確認',
        '0.192',
        '2025',
      ],
      [
        'TD-D',
        '表',
        '原単位表',
        '軽油',
        '事業用',
        '3000',
        '6000',
        '37',
        '燃費基準未確認',
        '0.127',
        '2025',
      ],
    ]);
    const r = extractFactorRows(t, suggestFactorMapping(DEFAULT_HEADERS), OPTS);
    expect(r.factors).toEqual([]);
    expect(r.errors[0]!.message).toContain('区分が他の行と重なっています');
  });
});

describe('値の読み方', () => {
  it('種類・基準・日付', () => {
    expect(parseFactorKind('燃料')).toBe('fuel');
    expect(parseFactorKind('電力')).toBe('electricity');
    expect(parseFactorKind('改良トンキロ法の式')).toBe('transport_formula');
    expect(parseFactorKind('見なし積載率の原単位表')).toBe('transport_default');
    expect(parseFactorKind('何か')).toBeNull();
    expect(parseBasis('ロケーション基準')).toBe('location');
    expect(parseBasis('market-based')).toBe('market');
    expect(parseBasis('')).toBeNull();
    expect(parseIsoDate('2025/1/5')).toBe('2025-01-05');
    expect(parseIsoDate('2025-02-30')).toBeNull();
  });
});
