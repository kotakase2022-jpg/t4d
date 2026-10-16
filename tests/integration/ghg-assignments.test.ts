import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { GHG_FIXTURE_IDS, ghgBatchId, ghgFactorId } from '@/lib/fixtures/ghg-verification';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  clearAssignment,
  factorFits,
  listAssignmentNeeds,
  needKey,
  saveAssignment,
  type SaveAssignmentInput,
} from '@/lib/services/ghg/assignments';
import { loadGhgVerificationStatus } from '@/lib/services/ghg/status';
import type { AuthorizationContext, OrganizationType, RoleKey, Uuid } from '@/types/domain';

/**
 * 係数の割当（plan §2.3 assignments.ts・CR-02・int:ghg-assignments）。
 *  - 必要な割当は活動量から導き、拠点 ＞ 国 ＞ 全社既定で解決する（経路を文で示す。代わりを使わない）
 *  - 割り当てられるのは有効なセットの、種類・活動・基準・国が合う係数だけ
 *  - 締めた期間は変えない。書けるのは enterprise.metric.manage
 *  - Demo Mode では Fixture の割当は外せない（割り当て直しはできる）
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

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const other = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], [], ORG_IDS.soten);

const CY = GHG_FIXTURE_IDS.period;
const TH = GHG_FIXTURE_IDS.units.th;

function input(over: Partial<SaveAssignmentInput>): SaveAssignmentInput {
  return {
    periodId: CY,
    level: 'unit',
    unitId: TH,
    countryCode: null,
    activityKind: 'electricity',
    activityCode: 'grid',
    basis: 'location',
    factorId: ghgFactorId(2024, 'ELEC-LOC-TH'),
    reason: '（架空）タイ工場は前年版で算定する',
    ...over,
  };
}

describe('listAssignmentNeeds', () => {
  it('Fixture の活動量から必要な割当を導き、すべて解決する（経路は 拠点 ＞ 国 ＞ 全社既定）', async () => {
    const overview = await listAssignmentNeeds(db, reviewer(), { periodId: CY });
    expect(overview.needs.length).toBeGreaterThan(0);
    expect(overview.needs.filter((n) => n.error)).toEqual([]);
    const thLocation = overview.needs.find(
      (n) => n.key === needKey(TH, 'electricity', 'grid', 'location'),
    )!;
    expect(thLocation.label).toBe('電力（ロケーション基準）');
    expect(thLocation.resolution).toMatchObject({ path: 'country' });
    expect(thLocation.resolution!.description).toBe(
      '国の割当（TH・電力（ロケーション基準）・2025 年版）',
    );
    expect(thLocation.lineCount).toBe(12);
    const eastMarket = overview.needs.find(
      (n) => n.key === needKey(UNIT_IDS.east, 'electricity', 'EAST-GREEN-01', 'market'),
    )!;
    expect(eastMarket.label).toBe('電力（マーケット基準・契約 EAST-GREEN-01）');
    expect(eastMarket.resolution).toMatchObject({ path: 'unit' });
    const transport = overview.needs.filter((n) => n.activityKind.startsWith('transport'));
    expect(transport.map((n) => n.activityKind).sort()).toEqual([
      'transport_default',
      'transport_formula',
    ]);
    // 割り当てられる係数は有効なセットの係数（2 つのセット × 12）
    expect(overview.candidates).toHaveLength(24);
    expect(overview.assignments.every((a) => !a.removable && a.removeBlockedReason)).toBe(true);
  });

  it('割当を外すと「未割当」になり、概要の要対応の件数（status.ts）と同じ規則で数える', async () => {
    const index = fixture.emissionFactorAssignments.findIndex(
      (a) => a.countryCode === 'TH' && a.basis === 'location',
    );
    fixture.emissionFactorAssignments.splice(index, 1);
    const overview = await listAssignmentNeeds(db, reviewer(), { periodId: CY });
    const unresolved = overview.needs.filter((n) => n.error);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]).toMatchObject({
      error: 'not_assigned',
      errorLabel: '係数が割り当てられていません',
    });
    const status = await loadGhgVerificationStatus(db, reviewer(), {
      periodId: CY,
      unitIds: [TH],
    });
    expect(status.attention.unresolvedLines).toBe(unresolved[0]!.lineCount);
  });

  it('確定していないバッチの数を返す（確定すると必要な割当に出る）', async () => {
    const batch = fixture.ghgActivityBatches.find((b) => b.id === ghgBatchId('TH1', 'energy'))!;
    batch.status = 'draft';
    const overview = await listAssignmentNeeds(db, reviewer(), { periodId: CY });
    expect(overview.draftBatches).toBe(1);
    expect(overview.needs.some((n) => n.unit.id === TH && n.activityKind === 'electricity')).toBe(
      false,
    );
  });
});

describe('saveAssignment', () => {
  it('拠点の割当を足すと国の割当より優先される（前年版の係数・本人名義・監査ログ）', async () => {
    const saved = await saveAssignment(db, manager(), input({}));
    expect(saved).toMatchObject({
      unitId: TH,
      countryCode: null,
      factorId: ghgFactorId(2024, 'ELEC-LOC-TH'),
      createdBy: userId('sustainability@demo.local'),
    });
    const overview = await listAssignmentNeeds(db, reviewer(), { periodId: CY });
    const need = overview.needs.find(
      (n) => n.key === needKey(TH, 'electricity', 'grid', 'location'),
    )!;
    expect(need.resolution).toMatchObject({ path: 'unit' });
    expect(need.resolution!.description).toBe(
      '拠点の割当（タイ工場・電力（ロケーション基準）・2024 年版）',
    );
    const audit = fixture.auditEvents.find((e) => e.resourceId === saved.id)!;
    expect(audit).toMatchObject({
      eventType: 'settings_changed',
      resourceType: 'emission_factor_assignment',
    });
    expect(overview.assignments.find((a) => a.assignment.id === saved.id)).toMatchObject({
      level: 'unit',
      targetLabel: 'タイ工場',
      removable: true,
    });
  });

  it('同じ範囲・活動の割当は差し替える（行を増やさない）。同じ内容は断る', async () => {
    const before = fixture.emissionFactorAssignments.length;
    const existing = fixture.emissionFactorAssignments.find(
      (a) =>
        a.activityKind === 'fuel' && a.activityCode === 'diesel' && !a.unitId && !a.countryCode,
    )!;
    const saved = await saveAssignment(
      db,
      manager(),
      input({
        level: 'org_default',
        unitId: null,
        activityKind: 'fuel',
        activityCode: 'diesel',
        basis: null,
        factorId: ghgFactorId(2024, 'DIESEL'),
        reason: '（架空）燃料は前年版',
      }),
    );
    expect(saved.id).toBe(existing.id);
    expect(saved.factorId).toBe(ghgFactorId(2024, 'DIESEL'));
    expect(fixture.emissionFactorAssignments).toHaveLength(before);
    await expect(
      saveAssignment(
        db,
        manager(),
        input({
          level: 'org_default',
          unitId: null,
          activityKind: 'fuel',
          activityCode: 'diesel',
          basis: null,
          factorId: ghgFactorId(2024, 'DIESEL'),
          reason: '（架空）燃料は前年版',
        }),
      ),
    ).rejects.toThrow(/同じです/);
  });

  it('種類・活動・基準・国が合わない係数は割り当てない（黙って代えない）', async () => {
    await expect(
      saveAssignment(
        db,
        manager(),
        input({
          activityKind: 'fuel',
          activityCode: 'diesel',
          basis: null,
          factorId: ghgFactorId(2025, 'GASOLINE'),
        }),
      ),
    ).rejects.toThrow(/使えません（種類・活動・基準が違います）/);
    await expect(
      saveAssignment(db, manager(), input({ factorId: ghgFactorId(2025, 'ELEC-LOC-VN') })),
    ).rejects.toThrow(/VN の係数です/);
    await expect(
      saveAssignment(
        db,
        manager(),
        input({ basis: 'market', factorId: ghgFactorId(2025, 'ELEC-LOC-TH') }),
      ),
    ).rejects.toThrow(/使えません/);
    await expect(saveAssignment(db, manager(), input({ basis: null }))).rejects.toThrow(/基準/);
    await expect(
      saveAssignment(db, manager(), input({ level: 'country', unitId: null, countryCode: 'THA' })),
    ).rejects.toThrow(/ISO 3166-1/);
  });

  it('マーケット基準は契約の係数か組織の代替値（grid）を割り当てられる', () => {
    const residual = {
      activityKind: 'electricity' as const,
      activityCode: 'grid',
      basis: 'market' as const,
    };
    expect(factorFits(residual, 'electricity', 'PLANT-01', 'market')).toBe(true);
    expect(factorFits(residual, 'electricity', 'PLANT-01', 'location')).toBe(false);
    expect(
      factorFits(
        { activityKind: 'fuel', activityCode: 'diesel', basis: null },
        'fuel',
        'gasoline',
        null,
      ),
    ).toBe(false);
  });

  it('有効でないセットの係数・締めた期間・権限の無い人・他社は断る', async () => {
    const set = fixture.emissionFactorSets.find((s) => s.id === GHG_FIXTURE_IDS.sets.org2024)!;
    set.status = 'retired';
    set.retiredAt = new Date().toISOString();
    set.retiredBy = userId('sustainability@demo.local');
    await expect(saveAssignment(db, manager(), input({}))).rejects.toThrow(
      /有効なセットの係数だけ/,
    );
    await expect(
      saveAssignment(
        db,
        manager(),
        input({ periodId: PERIOD_IDS.fy2025, factorId: ghgFactorId(2025, 'ELEC-LOC-TH') }),
      ),
    ).rejects.toThrow(/締めた期間/);
    await expect(saveAssignment(db, reviewer(), input({}))).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(saveAssignment(db, other(), input({}))).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('clearAssignment', () => {
  it('利用者が作った割当は外せる（国の割当へ戻る）。Fixture の割当は Demo では外せない', async () => {
    const saved = await saveAssignment(db, manager(), input({}));
    await clearAssignment(db, manager(), { assignmentId: saved.id });
    expect(fixture.emissionFactorAssignments.some((a) => a.id === saved.id)).toBe(false);
    const overview = await listAssignmentNeeds(db, reviewer(), { periodId: CY });
    const need = overview.needs.find(
      (n) => n.key === needKey(TH, 'electricity', 'grid', 'location'),
    )!;
    expect(need.resolution).toMatchObject({ path: 'country' });
    const fixtureRow = fixture.emissionFactorAssignments[0]!;
    await expect(clearAssignment(db, manager(), { assignmentId: fixtureRow.id })).rejects.toThrow(
      /デモの初期データの割当は外せません/,
    );
    await expect(
      clearAssignment(db, reviewer(), { assignmentId: fixtureRow.id }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});
