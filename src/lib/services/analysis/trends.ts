import 'server-only';

import { assertCan, assertEnterpriseWorkspace } from '@/lib/authorization/can';
import {
  buildTrendRow,
  INTERCOMPANY_BOUNDARY,
  isTrendMetric,
  sortTrendRows,
  summarizeTrends,
  TREND_WINDOW_YEARS,
  trendWindowNote,
  type MetricTrendRowView,
  type TrendCell,
  type TrendSummary,
} from '@/lib/domain/metric-trend';
import { KPI_KEYS, KPI_SPECS, loadMetricYearStates, type KpiKey } from '@/lib/services/kpi';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AggregationMethod,
  AuthorizationContext,
  DataPointStatus,
  MetricCategory,
  MetricDataType,
  ReportingPeriod,
  Uuid,
} from '@/types/domain';

/**
 * 自社経年比較（docs/disclosure-first.md §10.2）。閲覧専用（書かない）。
 *
 * 年度の窓: ヘッダーの年度（Cookie）を終点に、開始日がそれ以前のこの組織の期間を新しい順に最大 3 つ
 * （年度コードの文字列では並べない）。データの無い年度も列に出す。
 * 値: 数値指標すべて（削除済みを除く）を kpi.ts の loadMetricYearStates で 1 回に読む（ESG経営・他社比較と
 * 同じ規則。合計は承認済みの連結値、比率は分子・分母の加重平均、それ以外は全社値は算定不可）。
 * 推計・前年値補完・目標・途中合計は値の欄と前年比に使わない（内訳に参考として出すだけ）。
 * セル・前年比・絞込・要約は domain/metric-trend.ts の純関数。
 */

export interface TrendMetric {
  id: Uuid;
  code: string;
  name: string;
  description: string;
  unit: string;
  category: MetricCategory;
  dataType: MetricDataType;
  aggregationMethod: AggregationMethod;
  numeratorMetricCode: string | null;
  denominatorMetricCode: string | null;
  yoyWarningRatio: number | null;
}

export interface TrendUnitValue {
  unitName: string;
  value: number | null;
  unitOfMeasure: string;
  statusLabel: string;
  consolidationLabel: string;
}

/** 内訳に出す 1 年度分（承認の状況・参考値・算定不可の拠点値・検証結果） */
export interface TrendYearDetail {
  period: ReportingPeriod;
  cell: TrendCell;
  /** ESG経営と同じ状態の表示（「確定（全拠点承認済み）」等） */
  stateLabel: string;
  /** 未承認・未入力・対象外・推計などの内訳（ESG経営と同じ文） */
  details: string[];
  /** 承認済み分のみの途中集計（確定していない年度だけ。比較に使わない） */
  partialValue: number | null;
  /** 推計込みの連結値（参考。合計の指標で推計があるときだけ） */
  referenceWithEstimates: number | null;
  /** 全社値を算定できない指標の拠点値（連結値に入らない拠点も含めて示す） */
  unitValues: TrendUnitValue[];
  /** この指標・年度の未解決の検証結果 */
  validation: { errors: number; warnings: number };
}

export interface TrendLink {
  label: string;
  href: string;
}

export interface MetricTrendRow extends MetricTrendRowView<TrendMetric> {
  years: TrendYearDetail[];
  /** 前年比の列の見出し（changes と同じ順。「FY2024→FY2025」） */
  changeLabels: string[];
  links: TrendLink[];
}

export interface MetricTrendsView {
  /** ヘッダーで選んだ年度（窓の終点） */
  period: ReportingPeriod;
  /** 窓の年度（開始日の昇順。最大 3） */
  periods: ReportingPeriod[];
  /** 窓が 3 年度に満たないときの注記 */
  windowNote: string | null;
  /** 群の順（GHG → 環境 → 社会 → ガバナンス）。絞込は画面側（filterMetricTrendRows） */
  rows: MetricTrendRow[];
  summary: TrendSummary;
}

const STATUS_LABEL: Record<DataPointStatus, string> = {
  not_started: '未着手',
  draft: '入力中',
  submitted: '提出済み',
  in_review: 'レビュー中',
  returned: '差戻し',
  approved: '承認済み',
};

/** 年度の窓（ヘッダーの年度を終点に、開始日がそれ以前の期間を新しい順に最大 3 つ → 昇順） */
export function trendWindowOf(
  period: ReportingPeriod,
  periods: readonly ReportingPeriod[],
  organizationId: Uuid,
): ReportingPeriod[] {
  return periods
    .filter((p) => p.organizationId === organizationId && p.startDate <= period.startDate)
    .sort((a, b) => (a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : 0))
    .slice(0, TREND_WINDOW_YEARS)
    .reverse();
}

/** 指標コード → ESG経営の KPI（主指標・副指標のどちらでも、その KPI の詳細画面へ） */
function kpiKeyByMetricCode(): Map<string, KpiKey> {
  const map = new Map<string, KpiKey>();
  for (const key of KPI_KEYS) {
    const spec = KPI_SPECS[key];
    for (const code of [spec.metricCode, ...spec.subMetricCodes]) {
      if (!map.has(code)) map.set(code, key);
    }
  }
  return map;
}

/**
 * 自社経年比較を読む（書かない）。権限は enterprise.data.read（全 enterprise 役割が持つ）。
 * 監査法人のワークスペースからは読めない
 */
export async function loadMetricTrends(
  db: DbClient,
  ctx: AuthorizationContext,
  { period, periods }: { period: ReportingPeriod; periods: readonly ReportingPeriod[] },
): Promise<MetricTrendsView> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.read');
  const organizationId = ctx.workspace.organizationId;
  const window = trendWindowOf(period, periods, organizationId);

  // 並びは指標マスターの登録順（群の中の順。Demo は Fixture の順）
  const metrics = (
    await db.select('metrics', {
      where: { organizationId, deletedAt: { isNull: true } },
      orderBy: { column: 'createdAt' },
    })
  ).filter(isTrendMetric);

  const states = await loadMetricYearStates(db, ctx, {
    metricCodes: metrics.map((m) => m.code),
    periodIds: window.map((p) => p.id),
  });

  // 検証結果（未解決）を指標 × 年度で数える。内訳から一覧の検証エラーへ進めるように
  const dataPointIds = [
    ...new Set(
      states.rows
        .flatMap((r) => r.years.flatMap((y) => y.state.contributions))
        .map((c) => c.dataPointId),
    ),
  ];
  const validations =
    dataPointIds.length === 0
      ? []
      : await db.select('validations', {
          where: {
            organizationId,
            dataPointId: { in: dataPointIds },
            resolvedAt: { isNull: true },
          },
        });
  const validationByDataPoint = new Map<Uuid, { errors: number; warnings: number }>();
  for (const v of validations) {
    const entry = validationByDataPoint.get(v.dataPointId) ?? { errors: 0, warnings: 0 };
    if (v.severity === 'error') entry.errors += 1;
    else if (v.severity === 'warning') entry.warnings += 1;
    validationByDataPoint.set(v.dataPointId, entry);
  }

  const kpiKeys = kpiKeyByMetricCode();
  const rows: MetricTrendRow[] = states.rows.map((source) => {
    const metric: TrendMetric = {
      id: source.metric.id,
      code: source.metric.code,
      name: source.metric.name,
      description: source.metric.description,
      unit: source.metric.unit,
      category: source.metric.category,
      dataType: source.metric.dataType,
      aggregationMethod: source.metric.aggregationMethod,
      numeratorMetricCode: source.metric.numeratorMetricCode,
      denominatorMetricCode: source.metric.denominatorMetricCode,
      yoyWarningRatio: source.metric.yoyWarningRatio,
    };
    const view = buildTrendRow({ metric, years: source.years, changes: source.changes });
    const years: TrendYearDetail[] = source.years.map((year, index) => {
      const { state } = year;
      const validation = { errors: 0, warnings: 0 };
      for (const c of state.contributions) {
        const hit = validationByDataPoint.get(c.dataPointId);
        if (!hit) continue;
        validation.errors += hit.errors;
        validation.warnings += hit.warnings;
      }
      return {
        period: year.period,
        cell: view.cells[index]!,
        stateLabel: year.display.label,
        details: year.display.details,
        partialValue:
          state.computable && !state.complete && state.approvedValue !== null
            ? state.approvedValue
            : null,
        referenceWithEstimates: year.referenceWithEstimates,
        unitValues: state.computable
          ? []
          : state.contributions
              .filter((c) => c.boundary !== INTERCOMPANY_BOUNDARY)
              .map((c) => ({
                unitName: c.unitName,
                value: c.value,
                unitOfMeasure: c.unitOfMeasure,
                statusLabel: STATUS_LABEL[c.status],
                consolidationLabel: c.consolidationLabel,
              })),
        validation,
      };
    });

    const links: TrendLink[] = [];
    const kpiKey = kpiKeys.get(metric.code);
    if (kpiKey) {
      links.push({
        label: `ESG経営の KPI「${KPI_SPECS[kpiKey].label}」`,
        href: `/enterprise/esg/${kpiKey}`,
      });
    }
    if (metric.category === 'ghg') {
      links.push({ label: 'GHG 排出量（連結集計）', href: '/enterprise/ghg' });
    }
    // データの一覧の年度はヘッダー（Cookie）で決まり、URL では選べない。開いた先の年度が分かるよう文言に書く
    links.push({
      label: `この指標のデータ（${period.code} の一覧。年度は画面上部で選択）`,
      href: `/enterprise/data?metric=${metric.id}`,
    });
    const latest = years[years.length - 1];
    if (latest && latest.period.id === period.id && latest.validation.errors > 0) {
      links.push({
        label: `この指標の検証エラー（${period.code} の一覧）`,
        href: `/enterprise/data?metric=${metric.id}&flag=validation_error`,
      });
    }

    return {
      ...view,
      years,
      changeLabels: source.years
        .slice(1)
        .map((year, index) => `${source.years[index]!.period.code}→${year.period.code}`),
      links,
    };
  });

  const sorted = sortTrendRows(rows);
  return {
    period,
    periods: states.periods,
    windowNote: trendWindowNote(states.periods.length),
    rows: sorted,
    summary: summarizeTrends(sorted),
  };
}
