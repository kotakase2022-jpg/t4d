import 'server-only';

import { isUnitInScope } from '@/lib/authorization/can';
import { FIXTURE_TODAY } from '@/lib/config';
import { daysUntilJst, isOverdue, toJstDate } from '@/lib/format/datetime';
import { summarizeValidations } from '@/lib/validation/data-point-rules';
import {
  findDataPointIdsWithValidation,
  loadActiveValidations,
} from '@/lib/services/validation-store';
import type { DbClient, Query, Where } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  DataPoint,
  DataPointStatus,
  DataPointValidationResult,
  DisclosureResponse,
  MetricDefinition,
  OrganizationUnit,
  Page,
  ReportingPeriod,
  Uuid,
  WorkTask,
} from '@/types/domain';

/** 一覧 1 行分の表示モデル（指示書 15.2 の列に対応）。 */
export interface DataPointRow {
  dataPoint: DataPoint;
  metric: MetricDefinition;
  unit: OrganizationUnit;
  period: ReportingPeriod;
  evidenceCount: number;
  errorCount: number;
  warningCount: number;
  /** 現在のユーザーが編集できるか（Unit スコープ判定込み） */
  editable: boolean;
}

export interface DataPointFilters {
  status?: DataPointStatus[];
  metricIds?: Uuid[];
  unitIds?: Uuid[];
  search?: string;
  /** 検証エラーのみ / Evidence 不足のみ 等の絞り込み */
  flag?: 'validation_error' | 'missing_evidence' | 'changed_after_approval' | 'review_pending';
}

/**
 * 並べ替え可能な列（機能要件 UX-P0-004「並べ替え」）。
 *
 * 指標名・組織名は別テーブルの名称であり DB 側で結合していないため、
 * ここでは `data_points` が自前で持つ列だけを対象にする。
 * 名称順が必要になったら、一覧用のビューを作ってから追加すること
 * （ページ内だけを並べ替えると「全体の並び順」と食い違うため、
 *  メモリ内ソートでの実装は意図的に避けている）。
 */
export const DATA_POINT_SORT_KEYS = ['unit', 'value', 'status', 'updated'] as const;
export type DataPointSortKey = (typeof DATA_POINT_SORT_KEYS)[number];
export type SortDirection = 'asc' | 'desc';

const SORT_COLUMN: Record<DataPointSortKey, keyof DataPoint> = {
  unit: 'unitId',
  value: 'value',
  status: 'status',
  updated: 'updatedAt',
};

export function parseSortKey(value: string | undefined): DataPointSortKey | undefined {
  return DATA_POINT_SORT_KEYS.includes(value as DataPointSortKey)
    ? (value as DataPointSortKey)
    : undefined;
}

// ======================================================================
// 一覧（サーバーサイドページング）
// ======================================================================

/**
 * 検索語に一致する指標・組織の ID を解決する。
 *
 * 指標名・組織名は別テーブルにあり、DbClient は JOIN を持たない。
 * ただしこれらはテナントあたり数十件のマスターなので、
 * 先に ID へ解決してから `orWhere` で DB 側に渡せば全件 Load を避けられる。
 */
function resolveSearchIds(
  search: string,
  metrics: MetricDefinition[],
  units: OrganizationUnit[],
): { metricIds: Uuid[]; unitIds: Uuid[] } {
  const q = search.trim().toLowerCase();
  return {
    metricIds: metrics
      .filter((m) => `${m.name} ${m.code}`.toLowerCase().includes(q))
      .map((m) => m.id),
    unitIds: units.filter((u) => `${u.name} ${u.code}`.toLowerCase().includes(q)).map((u) => u.id),
  };
}

/** 空の結果ページ。 */
function emptyPage(page: number, pageSize: number): Page<DataPointRow> {
  return { rows: [], total: 0, page, pageSize };
}

/**
 * Data Point 一覧を **DB 側で絞り込み・ページング**して取得する。
 *
 * 全件をアプリへ読み込まない（指示書 21 章「主要一覧は Server Pagination /
 * 全件 Client Load を避ける」）。検証結果は `data_point_validation_results` へ
 * materialize 済みのものを参照するため、行をまたぐ判定もページ単位で扱える。
 */
export async function loadDataPointPage(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  metrics: MetricDefinition[],
  units: OrganizationUnit[],
  filters: DataPointFilters,
  page: number,
  pageSize: number,
  sort?: { key: DataPointSortKey; dir: SortDirection },
): Promise<Page<DataPointRow>> {
  const organizationId = ctx.workspace.organizationId;
  const safePage = Math.max(1, page);

  const where: Where<DataPoint> = {
    organizationId,
    reportingPeriodId: period.id,
    deletedAt: { isNull: true },
  };

  if (filters.status && filters.status.length > 0) where.status = { in: filters.status };
  if (filters.unitIds && filters.unitIds.length > 0) where.unitId = { in: filters.unitIds };
  if (filters.metricIds && filters.metricIds.length > 0) where.metricId = { in: filters.metricIds };

  // 要対応フラグ
  switch (filters.flag) {
    case 'validation_error': {
      const ids = await findDataPointIdsWithValidation(db, organizationId, { severity: 'error' });
      if (ids.length === 0) return emptyPage(safePage, pageSize);
      where.id = { in: ids };
      break;
    }
    case 'missing_evidence': {
      const ids = await findDataPointIdsWithValidation(db, organizationId, {
        ruleKey: 'missing_evidence',
      });
      if (ids.length === 0) return emptyPage(safePage, pageSize);
      where.id = { in: ids };
      break;
    }
    case 'changed_after_approval':
      where.changedAfterApproval = true;
      break;
    case 'review_pending':
      where.status = { in: ['submitted', 'in_review'] };
      break;
    default:
      break;
  }

  // 検索（指標名 OR 組織名）
  let orWhere: Array<Where<DataPoint>> | undefined;
  if (filters.search?.trim()) {
    const matched = resolveSearchIds(filters.search, metrics, units);
    if (matched.metricIds.length === 0 && matched.unitIds.length === 0) {
      return emptyPage(safePage, pageSize);
    }
    orWhere = [];
    if (matched.metricIds.length > 0) orWhere.push({ metricId: { in: matched.metricIds } });
    if (matched.unitIds.length > 0) orWhere.push({ unitId: { in: matched.unitIds } });
  }

  // 一意列（id）を最後に必ず含めてページングを安定させる。
  // 指定が無いときは従来どおり 組織 → 指標 の順。
  const orderBy: Query<DataPoint>['orderBy'] = sort
    ? [{ column: SORT_COLUMN[sort.key], dir: sort.dir }, { column: 'id' }]
    : [{ column: 'unitId' }, { column: 'metricId' }, { column: 'id' }];

  const query: Query<DataPoint> = {
    where,
    orWhere,
    orderBy,
    limit: pageSize,
    offset: (safePage - 1) * pageSize,
  };

  const [total, dataPoints] = await Promise.all([
    db.count('dataPoints', { where, orWhere }),
    db.select('dataPoints', query),
  ]);

  if (dataPoints.length === 0) return { rows: [], total, page: safePage, pageSize };

  // ここから先は「このページの行」だけを対象にする
  const pageIds = dataPoints.map((dp) => dp.id);
  const [validations, evidenceLinks] = await Promise.all([
    loadActiveValidations(db, organizationId, pageIds),
    db.select('evidenceLinks', {
      where: { organizationId, targetType: 'data_point', targetId: { in: pageIds } },
    }),
  ]);

  const summary = summarizeValidations(validations);
  const evidenceCount = new Map<Uuid, number>();
  for (const link of evidenceLinks) {
    evidenceCount.set(link.targetId, (evidenceCount.get(link.targetId) ?? 0) + 1);
  }

  const metricById = new Map(metrics.map((m) => [m.id, m]));
  const unitById = new Map(units.map((u) => [u.id, u]));

  const rows: DataPointRow[] = [];
  for (const dp of dataPoints) {
    const metric = metricById.get(dp.metricId);
    const unit = unitById.get(dp.unitId);
    if (!metric || !unit) continue;
    const counts = summary.byDataPoint.get(dp.id) ?? { errors: 0, warnings: 0 };
    rows.push({
      dataPoint: dp,
      metric,
      unit,
      period,
      evidenceCount: evidenceCount.get(dp.id) ?? 0,
      errorCount: counts.errors,
      warningCount: counts.warnings,
      editable: isUnitInScope(ctx, dp.unitId) && dp.status !== 'approved',
    });
  }

  return { rows, total, page: safePage, pageSize };
}

// ======================================================================
// 期間全体のデータセット（集計・Export・GHG 用）
// ======================================================================

export interface PeriodDataset {
  dataPoints: DataPoint[];
  validations: DataPointValidationResult[];
  evidenceCountByDataPoint: Map<Uuid, number>;
  metricById: Map<Uuid, MetricDefinition>;
  unitById: Map<Uuid, OrganizationUnit>;
}

/**
 * 指定報告期間の Data Point 一式と、**永続化済み**の検証結果を読み込む。
 *
 * 一覧（ページング）では使わない。集計・Export・GHG のように
 * 期間全体を対象とする画面のためのもの。
 */
export async function loadPeriodDataset(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  metrics: MetricDefinition[],
  units: OrganizationUnit[],
  _periods: ReportingPeriod[],
): Promise<PeriodDataset> {
  const organizationId = ctx.workspace.organizationId;

  const dataPoints = await db.select('dataPoints', {
    where: { organizationId, reportingPeriodId: period.id, deletedAt: { isNull: true } },
  });

  const evidenceLinks = await db.select('evidenceLinks', {
    where: { organizationId, targetType: 'data_point' },
  });
  const evidenceCountByDataPoint = new Map<Uuid, number>();
  for (const link of evidenceLinks) {
    evidenceCountByDataPoint.set(
      link.targetId,
      (evidenceCountByDataPoint.get(link.targetId) ?? 0) + 1,
    );
  }

  const validations = await loadActiveValidations(
    db,
    organizationId,
    dataPoints.map((dp) => dp.id),
  );

  return {
    dataPoints,
    validations,
    evidenceCountByDataPoint,
    metricById: new Map(metrics.map((m) => [m.id, m])),
    unitById: new Map(units.map((u) => [u.id, u])),
  };
}

export function buildDataPointRows(
  dataset: PeriodDataset,
  period: ReportingPeriod,
  ctx: AuthorizationContext,
): DataPointRow[] {
  const summary = summarizeValidations(dataset.validations);
  const rows: DataPointRow[] = [];
  for (const dp of dataset.dataPoints) {
    const metric = dataset.metricById.get(dp.metricId);
    const unit = dataset.unitById.get(dp.unitId);
    if (!metric || !unit) continue;
    const counts = summary.byDataPoint.get(dp.id) ?? { errors: 0, warnings: 0 };
    rows.push({
      dataPoint: dp,
      metric,
      unit,
      period,
      evidenceCount: dataset.evidenceCountByDataPoint.get(dp.id) ?? 0,
      errorCount: counts.errors,
      warningCount: counts.warnings,
      editable: isUnitInScope(ctx, dp.unitId) && dp.status !== 'approved',
    });
  }
  return rows;
}

// ======================================================================
// ダッシュボード
// ======================================================================

export interface EnterpriseDashboardData {
  overdueCount: number;
  notSubmittedCount: number;
  validationErrorCount: number;
  missingEvidenceCount: number;
  reviewPendingCount: number;
  approvalRate: number;
  cdpReadiness: number;
  changedAfterApprovalCount: number;
  unitProgress: Array<{
    unit: OrganizationUnit;
    total: number;
    approved: number;
    submitted: number;
    notStarted: number;
    errors: number;
    progressPercent: number;
  }>;
  todaysTasks: WorkTask[];
  overdueTasks: WorkTask[];
  topAlerts: DataPointValidationResult[];
  recentActivity: Array<{ id: string; label: string; at: string }>;
}

/**
 * ダッシュボードの KPI。
 * 件数はすべて `db.count()`（DB 側集計）で求め、行そのものは読み込まない。
 */
export async function loadEnterpriseDashboard(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  units: OrganizationUnit[],
  metrics: MetricDefinition[],
): Promise<EnterpriseDashboardData> {
  const organizationId = ctx.workspace.organizationId;
  const base: Where<DataPoint> = {
    organizationId,
    reportingPeriodId: period.id,
    deletedAt: { isNull: true },
  };

  const [total, notSubmittedCount, reviewPendingCount, approvedCount, changedAfterApprovalCount] =
    await Promise.all([
      db.count('dataPoints', { where: base }),
      db.count('dataPoints', { where: { ...base, status: { in: ['not_started', 'draft'] } } }),
      db.count('dataPoints', { where: { ...base, status: { in: ['submitted', 'in_review'] } } }),
      db.count('dataPoints', { where: { ...base, status: 'approved' } }),
      db.count('dataPoints', { where: { ...base, changedAfterApproval: true } }),
    ]);

  const [errorIds, missingEvidenceIds] = await Promise.all([
    findDataPointIdsWithValidation(db, organizationId, { severity: 'error' }),
    findDataPointIdsWithValidation(db, organizationId, { ruleKey: 'missing_evidence' }),
  ]);

  const tasks = await db.select('tasks', {
    where: { organizationId, status: { notIn: ['done', 'cancelled'] } },
    orderBy: { column: 'dueDate' },
  });
  const overdueTasks = tasks.filter((t) => isOverdue(t.dueDate, FIXTURE_TODAY));
  const todaysTasks = tasks.filter((t) => {
    const diff = daysUntilJst(t.dueDate, FIXTURE_TODAY);
    return diff !== null && diff >= 0 && diff <= 7;
  });

  const responses = await db.select('disclosureResponses', {
    where: { organizationId, reportingPeriodId: period.id },
  });

  // 拠点別進捗: 拠点数は数件なので拠点ごとの count で足りる
  const reportableUnits = units.filter((u) => u.unitType !== 'supplier');
  const unitProgress = await Promise.all(
    reportableUnits.map(async (unit) => {
      const unitWhere = { ...base, unitId: unit.id };
      const [unitTotal, approved, submitted, notStarted] = await Promise.all([
        db.count('dataPoints', { where: unitWhere }),
        db.count('dataPoints', { where: { ...unitWhere, status: 'approved' } }),
        db.count('dataPoints', {
          where: { ...unitWhere, status: { in: ['submitted', 'in_review'] } },
        }),
        db.count('dataPoints', {
          where: { ...unitWhere, status: { in: ['not_started', 'draft'] } },
        }),
      ]);
      const unitErrorIds =
        errorIds.length === 0
          ? []
          : await db.select('dataPoints', {
              where: { ...unitWhere, id: { in: errorIds } },
            });
      return {
        unit,
        total: unitTotal,
        approved,
        submitted,
        notStarted,
        errors: unitErrorIds.length,
        progressPercent: unitTotal === 0 ? 0 : Math.round((approved / unitTotal) * 100),
      };
    }),
  );

  const topAlerts = (
    await db.select('validations', {
      where: { organizationId, severity: 'error', resolvedAt: { isNull: true } },
      orderBy: { column: 'detectedAt', dir: 'desc' },
      limit: 8,
    })
  ).slice(0, 8);

  const versions = await db.select('dataPointVersions', {
    where: { organizationId },
    orderBy: [{ column: 'createdAt', dir: 'desc' }, { column: 'id' }],
    limit: 8,
  });
  const versionDataPointIds = [...new Set(versions.map((v) => v.dataPointId))];
  const versionDataPoints =
    versionDataPointIds.length === 0
      ? []
      : await db.select('dataPoints', { where: { id: { in: versionDataPointIds } } });
  const metricById = new Map(metrics.map((m) => [m.id, m]));
  const unitById = new Map(units.map((u) => [u.id, u]));

  const recentActivity = versions.map((v) => {
    const dp = versionDataPoints.find((d) => d.id === v.dataPointId);
    const metric = dp ? metricById.get(dp.metricId) : undefined;
    const unit = dp ? unitById.get(dp.unitId) : undefined;
    return {
      id: v.id,
      label: `${unit?.name ?? '—'} / ${metric?.name ?? '—'} を v${v.versionNo} へ更新（${
        v.changeReason ?? v.sourceReference ?? '初回登録'
      }）`,
      at: v.createdAt,
    };
  });

  return {
    overdueCount: overdueTasks.length,
    notSubmittedCount,
    validationErrorCount: errorIds.length,
    missingEvidenceCount: missingEvidenceIds.length,
    reviewPendingCount,
    approvalRate: total === 0 ? 0 : Math.round((approvedCount / total) * 100),
    cdpReadiness: readinessPercent(responses),
    changedAfterApprovalCount,
    unitProgress,
    todaysTasks: todaysTasks.slice(0, 8),
    overdueTasks: overdueTasks.slice(0, 8),
    topAlerts,
    recentActivity,
  };
}

export function readinessPercent(responses: DisclosureResponse[]): number {
  if (responses.length === 0) return 0;
  const done = responses.filter(
    (r) => r.status === 'approved' || r.status === 'in_review' || r.status === 'draft',
  ).length;
  return Math.round((done / responses.length) * 100);
}

export function jstToday(): string {
  return toJstDate(new Date().toISOString());
}
