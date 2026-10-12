import 'server-only';

import { permissionsFor } from '@/lib/authorization/can';
import type { DocxSection } from '@/lib/exports';
import { diffFrameworkItems, type FrameworkDiff } from '@/lib/domain/framework-diff';
import { ValidationError } from '@/lib/errors/user-facing';
import { SSBJ_FRAMEWORK_INFO } from '@/lib/frameworks/ssbj-2026';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import {
  evaluateDataCoverage,
  isCountedInTotals,
  sumValues,
  type DataCoverage,
} from '@/lib/services/aggregation';
import { hasOption, OPTION_NOT_CONTRACTED_MESSAGES } from '@/lib/services/organization-options';
import { loadSsbjDrafts } from '@/lib/services/ssbj-draft';
import { resolveSsbjVersion, ssbjVersionStamp } from '@/lib/services/ssbj-gap';

import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  DataPoint,
  DisclosureFrameworkVersion,
  DisclosureItem,
  DisclosureMapping,
  DisclosureResponse,
  FrameworkKey,
  MetricDefinition,
  OrganizationOptionKey,
  ReportingPeriod,
  ResponseContentLink,
  Uuid,
} from '@/types/domain';

/**
 * 開示ワークスペース（指示書 15.4 / CDP-P0-001〜007）。
 *
 * 前年 Version との差分（新規 / 変更 / 継続）と、承認済みデータからのマッピングを扱う。
 */

// ----------------------------------------------------------------------
// 契約で開く基準（トライアル対応 NF-38）
// ----------------------------------------------------------------------

/**
 * 組織の契約（organization_options）が無いと使えない基準。CDP は基本の提供範囲から切り分けた
 * 有償のオプションで、顧客の管理者が自分で開けない（運営が設定する）。
 * 回答画面・出力・AI の Action は CDP と CSRD で共用のため、**項目の基準**で判定する
 */
const OPTION_GATED_FRAMEWORKS: Partial<Record<FrameworkKey, OrganizationOptionKey>> = {
  cdp: 'cdp',
};

/** 契約が無い基準を使おうとした（利用者にそのまま見せる。権限の拒否ではないので access_denied にしない） */
export class FrameworkOptionNotContractedError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'FrameworkOptionNotContractedError';
  }
}

/** 基準が今の組織で使えるか（契約が要らない基準は常に true） */
export async function isFrameworkAvailable(
  db: DbClient,
  ctx: AuthorizationContext,
  frameworkKey: FrameworkKey,
): Promise<boolean> {
  const option = OPTION_GATED_FRAMEWORKS[frameworkKey];
  return option ? hasOption(db, ctx, option) : true;
}

/** 契約が無ければ理由付きで止める（画面・出力・Action の共通の入口） */
export async function assertFrameworkAvailable(
  db: DbClient,
  ctx: AuthorizationContext,
  frameworkKey: FrameworkKey,
): Promise<void> {
  const option = OPTION_GATED_FRAMEWORKS[frameworkKey];
  if (option && !(await hasOption(db, ctx, option))) {
    throw new FrameworkOptionNotContractedError(OPTION_NOT_CONTRACTED_MESSAGES[option]);
  }
}

/** 項目（質問・要求事項）が属する基準のキー。マスターに無ければ null */
export async function frameworkKeyOfItem(
  db: DbClient,
  item: Pick<DisclosureItem, 'frameworkVersionId'>,
): Promise<FrameworkKey | null> {
  const version = await db.findById('frameworkVersions', item.frameworkVersionId);
  const framework = version ? await db.findById('frameworks', version.frameworkId) : null;
  return framework?.key ?? null;
}

/** 項目の基準で契約を確かめる（CDP の質問なら CDP 対応オプションが要る） */
export async function assertItemAvailable(
  db: DbClient,
  ctx: AuthorizationContext,
  item: Pick<DisclosureItem, 'frameworkVersionId'>,
): Promise<void> {
  const key = await frameworkKeyOfItem(db, item);
  if (key) await assertFrameworkAvailable(db, ctx, key);
}

// ----------------------------------------------------------------------
// 期間と版の対応（NF-39 C-09）
// ----------------------------------------------------------------------

/** 期間の開始の年（FY2026 = 2026-04-01 開始 → 2026） */
function periodYear(period: Pick<ReportingPeriod, 'startDate'>): number {
  return Number(period.startDate.slice(0, 4));
}

/**
 * 期間に対応する版。期間の開始の年と同じ年の版、無ければ公開中の版（無ければ最新）。
 * 対応は記録せず毎回同じ規則で導く（Demo の Cookie に書き込みを増やさない。plan K7）
 */
export function versionForPeriod<
  V extends Pick<DisclosureFrameworkVersion, 'id' | 'year' | 'status'>,
>(versions: readonly V[], period: Pick<ReportingPeriod, 'startDate'>): V | null {
  const year = periodYear(period);
  return (
    versions.find((v) => v.year === year) ??
    versions.find((v) => v.status === 'published') ??
    [...versions].sort((a, b) => b.year - a.year)[0] ??
    null
  );
}

/** 回答の不足（一覧の「不足」列・保存ビュー「不足あり」。NF-39 C-06） */
export interface DisclosureGaps {
  /** 対応付けた指標のうち承認済みの値が無いもの */
  dataMissing: number;
  /** 指標にも T4D の情報（定性情報・原稿・要求事項）にも対応付いていない */
  unmapped: boolean;
  /** 直近の AI 草案が埋められなかった情報（承認済みの回答では数えない） */
  aiMissing: string[];
  /** 不足の件数の合計（0 なら不足なし） */
  total: number;
}

export interface WorkspaceOptions {
  /** 表示する版（その基準の版でなければ無視して期間の版） */
  versionId?: string | null;
}

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
  /** 人が確定した T4D の情報との対応付け（外したものを除く。NF-39 C-03） */
  contentLinks: ResponseContentLink[];
  /** 不足（NF-39 C-06） */
  gaps: DisclosureGaps;
}

export interface DisclosureWorkspace {
  frameworkKey: FrameworkKey;
  versionLabel: string;
  isFixture: boolean;
  /** 表示している版 */
  version: DisclosureFrameworkVersion;
  /** この基準の版（新しい順） */
  versions: DisclosureFrameworkVersion[];
  /** 期間に対応する版（表示している版と違えば、画面がその旨を出す） */
  periodVersionId: Uuid;
  /** 前の版（年が 1 つ前。無ければ null） */
  previousVersion: DisclosureFrameworkVersion | null;
  /** 前の版との比較（版どうしを比べた結果。NF-08 の差分。前の版が無ければ null） */
  versionDiff: FrameworkDiff | null;
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
    /** 不足のある質問の数 */
    withGaps: number;
  };
}

/** 直近の AI 草案の「埋められなかった情報」（回答ごと。不採用・失敗した実行は使わない） */
async function latestAiMissingByResponse(
  db: DbClient,
  organizationId: Uuid,
  responseIds: ReadonlySet<Uuid>,
): Promise<Map<Uuid, string[]>> {
  const out = new Map<Uuid, string[]>();
  if (responseIds.size === 0) return out;
  // 人が採用した草案（accepted）の不足も残す（採用しても、AI が書けなかった情報が埋まったとは限らない）
  const runs = await db.select('aiRuns', {
    where: {
      organizationId,
      featureType: 'cdpDraftGeneration',
      status: { in: ['succeeded', 'accepted'] },
    },
    orderBy: { column: 'createdAt', dir: 'desc' },
  });
  for (const run of runs) {
    const responseId = run.inputReferenceIds[0];
    if (!responseId || !responseIds.has(responseId) || out.has(responseId)) continue;
    const output: Record<string, unknown> = run.outputJson ?? {};
    const missing = output.missingInformation;
    out.set(
      responseId,
      Array.isArray(missing) ? missing.filter((m): m is string => typeof m === 'string') : [],
    );
  }
  return out;
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

/**
 * 開示ワークスペース。契約が要る基準（CDP）で組織に契約が無ければ null（画面・出力・AI のどの経路からも
 * 読めない。画面は呼ぶ前に isFrameworkAvailable で「契約されていません」を出す）。
 *
 * 版は options.versionId（その基準の版に限る）、無ければ期間に対応する版（versionForPeriod）。
 * 回答は期間 × 表示している版の項目で引く（版を切り替えると、その版の質問構成で一覧が変わる。C-09）
 */
export async function loadDisclosureWorkspace(
  db: DbClient,
  ctx: AuthorizationContext,
  frameworkKey: FrameworkKey,
  period: ReportingPeriod,
  periods: ReportingPeriod[],
  metrics: MetricDefinition[],
  options: WorkspaceOptions = {},
): Promise<DisclosureWorkspace | null> {
  const organizationId = ctx.workspace.organizationId;
  if (!(await isFrameworkAvailable(db, ctx, frameworkKey))) return null;

  const frameworks = await db.select('frameworks', { where: { key: frameworkKey }, limit: 1 });
  const framework = frameworks[0];
  if (!framework) return null;

  const versions = await db.select('frameworkVersions', {
    where: { frameworkId: framework.id },
    orderBy: { column: 'year', dir: 'desc' },
  });
  // SSBJ は年度ごとに設定で固定した版（無ければ公開中の版）を読む（NF-12。SSBJ の画面・設定・要求事項 CSV と
  // 同じ版にし、出力（DOCX・CSV）の「基準」と「対象年度×基準版」を食い違わせない）
  const ssbjVersion =
    frameworkKey === 'ssbj'
      ? ((await resolveSsbjVersion(db, organizationId, period.id))?.version ?? null)
      : null;
  const periodVersion = ssbjVersion
    ? (versions.find((v) => v.id === ssbjVersion.id) ?? ssbjVersion)
    : versionForPeriod(versions, period);
  const current =
    (options.versionId ? versions.find((v) => v.id === options.versionId) : undefined) ??
    periodVersion;
  if (!current || !periodVersion) return null;

  const items = await db.select('disclosureItems', {
    where: { frameworkVersionId: current.id },
    orderBy: { column: 'sortOrder' },
  });

  // 前の版（年が小さい中で最も新しい版）と比べる。差分区分はマスターの手書きの値ではなく、
  // 版どうしを比べて出す（NF-08 の比較。改番を「削除＋追加」にしない）
  const previousVersion =
    versions.filter((v) => v.year < current.year).sort((a, b) => b.year - a.year)[0] ?? null;
  const versionDiff = previousVersion
    ? diffFrameworkItems(
        await db.select('disclosureItems', {
          where: { frameworkVersionId: previousVersion.id },
          orderBy: { column: 'sortOrder' },
        }),
        items,
      )
    : null;

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

  // 人が確定した対応付けだけを使う（確定を外した行・AI の未確定の候補は数えない。NF-39 C-03）
  const mappings = await db.select('disclosureMappings', {
    where: { organizationId, confirmedAt: { isNull: false } },
  });
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
  const itemIds = new Set(items.map((i) => i.id));
  const contentLinks = (
    await db.select('responseContentLinks', {
      where: { organizationId, deletedAt: { isNull: true } },
    })
  ).filter((l) => itemIds.has(l.itemId));
  const aiMissing = await latestAiMissingByResponse(
    db,
    organizationId,
    new Set(
      items.flatMap((i) => {
        const r = responseByItem.get(i.id);
        return r && r.status !== 'approved' ? [r.id] : [];
      }),
    ),
  );

  const rows: DisclosureQuestionRow[] = items.map((item) => {
    const response = responseByItem.get(item.id) ?? null;
    const itemMappings = mappings.filter((m) => m.itemId === item.id);
    const itemLinks = contentLinks.filter((l) => l.itemId === item.id);
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
    const unmapped = mappedMetrics.length === 0 && itemLinks.length === 0;
    const aiMissingForRow = response ? (aiMissing.get(response.id) ?? []) : [];

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
      contentLinks: itemLinks,
      gaps: {
        dataMissing: missing.length,
        unmapped,
        aiMissing: aiMissingForRow,
        total: missing.length + (unmapped ? 1 : 0) + aiMissingForRow.length,
      },
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
    version: current,
    versions,
    periodVersionId: periodVersion.id,
    previousVersion,
    versionDiff,
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
      withGaps: rows.filter((r) => r.gaps.total > 0).length,
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
  // どの年度をどの版で評価したか（設定の確定で固定した版、無ければ公開中の版。NF-12）
  const resolved = await resolveSsbjVersion(db, ctx.workspace.organizationId, period.id);

  const sections: DocxSection[] = [
    {
      heading: '概要',
      paragraphs: [
        `対象組織: ${ctx.workspace.organizationName}`,
        `対象期間: ${period.label}`,
        `基準: ${workspace.versionLabel}${workspace.isFixture ? '（架空の縮小マスター）' : ''}`,
        ...(resolved ? [`対象年度×基準版: ${ssbjVersionStamp(period.label, resolved)}`] : []),
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

// ----------------------------------------------------------------------
// 回答の担当・対応する T4D の情報・根拠（NF-39 C-01・C-03・C-04）。読むだけ（行を作らない）
// ----------------------------------------------------------------------

export interface AssigneeOption {
  userId: Uuid;
  displayName: string;
}

export interface ResponseAssignees {
  /** 作成担当に選べる人（組織の有効なメンバーで、開示の編集ができる） */
  owners: AssigneeOption[];
  /** レビュー担当に選べる人（開示の編集か承認ができる） */
  reviewers: AssigneeOption[];
  /** 表示名（組織の有効なメンバー全員） */
  nameById: Map<Uuid, string>;
}

/** 回答の担当に選べる組織のメンバー（サービスの検査 assignDisclosureResponses と同じ条件） */
export async function listResponseAssignees(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<ResponseAssignees> {
  const memberships = await db.select('memberships', {
    where: { organizationId: ctx.workspace.organizationId, status: 'active' },
  });
  if (memberships.length === 0) return { owners: [], reviewers: [], nameById: new Map() };
  const [profiles, roles] = await Promise.all([
    db.select('profiles', { where: { id: { in: memberships.map((m) => m.userId) } } }),
    db.select('membershipRoles', {
      where: { membershipId: { in: memberships.map((m) => m.id) } },
    }),
  ]);
  const nameById = new Map(profiles.map((p) => [p.id, p.displayName]));
  const owners: AssigneeOption[] = [];
  const reviewers: AssigneeOption[] = [];
  for (const membership of memberships) {
    const displayName = nameById.get(membership.userId);
    if (!displayName) continue;
    const permissions = permissionsFor(
      roles.filter((r) => r.membershipId === membership.id).map((r) => r.roleKey),
    );
    const option = { userId: membership.userId, displayName };
    if (permissions.has('enterprise.disclosure.write')) owners.push(option);
    if (
      permissions.has('enterprise.disclosure.write') ||
      permissions.has('enterprise.disclosure.approve')
    ) {
      reviewers.push(option);
    }
  }
  const byName = (a: AssigneeOption, b: AssigneeOption) =>
    a.displayName.localeCompare(b.displayName, 'ja');
  return { owners: owners.sort(byName), reviewers: reviewers.sort(byName), nameById };
}

export interface LinkedContent {
  link: ResponseContentLink;
  /** 表示名（定性情報の題名・節の題名・要求事項のコード＋題名） */
  label: string;
  /** 使う版の番号（確認済み・承認済みの版。無くなっていれば null） */
  versionNo: number | null;
  /** 版の本文の抜粋（要求事項は題名） */
  excerpt: string;
  /** 確認済み・承認済みの版が今もあるか（無ければ「版が見つかりません」と出す） */
  usable: boolean;
  href: string | null;
}

export interface ContentCandidate {
  id: Uuid;
  label: string;
}

export interface EvidenceEntry {
  evidenceLinkId: Uuid;
  fileName: string;
  page: number | null;
  /** どの指標の承認済みデータの根拠か */
  metricName: string;
}

export interface QuestionLinks {
  narratives: LinkedContent[];
  blocks: LinkedContent[];
  requirements: LinkedContent[];
  /** 対応付けに加えられるもの（既に対応付けたものを除く） */
  candidates: {
    metrics: ContentCandidate[];
    narratives: ContentCandidate[];
    blocks: ContentCandidate[];
    requirements: ContentCandidate[];
  };
  evidence: {
    /** この回答に紐付けた根拠 */
    linked: EvidenceEntry[];
    /** 対応付けた指標の承認済みデータの根拠（まだ紐付けていないもの。人が選ぶ） */
    candidates: EvidenceEntry[];
    /** 根拠資料の閲覧権限が無いため、資料名を出さない */
    hidden: boolean;
  };
}

const EXCERPT_LENGTH = 120;

function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH)}…` : flat;
}

/**
 * 回答画面の「対応する T4D の情報」と「根拠」。対応付けは組織 × 質問（期間をまたいで使う）、
 * 根拠は回答（期間ごと）。定性情報は確認済みの版、原稿は承認済みの版だけを使う
 */
export async function loadQuestionLinks(
  db: DbClient,
  ctx: AuthorizationContext,
  row: DisclosureQuestionRow,
  period: ReportingPeriod,
  metrics: readonly MetricDefinition[],
): Promise<QuestionLinks> {
  const organizationId = ctx.workspace.organizationId;
  const linkOf = (kind: ResponseContentLink['targetKind']) =>
    row.contentLinks.filter((l) => l.targetKind === kind);

  const [records, blocks, ssbjItems, projects] = await Promise.all([
    db.select('narrativeRecords', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('disclosureBlocks', { where: { organizationId, deletedAt: { isNull: true } } }),
    loadSsbjItems(db),
    db.select('disclosureProjects', { where: { organizationId } }),
  ]);
  const recordById = new Map(records.map((r) => [r.id, r]));
  const blockById = new Map(blocks.map((b) => [b.id, b]));
  const projectNameById = new Map(projects.map((p) => [p.id, p.name]));
  // 節の題名は年度のプロジェクトごとに同じになる（ガバナンス等）ため、プロジェクト名を添えて区別する
  const blockLabel = (b: { title: string; projectId: Uuid }) => {
    const project = projectNameById.get(b.projectId);
    return project ? `${b.title}（${project}）` : b.title;
  };
  const ssbjById = new Map(ssbjItems.map((i) => [i.id, i]));

  const narratives: LinkedContent[] = [];
  for (const link of linkOf('narrative_record')) {
    const record = recordById.get(link.targetId);
    const version = record?.confirmedVersionId
      ? await db.findById('narrativeVersions', record.confirmedVersionId)
      : null;
    narratives.push({
      link,
      label: record?.title ?? '（削除された定性情報）',
      versionNo: version?.versionNo ?? null,
      excerpt: version ? excerptOf(version.body) : '',
      usable: Boolean(version && version.organizationId === organizationId),
      href: record ? `/enterprise/narratives/${record.id}` : null,
    });
  }

  const linkedBlocks: LinkedContent[] = [];
  for (const link of linkOf('disclosure_block')) {
    const block = blockById.get(link.targetId);
    const version = block?.approvedVersionId
      ? await db.findById('disclosureBlockVersions', block.approvedVersionId)
      : null;
    linkedBlocks.push({
      link,
      label: block ? blockLabel(block) : '（削除された原稿の節）',
      versionNo: version?.versionNo ?? null,
      excerpt: version ? excerptOf(version.plainText) : '',
      usable: Boolean(version && version.organizationId === organizationId),
      href: block ? `/enterprise/disclosure-projects/${block.projectId}/blocks/${block.id}` : null,
    });
  }

  const requirements: LinkedContent[] = linkOf('requirement_item').map((link) => {
    const item = ssbjById.get(link.targetId);
    return {
      link,
      label: item ? `${item.code} ${item.questionText}` : '（見つからない要求事項）',
      versionNo: null,
      excerpt: item ? excerptOf(item.questionText) : '',
      usable: Boolean(item),
      href: item ? `/enterprise/disclosures/ssbj/requirements/${item.id}` : null,
    };
  });

  const linkedIds = new Set(row.contentLinks.map((l) => `${l.targetKind}:${l.targetId}`));
  const mappedMetricIds = new Set(row.mappedMetrics.map((m) => m.id));
  const candidates: QuestionLinks['candidates'] = {
    metrics: metrics
      .filter((m) => !mappedMetricIds.has(m.id) && !m.deletedAt)
      .map((m) => ({ id: m.id, label: `${m.name}（${m.unit}）` })),
    narratives: records
      .filter((r) => r.confirmedVersionId && !linkedIds.has(`narrative_record:${r.id}`))
      .map((r) => ({ id: r.id, label: r.title })),
    blocks: blocks
      .filter((b) => b.approvedVersionId && !linkedIds.has(`disclosure_block:${b.id}`))
      .map((b) => ({ id: b.id, label: blockLabel(b) })),
    requirements: ssbjItems
      .filter((i) => !linkedIds.has(`requirement_item:${i.id}`))
      .map((i) => ({ id: i.id, label: `${i.code} ${i.questionText}` })),
  };

  // 根拠: 資料の閲覧権限が無い人には資料名を出さない（件数だけ一覧に出る）
  const hidden = !permissionsFor(ctx.workspace.roleKeys).has('enterprise.evidence.read');
  const evidence: QuestionLinks['evidence'] = { linked: [], candidates: [], hidden };
  if (!hidden) {
    const entries = await evidenceEntriesForRow(db, organizationId, row, period);
    const linkedLinkIds = new Set(
      row.response
        ? (
            await db.select('responseEvidenceLinks', {
              where: { organizationId, responseId: row.response.id },
            })
          ).map((l) => l.evidenceLinkId)
        : [],
    );
    evidence.linked = await linkedEvidenceEntries(db, organizationId, linkedLinkIds, entries);
    evidence.candidates = entries.filter((e) => !linkedLinkIds.has(e.evidenceLinkId));
  }

  return { narratives, blocks: linkedBlocks, requirements, candidates, evidence };
}

/** SSBJ の要求事項（公開中の版）。CDP の回答と対応付ける先 */
async function loadSsbjItems(db: DbClient): Promise<DisclosureItem[]> {
  const frameworks = await db.select('frameworks', { where: { key: 'ssbj' }, limit: 1 });
  const framework = frameworks[0];
  if (!framework) return [];
  const versions = await db.select('frameworkVersions', {
    where: { frameworkId: framework.id },
    orderBy: { column: 'year', dir: 'desc' },
  });
  const version = versions.find((v) => v.status === 'published') ?? versions[0];
  if (!version) return [];
  return db.select('disclosureItems', {
    where: { frameworkVersionId: version.id },
    orderBy: { column: 'sortOrder' },
  });
}

/**
 * 対応付けた指標の、その期間の承認済みデータに付いた根拠（資料が削除されていないもの）。
 * linkResponseEvidence はこの一覧にあるものだけを受け付ける
 */
export async function evidenceEntriesForRow(
  db: DbClient,
  organizationId: Uuid,
  row: Pick<DisclosureQuestionRow, 'mappedMetrics'>,
  period: Pick<ReportingPeriod, 'id'>,
): Promise<EvidenceEntry[]> {
  if (row.mappedMetrics.length === 0) return [];
  const metricById = new Map(row.mappedMetrics.map((m) => [m.id, m]));
  const dataPoints = await db.select('dataPoints', {
    where: {
      organizationId,
      reportingPeriodId: period.id,
      status: 'approved',
      deletedAt: { isNull: true },
      metricId: { in: [...metricById.keys()] },
    },
  });
  if (dataPoints.length === 0) return [];
  const dataPointById = new Map(dataPoints.map((dp) => [dp.id, dp]));
  const links = await db.select('evidenceLinks', {
    where: {
      organizationId,
      targetType: 'data_point',
      targetId: { in: [...dataPointById.keys()] },
    },
  });
  const entries: EvidenceEntry[] = [];
  for (const link of links) {
    const file = await fileOfVersion(db, organizationId, link.fileVersionId);
    if (!file) continue;
    const dp = dataPointById.get(link.targetId);
    entries.push({
      evidenceLinkId: link.id,
      fileName: file.originalName,
      page: link.page,
      metricName: (dp && metricById.get(dp.metricId)?.name) ?? '—',
    });
  }
  return entries;
}

async function fileOfVersion(db: DbClient, organizationId: Uuid, fileVersionId: Uuid) {
  const version = await db.findById('fileVersions', fileVersionId);
  const file = version ? await db.findById('files', version.fileId) : null;
  if (!file || file.organizationId !== organizationId || file.deletedAt) return null;
  return file;
}

/** 紐付け済みの根拠（候補の一覧から外れた古いデータの根拠も、資料が残っていれば出す） */
async function linkedEvidenceEntries(
  db: DbClient,
  organizationId: Uuid,
  linkIds: ReadonlySet<Uuid>,
  known: readonly EvidenceEntry[],
): Promise<EvidenceEntry[]> {
  const out: EvidenceEntry[] = [];
  for (const id of linkIds) {
    const entry = known.find((e) => e.evidenceLinkId === id);
    if (entry) {
      out.push(entry);
      continue;
    }
    const link = await db.findById('evidenceLinks', id);
    if (!link || link.organizationId !== organizationId) continue;
    const file = await fileOfVersion(db, organizationId, link.fileVersionId);
    if (!file) continue;
    out.push({ evidenceLinkId: id, fileName: file.originalName, page: link.page, metricName: '—' });
  }
  return out;
}

export function filterDisclosureRows(
  rows: DisclosureQuestionRow[],
  filters: {
    changeType?: string;
    status?: string;
    search?: string;
    onlyDiff?: boolean;
    /** 担当（'me' は currentUserId、'none' は未割当。作成担当かレビュー担当のどちらか。NF-39 C-01） */
    owner?: string;
    currentUserId?: Uuid;
    /** '1' で不足のある質問だけ（NF-39 C-06） */
    gap?: string;
  },
): DisclosureQuestionRow[] {
  const search = filters.search?.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.onlyDiff && row.item.changeType === 'carry_forward') return false;
    if (filters.changeType && row.item.changeType !== filters.changeType) return false;
    if (filters.owner === 'me') {
      const me = filters.currentUserId;
      if (!me || (row.response?.ownerUserId !== me && row.response?.reviewerUserId !== me)) {
        return false;
      }
    } else if (filters.owner === 'none') {
      if (row.response?.ownerUserId) return false;
    }
    if (filters.gap === '1' && row.gaps.total === 0) return false;
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
