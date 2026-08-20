import 'server-only';

import { isCountedInTotals } from '@/lib/services/aggregation';

import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  DisclosureItem,
  DisclosureMapping,
  DisclosureResponse,
  FrameworkKey,
  MetricDefinition,
  ReportingPeriod,
  Uuid,
} from '@/types/domain';

/**
 * 開示ワークスペース（指示書 15.4 / CDP-P0-001〜007）。
 *
 * 前年 Version との差分（新規 / 変更 / 継続）と、承認済みデータからのマッピングを扱う。
 */

export interface DisclosureQuestionRow {
  item: DisclosureItem;
  response: DisclosureResponse | null;
  previousResponse: DisclosureResponse | null;
  mappings: DisclosureMapping[];
  mappedMetrics: MetricDefinition[];
  /** マッピングされた承認済みデータの合計（YoY 比較に使う） */
  currentValue: number | null;
  previousValue: number | null;
  evidenceCount: number;
  priority: 'critical' | 'high' | 'medium' | 'low';
}

export interface DisclosureWorkspace {
  frameworkKey: FrameworkKey;
  versionLabel: string;
  isFixture: boolean;
  period: ReportingPeriod;
  previousPeriod: ReportingPeriod | null;
  rows: DisclosureQuestionRow[];
  sections: string[];
  summary: {
    total: number;
    approved: number;
    draft: number;
    notStarted: number;
    newItems: number;
    changedItems: number;
    carryForward: number;
    readiness: number;
  };
}

function priorityFor(
  item: DisclosureItem,
  response: DisclosureResponse | null,
): DisclosureQuestionRow['priority'] {
  if (response?.status === 'approved') return 'low';
  if (item.changeType === 'new' && item.required) return 'critical';
  if (item.changeType === 'changed' && item.required) return 'high';
  if (item.required) return 'medium';
  return 'low';
}

export async function loadDisclosureWorkspace(
  db: DbClient,
  ctx: AuthorizationContext,
  frameworkKey: FrameworkKey,
  period: ReportingPeriod,
  periods: ReportingPeriod[],
  metrics: MetricDefinition[],
): Promise<DisclosureWorkspace | null> {
  const organizationId = ctx.workspace.organizationId;

  const frameworks = await db.select('frameworks', { where: { key: frameworkKey }, limit: 1 });
  const framework = frameworks[0];
  if (!framework) return null;

  const versions = await db.select('frameworkVersions', {
    where: { frameworkId: framework.id },
    orderBy: { column: 'year', dir: 'desc' },
  });
  const current = versions.find((v) => v.status === 'published') ?? versions[0];
  if (!current) return null;

  const items = await db.select('disclosureItems', {
    where: { frameworkVersionId: current.id },
    orderBy: { column: 'sortOrder' },
  });

  const responses = await db.select('disclosureResponses', {
    where: { organizationId, reportingPeriodId: period.id },
  });
  const responseByItem = new Map(responses.map((r) => [r.itemId, r]));

  const previousPeriod =
    periods
      .filter((p) => p.startDate < period.startDate)
      .sort((a, b) => (a.startDate < b.startDate ? 1 : -1))[0] ?? null;

  const previousResponses = previousPeriod
    ? await db.select('disclosureResponses', {
        where: { organizationId, reportingPeriodId: previousPeriod.id },
      })
    : [];
  const previousById = new Map(previousResponses.map((r) => [r.id, r]));

  const mappings = await db.select('disclosureMappings', { where: { organizationId } });
  const metricById = new Map(metrics.map((m) => [m.id, m]));

  const approvedDataPoints = await db.select('dataPoints', {
    where: {
      organizationId,
      reportingPeriodId: period.id,
      status: 'approved',
      deletedAt: { isNull: true },
    },
  });
  const previousApproved = previousPeriod
    ? await db.select('dataPoints', {
        where: {
          organizationId,
          reportingPeriodId: previousPeriod.id,
          status: 'approved',
          deletedAt: { isNull: true },
        },
      })
    : [];

  const sumByMetric = (rows: typeof approvedDataPoints, metricId: Uuid) =>
    rows
      // 内部取引の明細行は控除用。通常の合計へ入れると二重計上になる
      .filter((dp) => dp.metricId === metricId && isCountedInTotals(dp))
      .reduce((sum, dp) => sum + (dp.value ?? 0), 0);

  const responseEvidence = await db.select('responseEvidenceLinks', { where: { organizationId } });

  const rows: DisclosureQuestionRow[] = items.map((item) => {
    const response = responseByItem.get(item.id) ?? null;
    const itemMappings = mappings.filter((m) => m.itemId === item.id);
    const mappedMetrics = itemMappings
      .map((m) => metricById.get(m.metricId))
      .filter((m): m is MetricDefinition => Boolean(m));

    let currentValue: number | null = null;
    let previousValue: number | null = null;
    if (mappedMetrics.length > 0) {
      const first = mappedMetrics[0];
      if (first) {
        const currentSum = sumByMetric(approvedDataPoints, first.id);
        currentValue = currentSum === 0 ? null : Math.round(currentSum * 100) / 100;
        const previousSum = sumByMetric(previousApproved, first.id);
        previousValue = previousSum === 0 ? null : Math.round(previousSum * 100) / 100;
      }
    }

    return {
      item,
      response,
      previousResponse: response?.previousResponseId
        ? (previousById.get(response.previousResponseId) ?? null)
        : null,
      mappings: itemMappings,
      mappedMetrics,
      currentValue,
      previousValue,
      evidenceCount: response
        ? responseEvidence.filter((l) => l.responseId === response.id).length
        : 0,
      priority: priorityFor(item, response),
    };
  });

  const approved = rows.filter((r) => r.response?.status === 'approved').length;
  const draft = rows.filter(
    (r) => r.response?.status === 'draft' || r.response?.status === 'in_review',
  ).length;
  const notStarted = rows.filter((r) => !r.response || r.response.status === 'not_started').length;

  return {
    frameworkKey,
    versionLabel: current.label,
    isFixture: current.isFixture,
    period,
    previousPeriod,
    rows,
    sections: [...new Set(items.map((i) => i.section))],
    summary: {
      total: rows.length,
      approved,
      draft,
      notStarted,
      newItems: rows.filter((r) => r.item.changeType === 'new').length,
      changedItems: rows.filter((r) => r.item.changeType === 'changed').length,
      carryForward: rows.filter((r) => r.item.changeType === 'carry_forward').length,
      readiness: rows.length === 0 ? 0 : Math.round(((approved + draft) / rows.length) * 100),
    },
  };
}

export function filterDisclosureRows(
  rows: DisclosureQuestionRow[],
  filters: { changeType?: string; status?: string; search?: string; onlyDiff?: boolean },
): DisclosureQuestionRow[] {
  const search = filters.search?.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.onlyDiff && row.item.changeType === 'carry_forward') return false;
    if (filters.changeType && row.item.changeType !== filters.changeType) return false;
    if (filters.status) {
      const status = row.response?.status ?? 'not_started';
      if (status !== filters.status) return false;
    }
    if (search) {
      const haystack =
        `${row.item.code} ${row.item.questionText} ${row.item.section}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}
