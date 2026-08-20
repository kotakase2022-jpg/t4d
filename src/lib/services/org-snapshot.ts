import 'server-only';

import type { DbClient } from '@/lib/repositories/types';
import { isCountedInTotals } from '@/lib/services/aggregation';
import { loadDisclosureWorkspace } from '@/lib/services/disclosure';
import type { AuthorizationContext, ReportingPeriod } from '@/types/domain';

/**
 * 組織の横断スナップショット。
 * インサイト（insightDiscovery）と Copilot 対話（copilotChat）が同じ入力を使う
 * （= 両機能の回答が同じ事実に基づく）。**承認済みデータのみ**を根拠にする。
 */

export interface MetricYoY {
  metricName: string;
  metricCode: string;
  unit: string;
  current: number | null;
  previous: number | null;
}

export interface UnitYoY {
  metricName: string;
  unitName: string;
  current: number | null;
  previous: number | null;
}

export interface OrgSnapshot {
  periodLabel: string;
  periodCode: string;
  previousPeriodLabel: string | null;
  submissionDueDate: string | null;
  metricYoY: MetricYoY[];
  unitYoY: UnitYoY[];
  collection: {
    total: number;
    approved: number;
    draft: number;
    submitted: number;
    returned: number;
  };
  quality: { openValidationErrors: number; approvedWithoutEvidence: number };
  disclosures: Array<{
    framework: string;
    total: number;
    requiredUnanswered: number;
    approved: number;
  }>;
  assurance: { openPbcRequests: number };
}

export async function collectOrgSnapshot(
  db: DbClient,
  ctx: AuthorizationContext,
  current: ReportingPeriod,
  periods: ReportingPeriod[],
): Promise<OrgSnapshot> {
  const organizationId = ctx.workspace.organizationId;
  const previous =
    periods
      .filter((p) => p.organizationId === organizationId && p.endDate < current.startDate)
      .sort((a, b) => (a.endDate < b.endDate ? 1 : -1))[0] ?? null;

  const [metrics, units, dataPoints, prevDataPoints] = await Promise.all([
    db.select('metrics', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('units', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('dataPoints', {
      where: { organizationId, reportingPeriodId: current.id, deletedAt: { isNull: true } },
    }),
    previous
      ? db.select('dataPoints', {
          where: { organizationId, reportingPeriodId: previous.id, deletedAt: { isNull: true } },
        })
      : Promise.resolve([]),
  ]);

  const metricById = new Map(metrics.map((m) => [m.id, m]));
  const unitById = new Map(units.map((u) => [u.id, u]));

  const sumBy = (rows: typeof dataPoints, keyOf: (r: (typeof dataPoints)[number]) => string) => {
    const acc = new Map<string, number>();
    for (const dp of rows) {
      if (dp.status !== 'approved' || dp.value === null || !isCountedInTotals(dp)) continue;
      acc.set(keyOf(dp), (acc.get(keyOf(dp)) ?? 0) + dp.value);
    }
    return acc;
  };
  const curByMetric = sumBy(dataPoints, (dp) => dp.metricId);
  const prevByMetric = sumBy(prevDataPoints, (dp) => dp.metricId);
  const curByMetricUnit = sumBy(dataPoints, (dp) => `${dp.metricId}/${dp.unitId}`);
  const prevByMetricUnit = sumBy(prevDataPoints, (dp) => `${dp.metricId}/${dp.unitId}`);

  const metricYoY: MetricYoY[] = [...metricById.values()]
    .map((m) => ({
      metricName: m.name,
      metricCode: m.code,
      unit: m.unit,
      current: curByMetric.get(m.id) ?? null,
      previous: prevByMetric.get(m.id) ?? null,
    }))
    .filter((m) => m.current !== null || m.previous !== null);

  const unitYoY: UnitYoY[] = [];
  for (const [key, cur] of curByMetricUnit) {
    const [mId, uId] = key.split('/');
    const metric = mId ? metricById.get(mId) : undefined;
    const unit = uId ? unitById.get(uId) : undefined;
    if (!metric || !unit) continue;
    unitYoY.push({
      metricName: metric.name,
      unitName: unit.name,
      current: cur,
      previous: prevByMetricUnit.get(key) ?? null,
    });
  }

  const statusCounts: Record<string, number> = {};
  for (const dp of dataPoints) statusCounts[dp.status] = (statusCounts[dp.status] ?? 0) + 1;

  const validations = await db.select('validations', {
    where: { organizationId, resolvedAt: { isNull: true } },
  });
  const dataPointIds = new Set(dataPoints.map((dp) => dp.id));
  const openErrors = validations.filter(
    (v) => v.severity === 'error' && dataPointIds.has(v.dataPointId),
  ).length;

  const evidenceLinks = await db.select('evidenceLinks', {
    where: { organizationId, targetType: 'data_point' },
  });
  const linkedDataPointIds = new Set(evidenceLinks.map((l) => l.targetId));
  const approvedWithoutEvidence = dataPoints.filter(
    (dp) =>
      dp.status === 'approved' &&
      !linkedDataPointIds.has(dp.id) &&
      metricById.get(dp.metricId)?.requiresEvidence,
  ).length;

  const disclosures: OrgSnapshot['disclosures'] = [];
  for (const key of ['cdp', 'csrd'] as const) {
    const ws = await loadDisclosureWorkspace(db, ctx, key, current, periods, metrics);
    if (!ws) continue;
    disclosures.push({
      framework: key.toUpperCase(),
      total: ws.rows.length,
      requiredUnanswered: ws.rows.filter((r) => {
        if (!r.item.required) return false;
        const resp = r.response;
        const answered = Boolean(
          resp && (resp.answerText || resp.answerNumeric !== null || resp.answerChoice.length > 0),
        );
        return !answered;
      }).length,
      approved: ws.summary.approved,
    });
  }

  const pbcRequests = await db.select('pbcRequests', {
    where: { clientOrganizationId: organizationId },
  });
  const openPbc = pbcRequests.filter(
    (p) =>
      p.status === 'sent' ||
      p.status === 'acknowledged' ||
      p.status === 'overdue' ||
      p.status === 'rejected',
  ).length;

  return {
    periodLabel: current.label,
    periodCode: current.code,
    previousPeriodLabel: previous ? previous.label : null,
    submissionDueDate: current.submissionDueDate,
    metricYoY,
    unitYoY,
    collection: {
      total: dataPoints.length,
      approved: statusCounts.approved ?? 0,
      draft: statusCounts.draft ?? 0,
      submitted: statusCounts.submitted ?? 0,
      returned: statusCounts.returned ?? 0,
    },
    quality: { openValidationErrors: openErrors, approvedWithoutEvidence },
    disclosures,
    assurance: { openPbcRequests: openPbc },
  };
}
