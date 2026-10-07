import 'server-only';

import { assertCan, assertEnterpriseWorkspace } from '@/lib/authorization/can';
import {
  DEMO_PEERS,
  DEMO_PEER_FISCAL_YEAR,
  DEMO_PEER_VALUES,
  type DemoPeer,
  type DemoPeerValue,
} from '@/lib/benchmarks/demo-peers';
import {
  BENCHMARK_METRICS,
  peerComparability,
  peerStatistics,
  type BenchmarkMetric,
  type Comparability,
  type ComparisonConditions,
  type PeerStatistics,
} from '@/lib/domain/benchmark';
import { computeConsolidatedAggregation } from '@/lib/services/aggregation';
import type { DbClient } from '@/lib/repositories/types';
import type { AuthorizationContext, MetricDefinition, ReportingPeriod } from '@/types/domain';
import { unitCoverageOf } from './unit-coverage';

/**
 * 他社比較（docs/disclosure-first.md §9.5）。閲覧専用（書かない）。
 *
 * 誠実さの規則:
 *  - 比較データは静的な架空データ（src/lib/benchmarks/demo-peers.ts）。Demo Mode のときだけ使い
 *    （source='demo'）、Supabase モード（source='none'）では何も返さない。他テナントの値は使わない
 *  - 自社の値は比較データと同じ年度（FY2025）の確定値。確定 = 対象の全拠点が承認済み（kpi.ts と同じ規則）。
 *    合計は GHG 画面と同じ連結値（持分調整・内部取引控除後）、比率は分子・分母の合計からの加重平均だけ
 *    （拠点の比率の単純合計・単純平均は使わない）。算定できない・値が無い指標は値を出さない（0 にしない）
 *  - 比較の可否は peerComparability。比較できない社は集計に入れず、理由を示す。換算しない
 *  - 社数 n を必ず示し、中央値は n ≥ 3 のときだけ。順位・総合スコアは作らない
 *
 * 比較の年度を「最新の確定年度」ではなく比較データの年度にそろえるのは、自社の確定年度が指標ごとに
 * 違う（本社だけの指標は当年度が先に確定する）と、年度の違う値どうしを並べてしまうため。
 */

export type BenchmarkSource = 'demo' | 'none';

export const OWN_VALUE_STATUSES = [
  'confirmed',
  'incomplete',
  'not_calculated',
  'not_computable',
  'not_registered',
  'no_period',
] as const;
export type OwnValueStatus = (typeof OWN_VALUE_STATUSES)[number];

export interface OwnBenchmarkValue {
  status: OwnValueStatus;
  /** 確定値だけ。確定していなければ null（集計途中の値を比較に使わない） */
  value: number | null;
  /** 状態の表示（確定値／集計中（承認済み n/N 拠点）／未算定／全社値は算定不可 等） */
  label: string;
  reason: string | null;
  /** 自社の指標名（指標マスターの名前。未登録は null） */
  metricName: string | null;
  conditions: ComparisonConditions;
  approvedUnitCount: number;
  expectedUnitCount: number;
  /** 確定値が無いときに直すための画面（確定値なら null） */
  fix: { label: string; href: string } | null;
}

export interface BenchmarkPeerCell {
  peer: DemoPeer;
  value: DemoPeerValue | null;
  /** 値を開示しているか（未開示は比較・集計に入れない。0 にしない） */
  disclosed: boolean;
  /** 開示している社だけ判定する */
  comparability: Comparability | null;
}

export interface BenchmarkRow {
  metric: BenchmarkMetric;
  own: OwnBenchmarkValue;
  peers: BenchmarkPeerCell[];
  /** 比較できる社（開示あり・条件が同じ）だけの集計 */
  stats: PeerStatistics;
  peerTotal: number;
  undisclosedCount: number;
  notComparableCount: number;
}

export type BenchmarkView =
  | { source: 'none' }
  | {
      source: 'demo';
      fiscalYear: string;
      /** 自社の比較年度の報告期間（同じ年度が無ければ null） */
      ownPeriod: ReportingPeriod | null;
      ownFiscalYearEndMonth: number | null;
      peers: readonly DemoPeer[];
      rows: BenchmarkRow[];
    };

/** 自社の値の状態の表示 */
export const OWN_VALUE_STATUS_LABEL: Record<OwnValueStatus, string> = {
  confirmed: '確定値',
  incomplete: '集計中',
  not_calculated: '未算定',
  not_computable: '全社値は算定不可',
  not_registered: '未算定（指標が未登録）',
  no_period: '未算定（同じ年度の期間なし）',
};

/** 指標の分子・分母や指標そのものを登録する画面（指標マスター） */
const METRIC_MASTER_FIX = {
  label: '指標マスター（分子・分母の登録）',
  href: '/enterprise/organizations',
};

function endMonthOf(period: ReportingPeriod): number | null {
  const month = Number(period.endDate.slice(5, 7));
  return Number.isInteger(month) && month >= 1 && month <= 12 ? month : null;
}

async function ownValues(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod | null,
  periods: ReportingPeriod[],
): Promise<Map<string, OwnBenchmarkValue>> {
  const result = new Map<string, OwnBenchmarkValue>();
  const baseConditions = (unit: string): ComparisonConditions => ({
    unit,
    boundary: null,
    method: null,
    fiscalYear: period?.code ?? null,
    fiscalYearEndMonth: period ? endMonthOf(period) : null,
  });

  if (!period) {
    for (const spec of BENCHMARK_METRICS) {
      result.set(spec.key, {
        status: 'no_period',
        value: null,
        label: OWN_VALUE_STATUS_LABEL.no_period,
        reason: `自社に ${DEMO_PEER_FISCAL_YEAR} の報告期間がありません。`,
        metricName: null,
        conditions: { ...baseConditions(spec.unit), method: spec.ownMethod },
        approvedUnitCount: 0,
        expectedUnitCount: 0,
        // 報告年度は組織・拠点の「報告年度」タブで追加する（設定画面には期間の節が無い。N-16）
        fix: { label: '報告期間の設定', href: '/enterprise/organizations?tab=periods' },
      });
    }
    return result;
  }

  const organizationId = ctx.workspace.organizationId;
  const [metrics, units] = await Promise.all([
    db.select('metrics', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('units', { where: { organizationId, deletedAt: { isNull: true } } }),
  ]);
  const metricByCode = new Map(metrics.map((m) => [m.code, m]));
  const codes = BENCHMARK_METRICS.map((m) => m.ownMetricCode).filter((c) => metricByCode.has(c));
  const metricIds = codes.map((c) => metricByCode.get(c)!.id);
  const [aggregation, dataPoints] = await Promise.all([
    computeConsolidatedAggregation(db, ctx, period, periods, codes),
    metricIds.length === 0
      ? Promise.resolve([])
      : db.select('dataPoints', {
          where: {
            organizationId,
            reportingPeriodId: period.id,
            metricId: { in: metricIds },
            deletedAt: { isNull: true },
          },
        }),
  ]);

  for (const spec of BENCHMARK_METRICS) {
    const metric: MetricDefinition | undefined = metricByCode.get(spec.ownMetricCode);
    if (!metric) {
      result.set(spec.key, {
        status: 'not_registered',
        value: null,
        label: OWN_VALUE_STATUS_LABEL.not_registered,
        reason: `自社の指標（${spec.ownMetricCode}）が登録されていません。`,
        metricName: null,
        conditions: { ...baseConditions(spec.unit), method: spec.ownMethod },
        approvedUnitCount: 0,
        expectedUnitCount: 0,
        fix: METRIC_MASTER_FIX,
      });
      continue;
    }
    const rows = dataPoints.filter((d) => d.metricId === metric.id);
    const coverage = unitCoverageOf(metric, units, rows);
    const aggregate = aggregation.metrics.find((m) => m.metric.id === metric.id);
    const conditions: ComparisonConditions = {
      ...baseConditions(metric.unit),
      boundary: coverage.boundary,
      method: spec.ownMethod,
    };
    const common = {
      metricName: metric.name,
      conditions,
      approvedUnitCount: coverage.approvedUnits.length + coverage.notApplicableUnits.length,
      expectedUnitCount: coverage.expected.length,
    };
    // データの一覧はヘッダーで選んだ年度を表示し、URL では年度を選べない（年度の選択は Cookie）。
    // 開いた先が比較の年度と違って見えないよう、比較の年度をリンクの名前で示す
    const dataFix = {
      label: `この指標のデータ（${period.code}。年度は画面上部で選択）`,
      href: `/enterprise/data?metric=${metric.id}`,
    };

    // 全社値の求め方は指標の定義に従う（kpi.ts と同じ）。比率は分子・分母の合計からの加重平均だけ
    const hasRatioInputs = Boolean(metric.numeratorMetricCode && metric.denominatorMetricCode);
    let value: number | null;
    if (metric.aggregationMethod === 'sum') {
      value =
        aggregate && aggregate.consolidatedValueCount > 0 && coverage.boundary !== null
          ? aggregate.consolidated
          : null;
    } else if (hasRatioInputs) {
      value = aggregate?.weightedAverage ?? null;
    } else {
      result.set(spec.key, {
        status: 'not_computable',
        value: null,
        label: OWN_VALUE_STATUS_LABEL.not_computable,
        reason:
          '全社値は分子・分母の指標から再計算します。分子・分母が登録されていないため算定できません（拠点値の単純合計・単純平均は使いません）。',
        ...common,
        fix: METRIC_MASTER_FIX,
      });
      continue;
    }

    if (value === null) {
      result.set(spec.key, {
        status: 'not_calculated',
        value: null,
        label: OWN_VALUE_STATUS_LABEL.not_calculated,
        reason:
          rows.length === 0
            ? `${period.code} のデータが登録されていません（0 としては扱いません）。`
            : '承認済みの実績値がありません（未承認・推計・目標値は使いません）。',
        ...common,
        fix: dataFix,
      });
      continue;
    }
    if (!coverage.complete) {
      result.set(spec.key, {
        status: 'incomplete',
        value: null,
        label: `集計中（承認済み ${common.approvedUnitCount}/${common.expectedUnitCount} 拠点）`,
        reason: '対象の全拠点が承認済みになるまで、途中の集計値は比較に使いません。',
        ...common,
        fix: dataFix,
      });
      continue;
    }
    result.set(spec.key, {
      status: 'confirmed',
      value,
      label: OWN_VALUE_STATUS_LABEL.confirmed,
      reason: null,
      ...common,
      fix: null,
    });
  }
  return result;
}

/**
 * 他社比較を読む（書かない）。権限は enterprise.data.read（自社の値は承認済みデータの集計のため）。
 * source='none'（Supabase モード）は DB を読まずに空を返す
 */
export async function loadBenchmark(
  db: DbClient,
  ctx: AuthorizationContext,
  options: { source: BenchmarkSource },
): Promise<BenchmarkView> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.read');
  if (options.source !== 'demo') return { source: 'none' };

  const organizationId = ctx.workspace.organizationId;
  const periods = await db.select('periods', { where: { organizationId } });
  const ownPeriod =
    periods.find((p) => p.organizationId === organizationId && p.code === DEMO_PEER_FISCAL_YEAR) ??
    null;
  const own = await ownValues(db, ctx, ownPeriod, periods);

  const rows: BenchmarkRow[] = BENCHMARK_METRICS.map((metric) => {
    const ownValue = own.get(metric.key)!;
    const peers: BenchmarkPeerCell[] = DEMO_PEERS.map((peer) => {
      const value =
        DEMO_PEER_VALUES.find((v) => v.peerId === peer.id && v.metricKey === metric.key) ?? null;
      const disclosed = value !== null && value.value !== null;
      return {
        peer,
        value,
        disclosed,
        comparability:
          value && disclosed
            ? peerComparability(ownValue.conditions, {
                unit: value.unit,
                boundary: value.boundary,
                method: value.method,
                fiscalYear: value.fiscalYear,
                fiscalYearEndMonth: value.fiscalYearEndMonth,
              })
            : null,
      };
    });
    const comparableValues = peers
      .filter((c) => c.disclosed && c.comparability?.comparable)
      .map((c) => c.value!.value as number);
    return {
      metric,
      own: ownValue,
      peers,
      stats: peerStatistics(comparableValues),
      peerTotal: peers.length,
      undisclosedCount: peers.filter((c) => !c.disclosed).length,
      notComparableCount: peers.filter((c) => c.disclosed && !c.comparability?.comparable).length,
    };
  });

  return {
    source: 'demo',
    fiscalYear: DEMO_PEER_FISCAL_YEAR,
    ownPeriod,
    ownFiscalYearEndMonth: ownPeriod ? endMonthOf(ownPeriod) : null,
    peers: DEMO_PEERS,
    rows,
  };
}
