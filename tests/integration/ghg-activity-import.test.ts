import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { selectCalculationInputs } from '@/lib/domain/ghg/select-inputs';
import { ValidationError } from '@/lib/errors/user-facing';
import { toCsv, toXlsx } from '@/lib/exports';
import { ORG_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { buildGhgDemoFile } from '@/lib/fixtures/ghg-demo-files';
import {
  GHG_FIXTURE_IDS,
  GHG_VERIFICATION_UNIT_IDS,
  ghgBatchId,
} from '@/lib/fixtures/ghg-verification';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { compactRow } from '@/lib/repositories/demo-compact';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  applyDemoEdits,
  decodeDemoEdits,
  encodeDemoEditStream,
  type DemoEdit,
} from '@/lib/repositories/demo-edit-codec';
import { DEMO_GHG_LIMITS } from '@/lib/repositories/demo-ghg-checks';
import {
  activityBatchWriteReason,
  activityImportPermissionReason,
  confirmActivityImport,
  createActivityBatch,
  discardActivityBatch,
  loadActivityBatch,
  loadActivityCoverage,
  previewActivityImport,
  type ActivityImportRequest,
} from '@/lib/services/ghg/activity-import';
import { loadGhgSource } from '@/lib/services/ghg/inputs';
import type { AuthorizationContext, GhgBatchKind, RoleKey, Uuid } from '@/types/domain';
import { WriteDetectingDbClient } from '../support/write-detecting-db';

/**
 * 活動量の取込（plan §2.3 activity-import.ts・CR-05・int:ghg-activity-import）。
 *  - 検証は書き込み 0。取込は検証したファイル（sha256）だけを、確認中のバッチとして書く
 *  - 取込は enterprise.import.run ＋ enterprise.data.write の担当拠点だけ（他拠点に書けない）
 *  - 読めない行・期間外の月・単位の取り違えは推測で埋めずに止める
 *  - 確定で算定の入力になり、確定後は不変。差し替えは新しいバッチで元を差し替え済みにする
 *  - Demo Mode の上限（2 回・60 行）と、Cookie から戻したときに同じ状態になること
 */

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  unitScopeIds: Uuid[] = [],
  organizationId: Uuid = ORG_IDS.aomi,
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType: 'enterprise',
      organizationName: 'テスト',
      roleKeys,
      unitScopeIds,
    },
    engagementIds: [],
    demo: true,
  };
}

const author = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const site = () => ctxFor('site-user@demo.local', ['site_contributor'], [UNIT_IDS.east]);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const other = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], [], ORG_IDS.soten);

const CY = GHG_FIXTURE_IDS.period;
const US1 = GHG_FIXTURE_IDS.units.us;
const TH1 = GHG_FIXTURE_IDS.units.th;

const csvFile = (name: string, text: string) => ({
  name,
  type: 'text/csv',
  bytes: new TextEncoder().encode(text),
});

function sampleTransport() {
  const file = buildGhgDemoFile('transport', createFixtureDb());
  return csvFile(file.fileName, toCsv(file.sheet));
}

async function sampleEnergy() {
  const file = buildGhgDemoFile('energy', createFixtureDb());
  return {
    name: file.fileName,
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes: await toXlsx([file.sheet], 'エネルギー'),
  };
}

function request(
  file: ActivityImportRequest['file'],
  over: Partial<ActivityImportRequest> = {},
): ActivityImportRequest {
  return {
    periodId: CY,
    unitId: UNIT_IDS.east,
    kind: 'transport' as GhgBatchKind,
    replaceBatchId: null,
    file,
    mapping: null,
    decimalSeparator: null,
    ...over,
  };
}

const TRANSPORT_HEADER =
  '月,出荷番号,輸送の区分,燃料,輸送重量(t),輸送距離(km),最大積載量(kg),積載率(%),用途,燃費の区分,貨物,備考';

describe('previewActivityImport（検証）', () => {
  it('輸送実績のサンプル: 書き込み 0・列は自動で対応・見なし積載率 1・下限 1・範囲外 1 の件数を返す', async () => {
    const guard = new WriteDetectingDbClient(db);
    const preview = await previewActivityImport(guard, author(), request(sampleTransport()));
    expect(guard.writes).toEqual([]);
    expect(fixture.auditEvents.filter((e) => e.resourceType === 'ghg_activity_batch')).toEqual([]);
    expect(preview).toMatchObject({
      canImport: true,
      blockers: [],
      mappingSuggested: true,
      mappingProblems: [],
      rowCount: 6,
      validCount: 6,
      errorCount: 0,
      overlaps: 0,
      replace: null,
      minLoadPct: 10,
      policyMissing: false,
    });
    expect(preview.file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.counts).toMatchObject({
      lines: 6,
      calculated: 6,
      errors: 0,
      defaultLoad: 1,
      floored: 1,
      payloadOutOfRange: 1,
      overseas: 0,
    });
    expect(preview.months).toEqual(['2025-12-01']);
    const floored = preview.rows.find((r) => r.transport?.loadFactorPct === 5)!;
    expect(floored.loadFactorSource).toBe('floored');
    expect(floored.warnings).toContain('積載率の下限を適用');
    const byDefault = preview.rows.find((r) => r.transport?.loadFactorPct === null)!;
    expect(byDefault.loadFactorSource).toBe('default');
    expect(byDefault.warnings).toContain('見なし積載率（原単位表）');
    expect(preview.rows.every((r) => r.trialT !== null && r.trialT > 0)).toBe(true);
  });

  it('海外拠点に輸送を取り込むときは、行に海外拠点の印が付く（組織の設定が「警告」）', async () => {
    const preview = await previewActivityImport(
      db,
      author(),
      request(sampleTransport(), { unitId: TH1 }),
    );
    expect(preview.unit).toMatchObject({ code: 'TH1', countryCode: 'TH', overseas: true });
    expect(preview.counts.overseas).toBe(6);
    expect(preview.rows[0]!.warnings).toContain('海外拠点の輸送（国内の方法を適用）');
  });

  it('読めない行（燃料・燃費の区分）と期間外の月は取り込まない（推測で埋めない）', async () => {
    const text = [
      TRANSPORT_HEADER,
      '2025-03,X-1,委託物流,軽油,2.2,180,4000,55,事業用,未確認,主要製品,',
      '2025-03,X-2,委託物流,水素,2.2,180,4000,55,事業用,未確認,主要製品,',
      '2024-12,X-3,委託物流,軽油,2.2,180,4000,55,事業用,未確認,主要製品,',
      '2025-04,X-4,委託物流,軽油,2.2,180,4000,55,事業用,ふつう,主要製品,',
    ].join('\n');
    const preview = await previewActivityImport(db, author(), request(csvFile('t.csv', text)));
    expect(preview.canImport).toBe(false);
    expect(preview.validCount).toBe(1);
    expect(preview.errorCount).toBe(3);
    expect(preview.blockers).toContain(
      '読めない行が 3 行あります。ファイルを直してから検証し直してください（推測で埋めずに止めています）。',
    );
    const errors = preview.rows.filter((r) => r.error).map((r) => [r.rowNo, r.error]);
    expect(errors).toEqual([
      [3, '燃料「水素」を読めません'],
      [4, expect.stringContaining('月 2024-12 は期間「')],
      [5, '燃費区分「ふつう」を読めません'],
    ]);
    await expect(
      createActivityBatch(db, author(), {
        ...request(csvFile('t.csv', text)),
        expectedSha256: preview.file.sha256,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fixture.ghgActivityBatches.filter((b) => b.source === 'upload')).toEqual([]);
  });

  it('「3.741」のような曖昧な数は小数点の記号を選ぶまで読まない', async () => {
    const text = [
      TRANSPORT_HEADER,
      '2025-03,X-1,委託物流,軽油,3.741,180,8000,46.8,事業用,未確認,,',
    ].join('\n');
    const ambiguous = await previewActivityImport(db, author(), request(csvFile('t.csv', text)));
    expect(ambiguous.canImport).toBe(false);
    expect(ambiguous.rows[0]!.error).toContain('小数点の記号を選ぶと読める場合があります');
    const dot = await previewActivityImport(
      db,
      author(),
      request(csvFile('t.csv', text), { decimalSeparator: 'dot' }),
    );
    expect(dot.canImport).toBe(true);
    expect(dot.rows[0]!.transport).toMatchObject({ cargoWeightT: 3.741, loadFactorPct: 46.8 });
  });

  it('列の対応の問題（単位の取り違え）は取り込まない。対応を直せば検証を通る', async () => {
    const text = [
      '月,区分,燃料,重量(kg),距離,最大積載量(kg),積載率(%),燃費の区分',
      '2025-03,委託,軽油,2200,180,4000,55,未確認',
    ].join('\n');
    const preview = await previewActivityImport(db, author(), request(csvFile('t.csv', text)));
    expect(preview.canImport).toBe(false);
    expect(preview.mappingProblems).toContain(
      '輸送重量の列「重量(kg)」は kg のようです。輸送重量は t（トン）で入れてください。',
    );
    expect(preview.blockers).toContain('列の対応を直してください。');
    const fixed = await previewActivityImport(
      db,
      author(),
      request(csvFile('t.csv', text), {
        mapping: {
          month: '月',
          carrierKind: '区分',
          fuel: '燃料',
          tonKm: '距離',
          maxPayloadKg: '最大積載量(kg)',
          loadFactorPct: '積載率(%)',
          fuelEconomyClass: '燃費の区分',
        },
      }),
    );
    expect(fixed.mappingProblems).toEqual([]);
    expect(fixed.mappingSuggested).toBe(false);
    expect(fixed.canImport).toBe(true);
  });

  it('表でないファイル・空のファイルは止める', async () => {
    const pdf = await previewActivityImport(
      db,
      author(),
      request({ name: 'a.pdf', type: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) }),
    );
    expect(pdf.canImport).toBe(false);
    expect(pdf.blockers[0]).toContain('表のファイル');
    const empty = await previewActivityImport(db, author(), request(csvFile('a.csv', '')));
    expect(empty.blockers).toContain('ファイルが空です。');
  });

  it('取込の権限（取込とデータ入力）が無い役割・担当外の拠点・他の組織は断る', async () => {
    await expect(
      previewActivityImport(db, reviewer(), request(sampleTransport())),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(activityImportPermissionReason(reviewer())).toContain('権限が必要です');
    expect(activityImportPermissionReason(site())).toBeNull();
    await expect(
      previewActivityImport(db, site(), request(sampleTransport(), { unitId: TH1 })),
    ).rejects.toBeInstanceOf(AuthorizationError);
    const own = await previewActivityImport(db, site(), request(sampleTransport()));
    expect(own.canImport).toBe(true);
    await expect(
      previewActivityImport(db, other(), request(sampleTransport())),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('締めた期間には取り込まない', async () => {
    fixture.periods.find((p) => p.id === CY)!.status = 'closed';
    await expect(previewActivityImport(db, author(), request(sampleTransport()))).rejects.toThrow(
      '締めています',
    );
  });
});

describe('createActivityBatch（取込）', () => {
  it('検証したファイルを確認中のバッチとして書く（sha256・行・監査ログ data_created）。算定には使わない', async () => {
    const file = sampleTransport();
    const preview = await previewActivityImport(db, author(), request(file));
    const batch = await createActivityBatch(db, author(), {
      ...request(file),
      expectedSha256: preview.file.sha256,
    });
    expect(batch).toMatchObject({
      status: 'draft',
      source: 'upload',
      kind: 'transport',
      unitId: UNIT_IDS.east,
      reportingPeriodId: CY,
      rowCount: 6,
      fileSha256: preview.file.sha256,
      supersedesBatchId: null,
      createdBy: userId('sustainability@demo.local'),
    });
    const lines = fixture.ghgActivityLines.filter((l) => l.batchId === batch.id);
    expect(lines.map((l) => l.lineNo)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(lines[0]).toMatchObject({
      activityKind: 'transport',
      activityCode: 'contracted',
      carrierKind: 'contracted',
      fuelCode: 'diesel',
      cargoKind: 'main_product',
      vehicleUse: 'commercial',
      attributes: { sourceRowNo: 2 },
    });
    const audit = fixture.auditEvents.find((e) => e.resourceId === batch.id)!;
    expect(audit).toMatchObject({ eventType: 'data_created', resourceType: 'ghg_activity_batch' });
    const source = await loadGhgSource(db, author(), CY);
    const inputs = selectCalculationInputs(source, [...GHG_VERIFICATION_UNIT_IDS])!;
    expect(inputs.batches.map((b) => b.id)).not.toContain(batch.id);
  });

  it('検証したファイルと違う（sha256 が違う）なら書かない', async () => {
    const preview = await previewActivityImport(db, author(), request(sampleTransport()));
    const changed = csvFile(
      'x.csv',
      [TRANSPORT_HEADER, '2025-03,X-1,委託物流,軽油,2.2,180,4000,55,事業用,未確認,,'].join('\n'),
    );
    await expect(
      createActivityBatch(db, author(), {
        ...request(changed),
        expectedSha256: preview.file.sha256,
      }),
    ).rejects.toThrow('検証したファイルと違うファイル');
    expect(fixture.ghgActivityBatches.filter((b) => b.source === 'upload')).toEqual([]);
  });

  it('Demo Mode の上限: 1 回 60 行まで・取込は 2 回まで（3 回目は検証で知らせ、取込で断る）', async () => {
    const many = [
      TRANSPORT_HEADER,
      ...Array.from(
        { length: DEMO_GHG_LIMITS.linesPerBatch + 1 },
        (_, i) => `2025-03,M-${i},委託物流,軽油,2.2,180,4000,55,事業用,未確認,,`,
      ),
    ].join('\n');
    const tooMany = await previewActivityImport(db, author(), request(csvFile('m.csv', many)));
    expect(tooMany.blockers).toContain(
      `デモでは 1 回の取込は ${DEMO_GHG_LIMITS.linesPerBatch} 行までです（このファイルは ${DEMO_GHG_LIMITS.linesPerBatch + 1} 行）。`,
    );
    for (let i = 0; i < DEMO_GHG_LIMITS.userBatches; i += 1) {
      const file = sampleTransport();
      const p = await previewActivityImport(db, author(), request(file));
      await createActivityBatch(db, author(), { ...request(file), expectedSha256: p.file.sha256 });
    }
    const file = sampleTransport();
    const third = await previewActivityImport(db, author(), request(file));
    expect(third.canImport).toBe(false);
    expect(third.blockers.join('')).toContain(
      `デモでは活動量の取込は ${DEMO_GHG_LIMITS.userBatches} 回まで`,
    );
    await expect(
      createActivityBatch(db, author(), { ...request(file), expectedSha256: third.file.sha256 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('confirmActivityImport・discardActivityBatch', () => {
  async function importTransport(ctx = author(), unitId: Uuid = UNIT_IDS.east) {
    const file = sampleTransport();
    const p = await previewActivityImport(db, ctx, request(file, { unitId }));
    return createActivityBatch(db, ctx, {
      ...request(file, { unitId }),
      expectedSha256: p.file.sha256,
    });
  }

  it('確定で算定の入力になる（本人の名義・監査ログ import_committed）。確定後は確定・破棄できない', async () => {
    const batch = await importTransport();
    expect(activityBatchWriteReason(author(), batch)).toBeNull();
    const { batch: confirmed, superseded } = await confirmActivityImport(db, author(), batch.id);
    expect(superseded).toBeNull();
    expect(confirmed).toMatchObject({
      status: 'confirmed',
      confirmedBy: userId('sustainability@demo.local'),
    });
    expect(confirmed.confirmedAt).not.toBeNull();
    const audit = fixture.auditEvents.find(
      (e) => e.resourceId === batch.id && e.eventType === 'import_committed',
    );
    expect(audit).toBeDefined();
    const source = await loadGhgSource(db, author(), CY);
    const inputs = selectCalculationInputs(source, [...GHG_VERIFICATION_UNIT_IDS])!;
    expect(inputs.batches.map((b) => b.id)).toContain(batch.id);
    // 追加なので元の確定済みのバッチも残る（両方が算定に入る）
    expect(inputs.batches.map((b) => b.id)).toContain(ghgBatchId('EAST', 'transport'));

    await expect(confirmActivityImport(db, author(), batch.id)).rejects.toThrow(
      '確認中のバッチだけを確定できます',
    );
    await expect(discardActivityBatch(db, author(), batch.id)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(activityBatchWriteReason(author(), confirmed)).toBe(
      '確認中のバッチだけを確定・破棄できます。',
    );
  });

  it('差し替える元が既に差し替え済み・行が欠けた取込は、詳細で確定の押せない理由を示す（確定の検査と同じ文。UX-03）', async () => {
    const original = ghgBatchId('EAST', 'transport');
    const file = sampleTransport();
    const p = await previewActivityImport(
      db,
      author(),
      request(file, { replaceBatchId: original }),
    );
    const draftA = await createActivityBatch(db, author(), {
      ...request(file, { replaceBatchId: original }),
      expectedSha256: p.file.sha256,
    });
    const draftB = await createActivityBatch(db, author(), {
      ...request(file, { replaceBatchId: original }),
      expectedSha256: p.file.sha256,
    });
    expect((await loadActivityBatch(db, author(), draftA.id)).confirmBlockedReason).toBeNull();
    // 先に B を確定すると、元のバッチは差し替え済みになり A は確定できない
    await confirmActivityImport(db, author(), draftB.id);
    const blocked = (await loadActivityBatch(db, author(), draftA.id)).confirmBlockedReason;
    expect(blocked).toContain('既に差し替え済み');
    await expect(confirmActivityImport(db, author(), draftA.id)).rejects.toThrow(blocked!);

    // 行が欠けた（Demo のサーバーの切り替えで行が戻らなかった）取込（デモの取込の上限のため別の Fixture で）
    fixture = createFixtureDb();
    db = new DemoDbClient(fixture);
    const draftC = await importTransport();
    fixture.ghgActivityLines.splice(
      fixture.ghgActivityLines.findIndex((l) => l.batchId === draftC.id),
      1,
    );
    const missing = (await loadActivityBatch(db, author(), draftC.id)).confirmBlockedReason;
    expect(missing).toContain('行の数が取込の記録と合いません');
    await expect(confirmActivityImport(db, author(), draftC.id)).rejects.toThrow(missing!);
  });

  it('担当外の拠点・データ入力の権限の無い役割は確定・破棄できない', async () => {
    const batch = await importTransport(author(), TH1);
    await expect(confirmActivityImport(db, site(), batch.id)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(discardActivityBatch(db, reviewer(), batch.id)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    expect(activityBatchWriteReason(site(), batch)).toBe(
      '担当外の拠点の活動量は確定・破棄できません。',
    );
    await expect(confirmActivityImport(db, other(), batch.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('拠点担当は自分の拠点の取込を確定できる', async () => {
    const batch = await importTransport(site());
    const { batch: confirmed } = await confirmActivityImport(db, site(), batch.id);
    expect(confirmed.confirmedBy).toBe(userId('site-user@demo.local'));
  });

  it('破棄は確認中だけ（行は残し、算定にも充足にも使わない。監査ログ data_updated）', async () => {
    const batch = await importTransport();
    const discarded = await discardActivityBatch(db, author(), batch.id);
    expect(discarded.status).toBe('discarded');
    expect(fixture.ghgActivityLines.filter((l) => l.batchId === batch.id)).toHaveLength(6);
    expect(
      fixture.auditEvents.find((e) => e.resourceId === batch.id && e.eventType === 'data_updated'),
    ).toBeDefined();
    await expect(confirmActivityImport(db, author(), batch.id)).rejects.toBeInstanceOf(
      ValidationError,
    );
    const coverage = await loadActivityCoverage(db, author(), {
      periodId: CY,
      unitIds: [...GHG_VERIFICATION_UNIT_IDS],
    });
    expect(coverage.counts.draftBatches).toBe(0);
  });

  it('行の数が取込の記録と合わないバッチは確定しない（デモで行が失われたときなど）', async () => {
    const batch = await importTransport();
    const index = fixture.ghgActivityLines.findIndex((l) => l.batchId === batch.id);
    fixture.ghgActivityLines.splice(index, 1);
    await expect(confirmActivityImport(db, author(), batch.id)).rejects.toThrow(
      '行の数が取込の記録と合いません',
    );
  });
});

describe('差し替え（supersedes_batch_id）', () => {
  const US1_ENERGY = ghgBatchId('US1', 'energy');

  it('追加なら確定済みの同じ月・活動の行の数を知らせる（両方が算定に入る）', async () => {
    const preview = await previewActivityImport(
      db,
      author(),
      request(await sampleEnergy(), { unitId: US1, kind: 'energy' }),
    );
    expect(preview.canImport).toBe(true);
    expect(preview.rowCount).toBe(3);
    expect(preview.overlaps).toBe(3);
    expect(preview.months).toEqual(['2025-07-01']);
  });

  it('差し替えはファイルに無い月を知らせ、確定で元のバッチを差し替え済みにする', async () => {
    const file = await sampleEnergy();
    const req = request(file, { unitId: US1, kind: 'energy', replaceBatchId: US1_ENERGY });
    const preview = await previewActivityImport(db, author(), req);
    const original = fixture.ghgActivityLines.filter((l) => l.batchId === US1_ENERGY);
    expect(preview.replace).toMatchObject({
      batchId: US1_ENERGY,
      rowCount: original.length,
      droppedLines: original.length - 3,
    });
    expect(preview.replace!.droppedMonths).toHaveLength(11);
    expect(preview.overlaps).toBe(0);
    const batch = await createActivityBatch(db, author(), {
      ...req,
      expectedSha256: preview.file.sha256,
    });
    expect(batch.supersedesBatchId).toBe(US1_ENERGY);
    const { superseded } = await confirmActivityImport(db, author(), batch.id);
    expect(superseded?.status).toBe('superseded');
    expect(fixture.ghgActivityBatches.find((b) => b.id === US1_ENERGY)!.status).toBe('superseded');

    const coverage = await loadActivityCoverage(db, author(), {
      periodId: CY,
      unitIds: [...GHG_VERIFICATION_UNIT_IDS],
    });
    const us1 = coverage.sites.find((s) => s.unit.id === US1)!;
    expect(us1.kinds.find((k) => k.kind === 'electricity')).toMatchObject({
      monthsCovered: 1,
      confirmedLines: 1,
    });
    expect(coverage.counts.missingMonths).toBeGreaterThanOrEqual(22);
    const replaced = coverage.batches.find((b) => b.batch.id === US1_ENERGY)!;
    expect(replaced.supersededByFileName).toBe(batch.fileName);

    // Cookie から戻しても同じ状態（バッチ・行・差し替え済み）
    const edits: DemoEdit[] = [
      ...fixture.ghgActivityBatches
        .filter((b) => b.id === batch.id || b.id === US1_ENERGY)
        .map((b) => ({
          t: 'ghgActivityBatches',
          id: b.id,
          v: compactRow('ghgActivityBatches', b as never, fixture)!,
        })),
      ...fixture.ghgActivityLines
        .filter((l) => l.batchId === batch.id)
        .map((l) => ({
          t: 'ghgActivityLines',
          id: l.id,
          v: compactRow('ghgActivityLines', l as never, fixture)!,
        })),
    ];
    const restored = createFixtureDb();
    applyDemoEdits(restored, decodeDemoEdits(encodeDemoEditStream(edits)));
    expect(restored.ghgActivityBatches.find((b) => b.id === batch.id)?.status).toBe('confirmed');
    expect(restored.ghgActivityBatches.find((b) => b.id === US1_ENERGY)?.status).toBe('superseded');
    expect(restored.ghgActivityLines.filter((l) => l.batchId === batch.id)).toHaveLength(3);
  });

  it('同じバッチを差し替える 2 つ目の取込は、先に確定した後では確定しない', async () => {
    const file = await sampleEnergy();
    const req = request(file, { unitId: US1, kind: 'energy', replaceBatchId: US1_ENERGY });
    const p = await previewActivityImport(db, author(), req);
    const first = await createActivityBatch(db, author(), {
      ...req,
      expectedSha256: p.file.sha256,
    });
    const second = await createActivityBatch(db, author(), {
      ...req,
      expectedSha256: p.file.sha256,
    });
    await confirmActivityImport(db, author(), first.id);
    await expect(confirmActivityImport(db, author(), second.id)).rejects.toThrow(
      '既に差し替え済みか見つかりません',
    );
  });

  it('別の拠点・種類のバッチは差し替えられない', async () => {
    const preview = await previewActivityImport(
      db,
      author(),
      request(sampleTransport(), { replaceBatchId: US1_ENERGY }),
    );
    expect(preview.canImport).toBe(false);
    expect(preview.blockers[0]).toContain('差し替える確定済みのバッチが見つかりません');
  });
});

describe('loadActivityCoverage・loadActivityBatch（読む）', () => {
  it('Fixture: 検証 5 拠点の拠点 × 活動 × 月はすべて揃い、見なし積載率 4 行・下限 1 行', async () => {
    const guard = new WriteDetectingDbClient(db);
    const coverage = await loadActivityCoverage(guard, reviewer(), {
      periodId: CY,
      unitIds: [...GHG_VERIFICATION_UNIT_IDS],
    });
    expect(guard.writes).toEqual([]);
    expect(coverage.months).toHaveLength(12);
    expect(coverage.sites.map((s) => s.unit.code)).toEqual(['EAST', 'TH1', 'VN1', 'MX1', 'US1']);
    expect(coverage.sites.map((s) => s.overseas)).toEqual([false, true, true, true, true]);
    const east = coverage.sites[0]!;
    expect(east.kinds.map((k) => [k.kind, k.monthsCovered])).toEqual([
      ['electricity', 12],
      ['fuel', 12],
      ['gas', 12],
      ['transport', 12],
    ]);
    expect(coverage.counts).toEqual({
      confirmedBatches: 6,
      draftBatches: 0,
      missingMonths: 0,
      defaultLoadLines: 4,
      flooredLoadLines: 1,
      overseasTransportLines: 0,
    });
    expect(coverage.batches).toHaveLength(6);
    expect(coverage.batches[0]!.createdByName).not.toBeNull();
  });

  it('算定方針が無ければ下限を当てる行は数えられない（null）', async () => {
    fixture.ghgCalculationPolicies.splice(0, fixture.ghgCalculationPolicies.length);
    const coverage = await loadActivityCoverage(db, reviewer(), {
      periodId: CY,
      unitIds: [...GHG_VERIFICATION_UNIT_IDS],
    });
    expect(coverage.minLoadPct).toBeNull();
    expect(coverage.counts.flooredLoadLines).toBeNull();
    expect(coverage.counts.defaultLoadLines).toBe(4);
  });

  it('確認中のバッチは充足に数えず、確認中の行として出す', async () => {
    const file = sampleTransport();
    const p = await previewActivityImport(db, author(), request(file, { unitId: TH1 }));
    await createActivityBatch(db, author(), {
      ...request(file, { unitId: TH1 }),
      expectedSha256: p.file.sha256,
    });
    const coverage = await loadActivityCoverage(db, author(), {
      periodId: CY,
      unitIds: [...GHG_VERIFICATION_UNIT_IDS],
    });
    const th = coverage.sites.find((s) => s.unit.id === TH1)!;
    expect(th.kinds.find((k) => k.kind === 'transport')).toMatchObject({
      monthsCovered: 0,
      confirmedLines: 0,
      draftLines: 6,
    });
    expect(coverage.counts.draftBatches).toBe(1);
    expect(coverage.counts.overseasTransportLines).toBe(6);
  });

  it('バッチの詳細: 行・拠点・追加の重複の数。他の組織は見つからない', async () => {
    const detail = await loadActivityBatch(db, reviewer(), ghgBatchId('EAST', 'transport'));
    expect(detail.lines).toHaveLength(36);
    expect(detail.overseas).toBe(false);
    expect(detail.unit.code).toBe('EAST');
    expect(detail.supersedes).toBeNull();
    await expect(
      loadActivityBatch(db, other(), ghgBatchId('EAST', 'transport')),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
