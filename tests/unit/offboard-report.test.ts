import { describe, expect, it } from 'vitest';
import {
  CASCADED_TABLES,
  KEPT_TABLES,
  offboardReport,
  offboardSql,
  resolveBackupResidualDays,
  type OffboardReportInput,
} from '../../scripts/offboard-tenant';

/**
 * 削除完了の報告（案）と終了処理の SQL（plan CR-26・CR-27・unit:offboard-report）。
 *  - 報告に削除日・件数・manifest の sha256・残存期間・消去の見込み日・「それまで秘密情報として管理」を入れる
 *  - 組織の名称を入れない（組織コードと日付・件数だけ）
 *  - 残存期間が未合意なら --backup-residual-days が無いと止まる。合意値と違う値でも止まる
 *  - 資料へのアクセスの記録は「残す」と書かない（資料の削除に連鎖して消える）
 */

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const SHA = 'b'.repeat(64);

function report(overrides: Partial<OffboardReportInput> = {}): string {
  return offboardReport({
    organizationCode: 'TRIAL-CO',
    executedOn: '2026-12-01',
    tableCounts: { data_points: 120, trial_programs: 1, ghg_activity_lines: 30, units: 0 },
    manifestSha256: SHA,
    backupResidualDays: 35,
    residualSource: 'agreed',
    ...overrides,
  }).join('\n');
}

describe('削除完了の報告（案）', () => {
  it('削除日・件数・manifest・残存期間・消去の見込み日・秘密情報としての管理を書く', () => {
    const text = report();
    expect(text).toContain('削除完了の報告（案）');
    expect(text).toContain('組織コード: TRIAL-CO');
    expect(text).toContain('削除の実施日: 2026-12-01（日本時間）');
    expect(text).toContain('合計 151 行（3 表）');
    expect(text).toContain(`sha256: ${SHA}`);
    expect(text).toContain('バックアップの残存期間: 35 日（データ取扱条件の合意値）');
    expect(text).toContain('バックアップから消える見込み日: 2027-01-05');
    expect(text).toContain('それまで秘密情報として管理します');
  });

  it('組織の名称を入れない（組織コードだけ）', () => {
    const text = report({ organizationCode: 'X-001' });
    expect(text).not.toContain('株式会社');
    expect(text).not.toContain('名称');
    expect(text).toContain('X-001');
  });

  it('資料へのアクセスの記録は連鎖して消えると書く（「残す」と書かない）', () => {
    const text = report();
    expect(text).toContain('資料へのアクセスの記録は、資料の削除に連鎖して消えました');
    expect(CASCADED_TABLES).toEqual(['storage_access_events']);
    expect(KEPT_TABLES).not.toContain('storage_access_events' as never);
  });

  it('日付・日数が読めなければ止まる', () => {
    expect(() => report({ executedOn: '2026/12/01' })).toThrow('YYYY-MM-DD');
    expect(() => report({ backupResidualDays: 401 })).toThrow('0〜400');
  });

  it('manifest を指定しないときは「指定なし」と書く。運営が指定した日数はそう書く', () => {
    const text = report({
      manifestSha256: null,
      residualSource: 'argument',
      backupResidualDays: 0,
    });
    expect(text).toContain('（指定なし）');
    expect(text).toContain('0 日（運営が指定した値）');
    expect(text).toContain('バックアップから消える見込み日: 2026-12-01');
  });
});

describe('残存期間の決め方', () => {
  it('合意値があれば使う。引数が同じ値なら通す', () => {
    expect(resolveBackupResidualDays({ agreed: 35, argument: undefined })).toBe(35);
    expect(resolveBackupResidualDays({ agreed: 35, argument: '35' })).toBe(35);
  });

  it('合意値と違う引数は止める（先に条件の版を記録し直す）', () => {
    expect(() => resolveBackupResidualDays({ agreed: 35, argument: '30' })).toThrow(
      '合意値（35 日）と違います',
    );
  });

  it('未合意なら --backup-residual-days が必須（推測しない）', () => {
    expect(() => resolveBackupResidualDays({ agreed: null, argument: undefined })).toThrow(
      '--backup-residual-days',
    );
    expect(resolveBackupResidualDays({ agreed: null, argument: '60' })).toBe(60);
    expect(() => resolveBackupResidualDays({ agreed: null, argument: '500' })).toThrow('0〜400');
  });
});

describe('終了処理の SQL', () => {
  it('残存期間を渡すと 5 引数版を組み立てる', () => {
    const sql = offboardSql({
      organizationId: ORG_ID,
      organizationCode: "TRIAL'CO",
      manifestSha256: SHA,
      executedByLabel: '運営',
      backupResidualDays: 35,
    });
    expect(sql).toContain(
      `t4d.offboard_organization('${ORG_ID}'::uuid, 'TRIAL''CO', '${SHA}', '運営', 35);`,
    );
    expect(
      offboardSql({
        organizationId: ORG_ID,
        organizationCode: 'X',
        manifestSha256: null,
        executedByLabel: '運営',
        backupResidualDays: null,
      }),
    ).toContain(`'X', null, '運営', null::integer);`);
  });

  it('残存期間を渡さないと旧い 4 引数版。範囲外の日数は止める', () => {
    expect(
      offboardSql({
        organizationId: ORG_ID,
        organizationCode: 'X',
        manifestSha256: null,
        executedByLabel: '運営',
      }),
    ).toContain(`'X', null, '運営');`);
    expect(() =>
      offboardSql({
        organizationId: ORG_ID,
        organizationCode: 'X',
        manifestSha256: null,
        executedByLabel: '運営',
        backupResidualDays: -1,
      }),
    ).toThrow('0〜400');
  });
});
