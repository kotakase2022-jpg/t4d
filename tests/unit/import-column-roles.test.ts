import { describe, expect, it } from 'vitest';
import { classifyColumns, pickValueCell } from '@/lib/imports/column-roles';

/**
 * 人事システムの帳票は、値の列以外に「コード」「日付」「前年同期」などの
 * 数字に見える列を大量に持つ。行内で最初に見つかった数値を採ると、
 * 部門コード 0012 が「12 人」になり、前年値が当年値として台帳へ入る。
 *
 * 列名と列全体の値の形から役割を決め、値として採ってよい列だけを残す。
 */

describe('classifyColumns', () => {
  it('ゼロ埋めコード列を code と判定する', () => {
    const roles = classifyColumns(
      ['部門コード', '部門名', '在籍者数'],
      [
        { 部門コード: '0012', 部門名: '第一営業部', 在籍者数: '34' },
        { 部門コード: '0013', 部門名: '第二営業部', 在籍者数: '28' },
      ],
    );
    expect(roles['部門コード']).toBe('code');
    expect(roles['在籍者数']).toBe('value');
  });

  it('列名がコードを示すならゼロ埋めでなくても code', () => {
    const roles = classifyColumns(
      ['社員番号', 'EMP_NO', 'Position ID', '人数'],
      [{ 社員番号: '1001', EMP_NO: '2', 'Position ID': 'P-004822', 人数: '3' }],
    );
    expect(roles['社員番号']).toBe('code');
    expect(roles['EMP_NO']).toBe('code');
    expect(roles['Position ID']).toBe('code');
    expect(roles['人数']).toBe('value');
  });

  it('日付列を date と判定する（和暦・8桁・スラッシュ）', () => {
    const roles = classifyColumns(
      ['入社年月日', '基準日', 'Reporting Date', '人数'],
      [
        {
          入社年月日: '令和8年4月1日',
          基準日: '20260401',
          'Reporting Date': '2026-03-31',
          人数: '12',
        },
        { 入社年月日: 'R8.4.1', 基準日: '20260401', 'Reporting Date': '2026-12-31', 人数: '8' },
      ],
    );
    expect(roles['入社年月日']).toBe('date');
    expect(roles['基準日']).toBe('date');
    expect(roles['Reporting Date']).toBe('date');
    expect(roles['人数']).toBe('value');
  });

  it('前年・前期の列を previous と判定する', () => {
    const roles = classifyColumns(
      ['在籍者数', '前年同期在籍者数', '上年同期用工总数', 'Prior Year Headcount'],
      [
        {
          在籍者数: '310',
          前年同期在籍者数: '298',
          上年同期用工总数: '305',
          'Prior Year Headcount': '288',
        },
      ],
    );
    expect(roles['在籍者数']).toBe('value');
    expect(roles['前年同期在籍者数']).toBe('previous');
    expect(roles['上年同期用工总数']).toBe('previous');
    expect(roles['Prior Year Headcount']).toBe('previous');
  });

  it('期間・単位の列をそれぞれ判定する', () => {
    const roles = classifyColumns(
      ['対象期間', '単位', '値'],
      [{ 対象期間: 'FY2026', 単位: '人', 値: '480' }],
    );
    expect(roles['対象期間']).toBe('period');
    expect(roles['単位']).toBe('unit');
    expect(roles['値']).toBe('value');
  });

  it('文字列だけの列は label', () => {
    const roles = classifyColumns(['部門名', '人数'], [{ 部門名: '第一営業部', 人数: '34' }]);
    expect(roles['部門名']).toBe('label');
  });
});

describe('pickValueCell', () => {
  const headers = ['部門コード', '部門名', '基準日', '在籍者数', '前年同期'];
  const roles = classifyColumns(headers, [
    {
      部門コード: '0012',
      部門名: '第一営業部',
      基準日: '20260331',
      在籍者数: '34',
      前年同期: '31',
    },
  ]);

  it('コード・日付・前年値を避けて当年の値を採る', () => {
    const picked = pickValueCell(
      {
        部門コード: '0012',
        部門名: '第一営業部',
        基準日: '20260331',
        在籍者数: '34',
        前年同期: '31',
      },
      roles,
    );
    expect(picked).toEqual({ header: '在籍者数', value: 34 });
  });

  it('値が 0 でも採る（0 人・0 件は本物の値）', () => {
    const picked = pickValueCell(
      {
        部門コード: '0012',
        部門名: '安全管理課',
        基準日: '20260331',
        在籍者数: '0',
        前年同期: '2',
      },
      roles,
    );
    expect(picked).toEqual({ header: '在籍者数', value: 0 });
  });

  it('値の列が空なら null（前年値へ滑り落ちない）', () => {
    const picked = pickValueCell(
      {
        部門コード: '0012',
        部門名: '第一営業部',
        基準日: '20260331',
        在籍者数: '',
        前年同期: '31',
      },
      roles,
    );
    expect(picked).toBeNull();
  });

  it('値の候補列が複数あるときは判断せず null を返す（人へ委ねる）', () => {
    const multi = classifyColumns(
      ['部門名', '男性', '女性'],
      [{ 部門名: '第一営業部', 男性: '20', 女性: '14' }],
    );
    expect(pickValueCell({ 部門名: '第一営業部', 男性: '20', 女性: '14' }, multi)).toBeNull();
  });
});
