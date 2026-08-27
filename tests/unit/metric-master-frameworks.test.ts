import { describe, expect, it } from 'vitest';
import { createFixtureDb } from '@/lib/fixtures/store';
import { ORG_IDS } from '@/lib/fixtures/dataset';
import { SSBJ_MASTER_ITEMS } from '@/lib/frameworks/ssbj-2026';
import { summarizeFrameworkCoverage } from '@/lib/domain/metrics';
import { METRIC_CATEGORIES, METRIC_FRAMEWORK_KEYS } from '@/types/domain';

/**
 * 指標マスターが SSBJ・CDP・CSRD の要求から作られていること。
 *
 * 指標マスターは長らく自社都合の一覧で、基準が何を求めているかと切れていた。
 * 出所（frameworks）を指標へ持たせ、基準側の要求と突き合わせられることを検査する。
 */

const db = createFixtureDb();
const metrics = db.metrics.filter((m) => m.organizationId === ORG_IDS.aomi);
const byCode = new Map(metrics.map((m) => [m.code, m]));

describe('指標マスターの出所', () => {
  it('3 基準すべてから指標を取り込んでいる', () => {
    for (const framework of METRIC_FRAMEWORK_KEYS) {
      const required = metrics.filter((m) => m.frameworks.includes(framework));
      expect(required.length, `${framework} の指標が 1 件も無い`).toBeGreaterThan(20);
    }
  });

  it('frameworks に未知のキーが混ざらない', () => {
    for (const metric of metrics) {
      for (const framework of metric.frameworks) {
        expect(METRIC_FRAMEWORK_KEYS).toContain(framework);
      }
    }
  });

  it('分類はすべて既知のものになっている', () => {
    for (const metric of metrics) {
      expect(METRIC_CATEGORIES).toContain(metric.category);
    }
  });

  it('コードは組織内で一意（同じ指標を二重に作らない）', () => {
    const codes = metrics.map((m) => m.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('SSBJ 気候関連開示基準が求める指標', () => {
  it('スコープ 1・2・3 の絶対総量を持つ（第47項）', () => {
    for (const code of ['scope1', 'scope2', 'scope3_total']) {
      expect(byCode.get(code)?.frameworks, `${code} が SSBJ に紐づいていない`).toContain('ssbj');
    }
  });

  it('スコープ 2 をロケーション基準とマーケット基準で分けて持つ（第53項・第54項）', () => {
    expect(byCode.get('scope2')?.name).toContain('マーケット基準');
    expect(byCode.get('scope2_location')?.name).toContain('ロケーション基準');
  });

  it('スコープ 3 を 15 カテゴリーすべてに分解して持つ（第55項）', () => {
    for (let category = 1; category <= 15; category += 1) {
      const metric = byCode.get(`scope3_cat${category}`);
      expect(metric, `Category ${category} の指標が無い`).toBeDefined();
      expect(metric?.unit).toBe('t-CO2e');
    }
  });

  it('産業横断的指標等（第79項〜第84項）を持つ', () => {
    const expected: Array<[string, string]> = [
      ['transition_risk_assets', '第79項 移行リスクに脆弱な資産'],
      ['physical_risk_assets', '第80項 物理的リスクに脆弱な資産'],
      ['climate_opportunity_assets', '第81項 機会と整合した資産'],
      ['climate_capex', '第82項 資本投下'],
      ['internal_carbon_price', '第83項 内部炭素価格'],
      ['exec_comp_climate_ratio', '第84項 役員報酬への組込割合'],
    ];
    for (const [code, why] of expected) {
      const metric = byCode.get(code);
      expect(metric, `${why} の指標が無い`).toBeDefined();
      expect(metric?.category).toBe('climate_transition');
      expect(metric?.frameworks).toContain('ssbj');
    }
  });

  it('SSBJ マスターが指標へ紐づけている code はすべて指標マスターに実在する', () => {
    const linked = new Set(
      SSBJ_MASTER_ITEMS.map((item) => item.metricCode).filter((c): c is string => Boolean(c)),
    );
    expect(linked.size).toBeGreaterThan(0);
    for (const code of linked) {
      expect(byCode.has(code), `SSBJ が参照する指標 ${code} がマスターに無い`).toBe(true);
    }
  });
});

describe('CDP・CSRD が求める指標', () => {
  it('CDP の主要な環境指標を持つ', () => {
    for (const code of ['energy', 'energy_renewable', 'renewable_ratio', 'water_withdrawal']) {
      expect(byCode.get(code)?.frameworks, `${code} が CDP に紐づいていない`).toContain('cdp');
    }
  });

  it('CSRD（ESRS）の社会・ガバナンス指標を持つ', () => {
    for (const code of [
      'work_related_injuries',
      'work_related_fatalities',
      'collective_bargaining_ratio',
      'corruption_cases',
    ]) {
      expect(byCode.get(code)?.frameworks, `${code} が CSRD に紐づいていない`).toContain('csrd');
    }
  });

  it('比率指標には分子と分母がある（計算根拠を残す）', () => {
    for (const code of ['renewable_ratio', 'recycling_rate']) {
      const metric = byCode.get(code);
      expect(metric?.numeratorMetricCode, `${code} に分子が無い`).toBeTruthy();
      expect(metric?.denominatorMetricCode, `${code} に分母が無い`).toBeTruthy();
      // 分子・分母も指標マスターに実在すること
      expect(byCode.has(metric!.numeratorMetricCode!)).toBe(true);
      expect(byCode.has(metric!.denominatorMetricCode!)).toBe(true);
    }
  });
});

describe('充足状況の集計', () => {
  it('値のある指標だけを充足として数える', () => {
    const withValue = new Set(
      db.dataPoints.filter((dp) => dp.organizationId === ORG_IDS.aomi).map((dp) => dp.metricId),
    );
    const coverage = summarizeFrameworkCoverage(metrics, withValue, METRIC_FRAMEWORK_KEYS);

    expect(coverage).toHaveLength(3);
    for (const row of coverage) {
      expect(row.collected).toBeLessThanOrEqual(row.required);
      expect(row.rate).toBe(Math.round((row.collected / row.required) * 100));
      // 基準から取り込んだばかりの指標が大半なので、満点にはならない。
      // ここが 100% になったらデータギャップが消えている＝デモの主題が壊れている
      expect(row.rate).toBeLessThan(100);
    }
  });

  it('要求 0 件の基準は 0% として扱い、0 除算にしない', () => {
    const coverage = summarizeFrameworkCoverage([], new Set(), METRIC_FRAMEWORK_KEYS);
    for (const row of coverage) {
      expect(row.rate).toBe(0);
      expect(row.required).toBe(0);
    }
  });
});
