import 'server-only';

import { runAi } from '@/lib/ai';
import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, can, NotFoundError } from '@/lib/authorization/can';
import { FIXTURE_TODAY } from '@/lib/config';
import { suggestMaterialityCategory } from '@/lib/domain/materiality-suggest';
import {
  areaOfSection,
  combineCoverage,
  coverageRate,
  evaluatePriority,
  type PriorityResult,
  type SsbjArea,
} from '@/lib/domain/ssbj';
import { ValidationError } from '@/lib/errors/user-facing';
import { fid } from '@/lib/fixtures/ids';
import { daysUntilJst } from '@/lib/format/datetime';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  DisclosureItem,
  MaterialityCategory,
  MaterialityLevel,
  MetricDefinition,
  ReportingPeriod,
  SsbjActionPlan,
  SsbjActionStatus,
  SsbjActionType,
  SsbjApplicability,
  SsbjAssessment,
  SsbjCoverageStatus,
  SsbjGapKind,
  SsbjMateriality,
  SsbjPriority,
  Uuid,
} from '@/types/domain';

/**
 * SSBJ ギャップ分析。
 *
 * 「AI が○△×を付けるツール」ではなく、
 *   分析条件の設定 → 資料の取込 → 対象判定 → AI ギャップ分析 → 担当者の確認
 *   → 優先順位付け → 対応計画 → データ収集・開示
 * という一連の業務を管理するための土台。
 *
 * 守っていること:
 *  - AI の判定はそのまま最終判定にしない（`finalStatus` は担当者の確認で入る）
 *  - 優先度は保存せず毎回計算する（対応状況を更新したら順位も追随する）
 *  - 判定を変えたら誰が・いつ・何を・なぜ変えたかを監査ログへ残す
 */

// ----------------------------------------------------------------------
// 読み取り
// ----------------------------------------------------------------------

export interface SsbjRequirementView {
  item: DisclosureItem;
  assessment: SsbjAssessment;
  area: SsbjArea;
  /** 3 観点をまとめた対応状況（最も遅れている観点に合わせる） */
  combined: SsbjCoverageStatus;
  priority: PriorityResult;
  /** この要求事項に紐づく対応計画 */
  plans: SsbjActionPlan[];
  /** 人工知能の分析で既存資料に該当箇所が見つかったか（取込資料との紐づけ） */
  hasDocumentLink: boolean;
  /** 要求する指標に当期の値があるか（データとの紐づけ） */
  hasDataLink: boolean;
  /** 人工知能の分析を実行済みか */
  analyzed: boolean;
}

export interface SsbjAreaSummary {
  area: SsbjArea;
  total: number;
  /** 対応度（%） */
  rate: number;
  notCovered: number;
}

export interface SsbjOverview {
  versionLabel: string;
  isFixture: boolean;
  attribution: string;
  period: ReportingPeriod;
  /** 3 観点それぞれの整備度（%） */
  disclosureRate: number;
  dataRate: number;
  processRate: number;
  /** 件数の内訳 */
  counts: {
    total: number;
    covered: number;
    mostlyCovered: number;
    partial: number;
    notCovered: number;
    notMaterial: number;
    notApplicable: number;
    awaitingReview: number;
  };
  areas: SsbjAreaSummary[];
  /** 優先度が高いギャップ（全体状況画面で目立たせる） */
  topPriorities: SsbjRequirementView[];
  /** 対応計画の進捗 */
  planCounts: Record<SsbjActionStatus, number>;
}

/**
 * 「①マテリアリティ・分析条件の設定」で選んだ基準から、評価対象の節を決める。
 *
 * 設定画面は「適用しない基準の要求事項は、以降の評価対象から外れます」と書いている。
 * ここで実際に外さないと、設定しても何も変わらない画面になる。
 * 要求事項マスターの section は「一般：〜」「気候：〜」「実務対応第1号：〜」で始まる。
 *
 * 未設定のうちは絞り込まない（決める前から要求事項が消えると、何を決めるのかが分からない）。
 */
async function sectionPrefixesFor(
  db: DbClient,
  organizationId: Uuid,
  reportingPeriodId: Uuid,
): Promise<string[] | null> {
  const rows = await db.select('ssbjAnalysisSettings', {
    where: { organizationId, reportingPeriodId },
    limit: 1,
  });
  const settings = rows[0];
  if (!settings) return null;

  const prefixes: string[] = [];
  if (settings.applyGeneral) prefixes.push('一般');
  if (settings.applyClimate) prefixes.push('気候');
  if (settings.applyPractical) prefixes.push('実務対応');
  // 1 つも選ばれていない状態は保存できないが、万一そうなっても全件を隠さない
  return prefixes.length > 0 ? prefixes : null;
}

/** SSBJ の要求事項マスター（disclosure_items）を取得する */
async function loadSsbjItems(
  db: DbClient,
  organizationId: Uuid,
  reportingPeriodId: Uuid,
): Promise<{ items: DisclosureItem[]; versionLabel: string; isFixture: boolean } | null> {
  const frameworks = await db.select('frameworks', { where: { key: 'ssbj' }, limit: 1 });
  const framework = frameworks[0];
  if (!framework) return null;
  const versions = await db.select('frameworkVersions', {
    where: { frameworkId: framework.id },
    orderBy: { column: 'year', dir: 'desc' },
  });
  const current = versions.find((v) => v.status === 'published') ?? versions[0];
  if (!current) return null;
  const all = await db.select('disclosureItems', {
    where: { frameworkVersionId: current.id },
    orderBy: { column: 'sortOrder' },
  });

  const prefixes = await sectionPrefixesFor(db, organizationId, reportingPeriodId);
  const items = prefixes
    ? all.filter((item) => prefixes.some((prefix) => item.section.startsWith(prefix)))
    : all;

  return { items, versionLabel: current.label, isFixture: current.isFixture };
}

/**
 * 評価行を用意する。まだ無い要求事項には既定値の行をその場で作る
 * （133 項目すべてに行が無いと、一覧の絞り込みや集計が歯抜けになる）。
 */
async function ensureAssessments(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  items: DisclosureItem[],
): Promise<SsbjAssessment[]> {
  const organizationId = ctx.workspace.organizationId;
  const existing = await db.select('ssbjAssessments', {
    where: { organizationId, reportingPeriodId: period.id },
  });
  const byItem = new Map(existing.map((a) => [a.itemId, a]));
  const missing = items.filter((i) => !byItem.has(i.id));
  if (missing.length === 0 || !can(ctx, 'enterprise.disclosure.write')) return existing;

  const now = new Date().toISOString();
  const created: SsbjAssessment[] = missing.map((item) => ({
    id: fid('ssbj_assessment', `${organizationId}/${period.id}/${item.code}`),
    organizationId,
    reportingPeriodId: period.id,
    itemId: item.id,
    applicability: 'applicable',
    applicabilityReason: '',
    materiality: 'not_assessed',
    materialityReason: '',
    disclosureStatus: 'unconfirmed',
    dataStatus: 'unconfirmed',
    processStatus: 'unconfirmed',
    aiStatus: null,
    aiComment: '',
    aiMissingInfo: [],
    aiRecommendation: '',
    aiRunId: null,
    aiEvaluatedAt: null,
    sourceDocument: null,
    sourcePage: null,
    sourceExcerpt: null,
    reviewDecision: null,
    reviewedBy: null,
    reviewedAt: null,
    reviewComment: '',
    finalStatus: null,
    ownerDepartment: '',
    ownerUserId: null,
    carriedOverFrom: null,
    recheckReason: '',
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  }));
  await db.insert('ssbjAssessments', created);
  return [...existing, ...created];
}

/** 保証の対象になりやすい指標に関係する要求事項か（優先度の評価に使う） */
function isAssuranceRelevant(item: DisclosureItem): boolean {
  return /温室効果ガス|排出|スコープ|指標|目標/.test(`${item.questionText}${item.section}`);
}

function buildView(
  item: DisclosureItem,
  assessment: SsbjAssessment,
  plans: SsbjActionPlan[],
  daysToDeadline: number | null,
): SsbjRequirementView {
  return {
    item,
    assessment,
    area: areaOfSection(item.section),
    combined: combineCoverage(
      assessment.disclosureStatus,
      assessment.dataStatus,
      assessment.processStatus,
    ),
    priority: evaluatePriority({
      required: item.required,
      materiality: assessment.materiality,
      disclosureStatus: assessment.disclosureStatus,
      dataStatus: assessment.dataStatus,
      processStatus: assessment.processStatus,
      assuranceRelevant: isAssuranceRelevant(item),
      daysToDeadline,
    }),
    plans: plans.filter((p) => p.assessmentId === assessment.id),
    hasDocumentLink: assessment.sourceDocument !== null,
    hasDataLink: false,
    analyzed: assessment.aiEvaluatedAt !== null,
  };
}

/** 期限までの残り日数（報告期間の提出期限を使う） */
function deadlineDays(period: ReportingPeriod): number | null {
  const due = period.submissionDueDate;
  if (!due) return null;
  return daysUntilJst(due, FIXTURE_TODAY);
}

export async function loadSsbjRequirementViews(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
): Promise<{ views: SsbjRequirementView[]; versionLabel: string; isFixture: boolean } | null> {
  const master = await loadSsbjItems(db, ctx.workspace.organizationId, period.id);
  if (!master) return null;

  const assessments = await ensureAssessments(db, ctx, period, master.items);
  const plans = await db.select('ssbjActionPlans', {
    where: { organizationId: ctx.workspace.organizationId, reportingPeriodId: period.id },
  });
  const byItem = new Map(assessments.map((a) => [a.itemId, a]));
  const days = deadlineDays(period);

  // 要求事項が求める指標に、当期の値が実際にあるか（データとの紐づけ）。
  // 要求事項 → 指標の対応は disclosure_mappings が持つ。
  // 「資料の取込・データ収集でこの項目を埋められるか」を一覧で見せるために持つ
  const [mappings, dataPoints] = await Promise.all([
    db.select('disclosureMappings', {
      where: { organizationId: ctx.workspace.organizationId },
    }),
    db.select('dataPoints', {
      where: {
        organizationId: ctx.workspace.organizationId,
        reportingPeriodId: period.id,
        deletedAt: { isNull: true },
      },
    }),
  ]);
  const metricIdsWithValue = new Set(
    dataPoints.filter((dp) => dp.value !== null).map((dp) => dp.metricId),
  );
  const itemIdsWithData = new Set(
    mappings.filter((m) => metricIdsWithValue.has(m.metricId)).map((m) => m.itemId),
  );

  const views = master.items
    .map((item) => {
      const assessment = byItem.get(item.id);
      if (!assessment) return null;
      const view = buildView(item, assessment, plans, days);
      view.hasDataLink = itemIdsWithData.has(item.id);
      return view;
    })
    .filter((v): v is SsbjRequirementView => v !== null);

  return { views, versionLabel: master.versionLabel, isFixture: master.isFixture };
}

// ----------------------------------------------------------------------
// 対象の整理（マッピング）
// ----------------------------------------------------------------------

/** マテリアリティ 1 件と SSBJ 基準の対応（マッピング表の 1 行） */
export interface SsbjMappingRow {
  title: string;
  category: MaterialityCategory;
  materiality: MaterialityLevel;
  /** 気候関連開示基準の対象になりやすい課題か */
  climate: boolean;
  /** 項目（対象指標）の数 */
  metricCount: number;
  /** 対象指標を通じて紐づく要求事項の数 */
  linkedItemCount: number;
}

export interface SsbjScopeMapping {
  /** 適用している基準（設定が無ければ既定: 一般・気候） */
  applied: { general: boolean; climate: boolean; practical: boolean };
  /** 設定を保存済みか（未設定なら既定の全件表示であることを画面で伝える） */
  configured: boolean;
  /** 件数の流れ: マスター全件 → 基準で絞り込み → 対象外・重要性なしを除く */
  counts: {
    masterTotal: number;
    afterStandards: number;
    notApplicable: number;
    notMaterial: number;
    inScope: number;
  };
  /** マテリアリティ × 基準のマッピング表 */
  rows: SsbjMappingRow[];
  /** 取込資料・データとの紐づけ集計（対象の要求事項のみ） */
  linkage: {
    document: number;
    data: number;
    /** 分析済みだが資料にもデータにも紐づかない */
    none: number;
    unanalyzed: number;
  };
}

/**
 * 「必要な要求項目のみが正しく表示されているか」を確かめるための整理。
 *
 * 前の 2 工程（①分析条件の設定・②資料の取込）の内容から、
 *  - どの基準を適用し、その結果 133 項目が何件に絞り込まれたか
 *  - 登録したマテリアリティが、どの基準・どの要求事項へ紐づくか
 *  - 対象の要求事項のうち、取込資料・データで裏づけられるものはどれか
 * を 1 か所で返す。判定は保存済みデータと規則だけで行い、ここで AI は使わない
 * （画面は「なぜこの件数なのか」を検算できる必要がある）。
 */
export async function loadSsbjScopeMapping(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  views: SsbjRequirementView[],
): Promise<SsbjScopeMapping> {
  const organizationId = ctx.workspace.organizationId;

  const [settingsRows, topics, allItemsCount, mappings, metrics] = await Promise.all([
    db.select('ssbjAnalysisSettings', {
      where: { organizationId, reportingPeriodId: period.id },
      limit: 1,
    }),
    db.select('materialityTopics', {
      where: { organizationId, reportingPeriodId: period.id, deletedAt: { isNull: true } },
      orderBy: { column: 'createdAt', dir: 'asc' },
    }),
    (async () => {
      const frameworks = await db.select('frameworks', { where: { key: 'ssbj' }, limit: 1 });
      if (!frameworks[0]) return 0;
      const versions = await db.select('frameworkVersions', {
        where: { frameworkId: frameworks[0].id },
        orderBy: { column: 'year', dir: 'desc' },
      });
      const current = versions.find((v) => v.status === 'published') ?? versions[0];
      if (!current) return 0;
      return (await db.select('disclosureItems', { where: { frameworkVersionId: current.id } }))
        .length;
    })(),
    db.select('disclosureMappings', { where: { organizationId } }),
    db.select('metrics', { where: { organizationId, deletedAt: { isNull: true } } }),
  ]);

  const settings = settingsRows[0] ?? null;
  const applied = settings
    ? {
        general: settings.applyGeneral,
        climate: settings.applyClimate,
        practical: settings.applyPractical,
      }
    : { general: true, climate: true, practical: false };

  const metricIdByCode = new Map(metrics.map((m) => [m.code, m.id]));
  // 指標 → その指標を求める要求事項（disclosure_mappings 経由）
  const itemIdsByMetricId = new Map<Uuid, Set<Uuid>>();
  for (const mapping of mappings) {
    const set = itemIdsByMetricId.get(mapping.metricId) ?? new Set<Uuid>();
    set.add(mapping.itemId);
    itemIdsByMetricId.set(mapping.metricId, set);
  }
  const shownItemIds = new Set(views.map((v) => v.item.id));

  const rows: SsbjMappingRow[] = topics.map((topic) => {
    // 気候の課題かどうかは、名前・内容・リスク・機会を合わせた提示器の判定で見る
    // （登録時と同じ規則なので、画面の説明と食い違わない）
    const suggestion = suggestMaterialityCategory(
      topic.title,
      topic.description,
      topic.risks,
      topic.opportunities,
    );
    const climate =
      suggestion.candidates.find((c) => c.category === topic.category)?.climate ?? false;

    const linkedItemIds = new Set<Uuid>();
    for (const code of topic.metricCodes) {
      const metricId = metricIdByCode.get(code);
      if (!metricId) continue;
      for (const itemId of itemIdsByMetricId.get(metricId) ?? []) {
        if (shownItemIds.has(itemId)) linkedItemIds.add(itemId);
      }
    }

    return {
      title: topic.title,
      category: topic.category,
      materiality: topic.materiality,
      climate,
      metricCount: topic.metricCodes.length,
      linkedItemCount: linkedItemIds.size,
    };
  });

  const applicable = views.filter((v) => v.assessment.applicability === 'applicable');
  const notApplicable = views.length - applicable.length;
  const notMaterial = applicable.filter((v) => v.assessment.materiality === 'not_material').length;

  const linkage = { document: 0, data: 0, none: 0, unanalyzed: 0 };
  for (const view of applicable) {
    if (view.hasDocumentLink) linkage.document += 1;
    if (view.hasDataLink) linkage.data += 1;
    if (!view.analyzed) linkage.unanalyzed += 1;
    else if (!view.hasDocumentLink && !view.hasDataLink) linkage.none += 1;
  }

  return {
    applied,
    configured: settings !== null,
    counts: {
      masterTotal: allItemsCount,
      afterStandards: views.length,
      notApplicable,
      notMaterial,
      inScope: applicable.length - notMaterial,
    },
    rows,
    linkage,
  };
}

/**
 * 未分析の要求事項をまとめて人工知能で分析する。
 *
 * 1 件ずつ詳細画面から実行する運用だと 133 項目は現実的に終わらない。
 * 優先度の高い順に、1 回の操作で最大 `limit` 件だけ実行する
 * （全件を一括にしないのは、実 AI 接続時の実行コストと時間を抑えるため）。
 * 判定はこれまでどおり候補どまりで、最終判定は担当者の確認で入る。
 */
export async function runSsbjGapAnalysisBulk(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  limit = 20,
): Promise<{ analyzed: number; remaining: number }> {
  assertCan(ctx, 'enterprise.ai.run');

  const loaded = await loadSsbjRequirementViews(db, ctx, period);
  if (!loaded) throw new NotFoundError('SSBJ の要求事項マスターが見つかりません。');

  const pending = loaded.views
    .filter((v) => v.assessment.applicability === 'applicable' && !v.analyzed)
    .sort((a, b) => b.priority.score - a.priority.score);

  const targets = pending.slice(0, limit);
  for (const view of targets) {
    await runSsbjGapAnalysis(db, ctx, view.assessment.id);
  }

  return { analyzed: targets.length, remaining: pending.length - targets.length };
}

const EMPTY_PLAN_COUNTS: Record<SsbjActionStatus, number> = {
  not_started: 0,
  in_progress: 0,
  in_review: 0,
  done: 0,
};

/**
 * 全体状況の見出し数値だけを読む（評価行を作らない）。
 *
 * ホーム画面から呼ぶため読み取り専用にしてある。画面を開いただけで
 * 評価行が作られると、「誰が作ったのか」が説明できなくなる。
 */
export async function loadSsbjHeadline(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
): Promise<{
  disclosureRate: number;
  dataRate: number;
  processRate: number;
  /** 未対応・未確認の要求事項の件数 */
  openCount: number;
  total: number;
} | null> {
  const all = await db.select('ssbjAssessments', {
    where: { organizationId: ctx.workspace.organizationId, reportingPeriodId: period.id },
  });
  if (all.length === 0) return null;

  // 適用しないと決めた基準の要求事項は数えない。
  // ここで揃えておかないと、ホームの件数と要求事項一覧の件数が食い違う
  // （後から基準を外すと、作成済みの評価行が残るため）。
  const master = await loadSsbjItems(db, ctx.workspace.organizationId, period.id);
  const applicableItemIds = master ? new Set(master.items.map((i) => i.id)) : null;
  const assessments = applicableItemIds ? all.filter((a) => applicableItemIds.has(a.itemId)) : all;
  if (assessments.length === 0) return null;

  // 対象外・重要性なしは整備度の分母から外す（対応する必要が無いため）
  const inScope = assessments.filter(
    (a) => a.applicability === 'applicable' && a.materiality !== 'not_material',
  );
  const openCount = inScope.filter((a) => {
    const combined = combineCoverage(a.disclosureStatus, a.dataStatus, a.processStatus);
    return combined === 'not_covered' || combined === 'unconfirmed';
  }).length;

  return {
    disclosureRate: coverageRate(inScope.map((a) => a.disclosureStatus)),
    dataRate: coverageRate(inScope.map((a) => a.dataStatus)),
    processRate: coverageRate(inScope.map((a) => a.processStatus)),
    openCount,
    total: assessments.length,
  };
}

export async function loadSsbjOverview(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  attribution: string,
): Promise<SsbjOverview | null> {
  const loaded = await loadSsbjRequirementViews(db, ctx, period);
  if (!loaded) return null;
  const { views, versionLabel, isFixture } = loaded;

  // 対象外・重要性なしは整備度の分母から外す（対応する必要が無いため）
  const inScope = views.filter(
    (v) =>
      v.assessment.applicability === 'applicable' && v.assessment.materiality !== 'not_material',
  );

  const counts = {
    total: views.length,
    covered: 0,
    mostlyCovered: 0,
    partial: 0,
    notCovered: 0,
    notMaterial: 0,
    notApplicable: 0,
    awaitingReview: 0,
  };
  for (const v of views) {
    if (v.assessment.applicability === 'not_applicable') {
      counts.notApplicable += 1;
      continue;
    }
    if (v.assessment.materiality === 'not_material') {
      counts.notMaterial += 1;
      continue;
    }
    // AI が判定したのに担当者がまだ確認していないもの
    if (v.assessment.aiStatus !== null && v.assessment.finalStatus === null) {
      counts.awaitingReview += 1;
    }
    switch (v.combined) {
      case 'covered':
        counts.covered += 1;
        break;
      case 'mostly_covered':
        counts.mostlyCovered += 1;
        break;
      case 'partial':
        counts.partial += 1;
        break;
      default:
        counts.notCovered += 1;
    }
  }

  const areas: SsbjAreaSummary[] = (['governance', 'strategy', 'risk', 'metrics', 'other'] as const)
    .map((area) => {
      const rows = inScope.filter((v) => v.area === area);
      return {
        area,
        total: rows.length,
        rate: coverageRate(rows.map((v) => v.combined)),
        notCovered: rows.filter((v) => v.combined === 'not_covered' || v.combined === 'unconfirmed')
          .length,
      };
    })
    .filter((a) => a.total > 0);

  const topPriorities = inScope
    .filter((v) => v.combined !== 'covered')
    .sort((a, b) => b.priority.score - a.priority.score || a.item.sortOrder - b.item.sortOrder)
    .slice(0, 8);

  const plans = await db.select('ssbjActionPlans', {
    where: { organizationId: ctx.workspace.organizationId, reportingPeriodId: period.id },
  });
  const planCounts = { ...EMPTY_PLAN_COUNTS };
  for (const plan of plans) planCounts[plan.status] += 1;

  return {
    versionLabel,
    isFixture,
    attribution,
    period,
    disclosureRate: coverageRate(inScope.map((v) => v.assessment.disclosureStatus)),
    dataRate: coverageRate(inScope.map((v) => v.assessment.dataStatus)),
    processRate: coverageRate(inScope.map((v) => v.assessment.processStatus)),
    counts,
    areas,
    topPriorities,
    planCounts,
  };
}

export interface SsbjRequirementFilters {
  area?: string[];
  coverage?: string[];
  materiality?: string[];
  priority?: string[];
  department?: string[];
  /** 取込資料・データとの紐づけ（document / data / unanalyzed / none） */
  linkage?: string[];
  search?: string;
}

/** 要求事項一覧（絞り込み付き） */
export function filterRequirements(
  views: SsbjRequirementView[],
  filters: SsbjRequirementFilters,
): SsbjRequirementView[] {
  const has = (list: string[] | undefined) => list !== undefined && list.length > 0;
  const search = (filters.search ?? '').trim();
  return views.filter((v) => {
    if (has(filters.area) && !filters.area!.includes(v.area)) return false;
    if (has(filters.coverage) && !filters.coverage!.includes(v.combined)) return false;
    if (has(filters.materiality) && !filters.materiality!.includes(v.assessment.materiality)) {
      return false;
    }
    if (has(filters.priority) && !filters.priority!.includes(v.priority.priority)) return false;
    if (has(filters.linkage)) {
      const states: string[] = [];
      if (v.hasDocumentLink) states.push('document');
      if (v.hasDataLink) states.push('data');
      if (!v.analyzed) states.push('unanalyzed');
      else if (!v.hasDocumentLink && !v.hasDataLink) states.push('none');
      if (!filters.linkage!.some((l) => states.includes(l))) return false;
    }
    if (has(filters.department) && !filters.department!.includes(v.assessment.ownerDepartment)) {
      return false;
    }
    if (search !== '') {
      const haystack = `${v.item.code} ${v.item.questionText} ${v.item.section} ${v.assessment.ownerDepartment}`;
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

export async function loadSsbjRequirementDetail(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  itemId: Uuid,
): Promise<{ view: SsbjRequirementView; metrics: MetricDefinition[] } | null> {
  const loaded = await loadSsbjRequirementViews(db, ctx, period);
  if (!loaded) return null;
  const view = loaded.views.find((v) => v.item.id === itemId);
  if (!view) return null;

  // この要求事項へ紐づいている指標（開示マッピング経由）
  const mappings = await db.select('disclosureMappings', {
    where: { organizationId: ctx.workspace.organizationId, itemId },
  });
  const allMetrics = await db.select('metrics', {
    where: { organizationId: ctx.workspace.organizationId, deletedAt: { isNull: true } },
  });
  const metricIds = new Set(mappings.map((m) => m.metricId));
  return { view, metrics: allMetrics.filter((m) => metricIds.has(m.id)) };
}

// ----------------------------------------------------------------------
// 書き込み
// ----------------------------------------------------------------------

async function findAssessment(
  db: DbClient,
  ctx: AuthorizationContext,
  assessmentId: Uuid,
): Promise<SsbjAssessment> {
  const assessment = await db.findById('ssbjAssessments', assessmentId);
  if (!assessment || assessment.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('評価が見つかりません。');
  }
  return assessment;
}

/** 対象判定・重要性判断（手順 3） */
export async function saveSsbjScope(
  db: DbClient,
  ctx: AuthorizationContext,
  input: {
    assessmentId: Uuid;
    applicability: SsbjApplicability;
    applicabilityReason: string;
    materiality: SsbjMateriality;
    materialityReason: string;
    ownerDepartment: string;
  },
): Promise<void> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const before = await findAssessment(db, ctx, input.assessmentId);

  // 「対象外」「重要性なし」は開示しない判断そのものなので、理由の記録を必須にする
  if (input.applicability === 'not_applicable' && input.applicabilityReason.trim() === '') {
    throw new ValidationError('対象外とする場合は、その理由を入力してください。');
  }
  if (input.materiality === 'not_material' && input.materialityReason.trim() === '') {
    throw new ValidationError('重要性なしとする場合は、その理由を入力してください。');
  }

  await db.update('ssbjAssessments', input.assessmentId, {
    applicability: input.applicability,
    applicabilityReason: input.applicabilityReason.trim(),
    materiality: input.materiality,
    materialityReason: input.materialityReason.trim(),
    ownerDepartment: input.ownerDepartment.trim(),
    updatedAt: new Date().toISOString(),
    updatedBy: ctx.userId,
  });

  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'ssbj_assessment',
    resourceId: input.assessmentId,
    beforeSummary: `適用区分 ${before.applicability} / 重要性 ${before.materiality}`,
    afterSummary: `適用区分 ${input.applicability} / 重要性 ${input.materiality}`,
    metadata: {
      applicabilityReason: input.applicabilityReason,
      materialityReason: input.materialityReason,
    },
  });
}

/**
 * AI によるギャップ分析（手順 4）。
 *
 * 結果は候補として保存する。`finalStatus` はここでは入れない
 * （担当者が確認して初めて最終判定になる）。
 */
export async function runSsbjGapAnalysis(
  db: DbClient,
  ctx: AuthorizationContext,
  assessmentId: Uuid,
): Promise<void> {
  assertCan(ctx, 'enterprise.ai.run');
  const assessment = await findAssessment(db, ctx, assessmentId);
  const item = await db.findById('disclosureItems', assessment.itemId);
  if (!item) throw new NotFoundError('要求事項が見つかりません。');

  const organizationId = ctx.workspace.organizationId;

  // 取り込み済みの資料（有価証券報告書・統合報告書など）から該当箇所を探させる
  const files = await db.select('files', { where: { organizationId } });
  const fragments = await db.select('fragments', { where: { organizationId } });
  const versionById = new Map(
    (await db.select('fileVersions', { where: { organizationId } })).map((v) => [v.id, v]),
  );
  const fileById = new Map(files.map((f) => [f.id, f]));

  const documents = fragments.slice(0, 40).map((f) => {
    const version = versionById.get(f.fileVersionId);
    const file = version ? fileById.get(version.fileId) : undefined;
    return {
      name: file?.originalName ?? '取込資料',
      page: f.page === null ? '該当箇所' : `${f.page} ページ`,
      excerpt: f.text.slice(0, 200),
    };
  });

  // この要求事項に紐づく承認済みデータ（データギャップの判定材料）
  const mappings = await db.select('disclosureMappings', {
    where: { organizationId, itemId: item.id },
  });
  const metrics = await db.select('metrics', {
    where: { organizationId, deletedAt: { isNull: true } },
  });
  const metricById = new Map(metrics.map((m) => [m.id, m]));
  const dataPoints = await db.select('dataPoints', {
    where: {
      organizationId,
      reportingPeriodId: assessment.reportingPeriodId,
      status: 'approved',
      deletedAt: { isNull: true },
    },
  });
  const mappedMetricIds = new Set(mappings.map((m) => m.metricId));
  const metricValues = dataPoints
    .filter((dp) => mappedMetricIds.has(dp.metricId))
    .slice(0, 10)
    .map((dp) => ({
      label: metricById.get(dp.metricId)?.name ?? '指標',
      value: dp.value ?? 0,
      unit: dp.unitOfMeasure,
    }));

  // 承認履歴が残る運用になっているか（業務プロセス・内部統制の判定材料）
  const approvals = await db.select('approvals', { where: { organizationId }, limit: 1 });

  const { run, output } = await runAi({
    db,
    ctx,
    idempotencyKey: `ssbjGap:${assessmentId}:${Date.now()}`,
    sources: metricValues.map((m) => ({
      kind: 'data_point' as const,
      id: null,
      label: m.label,
      locator: null,
      periodLabel: null,
    })),
    invocation: {
      feature: 'ssbjGapAnalysis',
      context: {
        organizationName: ctx.workspace.organizationName,
        reportingPeriodLabel: '',
      },
      inputReferenceIds: [assessmentId, item.id],
      input: {
        itemCode: item.code,
        title: item.questionText,
        requirementText: item.guidance,
        required: item.required,
        documents,
        metricValues,
        hasApprovalWorkflow: approvals.length > 0,
        sources: [],
      },
    },
  });

  await db.update('ssbjAssessments', assessmentId, {
    // 3 観点の現況を AI の判定で埋める（担当者が後から修正できる）
    disclosureStatus: output.disclosureStatus,
    dataStatus: output.dataStatus,
    processStatus: output.processStatus,
    aiStatus: combineCoverage(output.disclosureStatus, output.dataStatus, output.processStatus),
    aiComment: output.comment,
    aiMissingInfo: output.missingInformation,
    aiRecommendation: output.recommendation,
    aiRunId: run.id,
    aiEvaluatedAt: new Date().toISOString(),
    sourceDocument: output.sourceDocument,
    sourcePage: output.sourcePage,
    sourceExcerpt: output.sourceExcerpt,
    // AI が判定し直したら、担当者の確認はやり直す。
    // 確認日や確認者を残すと「いつの判定を確認したのか」が食い違う
    reviewDecision: null,
    reviewedBy: null,
    reviewedAt: null,
    reviewComment: '',
    finalStatus: null,
    updatedAt: new Date().toISOString(),
    updatedBy: ctx.userId,
  });
}

/**
 * 担当者による確認（手順 5）。ここで初めて最終判定が入る。
 */
export async function saveSsbjReview(
  db: DbClient,
  ctx: AuthorizationContext,
  input: {
    assessmentId: Uuid;
    /** AI の判定をそのまま承認するか、修正するか */
    decision: 'approve_ai' | 'modify';
    disclosureStatus: SsbjCoverageStatus;
    dataStatus: SsbjCoverageStatus;
    processStatus: SsbjCoverageStatus;
    comment: string;
  },
): Promise<void> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const before = await findAssessment(db, ctx, input.assessmentId);

  if (input.decision === 'approve_ai' && before.aiStatus === null) {
    throw new ValidationError(
      'AI による判定がありません。先にギャップ分析を実行するか、判定を修正して確定してください。',
    );
  }

  const disclosureStatus =
    input.decision === 'approve_ai' ? before.disclosureStatus : input.disclosureStatus;
  const dataStatus = input.decision === 'approve_ai' ? before.dataStatus : input.dataStatus;
  const processStatus =
    input.decision === 'approve_ai' ? before.processStatus : input.processStatus;
  const finalStatus = combineCoverage(disclosureStatus, dataStatus, processStatus);

  const now = new Date().toISOString();
  await db.update('ssbjAssessments', input.assessmentId, {
    disclosureStatus,
    dataStatus,
    processStatus,
    finalStatus,
    reviewDecision: input.decision === 'approve_ai' ? 'approved' : 'modified',
    reviewedBy: ctx.userId,
    reviewedAt: now,
    reviewComment: input.comment.trim(),
    updatedAt: now,
    updatedBy: ctx.userId,
  });

  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'ssbj_assessment',
    resourceId: input.assessmentId,
    beforeSummary: `AI 判定 ${before.aiStatus ?? '未実施'} / 最終判定 ${before.finalStatus ?? '未確定'}`,
    afterSummary: `最終判定 ${finalStatus}（${input.decision === 'approve_ai' ? 'AI 判定を承認' : '担当者が修正'}）`,
    metadata: { comment: input.comment },
  });
}

// ----------------------------------------------------------------------
// 対応計画（手順 7）
// ----------------------------------------------------------------------

export interface ActionPlanInput {
  assessmentId: Uuid;
  gapKind: SsbjGapKind;
  title: string;
  detail: string;
  actionType: SsbjActionType;
  department: string;
  assigneeUserId: Uuid | null;
  dueDate: string | null;
  priority: SsbjPriority;
}

export async function createActionPlan(
  db: DbClient,
  ctx: AuthorizationContext,
  input: ActionPlanInput,
): Promise<SsbjActionPlan> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const assessment = await findAssessment(db, ctx, input.assessmentId);
  if (input.title.trim() === '') {
    throw new ValidationError('対応内容を入力してください。');
  }

  const now = new Date().toISOString();
  const plan: SsbjActionPlan = {
    id: fid('ssbj_action_plan', `${input.assessmentId}/${input.gapKind}/${now}`),
    organizationId: ctx.workspace.organizationId,
    reportingPeriodId: assessment.reportingPeriodId,
    assessmentId: input.assessmentId,
    gapKind: input.gapKind,
    title: input.title.trim(),
    detail: input.detail.trim(),
    actionType: input.actionType,
    department: input.department.trim(),
    assigneeUserId: input.assigneeUserId,
    dueDate: input.dueDate,
    priority: input.priority,
    status: 'not_started',
    linkedMetricCode: null,
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  };
  await db.insert('ssbjActionPlans', [plan]);

  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'ssbj_action_plan',
    resourceId: plan.id,
    afterSummary: `対応計画を追加: ${plan.title}`,
    metadata: { gapKind: plan.gapKind, actionType: plan.actionType },
  });
  return plan;
}

export async function updateActionPlan(
  db: DbClient,
  ctx: AuthorizationContext,
  input: {
    planId: Uuid;
    status: SsbjActionStatus;
    department: string;
    assigneeUserId: Uuid | null;
    dueDate: string | null;
    priority: SsbjPriority;
  },
): Promise<void> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const plan = await db.findById('ssbjActionPlans', input.planId);
  if (!plan || plan.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('対応計画が見つかりません。');
  }

  await db.update('ssbjActionPlans', input.planId, {
    status: input.status,
    department: input.department.trim(),
    assigneeUserId: input.assigneeUserId,
    dueDate: input.dueDate,
    priority: input.priority,
    updatedAt: new Date().toISOString(),
    updatedBy: ctx.userId,
  });

  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'ssbj_action_plan',
    resourceId: input.planId,
    beforeSummary: `対応状況 ${plan.status} / 担当部署 ${plan.department || '未設定'}`,
    afterSummary: `対応状況 ${input.status} / 担当部署 ${input.department || '未設定'}`,
  });
}

export interface ActionPlanView {
  plan: SsbjActionPlan;
  item: DisclosureItem | null;
  assigneeName: string | null;
  /** 期限までの残り日数（マイナスは超過） */
  daysLeft: number | null;
}

export async function loadActionPlans(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
): Promise<ActionPlanView[]> {
  const organizationId = ctx.workspace.organizationId;
  const plans = await db.select('ssbjActionPlans', {
    where: { organizationId, reportingPeriodId: period.id },
  });
  const assessments = await db.select('ssbjAssessments', {
    where: { organizationId, reportingPeriodId: period.id },
  });
  const assessmentById = new Map(assessments.map((a) => [a.id, a]));
  const itemIds = new Set(assessments.map((a) => a.itemId));
  const items = (
    await db.select('disclosureItems', { where: { id: { in: [...itemIds] } } })
  ).reduce((map, item) => map.set(item.id, item), new Map<Uuid, DisclosureItem>());
  const profiles = await db.select('profiles', {});
  const nameById = new Map(profiles.map((p) => [p.id, p.displayName]));

  return plans.map((plan) => {
    const assessment = assessmentById.get(plan.assessmentId);
    return {
      plan,
      item: assessment ? (items.get(assessment.itemId) ?? null) : null,
      assigneeName: plan.assigneeUserId ? (nameById.get(plan.assigneeUserId) ?? null) : null,
      daysLeft: plan.dueDate ? daysUntilJst(plan.dueDate, FIXTURE_TODAY) : null,
    };
  });
}

// ----------------------------------------------------------------------
// データ収集への接続（手順 8）
// ----------------------------------------------------------------------

/**
 * データギャップから、収集すべきデータ項目（指標 × 拠点 × 期間の担当・期限）を作る。
 *
 * 指標マスターに無ければ新規作成し、`metric_assignments` に担当と期限を入れる。
 * ここが「ギャップ分析 → 対応計画 → データ収集」を途切れさせないための接続点。
 */
export async function createDataCollectionItem(
  db: DbClient,
  ctx: AuthorizationContext,
  input: {
    planId: Uuid;
    metricCode: string;
    metricName: string;
    unit: string;
    unitId: Uuid;
    ownerUserId: Uuid | null;
    dueDate: string;
    requiresEvidence: boolean;
    department: string;
  },
): Promise<{ metricCode: string }> {
  assertCan(ctx, 'enterprise.disclosure.write');
  assertCan(ctx, 'enterprise.metric.manage');

  const organizationId = ctx.workspace.organizationId;
  const plan = await db.findById('ssbjActionPlans', input.planId);
  if (!plan || plan.organizationId !== organizationId) {
    throw new NotFoundError('対応計画が見つかりません。');
  }
  if (input.metricCode.trim() === '' || input.metricName.trim() === '') {
    throw new ValidationError('データ項目のコードと名称を入力してください。');
  }

  const code = input.metricCode.trim();
  const existing = await db.select('metrics', { where: { organizationId, code }, limit: 1 });
  const now = new Date().toISOString();

  let metricId = existing[0]?.id ?? null;
  if (!metricId) {
    metricId = fid('metric_definition', `${organizationId}/${code}`);
    await db.insert('metrics', [
      {
        id: metricId,
        organizationId,
        code,
        name: input.metricName.trim(),
        description: `SSBJ 対応計画「${plan.title}」から作成したデータ項目`,
        category: 'ghg',
        unit: input.unit.trim() || '—',
        baseUnit: input.unit.trim() || '—',
        dataType: 'number',
        aggregationMethod: 'sum',
        numeratorMetricCode: null,
        denominatorMetricCode: null,
        formula: null,
        requiresEvidence: input.requiresEvidence,
        hqOnly: false,
        // SSBJ の対応計画から作られた指標なので、出所は SSBJ
        frameworks: ['ssbj'],
        materiality: 'high',
        reportingFrequency: 'annual',
        responsibleDepartment: input.department.trim() || null,
        yoyWarningRatio: null,
        minValue: null,
        maxValue: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    ]);
  } else {
    // 指標マスターは SSBJ・CDP・CSRD の要求から作ってあるため、SSBJ の対応計画で
    // 集めようとする指標は既に定義済みのことが多い。同じコードで作り直すと
    // 重複してしまうので、既存の定義を使い、まだ埋まっていない運用項目だけ補う。
    const current = existing[0]!;
    const patch: Partial<typeof current> = {};
    // 担当部署は、対応計画で人が明示的に指定したものを優先する。
    // マスター側の値はカテゴリーからの初期値でしかなく、実際に誰が集めるかは
    // 計画を立てた人のほうが分かっている（例: Scope3 の輸送は物流部）
    const department = input.department.trim();
    if (department !== '' && department !== current.responsibleDepartment) {
      patch.responsibleDepartment = department;
    }
    // 根拠資料が要ると計画側で判断したなら、それを弱めない
    if (input.requiresEvidence && !current.requiresEvidence) patch.requiresEvidence = true;
    if (Object.keys(patch).length > 0) {
      await db.update('metrics', metricId!, { ...patch, updatedAt: now, updatedBy: ctx.userId });
    }
  }

  // 同じ指標 × 拠点 × 期間の割当が既にあれば作り直さない
  const assignments = await db.select('metricAssignments', {
    where: {
      organizationId,
      metricId,
      unitId: input.unitId,
      reportingPeriodId: plan.reportingPeriodId,
    },
    limit: 1,
  });
  if (assignments.length === 0) {
    await db.insert('metricAssignments', [
      {
        id: fid('metric_assignment', `${metricId}/${input.unitId}/${plan.reportingPeriodId}`),
        organizationId,
        metricId,
        unitId: input.unitId,
        reportingPeriodId: plan.reportingPeriodId,
        ownerUserId: input.ownerUserId,
        reviewerUserId: null,
        dueDate: input.dueDate,
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    ]);
  }

  await db.update('ssbjActionPlans', input.planId, {
    linkedMetricCode: code,
    status: plan.status === 'not_started' ? 'in_progress' : plan.status,
    updatedAt: now,
    updatedBy: ctx.userId,
  });

  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'metric_assignment',
    resourceId: metricId,
    afterSummary: `データ収集項目を作成: ${input.metricName}（${code}）`,
    metadata: { planId: input.planId, dueDate: input.dueDate },
  });

  return { metricCode: code };
}

export interface DataCollectionRow {
  plan: SsbjActionPlan;
  metricCode: string;
  metricName: string;
  unitName: string;
  unit: string;
  ownerName: string | null;
  dueDate: string | null;
  daysLeft: number | null;
  /** 収集済みの値（承認済みのみ） */
  collectedValue: number | null;
  collectedStatus: string | null;
  /** 台帳のデータ。承認の進み具合と履歴を辿る先。まだ入力が無ければ null */
  dataPointId: string | null;
}

/** データ収集管理画面のための一覧 */
export async function loadDataCollection(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
): Promise<DataCollectionRow[]> {
  const organizationId = ctx.workspace.organizationId;
  const plans = (
    await db.select('ssbjActionPlans', { where: { organizationId, reportingPeriodId: period.id } })
  ).filter((p) => p.linkedMetricCode !== null);
  if (plans.length === 0) return [];

  const metrics = await db.select('metrics', {
    where: { organizationId, deletedAt: { isNull: true } },
  });
  const metricByCode = new Map(metrics.map((m) => [m.code, m]));
  const units = await db.select('units', {
    where: { organizationId, deletedAt: { isNull: true } },
  });
  const unitById = new Map(units.map((u) => [u.id, u]));
  const assignments = await db.select('metricAssignments', {
    where: { organizationId, reportingPeriodId: period.id },
  });
  const dataPoints = await db.select('dataPoints', {
    where: { organizationId, reportingPeriodId: period.id, deletedAt: { isNull: true } },
  });
  const profiles = await db.select('profiles', {});
  const nameById = new Map(profiles.map((p) => [p.id, p.displayName]));

  const rows: DataCollectionRow[] = [];
  for (const plan of plans) {
    const metric = plan.linkedMetricCode ? metricByCode.get(plan.linkedMetricCode) : undefined;
    if (!metric) continue;
    const related = assignments.filter((a) => a.metricId === metric.id);
    for (const assignment of related) {
      const dp = dataPoints.find((d) => d.metricId === metric.id && d.unitId === assignment.unitId);
      rows.push({
        plan,
        metricCode: metric.code,
        metricName: metric.name,
        unitName: unitById.get(assignment.unitId)?.name ?? '—',
        unit: metric.unit,
        ownerName: assignment.ownerUserId ? (nameById.get(assignment.ownerUserId) ?? null) : null,
        dueDate: assignment.dueDate,
        daysLeft: assignment.dueDate ? daysUntilJst(assignment.dueDate, FIXTURE_TODAY) : null,
        collectedValue: dp?.value ?? null,
        collectedStatus: dp?.status ?? null,
        dataPointId: dp?.id ?? null,
      });
    }
  }
  return rows;
}

// ----------------------------------------------------------------------
// 前年度からの引き継ぎ（手順 1 の補助）
// ----------------------------------------------------------------------

export interface CarryOverResult {
  copied: number;
  recheck: number;
}

/**
 * 前年度の評価を今年度へ引き継ぐ。
 *
 * そのまま複製するのではなく、「今年度に再評価が必要な要求事項」に理由を付ける。
 * SSBJ 基準の改正で追加された項目や、前年に未対応だった項目は再評価が要る。
 */
export async function carryOverSsbjAssessments(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  previousPeriod: ReportingPeriod,
): Promise<CarryOverResult> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const organizationId = ctx.workspace.organizationId;

  const master = await loadSsbjItems(db, organizationId, period.id);
  if (!master) return { copied: 0, recheck: 0 };

  const previous = await db.select('ssbjAssessments', {
    where: { organizationId, reportingPeriodId: previousPeriod.id },
  });
  if (previous.length === 0) return { copied: 0, recheck: 0 };

  const current = await ensureAssessments(db, ctx, period, master.items);
  const previousByItem = new Map(previous.map((a) => [a.itemId, a]));
  const itemById = new Map(master.items.map((i) => [i.id, i]));

  let copied = 0;
  let recheck = 0;
  const now = new Date().toISOString();

  for (const assessment of current) {
    const prev = previousByItem.get(assessment.itemId);
    if (!prev) continue;
    // 既に今年度の確認が済んでいるものは触らない
    if (assessment.finalStatus !== null) continue;

    const item = itemById.get(assessment.itemId);
    const reasons: string[] = [];
    if (item?.changeType === 'new') reasons.push('SSBJ 基準の改正で追加された要求事項です。');
    if (item?.changeType === 'changed') reasons.push('SSBJ 基準の改正で内容が変更されています。');
    if (prev.finalStatus !== 'covered') reasons.push('前年度に対応が完了していません。');
    if (prev.materiality === 'not_assessed') reasons.push('前年度に重要性が判定されていません。');

    await db.update('ssbjAssessments', assessment.id, {
      applicability: prev.applicability,
      applicabilityReason: prev.applicabilityReason,
      materiality: prev.materiality,
      materialityReason: prev.materialityReason,
      disclosureStatus: prev.disclosureStatus,
      dataStatus: prev.dataStatus,
      processStatus: prev.processStatus,
      ownerDepartment: prev.ownerDepartment,
      ownerUserId: prev.ownerUserId,
      carriedOverFrom: prev.id,
      recheckReason: reasons.join(' '),
      // 引き継いだ内容は「前年度の判断」であって今年度の最終判定ではない
      finalStatus: null,
      reviewDecision: null,
      reviewedBy: null,
      reviewedAt: null,
      updatedAt: now,
      updatedBy: ctx.userId,
    });
    copied += 1;
    if (reasons.length > 0) recheck += 1;
  }

  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'ssbj_assessment',
    resourceId: null,
    afterSummary: `前年度評価を引き継ぎ: ${copied} 件（うち再評価が必要 ${recheck} 件）`,
    metadata: { fromPeriod: previousPeriod.code, toPeriod: period.code },
  });

  return { copied, recheck };
}
