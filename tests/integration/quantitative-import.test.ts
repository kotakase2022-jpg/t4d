import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import {
  ORG_IDS,
  PERIOD_IDS,
  UNIT_IDS,
  dataPointId,
  metricId,
  userId,
} from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import type { DbClient, Query, Row, TableName } from '@/lib/repositories/types';
import { transitionDataPoint, updateDataPointValue } from '@/lib/services/data-point-workflow';
import {
  commitQuantitativeImport,
  listQuantitativeImportBatches,
  QUANTITATIVE_IMPORT_EXPIRED_MESSAGE,
  QuantitativeImportConflictError,
  QuantitativeImportExpiredError,
  QuantitativeImportPartialError,
  validateQuantitativeImport,
  type QuantitativeImportCommitMode,
  type QuantitativeImportPreview,
} from '@/lib/services/quantitative-import';
import type { NumberNotation } from '@/lib/imports/standard-csv';
import type { AuthorizationContext, RoleKey, Uuid } from '@/types/domain';

/**
 * 数値を登録（標準 CSV・手入力）: 検証 → 差分 → 確定（§6.4 / §7.1 / §7.4 / §12.2）。
 *
 * 受入テスト（§15）: A03 同じ CSV を名前を変えて再取込 / A04 訂正 CSV / A05 プレビュー後の変化 /
 * A06 混在単位・年度・組織不明 / A07 空欄・未提出・0・対象外 / A11 推計 / A35 保存失敗と再試行。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  unitScopeIds: Uuid[] = [],
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds,
    },
    engagementIds: [],
    demo: true,
  };
}

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const admin = () => ctxFor('enterprise-admin@demo.local', ['enterprise_admin']);
const siteUser = () => ctxFor('site-user@demo.local', ['site_contributor'], [UNIT_IDS.east]);
const viewer = () => ctxFor('reviewer@demo.local', ['viewer']);

const HEADER =
  'metric_code,period_start,period_end,entity_code,boundary_code,value,unit,value_kind,availability_status,absence_reason,methodology_code,breakdown_key,source_reference';
const FY26 = '2026-04-01,2027-03-31';

function csv(...lines: string[]): string {
  return [HEADER, ...lines].join('\r\n');
}

async function validate(
  text: string,
  options: { fileName?: string; ctx?: AuthorizationContext; notation?: NumberNotation } = {},
): Promise<QuantitativeImportPreview> {
  return validateQuantitativeImport(db, options.ctx ?? manager(), {
    reportingPeriodId: PERIOD_IDS.fy2026,
    source: {
      kind: 'file',
      fileName: options.fileName ?? 'metrics.csv',
      bytes: new TextEncoder().encode(text),
    },
    numberNotation: options.notation,
  });
}

async function commit(
  preview: QuantitativeImportPreview,
  options: {
    ctx?: AuthorizationContext;
    mode?: QuantitativeImportCommitMode;
    reason?: string;
    key?: string;
    client?: DbClient;
  } = {},
) {
  return commitQuantitativeImport(options.client ?? db, options.ctx ?? manager(), {
    batchId: preview.batchId,
    previewHash: preview.previewHash,
    idempotencyKey: options.key ?? randomUUID(),
    mode: options.mode ?? 'all',
    correctionReason: options.reason ?? null,
  });
}

function rowOf(preview: QuantitativeImportPreview, rowNo: number) {
  const row = preview.rows.find((r) => r.rowNo === rowNo);
  if (!row) throw new Error(`row ${rowNo} not found`);
  return row;
}

/** 業務キーで Data Point を引く（新規作成した行の ID を決め打ちしない） */
function dpByKey(metricCode: string, unitId: Uuid, periodId: Uuid = PERIOD_IDS.fy2026) {
  return fixture.dataPoints.find(
    (dp) =>
      dp.metricId === metricId('AOMI', metricCode) &&
      dp.unitId === unitId &&
      dp.reportingPeriodId === periodId &&
      !dp.deletedAt,
  );
}

function versionsOf(dpId: Uuid) {
  return fixture.dataPointVersions
    .filter((v) => v.dataPointId === dpId)
    .sort((a, b) => a.versionNo - b.versionNo);
}

const HQ_SCOPE1 = dataPointId('HQ', 'scope1', 'FY2026');
const hqScope1 = () => fixture.dataPoints.find((dp) => dp.id === HQ_SCOPE1)!;
/** 表記を揺らさずに現在値を CSV へ書く */
const hqScope1Value = () => String(hqScope1().value);

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('A03 同じ CSV を名前を変えて再取込しても二重に登録しない', () => {
  it('2 回目は全行「変更なし」になり、確定しても版が増えない。重複の理由を示す', async () => {
    const text = csv(
      `scope2_location,${FY26},HQ,連結,5000,t-CO2e,actual,,,,,電力会社の請求書（架空）`,
      `scope1,${FY26},HQ,連結,${hqScope1Value()},t-CO2e,,,,,,`,
    );

    const first = await validate(text, { fileName: 'scope2_2026.csv' });
    expect(first.counts).toEqual({ new: 1, changed: 0, unchanged: 1, error: 0 });
    const firstResult = await commit(first);
    expect(firstResult.created).toBe(1);
    expect(firstResult.updated).toBe(0);

    const created = dpByKey('scope2_location', UNIT_IDS.hq)!;
    expect(created.status).toBe('draft');
    const versionsBefore = fixture.dataPointVersions.length;

    const second = await validate(text, { fileName: 'コピー - scope2_2026 (1).csv' });
    expect(second.counts).toEqual({ new: 0, changed: 0, unchanged: 2, error: 0 });
    expect(second.fileWarnings.join(' ')).toContain('同じ内容のファイル');
    expect(second.fileWarnings.join(' ')).toContain('scope2_2026.csv');
    expect(rowOf(second, 2).warnings.join(' ')).toContain('重複して登録しません');

    const secondResult = await commit(second);
    expect(secondResult).toMatchObject({ created: 0, updated: 0, unchanged: 2, excluded: 0 });
    expect(fixture.dataPointVersions.length).toBe(versionsBefore);
    expect(versionsOf(created.id)).toHaveLength(1);
  });

  it('同じ新規行を含む 2 つの検証結果は、後から確定したほうを競合として止める', async () => {
    const text = csv(`scope2_location,${FY26},HQ,連結,5000,t-CO2e,,,,,,`);
    const a = await validate(text, { fileName: 'a.csv' });
    const b = await validate(text, { fileName: 'b.csv' });
    await commit(a);
    await expect(commit(b)).rejects.toBeInstanceOf(QuantitativeImportConflictError);
    expect(
      fixture.dataPoints.filter(
        (dp) =>
          dp.metricId === metricId('AOMI', 'scope2_location') &&
          dp.unitId === UNIT_IDS.hq &&
          dp.reportingPeriodId === PERIOD_IDS.fy2026,
      ),
    ).toHaveLength(1);
  });
});

describe('A04 既存値と異なる訂正 CSV', () => {
  it('上書きせずに次の版を作り、旧値と変更理由が残る。承認済みは下書きへ戻す（自動承認しない）', async () => {
    const before = hqScope1();
    // 参照ではなく写しを取る（後で書き換わっていないことを比べるため）
    const oldVersions = versionsOf(HQ_SCOPE1).map((v) => ({ ...v }));
    expect(before.status).toBe('approved');

    const preview = await validate(
      csv(`scope1,${FY26},HQ,連結,1201.3,t-CO2e,actual,,,,,訂正後の燃料集計表（架空）`),
    );
    const row = rowOf(preview, 2);
    expect(row.diffKind).toBe('changed');
    expect(row.previous?.versionNo).toBe(oldVersions.length);
    expect(row.previous?.valueDisplay).toBe(new Intl.NumberFormat('ja-JP').format(before.value!));
    expect(row.delta).toBe(
      `+${new Intl.NumberFormat('ja-JP').format(Math.round((1201.3 - before.value!) * 10) / 10)}`,
    );
    expect(row.warnings.join(' ')).toContain('承認済み');

    // 変更理由が無ければ確定しない
    await expect(commit(preview)).rejects.toThrow(/変更理由/);
    expect(versionsOf(HQ_SCOPE1)).toHaveLength(oldVersions.length);

    const result = await commit(preview, { reason: '燃料使用量の集計漏れを訂正（架空）' });
    expect(result.updated).toBe(1);

    const versions = versionsOf(HQ_SCOPE1);
    expect(versions).toHaveLength(oldVersions.length + 1);
    // 旧版はそのまま残る
    for (const [index, old] of oldVersions.entries()) {
      expect(versions[index]).toEqual(old);
    }
    const latest = versions.at(-1)!;
    expect(latest.value).toBe(1201.3);
    expect(latest.changeReason).toBe('燃料使用量の集計漏れを訂正（架空）');
    expect(latest.sourceType).toBe('import');
    expect(latest.sourceReference).toContain('標準CSV「metrics.csv」 2 行目');
    expect(latest.sourceReference).toContain('訂正後の燃料集計表（架空）');

    const after = hqScope1();
    expect(after.currentVersionId).toBe(latest.id);
    expect(after.value).toBe(1201.3);
    expect(after.status).toBe('draft');
    expect(after.changedAfterApproval).toBe(true);
  });
});

describe('A05 プレビュー後に既存値が変わった', () => {
  it('確定を競合として止め、行と最新値を示す。取込側の版は作らない', async () => {
    const preview = await validate(csv(`scope1,${FY26},HQ,連結,1201.3,t-CO2e,,,,,,`));
    expect(rowOf(preview, 2).diffKind).toBe('changed');

    // 検証の後に、画面から別の人が同じ値を訂正した
    await updateDataPointValue(db, admin(), {
      dataPointId: HQ_SCOPE1,
      value: 1195,
      unitOfMeasure: 't-CO2e',
      changeReason: '別経路の訂正（架空）',
    });
    const versionsAfterManual = versionsOf(HQ_SCOPE1).length;

    const error = await commit(preview, { reason: '訂正' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuantitativeImportConflictError);
    const conflicts = (error as QuantitativeImportConflictError).conflicts;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ rowNo: 2 });
    expect(conflicts[0]!.currentDisplay).toContain('1,195');
    expect(conflicts[0]!.reason).toContain('新しい版');

    expect(versionsOf(HQ_SCOPE1)).toHaveLength(versionsAfterManual);
    expect(hqScope1().value).toBe(1195);
    expect(fixture.quantitativeImportBatches.find((b) => b.id === preview.batchId)?.status).toBe(
      'validated',
    );
  });

  it('検証の後に状態が変わった値（入力中 → 提出済み）も、書き込む前に競合として止める', async () => {
    const euScope2 = dataPointId('EU', 'scope2', 'FY2026');
    expect(fixture.dataPoints.find((dp) => dp.id === euScope2)?.status).toBe('draft');
    const preview = await validate(csv(`scope2,${FY26},EU,連結,999,t-CO2e,,,,,,`));
    expect(rowOf(preview, 2).diffKind).toBe('changed');

    await transitionDataPoint(db, manager(), { dataPointId: euScope2, to: 'submitted' });

    const error = await commit(preview, { reason: '訂正' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuantitativeImportConflictError);
    expect((error as QuantitativeImportConflictError).conflicts[0]?.reason).toContain(
      '入力中 → 提出済み',
    );
    expect(fixture.dataPoints.find((dp) => dp.id === euScope2)?.value).not.toBe(999);
  });
});

describe('A06 混在単位・年度・組織不明・曖昧な数値・重複', () => {
  const text = csv(
    `scope2_location,${FY26},HQ,連結,5000,t-CO2e,,,,,,`,
    `waste,${FY26},EAST,連結,120000,kg,,,,,,`,
    `scope2_location,${FY26},NOWHERE,連結,10,t-CO2e,,,,,,`,
    `scope3_cat4,${FY26},HQ,連結,1.234,t-CO2e,,,,,,`,
    `scope3_cat2,${FY26},HQ,連結,100,t-CO2e,,,,,,`,
    `scope3_cat2,${FY26},HQ,連結,120,t-CO2e,,,,,,`,
    `energy,2026-04-01,2026-04-30,HQ,連結,500,MWh,,,,,,`,
    `scope9,${FY26},HQ,連結,1,t-CO2e,,,,,,`,
  );

  it('該当行に理由を付け、推定・合算をしない', async () => {
    const preview = await validate(text);
    expect(preview.counts).toEqual({ new: 1, changed: 0, unchanged: 0, error: 7 });

    expect(rowOf(preview, 3).errors.join(' ')).toContain('単位違い');
    expect(rowOf(preview, 4).errors.join(' ')).toContain('未知の組織');
    const ambiguous = rowOf(preview, 5);
    expect(ambiguous.errors.join(' ')).toContain('推定では確定しません');
    expect(ambiguous.valueRaw).toBe('1.234');
    expect(ambiguous.valueDisplay).toBe('—');
    expect(rowOf(preview, 6).errors.join(' ')).toContain('7 行目にもあります');
    expect(rowOf(preview, 7).errors.join(' ')).toContain('6 行目にもあります');
    expect(rowOf(preview, 8).errors.join(' ')).toContain('途中の期間');
    expect(rowOf(preview, 9).errors.join(' ')).toContain('指標定義にありません');
  });

  it('既定の確定はエラーが 1 行でもあれば止める。「正常行のみ登録」は除外行と件数を残す', async () => {
    const preview = await validate(text);
    const eastWaste = fixture.dataPoints.find(
      (dp) => dp.id === dataPointId('EAST', 'waste', 'FY2026'),
    )!;
    const eastWasteVersions = versionsOf(eastWaste.id).length;

    await expect(commit(preview)).rejects.toThrow(/エラーの行が 7 行/);
    expect(dpByKey('scope2_location', UNIT_IDS.hq)).toBeUndefined();

    const result = await commit(preview, { mode: 'valid_only' });
    expect(result.created).toBe(1);
    expect(result.excluded).toBe(7);
    expect(result.excludedRows.map((r) => r.rowNo)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(result.excludedRows.every((r) => r.reasons.length > 0)).toBe(true);

    const batch = fixture.quantitativeImportBatches.find((b) => b.id === preview.batchId)!;
    expect(batch.status).toBe('committed');
    expect(batch.excludedCount).toBe(7);
    expect(batch.rows.filter((r) => !r.included).map((r) => r.rowNo)).toEqual([
      3, 4, 5, 6, 7, 8, 9,
    ]);

    // 除外した行は台帳に入らない（重複は合算しない・単位違いは換算しない）
    expect(dpByKey('scope3_cat2', UNIT_IDS.hq)).toBeUndefined();
    expect(dpByKey('scope3_cat4', UNIT_IDS.hq)).toBeUndefined();
    expect(versionsOf(eastWaste.id)).toHaveLength(eastWasteVersions);
    expect(dpByKey('scope2_location', UNIT_IDS.hq)?.value).toBe(5000);
  });

  it('数値の書式を明示すれば、曖昧だった値を指定どおりに読む', async () => {
    const preview = await validate(csv(`scope3_cat4,${FY26},HQ,連結,1.234,t-CO2e,,,,,,`), {
      notation: 'comma_decimal',
    });
    const row = rowOf(preview, 2);
    expect(row.errors).toEqual([]);
    expect(row.valueRaw).toBe('1.234');
    expect(row.valueDisplay).toBe('1,234');
  });
});

describe('A07 空欄・未提出・0・対象外を区別する', () => {
  it('CSV の状態列・理由、保存値、画面表示がそれぞれ区別される', async () => {
    const preview = await validate(
      csv(
        `scope3_cat3,${FY26},HQ,連結,,t-CO2e,,,,,,`,
        `scope3_cat4,${FY26},HQ,連結,0,t-CO2e,,,,,,`,
        `scope3_cat5,${FY26},HQ,連結,,t-CO2e,,対象外,該当する活動なし（架空）,,,`,
        `scope3_cat6,${FY26},HQ,連結,,t-CO2e,,未提出,拠点から未着（架空）,,,`,
        `scope3_cat7,${FY26},HQ,連結,,t-CO2e,,not_calculated,,,,`,
      ),
    );
    expect(rowOf(preview, 2)).toMatchObject({
      availabilityStatus: 'not_entered',
      valueDisplay: '未入力',
      diffKind: 'new',
    });
    expect(rowOf(preview, 2).warnings.join(' ')).toContain('0 にも対象外にもしません');
    expect(rowOf(preview, 3)).toMatchObject({
      availabilityStatus: 'value_present',
      valueDisplay: '0',
    });
    expect(rowOf(preview, 4)).toMatchObject({
      availabilityStatus: 'not_applicable',
      valueDisplay: '対象外',
      absenceReason: '該当する活動なし（架空）',
    });
    expect(rowOf(preview, 5)).toMatchObject({
      availabilityStatus: 'not_obtained',
      valueDisplay: '未取得',
    });
    expect(rowOf(preview, 6).diffKind).toBe('error');
    expect(rowOf(preview, 6).errors.join(' ')).toContain('理由');

    await commit(preview, { mode: 'valid_only' });

    const blank = dpByKey('scope3_cat3', UNIT_IDS.hq)!;
    const zero = dpByKey('scope3_cat4', UNIT_IDS.hq)!;
    const na = dpByKey('scope3_cat5', UNIT_IDS.hq)!;
    const notObtained = dpByKey('scope3_cat6', UNIT_IDS.hq)!;
    expect([blank.value, blank.availabilityStatus, blank.absenceReason]).toEqual([
      null,
      'not_entered',
      null,
    ]);
    expect([zero.value, zero.availabilityStatus]).toEqual([0, 'value_present']);
    expect([na.value, na.availabilityStatus, na.absenceReason]).toEqual([
      null,
      'not_applicable',
      '該当する活動なし（架空）',
    ]);
    expect([notObtained.availabilityStatus, notObtained.absenceReason]).toEqual([
      'not_obtained',
      '拠点から未着（架空）',
    ]);
    // 版にも同じ区別が残る（開示本文は版を引用する）
    expect(versionsOf(zero.id)[0]).toMatchObject({ value: 0, availabilityStatus: 'value_present' });
    expect(versionsOf(na.id)[0]).toMatchObject({
      value: null,
      availabilityStatus: 'not_applicable',
      absenceReason: '該当する活動なし（架空）',
    });
    expect(dpByKey('scope3_cat7', UNIT_IDS.hq)).toBeUndefined();
  });

  it('既に値がある枠を空欄の行で消さない', async () => {
    const preview = await validate(csv(`scope1,${FY26},HQ,連結,,t-CO2e,,,,,,`));
    const row = rowOf(preview, 2);
    expect(row.diffKind).toBe('unchanged');
    expect(row.warnings.join(' ')).toContain('変更しません');
    const versionsBefore = versionsOf(HQ_SCOPE1).length;
    await commit(preview);
    expect(versionsOf(HQ_SCOPE1)).toHaveLength(versionsBefore);
    expect(hqScope1().availabilityStatus).toBe('value_present');
  });
});

describe('A11 推計は推計のまま', () => {
  it('推計の行は推計として保存し、区分が空欄の再取込でも実績へ変えない', async () => {
    const first = await validate(
      csv(`scope3_cat8,${FY26},HQ,連結,120,t-CO2e,estimate,,,前年値補完,,`),
    );
    await commit(first);
    const dp = dpByKey('scope3_cat8', UNIT_IDS.hq)!;
    expect(dp.valueKind).toBe('estimate');
    expect(dp.status).toBe('draft');
    expect(versionsOf(dp.id)[0]?.valueKind).toBe('estimate');

    const same = await validate(csv(`scope3_cat8,${FY26},HQ,連結,120,t-CO2e,,,,,,`));
    expect(rowOf(same, 2)).toMatchObject({ diffKind: 'unchanged', valueKind: 'estimate' });
    expect(rowOf(same, 2).warnings.join(' ')).toContain('既存の「推計」を引き継ぎます');

    const revised = await validate(csv(`scope3_cat8,${FY26},HQ,連結,130,t-CO2e,,,,,,`));
    expect(rowOf(revised, 2)).toMatchObject({ diffKind: 'changed', valueKind: 'estimate' });
    await commit(revised, { reason: '推計方法の見直し（架空）' });
    expect(dpByKey('scope3_cat8', UNIT_IDS.hq)?.valueKind).toBe('estimate');
  });
});

describe('確定の冪等性と検証結果の扱い（A03 再試行 / A35）', () => {
  it('同じ確定キーの再送は、書き込まずに最初の結果を返す', async () => {
    const preview = await validate(csv(`scope1,${FY26},HQ,連結,1201.3,t-CO2e,,,,,,`));
    const key = randomUUID();
    const first = await commit(preview, { key, reason: '訂正（架空）' });
    const versionsAfterFirst = versionsOf(HQ_SCOPE1).length;

    const retry = await commit(preview, { key, reason: '訂正（架空）' });
    expect(retry.replayed).toBe(true);
    expect(retry.updated).toBe(first.updated);
    expect(retry.writtenRows).toEqual(first.writtenRows);
    expect(versionsOf(HQ_SCOPE1)).toHaveLength(versionsAfterFirst);

    // 別のキーで確定済みの取込をもう一度確定しようとしても書かない
    await expect(commit(preview, { reason: '訂正（架空）' })).rejects.toThrow(/確定済み/);
    expect(versionsOf(HQ_SCOPE1)).toHaveLength(versionsAfterFirst);
  });

  it('二重押下で同時に届いた確定も、1 回分しか書かない', async () => {
    const preview = await validate(csv(`scope1,${FY26},HQ,連結,1201.3,t-CO2e,,,,,,`));
    const key = randomUUID();
    const before = versionsOf(HQ_SCOPE1).length;
    const [a, b] = await Promise.all([
      commit(preview, { key, reason: '訂正（架空）' }),
      commit(preview, { key, reason: '訂正（架空）' }),
    ]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(versionsOf(HQ_SCOPE1)).toHaveLength(before + 1);
  });

  it('検証結果が見つからなければ「有効期限切れ」として再検証を促す', async () => {
    const error = await commitQuantitativeImport(db, manager(), {
      batchId: randomUUID(),
      previewHash: 'x',
      idempotencyKey: randomUUID(),
      mode: 'all',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuantitativeImportExpiredError);
    expect((error as Error).message).toBe(QUANTITATIVE_IMPORT_EXPIRED_MESSAGE);
  });

  it('画面から送られた差分がサーバーの検証結果と違えば確定しない（改ざん・古い画面）', async () => {
    const preview = await validate(csv(`scope2_location,${FY26},HQ,連結,5000,t-CO2e,,,,,,`));
    await expect(commit({ ...preview, previewHash: 'tampered' })).rejects.toThrow(
      /検証結果が変わっています/,
    );

    // 保存した行そのものが書き換えられた場合も止める
    const stored = fixture.quantitativeImportBatches.find((b) => b.id === preview.batchId)!;
    stored.rows = stored.rows.map((r) => ({ ...r, value: 999999 }));
    await expect(commit(preview)).rejects.toThrow(/検証結果が変わっています/);
    expect(dpByKey('scope2_location', UNIT_IDS.hq)).toBeUndefined();
  });

  it('検証した本人以外は確定できない', async () => {
    const preview = await validate(csv(`scope2_location,${FY26},HQ,連結,5000,t-CO2e,,,,,,`));
    await expect(commit(preview, { ctx: admin() })).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('書き込みの途中で失敗したら書き終えた行を示し、同じ確定で続きから再開する（二重に書かない）', async () => {
    const preview = await validate(
      csv(
        `scope3_cat9,${FY26},HQ,連結,10,t-CO2e,,,,,,`,
        `scope3_cat10,${FY26},HQ,連結,20,t-CO2e,,,,,,`,
        `scope3_cat11,${FY26},HQ,連結,30,t-CO2e,,,,,,`,
      ),
    );
    const key = randomUUID();
    const failing = new FailingDb(
      db,
      (table, count) => table === 'dataPointVersions' && count === 2,
    );
    // 内部の失敗はサーバーのログへ出す（画面には SQL などの内部情報を出さない）
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const error = await commit(preview, { key, client: failing }).catch((e: unknown) => e);
    expect(logged).toHaveBeenCalled();
    expect((error as Error).message).not.toContain('simulated failure');
    expect(error).toBeInstanceOf(QuantitativeImportPartialError);
    expect((error as QuantitativeImportPartialError).writtenRowNos).toEqual([2]);
    expect((error as QuantitativeImportPartialError).failedRowNo).toBe(3);
    expect((error as Error).message).toContain('保存失敗');

    // 失敗した行は親だけが作られ、版が無い。再試行では競合として止まる（黙って二重に作らない）
    const cat9 = dpByKey('scope3_cat9', UNIT_IDS.hq)!;
    expect(versionsOf(cat9.id)).toHaveLength(1);
    const half = dpByKey('scope3_cat10', UNIT_IDS.hq)!;
    expect(half.currentVersionId).toBeNull();
    await expect(commit(preview, { key })).rejects.toBeInstanceOf(QuantitativeImportConflictError);
    expect(versionsOf(cat9.id)).toHaveLength(1);
  });

  it('失敗が行と行の間で起きた場合は、書き終えた行を飛ばして最後まで確定できる', async () => {
    const preview = await validate(
      csv(
        `scope3_cat9,${FY26},HQ,連結,10,t-CO2e,,,,,,`,
        `scope3_cat10,${FY26},HQ,連結,20,t-CO2e,,,,,,`,
      ),
    );
    const key = randomUUID();
    // 2 行目を書き終えた直後（3 行目の親を作る前）に失敗させる
    const failing = new FailingDb(db, (table, count) => table === 'dataPoints' && count === 2);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(commit(preview, { key, client: failing })).rejects.toBeInstanceOf(
      QuantitativeImportPartialError,
    );

    const resumed = await commit(preview, { key });
    expect(resumed.created).toBe(2);
    expect(versionsOf(dpByKey('scope3_cat9', UNIT_IDS.hq)!.id)).toHaveLength(1);
    expect(versionsOf(dpByKey('scope3_cat10', UNIT_IDS.hq)!.id)).toHaveLength(1);
  });
});

describe('権限・担当範囲', () => {
  it('取込権限の無い利用者は検証できない', async () => {
    await expect(
      validate(csv(`scope1,${FY26},HQ,連結,1,t-CO2e,,,,,,`), { ctx: viewer() }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('拠点担当は担当外の組織を登録できず、承認済みの値も変えられない（行ごとの理由）', async () => {
    const preview = await validate(
      csv(`energy,${FY26},WEST,連結,100,MWh,,,,,,`, `scope1,${FY26},EAST,連結,99999,t-CO2e,,,,,,`),
      { ctx: siteUser() },
    );
    expect(rowOf(preview, 2).errors.join(' ')).toContain('担当外');
    expect(rowOf(preview, 3).errors.join(' ')).toContain('レビュー権限');
  });

  it('別テナントの取込バッチは確定できない（存在も明かさない）', async () => {
    const preview = await validate(csv(`scope2_location,${FY26},HQ,連結,5000,t-CO2e,,,,,,`));
    const other: AuthorizationContext = {
      ...ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin']),
      workspace: {
        organizationId: ORG_IDS.soten,
        organizationType: 'enterprise',
        organizationName: '蒼天マテリアル',
        roleKeys: ['enterprise_admin'],
        unitScopeIds: [],
      },
    };
    await expect(commit(preview, { ctx: other })).rejects.toBeInstanceOf(
      QuantitativeImportExpiredError,
    );
    expect(await listQuantitativeImportBatches(db, other)).toEqual([]);
  });
});

describe('手入力・既存テンプレート・数式に見えるセル', () => {
  it('手入力の 1 行も同じ検証 → 確定を通り、出所は「手入力」になる', async () => {
    const preview = await validateQuantitativeImport(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      source: {
        kind: 'manual',
        entry: {
          metricCode: 'scope3_cat12',
          entityCode: 'HQ',
          reportingPeriodId: PERIOD_IDS.fy2026,
          value: '４２．５',
          unit: 't-CO2e',
          valueKind: 'actual',
          sourceReference: '廃棄物処理委託契約（架空）',
        },
      },
    });
    expect(preview.sourceKind).toBe('manual');
    expect(rowOf(preview, 1)).toMatchObject({ diffKind: 'new', valueDisplay: '42.5' });
    await commit(preview);
    const dp = dpByKey('scope3_cat12', UNIT_IDS.hq)!;
    expect(dp.value).toBe(42.5);
    expect(versionsOf(dp.id)[0]).toMatchObject({ sourceType: 'manual' });
  });

  it('既存テンプレート（拠点・項目・値・単位・期間）は候補として対応付けて検証する', async () => {
    const preview = await validate(
      '拠点,項目,値,単位,期間\r\n本社,Scope2 排出量（ロケーション基準）,4800,t-CO2e,FY2026\r\n',
    );
    expect(preview.format).toBe('legacy_template');
    expect(preview.mapping.every((m) => m.candidate)).toBe(true);
    const row = rowOf(preview, 2);
    expect(row).toMatchObject({ diffKind: 'new', metricCode: 'scope2_location', entityCode: 'HQ' });
    expect(row.warnings.join(' ')).toContain('候補');
  });

  it('数式に見えるセルは計算せず、文字のまま保存する', async () => {
    const formula = '=HYPERLINK("http://example.invalid","x")';
    const preview = await validate(
      csv(
        `scope3_cat13,${FY26},HQ,連結,=1+2,t-CO2e,,,,,,`,
        `scope3_cat14,${FY26},HQ,連結,10,t-CO2e,,,,,,"${formula.replace(/"/g, '""')}"`,
      ),
    );
    expect(rowOf(preview, 2).diffKind).toBe('error');
    expect(rowOf(preview, 2).errors.join(' ')).toContain('数式');
    expect(rowOf(preview, 3).sourceReference).toBe(formula);
    expect(rowOf(preview, 3).warnings.join(' ')).toContain('数式');

    await commit(preview, { mode: 'valid_only' });
    expect(dpByKey('scope3_cat13', UNIT_IDS.hq)).toBeUndefined();
    const dp = dpByKey('scope3_cat14', UNIT_IDS.hq)!;
    expect(versionsOf(dp.id)[0]?.sourceReference).toContain(formula);
  });

  it('配布するテンプレート（public/templates/standard-metrics.csv）はそのまま検証を通る', async () => {
    const bytes = new Uint8Array(
      readFileSync(join(process.cwd(), 'public', 'templates', 'standard-metrics.csv')),
    );
    const preview = await validateQuantitativeImport(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      source: { kind: 'file', fileName: 'standard-metrics.csv', bytes },
    });
    expect(preview.encoding).toBe('UTF-8 (BOM)');
    expect(preview.format).toBe('standard');
    expect(preview.counts).toEqual({ new: 5, changed: 0, unchanged: 0, error: 0 });
    expect(preview.rows.map((r) => r.availabilityStatus)).toEqual([
      'value_present',
      'value_present',
      'not_calculated',
      'not_applicable',
      'value_present',
    ]);
    expect(preview.rows.map((r) => r.valueKind)).toEqual([
      'actual',
      'estimate',
      'actual',
      'actual',
      'actual',
    ]);
  });

  it('確認用サンプル（エラーを含む）は、単位違い・重複・曖昧な数値・未知の組織・年度途中の期間を行ごとに示す', async () => {
    const bytes = new Uint8Array(
      readFileSync(
        join(process.cwd(), 'public', 'templates', 'standard-metrics-sample-with-errors.csv'),
      ),
    );
    const preview = await validateQuantitativeImport(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      source: { kind: 'file', fileName: 'sample.csv', bytes },
    });
    expect(preview.counts).toEqual({ new: 4, changed: 0, unchanged: 0, error: 6 });
    expect(preview.rows.filter((r) => r.diffKind === 'error').map((r) => r.rowNo)).toEqual([
      3, 4, 6, 9, 10, 11,
    ]);
    // 別年度の行は登録できるが、期間が違うことを示す
    expect(rowOf(preview, 5).warnings.join(' ')).toContain('異なる期間');
    // 0 と未提出は区別したまま新規になる
    expect(rowOf(preview, 7)).toMatchObject({ diffKind: 'new', valueDisplay: '0' });
    expect(rowOf(preview, 8)).toMatchObject({
      diffKind: 'new',
      availabilityStatus: 'not_obtained',
    });
  });

  it('取込の履歴に件数と除外行数が残る', async () => {
    const preview = await validate(
      csv(
        `scope2_location,${FY26},HQ,連結,5000,t-CO2e,,,,,,`,
        `scope9,${FY26},HQ,連結,1,t-CO2e,,,,,,`,
      ),
    );
    await commit(preview, { mode: 'valid_only' });
    const [latest] = await listQuantitativeImportBatches(db, manager());
    expect(latest).toMatchObject({
      id: preview.batchId,
      status: 'committed',
      excludedCount: 1,
      counts: { new: 1, changed: 0, unchanged: 0, error: 1 },
    });
  });

  it('確定の監査ログ（import_committed）を残す', async () => {
    const preview = await validate(csv(`scope2_location,${FY26},HQ,連結,5000,t-CO2e,,,,,,`));
    await commit(preview);
    const event = fixture.auditEvents.find(
      (e) => e.eventType === 'import_committed' && e.resourceId === preview.batchId,
    );
    expect(event?.afterSummary).toContain('新規 1 件');
  });
});

/** 指定した回数目の書き込みで失敗させる DbClient（保存失敗・途中失敗の再現用） */
class FailingDb implements DbClient {
  readonly mode = 'demo' as const;
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly inner: DbClient,
    private readonly shouldFail: (table: TableName, count: number) => boolean,
  ) {}

  select<K extends TableName>(table: K, query?: Query<Row<K>>): Promise<Row<K>[]> {
    return this.inner.select(table, query);
  }
  count<K extends TableName>(table: K, query?: Pick<Query<Row<K>>, 'where' | 'orWhere'>) {
    return this.inner.count(table, query);
  }
  findById<K extends TableName>(table: K, id: Uuid): Promise<Row<K> | null> {
    return this.inner.findById(table, id);
  }
  async insert<K extends TableName>(table: K, rows: Row<K>[]): Promise<Row<K>[]> {
    const next = (this.counts.get(table) ?? 0) + 1;
    this.counts.set(table, next);
    if (this.shouldFail(table, next)) throw new Error(`simulated failure on ${table}`);
    return this.inner.insert(table, rows);
  }
  update<K extends TableName>(table: K, id: Uuid, patch: Partial<Row<K>>): Promise<Row<K>> {
    return this.inner.update(table, id, patch);
  }
  softDelete<K extends TableName>(table: K, id: Uuid, at: string): Promise<void> {
    return this.inner.softDelete(table, id, at);
  }
}

// ValidationError を import しているのは、競合・途中失敗が利用者向けのエラーとして
// 画面へ届くこと（内部エラーとして伏せられないこと）を型で確かめるため
describe('利用者向けエラーの型', () => {
  it('競合と途中失敗は ValidationError（画面にそのまま出せる）', () => {
    expect(new QuantitativeImportConflictError([])).toBeInstanceOf(ValidationError);
    expect(new QuantitativeImportPartialError([], 2)).toBeInstanceOf(ValidationError);
  });
});
