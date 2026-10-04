import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError } from '@/lib/authorization/can';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, metricId, userId } from '@/lib/fixtures/dataset';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { NO_TREND_FILTERS, filterMetricTrendRows } from '@/lib/domain/metric-trend';
import { computeConsolidatedAggregation } from '@/lib/services/aggregation';
import {
  loadMetricTrends,
  type MetricTrendRow,
  type MetricTrendsView,
} from '@/lib/services/analysis/trends';
import type { AuthorizationContext, ReportingPeriod, RoleKey, Uuid } from '@/types/domain';
import { WriteDetectingDbClient } from '../support/write-detecting-db';

/**
 * 自社経年比較（docs/disclosure-first.md §10.2）。
 *  - 窓はヘッダーの年度を終点に、開始日がそれ以前の期間を新しい順に最大 3 つ（開始日の昇順で返す）
 *  - 値は ESG経営と同じ確定値（合計 = 承認済みの連結値〔JV を数えない〕、比率 = 分子・分母の加重平均）
 *  - 集計中の年度は値を出さず、前年比も出さない。内部取引の控除が片方だけなら比較条件の確認
 *  - 全社値を算定できない指標は「全社値は算定不可」（拠点値は内訳）
 *  - 他テナントの値が混ざらない。監査法人は読めない。読むだけ（書かない）
 *
 * FY2024 は 2026-10-02 に収集 21 指標の承認済み実績を持つよう広げた Fixture（GHG の値は不変）。
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

function periodOf(id: Uuid): ReportingPeriod {
  const period = fixture.periods.find((p) => p.id === id);
  if (!period) throw new Error(`期間 ${id} が無い`);
  return period;
}

/** シェルと同じ: 組織の期間をコードの降順で渡す（窓はコードではなく開始日で決まる） */
function orgPeriods(organizationId: Uuid = ORG_IDS.aomi): ReportingPeriod[] {
  return fixture.periods
    .filter((p) => p.organizationId === organizationId)
    .sort((a, b) => (a.code < b.code ? 1 : -1));
}

async function trends(
  periodId: Uuid = PERIOD_IDS.fy2026,
  ctx: AuthorizationContext = manager(),
): Promise<MetricTrendsView> {
  return loadMetricTrends(db, ctx, { period: periodOf(periodId), periods: orgPeriods() });
}

function rowOf(view: MetricTrendsView, code: string): MetricTrendRow {
  const row = view.rows.find((r) => r.metric.code === code);
  if (!row) throw new Error(`${code} の行が無い`);
  return row;
}

describe('年度の窓', () => {
  it('既定（FY2026）は FY2024 → FY2025 → FY2026（開始日の昇順）で、注記は無い', async () => {
    const view = await trends();
    expect(view.period.id).toBe(PERIOD_IDS.fy2026);
    expect(view.periods.map((p) => p.code)).toEqual(['FY2024', 'FY2025', 'FY2026']);
    expect(view.windowNote).toBeNull();
    for (const row of view.rows) {
      expect(row.cells).toHaveLength(3);
      expect(row.changes).toHaveLength(2);
      expect(row.changeLabels).toEqual(['FY2024→FY2025', 'FY2025→FY2026']);
    }
  });

  it('ヘッダーが FY2025 なら FY2024・FY2025 の 2 年窓で、年数と理由を示す', async () => {
    const view = await trends(PERIOD_IDS.fy2025);
    expect(view.periods.map((p) => p.code)).toEqual(['FY2024', 'FY2025']);
    expect(view.windowNote).toBe('比較できる年度は 2 年分（それ以前の報告期間なし）');
    expect(rowOf(view, 'scope1').changeLabels).toEqual(['FY2024→FY2025']);
    // 窓の外（FY2026）の値を使わない
    expect(rowOf(view, 'scope1').cells.map((c) => c.value)).toEqual([9735.4, 8931.6]);
  });

  it('期間の開始日で並べる（コードの文字列順に頼らない）', async () => {
    // コードの辞書順では FY2026 より後ろになる名前の期間を、FY2024 より前の開始日で足す
    fixture.periods.push({
      ...periodOf(PERIOD_IDS.fy2024),
      id: fid('period', 'AOMI/ZZ-OLD'),
      code: 'ZZ2023',
      label: '2023年度',
      startDate: '2023-04-01',
      endDate: '2024-03-31',
    });
    const view = await trends(PERIOD_IDS.fy2025);
    expect(view.periods.map((p) => p.code)).toEqual(['ZZ2023', 'FY2024', 'FY2025']);
    expect(view.windowNote).toBeNull();
  });
});

describe('値（ESG経営と同じ確定値）', () => {
  it('scope1: 9,735.4 → 8,931.6（−8.3%）。FY2026 は集計中 3/4 で値も前年比も出さない', async () => {
    const view = await trends();
    const scope1 = rowOf(view, 'scope1');
    expect(scope1.group).toBe('ghg');
    expect(scope1.cells.map((c) => c.kind)).toEqual(['confirmed', 'confirmed', 'incomplete']);
    expect(scope1.cells.map((c) => c.value)).toEqual([9735.4, 8931.6, null]);
    expect(scope1.cells[2]!.label).toBe('集計中（承認済み 3/4 拠点）');
    expect(scope1.changes[0]).toEqual({
      kind: 'value',
      direction: 'down',
      text: '−8.3%（−803.8 t-CO2e）',
      large: false,
      notes: [],
    });
    expect(scope1.changes[1]).toEqual({
      kind: 'unavailable',
      reason: 'FY2026 の確定値がありません。',
    });

    // 途中合計と推計込みは内訳の参考だけ（値の欄・前年比に使わない）
    const ctx = manager();
    const aggregation = await computeConsolidatedAggregation(
      db,
      ctx,
      periodOf(PERIOD_IDS.fy2026),
      orgPeriods(),
      ['scope1'],
    );
    const fy2026 = scope1.years[2]!;
    expect(fy2026.partialValue).toBe(aggregation.metrics[0]!.consolidated);
    expect(fy2026.referenceWithEstimates).toBe(aggregation.metrics[0]!.consolidatedWithEstimates);
    expect(fy2026.referenceWithEstimates!).toBeGreaterThan(fy2026.partialValue!);
    expect(fy2026.details.some((d) => d.includes('欧州販売子会社'))).toBe(true);
    expect(scope1.years[0]!.partialValue).toBeNull();
  });

  it('合計は連結値: 持分法の JV（青海マテリアル合弁会社）を数えない', async () => {
    const view = await trends();
    const fy2024 = rowOf(view, 'scope1').cells[0]!;
    // HQ 1,352.1 + 東日本 4,326.9 + 西日本 3,245.1 + 欧州 811.3（JV 473.3 は含めない）
    expect(fy2024.value).toBeCloseTo(1352.1 + 4326.9 + 3245.1 + 811.3, 1);
    expect(fy2024.expectedCount).toBe(4);
    expect(fy2024.approvedCount).toBe(4);
  });

  it('scope3_cat1: FY2025 → FY2026 は内部取引の控除が FY2026 だけなので比較条件の確認', async () => {
    const view = await trends();
    const cat1 = rowOf(view, 'scope3_cat1');
    expect(cat1.cells.map((c) => c.value)).toEqual([44835.3, 48210, 48130]);
    expect(cat1.changes[0]).toMatchObject({ kind: 'value', text: '+7.5%（+3,374.7 t-CO2e）' });
    expect(cat1.changes[1]!.kind).toBe('needs_check');
    if (cat1.changes[1]!.kind === 'needs_check') {
      expect(cat1.changes[1]!.reasons).toEqual([
        '内部取引の控除が FY2026 だけにあります（FY2025 は控除なし）。控除の有無をそろえないと、増減の大きさや向きが変わることがあります。',
      ]);
    }
    expect(cat1.basisReasons[1]!.map((r) => r.kind)).toEqual(['intercompany']);
  });

  it('female_manager_ratio: 分子・分母の加重平均（14.04 → 15 → 18.25）で、差は % ポイント', async () => {
    const view = await trends();
    const ratio = rowOf(view, 'female_manager_ratio');
    expect(ratio.group).toBe('social');
    expect(ratio.cells.map((c) => c.kind)).toEqual(['confirmed', 'confirmed', 'confirmed']);
    expect(ratio.cells[0]!.value).toBeCloseTo(14.04, 2);
    expect(ratio.cells[1]!.value).toBeCloseTo(15, 2);
    expect(ratio.cells[2]!.value).toBeCloseTo(18.25, 2);
    expect(ratio.changes.map((c) => (c.kind === 'value' ? c.text : c.kind))).toEqual([
      '+0.96 pt',
      '+3.25 pt',
    ]);
  });

  it('turnover_rate・directors_count は全社値は算定不可（拠点値は内訳）。前年比も出さない', async () => {
    const view = await trends();
    for (const code of ['turnover_rate', 'directors_count']) {
      const row = rowOf(view, code);
      expect(row.cells.map((c) => c.kind)).toEqual([
        'not_computable',
        'not_computable',
        'not_computable',
      ]);
      expect(row.cells.every((c) => c.value === null && c.label === '全社値は算定不可')).toBe(true);
      expect(row.changes.every((c) => c.kind === 'unavailable')).toBe(true);
      expect(row.years[1]!.unitValues.length).toBeGreaterThan(0);
    }
    // 拠点値は状態つきで示す（FY2025 の本社の離職率 6.8%）
    expect(rowOf(view, 'turnover_rate').years[1]!.unitValues[0]).toMatchObject({
      unitName: '本社',
      value: 6.8,
      unitOfMeasure: '%',
      statusLabel: '承認済み',
    });
  });

  it('どの年度にもデータの無い指標は「未入力」で値は null（0 にしない）、既定では隠す', async () => {
    const view = await trends();
    const location = rowOf(view, 'scope2_location');
    expect(location.hasAnyData).toBe(false);
    expect(location.cells.map((c) => [c.kind, c.label, c.value])).toEqual([
      ['not_entered', '未入力', null],
      ['not_entered', '未入力', null],
      ['not_entered', '未入力', null],
    ]);
    const shown = filterMetricTrendRows(view.rows, NO_TREND_FILTERS).map((r) => r.metric.code);
    expect(shown).not.toContain('scope2_location');
    expect(
      filterMetricTrendRows(view.rows, { ...NO_TREND_FILTERS, empty: true }).map(
        (r) => r.metric.code,
      ),
    ).toContain('scope2_location');
  });

  it('承認前の単位違い（東日本の廃棄物 kg）は値に入らず集計中のまま（単位の確認にしない）', async () => {
    const view = await trends();
    expect(rowOf(view, 'waste').cells[2]!.kind).toBe('incomplete');
  });

  it('承認済みの異常値（役員総数 12 → 3）もそのまま出し、検証エラーは内訳から一覧へ進める', async () => {
    const view = await trends();
    const officers = rowOf(view, 'officers_total');
    expect(officers.cells.map((c) => c.value)).toEqual([11, 12, 3]);
    expect(officers.changes[1]).toMatchObject({ kind: 'value', text: '−75.0%（−9 人）' });
    const ratio = rowOf(view, 'female_officer_ratio');
    // 女性役員 4 人 > 役員 3 人の検証エラーは比率の行に付く
    expect(ratio.years[2]!.validation.errors).toBeGreaterThan(0);
    expect(ratio.links).toContainEqual({
      label: 'この指標の検証エラー（FY2026 の一覧）',
      href: `/enterprise/data?metric=${ratio.metric.id}&flag=validation_error`,
    });
    expect(ratio.links).toContainEqual({
      label: 'この指標のデータ（FY2026 の一覧。年度は画面上部で選択）',
      href: `/enterprise/data?metric=${ratio.metric.id}`,
    });
  });

  it('リンク: KPI の指標は ESG経営の詳細、GHG は GHG 画面', async () => {
    const view = await trends();
    expect(rowOf(view, 'scope1').links.map((l) => l.href)).toEqual([
      '/enterprise/esg/scope1',
      '/enterprise/ghg',
      `/enterprise/data?metric=${metricId('AOMI', 'scope1')}`,
    ]);
    expect(rowOf(view, 'ltifr').links[0]).toEqual({
      label: 'ESG経営の KPI「労災」',
      href: '/enterprise/esg/occupational_safety',
    });
    expect(rowOf(view, 'employees').links.map((l) => l.href)).toEqual([
      `/enterprise/data?metric=${metricId('AOMI', 'employees')}`,
    ]);
  });
});

describe('行の並びと要約', () => {
  it('数値指標だけを群の順（GHG → 環境 → 社会 → ガバナンス）に並べる', async () => {
    const view = await trends();
    const groups = view.rows.map((r) => r.group);
    const order = ['ghg', 'environment', 'social', 'governance'];
    expect([...groups].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(groups);
    expect(view.rows.every((r) => ['number', 'integer', 'ratio'].includes(r.metric.dataType))).toBe(
      true,
    );
    const numeric = fixture.metrics.filter(
      (m) =>
        m.organizationId === ORG_IDS.aomi &&
        m.deletedAt === null &&
        ['number', 'integer', 'ratio'].includes(m.dataType),
    );
    expect(view.rows).toHaveLength(numeric.length);
  });

  it('要約は分母付きの件数（データのある 21 指標が分母。総合点・準拠率を作らない）', async () => {
    const view = await trends();
    expect(view.summary).toEqual({
      dataMetricCount: 21,
      // 全社値を算定できる 15 指標は FY2024 → FY2025 を同条件で比べられる
      comparedCount: 15,
      // 前年比の許容幅を超えた変化は無い（FY2025 の検証に前年差の警告が無いのと同じ）
      largeCount: 0,
      // scope3_cat1（内部取引の控除が FY2026 だけ）
      needsCheckCount: 1,
      // FY2026 が集計中: scope1・scope2・energy・water・waste・employees・female_officer_ratio・
      // female_employees・new_hires
      latestIncompleteCount: 9,
      emptyCount: view.rows.length - 21,
    });
    const json = JSON.stringify(view);
    expect(json).not.toMatch(/"(rank|ranking|score|totalScore|percentile)"/);
    expect(json).not.toContain('準拠率');
  });
});

describe('テナントと権限', () => {
  it('他テナント（蒼天）の値が混ざらない', async () => {
    const aomiDp = fixture.dataPoints.find(
      (d) => d.metricId === metricId('AOMI', 'scope1') && d.reportingPeriodId === PERIOD_IDS.fy2025,
    )!;
    fixture.dataPoints.push({
      ...aomiDp,
      id: fid('data_point', 'SOTEN/scope1-trend-test'),
      organizationId: ORG_IDS.soten,
      metricId: metricId('SOTEN', 'scope1'),
      unitId: UNIT_IDS.sotenHq,
      reportingPeriodId: PERIOD_IDS.sotenFy2026,
      value: 777777,
      boundary: '連結',
      status: 'approved',
    });

    const aomi = await trends();
    expect(JSON.stringify(aomi)).not.toContain('777777');

    const soten = await loadMetricTrends(db, otherTenant(), {
      period: periodOf(PERIOD_IDS.sotenFy2026),
      periods: orgPeriods(ORG_IDS.soten),
    });
    expect(soten.periods.map((p) => p.id)).toEqual([PERIOD_IDS.sotenFy2026]);
    expect(soten.windowNote).toBe('比較できる年度は 1 年分（それ以前の報告期間なし）');
    expect(rowOf(soten, 'scope1').cells.map((c) => c.value)).toEqual([777777]);
    const json = JSON.stringify(soten);
    for (const aomiValue of ['9735.4', '8931.6', '44835.3']) expect(json).not.toContain(aomiValue);

    // 青海の期間を渡されても、蒼天の窓に青海の期間を入れない
    const crossed = await loadMetricTrends(db, otherTenant(), {
      period: periodOf(PERIOD_IDS.sotenFy2026),
      periods: [...orgPeriods(ORG_IDS.aomi), ...orgPeriods(ORG_IDS.soten)],
    });
    expect(crossed.periods.map((p) => p.id)).toEqual([PERIOD_IDS.sotenFy2026]);
  });

  it('監査法人のワークスペースからは読めない', async () => {
    await expect(
      loadMetricTrends(db, auditor(), {
        period: periodOf(PERIOD_IDS.fy2026),
        periods: orgPeriods(),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('拠点担当（enterprise.data.read あり）も読める', async () => {
    const view = await trends(PERIOD_IDS.fy2026, siteUser());
    expect(rowOf(view, 'scope1').cells[0]!.value).toBe(9735.4);
  });

  it('読むだけで書かない（書込検知ラッパーで例外が出ない）', async () => {
    const spy = new WriteDetectingDbClient(db);
    await loadMetricTrends(spy, manager(), {
      period: periodOf(PERIOD_IDS.fy2026),
      periods: orgPeriods(),
    });
    expect(spy.writes).toEqual([]);
  });
});
