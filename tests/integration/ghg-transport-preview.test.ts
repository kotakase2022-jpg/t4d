import { beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '@/lib/authorization/can';
import { CO2_PER_C } from '@/lib/domain/ghg/fuel-co2';
import { roundSignificant } from '@/lib/domain/ghg/rounding';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { GHG_FIXTURE_IDS, ghgBatchId } from '@/lib/fixtures/ghg-verification';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  previewTransportCalculation,
  trialWarningLabel,
  type TrialResult,
} from '@/lib/services/ghg/transport-preview';
import type { AuthorizationContext, RoleKey, Uuid } from '@/types/domain';
import { WriteDetectingDbClient } from '../support/write-detecting-db';

/**
 * 活動量のバッチの試算（plan §2.3 transport-preview.ts・P95・int:ghg-transport-preview）。
 *  - 書き込み 0（読むだけ）。閲覧の権限で見られ、他の組織のバッチは「見つかりません」
 *  - 算定のエンジンと同じ計算（Fixture の算定の記録 R-1 の算定行と同じ値）
 *  - t·km → 原単位（式／見なし積載率の原単位表・積載率の出所）→ 燃料 L → CO2 の段を行ごとに返す
 *  - 見なし積載率・下限・最大積載量の範囲外・海外拠点の印を数える。算定方針が無ければ試算しない
 */

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

function ctxFor(email: string, roleKeys: RoleKey[], organizationId: Uuid = ORG_IDS.aomi) {
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
  } satisfies AuthorizationContext;
}

const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const other = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);

const TRANSPORT = ghgBatchId('EAST', 'transport');

function resultsOf(
  trial: Awaited<ReturnType<typeof previewTransportCalculation>>['trial'],
  lineNo: number,
): TrialResult[] {
  const line = fixture.ghgActivityLines.find(
    (l) => l.batchId === TRANSPORT && l.lineNo === lineNo,
  )!;
  return trial.lines.find((t) => t.activityLineId === line.id)!.results;
}

describe('previewTransportCalculation', () => {
  it('書き込み 0。閲覧の権限（レビュー担当）で見られる', async () => {
    const guard = new WriteDetectingDbClient(db);
    const { batch, trial } = await previewTransportCalculation(guard, reviewer(), TRANSPORT);
    expect(guard.writes).toEqual([]);
    expect(batch.id).toBe(TRANSPORT);
    expect(trial.lines).toHaveLength(36);
    expect(trial.counts).toMatchObject({
      lines: 36,
      calculated: 36,
      errors: 0,
      defaultLoad: 4,
      floored: 1,
      payloadOutOfRange: 1,
      loadCapped: 0,
      overseas: 0,
    });
  });

  it('他の組織のバッチは「見つかりません」', async () => {
    await expect(previewTransportCalculation(db, other(), TRANSPORT)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('算定の記録 R-1 の算定行と同じ値（試算と算定が食い違わない）', async () => {
    const { trial } = await previewTransportCalculation(db, reviewer(), TRANSPORT);
    const recorded = fixture.ghgCalculationLines.filter((l) => l.runId === GHG_FIXTURE_IDS.run);
    expect(recorded.length).toBeGreaterThan(0);
    for (const t of trial.lines) {
      const expected = recorded.filter((l) => l.activityLineId === t.activityLineId);
      expect(t.results.map((r) => r.emissionsT)).toEqual(expected.map((l) => l.emissionsUnrounded));
      expect(t.results.map((r) => r.warnings)).toEqual(expected.map((l) => l.warnings));
    }
  });

  it('積載率が分かる行: t·km（重量 × 距離）→ 告示の形の原単位（有効 3 桁）→ 燃料 L → 2 段係数で CO2', async () => {
    const { trial } = await previewTransportCalculation(db, reviewer(), TRANSPORT);
    // 委託物流の 1 行目（2.2t × 180km・4,000kg・55%・燃費基準未確認）は 13 行目（自社便 12 行の後）
    const [r] = resultsOf(trial, 13);
    expect(r).toBeDefined();
    const t = r!.transport!;
    expect(r!.method).toBe('tonkm_improved');
    expect(t.tonKmSource).toBe('weight_distance');
    expect(t.tonKm).toBeCloseTo(396, 9);
    expect(t).toMatchObject({
      intensitySource: 'formula',
      shape: 'kokuji',
      loadFactorUsed: 55,
      loadFactorSource: 'measured',
      overseas: false,
    });
    // 架空の係数（A 14.8・B 0.651・S 0.809）で告示の形
    expect(t.coefficients).toMatchObject({ A: 14.8, B: 0.651, S: 0.809 });
    expect(t.intensityRaw).toBeCloseTo(14.8 / 0.55 ** 0.809 / 4000 ** 0.651, 12);
    expect(t.intensity).toBe(roundSignificant(t.intensityRaw, 3, 'half_up'));
    expect(t.fuelLiters).toBeCloseTo(t.tonKm * t.intensity, 9);
    expect(r!.convertedUnit).toBe('kL');
    expect(r!.convertedAmount).toBeCloseTo(t.fuelLiters / 1000, 12);
    const fuel = r!.fuel!;
    expect(r!.emissionsT).toBeCloseTo(
      r!.convertedAmount * fuel.calorificValue * fuel.carbonFactor * CO2_PER_C,
      12,
    );
    expect(r!.protocolScope).toBe('scope3_cat4');
    expect(r!.factorSetCode).toBe('ORG-2025');
  });

  it('積載率 5% の行は下限 10% で算定し、「下限を適用」の印を付ける', async () => {
    const { trial } = await previewTransportCalculation(db, reviewer(), TRANSPORT);
    const floored = trial.lines
      .flatMap((l) => l.results)
      .filter((r) => r.transport?.loadFactorSource === 'floored');
    expect(floored).toHaveLength(1);
    expect(floored[0]!.transport!.loadFactorUsed).toBe(10);
    expect(floored[0]!.warnings).toContain('load_floored');
    expect(trialWarningLabel('load_floored')).toBe('積載率の下限を適用');
  });

  it('積載率が無い行は見なし積載率の原単位表（架空の表の値）', async () => {
    const { trial } = await previewTransportCalculation(db, reviewer(), TRANSPORT);
    // 委託物流の 3 行目（1.8t × 95km・3,000kg・積載率なし・未確認）は 15 行目
    const [r] = resultsOf(trial, 15);
    expect(r!.transport).toMatchObject({
      intensitySource: 'default_table',
      loadFactorSource: 'default',
      loadFactorUsed: 33,
      intensityRaw: 0.195,
      shape: null,
    });
    expect(r!.warnings).toEqual(['default_load_factor']);
  });

  it('最大積載量 25,000kg の行は組織の範囲（〜20,500kg）の外として警告して算定する', async () => {
    const { trial } = await previewTransportCalculation(db, reviewer(), TRANSPORT);
    const out = trial.lines
      .flatMap((l) => l.results)
      .filter((r) => r.warnings.includes('payload_out_of_range'));
    expect(out).toHaveLength(1);
    expect(out[0]!.transport!.tonKm).toBeCloseTo(11.3 * 410, 9);
  });

  it('自社便の燃料（燃料法）は原単位の段が無く、燃料の量から CO2（既定区分 Scope1）', async () => {
    const { trial } = await previewTransportCalculation(db, reviewer(), TRANSPORT);
    const [r] = resultsOf(trial, 1);
    expect(r!.method).toBe('fuel_method');
    expect(r!.transport).toBeNull();
    expect(r!.fuel).not.toBeNull();
    expect(r!.activityUnit).toBe('L');
    expect(r!.protocolScope).toBe('scope1');
  });

  it('電力は 2 基準の 2 行。既定区分の合計は Scope2 の 2 基準を足さずに別に持つ', async () => {
    const { trial } = await previewTransportCalculation(
      db,
      reviewer(),
      ghgBatchId('EAST', 'energy'),
    );
    const electricity = trial.lines.find((l) => l.results.some((r) => r.basis === 'location'))!;
    expect(electricity.results.map((r) => r.basis)).toEqual(['location', 'market']);
    expect(trial.totalsByProtocolScope.scope2_location).toBeGreaterThan(0);
    expect(trial.totalsByProtocolScope.scope2).toBeGreaterThan(0);
    expect(trial.totalsByProtocolScope.scope2).not.toBe(
      trial.totalsByProtocolScope.scope2_location,
    );
  });

  it('海外拠点の輸送: 組織の設定が「警告」なら印を付けて算定、「止める」なら試算しない（理由を出す）', async () => {
    // 東日本工場の輸送の行をタイ工場の確認中のバッチとして置く（試算はバッチの状態を問わない）
    const batchId = '0b000000-0000-4000-8000-0000000000b1';
    fixture.ghgActivityBatches.push({
      ...fixture.ghgActivityBatches.find((b) => b.id === TRANSPORT)!,
      id: batchId,
      unitId: GHG_FIXTURE_IDS.units.th,
      source: 'upload',
      status: 'draft',
      confirmedBy: null,
      confirmedAt: null,
    });
    const shipments = fixture.ghgActivityLines.filter(
      (l) => l.batchId === TRANSPORT && l.activityCode === 'contracted',
    );
    fixture.ghgActivityLines.push(
      ...shipments.slice(0, 3).map((l, i) => ({ ...l, id: `${batchId}-${i}`, batchId })),
    );
    const warn = await previewTransportCalculation(db, reviewer(), batchId);
    expect(warn.trial.counts).toMatchObject({ lines: 3, overseas: 3, errors: 0 });
    expect(warn.trial.lines[0]!.results[0]!.transport!.overseas).toBe(true);

    const policy = fixture.ghgCalculationPolicies.find((p) => p.id === GHG_FIXTURE_IDS.policy)!;
    policy.tonkm = { ...policy.tonkm, overseas: 'block' };
    const blocked = await previewTransportCalculation(db, reviewer(), batchId);
    expect(blocked.trial.counts).toMatchObject({ calculated: 0, errors: 3 });
    expect(blocked.trial.lines[0]!.error).toBe(
      '海外拠点の輸送です（組織の設定で改良トンキロ法を止めています）',
    );
  });

  it('算定方針が無い期間は試算しない（全行に理由。代わりの設定を使わない）', async () => {
    fixture.ghgCalculationPolicies.splice(0, fixture.ghgCalculationPolicies.length);
    const { trial } = await previewTransportCalculation(db, reviewer(), TRANSPORT);
    expect(trial.policy).toBeNull();
    expect(trial.counts).toMatchObject({ calculated: 0, errors: 36 });
    expect(trial.lines[0]!.error).toContain('算定方針');
  });

  it('係数が割り当てられていない行は試算できない理由を行に出す（ほかの行は試算する）', async () => {
    const assignment = fixture.emissionFactorAssignments.find(
      (a) =>
        a.reportingPeriodId === GHG_FIXTURE_IDS.period &&
        a.activityKind === 'transport_default' &&
        a.unitId === null,
    )!;
    fixture.emissionFactorAssignments.splice(
      fixture.emissionFactorAssignments.indexOf(assignment),
      1,
    );
    const { trial } = await previewTransportCalculation(db, reviewer(), TRANSPORT);
    expect(trial.counts.errors).toBe(4);
    expect(trial.counts.calculated).toBe(32);
    const failed = trial.lines.find((l) => l.error)!;
    expect(failed.results).toEqual([]);
    expect(failed.error).toContain('見なし積載率の原単位表');
  });
});
