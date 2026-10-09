import { describe, expect, it } from 'vitest';
import { buildInfoFrom, buildStamp, UNKNOWN_BUILD_VALUE } from '@/lib/build-info';

/**
 * この環境の版（トライアル対応 NF-31。unit:build-info）。取得できなければ「不明」。
 */
describe('buildInfoFrom', () => {
  it('コミットは短縮形（7 文字・小文字）、日時は ISO にそろえて日本時間で表示する', () => {
    const info = buildInfoFrom({ commit: 'ABCDEF1234567', builtAt: '2026-10-09T08:00:00Z' });
    expect(info.commit).toBe('abcdef1');
    expect(info.builtAt).toBe('2026-10-09T08:00:00.000Z');
    expect(info.label).toBe('abcdef1（2026-10-09 17:00 ビルド）');
  });

  it('取得できなければ「不明」', () => {
    const info = buildInfoFrom({ commit: '', builtAt: null });
    expect(info.commit).toBe(UNKNOWN_BUILD_VALUE);
    expect(info.builtAt).toBeNull();
    expect(info.label).toBe('不明（ビルド日時 不明）');
  });

  it('コミットの形でない値・日時でない値は採らない（任意の文字列を画面・記録に出さない）', () => {
    const info = buildInfoFrom({ commit: '<script>', builtAt: 'yesterday' });
    expect(info.commit).toBe(UNKNOWN_BUILD_VALUE);
    expect(info.builtAt).toBeNull();
  });

  it('記録に添える形は版とビルド日時だけ', () => {
    const stamp = buildStamp(buildInfoFrom({ commit: 'abcdef1', builtAt: '2026-10-09T08:00:00Z' }));
    expect(stamp).toEqual({ build: 'abcdef1', builtAt: '2026-10-09T08:00:00.000Z' });
  });
});
