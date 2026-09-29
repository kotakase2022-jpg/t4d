import 'server-only';

import type { DocxSection } from '@/lib/exports';
import { SSBJ_FRAMEWORK_INFO } from '@/lib/frameworks/ssbj-2026';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import {
  evaluateDataCoverage,
  isCountedInTotals,
  sumValues,
  type DataCoverage,
} from '@/lib/services/aggregation';
import { loadSsbjDrafts } from '@/lib/services/ssbj-draft';

import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  DataPoint,
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

/** 対応付いた指標 1 つ分の値（異なる指標どうしは足さない。W0 O7） */
export interface DisclosureMetricValue {
  metric: MetricDefinition;
  /** 承認済みの実績値の合計（内部取引の明細行を除く）。値の行が無ければ null */
  currentValue: number | null;
  previousValue: number | null;
  /** 承認済みの推計値の合計（実績と混ぜない）。無ければ null */
  currentEstimate: number | null;
}

export interface DisclosureQuestionRow {
  item: DisclosureItem;
  response: DisclosureResponse | null;
  previousResponse: DisclosureResponse | null;
  mappings: DisclosureMapping[];
  mappedMetrics: MetricDefinition[];
  /** 指標ごとの値（mappedMetrics と同じ順） */
  metricValues: DisclosureMetricValue[];
  /** データの揃い具合。複数の指標を求める項目は、全指標に値があって初めて full */
  dataCoverage: DataCoverage;
  /** 値の無い指標（一部データあり・データなしの不足分） */
  missingMetrics: MetricDefinition[];
  /**
   * 当年値（YoY 比較に使う）。指標が 1 つだけ対応付いた項目のその指標の値。
   * 複数の指標を求める項目は、異なる指標を足した値に意味が無いため null
   * （metricValues を見る）。値の行が無いときも null（0 と区別する）
   */
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

  // 内部取引の明細行は控除用。通常の合計へ入れると二重計上になる。
  // 「データなし」は行の有無で決める（以前は合計が 0 なら null にしていたため、
  // 実績ゼロが「データなし」になっていた。W0 O4）
  const rowsOf = (rows: DataPoint[], metricId: Uuid) =>
    rows.filter((dp) => dp.metricId === metricId && isCountedInTotals(dp));
  const round2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);
  const metricValueOf = (metric: MetricDefinition): DisclosureMetricValue => ({
    metric,
    currentValue: round2(sumValues(rowsOf(approvedDataPoints, metric.id), 'actual').total),
    previousValue: round2(sumValues(rowsOf(previousApproved, metric.id), 'actual').total),
    currentEstimate: round2(sumValues(rowsOf(approvedDataPoints, metric.id), 'estimate').total),
  });

  const responseEvidence = await db.select('responseEvidenceLinks', { where: { organizationId } });

  const rows: DisclosureQuestionRow[] = items.map((item) => {
    const response = responseByItem.get(item.id) ?? null;
    const itemMappings = mappings.filter((m) => m.itemId === item.id);
    const mappedMetrics = [
      ...new Map(
        itemMappings
          .map((m) => metricById.get(m.metricId))
          .filter((m): m is MetricDefinition => Boolean(m))
          .map((m) => [m.id, m]),
      ).values(),
    ];

    // 指標ごとに別々に求める（Scope1 と Scope2 を足した値は開示に使えない）
    const metricValues = mappedMetrics.map((metric) => metricValueOf(metric));
    const withValue = new Set(
      metricValues
        .filter((v) => v.currentValue !== null || v.currentEstimate !== null)
        .map((v) => v.metric.id),
    );
    const { coverage, missing } = evaluateDataCoverage(mappedMetrics, withValue);
    const single = metricValues.length === 1 ? metricValues[0] : undefined;

    return {
      item,
      response,
      previousResponse: response?.previousResponseId
        ? (previousById.get(response.previousResponseId) ?? null)
        : null,
      mappings: itemMappings,
      mappedMetrics,
      metricValues,
      dataCoverage: coverage,
      missingMetrics: missing,
      currentValue: single?.currentValue ?? null,
      previousValue: single?.previousValue ?? null,
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

// ----------------------------------------------------------------------
// SSBJ の Word 出力（開示ドラフト画面「Word で書き出す」・レポート画面）
// ----------------------------------------------------------------------

/**
 * SSBJ の DOCX に載せる節。
 *
 * 以前は要求事項ごとの回答（SSBJ には回答が無い）を出しており、133 件すべてが
 * 「（未回答…）」の空欄になっていた。開示ドラフト画面で作った節別の本文
 * （ssbj_disclosure_drafts）を、確定／未確定を明記して出す（W0 棚卸し §2.2）。
 *
 * - 確定は企業内の確認であって、第三者保証ではない（そう書く）
 * - AI の草案に人の手が入っていないものは、その旨と生成元（Mock はデモ生成）を書く
 * - 定量指標は指標ごとの承認済みの値を並べる。異なる指標を足さない
 */
export async function buildSsbjDocxSections(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  periods: ReportingPeriod[],
  metrics: MetricDefinition[],
): Promise<{ title: string; sections: DocxSection[] } | null> {
  const [overview, workspace] = await Promise.all([
    loadSsbjDrafts(db, ctx, period),
    loadDisclosureWorkspace(db, ctx, 'ssbj', period, periods, metrics),
  ]);
  if (!overview || !workspace) return null;

  const drafts = overview.areas.flatMap((a) => (a.draft ? [a.draft] : []));
  const [profiles, aiRuns] = await Promise.all([
    drafts.some((d) => d.confirmedBy)
      ? db.select('profiles', {
          where: { id: { in: drafts.flatMap((d) => (d.confirmedBy ? [d.confirmedBy] : [])) } },
        })
      : Promise.resolve([]),
    drafts.some((d) => d.aiRunId)
      ? db.select('aiRuns', {
          where: {
            organizationId: ctx.workspace.organizationId,
            id: { in: drafts.flatMap((d) => (d.aiRunId ? [d.aiRunId] : [])) },
          },
        })
      : Promise.resolve([]),
  ]);
  const nameById = new Map(profiles.map((p) => [p.id, p.displayName]));
  const providerByRunId = new Map(aiRuns.map((r) => [r.id, r.provider]));

  const confirmedCount = overview.areas.filter((a) => a.draft?.confirmedAt).length;

  const sections: DocxSection[] = [
    {
      heading: '概要',
      paragraphs: [
        `対象組織: ${ctx.workspace.organizationName}`,
        `対象期間: ${period.label}`,
        `基準: ${workspace.versionLabel}${workspace.isFixture ? '（架空の縮小マスター）' : ''}`,
        `節の確定状況: 確定 ${confirmedCount} / ${overview.areas.length} 節`,
        '「確定」は社内の担当者が本文を確認して確定したことを示します。第三者による保証ではありません。',
        ...(workspace.isFixture ? [] : [SSBJ_FRAMEWORK_INFO.attribution]),
      ],
      table: {
        headers: ['節', '状態', '確定日時'],
        rows: overview.areas.map((area) => [
          area.areaLabel,
          area.draft?.confirmedAt ? '確定' : area.draft ? '未確定（下書き）' : '未作成',
          area.draft?.confirmedAt ? formatJst(area.draft.confirmedAt) : '—',
        ]),
      },
    },
  ];

  for (const area of overview.areas) {
    const draft = area.draft;
    if (!draft) {
      sections.push({
        heading: `${area.areaLabel}（未作成）`,
        paragraphs: ['この節の草案はまだありません。開示ドラフト画面で作成・確定してください。'],
      });
      continue;
    }
    const confirmed = draft.confirmedAt !== null;
    const unedited = draft.aiRunId !== null && draft.aiBody !== '' && draft.body === draft.aiBody;
    const provider = draft.aiRunId ? providerByRunId.get(draft.aiRunId) : undefined;
    const paragraphs: string[] = [
      confirmed
        ? `状態: 確定（${formatJst(draft.confirmedAt)}・確定者 ${
            (draft.confirmedBy && nameById.get(draft.confirmedBy)) ?? '—'
          }）`
        : '状態: 未確定（下書き）。開示前に内容の確認と確定が必要です。',
      ...(unedited
        ? [
            `この本文は AI の草案から人の修正が入っていません（${
              provider === 'mock' ? 'デモ生成（Mock）' : 'AI 生成'
            }）。確定の前に内容を確認してください。`,
          ]
        : []),
      ...draft.body
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== ''),
    ];
    if (draft.gaps.length > 0) {
      paragraphs.push(
        '書けなかった箇所:',
        ...draft.gaps.map((gap) => `【${gap.itemCode}】${gap.reason}`),
      );
    }
    if (draft.coveredItemCodes.length > 0) {
      paragraphs.push(`対応する要求事項: ${draft.coveredItemCodes.join('、')}`);
    }
    sections.push({
      heading: `${area.areaLabel}（${confirmed ? '確定' : '未確定'}）`,
      paragraphs,
    });
  }

  // 定量指標: 指標ごとの承認済みの値。値が無い指標は「値なし」と書く（0 と書かない）
  const metricRows = workspace.rows.flatMap((row) =>
    row.metricValues.map((value) => [
      row.item.code,
      value.metric.name,
      value.currentValue === null
        ? '値なし（承認済みの値がありません）'
        : `${formatNumber(value.currentValue)} ${value.metric.unit}`,
      value.previousValue === null
        ? '—'
        : `${formatNumber(value.previousValue)} ${value.metric.unit}`,
    ]),
  );
  if (metricRows.length > 0) {
    sections.push({
      heading: '定量指標（承認済みの値）',
      paragraphs: [
        '要求事項に対応付いた指標ごとの、承認済みの実績値です。異なる指標（Scope2 の 2 方式を含む）は足し合わせていません。',
      ],
      table: {
        headers: ['要求事項', '指標', `当年（${period.code}）`, '前年'],
        rows: metricRows,
      },
    });
  }

  return { title: `SSBJ 開示ドラフト ${period.code}`, sections };
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
