import { describe, expect, it } from 'vitest';
import { contentDisposition, toCsv, toDocx, toXlsx } from '@/lib/exports';
import {
  daysUntilJst,
  formatJst,
  formatJstDate,
  formatNumber,
  formatPercent,
  isOverdue,
  toJstDate,
} from '@/lib/format/datetime';

interface Row {
  name: string;
  value: number | null;
  note: string;
}

const sheet = {
  name: 'テスト',
  columns: [
    { key: 'name', header: '指標', value: (r: Row) => r.name },
    { key: 'value', header: '値', value: (r: Row) => r.value, numeric: true },
    { key: 'note', header: '備考', value: (r: Row) => r.note },
  ],
  rows: [
    { name: 'Scope1', value: 1234.5, note: '通常' },
    { name: 'Scope2', value: null, note: 'カンマ, と "引用符" と\n改行' },
  ] as Row[],
};

describe('CSV Export', () => {
  const csv = toCsv(sheet);

  it('UTF-8 BOM を付ける（Excel の文字化け防止）', () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('ヘッダー行を出力する', () => {
    expect(csv).toContain('指標,値,備考');
  });

  it('カンマ・引用符・改行を含む値をエスケープする', () => {
    expect(csv).toContain('"カンマ, と ""引用符"" と\n改行"');
  });

  it('null を空欄にする', () => {
    const lines = csv.split('\r\n');
    expect(lines[2]).toContain('Scope2,,');
  });
});

describe('XLSX Export', () => {
  it('ブックを生成できる（ZIP シグネチャを持つ）', async () => {
    const bytes = await toXlsx([sheet], 'テストブック');
    expect(bytes.byteLength).toBeGreaterThan(1000);
    // XLSX は ZIP。先頭が "PK"
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });
});

describe('DOCX Export', () => {
  it('文書を生成できる', async () => {
    const bytes = await toDocx('テスト開示ドラフト', [
      {
        heading: '概要',
        paragraphs: ['本文 1', '本文 2'],
        table: { headers: ['区分', '件数'], rows: [['新規', '2']] },
      },
    ]);
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });
});

describe('Content-Disposition', () => {
  it('日本語ファイル名を RFC 5987 でエンコードする', () => {
    const header = contentDisposition('T4D_非財務データ.csv');
    expect(header).toContain("filename*=UTF-8''");
    expect(header).toContain(encodeURIComponent('T4D_非財務データ.csv'));
    // ASCII フォールバックも持つ
    expect(header).toMatch(/filename="[\x20-\x7e]+"/);
  });
});

describe('日時フォーマット（Asia/Tokyo 固定・DB は UTC）', () => {
  it('UTC を JST で表示する', () => {
    // 2026-08-13T20:00:00Z = 2026-08-14 05:00 JST
    expect(formatJst('2026-08-13T20:00:00.000Z')).toBe('2026-08-14 05:00');
  });

  it('日付境界: UTC 15:00 は翌日の JST 00:00', () => {
    expect(toJstDate('2026-08-13T15:00:00.000Z')).toBe('2026-08-14');
    expect(toJstDate('2026-08-13T14:59:59.000Z')).toBe('2026-08-13');
  });

  it('年またぎの日付境界', () => {
    expect(toJstDate('2025-12-31T15:00:00.000Z')).toBe('2026-01-01');
    expect(toJstDate('2025-12-31T14:59:00.000Z')).toBe('2025-12-31');
  });

  it('null は — で表示する', () => {
    expect(formatJst(null)).toBe('—');
    expect(formatJstDate(undefined)).toBe('—');
    expect(formatNumber(null)).toBe('—');
  });

  it('期限までの日数を JST の暦日で計算する', () => {
    expect(daysUntilJst('2026-08-14', '2026-08-14')).toBe(0);
    expect(daysUntilJst('2026-08-20', '2026-08-14')).toBe(6);
    expect(daysUntilJst('2026-08-10', '2026-08-14')).toBe(-4);
  });

  it('年度境界（3/31 → 4/1）でも正しく計算する', () => {
    expect(daysUntilJst('2026-04-01', '2026-03-31')).toBe(1);
    expect(daysUntilJst('2026-03-31', '2026-04-01')).toBe(-1);
  });

  it('期限超過を判定する', () => {
    expect(isOverdue('2026-08-13', '2026-08-14')).toBe(true);
    expect(isOverdue('2026-08-14', '2026-08-14')).toBe(false);
    expect(isOverdue(null, '2026-08-14')).toBe(false);
  });

  it('数値を 3 桁区切りで表示する', () => {
    expect(formatNumber(1234567.891)).toBe('1,234,567.891');
    expect(formatPercent(15.25)).toBe('15.3%');
  });
});

describe('CSV の数式インジェクション対策', () => {
  /**
   * 企業が入力した文字列は、CSV として監査法人の手元で開かれる。
   * `=` などで始まる値をそのまま出すと、開いた環境で数式として評価されうる。
   */
  const sheet = {
    name: 'テスト',
    columns: [
      { key: 'name', header: '指標', value: (r: { name: string }) => r.name },
      { key: 'value', header: '値', value: () => -12.5 },
    ],
    rows: [
      { name: '=1+1' },
      { name: '+HYPERLINK("http://example.test")' },
      { name: '-2+3' },
      { name: '@SUM(A1)' },
      { name: '通常の文字列' },
    ],
  };

  it('数式として解釈される先頭文字を無害化する', () => {
    const csv = toCsv(sheet);
    expect(csv).toContain("'=1+1");
    expect(csv).toContain("'+HYPERLINK");
    expect(csv).toContain("'-2+3");
    expect(csv).toContain("'@SUM(A1)");
  });

  it('通常の文字列と数値（負数を含む）は変えない', () => {
    const csv = toCsv(sheet);
    expect(csv).toContain('通常の文字列');
    expect(csv).not.toContain("'通常の文字列");
    expect(csv).toContain('-12.5');
    expect(csv).not.toContain("'-12.5");
  });
});
