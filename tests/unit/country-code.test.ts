import { describe, expect, it } from 'vitest';
import { ISO_3166_ALPHA2, isIsoCountryCode, normalizeCountryCode } from '@/lib/domain/country-code';

/**
 * 国コード（ISO 3166-1 alpha-2）の検査（plan CR-18・unit:country-code）。国別の係数の割当は国コードの一致で引くため、
 * 3 文字・国名・未割り当てのコードを拒否する（黙って国の割当が外れないように）。
 */

describe('isIsoCountryCode', () => {
  it('2 文字の割り当て済みコードを受け付け、表記ゆれ（小文字・全角・空白）を揃える', () => {
    for (const code of ['JP', 'TH', 'VN', 'MX', 'US', 'ID', 'BR', 'MY', 'CN', 'NL']) {
      expect(isIsoCountryCode(code), code).toBe(true);
    }
    expect(isIsoCountryCode(' jp ')).toBe(true);
    expect(isIsoCountryCode('ＴＨ')).toBe(true);
    expect(normalizeCountryCode(' ｔｈ')).toBe('TH');
  });

  it('3 文字・国名・未割り当て・空は拒否する', () => {
    for (const code of ['JPN', 'Japan', 'XX', 'UK', 'EU', '', 'J']) {
      expect(isIsoCountryCode(code), code).toBe(false);
    }
  });

  it('表は 249 の割り当て済みコード', () => {
    expect(ISO_3166_ALPHA2.size).toBe(249);
  });
});
