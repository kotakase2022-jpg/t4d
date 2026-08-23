import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES } from '../../src/lib/imports/parsers';

/**
 * 取込は Server Action でファイルを受け取る。
 * Next.js の Server Action は既定で **1MB** までしか本文を受け付けない。
 * 画面は「1 ファイル 25MB まで」と案内し、サーバー側検証も 25MB を上限にしているので、
 * 設定を入れ忘れると 1MB を超えた時点で検証にすら届かず取込が失敗する。
 */
describe('アップロード上限の整合', () => {
  const config = readFileSync('next.config.ts', 'utf8');

  it('next.config.ts の bodySizeLimit が MAX_UPLOAD_BYTES 以上になっている', () => {
    const match = config.match(/bodySizeLimit:\s*'(\d+)mb'/);
    expect(match, 'serverActions.bodySizeLimit が設定されていない').not.toBeNull();
    const limitBytes = Number(match![1]) * 1024 * 1024;
    expect(limitBytes).toBeGreaterThanOrEqual(MAX_UPLOAD_BYTES);
  });

  it('画面の案内（25MB）とサーバー側の上限が一致している', () => {
    expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
  });
});
