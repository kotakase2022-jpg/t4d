import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError } from '@/lib/authorization/can';
import { DEMO_PEERS } from '@/lib/benchmarks/demo-peers';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, metricId, userId } from '@/lib/fixtures/dataset';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import type { BenchmarkMetricKey } from '@/lib/domain/benchmark';
import { loadBenchmark, type BenchmarkRow } from '@/lib/services/analysis/benchmark';
import type { AuthorizationContext, RoleKey, Uuid } from '@/types/domain';
import { WriteDetectingDbClient } from '../support/write-detecting-db';

/**
 * 他社比較（docs/disclosure-first.md §9.5）。
 *  - 比較データは Demo Mode のときだけ（source='demo'）。Supabase 相当（source='none'）は空
 *  - 自社の値は FY2025 の確定値（全拠点が承認済み・連結・持分調整後）。比率は加重平均のみ
 *  - 比較できない社は理由つきで集計から外す。中央値は 3 社以上。順位・総合スコアは無い
 *  - 他テナントの値を使わない。読込は書かない
 */

let fixture: FixtureDb;
let db: DemoDbClient;

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  organizationId: Uuid = ORG_IDS.aomi,
  organizationType: 'enterprise' | 'assurance_firm' = 'enterprise',
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
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const viewer = () => ctxFor('approver@demo.local', ['viewer']);
const otherTenant = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

async function rows(ctx = manager()): Promise<Map<BenchmarkMetricKey, BenchmarkRow>> {
  const view = await loadBenchmark(db, ctx, { source: 'demo' });
  if (view.source !== 'demo') throw new Error('demo の比較データが返らない');
  return new Map(view.rows.map((r) => [r.metric.key, r]));
}

function comparablePeerIds(row: BenchmarkRow): string[] {
  return row.peers.filter((c) => c.disclosed && c.comparability?.comparable).map((c) => c.peer.id);
}

describe('比較データの出どころ', () => {
  it('Demo Mode では架空の 5 社・12 指標を返し、年度は FY2025（自社も FY2025・3 月決算）', async () => {
    const view = await loadBenchmark(db, manager(), { source: 'demo' });
    expect(view.source).toBe('demo');
    if (view.source !== 'demo') return;
    expect(view.fiscalYear).toBe('FY2025');
    expect(view.ownPeriod?.id).toBe(PERIOD_IDS.fy2025);
    expect(view.ownFiscalYearEndMonth).toBe(3);
    expect(view.peers.map((p) => p.name)).toEqual(DEMO_PEERS.map((p) => p.name));
    expect(view.rows).toHaveLength(12);
  });

  it('Supabase 相当（比較データなし）は空で、DB を読まない', async () => {
    const reads: string[] = [];
    const spy = new WriteDetectingDbClient(db);
    const original = spy.select.bind(spy);
    spy.select = ((table: never, query?: never) => {
      reads.push(String(table));
      return original(table, query);
    }) as typeof spy.select;
    const view = await loadBenchmark(spy, manager(), { source: 'none' });
    expect(view).toEqual({ source: 'none' });
    expect(reads).toEqual([]);
  });
});

describe('自社の値（FY2025 の確定値）', () => {
  it('Scope1 は連結値（持分法の合弁会社を含めない）・境界は連結', async () => {
    const scope1 = (await rows()).get('scope1')!;
    expect(scope1.own).toMatchObject({
      status: 'confirmed',
      value: 8931.6,
      conditions: { unit: 't-CO2e', boundary: '連結', fiscalYear: 'FY2025', fiscalYearEndMonth: 3 },
      approvedUnitCount: 4,
      expectedUnitCount: 4,
    });
  });

  it('比率は分子・分母の合計からの加重平均だけを使う（拠点の比率の単純合計を使わない）', async () => {
    const map = await rows();
    // 女性役員比率: 女性役員数 ÷ 役員総数 = 16.67%（比率の行の単純合計 16.7 ではない）
    expect(map.get('female_officer_ratio')!.own).toMatchObject({
      status: 'confirmed',
      value: 16.67,
    });
    expect(map.get('female_manager_ratio')!.own.value).toBe(15);
  });

  it('分子・分母の無い比率（賃金・LTIFR・離職率）は「全社値は算定不可」で値を出さない', async () => {
    const map = await rows();
    for (const key of ['gender_pay', 'ltifr', 'turnover'] as const) {
      const own = map.get(key)!.own;
      expect(own.status, key).toBe('not_computable');
      expect(own.value, key).toBeNull();
      expect(own.label, key).toBe('全社値は算定不可');
    }
    // 拠点の比率を足した 305.6 を全社値として出さない
    expect(JSON.stringify(map.get('gender_pay'))).not.toContain('305.6');
    // 直す画面: 分子・分母を登録する指標マスター
    expect(map.get('ltifr')!.own.fix).toEqual({
      label: '指標マスター（分子・分母の登録）',
      href: '/enterprise/organizations',
    });
    expect(map.get('scope1')!.own.fix).toBeNull();
  });

  it('値の無い指標は「未算定」（0 にしない）。Scope3 合計は Cat.1 で代えない', async () => {
    const map = await rows();
    for (const key of ['scope2_location', 'scope3_total'] as const) {
      expect(map.get(key)!.own, key).toMatchObject({
        status: 'not_calculated',
        value: null,
        label: '未算定',
      });
      expect(map.get(key)!.own.fix!.href, key).toMatch(/^\/enterprise\/data\?metric=/);
      // データの一覧はヘッダーで選んだ年度を出すため、比較の年度（FY2025）をリンクの名前で示す
      expect(map.get(key)!.own.fix!.label, key).toBe(
        'この指標のデータ（FY2025。年度は画面上部で選択）',
      );
    }
  });

  it('全拠点が承認済みでない年度の値は比較に使わない（集計中）', async () => {
    // FY2025 の東日本工場の Scope1 を未承認に戻す
    const metric = fixture.metrics.find(
      (m) => m.organizationId === ORG_IDS.aomi && m.code === 'scope1',
    )!;
    const dp = fixture.dataPoints.find(
      (d) =>
        d.metricId === metric.id &&
        d.reportingPeriodId === PERIOD_IDS.fy2025 &&
        d.unitId === UNIT_IDS.east,
    )!;
    dp.status = 'in_review';
    const scope1 = (await rows()).get('scope1')!;
    expect(scope1.own).toMatchObject({
      status: 'incomplete',
      value: null,
      approvedUnitCount: 3,
      expectedUnitCount: 4,
    });
    expect(scope1.own.label).toBe('集計中（承認済み 3/4 拠点）');
  });
});

describe('比較の可否と集計', () => {
  it('Scope1: B（12 月決算）と C（単体）は理由つきで対象外、A・D・E の 3 社で中央値と範囲', async () => {
    const scope1 = (await rows()).get('scope1')!;
    expect(comparablePeerIds(scope1)).toEqual(['peer-a', 'peer-d', 'peer-e']);
    const cell = (id: string) => scope1.peers.find((c) => c.peer.id === id)!;
    expect(cell('peer-b').comparability!.reasons.map((r) => r.factor)).toEqual(['fiscal_year_end']);
    expect(cell('peer-c').comparability!.reasons.map((r) => r.factor)).toEqual(['boundary']);
    expect(scope1.stats).toMatchObject({ n: 3, median: 12400, min: 9760, max: 15300 });
    expect(scope1.notComparableCount).toBe(2);
    expect(scope1.undisclosedCount).toBe(0);
    expect(scope1.peerTotal).toBe(5);
  });

  it('Scope2（マーケット）: D は未開示（0 にしない）、比較できるのは 2 社なので中央値なし', async () => {
    const row = (await rows()).get('scope2_market')!;
    expect(row.peers.find((c) => c.peer.id === 'peer-d')!.disclosed).toBe(false);
    expect(row.undisclosedCount).toBe(1);
    expect(row.stats).toMatchObject({ n: 2, median: null, min: 25100, max: 31200 });
    expect(row.stats.medianOmittedReason).toContain('2 社');
  });

  it('男女の賃金: D の格差率は換算せず対象外。自社は算定不可でも条件の揃う社の分布は示す', async () => {
    const row = (await rows()).get('gender_pay')!;
    const d = row.peers.find((c) => c.peer.id === 'peer-d')!;
    expect(d.comparability!.reasons.map((r) => r.factor)).toEqual(['method']);
    expect(d.value!.value).toBe(26.3);
    expect(comparablePeerIds(row)).toEqual(['peer-a', 'peer-e']);
    expect(row.stats).toMatchObject({ n: 2, median: null, min: 72.8, max: 74.1 });
  });

  it('LTIFR: D の 20 万時間当たりは換算せず対象外（値 0.18 のまま）', async () => {
    const row = (await rows()).get('ltifr')!;
    const d = row.peers.find((c) => c.peer.id === 'peer-d')!;
    expect(d.comparability!.reasons.map((r) => r.factor)).toEqual(['unit']);
    expect(d.value).toMatchObject({ value: 0.18, unit: '件/20万時間' });
    expect(row.stats.n).toBe(2);
  });

  it('自社の承認済みデータが無い指標（Scope2 ロケーション）は範囲を確かめられず、比較できる社は 0', async () => {
    const row = (await rows()).get('scope2_location')!;
    expect(row.stats).toMatchObject({ n: 0, median: null, min: null, max: null });
    for (const cell of row.peers.filter((c) => c.disclosed)) {
      expect(cell.comparability!.reasons.map((r) => r.factor)).toContain('boundary');
    }
  });

  it('女性管理職比率は 3 社で中央値（A・D・E）', async () => {
    const row = (await rows()).get('female_manager_ratio')!;
    expect(comparablePeerIds(row)).toEqual(['peer-a', 'peer-d', 'peer-e']);
    expect(row.stats).toMatchObject({ n: 3, median: 12.4, min: 11, max: 14.2 });
  });

  it('順位・総合スコア・準拠率を返さない', async () => {
    const view = await loadBenchmark(db, manager(), { source: 'demo' });
    const json = JSON.stringify(view);
    expect(json).not.toMatch(/"(rank|ranking|score|totalScore|percentile)"/);
    expect(json).not.toContain('準拠率');
  });
});

describe('テナントと権限', () => {
  it('他テナントの値を使わない（自社の値は自組織のデータだけから求める）', async () => {
    // 蒼天マテリアル（別テナント）に FY2025 の承認済み Scope1 を置く
    const sotenPeriodId = fid('period', 'SOTEN/FY2025-test');
    const aomiFy2025 = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2025)!;
    fixture.periods.push({ ...aomiFy2025, id: sotenPeriodId, organizationId: ORG_IDS.soten });
    const aomiScope1 = fixture.metrics.find(
      (m) => m.organizationId === ORG_IDS.aomi && m.code === 'scope1',
    )!;
    const aomiDp = fixture.dataPoints.find(
      (d) => d.metricId === aomiScope1.id && d.reportingPeriodId === PERIOD_IDS.fy2025,
    )!;
    fixture.dataPoints.push({
      ...aomiDp,
      id: fid('data_point', 'SOTEN/scope1-test'),
      organizationId: ORG_IDS.soten,
      metricId: metricId('SOTEN', 'scope1'),
      unitId: UNIT_IDS.sotenHq,
      reportingPeriodId: sotenPeriodId,
      value: 777777,
      boundary: '連結',
      status: 'approved',
    });

    const aomi = await loadBenchmark(db, manager(), { source: 'demo' });
    expect(JSON.stringify(aomi)).not.toContain('777777');
    expect((await rows()).get('scope1')!.own.value).toBe(8931.6);

    const soten = await loadBenchmark(db, otherTenant(), { source: 'demo' });
    if (soten.source !== 'demo') throw new Error('demo の比較データが返らない');
    const sotenScope1 = soten.rows.find((r) => r.metric.key === 'scope1')!;
    expect(sotenScope1.own.value).toBe(777777);
    expect(JSON.stringify(soten)).not.toContain('8931.6');
    // 比較データは静的な架空データで、どのテナントでも同じ
    expect(soten.peers).toEqual(DEMO_PEERS);
  });

  it('同じ年度の報告期間が無い組織は、自社の値をすべて出さない（推測で埋めない）', async () => {
    const view = await loadBenchmark(db, otherTenant(), { source: 'demo' });
    if (view.source !== 'demo') throw new Error('demo の比較データが返らない');
    expect(view.ownPeriod).toBeNull();
    for (const row of view.rows) {
      expect(row.own.status, row.metric.key).toBe('no_period');
      expect(row.own.value, row.metric.key).toBeNull();
      expect(row.stats.n, row.metric.key).toBe(0);
    }
  });

  it('閲覧者（データの閲覧権限）は読める。監査法人のワークスペースは拒否', async () => {
    await expect(loadBenchmark(db, viewer(), { source: 'demo' })).resolves.toMatchObject({
      source: 'demo',
    });
    const assurance = ctxFor(
      'assurance-manager@demo.local',
      ['assurance_manager'],
      ORG_IDS.aoba,
      'assurance_firm',
    );
    await expect(loadBenchmark(db, assurance, { source: 'demo' })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it('データの閲覧権限が無ければ拒否', async () => {
    const noRead = ctxFor('site-user@demo.local', []);
    await expect(loadBenchmark(db, noRead, { source: 'demo' })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});

describe('読込は書かない', () => {
  it('書込検知ラッパーで包んでも例外が出ない', async () => {
    const spy = new WriteDetectingDbClient(db);
    await loadBenchmark(spy, manager(), { source: 'demo' });
    await loadBenchmark(spy, otherTenant(), { source: 'demo' });
    expect(spy.writes).toEqual([]);
  });
});
