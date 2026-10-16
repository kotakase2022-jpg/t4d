import { describe, expect, it } from 'vitest';
import {
  addCalendarDays,
  backupPurgeDueOn,
  backupResidualLabel,
  backupResidualText,
  BACKUP_RESIDUAL_DAYS_MAX,
  isBackupResidualDays,
  isCalendarDate,
} from '@/lib/domain/data-disposal';

/**
 * 返却・削除とバックアップの残存（plan CR-26・unit:data-disposal）。
 *  - 消去の見込み日 = 削除日 + 残存期間（暦日。月末・うるう年は暦どおり。0 日は同じ日）
 *  - 残存期間が未合意なら見込み日を出さない（推測しない）
 *  - 残存期間は 0〜400 の整数（0060 の CHECK と同じ）
 */

describe('backupPurgeDueOn', () => {
  it('暦日で足す（月末・年末をまたぐ）', () => {
    expect(backupPurgeDueOn('2026-10-16', 35)).toBe('2026-11-20');
    expect(backupPurgeDueOn('2026-01-31', 1)).toBe('2026-02-01');
    expect(backupPurgeDueOn('2026-12-31', 1)).toBe('2027-01-01');
    expect(backupPurgeDueOn('2026-03-31', 30)).toBe('2026-04-30');
  });

  it('うるう年の 2 月 29 日を数える', () => {
    expect(backupPurgeDueOn('2028-02-28', 1)).toBe('2028-02-29');
    expect(backupPurgeDueOn('2028-02-29', 1)).toBe('2028-03-01');
    expect(backupPurgeDueOn('2027-02-28', 1)).toBe('2027-03-01');
    expect(backupPurgeDueOn('2028-02-29', 365)).toBe('2029-02-28');
  });

  it('0 日は削除日と同じ日。上限 400 日まで', () => {
    expect(backupPurgeDueOn('2026-10-16', 0)).toBe('2026-10-16');
    expect(backupPurgeDueOn('2026-10-16', BACKUP_RESIDUAL_DAYS_MAX)).toBe('2027-11-20');
  });

  it('未合意（null）・削除日なし・範囲外・実在しない日付は出さない（推測しない）', () => {
    expect(backupPurgeDueOn('2026-10-16', null)).toBeNull();
    expect(backupPurgeDueOn(null, 35)).toBeNull();
    expect(backupPurgeDueOn('2026-10-16', -1)).toBeNull();
    expect(backupPurgeDueOn('2026-10-16', 401)).toBeNull();
    expect(backupPurgeDueOn('2026-10-16', 1.5)).toBeNull();
    expect(backupPurgeDueOn('2027-02-29', 1)).toBeNull();
  });
});

describe('日付と日数の検査', () => {
  it('実在する日付だけを日付とみなす', () => {
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2027-02-29')).toBe(false);
    expect(isCalendarDate('2026/10/16')).toBe(false);
    expect(() => addCalendarDays('2026-13-01', 1)).toThrow(RangeError);
  });

  it('残存期間は 0〜400 の整数', () => {
    expect(isBackupResidualDays(0)).toBe(true);
    expect(isBackupResidualDays(400)).toBe(true);
    expect(isBackupResidualDays(401)).toBe(false);
    expect(isBackupResidualDays(-1)).toBe(false);
    expect(isBackupResidualDays(null)).toBe(false);
    expect(isBackupResidualDays('35')).toBe(false);
  });
});

describe('固定の文', () => {
  it('合意済みなら日数を入れ、秘密情報として管理することを書く', () => {
    const text = backupResidualText(35);
    expect(text).toContain('合意: 35 日');
    expect(text).toContain('期間の終了後に消え、それまで秘密情報として管理します');
    expect(backupResidualLabel(35)).toBe('35 日');
  });

  it('未合意なら日数を推測せず「未合意」と書く', () => {
    const text = backupResidualText(null);
    expect(text).toContain('残存期間は未合意です');
    expect(text).not.toMatch(/\d+ 日/);
    expect(backupResidualLabel(null)).toBe('未合意');
  });
});
