import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseCsv, parseFlexibleNumber, parsePdf } from '@/lib/imports/parsers';
import { normalizeLabel } from '@/lib/imports/learning';
import { buildHeterogeneousDataset } from '../../scripts/hetero-dataset';

/**
 * 異種データ対応の解析ロジック（機能追加要望 ①）。
 * 多言語・多表記・多区切りのファイルを「事前加工なし」で読めることを固定する。
 */

describe('parseFlexibleNumber — ロケール混在の数値表記', () => {
  it('日英式（カンマ桁区切り）を解釈する', () => {
    expect(parseFlexibleNumber('1,234.5')).toBe(1234.5);
    expect(parseFlexibleNumber('3,120,500')).toBe(3120500);
  });

  it('独仏式（ピリオド桁区切り・カンマ小数点）を解釈する', () => {
    expect(parseFlexibleNumber('1.234,5')).toBe(1234.5);
    expect(parseFlexibleNumber('8,4')).toBe(8.4);
    expect(parseFlexibleNumber('1 842,3')).toBe(1842.3);
  });

  it('全角数字・％・単位付きを解釈する', () => {
    expect(parseFlexibleNumber('１２４００')).toBe(12400);
    expect(parseFlexibleNumber('18.4%')).toBe(18.4);
    expect(parseFlexibleNumber('812.3 t')).toBe(812.3);
  });

  it('数値でないものは null（勝手に 0 にしない）', () => {
    expect(parseFlexibleNumber('検針値')).toBeNull();
    expect(parseFlexibleNumber('')).toBeNull();
  });

  it('ドット単独の 3 桁区切り形（"2.845"）は判別不能として null（独式 2845 / 英式 2.845 の両解釈があり得る）', () => {
    expect(parseFlexibleNumber('2.845')).toBeNull();
    expect(parseFlexibleNumber('1.234')).toBeNull();
    expect(parseFlexibleNumber('1.234.567')).toBeNull();
    // 小数として一意に読める形は従来どおり
    expect(parseFlexibleNumber('812.3')).toBe(812.3);
    expect(parseFlexibleNumber('2.84')).toBe(2.84);
    expect(parseFlexibleNumber('2.8456')).toBe(2.8456);
  });
});

describe('detectDelimiter — 区切り文字の自動判定', () => {
  it('セミコロン区切り（欧州 CSV）を判定する', () => {
    expect(detectDelimiter('Standort;Kennzahl;Wert\nMünchen;Strom;1.234,5')).toBe(';');
  });

  it('タブ区切りとカンマ区切りを判定する', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
  });

  it('引用符内の区切り文字は数えない', () => {
    expect(detectDelimiter('"a;b;c;d",x\n"1;2;3;4",y')).toBe(',');
  });
});

describe('parseCsv — セミコロン区切りの実ファイル', () => {
  it('ドイツ語 CSV が 4 列として解析される（1 列に潰れない）', () => {
    const bytes = new TextEncoder().encode(
      'Standort;Kennzahl;Wert;Einheit\r\nMünchen Büro;Stromverbrauch;1.234,5;kWh',
    );
    const table = parseCsv(bytes);
    expect(table.headers).toEqual(['Standort', 'Kennzahl', 'Wert', 'Einheit']);
    expect(table.rows[0]?.Kennzahl).toBe('Stromverbrauch');
    expect(parseFlexibleNumber(table.rows[0]?.Wert ?? '')).toBe(1234.5);
  });
});

describe('normalizeLabel — 事前学習のラベル正規化', () => {
  it('数値・期間・単位セルを除いた文字セルを正規化して連結する', () => {
    expect(
      normalizeLabel({
        拠点: '西日本工場',
        項目: '蒸気（購入分）',
        値: '18.4',
        単位: 'GJ',
        期間: 'FY2026',
      }),
    ).toBe('西日本工場|蒸気(購入分)'); // NFKC で全角括弧は半角へ正規化される
  });

  it('全角半角・大小・空白の揺れを吸収する（同じラベルに正規化される）', () => {
    const a = normalizeLabel({ Site: 'München Büro', Metric: 'Stromverbrauch' });
    const b = normalizeLabel({ 拠点: 'München  büro', 項目: 'STROMVERBRAUCH' });
    expect(a).toBe(b);
  });
});

describe('異種データ 50 ファイルの生成', () => {
  it('50 ファイルが決定論的に生成される', async () => {
    const files = await buildHeterogeneousDataset();
    expect(files).toHaveLength(50);
    // ファイル名は一意
    expect(new Set(files.map((f) => f.name)).size).toBe(50);
    // フォーマットの多様性: CSV / TSV / Excel / PDF が全て含まれる
    expect(files.some((f) => f.name.endsWith('.csv'))).toBe(true);
    expect(files.some((f) => f.name.endsWith('.tsv'))).toBe(true);
    expect(files.some((f) => f.name.endsWith('.xlsx'))).toBe(true);
    expect(files.filter((f) => f.name.endsWith('.pdf'))).toHaveLength(5);
  });

  it('手組みの PDF が実際にテキスト抽出できる（needs_ocr にならない）', async () => {
    const files = await buildHeterogeneousDataset();
    const pdf = files.find((f) => f.name === '46_electricity_invoice_munich.pdf')!;
    const parsed = await parsePdf(pdf.bytes);
    expect(parsed.status).toBe('parsed');
    // 請求書としての体裁（発行者・請求番号・明細・合計・排出係数）が抽出できる
    expect(parsed.pages[0]?.text).toContain('Stadtwerke Muenchen');
    expect(parsed.pages[0]?.text).toContain('SR-2026-004128');
    expect(parsed.pages[0]?.text).toContain('74.200,0 kWh');
    expect(parsed.pages[0]?.text).toContain('Rechnungsbetrag');
  });
});
