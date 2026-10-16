import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { RECONCILIATION_CHECKER_VERSION } from '@/lib/domain/ghg/attribution';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import {
  GHG_FIXTURE_IDS,
  GHG_FIXTURE_TOLERANCE,
  GHG_VERIFICATION_UNIT_IDS,
} from '@/lib/fixtures/ghg-verification';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { ValidationError } from '@/lib/errors/user-facing';
import { compactRow } from '@/lib/repositories/demo-compact';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  applyDemoEdits,
  decodeDemoEdits,
  encodeDemoEditStream,
  type DemoEdit,
} from '@/lib/repositories/demo-edit-codec';
import { runCalculation } from '@/lib/services/ghg/calculation';
import { loadReconciliation, reconcile } from '@/lib/services/ghg/reconciliation';
import { loadGhgVerificationStatus } from '@/lib/services/ghg/status';
import type { AuthorizationContext, RoleKey, Uuid } from '@/types/domain';

/**
 * 照合（plan §2.3 reconciliation.ts・CR-12・int:ghg-reconciliation）と拠点ごとの検証の状況（status.ts・int:ghg-status）。
 *  - 許容差は既定値を置かない（照合に出る区分の許容差が無ければ拒否）
 *  - 判定は確認の記録を反映する（原因を記録した項目は「原因を確認済み」）
 *  - Demo Mode の Cookie から戻した照合は結果を作り直す（照合の規則の版を照合）
 *  - 拠点ごとの 6 状態（未着手・入力不足・算定済み・再算定が必要・照合〔要確認〕・照合済み）
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
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const author = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const other = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);
const G = GHG_FIXTURE_IDS;

describe('reconcile', () => {
  it('R-1 × BL-1 を照合して記録する（照合の規則の版を残し、監査ログは data_created）', async () => {
    const row = await reconcile(db, author(), {
      runId: G.run,
      baselineId: G.baseline,
      tolerance: GHG_FIXTURE_TOLERANCE,
    });
    expect(row.checkerVersion).toBe(RECONCILIATION_CHECKER_VERSION);
    const fixtureRecon = fixture.ghgReconciliations.find((r) => r.id === G.reconciliation)!;
    expect(row.result).toEqual(fixtureRecon.result);
    const audit = fixture.auditEvents.find((e) => e.resourceId === row.id)!;
    expect(audit).toMatchObject({ eventType: 'data_created', resourceType: 'ghg_reconciliation' });
  });

  it('照合に出る区分の許容差が無ければ拒否する（既定値を置かない）', async () => {
    const { scope3_cat4: _drop, ...partial } = GHG_FIXTURE_TOLERANCE;
    await expect(
      reconcile(db, author(), { runId: G.run, baselineId: G.baseline, tolerance: partial }),
    ).rejects.toThrow(/許容差が入っていない区分があります（Scope3 カテゴリ4）/);
    await expect(
      reconcile(db, author(), {
        runId: G.run,
        baselineId: G.baseline,
        tolerance: { ...GHG_FIXTURE_TOLERANCE, scope1: { absoluteT: null, relativePct: null } },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('データの書込権限が無い人・他社は照合できない。別の期間の既存結果とは照合しない', async () => {
    await expect(
      reconcile(db, reviewer(), {
        runId: G.run,
        baselineId: G.baseline,
        tolerance: GHG_FIXTURE_TOLERANCE,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      reconcile(db, other(), {
        runId: G.run,
        baselineId: G.baseline,
        tolerance: GHG_FIXTURE_TOLERANCE,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    fixture.ghgBaselineResults.push({
      ...fixture.ghgBaselineResults[0]!,
      id: '33333333-3333-4333-8333-333333333333',
      reportingPeriodId: PERIOD_IDS.fy2026,
    });
    await expect(
      reconcile(db, author(), {
        runId: G.run,
        baselineId: '33333333-3333-4333-8333-333333333333',
        tolerance: GHG_FIXTURE_TOLERANCE,
      }),
    ).rejects.toThrow(/同じ期間/);
  });

  it('UUID でない ID は DB に問い合わせずに「見つからない」にする（Supabase Mode で 22P02 → 500 にしない）', async () => {
    const findById = vi.spyOn(db, 'findById');
    await expect(
      reconcile(db, author(), {
        runId: 'not-a-uuid',
        baselineId: G.baseline,
        tolerance: GHG_FIXTURE_TOLERANCE,
      }),
    ).rejects.toThrow(new NotFoundError('算定の記録が見つかりません。'));
    await expect(
      reconcile(db, author(), {
        runId: G.run,
        baselineId: "1' or 1=1",
        tolerance: GHG_FIXTURE_TOLERANCE,
      }),
    ).rejects.toThrow(new NotFoundError('既存の算定結果が見つかりません。'));
    await expect(loadReconciliation(db, author(), 'R-1')).rejects.toThrow(
      new NotFoundError('照合の記録が見つかりません。'),
    );
    expect(findById).not.toHaveBeenCalled();
  });
});

describe('loadReconciliation', () => {
  it('確認の記録を反映した判定（原因を記録した項目は原因を確認済み）。判定の語に「一致」が無い', async () => {
    const before = await loadReconciliation(db, author(), G.reconciliation);
    const vn = before.items!.find((i) => i.unitId === G.units.vn && i.mainCause === 'factor')!;
    expect(vn.verdict).toBe('needs_review');
    fixture.ghgReconciliationNotes.push({
      id: '44444444-4444-4444-8444-444444444444',
      organizationId: ORG_IDS.aomi,
      reconciliationId: G.reconciliation,
      itemKey: vn.key,
      confirmedCause: 'factor',
      comment: '（テスト）2024 年版の係数',
      decidedBy: userId('reviewer@demo.local'),
      decidedAt: new Date().toISOString(),
      supersedesId: null,
    });
    const after = await loadReconciliation(db, reviewer(), G.reconciliation);
    const confirmed = after.items!.find((i) => i.key === vn.key)!;
    expect(confirmed.verdict).toBe('cause_confirmed');
    expect(confirmed.latestNote?.confirmedCause).toBe('factor');
    expect(after.counts.cause_confirmed).toBe(before.counts.cause_confirmed + 1);
    expect(Object.keys(after.counts).join(',')).not.toContain('match');
  });

  it('Cookie から戻した照合は結果を作り直す。照合の規則の版が違えば結果は null（数値を出さない）', async () => {
    const result = await runCalculation(db, author(), {
      periodId: G.period,
      unitIds: [...GHG_VERIFICATION_UNIT_IDS],
    });
    if (!result.ok) throw new Error('算定できるはず');
    const recon = await reconcile(db, author(), {
      runId: result.run.id,
      baselineId: G.baseline,
      tolerance: GHG_FIXTURE_TOLERANCE,
    });
    const editOf = (table: string, row: object): DemoEdit => ({
      t: table,
      id: (row as { id: string }).id,
      v: compactRow(table, row as Record<string, unknown>, fixture)!,
    });
    const target = createFixtureDb();
    applyDemoEdits(
      target,
      decodeDemoEdits(
        encodeDemoEditStream([
          editOf('ghgCalculationRuns', result.run),
          editOf('ghgReconciliations', recon),
        ]),
      ),
    );
    expect(target.ghgReconciliations.find((r) => r.id === recon.id)!.result).toEqual(recon.result);
    const stale = createFixtureDb();
    applyDemoEdits(
      stale,
      decodeDemoEdits(
        encodeDemoEditStream([
          editOf('ghgCalculationRuns', result.run),
          editOf('ghgReconciliations', { ...recon, checkerVersion: 'ghg-reconcile/0' }),
        ]),
      ),
    );
    expect(stale.ghgReconciliations.find((r) => r.id === recon.id)!.result).toBeNull();
  });
});

describe('loadGhgVerificationStatus（拠点ごとの検証の状況）', () => {
  const units = [...GHG_VERIFICATION_UNIT_IDS];

  it('Fixture: TH1 は全項目が許容差内で照合済み、ほかは照合（要確認）。注意の件数', async () => {
    const status = await loadGhgVerificationStatus(db, author(), {
      periodId: G.period,
      unitIds: units,
    });
    expect(status.units.map((u) => [u.unit.code, u.status.overall])).toEqual([
      ['EAST', 'reconciliation_review'],
      ['TH1', 'reconciled'],
      ['VN1', 'reconciliation_review'],
      ['MX1', 'reconciliation_review'],
      ['US1', 'reconciliation_review'],
    ]);
    expect(status.units.every((u) => u.status.activity.state === 'complete')).toBe(true);
    expect(status.attention).toMatchObject({
      unresolvedLines: 0,
      pendingRules: 1,
      draftBatches: 0,
      defaultLoadLines: 4,
      flooredLoadLines: 1,
    });
  });

  it('区分規則を承認すると入力が変わり、全拠点が再算定が必要', async () => {
    Object.assign(fixture.ghgClassificationRules[0]!, {
      status: 'approved',
      approvedBy: userId('approver@demo.local'),
      approvedAt: new Date().toISOString(),
    });
    const status = await loadGhgVerificationStatus(db, author(), {
      periodId: G.period,
      unitIds: units,
    });
    expect(new Set(status.units.map((u) => u.status.overall))).toEqual(new Set(['recalc_needed']));
  });

  it('係数の割当が無いと入力不足（理由を拠点名つきで返す）', async () => {
    const index = fixture.emissionFactorAssignments.findIndex((a) => a.countryCode === 'MX');
    fixture.emissionFactorAssignments.splice(index, 1);
    const status = await loadGhgVerificationStatus(db, author(), {
      periodId: G.period,
      unitIds: units,
    });
    const mx = status.units.find((u) => u.unit.id === G.units.mx)!;
    expect(mx.status.overall).toBe('input_missing');
    expect(mx.status.factors.unresolved).toBe(12);
    expect(status.attention.unresolvedReasons[0]).toContain('メキシコ工場');
  });

  it('活動量の無い拠点は未着手', async () => {
    const status = await loadGhgVerificationStatus(db, author(), {
      periodId: G.period,
      unitIds: [UNIT_IDS.west],
    });
    expect(status.units[0]!.status.overall).toBe('not_started');
  });
});
