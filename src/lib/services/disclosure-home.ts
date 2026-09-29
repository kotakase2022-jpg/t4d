import 'server-only';

import { can } from '@/lib/authorization/can';
import {
  APPLICABILITY_STATUS_LABELS,
  DISCLOSURE_PROJECT_STATUS_LABELS,
  DISCLOSURE_PURPOSE_LABELS,
  FRAMEWORK_COVERAGE_STATUS_LABELS,
  FRAMEWORK_LEGAL_STATUS_LABELS,
  canCompleteReview,
  canFinalApprove,
  evaluateBlockBlockers,
  hasUnresolvedRequiredInfo,
  isChangedAfterApproval,
  type BlockBlocker,
} from '@/lib/domain/disclosure-status';
import { isOldRefKept } from '@/lib/domain/disclosure-block';
import { unresolvedNarrativeFields } from '@/lib/domain/narrative-template';
import { daysUntilJst } from '@/lib/format/datetime';
import type { DbClient, Query, Row, TableName } from '@/lib/repositories/types';
import type { ManuscriptFilter } from '@/lib/services/disclosure-block';
import {
  buildRequirementRows,
  getProject,
  isRequirementApproved,
  summarizeRequirements,
  type RequirementRow,
} from '@/lib/services/disclosure-project';
import type {
  ApplicabilityStatus,
  AuthorizationContext,
  BlockBody,
  DisclosureBlock,
  DisclosureBlockVersion,
  DisclosureFrameworkVersion,
  DisclosureProject,
  DisclosureProjectStatus,
  DisclosurePurpose,
  IsoDate,
  NarrativeRecord,
  NarrativeVersion,
  ProjectFramework,
  ReportingPeriod,
  ReviewEvent,
  ReviewRequest,
  Uuid,
} from '@/types/domain';

/**
 * 開示ホーム（指示書 §6.1・docs/disclosure-first.md §6）。
 *
 * 「自分が次に何をすればよいか」を不足理由とともに出す。集計はすべてここで行い、
 * 画面（/enterprise/dashboard の「開示業務」タブ）は表示だけを担う。
 *
 * 数え方の約束（画面にも同じ説明を出す）:
 *  - 進捗は必ず分母を併記する。「適用確定済み N 項目中、承認済み M 項目」と「適用未判定 K 件」を分け、
 *    率（準拠率など）にはまとめない。未判定の基準を分母から黙って外さない（A21）
 *  - 「承認後に変更が発生」は承認済みの版が引用した数値・定性情報に新しい版ができた節と、
 *    承認後に修正を始めた節。承認済みの版そのものは変えない（A25）
 *  - 期限の判定は業務上の今日（src/lib/clock.ts）。呼び出し側から受け取り、テストで固定できるようにする
 */

// ----------------------------------------------------------------------
// 画面へのリンク（プロジェクト詳細のタブは ?tab=、原稿一覧の絞り込みは &filter=）
// ----------------------------------------------------------------------

export const PROJECT_TABS = {
  overview: 'overview',
  requirements: 'requirements',
  manuscripts: 'manuscripts',
  reviews: 'reviews',
  outputs: 'outputs',
  settings: 'settings',
} as const;

/**
 * 原稿タブの絞り込み（原稿一覧 listProjectBlocks の値。型で一致を強制する）。
 * カードの遷移先は、カードと同じ判定で絞る unresolved / changed_after_approval を使う
 * （本文なし・再確認が必要の絞り込みは件数の母集団がカードと違う）。
 */
export const MANUSCRIPT_FILTERS = {
  missing: 'missing',
  unresolved: 'unresolved',
  review: 'review',
  returned: 'returned',
  recheck: 'recheck',
  changedAfterApproval: 'changed_after_approval',
  mine: 'mine',
} as const satisfies Record<string, ManuscriptFilter>;

export function projectHref(projectId: Uuid, params: Record<string, string> = {}): string {
  const query = new URLSearchParams(params).toString();
  return `/enterprise/disclosure-projects/${projectId}${query ? `?${query}` : ''}`;
}

export function blockHref(projectId: Uuid, blockId: Uuid): string {
  return `/enterprise/disclosure-projects/${projectId}/blocks/${blockId}`;
}

// ----------------------------------------------------------------------
// ヘッダー（プロジェクト名・対象範囲）
// ----------------------------------------------------------------------

export interface HeaderProjectSummary {
  id: Uuid;
  name: string;
  reportingEntity: string;
  scopeOrgNote: string;
  scopeConsolidationNote: string;
  scopeGhgBoundaryNote: string;
  scopeValueChainNote: string;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  reportingPeriodId: Uuid;
}

/**
 * ヘッダーに出すためのプロジェクト一覧（名前・対象範囲・期間だけ）。
 * 開示の閲覧権限が無い利用者（拠点担当など）には出さない。
 */
export async function loadHeaderProjects(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<HeaderProjectSummary[]> {
  if (ctx.workspace.organizationType !== 'enterprise') return [];
  if (!can(ctx, 'enterprise.disclosure.read')) return [];
  const projects = await db.select('disclosureProjects', {
    where: { organizationId: ctx.workspace.organizationId, deletedAt: { isNull: true } },
  });
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    reportingEntity: p.reportingEntity,
    scopeOrgNote: p.scopeOrgNote,
    scopeConsolidationNote: p.scopeConsolidationNote,
    scopeGhgBoundaryNote: p.scopeGhgBoundaryNote,
    scopeValueChainNote: p.scopeValueChainNote,
    periodStart: p.periodStart,
    periodEnd: p.periodEnd,
    reportingPeriodId: p.reportingPeriodId,
  }));
}

// ----------------------------------------------------------------------
// 型
// ----------------------------------------------------------------------

export interface HomeProject {
  id: Uuid;
  name: string;
  status: DisclosureProjectStatus;
  statusLabel: string;
  reportingEntity: string;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  dueDate: IsoDate | null;
  daysUntilDue: number | null;
  purposes: DisclosurePurpose[];
  purposeLabels: string[];
  href: string;
}

export const MY_TASK_KINDS = [
  'returned',
  'final_approval',
  'review',
  'recheck',
  'missing_info',
  'ready_for_review',
] as const;
export type MyTaskKind = (typeof MY_TASK_KINDS)[number];

/** 「自分が次に行う作業」の 1 行（項目名・対象基準・担当・期限・阻害理由・CTA） */
export interface MyTaskRow {
  key: string;
  kind: MyTaskKind;
  blockId: Uuid;
  itemName: string;
  frameworkLabel: string;
  /** 草案・サンプル・適用判断が未確定などの注記。無ければ null */
  frameworkNote: string | null;
  /** 節の作成担当 */
  ownerName: string;
  dueDate: IsoDate | null;
  daysUntilDue: number | null;
  /** 阻害理由（不足・差戻し理由・職務分離など）。無ければ null */
  blockerReason: string | null;
  cta: { label: string; href: string };
}

export interface HomeCard {
  count: number;
  href: string;
}

export interface HomeCards {
  /** 本文・引用した定性情報の必須項目・要対応コメント・適用判断に不足がある（未承認の）原稿 */
  unresolvedRequired: HomeCard;
  /** レビュー待ち（第 1 段）と最終承認待ちの依頼 */
  reviewPending: HomeCard & { reviewStage: number; finalStage: number };
  /** 承認済みの版の引用先に新しい版がある・承認後に修正を始めた原稿 */
  changedAfterApproval: HomeCard;
  /** 次の提出期限（未承認の原稿の期限とプロジェクトの期限のうち最も早いもの） */
  nextDeadline: {
    date: IsoDate;
    daysUntil: number | null;
    label: string;
    href: string;
  } | null;
}

export interface FrameworkProgressRow {
  projectFrameworkId: Uuid;
  frameworkVersionId: Uuid;
  label: string;
  /** 草案・サンプルなど法的な位置付け（null は未確認） */
  legalStatusLabel: string | null;
  coverageStatusLabel: string | null;
  applicabilityStatus: ApplicabilityStatus;
  applicabilityLabel: string;
  /** 適用判断が確定しているか（判断の記録があり、候補・確認待ち・未判定ではない） */
  decided: boolean;
  decidedOn: IsoDate | null;
  /** 適用すると確定した（適用・任意適用） */
  inScope: boolean;
  /** 対象外と確定した */
  excluded: boolean;
  /** 収録している要求事項の数（未収録の基準は 0） */
  itemCount: number;
  /** 要求事項ごとの判断で「適用（重要）」と確定した数（分母）。適用すると判断した基準だけ */
  confirmedItemCount: number;
  /** 要求事項ごとに対象外・非重要と判断した数（理由・判断者あり。分母に含めない） */
  excludedItemCount: number;
  /** 要求事項ごとの判断が未判定の数（分母に含めず別に示す） */
  notAssessedItemCount: number;
  /** 適用（重要）のうち、原稿の節に割り当てた数 */
  assignedItemCount: number;
  approvedItemCount: number;
  /** 承認済みだが引用先に新しい版があり、再確認が必要な要求事項 */
  staleApprovedItemCount: number;
  blockCount: number;
}

export interface HomeProgress {
  /**
   * 分母: 適用すると判断した基準の要求事項のうち、要求事項ごとの判断で「適用（重要）」と確定したもの
   * （プロジェクトの概要・要求事項タブの「適用確定済み」と同じ数）
   */
  confirmedItemCount: number;
  /** 分子: そのうち、割り当てた原稿の節がすべて承認済みの要求事項 */
  approvedItemCount: number;
  staleApprovedItemCount: number;
  assignedItemCount: number;
  /** 要求事項ごとに対象外・非重要と判断したもの（分母に含めず別に示す） */
  excludedItemCount: number;
  /** 要求事項ごとの判断が未判定のもの（分母に含めず別に示す） */
  notAssessedItemCount: number;
  /** 適用判断が確定していない基準の数（別枠で示す。分母から黙って外さない） */
  notAssessedCount: number;
  excludedFrameworkCount: number;
  rows: FrameworkProgressRow[];
}

export interface UnitSubmissionRow {
  unitId: Uuid;
  unitName: string;
  unitCode: string;
  notSubmitted: number;
  total: number;
  href: string;
}

export interface DisclosureHome {
  /** 開示の閲覧権限（enterprise.disclosure.read）。無ければ開示の集計は出さない */
  canRead: boolean;
  project: HomeProject | null;
  /** 同じ組織の他のプロジェクト数（一覧への導線に使う） */
  otherProjectCount: number;
  cards: HomeCards | null;
  /** 最大 5 件 */
  myTasks: MyTaskRow[];
  myTaskTotal: number;
  progress: HomeProgress | null;
  /** 拠点の未提出（補助表示）。未提出がある拠点だけ */
  unitSubmissions: UnitSubmissionRow[];
}

export interface DisclosureHomeInput {
  period: ReportingPeriod;
  /** 業務上の今日（src/lib/clock.ts の businessToday） */
  today: IsoDate;
  /** ?project= で明示されたプロジェクト。同じ組織のものだけ使う */
  projectId?: string | null;
}

export const MY_TASK_LIMIT = 5;

// ----------------------------------------------------------------------
// 補助
// ----------------------------------------------------------------------

/** 空の in 条件で問い合わせない（PostgREST の in.() を避ける） */
async function selectByIds<K extends TableName>(
  db: DbClient,
  table: K,
  ids: Iterable<string>,
  /**
   * 組織を持つ表では必ず渡す。本文の参照 ID は利用者が送った値のため、他社の行を引いて
   * 指標名・定性情報の題名を表示しないようにする（A29。Supabase は RLS でも隠れるが Demo は隠れない）
   */
  organizationId?: string,
): Promise<Row<K>[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  // 対象の表はすべて id 列を持つ（Row<K> が総称のままでは id を型で確かめられないため変換する）
  const query: Query<{ id: string; organizationId?: string }> = {
    where: organizationId ? { id: { in: unique }, organizationId } : { id: { in: unique } },
  };
  return db.select(table, query as unknown as Query<Row<K>>);
}

const PROJECT_STATUS_ORDER: Record<DisclosureProjectStatus, number> = {
  active: 0,
  preparing: 1,
  closed: 2,
};

/**
 * 選択中の報告期間のプロジェクトを 1 つ選ぶ（進行中 → 準備中 → 完了、期限が近い順）。
 * 別年度のプロジェクトへは黙って移らない（A02: 対象期間を一致させる）。
 */
export function pickCurrentProject(
  projects: readonly DisclosureProject[],
  periodId: Uuid,
  requestedId?: string | null,
): DisclosureProject | null {
  if (requestedId) {
    const requested = projects.find((p) => p.id === requestedId && p.deletedAt === null);
    if (requested) return requested;
  }
  const candidates = projects
    .filter((p) => p.reportingPeriodId === periodId && p.deletedAt === null)
    .sort(
      (a, b) =>
        PROJECT_STATUS_ORDER[a.status] - PROJECT_STATUS_ORDER[b.status] ||
        (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31') ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  return candidates[0] ?? null;
}

const UNDECIDED_STATUSES: readonly ApplicabilityStatus[] = [
  'not_assessed',
  'candidate',
  'awaiting_confirmation',
];

export function isApplicabilityDecided(
  pf: Pick<ProjectFramework, 'currentDecisionId' | 'applicabilityStatus'>,
): boolean {
  return pf.currentDecisionId !== null && !UNDECIDED_STATUSES.includes(pf.applicabilityStatus);
}

/**
 * 引用した定性情報の未記入項目。原稿一覧（disclosure-block.ts）と同じ数え方にするため、
 * 定義は domain/narrative-template.ts に置き、ここでは再公開だけする。
 */
export { unresolvedNarrativeFields };

function metricNodes(
  body: BlockBody | null,
): Array<{ dataPointId: Uuid; dataPointVersionId: Uuid }> {
  if (!body) return [];
  const out: Array<{ dataPointId: Uuid; dataPointVersionId: Uuid }> = [];
  for (const paragraph of body.paragraphs) {
    for (const inline of paragraph.children) {
      if (inline.t === 'metric') {
        out.push({
          dataPointId: inline.dataPointId,
          dataPointVersionId: inline.dataPointVersionId,
        });
      }
    }
  }
  return out;
}

function narrativeVersionIdsOf(body: BlockBody | null): Uuid[] {
  if (!body) return [];
  const ids = new Set<Uuid>();
  for (const paragraph of body.paragraphs) {
    for (const inline of paragraph.children) {
      if (inline.t === 'narrative') ids.add(inline.narrativeVersionId);
    }
  }
  return [...ids];
}

interface BlockEvaluation {
  block: DisclosureBlock;
  framework: ProjectFramework | null;
  frameworkLabel: string;
  frameworkNote: string | null;
  /** 現在の本文（自動保存があればそれ、無ければ現在の版） */
  body: BlockBody | null;
  /** 現在の版を指しているのに版の行が読めない（デモの別インスタンスなど） */
  versionMissing: boolean;
  /** 現在の本文に対する阻害条件（evaluateBlockBlockers） */
  blockers: BlockBlocker[];
  /** 引用した定性情報の未記入項目 */
  missingNarratives: Array<{ title: string; fields: string[] }>;
  /** 承認済みの版が引用した数値・定性情報に新しい版がある */
  approvedStaleMessage: string | null;
  /** 承認後に修正を始めた（現在の版が承認済みの版と違う） */
  revisedAfterApproval: boolean;
}

function hasMissingInfo(e: BlockEvaluation): boolean {
  // 原稿一覧の「未解決の必須情報」と同じ判定（domain/disclosure-status.ts）
  return hasUnresolvedRequiredInfo({
    status: e.block.status,
    versionMissing: e.versionMissing,
    narrativeGapCount: e.missingNarratives.length,
    blockers: e.blockers,
  });
}

function missingInfoMessage(e: BlockEvaluation): string | null {
  if (e.versionMissing) {
    return '保存済みの版を読み込めませんでした（デモ環境の制約）。原稿を開き直してください。';
  }
  const hard = e.blockers.find((b) => b.code !== 'stale_metric_refs');
  if (hard) return hard.message;
  const first = e.missingNarratives[0];
  if (!first) return null;
  const rest = e.missingNarratives.length - 1;
  return (
    `引用した定性情報に未記入の項目があります: 「${first.title}」の${first.fields.join('・')}` +
    (rest > 0 ? ` ほか ${rest} 件` : '')
  );
}

function compareTasks(a: MyTaskRow, b: MyTaskRow): number {
  return (
    MY_TASK_KINDS.indexOf(a.kind) - MY_TASK_KINDS.indexOf(b.kind) ||
    (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31') ||
    a.itemName.localeCompare(b.itemName, 'ja')
  );
}

// ----------------------------------------------------------------------
// 本体
// ----------------------------------------------------------------------

export async function loadDisclosureHome(
  db: DbClient,
  ctx: AuthorizationContext,
  input: DisclosureHomeInput,
): Promise<DisclosureHome> {
  const organizationId = ctx.workspace.organizationId;
  const unitSubmissions = can(ctx, 'enterprise.data.read')
    ? await loadUnitSubmissions(db, ctx, input.period)
    : [];

  const empty: DisclosureHome = {
    canRead: false,
    project: null,
    otherProjectCount: 0,
    cards: null,
    myTasks: [],
    myTaskTotal: 0,
    progress: null,
    unitSubmissions,
  };
  if (ctx.workspace.organizationType !== 'enterprise') return empty;
  if (!can(ctx, 'enterprise.disclosure.read')) return empty;

  const projects = await db.select('disclosureProjects', {
    where: { organizationId, deletedAt: { isNull: true } },
  });
  const current = pickCurrentProject(projects, input.period.id, input.projectId);
  if (!current) {
    return { ...empty, canRead: true, otherProjectCount: projects.length };
  }

  const [blocks, projectFrameworks, requests] = await Promise.all([
    db.select('disclosureBlocks', {
      where: { organizationId, projectId: current.id, deletedAt: { isNull: true } },
      orderBy: { column: 'sortOrder' },
    }),
    db.select('projectFrameworks', { where: { organizationId, projectId: current.id } }),
    db.select('reviewRequests', { where: { organizationId, projectId: current.id } }),
  ]);

  const frameworkVersionIds = new Set([
    ...projectFrameworks.map((pf) => pf.frameworkVersionId),
    ...blocks.map((b) => b.frameworkVersionId),
  ]);
  const versionIds = new Set<Uuid>();
  for (const b of blocks) {
    if (b.currentVersionId) versionIds.add(b.currentVersionId);
    if (b.approvedVersionId) versionIds.add(b.approvedVersionId);
  }
  for (const r of requests) versionIds.add(r.targetVersionId);

  const [frameworkVersions, decisions, blockVersions, events, comments, itemCounts, rechecks] =
    await Promise.all([
      selectByIds(db, 'frameworkVersions', frameworkVersionIds),
      selectByIds(
        db,
        'projectFrameworkDecisions',
        projectFrameworks.flatMap((pf) => (pf.currentDecisionId ? [pf.currentDecisionId] : [])),
        organizationId,
      ),
      selectByIds(db, 'disclosureBlockVersions', versionIds, organizationId),
      requests.length === 0
        ? Promise.resolve([] as ReviewEvent[])
        : db.select('reviewEvents', {
            where: { organizationId, reviewRequestId: { in: requests.map((r) => r.id) } },
            orderBy: { column: 'createdAt' },
          }),
      blocks.length === 0
        ? Promise.resolve([])
        : db.select('reviewComments', {
            where: { organizationId, blockId: { in: blocks.map((b) => b.id) } },
          }),
      Promise.all(
        [...frameworkVersionIds].map(
          async (id) =>
            [id, await db.count('disclosureItems', { where: { frameworkVersionId: id } })] as const,
        ),
      ),
      blocks.length === 0
        ? Promise.resolve([])
        : db.select('recheckDecisions', {
            where: { organizationId, blockId: { in: blocks.map((b) => b.id) } },
          }),
    ]);

  const versionById = new Map<Uuid, DisclosureBlockVersion>(blockVersions.map((v) => [v.id, v]));
  const frameworkVersionById = new Map<Uuid, DisclosureFrameworkVersion>(
    frameworkVersions.map((v) => [v.id, v]),
  );
  const itemCountByVersion = new Map<Uuid, number>(itemCounts);
  const pfByVersion = new Map<Uuid, ProjectFramework>(
    projectFrameworks.map((pf) => [pf.frameworkVersionId, pf]),
  );

  // 本文（現在の本文と承認済みの版）が引用した数値・定性情報の現在の版
  const bodyOf = (b: DisclosureBlock): BlockBody | null =>
    b.workingBody ??
    (b.currentVersionId ? (versionById.get(b.currentVersionId)?.body ?? null) : null);
  const approvedBodyOf = (b: DisclosureBlock): BlockBody | null =>
    b.approvedVersionId ? (versionById.get(b.approvedVersionId)?.body ?? null) : null;

  const allMetricNodes = blocks.flatMap((b) => [
    ...metricNodes(bodyOf(b)),
    ...metricNodes(approvedBodyOf(b)),
  ]);
  const allNarrativeVersionIds = blocks.flatMap((b) => [
    ...narrativeVersionIdsOf(bodyOf(b)),
    ...narrativeVersionIdsOf(approvedBodyOf(b)),
  ]);

  const [dataPoints, narrativeVersions] = await Promise.all([
    selectByIds(
      db,
      'dataPoints',
      allMetricNodes.map((n) => n.dataPointId),
      organizationId,
    ),
    selectByIds(db, 'narrativeVersions', allNarrativeVersionIds, organizationId),
  ]);
  const [metrics, narrativeRecords] = await Promise.all([
    selectByIds(
      db,
      'metrics',
      dataPoints.map((d) => d.metricId),
      organizationId,
    ),
    selectByIds(
      db,
      'narrativeRecords',
      narrativeVersions.map((v) => v.narrativeRecordId),
      organizationId,
    ),
  ]);
  const dataPointById = new Map(dataPoints.map((d) => [d.id, d]));
  const metricNameById = new Map(metrics.map((m) => [m.id, m.name]));
  const narrativeVersionById = new Map<Uuid, NarrativeVersion>(
    narrativeVersions.map((v) => [v.id, v]),
  );
  const narrativeRecordById = new Map<Uuid, NarrativeRecord>(
    narrativeRecords.map((r) => [r.id, r]),
  );

  const frameworkLabelOf = (versionId: Uuid): string =>
    frameworkVersionById.get(versionId)?.label ?? '（基準の版が見つかりません）';

  const frameworkNoteOf = (versionId: Uuid, pf: ProjectFramework | null): string | null => {
    const notes: string[] = [];
    const version = frameworkVersionById.get(versionId);
    // 草案・サンプルを正式な基準と見誤らせない（A22・§14.3）
    if (version?.legalStatus === 'draft') notes.push('公開草案に基づく準備');
    if (version?.legalStatus === 'sample') notes.push('サンプル（架空）');
    if (!pf) notes.push('プロジェクトに登録されていない基準');
    else if (!isApplicabilityDecided(pf)) {
      notes.push(`適用判断が未確定（${APPLICABILITY_STATUS_LABELS[pf.applicabilityStatus]}）`);
    }
    return notes.length > 0 ? notes.join('・') : null;
  };

  // 理由付きで「引用中の版を維持」と判断した組み合わせは再確認済み。原稿画面・レポートの確定と
  // 同じ規則（domain/disclosure-block.ts の isOldRefKept）で判定し、ホームだけが古いと言い続けない
  const keptOld = (
    blockId: Uuid,
    refKind: 'metric' | 'narrative',
    oldRefId: Uuid,
    newRefId: Uuid,
  ): boolean => isOldRefKept(rechecks, { blockId, refKind, oldRefId, newRefId });
  /** 数値の現在の版。維持と判断済みなら引用中の版を現在の版として扱う */
  const effectiveMetricVersionOf = (
    blockId: Uuid,
    n: { dataPointId: Uuid; dataPointVersionId: Uuid },
  ): Uuid | null => {
    const current = dataPointById.get(n.dataPointId)?.currentVersionId ?? null;
    if (current === null || current === n.dataPointVersionId) return current;
    return keptOld(blockId, 'metric', n.dataPointVersionId, current)
      ? n.dataPointVersionId
      : current;
  };

  const staleMessageOf = (body: BlockBody | null, blockId: Uuid): string | null => {
    const staleMetrics = metricNodes(body).filter((n) => {
      const current = effectiveMetricVersionOf(blockId, n);
      return current !== null && current !== n.dataPointVersionId;
    });
    const staleNarratives = narrativeVersionIdsOf(body).filter((id) => {
      const version = narrativeVersionById.get(id);
      const record = version ? narrativeRecordById.get(version.narrativeRecordId) : undefined;
      return (
        record?.currentVersionId != null &&
        record.currentVersionId !== id &&
        !keptOld(blockId, 'narrative', id, record.currentVersionId)
      );
    });
    if (staleMetrics.length === 0 && staleNarratives.length === 0) return null;
    const labels = [
      ...new Set(
        staleMetrics.map((n) => {
          const dp = dataPointById.get(n.dataPointId);
          return (dp && metricNameById.get(dp.metricId)) ?? '数値';
        }),
      ),
      ...staleNarratives.map((id) => {
        const version = narrativeVersionById.get(id);
        return (version && narrativeRecordById.get(version.narrativeRecordId)?.title) ?? '定性情報';
      }),
    ];
    return `引用した${staleMetrics.length > 0 ? '数値' : ''}${
      staleMetrics.length > 0 && staleNarratives.length > 0 ? '・' : ''
    }${staleNarratives.length > 0 ? '定性情報' : ''}に新しい版があります（${labels.join('、')}）。再確認してください。`;
  };

  const evaluations: BlockEvaluation[] = blocks.map((block) => {
    const pf = pfByVersion.get(block.frameworkVersionId) ?? null;
    const body = bodyOf(block);
    const versionMissing =
      block.workingBody === null &&
      block.currentVersionId !== null &&
      !versionById.has(block.currentVersionId);
    const blockers = evaluateBlockBlockers({
      body,
      // AI 候補の未採用件数は原稿画面（S-d）が持つ。ホームでは数えない（0 として扱う）
      pendingAiCandidateCount: 0,
      comments: comments.filter((c) => c.blockId === block.id),
      metricRefs: metricNodes(body).map((n) => {
        const dp = dataPointById.get(n.dataPointId);
        return {
          dataPointId: n.dataPointId,
          dataPointVersionId: n.dataPointVersionId,
          currentVersionId: effectiveMetricVersionOf(block.id, n),
          label: dp ? metricNameById.get(dp.metricId) : undefined,
        };
      }),
      // 節が属する基準の適用区分だけを見る（別の基準の未判定で、この節を止めない）
      frameworks: [
        {
          frameworkVersionId: block.frameworkVersionId,
          label: frameworkLabelOf(block.frameworkVersionId),
          applicabilityStatus: pf?.applicabilityStatus ?? 'not_assessed',
        },
      ],
    });
    // 版が読めないだけのときに「本文がありません」と誤って伝えない
    const effectiveBlockers = versionMissing
      ? blockers.filter((b) => b.code !== 'no_body')
      : blockers;

    const missingNarratives = narrativeVersionIdsOf(body).flatMap((id) => {
      const version = narrativeVersionById.get(id);
      const record = version ? narrativeRecordById.get(version.narrativeRecordId) : undefined;
      if (!version || !record) return [];
      const fields = unresolvedNarrativeFields(record.theme, version.fields);
      return fields.length > 0 ? [{ title: record.title, fields }] : [];
    });

    return {
      block,
      framework: pf,
      frameworkLabel: frameworkLabelOf(block.frameworkVersionId),
      frameworkNote: frameworkNoteOf(block.frameworkVersionId, pf),
      body,
      versionMissing,
      blockers: effectiveBlockers,
      missingNarratives,
      approvedStaleMessage:
        block.approvedVersionId !== null ? staleMessageOf(approvedBodyOf(block), block.id) : null,
      revisedAfterApproval:
        block.approvedVersionId !== null && block.currentVersionId !== block.approvedVersionId,
    };
  });

  // ---- カード -------------------------------------------------------------
  const openRequests = requests.filter((r) => r.status === 'open');
  const reviewedRequests = requests.filter((r) => r.status === 'reviewed');
  // 原稿一覧の「承認後に変更が発生」と同じ判定（domain/disclosure-status.ts）
  const changedAfterApproval = evaluations.filter((e) =>
    isChangedAfterApproval({
      approvedVersionId: e.block.approvedVersionId,
      currentVersionId: e.block.currentVersionId,
      approvedVersionHasStaleRefs: e.approvedStaleMessage !== null,
    }),
  );

  const deadlineCandidates: Array<{ date: IsoDate; label: string; href: string }> = [
    ...blocks
      .filter((b) => b.status !== 'approved' && b.dueDate)
      .map((b) => ({
        date: b.dueDate as IsoDate,
        label: b.title,
        href: blockHref(current.id, b.id),
      })),
    ...(current.dueDate
      ? [
          {
            date: current.dueDate,
            label: 'プロジェクトの提出期限',
            href: projectHref(current.id, { tab: PROJECT_TABS.overview }),
          },
        ]
      : []),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const next = deadlineCandidates[0];

  const cards: HomeCards = {
    unresolvedRequired: {
      count: evaluations.filter(hasMissingInfo).length,
      href: projectHref(current.id, {
        tab: PROJECT_TABS.manuscripts,
        filter: MANUSCRIPT_FILTERS.unresolved,
      }),
    },
    reviewPending: {
      count: openRequests.length + reviewedRequests.length,
      reviewStage: openRequests.length,
      finalStage: reviewedRequests.length,
      href: projectHref(current.id, { tab: PROJECT_TABS.reviews }),
    },
    changedAfterApproval: {
      count: changedAfterApproval.length,
      href: projectHref(current.id, {
        tab: PROJECT_TABS.manuscripts,
        filter: MANUSCRIPT_FILTERS.changedAfterApproval,
      }),
    },
    nextDeadline: next ? { ...next, daysUntil: daysUntilJst(next.date, input.today) } : null,
  };

  // ---- 自分が次に行う作業 --------------------------------------------------
  const ownerIds = new Set<Uuid>(blocks.flatMap((b) => (b.ownerUserId ? [b.ownerUserId] : [])));
  const profiles = await selectByIds(db, 'profiles', ownerIds);
  const nameOf = (id: Uuid | null) =>
    id ? (profiles.find((p) => p.id === id)?.displayName ?? '—') : '未割当';

  const tasks: MyTaskRow[] = [];
  const evaluationByBlock = new Map(evaluations.map((e) => [e.block.id, e]));
  const eventsOf = (requestId: Uuid) => events.filter((e) => e.reviewRequestId === requestId);
  const row = (
    e: BlockEvaluation,
    kind: MyTaskKind,
    blockerReason: string | null,
    ctaLabel: string,
    key = `${kind}:${e.block.id}`,
  ): MyTaskRow => ({
    key,
    kind,
    blockId: e.block.id,
    itemName: e.block.title,
    frameworkLabel: e.frameworkLabel,
    frameworkNote: e.frameworkNote,
    ownerName: nameOf(e.block.ownerUserId),
    dueDate: e.block.dueDate,
    daysUntilDue: daysUntilJst(e.block.dueDate, input.today),
    blockerReason,
    cta: { label: ctaLabel, href: blockHref(current.id, e.block.id) },
  });

  const canWrite = can(ctx, 'enterprise.disclosure.write');
  const canApprove = can(ctx, 'enterprise.disclosure.approve');

  // (1) 自分に割り当てられたレビュー・最終承認
  for (const request of requests) {
    const e = evaluationByBlock.get(request.targetId);
    if (!e) continue;
    const authorId = versionById.get(request.targetVersionId)?.createdBy ?? null;
    if (request.status === 'open' && request.reviewerUserId === ctx.userId && canWrite) {
      const check = canCompleteReview({
        actorId: ctx.userId,
        request,
        targetVersionCreatedBy: authorId ?? '',
      });
      tasks.push(
        row(e, 'review', check.ok ? null : check.reason, 'レビューする', `review:${request.id}`),
      );
    }
    if (request.status === 'reviewed' && request.approverUserId === ctx.userId && canApprove) {
      const reviewCompletedBy = eventsOf(request.id)
        .filter((ev) => ev.eventType === 'review_completed')
        .map((ev) => ev.actorUserId);
      const check = canFinalApprove({
        actorId: ctx.userId,
        request,
        targetVersionCreatedBy: authorId ?? '',
        reviewCompletedBy,
      });
      const stale = staleMessageOf(
        versionById.get(request.targetVersionId)?.body ?? null,
        request.targetId,
      );
      tasks.push(
        row(
          e,
          'final_approval',
          check.ok ? stale : check.reason,
          '最終承認する',
          `final:${request.id}`,
        ),
      );
    }
  }

  // (2) 自分が担当する節
  if (canWrite) {
    for (const e of evaluations) {
      if (e.block.ownerUserId !== ctx.userId) continue;
      const status = e.block.status;
      if (status === 'returned') {
        const request = latestRequest(requests, e.block.id, 'returned');
        const returned = request
          ? eventsOf(request.id)
              .filter((ev) => ev.eventType === 'returned')
              .at(-1)
          : undefined;
        const reason = returned?.reason
          ? `差戻し理由: ${returned.reason}${returned.paragraphId ? `（段落 ${returned.paragraphId}）` : ''}`
          : '差し戻されました。レビューのコメントを確認してください。';
        tasks.push(row(e, 'returned', reason, '差戻しに対応'));
      } else if (status === 'approved') {
        if (e.approvedStaleMessage) {
          tasks.push(row(e, 'recheck', e.approvedStaleMessage, '再確認する'));
        }
      } else if (status === 'draft') {
        if (hasMissingInfo(e)) {
          tasks.push(row(e, 'missing_info', missingInfoMessage(e), '不足を補う'));
        } else {
          const stale = e.blockers.find((b) => b.code === 'stale_metric_refs');
          tasks.push(
            stale
              ? row(e, 'recheck', stale.message, '再確認する')
              : row(e, 'ready_for_review', null, 'レビューを依頼'),
          );
        }
      }
      // review_requested / approval_pending は他の人の番（自分の作業には出さない）
    }
  }

  tasks.sort(compareTasks);

  // ---- 進捗（分母を明示） --------------------------------------------------
  // 分母は要求事項ごとの適用判断（SSBJ 評価）で「適用（重要）」と確定したものだけ。
  // 基準単位で「適用」と判断しても、要求事項ごとに対象外・非重要・未判定があるため、
  // プロジェクトの概要・要求事項タブと同じ行（buildRequirementRows）から数える（件数を食い違わせない）
  const decisionById = new Map(decisions.map((d) => [d.id, d]));
  const detail = await getProject(db, ctx, current.id);
  const requirementRowsByPf = new Map<Uuid, RequirementRow[]>();
  for (const view of detail.frameworks) {
    const pf = view.projectFramework;
    if (!isApplicabilityDecided(pf)) continue;
    if (pf.applicabilityStatus !== 'applicable' && pf.applicabilityStatus !== 'voluntary') continue;
    requirementRowsByPf.set(pf.id, (await buildRequirementRows(db, ctx, detail, view)).rows);
  }
  const rows: FrameworkProgressRow[] = projectFrameworks
    .map((pf) => {
      const version = frameworkVersionById.get(pf.frameworkVersionId);
      const decided = isApplicabilityDecided(pf);
      const inScope =
        decided &&
        (pf.applicabilityStatus === 'applicable' || pf.applicabilityStatus === 'voluntary');
      // 翻訳の節は元の節と同じ要求事項を持つため、数えるのは元の節だけ
      const fwBlocks = evaluations.filter(
        (e) =>
          e.block.frameworkVersionId === pf.frameworkVersionId &&
          e.block.translationOfBlockId === null,
      );
      const requirementRows = requirementRowsByPf.get(pf.id) ?? [];
      const applicable = requirementRows.filter((r) => r.decision.kind === 'material');
      const summary = summarizeRequirements(requirementRows);
      let staleApproved = 0;
      for (const row of applicable.filter(isRequirementApproved)) {
        const covering = fwBlocks.filter((e) => e.block.requirementItemIds.includes(row.item.id));
        if (covering.some((e) => e.approvedStaleMessage)) staleApproved += 1;
      }
      return {
        projectFrameworkId: pf.id,
        frameworkVersionId: pf.frameworkVersionId,
        label: version?.label ?? '（基準の版が見つかりません）',
        legalStatusLabel: version?.legalStatus
          ? FRAMEWORK_LEGAL_STATUS_LABELS[version.legalStatus]
          : null,
        coverageStatusLabel: version?.coverageStatus
          ? FRAMEWORK_COVERAGE_STATUS_LABELS[version.coverageStatus]
          : null,
        applicabilityStatus: pf.applicabilityStatus,
        applicabilityLabel: APPLICABILITY_STATUS_LABELS[pf.applicabilityStatus],
        decided,
        decidedOn: pf.currentDecisionId
          ? (decisionById.get(pf.currentDecisionId)?.confirmedOn ?? null)
          : null,
        inScope,
        excluded: decided && pf.applicabilityStatus === 'not_applicable',
        itemCount: itemCountByVersion.get(pf.frameworkVersionId) ?? 0,
        confirmedItemCount: inScope ? summary.applicableConfirmed : 0,
        excludedItemCount: inScope ? summary.excludedDecided : 0,
        notAssessedItemCount: inScope ? summary.notAssessed : 0,
        assignedItemCount: inScope ? summary.assignedOfApplicable : 0,
        approvedItemCount: inScope ? summary.approvedOfApplicable : 0,
        staleApprovedItemCount: staleApproved,
        blockCount: fwBlocks.length,
      };
    })
    .sort((a, b) => Number(b.inScope) - Number(a.inScope) || a.label.localeCompare(b.label, 'ja'));

  const inScopeRows = rows.filter((r) => r.inScope);
  const progress: HomeProgress = {
    confirmedItemCount: inScopeRows.reduce((sum, r) => sum + r.confirmedItemCount, 0),
    approvedItemCount: inScopeRows.reduce((sum, r) => sum + r.approvedItemCount, 0),
    staleApprovedItemCount: inScopeRows.reduce((sum, r) => sum + r.staleApprovedItemCount, 0),
    assignedItemCount: inScopeRows.reduce((sum, r) => sum + r.assignedItemCount, 0),
    excludedItemCount: inScopeRows.reduce((sum, r) => sum + r.excludedItemCount, 0),
    notAssessedItemCount: inScopeRows.reduce((sum, r) => sum + r.notAssessedItemCount, 0),
    notAssessedCount: rows.filter((r) => !r.decided).length,
    excludedFrameworkCount: rows.filter((r) => r.excluded).length,
    rows,
  };

  return {
    canRead: true,
    project: {
      id: current.id,
      name: current.name,
      status: current.status,
      statusLabel: DISCLOSURE_PROJECT_STATUS_LABELS[current.status],
      reportingEntity: current.reportingEntity,
      periodStart: current.periodStart,
      periodEnd: current.periodEnd,
      dueDate: current.dueDate,
      daysUntilDue: daysUntilJst(current.dueDate, input.today),
      purposes: current.purposes,
      purposeLabels: current.purposes.map((p) => DISCLOSURE_PURPOSE_LABELS[p]),
      href: projectHref(current.id),
    },
    otherProjectCount: projects.length - 1,
    cards,
    myTasks: tasks.slice(0, MY_TASK_LIMIT),
    myTaskTotal: tasks.length,
    progress,
    unitSubmissions,
  };
}

function latestRequest(
  requests: readonly ReviewRequest[],
  blockId: Uuid,
  status: ReviewRequest['status'],
): ReviewRequest | undefined {
  return requests
    .filter((r) => r.targetId === blockId && r.status === status)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .at(-1);
}

// ----------------------------------------------------------------------
// 拠点の未提出（補助表示）
// ----------------------------------------------------------------------

async function loadUnitSubmissions(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
): Promise<UnitSubmissionRow[]> {
  const organizationId = ctx.workspace.organizationId;
  const scope = ctx.workspace.unitScopeIds;
  const units = (
    await db.select('units', {
      where: { organizationId, deletedAt: { isNull: true } },
      orderBy: { column: 'sortOrder' },
    })
  ).filter((u) => u.unitType !== 'supplier' && (scope.length === 0 || scope.includes(u.id)));

  const rows = await Promise.all(
    units.map(async (unit) => {
      const where = {
        organizationId,
        reportingPeriodId: period.id,
        unitId: unit.id,
        deletedAt: { isNull: true },
      } as const;
      const [total, notSubmitted] = await Promise.all([
        db.count('dataPoints', { where }),
        db.count('dataPoints', {
          where: { ...where, status: { in: ['not_started', 'draft', 'returned'] } },
        }),
      ]);
      return {
        unitId: unit.id,
        unitName: unit.name,
        unitCode: unit.code,
        notSubmitted,
        total,
        href: `/enterprise/data?unit=${unit.id}&status=not_started&status=draft&status=returned`,
      };
    }),
  );
  return rows.filter((r) => r.notSubmitted > 0).sort((a, b) => b.notSubmitted - a.notSubmitted);
}
