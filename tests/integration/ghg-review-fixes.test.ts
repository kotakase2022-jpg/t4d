import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { ORG_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import {
  GHG_FIXTURE_IDS,
  GHG_FIXTURE_TOLERANCE,
  GHG_VERIFICATION_UNIT_IDS,
  ghgFactorId,
} from '@/lib/fixtures/ghg-verification';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { confirmActivityImport, discardActivityBatch } from '@/lib/services/ghg/activity-import';
import { clearAssignment, saveAssignment } from '@/lib/services/ghg/assignments';
import { approveRule, withdrawRule } from '@/lib/services/ghg/classification-rules';
import { listRuns, loadRun, runCalculation } from '@/lib/services/ghg/calculation';
import { activateFactorSet, loadFactorSet, retireFactorSet } from '@/lib/services/ghg/factor-sets';
import { planRunPosting } from '@/lib/services/ghg/post-to-data-points';
import { loadReconciliation, reconcile } from '@/lib/services/ghg/reconciliation';
import { loadGhgVerificationStatus } from '@/lib/services/ghg/status';
import { whatIfForReconciliation } from '@/lib/services/ghg/what-if';
import type { AuthorizationContext, GhgCalculationLine, RoleKey, Uuid } from '@/types/domain';
import { SupabaseModeDbClient } from '../support/supabase-mode-db';
import { isUuid } from '@/lib/validation/uuid';
import type { DbClient } from '@/lib/repositories/types';

/**
 * Scope1・2 の算定と照合のレビュー指摘（自己監査 GHG）の回帰テスト。
 *  - 入力ハッシュ: 係数のセットの取り下げ・拠点の国の変更で記録は「入力が変わった」になり反映を止める。関係の無い国の
 *    割当では変わらない（inv F1・F6・pers F3）
 *  - 仮説の再計算: 割当が記録の後に変わったら断る（inv F2）
 *  - 解決: 活動の合わない係数の割当は黙って使わない（sec F3）
 *  - 照合: 担当外の拠点を含む記録は照合できない（sec F5）
 *  - Supabase Mode: 利用者の JWT で書かれた要約・算定行・照合の結果を信じず、作り直した値を使う（sec F1・F6）
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

const G = GHG_FIXTURE_IDS;
const CY = G.period;
const UNITS = [...GHG_VERIFICATION_UNIT_IDS];

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

async function r1State(client = db): Promise<string> {
  const runs = await listRuns(client, author(), { periodId: CY });
  return runs.find((r) => r.run.id === G.run)!.inputState;
}

describe('入力ハッシュ（記録の入力の状態）', () => {
  it('使った係数のセットを取り下げると R-1 は「入力が変わった」になり、Data Point へ反映しない', async () => {
    expect(await r1State()).toBe('current');
    await retireFactorSet(db, author(), G.sets.org2025, { reason: '（テスト）値に誤り' });
    expect(await r1State()).toBe('stale');
    const plan = await planRunPosting(db, author(), G.run);
    expect(plan.blockedReason).toContain('入力');
    const status = await loadGhgVerificationStatus(db, author(), { periodId: CY, unitIds: UNITS });
    expect(status.units.every((u) => u.status.calculation === 'stale')).toBe(true);
  });

  it('算定する拠点の国に関係しない国の割当を足しても R-1 は最新のまま（反映できる）', async () => {
    await saveAssignment(db, author(), {
      periodId: CY,
      level: 'country',
      unitId: null,
      countryCode: 'DE',
      activityKind: 'fuel',
      activityCode: 'diesel',
      basis: null,
      factorId: ghgFactorId(2025, 'DIESEL'),
      reason: '（テスト）将来の拠点の準備',
    });
    expect(await r1State()).toBe('current');
    const plan = await planRunPosting(db, author(), G.run);
    expect(plan.blockedReason).toBeNull();
  });

  it('拠点の国を変えると（国の割当・海外拠点の輸送が変わる）R-1 は「入力が変わった」', async () => {
    const th = fixture.units.find((u) => u.id === G.units.th)!;
    th.countryCode = 'VN';
    expect(await r1State()).toBe('stale');
  });
});

describe('仮説の再計算は記録の入力でだけ行う（inv F2）', () => {
  it('記録の後に割当が変わったら断る（割当の変更の差を丸めの効果と取り違えない）', async () => {
    const base = await whatIfForReconciliation(db, reviewer(), G.reconciliation, 'rounding:none');
    expect(base.closedCount).toBe(0);
    await saveAssignment(db, author(), {
      periodId: CY,
      level: 'unit',
      unitId: G.units.vn,
      countryCode: null,
      activityKind: 'electricity',
      activityCode: 'grid',
      basis: 'location',
      factorId: ghgFactorId(2024, 'ELEC-LOC-VN'),
      reason: '（テスト）2024 年版',
    });
    await expect(
      whatIfForReconciliation(db, reviewer(), G.reconciliation, 'rounding:none'),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('解決: 活動の合わない係数の割当は使わない（sec F3）', () => {
  it('軽油の割当が揮発油の係数を指していたら、算定はエラーの一覧を返し記録を作らない', async () => {
    const diesel = fixture.emissionFactorAssignments.find(
      (a) => a.activityKind === 'fuel' && a.activityCode === 'diesel' && a.unitId === null,
    )!;
    diesel.factorId = ghgFactorId(2025, 'GASOLINE');
    const result = await runCalculation(db, author(), { periodId: CY, unitIds: UNITS });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.message).toContain('割り当てた係数の活動か基準が活動量と合いません');
  });
});

describe('照合は記録の拠点がすべて担当拠点の人だけ（sec F5）', () => {
  it('拠点担当は 5 拠点の R-1 を照合できない。自分の拠点だけの記録は照合できる', async () => {
    const input = (runId: Uuid) => ({
      runId,
      baselineId: G.baseline,
      tolerance: GHG_FIXTURE_TOLERANCE,
    });
    const before = fixture.ghgReconciliations.length;
    await expect(reconcile(db, site(), input(G.run))).rejects.toBeInstanceOf(AuthorizationError);
    expect(fixture.ghgReconciliations).toHaveLength(before);
    const own = await runCalculation(db, site(), { periodId: CY, unitIds: [UNIT_IDS.east] });
    if (!own.ok) throw new Error('算定できるはず');
    const recon = await reconcile(db, site(), input(own.run.id));
    expect(recon.runId).toBe(own.run.id);
  });
});

describe('Supabase Mode は保存された要約・算定行・照合の結果を信じない（sec F1・F6）', () => {
  it('要約を書き換えた記録は、作り直した要約を出し・反映に使う', async () => {
    const sdb = new SupabaseModeDbClient(db);
    const created = await runCalculation(sdb, author(), { periodId: CY, unitIds: UNITS });
    if (!created.ok) throw new Error('算定できるはず');
    const honest = structuredClone(created.run.summary!);
    // PostgREST で直接書いた（RLS の上では書ける）偽の要約: 拠点×区分の値を 10 倍にする
    const stored = fixture.ghgCalculationRuns.find((r) => r.id === created.run.id)!;
    for (const s of stored.summary!.reported.sites) s.rounded *= 10;
    const loaded = await loadRun(sdb, author(), created.run.id);
    expect(loaded.run.summary).toEqual(honest);
    const listed = (await listRuns(sdb, author(), { periodId: CY })).find(
      (r) => r.run.id === created.run.id,
    )!;
    expect(listed.run.summary).toEqual(honest);
    const plan = await planRunPosting(sdb, author(), created.run.id);
    const east = plan.targets.find((t) => t.unitId === UNIT_IDS.east && t.scope === 'scope1')!;
    const honestEast = honest.reported.sites.find(
      (s) => s.unitId === UNIT_IDS.east && s.scope === 'scope1',
    )!;
    expect(east.value).toBe(honestEast.rounded);
  });

  it('後から算定行を足した記録・入力ハッシュの合わない記録は数値を出さず、反映しない', async () => {
    const sdb = new SupabaseModeDbClient(db);
    const created = await runCalculation(sdb, author(), { periodId: CY, unitIds: UNITS });
    if (!created.ok) throw new Error('算定できるはず');
    const appended: GhgCalculationLine = {
      ...created.lines[0]!,
      id: fid('ghg_line', `${created.run.id}/appended`),
      unitId: G.units.th,
      emissionsUnrounded: 999_999,
      emissionsRounded: 999_999,
    };
    fixture.ghgCalculationLines.push(appended);
    const loaded = await loadRun(sdb, author(), created.run.id);
    expect(loaded.inputState).toBe('input_changed');
    expect(loaded.run.summary).toBeNull();
    expect(loaded.lines).toEqual([]);
    const plan = await planRunPosting(sdb, author(), created.run.id);
    expect(plan.blockedReason).not.toBeNull();

    const forged = {
      ...structuredClone(fixture.ghgCalculationRuns.find((r) => r.id === G.run)!),
      id: '0a0a0a0a-0000-4000-8000-000000000001',
      inputHash: 'f'.repeat(64),
    };
    fixture.ghgCalculationRuns.push(forged);
    const listed = (await listRuns(sdb, author(), { periodId: CY })).find(
      (r) => r.run.id === forged.id,
    )!;
    expect(listed.inputState).toBe('input_changed');
    expect(listed.run.summary).toBeNull();
  });

  it('結果を書き換えた照合（すべて許容差内）は、作り直した結果で判定する', async () => {
    const sdb = new SupabaseModeDbClient(db);
    const honest = await loadReconciliation(sdb, reviewer(), G.reconciliation);
    const honestOutside = honest.items!.filter((i) => !i.withinTolerance).length;
    expect(honestOutside).toBeGreaterThan(0);
    const stored = fixture.ghgReconciliations.find((r) => r.id === G.reconciliation)!;
    for (const item of stored.result!.items) {
      item.withinTolerance = true;
      item.oneSided = null;
    }
    const loaded = await loadReconciliation(sdb, reviewer(), G.reconciliation);
    expect(loaded.items!.filter((i) => !i.withinTolerance)).toHaveLength(honestOutside);
    const status = await loadGhgVerificationStatus(sdb, author(), { periodId: CY, unitIds: UNITS });
    expect(status.units.some((u) => u.status.reconciliation === 'needs_review')).toBe(true);
  });
});

describe('UUID でない ID は DB に問い合わせず「見つからない」（sec F7・UX-08・pers F4）', () => {
  /** PostgREST と同じく、UUID の列を UUID でない値で引くと例外（22P02）にする */
  function strictUuid(inner: DbClient): DbClient {
    return new Proxy(inner, {
      get(target, key, receiver) {
        if (key === 'findById') {
          return (table: string, id: string) => {
            if (!isUuid(id)) throw new Error('22P02 invalid input syntax for type uuid');
            return (target.findById as (t: string, i: string) => unknown)(table, id);
          };
        }
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
  }
  const approver = () => ctxFor('approver@demo.local', ['approver']);

  it('係数のセット・区分規則・活動量の取込・割当の操作は NotFoundError か入力のエラー（500 にしない）', async () => {
    const sdb = strictUuid(db);
    const bad = 'abc';
    await expect(loadFactorSet(sdb, author(), bad)).rejects.toBeInstanceOf(NotFoundError);
    await expect(activateFactorSet(sdb, author(), bad)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      retireFactorSet(sdb, author(), bad, { reason: '（テスト）' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(approveRule(sdb, approver(), bad)).rejects.toBeInstanceOf(NotFoundError);
    await expect(withdrawRule(sdb, author(), bad, { reason: '（テスト）' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(confirmActivityImport(sdb, author(), bad)).rejects.toBeInstanceOf(NotFoundError);
    await expect(discardActivityBatch(sdb, author(), bad)).rejects.toBeInstanceOf(NotFoundError);
    await expect(clearAssignment(sdb, author(), { assignmentId: bad })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const input = {
      periodId: CY,
      level: 'unit' as const,
      unitId: G.units.th,
      countryCode: null,
      activityKind: 'electricity' as const,
      activityCode: 'grid',
      basis: 'location' as const,
      factorId: ghgFactorId(2024, 'ELEC-LOC-TH'),
      reason: '',
    };
    await expect(saveAssignment(sdb, author(), { ...input, periodId: bad })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(saveAssignment(sdb, author(), { ...input, unitId: bad })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(saveAssignment(sdb, author(), { ...input, factorId: bad })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
