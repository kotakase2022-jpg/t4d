import { describe, expect, it } from 'vitest';
import {
  businessToday,
  describeReferenceDate,
  getReferenceDate,
  todayInTimeZone,
} from '../../src/lib/clock';
import { FIXTURE_TODAY } from '../../src/lib/config';

/**
 * 業務上の「今日」（期限判定の基準日）。
 *
 * これまで Supabase Mode でも FIXTURE_TODAY で期限を判定しており、
 * 本番の期限・超過が 2026-08-14 基準で誤っていた（W0 棚卸し O5）。
 */
describe('基準日（src/lib/clock.ts）', () => {
  it('Demo Mode では FIXTURE_TODAY を返す（実時計に関係なく固定）', () => {
    expect(getReferenceDate('demo')).toBe(FIXTURE_TODAY);
    expect(getReferenceDate('demo', { now: new Date('2030-01-01T00:00:00Z') })).toBe(FIXTURE_TODAY);
  });

  it('テスト環境は Demo Mode なので、モード省略時も FIXTURE_TODAY になる', () => {
    expect(getReferenceDate()).toBe(FIXTURE_TODAY);
    expect(businessToday()).toBe(FIXTURE_TODAY);
  });

  it('Supabase Mode では実時計を Asia/Tokyo の暦日にする', () => {
    const now = new Date('2026-09-29T03:00:00Z'); // JST 12:00
    expect(getReferenceDate('supabase', { now })).toBe('2026-09-29');
    expect(businessToday({ mode: 'supabase', now })).toBe('2026-09-29');
  });

  it('JST の日付境界で切り替わる（UTC の日付を使わない）', () => {
    // UTC 2026-09-28 15:00 = JST 2026-09-29 00:00
    expect(getReferenceDate('supabase', { now: new Date('2026-09-28T14:59:59Z') })).toBe(
      '2026-09-28',
    );
    expect(getReferenceDate('supabase', { now: new Date('2026-09-28T15:00:00Z') })).toBe(
      '2026-09-29',
    );
  });

  it('組織のタイムゾーンを渡せる（既定は Asia/Tokyo）', () => {
    const now = new Date('2026-09-29T03:00:00Z');
    expect(todayInTimeZone(now)).toBe('2026-09-29');
    // ロサンゼルスではまだ前日
    expect(getReferenceDate('supabase', { now, timeZone: 'America/Los_Angeles' })).toBe(
      '2026-09-28',
    );
  });

  it('デモでは「デモ基準日」を表示用に返し、実時計では表示しない', () => {
    expect(describeReferenceDate('demo')).toEqual({
      date: FIXTURE_TODAY,
      source: 'fixture',
      label: `デモ基準日 ${FIXTURE_TODAY}`,
    });
    const info = describeReferenceDate('supabase', { now: new Date('2026-09-29T03:00:00Z') });
    expect(info).toEqual({ date: '2026-09-29', source: 'clock', label: null });
  });
});
