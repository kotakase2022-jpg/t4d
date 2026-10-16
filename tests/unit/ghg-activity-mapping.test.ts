import { describe, expect, it } from 'vitest';
import {
  activityMappingFields,
  normalizeHeader,
  parseMappingSelection,
  suggestActivityMapping,
  validateActivityMapping,
} from '@/app/enterprise/ghg/calculation/activity/_lib/activity-mapping';
import { buildGhgDemoFile } from '@/lib/fixtures/ghg-demo-files';
import { createFixtureDb } from '@/lib/fixtures/store';

/**
 * 活動量の取込の列の対応付け（plan P94・CR-05・unit:ghg-activity-mapping）。
 *  - 架空のサンプル（E20）の列はすべて自動で対応する
 *  - 同じ列を 2 つの項目に当てない・必須の欠け・組み合わせで要る項目を、項目名つきの文で返す
 *  - 単位を取り違えると桁違いになる列（重量 kg・最大積載量 t・積載率が % 以外）は対応付けの段で止める
 */

const headersOf = (kind: 'energy' | 'transport') =>
  buildGhgDemoFile(kind, createFixtureDb()).sheet.columns.map((c) => c.header);

describe('suggestActivityMapping', () => {
  it('輸送実績のサンプルの 12 列をすべて対応付ける', () => {
    const headers = headersOf('transport');
    expect(suggestActivityMapping(headers, 'transport')).toEqual({
      month: '月',
      shipmentRef: '出荷番号',
      carrierKind: '輸送の区分',
      fuel: '燃料',
      cargoWeightT: '輸送重量(t)',
      distanceKm: '輸送距離(km)',
      maxPayloadKg: '最大積載量(kg)',
      loadFactorPct: '積載率(%)',
      vehicleUse: '用途',
      fuelEconomyClass: '燃費の区分',
      cargoKind: '貨物',
      note: '備考',
    });
    const validation = validateActivityMapping(
      suggestActivityMapping(headers, 'transport'),
      headers,
      'transport',
    );
    expect(validation.problems).toEqual([]);
    expect(validation.mapping?.month).toBe('月');
  });

  it('エネルギーのサンプルの 6 列をすべて対応付ける', () => {
    const headers = headersOf('energy');
    expect(suggestActivityMapping(headers, 'energy')).toEqual({
      month: '月',
      activity: '活動',
      amount: '量',
      unit: '単位',
      contractCode: '契約',
      note: '備考',
    });
    expect(
      validateActivityMapping(suggestActivityMapping(headers, 'energy'), headers, 'energy')
        .problems,
    ).toEqual([]);
  });

  it('全角・大小・括弧・「の」の違いを吸収し、1 つの列は 1 つの項目にだけ当てる', () => {
    expect(normalizeHeader('燃費の区分')).toBe('燃費区分');
    expect(normalizeHeader('Ｍｏｎｔｈ')).toBe('month');
    expect(normalizeHeader('輸送重量 (t)')).toBe('輸送重量');
    const mapping = suggestActivityMapping(
      ['年月', '燃料の量', '燃料の単位', '燃料', '輸送の区分', '燃料の種類'],
      'transport',
    );
    expect(mapping).toMatchObject({
      month: '年月',
      amount: '燃料の量',
      unit: '燃料の単位',
      fuel: '燃料',
      carrierKind: '輸送の区分',
    });
    const headers = Object.values(mapping);
    expect(new Set(headers).size).toBe(headers.length);
  });

  it('前方一致は 2 文字以上の候補だけ（「月」で別の列を拾わない）', () => {
    expect(suggestActivityMapping(['月末の在庫', '電力使用量'], 'energy').month).toBeUndefined();
    expect(suggestActivityMapping(['使用量(kWh)'], 'energy').amount).toBe('使用量(kWh)');
  });

  it('項目の一覧: エネルギーは月・活動・量・単位が必須、輸送は月・輸送の区分・燃料が必須', () => {
    const required = (kind: 'energy' | 'transport') =>
      activityMappingFields(kind)
        .filter((f) => f.need === 'required')
        .map((f) => f.key);
    expect(required('energy')).toEqual(['month', 'activity', 'amount', 'unit']);
    expect(required('transport')).toEqual(['month', 'carrierKind', 'fuel']);
  });
});

describe('validateActivityMapping', () => {
  const transportHeaders = headersOf('transport');

  it('ファイルに無い列・同じ列の 2 重の割当・必須の欠けを項目名つきで返し、取込の対応を作らない', () => {
    const result = validateActivityMapping(
      { month: '月', carrierKind: '燃料', fuel: '燃料', cargoWeightT: '重さ' },
      transportHeaders,
      'transport',
    );
    expect(result.mapping).toBeNull();
    expect(result.problems).toEqual(
      expect.arrayContaining([
        '輸送重量（t）: 列「重さ」がファイルにありません。',
        '列「燃料」を 輸送の区分（委託・自社便）・燃料 の 2 つ以上に当てています。',
      ]),
    );
  });

  it('輸送: 重量×距離か t·km（燃料法なら量と単位）が要り、t·km を使うなら最大積載量と燃費の区分が要る', () => {
    const base = { month: '月', carrierKind: '輸送の区分', fuel: '燃料' };
    expect(validateActivityMapping(base, transportHeaders, 'transport').problems).toContain(
      '輸送重量と輸送距離、または輸送トンキロ（燃料法なら燃料の量と単位）の列を選んでください。',
    );
    const halfway = validateActivityMapping(
      { ...base, cargoWeightT: '輸送重量(t)' },
      transportHeaders,
      'transport',
    );
    expect(halfway.problems).toContain(
      '輸送重量と輸送距離は両方を選んでください（片方だけでは t·km を作れません）。',
    );
    const noPayload = validateActivityMapping(
      { ...base, cargoWeightT: '輸送重量(t)', distanceKm: '輸送距離(km)' },
      transportHeaders,
      'transport',
    );
    expect(noPayload.problems).toEqual([
      '改良トンキロ法には最大積載量（kg）の列が要ります。',
      '改良トンキロ法には燃費の区分の列が要ります（不明な車両は「未確認」と書きます）。',
    ]);
  });

  it('燃料法だけのファイル（燃料の量と単位）は最大積載量・燃費の区分を求めない', () => {
    const headers = ['月', '輸送の区分', '燃料', '燃料の量', '単位'];
    const result = validateActivityMapping(
      suggestActivityMapping(headers, 'transport'),
      headers,
      'transport',
    );
    expect(result.problems).toEqual([]);
    expect(result.mapping).toMatchObject({ amount: '燃料の量', unit: '単位' });
  });

  it('単位の語が食い違う列は止める（重量 kg・最大積載量 t・積載率が % 以外）', () => {
    const headers = [
      '月',
      '区分',
      '燃料',
      '重量(kg)',
      '距離',
      '最大積載量(t)',
      '積載率(割合)',
      '燃費',
    ];
    const result = validateActivityMapping(
      {
        month: '月',
        carrierKind: '区分',
        fuel: '燃料',
        cargoWeightT: '重量(kg)',
        distanceKm: '距離',
        maxPayloadKg: '最大積載量(t)',
        loadFactorPct: '積載率(割合)',
        fuelEconomyClass: '燃費',
      },
      headers,
      'transport',
    );
    expect(result.mapping).toBeNull();
    expect(result.problems).toEqual([
      '輸送重量の列「重量(kg)」は kg のようです。輸送重量は t（トン）で入れてください。',
      '最大積載量の列「最大積載量(t)」は t のようです。最大積載量は kg で入れてください。',
      '積載率の列「積載率(割合)」の単位が % ではありません。積載率は % で入れてください。',
    ]);
  });

  it('エネルギーの必須の欠けは項目ごとに返す', () => {
    const result = validateActivityMapping({ month: '月' }, ['月', '量'], 'energy');
    expect(result.problems).toEqual([
      '活動の列を選んでください。',
      '量の列を選んでください。',
      '単位の列を選んでください。',
    ]);
  });

  it('種類に無い項目は無視する（輸送の項目をエネルギーの対応に入れない）', () => {
    const headers = headersOf('energy');
    const result = validateActivityMapping(
      { ...suggestActivityMapping(headers, 'energy'), loadFactorPct: '量' },
      headers,
      'energy',
    );
    expect(result.problems).toEqual([]);
    expect(result.mapping).not.toHaveProperty('loadFactorPct');
  });
});

describe('parseMappingSelection', () => {
  it('知らない項目・文字列でない値・空の値は捨てる。壊れた JSON は空', () => {
    expect(
      parseMappingSelection(
        JSON.stringify({ month: '月', evil: 'x', amount: 3, unit: ' ', fuel: '燃料' }),
      ),
    ).toEqual({ month: '月', fuel: '燃料' });
    expect(parseMappingSelection('{')).toEqual({});
    expect(parseMappingSelection('[1]')).toEqual({});
    expect(parseMappingSelection(null)).toEqual({});
  });
});
