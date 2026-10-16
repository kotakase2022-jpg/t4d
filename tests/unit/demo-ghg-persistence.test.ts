import { describe, expect, it } from 'vitest';
import { calculateRun } from '@/lib/domain/ghg/calculate';
import { selectCalculationInputs } from '@/lib/domain/ghg/select-inputs';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import {
  GHG_FIXTURE_IDS,
  GHG_FIXTURE_TOLERANCE,
  GHG_VERIFICATION_UNIT_IDS,
  ghgBatchId,
  ghgFactorId,
  ghgSourceRowsFromFixture,
} from '@/lib/fixtures/ghg-verification';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { compactRow } from '@/lib/repositories/demo-compact';
import {
  applyDemoEdits,
  decodeDemoEdits,
  encodeDemoEditStream,
  type DemoEdit,
} from '@/lib/repositories/demo-edit-codec';
import {
  attribute,
  attributionLinesFrom,
  RECONCILIATION_CHECKER_VERSION,
} from '@/lib/domain/ghg/attribution';
import type {
  EmissionFactor,
  EmissionFactorSet,
  GhgActivityBatch,
  GhgActivityLine,
  GhgCalculationPolicy,
  GhgReconciliationNote,
} from '@/types/domain';

/**
 * Demo Mode の Cookie から戻す Scope1・2 の算定と照合の行の検査（plan §2.7・demo-ghg-checks.ts）。
 * 偽の Cookie で、権限の無い人の名義・職務分離を通らない承認・有効にしたセットの係数の書き換え・担当外の拠点・
 * 大きすぎる行を、インスタンスの全利用者の画面に出させない。あわせて GHG の流れの Cookie の大きさを測る（予算 3,000B）。
 */

const AUTHOR = userId('sustainability@demo.local');
const APPROVER = userId('approver@demo.local');
const REVIEWER = userId('reviewer@demo.local');
const SITE = userId('site-user@demo.local');
const ORG = ORG_IDS.aomi;
const G = GHG_FIXTURE_IDS;
const T0 = '2026-10-16T01:00:00.000Z';
const T1 = '2026-10-16T02:00:00.000Z';
const T2 = '2026-10-16T03:00:00.000Z';

function edit(table: string, row: object, db: FixtureDb = createFixtureDb()): DemoEdit {
  const v = compactRow(table, row as Record<string, unknown>, db);
  if (!v) throw new Error(`${table} は Cookie に載らない形です`);
  return { t: table, id: (row as { id: string }).id, v };
}

function replay(edits: DemoEdit[]): FixtureDb {
  const target = createFixtureDb();
  applyDemoEdits(target, decodeDemoEdits(encodeDemoEditStream(edits)));
  return target;
}

const set = (over: Partial<EmissionFactorSet> = {}): EmissionFactorSet => ({
  id: '0a000000-0000-4000-8000-000000000001',
  organizationId: ORG,
  code: 'ORG-2025-R',
  name: '組織指定（架空）2025 年版 改訂',
  origin: 'customer_specified',
  sourceLabel: '（架空）',
  versionLabel: '2025 年版 改訂',
  publishedOn: null,
  referenceYear: 2025,
  status: 'active',
  activatedBy: AUTHOR,
  activatedAt: T1,
  retiredBy: null,
  retiredAt: null,
  notes: '',
  createdAt: T0,
  updatedAt: T1,
  createdBy: AUTHOR,
  updatedBy: AUTHOR,
  ...over,
});

const factor = (over: Partial<EmissionFactor> = {}): EmissionFactor => ({
  ...createFixtureDb().emissionFactors.find((f) => f.id === ghgFactorId(2025, 'DIESEL'))!,
  id: '0a000000-0000-4000-8000-000000000002',
  code: 'R-DIESEL',
  factorSetId: '0a000000-0000-4000-8000-000000000001',
  createdAt: T0,
  ...over,
});

describe('係数のセットと係数', () => {
  it('有効化の前に作った係数は戻す（Cookie はセットの最後の状態だけを持つ）', () => {
    const db = replay([edit('emissionFactorSets', set()), edit('emissionFactors', factor())]);
    expect(db.emissionFactorSets.some((s) => s.code === 'ORG-2025-R')).toBe(true);
    expect(db.emissionFactors.some((f) => f.code === 'R-DIESEL')).toBe(true);
  });

  it('有効化の後に作った係数・権限の無い人が有効にしたセットは戻さない', () => {
    const late = replay([
      edit('emissionFactorSets', set()),
      edit('emissionFactors', factor({ createdAt: T2 })),
    ]);
    expect(late.emissionFactors.some((f) => f.code === 'R-DIESEL')).toBe(false);
    const byReviewer = replay([
      edit('emissionFactorSets', set({ activatedBy: REVIEWER, updatedBy: REVIEWER })),
    ]);
    expect(byReviewer.emissionFactorSets.some((s) => s.code === 'ORG-2025-R')).toBe(false);
  });

  it('Fixture の有効なセットの係数は Cookie から書き換えない', () => {
    const original = createFixtureDb().emissionFactors.find(
      (f) => f.id === ghgFactorId(2025, 'DIESEL'),
    )!;
    const db = replay([{ t: 'emissionFactors', id: original.id, v: { calorificValue: 99 } }]);
    expect(db.emissionFactors.find((f) => f.id === original.id)!.calorificValue).toBe(
      original.calorificValue,
    );
  });
});

describe('区分規則', () => {
  const approve = (approvedBy: string) =>
    replay([
      {
        t: 'ghgClassificationRules',
        id: G.rule,
        v: { status: 'approved', approvedBy, approvedAt: T1, updatedAt: T1 },
      },
    ]).ghgClassificationRules.find((r) => r.id === G.rule)!.status;

  it('提案者本人・承認の権限の無い人の承認は戻さない。最終承認者の承認は戻す', () => {
    expect(approve(AUTHOR)).toBe('proposed');
    expect(approve(REVIEWER)).toBe('proposed');
    expect(approve(APPROVER)).toBe('approved');
  });

  it('内容（根拠）の書き換えは戻さない', () => {
    const db = replay([{ t: 'ghgClassificationRules', id: G.rule, v: { rationale: '書き換え' } }]);
    expect(db.ghgClassificationRules.find((r) => r.id === G.rule)!.rationale).toContain('（架空）');
  });
});

describe('割当・方針', () => {
  it('締めた期間の割当・他社の係数の割当・権限の無い人の割当は戻さない', () => {
    const base = createFixtureDb().emissionFactorAssignments[0]!;
    const closed = {
      ...base,
      id: '0a000000-0000-4000-8000-000000000010',
      reportingPeriodId: PERIOD_IDS.fy2025,
    };
    const bySite = {
      ...base,
      id: '0a000000-0000-4000-8000-000000000011',
      unitId: UNIT_IDS.east,
      createdBy: SITE,
      updatedBy: SITE,
    };
    const db = replay([
      edit('emissionFactorAssignments', closed),
      edit('emissionFactorAssignments', bySite),
    ]);
    expect(db.emissionFactorAssignments.some((a) => a.id === closed.id || a.id === bySite.id)).toBe(
      false,
    );
  });

  it('方針の新しい版は metric.manage の本人だけ・版は前より後・JSON は 1,000 字まで', () => {
    const base = createFixtureDb().ghgCalculationPolicies[0]!;
    const v2: GhgCalculationPolicy = {
      ...base,
      id: '0a000000-0000-4000-8000-000000000020',
      versionNo: 2,
      createdAt: T1,
    };
    expect(
      replay([edit('ghgCalculationPolicies', v2)]).ghgCalculationPolicies.some(
        (p) => p.id === v2.id,
      ),
    ).toBe(true);
    const byReviewer = { ...v2, createdBy: REVIEWER };
    expect(
      replay([edit('ghgCalculationPolicies', byReviewer)]).ghgCalculationPolicies.some(
        (p) => p.id === v2.id,
      ),
    ).toBe(false);
    const sameVersion = { ...v2, versionNo: 1 };
    expect(
      replay([edit('ghgCalculationPolicies', sameVersion)]).ghgCalculationPolicies.some(
        (p) => p.id === v2.id,
      ),
    ).toBe(false);
    const huge = {
      ...v2,
      conversions: Array.from({ length: 20 }, (_, i) => ({
        from: 'm3',
        to: 'Nm3',
        multiplier: 1,
        source: `出典${'あ'.repeat(40)}${i}`,
      })),
    };
    expect(
      replay([edit('ghgCalculationPolicies', huge)]).ghgCalculationPolicies.some(
        (p) => p.id === v2.id,
      ),
    ).toBe(false);
  });
});

describe('活動量', () => {
  const batch = (over: Partial<GhgActivityBatch> = {}): GhgActivityBatch => ({
    id: '0a000000-0000-4000-8000-000000000030',
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
    ...over,
  });
  const line = (over: Partial<GhgActivityLine> = {}): GhgActivityLine => ({
    ...createFixtureDb().ghgActivityLines.find(
      (l) => l.batchId === ghgBatchId('EAST', 'transport') && l.carrierKind === 'contracted',
    )!,
    id: '0a000000-0000-4000-8000-000000000031',
    batchId: '0a000000-0000-4000-8000-000000000030',
    lineNo: 1,
    createdAt: T0,
    ...over,
  });

  it('担当拠点の利用者のバッチと、確定より前に作った行は戻す', () => {
    const db = replay([edit('ghgActivityBatches', batch()), edit('ghgActivityLines', line())]);
    expect(db.ghgActivityLines.some((l) => l.id === line().id)).toBe(true);
  });

  it('担当外の拠点のバッチ・確定の後に作った行・Fixture を名乗るバッチは戻さない', () => {
    const outside = replay([edit('ghgActivityBatches', batch({ unitId: G.units.th }))]);
    expect(outside.ghgActivityBatches.some((b) => b.id === batch().id)).toBe(false);
    const late = replay([
      edit('ghgActivityBatches', batch()),
      edit('ghgActivityLines', line({ createdAt: T2 })),
    ]);
    expect(late.ghgActivityLines.some((l) => l.id === line().id)).toBe(false);
    const fixtureClaim = replay([edit('ghgActivityBatches', batch({ source: 'fixture' }))]);
    expect(fixtureClaim.ghgActivityBatches.some((b) => b.id === batch().id)).toBe(false);
  });
});

describe('原因の確認の記録・既存結果', () => {
  const note = (over: Partial<GhgReconciliationNote> = {}): GhgReconciliationNote => ({
    id: '0a000000-0000-4000-8000-000000000040',
    organizationId: ORG,
    reconciliationId: G.reconciliation,
    itemKey: 'k',
    confirmedCause: 'factor',
    comment: '（架空）',
    decidedBy: REVIEWER,
    decidedAt: T1,
    supersedesId: null,
    ...over,
  });

  it('レビューの権限の本人の記録は戻す。権限の無い人・コメントの無い「その他」は戻さない', () => {
    expect(replay([edit('ghgReconciliationNotes', note())]).ghgReconciliationNotes).toHaveLength(1);
    expect(
      replay([edit('ghgReconciliationNotes', note({ decidedBy: SITE }))]).ghgReconciliationNotes,
    ).toHaveLength(0);
    expect(
      replay([edit('ghgReconciliationNotes', note({ confirmedCause: 'other', comment: '' }))])
        .ghgReconciliationNotes,
    ).toHaveLength(0);
  });

  it('既存結果は 80 行まで（Demo の上限）', () => {
    const base = createFixtureDb().ghgBaselineResults[0]!;
    const small = {
      ...base,
      id: '0a000000-0000-4000-8000-000000000050',
      rows: base.rows.slice(0, 10),
      rowCount: 10,
      createdAt: T1,
    };
    expect(
      replay([edit('ghgBaselineResults', small)]).ghgBaselineResults.some((b) => b.id === small.id),
    ).toBe(true);
    const large = { ...small, rows: base.rows.slice(0, 81), rowCount: 81 };
    expect(
      replay([edit('ghgBaselineResults', large)]).ghgBaselineResults.some((b) => b.id === small.id),
    ).toBe(false);
  });
});

describe('GHG の流れの Cookie の大きさ（plan §2.7。単独 3,000B 以下）', () => {
  it('規則の承認 → 算定 R-2（目録）→ 照合（目録）→ 原因の記録 2 件で 3,000B 以下', () => {
    const fixture = createFixtureDb();
    const rule = fixture.ghgClassificationRules[0]!;
    Object.assign(rule, {
      status: 'approved',
      approvedBy: APPROVER,
      approvedAt: T1,
      updatedAt: T1,
    });
    const period = fixture.periods.find((p) => p.id === G.period)!;
    const inputs = selectCalculationInputs(ghgSourceRowsFromFixture(fixture, period), [
      ...GHG_VERIFICATION_UNIT_IDS,
    ])!;
    const runId = '0a000000-0000-4000-8000-000000000060';
    const out = calculateRun(inputs, { runId, createdAt: T2 });
    expect(out.errors).toEqual([]);
    const run = {
      id: runId,
      organizationId: ORG,
      reportingPeriodId: period.id,
      unitIds: [...GHG_VERIFICATION_UNIT_IDS],
      policyId: inputs.policy.id,
      factorSetIds: out.factorSetIds,
      ruleIds: out.ruleIds,
      activityBatchIds: out.activityBatchIds,
      inputHash: out.inputHash,
      engineVersion: out.engineVersion,
      summary: out.summary,
      lineCount: out.lines.length,
      createdAt: T2,
      createdBy: AUTHOR,
    };
    fixture.ghgCalculationRuns.push(run);
    fixture.ghgCalculationLines.push(...out.lines);
    const shipments = new Map(fixture.ghgActivityLines.map((l) => [l.id, l.shipmentRef]));
    const recon = {
      id: '0a000000-0000-4000-8000-000000000061',
      organizationId: ORG,
      runId,
      baselineId: G.baseline,
      tolerance: GHG_FIXTURE_TOLERANCE,
      attributionOrder: [
        'classification',
        'coverage',
        'activity',
        'conversion',
        'factor',
        'method',
        'rounding',
      ] as const,
      result: attribute(
        attributionLinesFrom(out.lines, (id) => shipments.get(id) ?? null),
        fixture.ghgBaselineResults[0]!.rows,
        {
          t4dRounding: inputs.policy.rounding,
          tolerance: GHG_FIXTURE_TOLERANCE,
        },
      ),
      checkerVersion: RECONCILIATION_CHECKER_VERSION,
      createdAt: T2,
      createdBy: AUTHOR,
    };
    const edits: DemoEdit[] = [
      {
        t: 'ghgClassificationRules',
        id: rule.id,
        v: { status: 'approved', approvedBy: APPROVER, approvedAt: T1, updatedAt: T1 },
      },
      edit('ghgCalculationRuns', run, fixture),
      edit(
        'ghgReconciliations',
        { ...recon, attributionOrder: [...recon.attributionOrder] },
        fixture,
      ),
      edit('ghgReconciliationNotes', {
        id: '0a000000-0000-4000-8000-000000000062',
        organizationId: ORG,
        reconciliationId: recon.id,
        itemKey: `${G.units.vn}|scope2_location|electricity:grid|2025-01-01`,
        confirmedCause: 'factor',
        comment: '（架空）2024 年版の係数で算定していた',
        decidedBy: REVIEWER,
        decidedAt: T2,
        supersedesId: null,
      }),
      edit('ghgReconciliationNotes', {
        id: '0a000000-0000-4000-8000-000000000063',
        organizationId: ORG,
        reconciliationId: recon.id,
        itemKey: `${G.units.th}|scope1|fuel:diesel|2025-01-01`,
        confirmedCause: 'rounding',
        comment: '（架空）月ごとに kg で切り捨てていた',
        decidedBy: REVIEWER,
        decidedAt: T2,
        supersedesId: null,
      }),
    ];
    const encoded = encodeDemoEditStream(edits);
    expect(encoded.length).toBeLessThanOrEqual(3000);
    // 戻すと、承認・記録・照合・確認がすべて揃い、算定と照合の結果は作り直される
    const restored = replay(edits);
    expect(restored.ghgClassificationRules[0]!.status).toBe('approved');
    const restoredRun = restored.ghgCalculationRuns.find((r) => r.id === runId)!;
    expect(restoredRun.summary).toEqual(out.summary);
    expect(restored.ghgReconciliations.find((r) => r.id === recon.id)!.result).toEqual(
      recon.result,
    );
    expect(restored.ghgReconciliationNotes).toHaveLength(2);
  });
});
