import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { DRIVER_KEYS, DRIVERS, type PathwayId } from '@/lib/domain/financial-impact';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DEMO_ASSUMPTION_DEFAULTS } from '@/lib/financial-impact/demo-assumptions';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  loadFinancialImpact,
  type FinancialImpactReady,
  type FinancialImpactView,
} from '@/lib/services/analysis/financial-impact';
import { loadMetricYearStates } from '@/lib/services/kpi';
import type { AuthorizationContext, ReportingPeriod, RoleKey, Uuid } from '@/types/domain';
import { WriteDetectingDbClient } from '../support/write-detecting-db';

/**
 * 財務影響分析のサービス（docs/disclosure-first.md §10.3）。
 * 起点は loadMetricYearStates の基準年度（ヘッダー年度以前で closed の最新 = デモは FY2025）の
 * 確定連結値だけ。FY2026 の途中値・推計・前年値補完は使わない。読むだけ（書かない）。
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
const siteUser = () => ctxFor('site-user@demo.local', ['site_contributor']);
const otherTenant = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);
const auditor = () =>
  ctxFor('assurance-manager@demo.local', ['assurance_manager'], ORG_IDS.aoba, 'assurance_firm');

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

function period(id: Uuid): ReportingPeriod {
  const found = fixture.periods.find((p) => p.id === id);
  if (!found) throw new Error(`期間 ${id} が無い`);
  return found;
}

function ready(view: FinancialImpactView): FinancialImpactReady {
  if (view.status !== 'ready') throw new Error(`ready ではない: ${view.status}`);
  return view;
}

async function load(
  ctx: AuthorizationContext = manager(),
  options: { periodId?: Uuid; source?: 'demo' | 'none'; params?: Record<string, string> } = {},
) {
  return loadFinancialImpact(db, ctx, {
    period: period(options.periodId ?? PERIOD_IDS.fy2026),
    source: options.source ?? 'demo',
    params: options.params ?? {},
  });
}

function pathwayOf(view: FinancialImpactReady, id: PathwayId) {
  const found = view.current.pathways.find((p) => p.pathway.id === id);
  if (!found) throw new Error(`${id} が無い`);
  return found;
}

describe('基準年度と起点', () => {
  it('ヘッダー FY2026 → 基準年度 FY2025（closed の最新）、試算期間 FY2026〜FY2035', async () => {
    const view = ready(await load());
    expect(view.basePeriod.id).toBe(PERIOD_IDS.fy2025);
    expect(view.baseYear).toBe(2025);
    expect(view.current.years[0]).toBe(2026);
    expect(view.current.years.at(-1)).toBe(2035);
    expect(view.referenceYear).toBe(2030);
  });

  it('起点は FY2025 の確定連結値（scope1 8,931.6 等。loadMetricYearStates と一致）', async () => {
    const view = ready(await load());
    const origin = (key: (typeof DRIVER_KEYS)[number]) =>
      view.origins.find((o) => o.driver === key)!;
    expect(origin('scope1').value).toBeCloseTo(8931.6, 1);
    expect(origin('scope2').value).toBeCloseTo(22897.4, 1);

    const states = await loadMetricYearStates(db, manager(), {
      metricCodes: DRIVER_KEYS.map((key) => DRIVERS[key].metricCode),
      periodIds: [PERIOD_IDS.fy2025],
    });
    for (const key of DRIVER_KEYS) {
      const row = states.rows.find((r) => r.metric.code === DRIVERS[key].metricCode)!;
      const state = row.years[0]!.state;
      expect(state.complete, key).toBe(true);
      expect(origin(key).value, key).toBe(state.approvedValue);
      expect(origin(key).href).toBe(`/enterprise/data?metric=${row.metric.id}`);
    }
    // P1 の FY2028 はこの起点から計算される
    const p1 = pathwayOf(view, 'P1');
    expect(p1.years.find((y) => y.year === 2028)!.value).toBeCloseTo(-8_931_600, 0);
  });

  it('FY2026 の途中値は使わない（scope1 の FY2026 集計中 7,859.8、Cat.1 の FY2026 確定値も起点にしない）', async () => {
    const view = ready(await load());
    const scope1 = view.origins.find((o) => o.driver === 'scope1')!;
    expect(scope1.value).not.toBeCloseTo(7859.8, 1);
    expect(scope1.periodCode).toBe('FY2025');
    const cat1 = view.origins.find((o) => o.driver === 'scope3_cat1')!;
    expect(cat1.value).toBeCloseTo(48210, 1);
    expect(cat1.value).not.toBeCloseTo(48130, 1);
  });

  it('ltifr・turnover_rate は起点にしない（全社値は算定不可）。労災の経路は入力値だけを使う', async () => {
    const view = ready(await load());
    const codes = view.origins.map((o) => o.spec.metricCode);
    expect(codes).not.toContain('ltifr');
    expect(codes).not.toContain('turnover_rate');
    expect(codes).toEqual(DRIVER_KEYS.map((key) => DRIVERS[key].metricCode));
    expect(view.injuryDataNote).toContain('LTIFR');
    expect(pathwayOf(view, 'P7').status).toBe('missing_input');
  });

  it('確定データの年数（基準年度以前）は最長 2 年分', async () => {
    const view = ready(await load());
    expect(view.dataDepthYears).toBe(2);
  });

  it('ヘッダー FY2024 → 基準年度 FY2024（起点は FY2024 の 9,735.4）', async () => {
    const view = ready(await load(manager(), { periodId: PERIOD_IDS.fy2024 }));
    expect(view.basePeriod.id).toBe(PERIOD_IDS.fy2024);
    expect(view.current.years[0]).toBe(2025);
    expect(view.origins.find((o) => o.driver === 'scope1')!.value).toBeCloseTo(9735.4, 1);
  });
});

describe('目標（目標達成シナリオ）', () => {
  it('Scope1 の目標（2030 年 7,840 t）は比較可で使い、Scope2 の目標は境界が違うため使わない', async () => {
    const view = ready(await load(manager(), { params: { sc: 'target' } }));
    const scope1 = view.targets.find((t) => t.driver === 'scope1')!;
    expect(scope1.status).toBe('applied');
    expect(scope1.targetYear).toBe(2030);
    expect(scope1.targetValue).toBe(7840);
    const scope2 = view.targets.find((t) => t.driver === 'scope2')!;
    expect(scope2.status).toBe('not_comparable');
    expect(scope2.reasons.join('')).toContain('単体（国内拠点）');

    expect(view.params.scenario).toBe('target');
    const p1 = pathwayOf(view, 'P1');
    expect(p1.years.find((y) => y.year === 2030)!.value).toBeCloseTo(-15_680_000, 0);
    // 回避コストは目標達成 − 現状維持
    expect(view.comparison.scenario).toBe('target');
    expect(view.comparison.avoided).toBeCloseTo(23_251_080, 0);
  });
});

describe('仮定の出所（Demo Mode と Supabase 相当）', () => {
  it('demo: 既定の仮定・架空のベースラインあり。定量化は 6 / 9 経路', async () => {
    const view = ready(await load());
    expect(view.source).toBe('demo');
    expect(view.defaults).toEqual(DEMO_ASSUMPTION_DEFAULTS);
    expect(view.baseline?.operatingProfit).toBe(5_000_000_000);
    expect(view.current.quantifiedCount).toBe(6);
    expect(view.current.enabledCount).toBe(9);
  });

  it("source 'none': 既定値・ベースラインなし。入力が揃った経路だけ計算する", async () => {
    const empty = ready(await load(manager(), { source: 'none' }));
    expect(empty.baseline).toBeNull();
    expect(empty.defaults.carbonPriceStart).toBeNull();
    expect(empty.params.assumptions.energyPrice).toBeNull();
    expect(empty.current.quantifiedCount).toBe(0);
    expect(empty.current.cumulative).toBeNull();
    // 起点のデータは同じ（承認済みの値は使う）
    expect(empty.origins.find((o) => o.driver === 'scope1')!.value).toBeCloseTo(8931.6, 1);

    const withPrice = ready(
      await load(manager(), {
        source: 'none',
        params: {
          a_carbonPriceStart: '1000',
          a_carbonPriceStep: '500',
          a_fuelShare: '100',
          a_passThroughFuel: '100',
        },
      }),
    );
    expect(withPrice.current.quantifiedCount).toBe(1);
    expect(pathwayOf(withPrice, 'P1').status).toBe('quantified');
    expect(pathwayOf(withPrice, 'P2').status).toBe('missing_input');
  });

  it('URL の範囲外の値は既定に戻して通知する', async () => {
    const view = ready(await load(manager(), { params: { a_carbonPriceStart: '-5' } }));
    expect(view.params.assumptions.carbonPriceStart).toBe(1000);
    expect(view.params.notices).toHaveLength(1);
  });
});

describe('定性情報・IRO（enterprise.disclosure.read のときだけ。円にしない）', () => {
  it('サステナビリティ担当: IRO・定性情報・SSBJ マテリアリティを経路に関連付けて示す', async () => {
    const view = ready(await load());
    expect(view.qualitative).not.toBeNull();
    expect(view.hiddenNote).toBeNull();
    const q = view.qualitative!;

    // リスク・機会の IRO（10 事項それぞれ 1 件）。E1 の炭素価格は P1・P2 に関連
    expect(q.iros).toHaveLength(10);
    const e1 = q.iros.find((i) => i.topic === 'E1')!;
    expect(e1.pathways).toEqual(['P1', 'P2']);
    expect(e1.likelihood).toBe(4);
    expect(e1.magnitude).toBe(4);
    // リコール・制裁金は円にしない（点数と期間のまま）
    for (const topic of ['E2', 'E4', 'S2', 'S3', 'S4', 'G1'] as const) {
      const iro = q.iros.find((i) => i.topic === topic)!;
      expect(iro.pathways, topic).toEqual([]);
      expect(iro.note).toContain('円にしない');
    }
    expect(q.iros.find((i) => i.topic === 'S4')!.magnitude).toBe(5);
    // 渇水は P4 に関連するが未定量
    const e3 = q.iros.find((i) => i.topic === 'E3')!;
    expect(e3.pathways).toEqual(['P4']);
    expect(e3.note).toContain('未定量');

    const narrative = (keyword: string) => q.narratives.find((n) => n.title.includes(keyword))!;
    expect(narrative('炭素価格').pathways).toEqual(['P1', 'P2']);
    expect(narrative('浸水').pathways).toEqual(['P8']);
    expect(narrative('低消費電力').pathways).toEqual(['P9']);
    // 財務的影響の定性情報は金額が無く、記録された理由をそのまま示す
    expect(narrative('財務的影響').amountNote).toContain('評価中のため未確定');

    // SSBJ マテリアリティ（FY2025 の評価）: 資源循環 → P5、労働安全 → P7
    expect(q.ssbjTopics.find((t) => t.title.includes('資源循環'))!.pathways).toEqual(['P5']);
    expect(q.ssbjTopics.find((t) => t.title.includes('労働安全'))!.pathways).toEqual(['P7']);

    expect(view.relatedByPathway.P1.map((r) => r.kind)).toEqual(
      expect.arrayContaining(['iro', 'narrative']),
    );
    expect(view.relatedByPathway.P1.find((r) => r.kind === 'iro')!.href).toBe(
      '/enterprise/disclosures/csrd/settings/matters/E1',
    );
  });

  it('拠点担当（disclosure.read なし）: 定性・IRO は読まず「閲覧権限が無い領域は表示していません」', async () => {
    const view = ready(await load(siteUser()));
    expect(view.qualitative).toBeNull();
    expect(view.hiddenNote).toContain('閲覧権限が無い領域は表示していません');
    for (const id of Object.keys(view.relatedByPathway) as PathwayId[]) {
      expect(view.relatedByPathway[id]).toEqual([]);
    }
    // 数値の試算は出す（enterprise.data.read）
    expect(view.current.quantifiedCount).toBe(6);
  });
});

describe('権限・テナント・書込', () => {
  it('読むだけで書かない（書込検知ラッパー）', async () => {
    const spy = new WriteDetectingDbClient(db);
    await loadFinancialImpact(spy, manager(), {
      period: period(PERIOD_IDS.fy2026),
      source: 'demo',
      params: { sc: 'custom', r_energy: '5' },
    });
    expect(spy.writes).toEqual([]);
  });

  it('監査法人のワークスペースからは読めない', async () => {
    await expect(load(auditor())).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('他テナント: 青海の期間は見つからない扱い、自社（蒼天）には closed の期間が無く空状態', async () => {
    await expect(load(otherTenant())).rejects.toBeInstanceOf(NotFoundError);
    const own = await load(otherTenant(), { periodId: PERIOD_IDS.sotenFy2026 });
    expect(own.status).toBe('no_base');
  });

  it('他テナントの値が混ざらない（起点は青海の承認済みデータだけ）', async () => {
    const view = ready(await load());
    const sotenMetricIds = new Set(
      fixture.metrics.filter((m) => m.organizationId === ORG_IDS.soten).map((m) => m.id),
    );
    for (const origin of view.origins) {
      expect(origin.metric?.organizationId).toBe(ORG_IDS.aomi);
      expect(sotenMetricIds.has(origin.metric!.id)).toBe(false);
    }
  });
});
