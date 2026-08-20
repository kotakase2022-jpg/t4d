import { describe, expect, it } from 'vitest';
import {
  decodeText,
  detectHeaderRow,
  parseCsv,
  parseCsvText,
  validateUpload,
} from '@/lib/imports/parsers';
import { SQL_TABLE_NAMES, toCamel, toSnake } from '@/lib/repositories/table-names';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

describe('CSV パーサ', () => {
  it('引用符・カンマ・改行を含むセルを解析する', () => {
    const rows = parseCsvText('a,b\n"1,000","改行\nあり"\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['1,000', '改行\nあり'],
    ]);
  });

  it('エスケープされた引用符を解釈する', () => {
    expect(parseCsvText('x\n"He said ""hi"""')).toEqual([['x'], ['He said "hi"']]);
  });

  it('CRLF を扱える', () => {
    expect(parseCsvText('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('ヘッダー行を推定する（説明行を読み飛ばす）', () => {
    const grid = [
      ['環境データ提出フォーム'],
      [''],
      ['拠点', '項目', '値', '単位'],
      ['東日本工場', 'Scope1', '1234', 't-CO2e'],
    ];
    expect(detectHeaderRow(grid)).toBe(2);
  });

  it('空行を除外し、行番号を保持する', () => {
    const csv = '拠点,項目,値\n\n東日本工場,Scope1,100\n\n西日本工場,Scope1,200\n';
    const table = parseCsv(new TextEncoder().encode(csv));
    expect(table.rows).toHaveLength(2);
    expect(table.rowNumbers).toEqual([3, 5]);
    expect(table.rows[0]).toEqual({ 拠点: '東日本工場', 項目: 'Scope1', 値: '100' });
  });
});

describe('文字コード判定', () => {
  it('UTF-8 BOM を検出して除去する', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('拠点')]);
    const result = decodeText(bytes);
    expect(result.encoding).toBe('UTF-8 (BOM)');
    expect(result.text).toBe('拠点');
  });

  it('UTF-8 をそのまま読む', () => {
    const result = decodeText(new TextEncoder().encode('東日本工場'));
    expect(result.encoding).toBe('UTF-8');
    expect(result.text).toBe('東日本工場');
  });

  it('Shift_JIS を判定して読む', () => {
    // 「拠点」の Shift_JIS バイト列
    const sjis = new Uint8Array([0x8b, 0x92, 0x93, 0x5f]);
    const result = decodeText(sjis);
    expect(result.encoding).toBe('Shift_JIS');
    expect(result.text).toBe('拠点');
  });
});

describe('アップロード検証', () => {
  it('Path Traversal を含むファイル名を無害化する', () => {
    const result = validateUpload('../../etc/passwd.csv', 'text/csv', 100);
    expect(result.safeName).not.toContain('..');
    expect(result.safeName).toBe('passwd.csv');
    expect(result.ok).toBe(true);
  });

  it('Windows のパス区切りも除去する', () => {
    const result = validateUpload('C:\\Users\\secret\\data.csv', 'text/csv', 100);
    expect(result.safeName).toBe('data.csv');
  });

  it('許可されない拡張子を拒否する', () => {
    const result = validateUpload('malware.exe', 'application/octet-stream', 100);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('拡張子');
  });

  it('サイズ上限を超えるファイルを拒否する', () => {
    const result = validateUpload('big.csv', 'text/csv', 26 * 1024 * 1024);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('上限');
  });

  it('空ファイルを拒否する', () => {
    expect(validateUpload('empty.csv', 'text/csv', 0).ok).toBe(false);
  });

  it('許可されない MIME を拒否する', () => {
    const result = validateUpload('script.csv', 'text/html', 100);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('MIME');
  });
});

describe('列名変換', () => {
  it('camelCase → snake_case（数字を分離しない）', () => {
    expect(toSnake('sha256')).toBe('sha256');
    expect(toSnake('unitOfMeasure')).toBe('unit_of_measure');
    expect(toSnake('estimatedCostUsd')).toBe('estimated_cost_usd');
    expect(toSnake('id')).toBe('id');
  });

  it('snake_case → camelCase', () => {
    expect(toCamel('unit_of_measure')).toBe('unitOfMeasure');
    expect(toCamel('sha256')).toBe('sha256');
    expect(toCamel('estimated_cost_usd')).toBe('estimatedCostUsd');
  });

  it('往復変換が安定する', () => {
    for (const name of ['unitOfMeasure', 'sha256', 'clientIpHash', 'progressPercent']) {
      expect(toCamel(toSnake(name))).toBe(name);
    }
  });
});

describe('SQL とテーブル名定義の整合', () => {
  const migrationsDir = path.resolve(process.cwd(), 'supabase', 'migrations');
  const sql = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(path.join(migrationsDir, f), 'utf8'))
    .join('\n');

  it('SQL_TABLE_NAMES の全テーブルが migration に存在する', () => {
    for (const tableName of Object.values(SQL_TABLE_NAMES)) {
      expect(
        new RegExp(`create table ${tableName}\\s*\\(`, 'i').test(sql),
        `${tableName} が migration に見つかりません`,
      ).toBe(true);
    }
  });

  it('TS 側テーブルキーに重複した SQL 名がない', () => {
    const names = Object.values(SQL_TABLE_NAMES);
    expect(new Set(names).size).toBe(names.length);
  });
});
