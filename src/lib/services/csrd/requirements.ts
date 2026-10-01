import 'server-only';

import { runAi } from '@/lib/ai';
import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, can, NotFoundError } from '@/lib/authorization/can';
import { getReferenceDate } from '@/lib/clock';
import {
  COVERAGE_LABEL,
  combineCoverage,
  evaluatePriority,
  type PriorityResult,
} from '@/lib/domain/ssbj';
import {
  CSRD_SECTION_LABEL,
  DMA_OUTCOME_LABEL,
  csrdDataStateOf,
  csrdSectionOfItem,
  deriveCsrdApplicability,
  isCsrdInScope,
  type CsrdApplicability,
  type CsrdDataState,
} from '@/lib/domain/csrd';
import { csrdRowIds } from '@/lib/domain/csrd-ids';
import { ValidationError } from '@/lib/errors/user-facing';
import { daysUntilJst } from '@/lib/format/datetime';
import {
  evaluateDataCoverage,
  hasUsableValue,
  valueKindOf,
  type DataCoverage,
} from '@/lib/services/aggregation';
import type { DbClient } from '@/lib/repositories/types';
import {
  CSRD_APPLICABILITY_KINDS,
  DMA_OUTCOMES,
  SSBJ_ACTION_STATUSES,
  SSBJ_COVERAGE_STATUSES,
  type AiSourceReference,
  type AuthorizationContext,
  type CsrdActionPlan,
  type CsrdApplicabilityKind,
  type CsrdAssessment,
  type CsrdSection,
  type DataPoint,
  type DisclosureItem,
  type DmaOutcome,
  type IsoDate,
  type MaterialityBasis,
  type MetricDefinition,
  type OrganizationUnit,
  type ReportingPeriod,
  type ResponseStatus,
  type SsbjActionStatus,
  type SsbjCoverageStatus,
  type Uuid,
  type ValueKind,
} from '@/types/domain';
import {
  assertCsrdWrite,
  assertSameBase,
  cleanText,
  countsAsConfirmedDraft,
  displayNameOf,
  findCsrdPeriod,
  loadCsrdContext,
  type CsrdContext,
  type CsrdMatterState,
} from './core';

/**
 * CSRD の要求事項（対応状況の全体・要求事項の一覧と詳細・評価・AI ギャップ分析・担当者の確認）
 * （docs/disclosure-first.md §9.4）。
 *
 * 守っていること:
 *  - 読込関数は書かない（評価行が無い要求事項は assessment = null で返す。表示で行を作らない）
 *  - 適用は保存せず、DMA の人の判断から毎回導出する（deriveCsrdApplicability）
 *  - AI は ai_* 列だけを書く。人の 3 観点・最終判定は「候補を採用」「修正して確定」か人の入力で入る
 *  - SSBJ の表を読まない・書かない。純関数（combineCoverage・evaluatePriority・ラベル）だけ再利用する
 */

/** 期限判定の基準日を差し替える（テスト・画面が同じ日を使うため） */
export interface CsrdReferenceDateOption {
  referenceDate?: IsoDate;
}

export interface CsrdRequirementView {
  item: DisclosureItem;
  /** 要求事項コードから決めた節（判定できなければ null） */
  section: CsrdSection | null;
  applicability: CsrdApplicability;
  /** 保存済みの評価。行が無ければ null（未確認） */
  assessment: CsrdAssessment | null;
  /** 人の 3 観点をまとめた状況（最も遅れている観点）。評価が無ければ未確認 */
  combined: SsbjCoverageStatus;
  /** 優先度（評価対象のみ。対象外・未判定は null） */
  priority: PriorityResult | null;
  /**
   * AI の候補があり、その後に人が確認していない（評価対象の要求事項だけ。対象外・未判定になった
   * 要求事項の候補は確認の操作が無いため「確認待ち」にしない）
   */
  awaitingReview: boolean;
  /** 人が確認済み（human）／AI の候補だけ（ai_only）／どちらも無い（none） */
  reviewState: 'human' | 'ai_only' | 'none';
  plans: CsrdActionPlan[];
  /** 対応付いた指標 */
  metrics: MetricDefinition[];
  dataCoverage: DataCoverage;
  missingMetrics: MetricDefinition[];
  /** 回答（版・承認）の状態。CSRD の回答だけを見る */
  response: { id: Uuid; status: ResponseStatus } | null;
}

export interface CsrdRequirementViews {
  period: ReportingPeriod;
  versionLabel: string;
  isFixture: boolean;
  /** 版の位置付けの表示（「サンプル（架空）」） */
  legalLabel: string;
  coverageNote: string | null;
  materialityBasis: MaterialityBasis | null;
  /** マスターに収録している要求事項の数 */
  masterTotal: number;
  dmaConfirmed: boolean;
  matters: CsrdMatterState[];
  views: CsrdRequirementView[];
}

/** 保証の対象になりやすい指標に関係する要求事項か（優先度の評価に使う） */
function isAssuranceRelevant(item: DisclosureItem): boolean {
  return /温室効果ガス|GHG|排出|Scope|スコープ|指標|目標/.test(
    `${item.questionText}${item.section}`,
  );
}

function deadlineDays(period: ReportingPeriod, referenceDate: IsoDate): number | null {
  const due = period.submissionDueDate;
  if (!due) return null;
  return daysUntilJst(due, referenceDate);
}

/**
 * 優先度。評価対象のみ。SSBJ の evaluatePriority を、適用（常に適用・重要）→ 重要性あり に写して使う。
 * 「ESRS 2（常に適用）」は重要性の判断に依らないため、その旨を根拠の説明に書き換える
 */
function csrdPriority(
  item: DisclosureItem,
  applicability: CsrdApplicability,
  statuses: [SsbjCoverageStatus, SsbjCoverageStatus, SsbjCoverageStatus],
  daysToDeadline: number | null,
): PriorityResult | null {
  if (!isCsrdInScope(applicability)) return null;
  const result = evaluatePriority({
    required: item.required,
    materiality: 'material',
    disclosureStatus: statuses[0],
    dataStatus: statuses[1],
    processStatus: statuses[2],
    assuranceRelevant: isAssuranceRelevant(item),
    daysToDeadline,
    standardLabel: 'ESRS（サンプル・架空）',
  });
  const factors = result.factors.map((factor) => {
    if (factor.label !== '企業にとっての重要性') return factor;
    return applicability.kind === 'always'
      ? {
          ...factor,
          judgement: 'ESRS 2（常に適用）',
          note: '重要性の判断に関わらず適用される全般開示です。',
        }
      : {
          ...factor,
          judgement: 'ダブル・マテリアリティで重要',
          note: `${applicability.reason}。`,
        };
  });
  return { ...result, factors };
}

function reviewStateOf(assessment: CsrdAssessment | null): CsrdRequirementView['reviewState'] {
  if (!assessment) return 'none';
  if (assessment.reviewedAt !== null) return 'human';
  return assessment.aiStatus !== null ? 'ai_only' : 'none';
}

/** AI の候補があり、その後に人が確認していないか */
export function isAwaitingReview(assessment: CsrdAssessment | null): boolean {
  if (!assessment || assessment.aiStatus === null || assessment.aiEvaluatedAt === null)
    return false;
  if (assessment.reviewedAt === null) return true;
  return Date.parse(assessment.aiEvaluatedAt) > Date.parse(assessment.reviewedAt);
}

/** 共通の読込から要求事項の行を組み立てる（書かない） */
async function buildViews(
  db: DbClient,
  ctx: AuthorizationContext,
  context: CsrdContext,
  options: CsrdReferenceDateOption,
): Promise<CsrdRequirementView[]> {
  const organizationId = ctx.workspace.organizationId;
  const itemIds = context.items.map((i) => i.id);
  const [dataPoints, responses] = await Promise.all([
    db.select('dataPoints', {
      where: {
        organizationId,
        reportingPeriodId: context.period.id,
        deletedAt: { isNull: true },
      },
    }),
    db.select('disclosureResponses', {
      where: { organizationId, reportingPeriodId: context.period.id, itemId: { in: itemIds } },
    }),
  ]);
  const withValue = new Set(dataPoints.filter(hasUsableValue).map((dp) => dp.metricId));
  const responseByItem = new Map(responses.map((r) => [r.itemId, r]));
  const assessmentByItem = new Map(context.assessments.map((a) => [a.itemId, a]));
  const matterByTopic = new Map(context.matters.map((m) => [m.topic, m.matter]));
  const days = deadlineDays(context.period, options.referenceDate ?? getReferenceDate());

  return context.items.map((item) => {
    const section = csrdSectionOfItem(item);
    const matter = section && section !== 'ESRS2' ? (matterByTopic.get(section) ?? null) : null;
    const applicability = deriveCsrdApplicability(section, matter, context.dmaConfirmed);
    const assessment = assessmentByItem.get(item.id) ?? null;
    const statuses: [SsbjCoverageStatus, SsbjCoverageStatus, SsbjCoverageStatus] = assessment
      ? [assessment.disclosureStatus, assessment.dataStatus, assessment.processStatus]
      : ['unconfirmed', 'unconfirmed', 'unconfirmed'];
    const metrics = context.metricsByItem.get(item.id) ?? [];
    const { coverage, missing } = evaluateDataCoverage(metrics, withValue);
    const response = responseByItem.get(item.id);
    return {
      item,
      section,
      applicability,
      assessment,
      combined: combineCoverage(...statuses),
      priority: csrdPriority(item, applicability, statuses, days),
      awaitingReview: isCsrdInScope(applicability) && isAwaitingReview(assessment),
      reviewState: reviewStateOf(assessment),
      plans: assessment ? context.plans.filter((p) => p.assessmentId === assessment.id) : [],
      metrics,
      dataCoverage: coverage,
      missingMetrics: missing,
      response: response ? { id: response.id, status: response.status } : null,
    };
  });
}

/**
 * 要求事項 12 行（適用・3 観点・優先度・AI 候補・回答の状態）。書かない。
 * 分析の「各規制への対応度」もこの関数だけを使う。CSRD のマスターが無ければ null
 */
export async function loadCsrdRequirementViews(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  options: CsrdReferenceDateOption = {},
): Promise<CsrdRequirementViews | null> {
  const context = await loadCsrdContext(db, ctx, period);
  if (!context) return null;
  return {
    period,
    versionLabel: context.version.label,
    isFixture: context.version.isFixture,
    legalLabel: context.legalLabel,
    coverageNote: context.version.coverageNote,
    materialityBasis: context.version.materialityBasis,
    masterTotal: context.items.length,
    dmaConfirmed: context.dmaConfirmed,
    matters: context.matters,
    views: await buildViews(db, ctx, context, options),
  };
}

// ----------------------------------------------------------------------
// 対応状況（全体）
// ----------------------------------------------------------------------

export interface CsrdOverview extends CsrdRequirementViews {
  dma: {
    confirmed: boolean;
    confirmedAt: string | null;
    confirmedByName: string | null;
    /** 人の判断の結果ごとの事項数（n / matterTotal） */
    outcomeCounts: Record<DmaOutcome, number>;
    matterTotal: number;
    /** 分析条件を保存済みか（未保存は既定値で表示している） */
    settingsPersisted: boolean;
    boundaryDecided: boolean;
  };
  /** 適用の内訳（n / total）。inScope = 常に適用 ＋ 重要 */
  applicabilityCounts: Record<CsrdApplicabilityKind, number> & {
    inScope: number;
    total: number;
    /** 暫定（DMA 確定前）の件数 */
    provisional: number;
  };
  /** 評価対象の 3 観点・総合の件数（重み付きの「対応度%」は出さない） */
  coverageCounts: Record<
    'disclosure' | 'data' | 'process' | 'combined',
    Record<SsbjCoverageStatus, number>
  >;
  /** AI の候補の確認待ち（評価対象） */
  awaitingReview: number;
  /** 優先度「高」（評価対象かつ対応済み以外） */
  highPriority: number;
  planCounts: Record<SsbjActionStatus, number>;
  /** 計画から作った収集項目の数（指標コードの付いた計画） */
  collectionPlanCount: number;
  /** 開示ドラフト（確定済みの節・AI 草案のある節） */
  draftCounts: { confirmed: number; generated: number };
}

function emptyCoverageCounts(): Record<SsbjCoverageStatus, number> {
  return Object.fromEntries(SSBJ_COVERAGE_STATUSES.map((s) => [s, 0])) as Record<
    SsbjCoverageStatus,
    number
  >;
}

/** 対応状況の画面（DMA の要約・適用の内訳・評価対象の件数・確認待ち・計画）。書かない */
export async function loadCsrdOverview(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  options: CsrdReferenceDateOption = {},
): Promise<CsrdOverview | null> {
  const context = await loadCsrdContext(db, ctx, period);
  if (!context) return null;
  const views = await buildViews(db, ctx, context, options);

  const outcomeCounts = Object.fromEntries(DMA_OUTCOMES.map((o) => [o, 0])) as Record<
    DmaOutcome,
    number
  >;
  for (const matter of context.matters) outcomeCounts[matter.outcome] += 1;

  const kindCounts = Object.fromEntries(CSRD_APPLICABILITY_KINDS.map((k) => [k, 0])) as Record<
    CsrdApplicabilityKind,
    number
  >;
  for (const view of views) kindCounts[view.applicability.kind] += 1;
  const inScope = views.filter((v) => isCsrdInScope(v.applicability));

  const coverageCounts = {
    disclosure: emptyCoverageCounts(),
    data: emptyCoverageCounts(),
    process: emptyCoverageCounts(),
    combined: emptyCoverageCounts(),
  };
  for (const view of inScope) {
    coverageCounts.disclosure[view.assessment?.disclosureStatus ?? 'unconfirmed'] += 1;
    coverageCounts.data[view.assessment?.dataStatus ?? 'unconfirmed'] += 1;
    coverageCounts.process[view.assessment?.processStatus ?? 'unconfirmed'] += 1;
    coverageCounts.combined[view.combined] += 1;
  }

  const planCounts = Object.fromEntries(SSBJ_ACTION_STATUSES.map((s) => [s, 0])) as Record<
    SsbjActionStatus,
    number
  >;
  for (const plan of context.plans) planCounts[plan.status] += 1;

  const drafts = await db.select('csrdDisclosureDrafts', {
    where: { organizationId: ctx.workspace.organizationId, reportingPeriodId: period.id },
  });

  return {
    period,
    versionLabel: context.version.label,
    isFixture: context.version.isFixture,
    legalLabel: context.legalLabel,
    coverageNote: context.version.coverageNote,
    materialityBasis: context.version.materialityBasis,
    masterTotal: context.items.length,
    dmaConfirmed: context.dmaConfirmed,
    matters: context.matters,
    views,
    dma: {
      confirmed: context.dmaConfirmed,
      confirmedAt: context.settings.dmaConfirmedAt,
      confirmedByName: await displayNameOf(db, context.settings.dmaConfirmedBy),
      outcomeCounts,
      matterTotal: context.matters.length,
      settingsPersisted: context.settingsPersisted,
      boundaryDecided: context.settings.valueChainScope !== 'not_decided',
    },
    applicabilityCounts: {
      ...kindCounts,
      inScope: inScope.length,
      total: views.length,
      provisional: views.filter((v) => v.applicability.provisional).length,
    },
    coverageCounts,
    awaitingReview: views.filter((v) => v.awaitingReview).length,
    highPriority: inScope.filter((v) => v.combined !== 'covered' && v.priority?.priority === 'high')
      .length,
    planCounts,
    collectionPlanCount: context.plans.filter((p) => p.linkedMetricCode !== null).length,
    draftCounts: {
      // 事項の判断が変わって対象外・未判定になった節の確定は数えない（確定の条件を満たさない）
      confirmed: drafts.filter((d) => countsAsConfirmedDraft(context, d)).length,
      generated: drafts.filter((d) => d.aiBody.trim() !== '').length,
    },
  };
}

// ----------------------------------------------------------------------
// 一覧の絞り込み（URL の ?applicability=&perspective=&coverage=&priority=&review=awaiting）
// ----------------------------------------------------------------------

export interface CsrdRequirementFilters {
  applicability?: string[];
  perspective?: string[];
  coverage?: string[];
  priority?: string[];
  /** 'awaiting' = AI の候補の確認待ち */
  review?: string[];
}

export function filterCsrdRequirements(
  views: CsrdRequirementView[],
  filters: CsrdRequirementFilters,
): CsrdRequirementView[] {
  const has = (list: string[] | undefined): list is string[] =>
    list !== undefined && list.length > 0;
  return views.filter((v) => {
    if (has(filters.applicability) && !filters.applicability.includes(v.applicability.kind)) {
      return false;
    }
    if (
      has(filters.perspective) &&
      !v.applicability.perspectives.some((p) => filters.perspective!.includes(p))
    ) {
      return false;
    }
    if (has(filters.coverage) && !filters.coverage.includes(v.combined)) return false;
    if (has(filters.priority) && !(v.priority && filters.priority.includes(v.priority.priority))) {
      return false;
    }
    if (has(filters.review) && filters.review.includes('awaiting') && !v.awaitingReview) {
      return false;
    }
    return true;
  });
}

// ----------------------------------------------------------------------
// 要求事項の詳細
// ----------------------------------------------------------------------

/** 対応付いた指標の当期の状況（拠点ごと）。値を出すのは承認済みだけ */
export interface CsrdMetricDataRow {
  metric: MetricDefinition;
  /** 拠点。当期の行も割当も無い指標は null（全社で未入力） */
  unit: OrganizationUnit | null;
  state: CsrdDataState;
  /** 承認済みの値（承認済み以外は null。0 と未入力を混同しない） */
  value: number | null;
  /** 承認済みの値の区分（実績・推計）。値が無ければ null。推計は推計と表示する */
  valueKind: Exclude<ValueKind, 'target'> | null;
  unitOfMeasure: string;
  dataPointId: Uuid | null;
}

/** 承認済みの値の区分（実績・推計）。値が無い行は null */
export function approvedValueKind(
  dp: DataPoint | undefined,
  state: CsrdDataState,
): Exclude<ValueKind, 'target'> | null {
  if (!dp || state !== 'approved' || !hasUsableValue(dp)) return null;
  return valueKindOf(dp) === 'estimate' ? 'estimate' : 'actual';
}

/** 指標 × 拠点の当期の状況（収集画面と要求事項の詳細が同じ組み立てを使う） */
export function metricDataRows(
  metrics: readonly MetricDefinition[],
  dataPoints: readonly DataPoint[],
  assignmentUnitIds: ReadonlyMap<Uuid, ReadonlySet<Uuid>>,
  units: readonly OrganizationUnit[],
): CsrdMetricDataRow[] {
  const unitById = new Map(units.map((u) => [u.id, u]));
  const rows: CsrdMetricDataRow[] = [];
  for (const metric of metrics) {
    const points = dataPoints.filter((dp) => dp.metricId === metric.id);
    const unitIds = new Set<Uuid>([
      ...points.map((dp) => dp.unitId),
      ...(assignmentUnitIds.get(metric.id) ?? []),
    ]);
    if (unitIds.size === 0) {
      rows.push({
        metric,
        unit: null,
        state: 'not_entered',
        value: null,
        valueKind: null,
        unitOfMeasure: metric.unit,
        dataPointId: null,
      });
      continue;
    }
    const ordered = [...unitIds].sort(
      (a, b) => (unitById.get(a)?.sortOrder ?? 999) - (unitById.get(b)?.sortOrder ?? 999),
    );
    for (const unitId of ordered) {
      const dp = points.find((p) => p.unitId === unitId);
      const state = csrdDataStateOf(dp);
      rows.push({
        metric,
        unit: unitById.get(unitId) ?? null,
        state,
        value: dp && state === 'approved' && hasUsableValue(dp) ? dp.value : null,
        valueKind: approvedValueKind(dp, state),
        unitOfMeasure: dp?.unitOfMeasure ?? metric.unit,
        dataPointId: dp?.id ?? null,
      });
    }
  }
  return rows;
}

export interface CsrdRequirementDetail {
  view: CsrdRequirementView;
  /** テーマ別の要求事項の事項（ESRS 2・判定できない節は null） */
  matter: CsrdMatterState | null;
  dmaConfirmed: boolean;
  /** 対応付いた指標の当期データ */
  metricData: CsrdMetricDataRow[];
  /** 回答（版・承認）の画面 */
  responseHref: string;
  reviewedByName: string | null;
  canWrite: boolean;
  canRunAi: boolean;
}

/** 要求事項の詳細。書かない。CSRD の要求事項でなければ null */
export async function loadCsrdRequirementDetail(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  itemId: Uuid,
  options: CsrdReferenceDateOption = {},
): Promise<CsrdRequirementDetail | null> {
  const context = await loadCsrdContext(db, ctx, period);
  if (!context) return null;
  if (!context.items.some((i) => i.id === itemId)) return null;
  const views = await buildViews(db, ctx, context, options);
  const view = views.find((v) => v.item.id === itemId);
  if (!view) return null;

  const organizationId = ctx.workspace.organizationId;
  const [dataPoints, assignments, units] = await Promise.all([
    db.select('dataPoints', {
      where: { organizationId, reportingPeriodId: period.id, deletedAt: { isNull: true } },
    }),
    db.select('metricAssignments', { where: { organizationId, reportingPeriodId: period.id } }),
    db.select('units', { where: { organizationId, deletedAt: { isNull: true } } }),
  ]);
  const assignmentUnits = new Map<Uuid, Set<Uuid>>();
  for (const a of assignments) {
    const set = assignmentUnits.get(a.metricId) ?? new Set<Uuid>();
    set.add(a.unitId);
    assignmentUnits.set(a.metricId, set);
  }
  const matter =
    view.section && view.section !== 'ESRS2'
      ? (context.matters.find((m) => m.topic === view.section) ?? null)
      : null;
  return {
    view,
    matter,
    dmaConfirmed: context.dmaConfirmed,
    metricData: metricDataRows(view.metrics, dataPoints, assignmentUnits, units),
    responseHref: `/enterprise/disclosures/csrd/${itemId}`,
    reviewedByName: await displayNameOf(db, view.assessment?.reviewedBy ?? null),
    canWrite: can(ctx, 'enterprise.disclosure.write'),
    canRunAi: can(ctx, 'enterprise.ai.run') && can(ctx, 'enterprise.disclosure.write'),
  };
}

// ----------------------------------------------------------------------
// 書込
// ----------------------------------------------------------------------

const COMMENT_MAX = 600;

/** 期間と CSRD の要求事項を確かめ、その要求事項の行（あれば）と適用を返す */
async function resolveItem(
  db: DbClient,
  ctx: AuthorizationContext,
  reportingPeriodId: Uuid,
  itemId: Uuid,
): Promise<{ context: CsrdContext; item: DisclosureItem; applicability: CsrdApplicability }> {
  const period = await findCsrdPeriod(db, ctx, reportingPeriodId);
  const context = await loadCsrdContext(db, ctx, period);
  if (!context) throw new NotFoundError('CSRD の要求事項マスターが見つかりません。');
  const item = context.items.find((i) => i.id === itemId);
  if (!item) throw new NotFoundError('CSRD の要求事項が見つかりません。');
  const section = csrdSectionOfItem(item);
  const matter =
    section && section !== 'ESRS2'
      ? (context.matters.find((m) => m.topic === section)?.matter ?? null)
      : null;
  return {
    context,
    item,
    applicability: deriveCsrdApplicability(section, matter, context.dmaConfirmed),
  };
}

/** 評価行を用意する（無ければ既定値で作る。書込の操作の中でだけ呼ぶ） */
export async function ensureCsrdAssessment(
  db: DbClient,
  ctx: AuthorizationContext,
  context: CsrdContext,
  item: DisclosureItem,
  now: string,
): Promise<CsrdAssessment> {
  const existing = context.assessments.find((a) => a.itemId === item.id);
  if (existing) return existing;
  const organizationId = ctx.workspace.organizationId;
  const row: CsrdAssessment = {
    id: csrdRowIds.assessment(organizationId, context.period.id, item.code),
    organizationId,
    reportingPeriodId: context.period.id,
    itemId: item.id,
    disclosureStatus: 'unconfirmed',
    dataStatus: 'unconfirmed',
    processStatus: 'unconfirmed',
    aiDisclosureStatus: null,
    aiDataStatus: null,
    aiProcessStatus: null,
    aiStatus: null,
    aiComment: '',
    aiMissingInfo: [],
    aiRecommendation: '',
    aiRunId: null,
    aiEvaluatedAt: null,
    reviewDecision: null,
    reviewedBy: null,
    reviewedAt: null,
    reviewComment: '',
    finalStatus: null,
    ownerDepartment: '',
    ownerUserId: null,
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  };
  await db.insert('csrdAssessments', [row]);
  context.assessments.push(row);
  return row;
}

function assertCoverage(value: unknown): SsbjCoverageStatus {
  if (typeof value !== 'string' || !(SSBJ_COVERAGE_STATUSES as readonly string[]).includes(value)) {
    throw new ValidationError(
      '対応状況は「対応済み・おおむね対応・一部対応・未対応・未確認」から選んでください。',
    );
  }
  return value as SsbjCoverageStatus;
}

export interface SaveCsrdAssessmentInput {
  reportingPeriodId: Uuid;
  itemId: Uuid;
  disclosureStatus: SsbjCoverageStatus;
  dataStatus: SsbjCoverageStatus;
  processStatus: SsbjCoverageStatus;
  comment: string;
  /** 省略時は変えない */
  ownerDepartment?: string;
}

/** AI の候補と違う値で確定するときの理由の指摘（「修正して確定」と同じ規則・同じ文言） */
const MODIFY_REASON_REQUIRED = '修正して確定する場合は、修正の理由（コメント）を入力してください。';

/**
 * 人が 3 観点を入力して確定する（AI の候補が無くてもよい）。
 * final_status = combineCoverage(3 観点)、reviewed_* に入力者と日時を入れる。AI の候補の列は変えない。
 * AI の候補がある要求事項で候補と違う値にするときは、「修正して確定」と同じく理由（コメント）が必須
 * （AI の候補を理由なく上書きした記録を残さない）。候補と同じ値なら「候補を採用」と同じ区分にする
 */
export async function saveCsrdAssessment(
  db: DbClient,
  ctx: AuthorizationContext,
  input: SaveCsrdAssessmentInput,
): Promise<CsrdAssessment> {
  assertCsrdWrite(ctx);
  const disclosureStatus = assertCoverage(input.disclosureStatus);
  const dataStatus = assertCoverage(input.dataStatus);
  const processStatus = assertCoverage(input.processStatus);
  const comment = cleanText(input.comment, COMMENT_MAX, 'コメント');
  const { context, item } = await resolveItem(db, ctx, input.reportingPeriodId, input.itemId);
  // 書く前に区分を決める（理由が要るのに無ければ、評価行を作る前に断る）
  const existing = context.assessments.find((a) => a.itemId === item.id) ?? null;
  const hasCandidate = existing !== null && existing.aiStatus !== null;
  const sameAsCandidate =
    hasCandidate &&
    existing.aiDisclosureStatus === disclosureStatus &&
    existing.aiDataStatus === dataStatus &&
    existing.aiProcessStatus === processStatus;
  if (hasCandidate && !sameAsCandidate && comment === '') {
    throw new ValidationError(MODIFY_REASON_REQUIRED);
  }
  const now = new Date().toISOString();
  const assessment = await ensureCsrdAssessment(db, ctx, context, item, now);
  const finalStatus = combineCoverage(disclosureStatus, dataStatus, processStatus);
  const updated = await db.update('csrdAssessments', assessment.id, {
    disclosureStatus,
    dataStatus,
    processStatus,
    finalStatus,
    // AI の候補と違う値は「修正」（理由あり）、同じ値は「採用」、候補が無ければ区分を付けない
    reviewDecision: !hasCandidate ? null : sameAsCandidate ? 'approved' : 'modified',
    reviewedBy: ctx.userId,
    reviewedAt: now,
    reviewComment: comment,
    ...(input.ownerDepartment !== undefined
      ? { ownerDepartment: cleanText(input.ownerDepartment, 100, '担当部署') }
      : {}),
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'csrd_assessment',
    resourceId: assessment.id,
    beforeSummary: `${item.code}: ${assessment.finalStatus ? COVERAGE_LABEL[assessment.finalStatus] : '未確定'}`,
    afterSummary: `${item.code}: 担当者が入力して確定（${COVERAGE_LABEL[finalStatus]}）`,
  });
  return updated;
}

/**
 * AI ギャップ分析（1 件ずつ）。評価対象（常に適用・重要）の要求事項だけ。
 * 結果は ai_* 列にだけ書く（人の 3 観点・最終判定・確認の記録は変えない）。評価行が無ければ作る
 */
export async function runCsrdGapAnalysis(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { reportingPeriodId: Uuid; itemId: Uuid },
): Promise<{ assessment: CsrdAssessment; runId: Uuid }> {
  assertCsrdWrite(ctx);
  assertCan(ctx, 'enterprise.ai.run');
  const { context, item, applicability } = await resolveItem(
    db,
    ctx,
    input.reportingPeriodId,
    input.itemId,
  );
  if (!isCsrdInScope(applicability)) {
    throw new ValidationError(
      '評価対象（常に適用・重要と判断した事項）の要求事項だけ AI ギャップ分析を実行できます。',
    );
  }
  const organizationId = ctx.workspace.organizationId;
  const period = context.period;
  const section = csrdSectionOfItem(item);

  // 承認済みの値だけを渡す（未承認値・値の無い行を根拠にさせない）
  const metrics = context.metricsByItem.get(item.id) ?? [];
  const metricIds = new Set(metrics.map((m) => m.id));
  const [approved, responses, approvals, units] = await Promise.all([
    db.select('dataPoints', {
      where: {
        organizationId,
        reportingPeriodId: period.id,
        status: 'approved',
        deletedAt: { isNull: true },
      },
    }),
    db.select('disclosureResponses', {
      where: { organizationId, reportingPeriodId: period.id, itemId: item.id },
      limit: 1,
    }),
    db.select('approvals', { where: { organizationId }, limit: 1 }),
    db.select('units', { where: { organizationId, deletedAt: { isNull: true } } }),
  ]);
  const unitName = new Map(units.map((u) => [u.id, u.name]));
  const metricById = new Map(metrics.map((m) => [m.id, m]));
  const usable = approved.filter((dp) => metricIds.has(dp.metricId) && hasUsableValue(dp));
  // 値の揃い具合は指標の数で渡す（値の行は指標 × 拠点のため、1 つの指標の拠点別の値だけで
  // 複数指標の要求事項を対応済みに見せない）。数えるのは切り詰める前の全件
  const withValue = new Set(usable.map((dp) => dp.metricId));
  const withActual = new Set(
    usable.filter((dp) => valueKindOf(dp) === 'actual').map((dp) => dp.metricId),
  );
  const values = usable.slice(0, 10);
  // 推計は推計のまま渡す（AI が実績として扱わないよう、値ごとに区分を付ける）
  const metricValues = values.map((dp) => ({
    label: `${metricById.get(dp.metricId)?.name ?? '指標'}（${unitName.get(dp.unitId) ?? '—'}）`,
    value: dp.value as number,
    unit: dp.unitOfMeasure,
    kind: valueKindOf(dp) === 'estimate' ? ('estimate' as const) : ('actual' as const),
  }));
  const matterState =
    section && section !== 'ESRS2' ? context.matters.find((m) => m.topic === section) : undefined;

  const sources: AiSourceReference[] = [
    ...values.map((dp) => ({
      kind: 'data_point' as const,
      id: dp.id,
      label: `${metricById.get(dp.metricId)?.name ?? '指標'}（${unitName.get(dp.unitId) ?? '—'}）`,
      locator: null,
      periodLabel: period.label,
    })),
    ...(matterState?.persisted
      ? [
          {
            kind: 'dma_matter' as const,
            id: matterState.matter.id,
            label: `${matterState.topic} ${DMA_OUTCOME_LABEL[matterState.outcome]}`,
            locator: null,
            periodLabel: period.label,
          },
        ]
      : []),
  ];

  const now = new Date().toISOString();
  const assessment = await ensureCsrdAssessment(db, ctx, context, item, now);
  const { run, output } = await runAi({
    db,
    ctx,
    idempotencyKey: `csrdGapAnalysis:${assessment.id}:${Date.now()}`,
    sources,
    invocation: {
      feature: 'csrdGapAnalysis',
      context: {
        organizationName: ctx.workspace.organizationName,
        reportingPeriodLabel: period.label,
      },
      inputReferenceIds: [assessment.id, item.id, ...(matterState ? [matterState.matter.id] : [])],
      input: {
        itemCode: item.code,
        title: item.questionText,
        requirementText: item.guidance,
        required: item.required,
        section,
        sectionLabel: section ? CSRD_SECTION_LABEL[section] : '節を判定できない要求事項',
        applicability: {
          kind: applicability.kind,
          perspectives: applicability.perspectives,
          provisional: applicability.provisional,
        },
        dma: matterState
          ? { outcome: matterState.outcome, outcomeLabel: DMA_OUTCOME_LABEL[matterState.outcome] }
          : null,
        responseStatus: responses[0]?.status ?? null,
        mappedMetricCount: metrics.length,
        metricsWithValueCount: withValue.size,
        metricsWithActualValueCount: withActual.size,
        missingMetricNames: metrics.filter((m) => !withValue.has(m.id)).map((m) => m.name),
        estimateOnlyMetricNames: metrics
          .filter((m) => withValue.has(m.id) && !withActual.has(m.id))
          .map((m) => m.name),
        metricValues,
        hasApprovalWorkflow: approvals.length > 0,
        sources,
      },
    },
  });

  const evaluatedAt = new Date().toISOString();
  const updated = await db.update('csrdAssessments', assessment.id, {
    aiDisclosureStatus: output.disclosureStatus,
    aiDataStatus: output.dataStatus,
    aiProcessStatus: output.processStatus,
    aiStatus: combineCoverage(output.disclosureStatus, output.dataStatus, output.processStatus),
    aiComment: output.comment,
    aiMissingInfo: output.missingInformation,
    aiRecommendation: output.recommendation,
    aiRunId: run.id,
    aiEvaluatedAt: evaluatedAt,
    updatedAt: evaluatedAt,
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'csrd_assessment',
    resourceId: assessment.id,
    afterSummary: `${item.code}: AI ギャップ分析の候補を記録（確定はしていない）`,
    metadata: { aiRunId: run.id },
  });
  return { assessment: updated, runId: run.id };
}

export interface ReviewCsrdAssessmentInput {
  assessmentId: Uuid;
  /** approved = AI の候補（3 観点）を採用、modified = 人の値で確定（コメント必須） */
  decision: 'approved' | 'modified';
  disclosureStatus?: SsbjCoverageStatus;
  dataStatus?: SsbjCoverageStatus;
  processStatus?: SsbjCoverageStatus;
  comment: string;
  /**
   * 「候補を採用」のとき、画面が表示した AI の候補の実行日時（ai_evaluated_at）。
   * 表示の後に分析がやり直されていれば、見ていない候補を確定しないよう断る
   */
  aiEvaluatedAt?: string | null;
}

/** 表示した後に AI の候補が変わったときの説明 */
export const CSRD_CANDIDATE_CHANGED_MESSAGE =
  'AI の候補が更新されています（別の操作で分析がやり直されました）。画面を再表示し、新しい候補を確認してから採用してください。';

/** 担当者の確認。ここで初めて AI の候補が確定値になる（または人が修正して確定する） */
export async function reviewCsrdAssessment(
  db: DbClient,
  ctx: AuthorizationContext,
  input: ReviewCsrdAssessmentInput,
): Promise<CsrdAssessment> {
  assertCsrdWrite(ctx);
  const before = await db.findById('csrdAssessments', input.assessmentId);
  if (!before || before.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('評価が見つかりません。');
  }
  const comment = cleanText(input.comment, COMMENT_MAX, 'コメント');
  let statuses: [SsbjCoverageStatus, SsbjCoverageStatus, SsbjCoverageStatus];
  if (input.decision === 'approved') {
    if (
      before.aiStatus === null ||
      before.aiDisclosureStatus === null ||
      before.aiDataStatus === null ||
      before.aiProcessStatus === null
    ) {
      throw new ValidationError(
        'AI の候補がありません。先に AI ギャップ分析を実行するか、修正して確定してください。',
      );
    }
    // 採用するのは、利用者が画面で見た候補だけ
    assertSameBase(before.aiEvaluatedAt, input.aiEvaluatedAt, CSRD_CANDIDATE_CHANGED_MESSAGE);
    statuses = [before.aiDisclosureStatus, before.aiDataStatus, before.aiProcessStatus];
  } else if (input.decision === 'modified') {
    statuses = [
      assertCoverage(input.disclosureStatus),
      assertCoverage(input.dataStatus),
      assertCoverage(input.processStatus),
    ];
    if (comment === '') {
      throw new ValidationError(MODIFY_REASON_REQUIRED);
    }
  } else {
    throw new ValidationError('確認の区分が正しくありません。');
  }
  const finalStatus = combineCoverage(...statuses);
  const now = new Date().toISOString();
  const updated = await db.update('csrdAssessments', before.id, {
    disclosureStatus: statuses[0],
    dataStatus: statuses[1],
    processStatus: statuses[2],
    finalStatus,
    reviewDecision: input.decision,
    reviewedBy: ctx.userId,
    reviewedAt: now,
    reviewComment: comment,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'csrd_assessment',
    resourceId: before.id,
    beforeSummary: `AI 候補 ${before.aiStatus ? COVERAGE_LABEL[before.aiStatus] : 'なし'} / 最終判定 ${before.finalStatus ? COVERAGE_LABEL[before.finalStatus] : '未確定'}`,
    afterSummary: `最終判定 ${COVERAGE_LABEL[finalStatus]}（${input.decision === 'approved' ? 'AI の候補を採用' : '担当者が修正'}）`,
  });
  return updated;
}
