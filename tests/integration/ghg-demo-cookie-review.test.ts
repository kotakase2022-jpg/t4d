import { describe, expect, it } from 'vitest';
import { ORG_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import {
  GHG_FIXTURE_IDS,
  ghgBatchId,
  ghgFactorId,
  ghgFixtureAssignmentIds,
} from '@/lib/fixtures/ghg-verification';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { compactRow } from '@/lib/repositories/demo-compact';
import {
  applyDemoEdits,
  decodeDemoEdits,
  encodeDemoEditStream,
  type DemoEdit,
} from '@/lib/repositories/demo-edit-codec';
import { DEMO_GHG_LIMITS, demoRemovalMark } from '@/lib/repositories/demo-ghg-checks';
import type {
  EmissionFactor,
  EmissionFactorAssignment,
  GhgActivityBatch,
  GhgActivityLine,
} from '@/types/domain';

/**
 * Demo Mode の Cookie から戻す GHG の行（自己監査 GHG のレビュー指摘）:
 *  - 確定済みのバッチ・有効なセットへ、作成日時を偽って行・係数を足させない（Fixture の不変の行・別の人の行）
 *  - 上限を超えた偽の算定の記録・照合を並べた Cookie で、作り直し（算定・照合の純関数）を繰り返させない
 *  - 外した割当は「外した」印で、既に行を戻した別のインスタンスからも除く
 *  - 活動・基準・国の合わない係数の割当、担当外の拠点を含む照合・既存結果を戻さない
 */

const ORG = ORG_IDS.aomi;
const AUTHOR = userId('sustainability@demo.local');
const SITE = userId('site-user@demo.local');
const REVIEWER = userId('reviewer@demo.local');
const G = GHG_FIXTURE_IDS;
const OLD = '2000-01-01T00:00:00.000Z';
const T0 = '2026-10-16T01:00:00.000Z';
const T1 = '2026-10-16T02:00:00.000Z';

function edit(table: string, row: object, db: FixtureDb): DemoEdit {
  const v = compactRow(table, row as Record<string, unknown>, db);
  if (!v) throw new Error(`${table} は Cookie に載らない形です`);
  return { t: table, id: (row as { id: string }).id, v };
}

function replayInto(target: FixtureDb, edits: DemoEdit[]): FixtureDb {
  applyDemoEdits(target, decodeDemoEdits(encodeDemoEditStream(edits)));
  return target;
}

describe('確定・有効にした行へ偽の子を足させない（sec F2）', () => {
  it('Fixture の確定済みのバッチに、作成日時を確定より前に偽った行を足さない', () => {
    const base = createFixtureDb();
    const batchId = ghgBatchId('EAST', 'energy');
    const template = base.ghgActivityLines.find((l) => l.batchId === batchId)!;
    const forged: GhgActivityLine = {
      ...template,
      id: '0b000000-0000-4000-8000-000000000001',
      lineNo: 999,
      amount: 99_999_999,
      createdAt: OLD,
    };
    const before = base.ghgActivityLines.filter((l) => l.batchId === batchId).length;
    const db = replayInto(createFixtureDb(), [edit('ghgActivityLines', forged, base)]);
    expect(db.ghgActivityLines.some((l) => l.id === forged.id)).toBe(false);
    expect(db.ghgActivityLines.filter((l) => l.batchId === batchId)).toHaveLength(before);
  });

  it('Fixture の有効なセットに、作成日時を有効化より前に偽った係数を足さない', () => {
    const base = createFixtureDb();
    const forged: EmissionFactor = {
      ...base.emissionFactors.find((f) => f.id === ghgFactorId(2025, 'DIESEL'))!,
      id: '0b000000-0000-4000-8000-000000000002',
      code: 'FORGED-X',
      createdAt: OLD,
    };
    const db = replayInto(createFixtureDb(), [edit('emissionFactors', forged, base)]);
    expect(db.emissionFactors.some((f) => f.code === 'FORGED-X')).toBe(false);
  });

  it('利用者の確定済みのバッチでも、同じ Cookie にバッチの行が無ければ行を足さない・行数を超えて足さない', () => {
    const base = createFixtureDb();
    const batch: GhgActivityBatch = {
      id: '0b000000-0000-4000-8000-000000000010',
      organizationId: ORG,
      reportingPeriodId: G.period,
      unitId: UNIT_IDS.east,
      kind: 'transport',
      source: 'upload',
      fileName: '（架空）輸送実績_追加.csv',
      fileSha256: 'b'.repeat(64),
      rowCount: 1,
      status: 'confirmed',
      confirmedBy: SITE,
      confirmedAt: T1,
      supersedesBatchId: null,
      createdAt: T0,
      createdBy: SITE,
      updatedAt: T1,
    };
    const line = (id: string, lineNo: number): GhgActivityLine => ({
      ...base.ghgActivityLines.find(
        (l) => l.batchId === ghgBatchId('EAST', 'transport') && l.carrierKind === 'contracted',
      )!,
      id,
      batchId: batch.id,
      lineNo,
      createdAt: T0,
    });
    // 別のインスタンスのメモリに、別の人の Cookie から戻したバッチがある
    const instance = createFixtureDb();
    instance.ghgActivityBatches.push(batch);
    replayInto(instance, [
      edit('ghgActivityLines', line('0b000000-0000-4000-8000-000000000011', 1), base),
    ]);
    expect(instance.ghgActivityLines.some((l) => l.batchId === batch.id)).toBe(false);
    // 持ち主の Cookie（バッチと行）なら戻す。行数（1）を超える行は戻さない
    const own = replayInto(createFixtureDb(), [
      edit('ghgActivityBatches', batch, base),
      edit('ghgActivityLines', line('0b000000-0000-4000-8000-000000000011', 1), base),
      edit('ghgActivityLines', line('0b000000-0000-4000-8000-000000000012', 2), base),
    ]);
    expect(own.ghgActivityLines.filter((l) => l.batchId === batch.id)).toHaveLength(1);
  });
});

describe('偽の算定の記録・照合で作り直しを繰り返させない（pers F2）', () => {
  it('上限を超えた照合 500 件の Cookie でも、作り直しは上限の分だけ（数秒かからない）', () => {
    const base = createFixtureDb();
    const recon = base.ghgReconciliations.find((r) => r.id === G.reconciliation)!;
    const edits: DemoEdit[] = Array.from({ length: 500 }, (_, i) => {
      const id = `0c000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      return edit('ghgReconciliations', { ...recon, id }, base);
    });
    const target = createFixtureDb();
    const started = performance.now();
    replayInto(target, edits);
    const elapsed = performance.now() - started;
    const forged = target.ghgReconciliations.filter((r) => r.id.startsWith('0c000000'));
    expect(forged).toHaveLength(DEMO_GHG_LIMITS.userReconciliations);
    // 修正前は検査の前に 500 件を作り直して約 12 秒かかった
    expect(elapsed).toBeLessThan(3_000);
  });

  it('上限を超えた算定の記録 500 件の Cookie でも、作り直しは上限の分だけ', () => {
    const base = createFixtureDb();
    const run = base.ghgCalculationRuns.find((r) => r.id === G.run)!;
    const edits: DemoEdit[] = Array.from({ length: 500 }, (_, i) => {
      const id = `0d000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      return edit('ghgCalculationRuns', { ...run, id }, base);
    });
    const target = createFixtureDb();
    const started = performance.now();
    replayInto(target, edits);
    const elapsed = performance.now() - started;
    expect(target.ghgCalculationRuns.filter((r) => r.id.startsWith('0d000000'))).toHaveLength(
      DEMO_GHG_LIMITS.userRuns,
    );
    expect(elapsed).toBeLessThan(3_000);
  });
});

describe('外した割当の印（pers F1）', () => {
  const userAssignment = (base: FixtureDb): EmissionFactorAssignment => ({
    ...base.emissionFactorAssignments.find(
      (a) => a.countryCode === 'TH' && a.basis === 'location',
    )!,
    id: '0e000000-0000-4000-8000-000000000001',
    unitId: G.units.th,
    countryCode: null,
    createdAt: T0,
    updatedAt: T0,
    createdBy: AUTHOR,
    updatedBy: AUTHOR,
  });

  it('既に割当を戻したインスタンスも、「外した」印で同じ割当を除く', () => {
    const base = createFixtureDb();
    const row = userAssignment(base);
    // インスタンス B: 以前のリクエストで割当を戻した
    const instance = replayInto(createFixtureDb(), [edit('emissionFactorAssignments', row, base)]);
    expect(instance.emissionFactorAssignments.some((a) => a.id === row.id)).toBe(true);
    // 別のインスタンスで外した後の Cookie（割当の編集の代わりに印だけ）
    replayInto(instance, [
      {
        t: 'emissionFactorAssignments',
        id: row.id,
        v: { id: row.id, ...demoRemovalMark(AUTHOR, T1) },
      },
    ]);
    expect(instance.emissionFactorAssignments.some((a) => a.id === row.id)).toBe(false);
    // 印だけの Cookie を受け取った別のインスタンス（行が無い）では何も起きない
    const fresh = replayInto(createFixtureDb(), [
      {
        t: 'emissionFactorAssignments',
        id: row.id,
        v: { id: row.id, ...demoRemovalMark(AUTHOR, T1) },
      },
    ]);
    expect(fresh.emissionFactorAssignments).toHaveLength(
      createFixtureDb().emissionFactorAssignments.length,
    );
  });

  it('Fixture の割当・権限の無い人の印では何も除かない', () => {
    const fixtureId = [...ghgFixtureAssignmentIds()][0]!;
    const db = replayInto(createFixtureDb(), [
      {
        t: 'emissionFactorAssignments',
        id: fixtureId,
        v: { id: fixtureId, ...demoRemovalMark(AUTHOR, T1) },
      },
    ]);
    expect(db.emissionFactorAssignments.some((a) => a.id === fixtureId)).toBe(true);
    const base = createFixtureDb();
    const row = userAssignment(base);
    const instance = replayInto(createFixtureDb(), [edit('emissionFactorAssignments', row, base)]);
    replayInto(instance, [
      {
        t: 'emissionFactorAssignments',
        id: row.id,
        v: { id: row.id, ...demoRemovalMark(REVIEWER, T1) },
      },
    ]);
    expect(instance.emissionFactorAssignments.some((a) => a.id === row.id)).toBe(true);
  });
});

describe('割当・照合・既存結果の規則（sec F3・F5・F4）', () => {
  it('軽油の割当を揮発油の係数に書き換えた Cookie は戻さない', () => {
    const base = createFixtureDb();
    const diesel = base.emissionFactorAssignments.find(
      (a) => a.activityKind === 'fuel' && a.activityCode === 'diesel',
    )!;
    const db = replayInto(createFixtureDb(), [
      {
        t: 'emissionFactorAssignments',
        id: diesel.id,
        v: { factorId: ghgFactorId(2025, 'GASOLINE'), updatedBy: AUTHOR, updatedAt: T1 },
      },
    ]);
    expect(db.emissionFactorAssignments.find((a) => a.id === diesel.id)!.factorId).toBe(
      ghgFactorId(2025, 'DIESEL'),
    );
  });

  it('担当外の拠点を含む算定の記録の照合（拠点担当の名義）は戻さない', () => {
    const base = createFixtureDb();
    const recon = base.ghgReconciliations.find((r) => r.id === G.reconciliation)!;
    const bySite = { ...recon, id: '0f000000-0000-4000-8000-000000000001', createdBy: SITE };
    const db = replayInto(createFixtureDb(), [edit('ghgReconciliations', bySite, base)]);
    expect(db.ghgReconciliations.some((r) => r.id === bySite.id)).toBe(false);
  });

  it('担当外の拠点を対応付けた既存結果（拠点担当の名義）は戻さない', () => {
    const base = createFixtureDb();
    const baseline = base.ghgBaselineResults[0]!;
    const rows = baseline.rows.slice(0, 5);
    const bySite = {
      ...baseline,
      id: '0f000000-0000-4000-8000-000000000002',
      rows,
      rowCount: rows.length,
      createdBy: SITE,
    };
    const db = replayInto(createFixtureDb(), [edit('ghgBaselineResults', bySite, base)]);
    expect(db.ghgBaselineResults.some((b) => b.id === bySite.id)).toBe(false);
  });
});
