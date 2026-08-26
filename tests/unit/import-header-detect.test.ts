import { describe, expect, it } from 'vitest';
import { parseCsv } from '@/lib/imports/parsers';

/**
 * 人事システムの CSV は、明細表の前に帳票名・出力日時・抽出条件が数行入る
 * （奉行の「タイトル情報出力」は既定で有効）。行数は抽出条件の数で毎回変わるので
 * 読み飛ばし行数を固定値にできない。
 *
 * ヘッダー行は「本体と列数が揃っている行」で見分ける。
 */

const enc = (s: string) => new TextEncoder().encode(s);

describe('前置きブロックのある CSV', () => {
  const csv = [
    '在籍者集計表,,,,',
    '青海テクノロジー株式会社,,,,',
    '出力日時:2027/04/01 09:12,,,,',
    '集計対象:2026年度 期末在籍者,,,,',
    '出力条件:雇用区分=正社員のみ / 出向者を含まない,,,,',
    ',,,,',
    '部門コード,部門名,雇用区分,性別,在籍者数',
    '0012,第一営業部,正社員,男性,34',
    '0012,第一営業部,正社員,女性,19',
    '0013,第二営業部,正社員,男性,28',
    '',
    '※ 派遣社員は含みません。,,,,',
    'レコード件数: 3,,,,',
  ].join('\r\n');

  const table = parseCsv(enc(csv));

  it('帳票名ではなく本当のヘッダー行を選ぶ', () => {
    expect(table.headers).toEqual(['部門コード', '部門名', '雇用区分', '性別', '在籍者数']);
  });

  it('前置きブロックを本文に混ぜない', () => {
    const joined = JSON.stringify(table.rows);
    expect(joined).not.toContain('出力日時');
    expect(joined).not.toContain('在籍者集計表');
  });

  it('前置きブロックを preamble として取り出す（集計条件の手掛かりになる）', () => {
    expect(table.preamble.join(' ')).toContain('雇用区分=正社員のみ');
    expect(table.preamble.join(' ')).toContain('2026年度 期末在籍者');
  });

  it('明細行だけを rows にする（注記・件数行は trailer へ）', () => {
    expect(table.rows).toHaveLength(3);
    expect(table.trailer.join(' ')).toContain('派遣社員は含みません');
    expect(table.trailer.join(' ')).toContain('レコード件数: 3');
  });

  it('元ファイルの行番号を保つ（原資料へ辿れること）', () => {
    // ヘッダーは 7 行目なので、最初の明細は 8 行目
    expect(table.rowNumbers[0]).toBe(8);
  });
});

describe('同名の列があるファイル', () => {
  it('後勝ちで列を消さずに連番を振る', () => {
    const csv = ['部門,人数,人数', '第一営業部,34,19'].join('\n');
    const table = parseCsv(enc(csv));
    expect(table.headers).toEqual(['部門', '人数', '人数_2']);
    expect(table.rows[0]).toEqual({ 部門: '第一営業部', 人数: '34', 人数_2: '19' });
  });

  it('空の列名には位置から名前を付ける', () => {
    const csv = ['部門,,人数', '第一営業部,備考,34'].join('\n');
    const table = parseCsv(enc(csv));
    expect(table.headers).toEqual(['部門', '列2', '人数']);
  });
});

describe('列数が揃わない行があるファイル', () => {
  it('列数の合う行をヘッダーに選ぶ（長い説明行に釣られない）', () => {
    const csv = [
      '本レポートは人事システムから出力した速報値であり確定値ではありません',
      '',
      '部門,人数',
      '第一営業部,34',
      '第二営業部,28',
    ].join('\n');
    const table = parseCsv(enc(csv));
    expect(table.headers).toEqual(['部門', '人数']);
    expect(table.rows).toHaveLength(2);
  });
});
