import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { ORG_IDS, PERIOD_IDS, dataPointId, metricId, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS, SCOPE1_CORRECTION } from '@/lib/fixtures/disclosure-first';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { computeConsolidatedAggregation } from '@/lib/services/aggregation';
import {
  computeTargetGap,
  computeTargetProgress,
  loadEsgDashboard,
  loadKpiDetail,
  loadKpiSnapshotComparison,
  parseKpiTargetForm,
  registerKpiTarget,
  targetComparability,
  type KpiCardView,
  type KpiKey,
  type KpiTargetInput,
} from '@/lib/services/kpi';
import { createReviewDraftSnapshot } from '@/lib/services/report-snapshot';
import type { AuthorizationContext, RoleKey, Uuid } from '@/types/domain';

/**
 * ESG 経営ダッシュボード（指示書 §6.11、受入 A08・A09・A12・A13・A14・A33・A34）。
 *
 * KPI は開示で使う Data Point をそのまま使い、承認済みの値だけで計算すること、
 * 目標と実績・前年と当年の条件が違えば率や差を出さないこと、指標の定義を混ぜないこと、
 * スナップショット照合で過去レポートの値を変えずに差と理由を示すことを確かめる。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

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

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const otherTenant = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);

async function card(key: KpiKey, periodId: Uuid = PERIOD_IDS.fy2026): Promise<KpiCardView> {
  const dashboard = await loadEsgDashboard(db, manager(), { periodId });
  const found = dashboard.cards.find((c) => c.spec.key === key);
  if (!found) throw new Error(`card ${key} が無い`);
  return found;
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

// ----------------------------------------------------------------------
// 進捗率の式（純粋関数）
// ----------------------------------------------------------------------

describe('目標の進捗率 (基準値 − 実績) ÷ (基準値 − 目標値)', () => {
  const base = { baseValue: 100, targetValue: 60, direction: 'reduce' as const, comparable: true };

  it('通常の削減目標', () => {
    const result = computeTargetProgress({ ...base, actualValue: 80 });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.rate).toBeCloseTo(50);
  });

  it('分母が 0（基準値 = 目標値）は計算しない', () => {
    const result = computeTargetProgress({ ...base, targetValue: 100, actualValue: 80 });
    expect(result).toMatchObject({ status: 'unavailable', code: 'zero_denominator' });
  });

  it('基準年より悪化した場合は負の値を残し、意味を説明する', () => {
    const result = computeTargetProgress({ ...base, actualValue: 120 });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.rate).toBeCloseTo(-50);
      expect(result.explanation).toContain('負の値');
    }
  });

  it('目標を超えて達成した場合は 100% 超を残し、意味を説明する', () => {
    const result = computeTargetProgress({ ...base, actualValue: 40 });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.rate).toBeCloseTo(150);
      expect(result.explanation).toContain('100% 超');
    }
  });

  it('増加目標も同じ式で向きが揃う', () => {
    const result = computeTargetProgress({
      baseValue: 10,
      targetValue: 30,
      actualValue: 15,
      direction: 'increase',
      comparable: true,
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.rate).toBeCloseTo(25);
  });

  it('基準値が無い・実績が無い・向きが逆・比較条件が違う場合は率を出さない', () => {
    expect(computeTargetProgress({ ...base, baseValue: null, actualValue: 80 })).toMatchObject({
      code: 'no_base',
    });
    expect(computeTargetProgress({ ...base, actualValue: null })).toMatchObject({
      code: 'no_actual',
    });
    expect(computeTargetProgress({ ...base, targetValue: 120, actualValue: 80 })).toMatchObject({
      code: 'direction_mismatch',
    });
    const notComparable = computeTargetProgress({
      ...base,
      actualValue: 80,
      comparable: false,
      comparabilityReasons: ['範囲が違う'],
    });
    expect(notComparable).toMatchObject({ status: 'unavailable', code: 'not_comparable' });
    if (notComparable.status === 'unavailable') {
      expect(notComparable.reason).toContain('比較条件の確認が必要');
    }
  });

  it('目標差は比較条件が同じときだけ出す', () => {
    expect(
      computeTargetGap({ actualValue: 80, targetValue: 60, direction: 'reduce', comparable: true }),
    ).toMatchObject({ status: 'ok', gap: 20 });
    expect(
      computeTargetGap({
        actualValue: 80,
        targetValue: 60,
        direction: 'reduce',
        comparable: false,
      }),
    ).toMatchObject({ status: 'unavailable' });
  });

  it('総量の目標と原単位の実績は比較しない', () => {
    expect(
      targetComparability(
        { boundary: '連結', targetType: 'absolute' },
        {
          boundary: '連結',
          metric: { unit: 't-CO2e/百万円' },
        },
      ).comparable,
    ).toBe(false);
  });
});

// ----------------------------------------------------------------------
// ダッシュボード（最新承認値モード）
// ----------------------------------------------------------------------

describe('Scope1・Scope2 のカード', () => {
  it('実績は GHG 画面と同じ連結値で、全拠点が承認済みの最新年度を使う（集計中の年度は途中値として別に示す）', async () => {
    const scope1 = await card('scope1');
    // FY2026 は欧州販売子会社が提出済み（未承認）のため集計中
    expect(scope1.current?.complete).toBe(false);
    expect(scope1.current?.pendingUnits).toEqual([
      { unitName: '欧州販売子会社', status: 'submitted' },
    ]);
    expect(scope1.dataState.label).toBe('集計中（承認済み 3/4 拠点）');

    // 実績は FY2025（確定）。GHG 画面の連結集計（computeConsolidatedAggregation）と一致する
    const fy2025 = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2025)!;
    const periods = fixture.periods.filter((p) => p.organizationId === ORG_IDS.aomi);
    const ghg = await computeConsolidatedAggregation(db, manager(), fy2025, periods, ['scope1']);
    expect(scope1.confirmed?.period.code).toBe('FY2025');
    expect(scope1.actualValue).toBe(ghg.metrics[0]!.consolidated);
    expect(scope1.actualValue).toBeCloseTo(8931.6);

    // 目標（連結・総量）と同じ条件なので進捗率を出す: (11,200 − 8,931.6) ÷ (11,200 − 7,840)
    expect(scope1.target?.comparable).toBe(true);
    expect(scope1.progress.status).toBe('ok');
    if (scope1.progress.status === 'ok') {
      expect(scope1.progress.rate).toBeCloseTo(((11_200 - 8_931.6) / (11_200 - 7_840)) * 100);
    }
  });

  it('A33: 目標の範囲（単体・国内拠点）と実績の範囲（連結）が違えば達成率を出さない', async () => {
    const scope2 = await card('scope2_market');
    expect(scope2.target?.target.id).toBe(IDS.kpiTargets.scope2Market);
    expect(scope2.target?.comparable).toBe(false);
    expect(scope2.progress).toMatchObject({ status: 'unavailable', code: 'not_comparable' });
    if (scope2.progress.status === 'unavailable') {
      expect(scope2.progress.reason).toContain('比較条件の確認が必要');
      expect(scope2.progress.reason).toContain('単体（国内拠点）');
    }
    expect(scope2.targetGap.status).toBe('unavailable');
  });

  it('A08: Scope2 のマーケット基準とロケーション基準は別のカードで、足し合わせない', async () => {
    const market = await card('scope2_market');
    const location = await card('scope2_location');
    expect(market.metric?.code).toBe('scope2');
    expect(location.metric?.code).toBe('scope2_location');
    // ロケーション基準は未入力。0 として扱わず、マーケット基準の値にも混ぜない
    expect(location.actualValue).toBeNull();
    expect(location.dataState.label).toBe('未入力');
    expect(market.actualValue).toBeCloseTo(3180.2 + 10176.6 + 7632.5 + 1908.1);
  });

  it('A34: 前年と対象拠点・算定方法が同じなら前年差を出し、変わっていれば「比較条件の確認が必要」とする', async () => {
    const before = await card('scope1');
    expect(before.yoy.status).toBe('ok');
    if (before.yoy.status === 'ok') {
      expect(before.yoy.previousPeriod.code).toBe('FY2024');
      expect(before.yoy.diff).toBeCloseTo(8931.6 - 9735.4);
    }

    // FY2025 の東日本工場だけ算定方法を変える（推計へ）
    const east = fixture.dataPoints.find((d) => d.id === dataPointId('EAST', 'scope1', 'FY2025'))!;
    east.methodology = '燃料購入量からの推計';
    const after = await card('scope1');
    expect(after.yoy.status).toBe('needs_check');
    if (after.yoy.status === 'needs_check') {
      expect(after.yoy.reasons.join('')).toContain('東日本工場');
      expect(after.yoy.reasons.join('')).toContain('算定方法');
    }
    // 推移でも非連続として示す
    const detail = await loadKpiDetail(db, manager(), 'scope1');
    const fy2025Row = detail.trend.find((t) => t.period.code === 'FY2025')!;
    expect(fy2025Row.discontinuityReasons.length).toBeGreaterThan(0);
  });

  it('未承認の訂正（承認後に直して未承認に戻った値）を実績に混ぜない', async () => {
    const hq = fixture.dataPoints.find((d) => d.id === dataPointId('HQ', 'scope1', 'FY2025'))!;
    const v1 = fixture.dataPointVersions.find((v) => v.dataPointId === hq.id && v.versionNo === 1)!;
    fixture.dataPointVersions.push({
      ...v1,
      id: 'hq-fy2025-v2',
      versionNo: 2,
      value: 9999,
      status: 'draft',
    });
    hq.currentVersionId = 'hq-fy2025-v2';
    hq.value = 9999;
    hq.status = 'draft';
    hq.changedAfterApproval = true;

    const scope1 = await card('scope1', PERIOD_IDS.fy2025);
    // FY2025 は訂正中で確定していないため、実績は FY2024 の確定値に戻る（9,999 を含めない）
    expect(scope1.current?.unapprovedCorrectionCount).toBe(1);
    expect(scope1.dataState.details.join('')).toContain('未承認の値 1 件は含めていません');
    expect(scope1.confirmed?.period.code).toBe('FY2024');
    expect(scope1.actualValue).toBeCloseTo(9735.4);
  });
});

describe('定義を混ぜない（Scope3・男女賃金・労災）', () => {
  it('A09: Scope3 は合計が未登録なら未算定とし、Cat.1 を Scope3 全体として示さない', async () => {
    const scope3 = await card('scope3');
    expect(scope3.metric?.code).toBe('scope3_total');
    expect(scope3.actualValue).toBeNull();
    expect(scope3.dataState.label).toBe('未入力');
    const cat1 = scope3.subRows.find((r) => r.code === 'scope3_cat1')!;
    // Cat.1 は内部取引控除後の連結値（GHG 画面と同じ）で、カテゴリの行としてだけ示す
    expect(cat1.state?.approvedValue).toBeCloseTo(50_620.5 - 1_850 - 640.5);
    expect(scope3.subRows).toHaveLength(15);
    expect(scope3.subRows.filter((r) => r.state?.hasData).map((r) => r.code)).toEqual([
      'scope3_cat1',
    ]);
  });

  it('A12: 男女賃金は指標の定義（比率）をそのまま示し、格差率へ換算しない', async () => {
    const pay = await card('gender_pay', PERIOD_IDS.fy2025);
    expect(pay.definition).toContain('男性の平均賃金に対する女性の平均賃金の割合');
    expect(pay.spec.note).toContain('自動で換算・同一視しません');
    // 分子・分母が無いため全社値は算定しない（拠点値 76.4 を平均して全社値にしない）
    expect(pay.current?.computable).toBe(false);
    expect(pay.actualValue).toBeNull();
    expect(pay.dataState.label).toBe('全社値は算定できません');
    expect(pay.current?.contributions.map((c) => c.value)).toContain(76.4);
  });

  it('A13・A14: 労災は件数を主にし、度数率（LTIFR）で件数を代替しない。率の全社値は単純平均しない', async () => {
    const safety = await card('occupational_safety', PERIOD_IDS.fy2025);
    expect(safety.metric?.code).toBe('work_related_injuries');
    expect(safety.actualValue).toBeNull();
    expect(safety.dataState.label).toBe('未入力');
    const ltifr = safety.subRows.find((r) => r.code === 'ltifr')!;
    expect(ltifr.state?.hasData).toBe(true);
    expect(ltifr.state?.computable).toBe(false);
    expect(ltifr.state?.approvedValue).toBeNull();
    expect(ltifr.display).toContain('算定できません');
  });
});

// ----------------------------------------------------------------------
// スナップショット照合モード
// ----------------------------------------------------------------------

describe('スナップショット照合モード', () => {
  it('スナップショットが引用した版と最新承認値の差、更新理由を示す（過去の値は変えない）', async () => {
    const snapshot = await createReviewDraftSnapshot(db, manager(), IDS.projects.fy2026);
    const comparison = await loadKpiSnapshotComparison(db, manager(), snapshot.id);
    expect(comparison.snapshot.kindLabel).toBe('レビュー用草稿');
    const row = comparison.rows.scope1.find(
      (r) => r.dataPointId === SCOPE1_CORRECTION.dataPointId,
    )!;
    expect(row.snapshotVersionNo).toBe(1);
    expect(row.snapshotValue).toBe(1190.9);
    expect(row.latestApproved?.versionNo).toBe(2);
    expect(row.differs).toBe(true);
    expect(row.reasons.join('')).toContain(SCOPE1_CORRECTION.changeReason);
    // 引用していない KPI には行を作らない
    expect(comparison.rows.scope2_location).toEqual([]);
  });

  it('A29: 他テナントのスナップショットは照合できない', async () => {
    const snapshot = await createReviewDraftSnapshot(db, manager(), IDS.projects.fy2026);
    await expect(loadKpiSnapshotComparison(db, otherTenant(), snapshot.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

// ----------------------------------------------------------------------
// 目標の登録（追記専用の版）
// ----------------------------------------------------------------------

describe('目標の登録', () => {
  const input = (overrides: Partial<KpiTargetInput> = {}): KpiTargetInput => ({
    targetKey: null,
    metricId: metricId('AOMI', 'scope1'),
    boundary: '連結',
    scopeNote: '連結子会社を含む',
    baseYear: 2024,
    baseValue: 9735.4,
    targetYear: 2035,
    targetValue: 5000,
    targetType: 'absolute',
    direction: 'reduce',
    methodologyNote: 'GHG プロトコル（架空）',
    ownerUserId: userId('sustainability@demo.local'),
    revisionReason: null,
    ...overrides,
  });

  it('指標マスターの管理権限が無い利用者は登録できない', async () => {
    await expect(registerKpiTarget(db, reviewer(), input())).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it('新規は版 1、改訂は理由付きで次の版を追記し、以前の版は変えない', async () => {
    const first = await registerKpiTarget(db, manager(), input());
    expect(first.versionNo).toBe(1);
    expect(first.targetKey).toBe('scope1_reduce_2035');

    await expect(
      registerKpiTarget(db, manager(), input({ targetKey: first.targetKey, targetValue: 4500 })),
    ).rejects.toThrow(/改訂の理由/);

    const second = await registerKpiTarget(
      db,
      manager(),
      input({
        targetKey: first.targetKey,
        targetValue: 4500,
        revisionReason: '中期経営計画の改定',
      }),
    );
    expect(second.versionNo).toBe(2);
    expect(second.revisionReason).toBe('中期経営計画の改定');
    const stored = fixture.kpiTargets.filter((t) => t.targetKey === first.targetKey);
    expect(stored.map((t) => [t.versionNo, t.targetValue])).toEqual([
      [1, 5000],
      [2, 4500],
    ]);
    expect(fixture.auditEvents.filter((e) => e.resourceType === 'kpi_target')).toHaveLength(2);
  });

  it('向きと矛盾する目標値・基準年より前の目標年・他組織の指標を受け付けない', async () => {
    await expect(
      registerKpiTarget(db, manager(), input({ targetValue: 12_000 })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      registerKpiTarget(db, manager(), input({ targetYear: 2020 })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      registerKpiTarget(db, manager(), input({ metricId: metricId('SOTEN', 'scope1') })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('フォームの数値は単位や文字が混じった値を黙って数値にしない', () => {
    const form = (values: Record<string, string>) => (key: string) => values[key] ?? '';
    const base = {
      metricId: 'm',
      boundary: '連結',
      targetType: 'absolute',
      direction: 'reduce',
      targetYear: '2030',
      targetValue: '7,840',
    };
    expect(parseKpiTargetForm(form(base)).targetValue).toBe(7840);
    expect(() => parseKpiTargetForm(form({ ...base, targetValue: '7840t' }))).toThrow(
      ValidationError,
    );
    expect(() => parseKpiTargetForm(form({ ...base, targetYear: '2030.5' }))).toThrow(
      ValidationError,
    );
    expect(parseKpiTargetForm(form(base)).baseValue).toBeNull();
  });
});
