import { describe, expect, it } from 'vitest';
import {
  interpretStandardRow,
  looksLikeFormula,
  parseStandardCsvBytes,
  parseStandardCsvText,
  parseStandardDate,
  parseStandardNumber,
} from '@/lib/imports/standard-csv';

/**
 * 数値の標準 CSV（§7.4）の解析。
 *
 * 取込で最も事故が起きやすいのは「読めてしまう誤り」である。
 * 1.234 を 1234 と読む、空欄を 0 にする、数式を計算する——どれも画面上は成功に見える。
 * ここでは「読めないものは読めないと言う」ことを検査する。
 */

const HEADER =
  'metric_code,period_start,period_end,entity_code,boundary_code,value,unit,value_kind,availability_status,absence_reason,methodology_code,breakdown_key,source_reference';

/** Node の TextDecoder（shift_jis）から逆引き表を作り、テスト用に CP932 のバイト列を作る */
function encodeCp932(text: string): Uint8Array {
  const decoder = new TextDecoder('shift_jis');
  const table = new Map<string, number[]>();
  const leads = [
    ...Array.from({ length: 0x9f - 0x81 + 1 }, (_, i) => 0x81 + i),
    ...Array.from({ length: 0xfc - 0xe0 + 1 }, (_, i) => 0xe0 + i),
  ];
  for (const lead of leads) {
    for (let trail = 0x40; trail <= 0xfc; trail += 1) {
      if (trail === 0x7f) continue;
      const ch = decoder.decode(new Uint8Array([lead, trail]));
      if (ch.length === 1 && ch !== '�' && !table.has(ch)) table.set(ch, [lead, trail]);
    }
  }
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 0x80) {
      bytes.push(code);
      continue;
    }
    const mapped = table.get(ch);
    if (!mapped) throw new Error(`CP932 に無い文字: ${ch}`);
    bytes.push(...mapped);
  }
  return new Uint8Array(bytes);
}

describe('標準 CSV の読み込み', () => {
  it('UTF-8 の BOM を外して標準列を認識する', () => {
    const text = `${HEADER}\r\nscope1,2026-04-01,2027-03-31,HQ,,1190.9,t-CO2e,,,,,,\r\n`;
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
    const parsed = parseStandardCsvBytes(bytes);
    expect(parsed.encoding).toBe('UTF-8 (BOM)');
    expect(parsed.fileErrors).toEqual([]);
    expect(parsed.format).toBe('standard');
    expect(parsed.mapping[0]).toEqual({
      header: 'metric_code',
      field: 'metric_code',
      candidate: false,
    });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.fields.metric_code).toBe('scope1');
    expect(parsed.rows[0]?.rowNo).toBe(2);
  });

  it('CP932（Shift_JIS）の日本語セルを読む', () => {
    const text = `${HEADER}\r\nscope3_cat5,2026-04-01,2027-03-31,HQ,連結,,t-CO2e,実績,対象外,該当する活動なし,,,社内集計表\r\n`;
    const parsed = parseStandardCsvBytes(encodeCp932(text));
    expect(parsed.encoding).toBe('Shift_JIS');
    expect(parsed.fileErrors).toEqual([]);
    const row = parsed.rows[0]!;
    expect(row.fields.boundary_code).toBe('連結');
    expect(row.fields.absence_reason).toBe('該当する活動なし');
    const interp = interpretStandardRow(row);
    expect(interp.availabilityStatus).toBe('not_applicable');
    expect(interp.valueKind).toBe('actual');
    expect(interp.errors).toEqual([]);
  });

  it('引用符の中のカンマ・改行を 1 つのセルとして読む', () => {
    const text = `${HEADER}\nscope1,2026-04-01,2027-03-31,HQ,,10,t-CO2e,,,,,,"報告書, p.3\n（注記あり）"\n`;
    const parsed = parseStandardCsvText(text);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.fields.source_reference).toBe('報告書, p.3\n（注記あり）');
  });

  it('必須列が無いファイルは行を検証せずにファイルの誤りとして返す', () => {
    const parsed = parseStandardCsvText('metric_code,value\nscope1,1\n');
    expect(parsed.fileErrors.join(' ')).toContain('entity_code');
    expect(parsed.fileErrors.join(' ')).toContain('period_start');
  });

  it('既存テンプレートの列（拠点・項目・値・単位・期間）は「候補」として対応付ける', () => {
    const parsed = parseStandardCsvText(
      '拠点,項目,値,単位,期間\n本社,Scope1 排出量,10,t-CO2e,FY2026\n',
    );
    expect(parsed.format).toBe('legacy_template');
    expect(parsed.fileErrors).toEqual([]);
    expect(parsed.mapping.every((m) => m.candidate)).toBe(true);
    expect(parsed.mapping.map((m) => m.field)).toEqual([
      'entity_code',
      'metric_code',
      'value',
      'unit',
      'period_code',
    ]);
    const interp = interpretStandardRow(parsed.rows[0]!);
    expect(interp.periodCode).toBe('FY2026');
    expect(interp.errors).toEqual([]);
  });

  it('見出しに無い列は使わない列として残す（エラーにしない）', () => {
    const parsed = parseStandardCsvText(
      `${HEADER},memo\nscope1,2026-04-01,2027-03-31,HQ,,1,t-CO2e,,,,,,,メモ\n`,
    );
    expect(parsed.fileErrors).toEqual([]);
    expect(parsed.mapping.at(-1)).toEqual({ header: 'memo', field: null, candidate: false });
  });
});

describe('数値の解釈（曖昧な表記は確定しない）', () => {
  it('桁区切り・全角数字・マイナス記号の異体字を読む', () => {
    expect(parseStandardNumber('1,234.5')).toEqual({
      kind: 'number',
      value: 1234.5,
      normalized: '1234.5',
    });
    expect(parseStandardNumber('１２３４．５')).toMatchObject({ kind: 'number', value: 1234.5 });
    expect(parseStandardNumber('１，２３４，５６７')).toMatchObject({
      kind: 'number',
      value: 1234567,
    });
    expect(parseStandardNumber('−12.5')).toMatchObject({ kind: 'number', value: -12.5 });
    expect(parseStandardNumber('0')).toMatchObject({ kind: 'number', value: 0 });
    expect(parseStandardNumber('0.125')).toMatchObject({ kind: 'number', value: 0.125 });
  });

  it('1.234 と 1,234 は国によって読み方が変わるため、書式の指定が無ければ要確認にする', () => {
    expect(parseStandardNumber('1.234').kind).toBe('ambiguous');
    expect(parseStandardNumber('1,234').kind).toBe('ambiguous');
    expect(parseStandardNumber('1.234,5').kind).toBe('ambiguous');
    expect(parseStandardNumber('2,5').kind).toBe('ambiguous');
  });

  it('利用者が書式を明示したときだけ、その書式で読む', () => {
    expect(parseStandardNumber('1.234', 'dot_decimal')).toMatchObject({ value: 1.234 });
    expect(parseStandardNumber('1,234', 'dot_decimal')).toMatchObject({ value: 1234 });
    expect(parseStandardNumber('1.234', 'comma_decimal')).toMatchObject({ value: 1234 });
    expect(parseStandardNumber('1.234,5', 'comma_decimal')).toMatchObject({ value: 1234.5 });
    expect(parseStandardNumber('1234.5', 'comma_decimal').kind).toBe('invalid');
  });

  it('空欄は 0 にしない。数式・単位付き・横棒は数値として読まない', () => {
    expect(parseStandardNumber('')).toEqual({ kind: 'empty' });
    expect(parseStandardNumber('   ')).toEqual({ kind: 'empty' });
    expect(parseStandardNumber('=SUM(A1:A2)').kind).toBe('invalid');
    expect(parseStandardNumber('=1+2').kind).toBe('invalid');
    expect(parseStandardNumber('1234 t').kind).toBe('invalid');
    expect(parseStandardNumber('12%').kind).toBe('invalid');
    expect(parseStandardNumber('-').kind).toBe('invalid');
    expect(parseStandardNumber('1e3').kind).toBe('invalid');
  });

  it('数式に見える文字列を判定する（負数は数式扱いしない）', () => {
    expect(looksLikeFormula('=HYPERLINK("x")')).toBe(true);
    expect(looksLikeFormula('@cmd')).toBe(true);
    expect(looksLikeFormula('+cmd|x')).toBe(true);
    expect(looksLikeFormula('-12.5')).toBe(false);
    expect(looksLikeFormula('社内集計表')).toBe(false);
  });
});

describe('日付と値の有無', () => {
  it('日付の書き方の違いを揃え、存在しない日付は誤りにする', () => {
    expect(parseStandardDate('2026/4/1')).toEqual({ ok: true, date: '2026-04-01' });
    expect(parseStandardDate('2027年3月31日')).toEqual({ ok: true, date: '2027-03-31' });
    expect(parseStandardDate('2026-02-30').ok).toBe(false);
    expect(parseStandardDate('46113').ok).toBe(false);
  });

  function interpret(cells: Record<string, string>) {
    return interpretStandardRow({
      rowNo: 2,
      raw: cells,
      fields: {
        metric_code: 'scope1',
        period_start: '2026-04-01',
        period_end: '2027-03-31',
        entity_code: 'HQ',
        unit: 't-CO2e',
        ...cells,
      },
    });
  }

  it('空欄は「未入力」の候補（0 でも対象外でもない）', () => {
    const blank = interpret({ value: '' });
    expect(blank.availabilityStatus).toBe('not_entered');
    expect(blank.blankCandidate).toBe(true);
    expect(blank.value).toBeNull();
    expect(blank.errors).toEqual([]);

    const zero = interpret({ value: '0' });
    expect(zero.availabilityStatus).toBe('value_present');
    expect(zero.value).toBe(0);
  });

  it('未取得・対象外・未算定は理由が必須。値と状態の矛盾は誤り', () => {
    expect(interpret({ availability_status: 'not_applicable' }).errors.join(' ')).toContain('理由');
    const withReason = interpret({ availability_status: '未提出', absence_reason: '未着' });
    expect(withReason.availabilityStatus).toBe('not_obtained');
    expect(withReason.errors).toEqual([]);
    expect(
      interpret({ availability_status: 'not_applicable', absence_reason: 'x', value: '1' }).errors,
    ).not.toEqual([]);
    expect(interpret({ availability_status: 'value_present' }).errors).not.toEqual([]);
  });

  it('内訳の行は合算せず誤りにする（合計の行は受ける）', () => {
    expect(interpret({ value: '1', breakdown_key: 'plant-a' }).errors.join(' ')).toContain('内訳');
    expect(interpret({ value: '1', breakdown_key: '合計' }).errors).toEqual([]);
  });

  it('数式に見える出所は計算せず文字のまま残し、警告を付ける', () => {
    const row = interpret({ value: '1', source_reference: '=HYPERLINK("http://example.invalid")' });
    expect(row.sourceReference).toBe('=HYPERLINK("http://example.invalid")');
    expect(row.warnings.join(' ')).toContain('数式');
    expect(row.errors).toEqual([]);
  });
});
