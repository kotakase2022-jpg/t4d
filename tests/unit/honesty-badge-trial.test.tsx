import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { HONESTY_KINDS, HONESTY_TEXT, HonestyBadge } from '@/components/shared/honesty-badge';

/**
 * トライアル対応（付録 C）で足した誠実さの注記。ラベル＋アイコン＋補足（読み上げにも届く）を必ず出す。
 * XBRL の出力は提出用ではないこと、社内承認は第三者保証ではないことを、画面ごとに違う語で書かない。
 */
describe('HonestyBadge（トライアル対応の 2 種）', () => {
  it.each([
    ['not-filing-ready', '提出用ではない', '提出には使えません'],
    ['internal-approval', '社内承認版', '第三者保証ではありません'],
  ] as const)('%s はラベル・アイコン・補足を出す', (kind, label, detail) => {
    expect(HONESTY_KINDS).toContain(kind);
    const { container } = render(<HonestyBadge kind={kind} />);
    const badge = container.querySelector(`[data-honesty="${kind}"]`)!;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toContain(label);
    expect(badge.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(badge.querySelector('.sr-only')?.textContent).toContain(detail);
    expect(HONESTY_TEXT[kind].label).toBe(label);
  });
});
