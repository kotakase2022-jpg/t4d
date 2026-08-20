import { describe, expect, it } from 'vitest';
import { totpCode } from '../support/totp';

/**
 * RFC 6238 Appendix B のテストベクタで TOTP 実装を検証する。
 * （8 桁ベクタの下 6 桁と一致すること）
 */
describe('totpCode', () => {
  // secret はASCII "12345678901234567890" の base32 表現
  const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  it.each([
    [59_000, '287082'],
    [1_111_111_109_000, '081804'],
    [1_111_111_111_000, '050471'],
    [1_234_567_890_000, '005924'],
    [2_000_000_000_000, '279037'],
  ])('T=%d ms → %s', (atMs, expected) => {
    expect(totpCode(SECRET, atMs)).toBe(expected);
  });

  it('30 秒窓の中では同じコードを返す', () => {
    expect(totpCode(SECRET, 60_000)).toBe(totpCode(SECRET, 89_999));
    expect(totpCode(SECRET, 60_000)).not.toBe(totpCode(SECRET, 90_000));
  });

  it('base32 でない文字は拒否する', () => {
    expect(() => totpCode('not!valid', 0)).toThrow(/base32/);
  });
});
