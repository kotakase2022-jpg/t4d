import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ORG_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { GHG_FIXTURE_IDS, GHG_VERIFICATION_UNIT_IDS } from '@/lib/fixtures/ghg-verification';
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
import { computeWhatIf, listRuns, loadRun, runCalculation } from '@/lib/services/ghg/calculation';
import type { AuthorizationContext, OrganizationType, RoleKey, Uuid } from '@/types/domain';
import { WriteDetectingDbClient } from '../support/write-detecting-db';

/**
 * 算定の実行と記録（plan §2.3 calculation.ts・CR-08・int:ghg-calculation）。
 *  - 決定論（Fixture の R-1 と同じ入力ハッシュ）・係数の未割当は記録を作らずエラーの一覧・拠点スコープ
 *  - 区分規則の承認で入力が変わる（記録は「入力が変わった」）
 *  - 仮説の再計算は書き込み 0
 *  - Demo Mode の Cookie から戻した記録は、要約と算定行を同じ純関数で作り直す（入力ハッシュを照合）
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
  organizationType: OrganizationType = 'enterprise',
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType,
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
const UNITS = [...GHG_VERIFICATION_UNIT_IDS];

function replay(table: string, row: object, base: FixtureDb = createFixtureDb()): FixtureDb {
  const v = compactRow(table, row as Record<string, unknown>, fixture);
  if (!v) throw new Error(`${table} は Cookie に載らない形です`);
  const edit: DemoEdit = { t: table, id: (row as { id: string }).id, v };
  applyDemoEdits(base, decodeDemoEdits(encodeDemoEditStream([edit])));
  return base;
}

describe('runCalculation', () => {
  it('5 拠点を算定して記録と算定行を書く。入力が同じなら Fixture の R-1 と同じ入力ハッシュ', async () => {
    const result = await runCalculation(db, author(), { periodId: CY, unitIds: UNITS });
    if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
    const r1 = fixture.ghgCalculationRuns.find((r) => r.id === GHG_FIXTURE_IDS.run)!;
    expect(result.run.inputHash).toBe(r1.inputHash);
    expect(result.run.lineCount).toBe(r1.lineCount);
    expect(result.run.createdBy).toBe(userId('sustainability@demo.local'));
    expect(fixture.ghgCalculationLines.filter((l) => l.runId === result.run.id)).toHaveLength(
      result.run.lineCount,
    );
    const audit = fixture.auditEvents.find((e) => e.resourceId === result.run.id)!;
    expect(audit).toMatchObject({ eventType: 'data_created', resourceType: 'ghg_calculation_run' });
  });

  it('係数が解決できない行が 1 つでもあれば記録を作らずエラーの一覧を返す（代わりを使わない）', async () => {
    const index = fixture.emissionFactorAssignments.findIndex(
      (a) => a.countryCode === 'TH' && a.basis === 'location',
    );
    fixture.emissionFactorAssignments.splice(index, 1);
    const before = fixture.ghgCalculationRuns.length;
    const result = await runCalculation(db, author(), { periodId: CY, unitIds: UNITS });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(12);
    expect(result.errors[0]!.message).toContain('タイ工場');
    expect(result.errors[0]!.message).toContain('係数が割り当てられていません');
    expect(fixture.ghgCalculationRuns).toHaveLength(before);
  });

  it('担当外の拠点は算定できない。データの書込権限が無い人・他社は実行できない', async () => {
    await expect(
      runCalculation(db, site(), {
        periodId: CY,
        unitIds: [UNIT_IDS.east, GHG_FIXTURE_IDS.units.th],
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    const own = await runCalculation(db, site(), { periodId: CY, unitIds: [UNIT_IDS.east] });
    expect(own.ok).toBe(true);
    await expect(
      runCalculation(db, reviewer(), { periodId: CY, unitIds: UNITS }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      runCalculation(db, other(), { periodId: CY, unitIds: UNITS }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('算定方針が無い期間・活動量が無い拠点は止める', async () => {
    fixture.ghgCalculationPolicies.length = 0;
    await expect(
      runCalculation(db, author(), { periodId: CY, unitIds: UNITS }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('listRuns・loadRun', () => {
  it('R-1 はいまの入力と同じ（最新）。区分規則を承認すると入力が変わる', async () => {
    const before = await listRuns(db, author(), { periodId: CY });
    expect(before.map((r) => [r.run.id, r.inputState])).toEqual([[GHG_FIXTURE_IDS.run, 'current']]);
    const rule = fixture.ghgClassificationRules[0]!;
    Object.assign(rule, {
      status: 'approved',
      approvedBy: userId('approver@demo.local'),
      approvedAt: new Date().toISOString(),
    });
    const after = await listRuns(db, author(), { periodId: CY });
    expect(after[0]!.inputState).toBe('stale');
  });

  it('算定行と二重表示（Σ(報告の scope1＋scope3) ＝ Σ(既定の scope1＋scope3)）', async () => {
    const loaded = await loadRun(db, author(), GHG_FIXTURE_IDS.run);
    expect(loaded.lines).toHaveLength(loaded.run.lineCount);
    const dual = loaded.dual!;
    expect(dual.reported.scope1 + dual.reported.scope3_cat4).toBeCloseTo(
      dual.protocol.scope1 + dual.protocol.scope3_cat4,
      9,
    );
    // 承認前なので再分類は無い
    expect(dual.reclassified).toEqual([]);
    await expect(loadRun(db, other(), GHG_FIXTURE_IDS.run)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('computeWhatIf（仮説の再計算）', () => {
  it('書き込みは 0。US1 の差は係数セット 2024 年版で閉じる', async () => {
    const guarded = new WriteDetectingDbClient(db);
    const out = await computeWhatIf(guarded, author(), GHG_FIXTURE_IDS.run, {
      factorSetId: GHG_FIXTURE_IDS.sets.org2024,
    });
    expect(guarded.writes).toEqual([]);
    const baseline = fixture.ghgBaselineResults[0]!;
    for (const row of baseline.rows.filter((r) => r.unitId === GHG_FIXTURE_IDS.units.us)) {
      const site = out.summary.reported.sites.find(
        (s) => s.unitId === GHG_FIXTURE_IDS.units.us && s.scope === row.scope,
      )!;
      expect(site.rounded).toBe(row.emissions);
    }
  });

  it('別の組織の係数のセットは使えない', async () => {
    await expect(
      computeWhatIf(db, author(), GHG_FIXTURE_IDS.run, {
        factorSetId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('Demo Mode の Cookie から戻す（plan K11）', () => {
  it('算定の記録は要約を落として載せ、戻すときに同じ純関数で作り直す（算定行もメモリへ）', async () => {
    const result = await runCalculation(db, author(), { periodId: CY, unitIds: UNITS });
    if (!result.ok) throw new Error('算定できるはず');
    const compact = compactRow(
      'ghgCalculationRuns',
      result.run as unknown as Record<string, unknown>,
      fixture,
    )!;
    expect(compact.summary).toBeUndefined();
    const target = replay('ghgCalculationRuns', result.run);
    const restored = target.ghgCalculationRuns.find((r) => r.id === result.run.id)!;
    expect(restored.summary).toEqual(result.run.summary);
    const lines = target.ghgCalculationLines.filter((l) => l.runId === result.run.id);
    expect(lines.map((l) => l.id)).toEqual(result.lines.map((l) => l.id));
  });

  it('入力ハッシュが合わない（偽の・入力が変わった）記録は要約を null にし、算定行を作らない', async () => {
    const result = await runCalculation(db, author(), { periodId: CY, unitIds: UNITS });
    if (!result.ok) throw new Error('算定できるはず');
    const forged = { ...result.run, inputHash: 'f'.repeat(64) };
    const target = replay('ghgCalculationRuns', forged);
    const restored = target.ghgCalculationRuns.find((r) => r.id === result.run.id)!;
    expect(restored.summary).toBeNull();
    expect(target.ghgCalculationLines.some((l) => l.runId === result.run.id)).toBe(false);
  });

  it('担当外の拠点を含む記録・権限の無い人の名義の記録は戻さない', async () => {
    const result = await runCalculation(db, author(), { periodId: CY, unitIds: UNITS });
    if (!result.ok) throw new Error('算定できるはず');
    const bySite = {
      ...result.run,
      id: '11111111-1111-4111-8111-111111111111',
      createdBy: userId('site-user@demo.local'),
    };
    expect(
      replay('ghgCalculationRuns', bySite).ghgCalculationRuns.some((r) => r.id === bySite.id),
    ).toBe(false);
    const byReviewer = {
      ...result.run,
      id: '22222222-2222-4222-8222-222222222222',
      createdBy: userId('reviewer@demo.local'),
    };
    expect(
      replay('ghgCalculationRuns', byReviewer).ghgCalculationRuns.some(
        (r) => r.id === byReviewer.id,
      ),
    ).toBe(false);
  });
});
