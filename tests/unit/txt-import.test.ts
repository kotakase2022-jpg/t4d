import { describe, expect, it } from 'vitest';
import { looksTabular, parseUploadedFile, validateUpload } from '@/lib/imports/parsers';

/**
 * .txt の取込。
 *
 * .txt は中身が 2 通りある。
 *   - タブ区切りなどの**表**（システムからの書き出し）
 *   - 議事録・規程などの**自由記述**
 * 前者は行として取り込み、後者は資料の断片として扱う。
 * 自由記述を無理に表として読むと、1 列だけの意味の無い行が大量に並ぶ。
 */

const enc = (s: string) => new TextEncoder().encode(s);

describe('validateUpload', () => {
  it('.txt を受け付ける', () => {
    expect(validateUpload('実績.txt', 'text/plain', 100).ok).toBe(true);
    // 拡張子が無い・MIME が空でも、名前で判断できるものは受け付ける
    expect(validateUpload('実績.txt', '', 100).ok).toBe(true);
  });

  it('引き続き許可されない拡張子は拒否する', () => {
    expect(validateUpload('写真.png', 'image/png', 100).ok).toBe(false);
    expect(validateUpload('script.exe', 'application/octet-stream', 100).ok).toBe(false);
  });
});

describe('looksTabular', () => {
  it('タブ区切りの表を表と判定する', () => {
    const text = [
      '拠点\t項目\t値\t単位',
      '本社\t電力使用量\t120\tMWh',
      '東日本工場\t取水量\t80\tm3',
    ].join('\n');
    expect(looksTabular(text)).toBe(true);
  });

  it('カンマ区切りの表を表と判定する', () => {
    const text = ['拠点,項目,値,単位', '本社,電力使用量,120,MWh', '東日本工場,取水量,80,m3'].join(
      '\n',
    );
    expect(looksTabular(text)).toBe(true);
  });

  it('自由記述は表と判定しない', () => {
    const text = [
      'サステナビリティ委員会 議事録',
      '2026年7月14日 10:00-11:30 本社会議室',
      '',
      '出席者: 委員長ほか 8 名',
      '気候関連リスクの評価方法について審議した。取締役会への報告は四半期ごととする。',
      '次回は 10 月に開催する。',
    ].join('\n');
    expect(looksTabular(text)).toBe(false);
  });

  it('区切り文字があっても列数が揃わなければ表にしない', () => {
    const text = [
      '本日は、以下について議論した。',
      '一つ目、算定範囲。二つ目、報告頻度。',
      '以上。',
    ].join('\n');
    expect(looksTabular(text)).toBe(false);
  });

  it('1 行しかない場合は表と判定しない（見出しだけでは表にならない）', () => {
    expect(looksTabular('拠点\t項目\t値')).toBe(false);
  });
});

describe('parseUploadedFile', () => {
  it('表形式の .txt は表として読む', async () => {
    const text = ['拠点\t項目\t値\t単位\t期間', '本社\t電力使用量\t120\tMWh\tFY2026'].join('\r\n');
    const result = await parseUploadedFile('実績.txt', 'text/plain', enc('﻿' + text));
    expect(result.kind).toBe('table');
    if (result.kind !== 'table') return;
    expect(result.table.headers).toEqual(['拠点', '項目', '値', '単位', '期間']);
    expect(result.table.rows[0]?.['値']).toBe('120');
  });

  it('自由記述の .txt は資料として読む（表にしない）', async () => {
    const text = [
      'サステナビリティ委員会 議事録',
      '気候関連リスクの評価方法について審議した。',
      '集計対象は正社員のみとする。',
    ].join('\n');
    const result = await parseUploadedFile('議事録.txt', 'text/plain', enc('﻿' + text));
    expect(result.kind).toBe('text');
    if (result.kind !== 'text') return;
    expect(result.text.status).toBe('parsed');
    expect(result.text.pages[0]?.text).toContain('正社員のみ');
    expect(result.text.message).toContain('資料');
  });

  it('中身の無い .txt は成功扱いにしない', async () => {
    const result = await parseUploadedFile('空.txt', 'text/plain', enc('   \n\n'));
    expect(result.kind).toBe('text');
    if (result.kind !== 'text') return;
    expect(result.text.status).toBe('empty');
  });

  it('Shift_JIS の .txt も読める', async () => {
    // 「拠点」「項目」を CP932 で書いたバイト列
    const sjis = new Uint8Array([
      0x8b, 0x92, 0x93, 0x5f, 0x09, 0x8d, 0x80, 0x96, 0xda, 0x09, 0x92, 0x6c, 0x0d, 0x0a, 0x41,
      0x09, 0x42, 0x09, 0x31, 0x32, 0x30, 0x0d, 0x0a,
    ]);
    const result = await parseUploadedFile('実績.txt', 'text/plain', sjis);
    expect(result.kind).toBe('table');
    if (result.kind !== 'table') return;
    expect(result.table.detectedEncoding).toContain('Shift_JIS');
    expect(result.table.headers).toContain('拠点');
  });
});
