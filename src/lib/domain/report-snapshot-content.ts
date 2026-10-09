/**
 * レポートのスナップショットの内容（docs/disclosure-first.md §3 0038）の型・内容ハッシュ・写しの作り方。
 *
 * Service（report-snapshot.ts）がスナップショットを作るときと、Demo Mode で Cookie の控え
 * （demo-compact.ts の目録）から別のインスタンスが写しを組み立て直すときが、**同じ関数**で写しを作る。
 * 規則が 2 か所に分かれると、組み立て直した写しの内容ハッシュが作成時と食い違い、同じスナップショットを
 * 別のインスタンスでは出力できなくなる（ハッシュが違う写しは出さない。出すと別の内容を同じハッシュで配る）。
 *
 * DB にも画面にも依存しない純粋関数だけを置く。
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '@/lib/domain/disclosure-block';
import type { BlockBlockerCode } from '@/lib/domain/disclosure-status';
import type {
  ApplicabilityStatus,
  BlockBody,
  CsrdAssessment,
  CsrdDmaMatter,
  SsbjAssessment,
  ConfidentialityLevel,
  DataPoint,
  DataPointVersion,
  DisclosureBlock,
  DisclosureBlockVersion,
  DisclosureFramework,
  DisclosureFrameworkVersion,
  DisclosureItem,
  DisclosureProject,
  DisclosurePurpose,
  FileObject,
  FileVersion,
  IsoDate,
  IsoDateTime,
  MetricDefinition,
  OrganizationUnit,
  ProjectFramework,
  ReportingPeriod,
  ReportSnapshot,
  ReportSnapshotAnchor,
  ReportSnapshotBlock,
  ReportSnapshotFramework,
  ReportSnapshotMetricValue,
  ReviewComment,
  ReviewCommentSeverity,
  SourceAnchor,
  Uuid,
} from '@/types/domain';

/**
 * 内容ハッシュの計算規則の版。規則を変えたら上げる（過去のハッシュと混同しない）。
 *
 * v2（トライアル対応 2026-10）: 節に承認の記録（依頼・レビュー者・最終承認者・日時）、数値に根拠資料の版、
 * 基準ごとに要求事項の状態（判断の履歴・対象外の申請と承認の記録の ID、可変の評価行は値のダイジェスト）を
 * 写しに含める。v1 のスナップショット（これらの項目を持たない）は v1 の規則のまま検査する
 * （過去の承認版の内容ハッシュを作り直さない）。
 */
export const SNAPSHOT_HASH_VERSION = 'report-snapshot-v2';
export const SNAPSHOT_HASH_VERSION_V1 = 'report-snapshot-v1';

// ======================================================================
// スナップショットに固定する写し（domain の基本型を拡張する）
// ======================================================================

export interface SnapshotFramework extends ReportSnapshotFramework {
  purpose: DisclosurePurpose | null;
  /** 草案の基準による準備（社内の確定はできるが、法定準拠の確定として扱わない） */
  draftStandardPrep: boolean;
  frameworkName: string;
  coverageNote: string | null;
  /** 固定時点のプロジェクトの表示（出力の表紙に使う。プロジェクトは後から編集されうる） */
  projectName: string;
  reportingEntity: string;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  /**
   * 固定時点の報告範囲の改訂番号（disclosure_projects.scope_revision）。後から範囲を変えたことを
   * 「上流の変更」として示すために持つ。この項目より前に作ったスナップショットでは null
   */
  scopeRevision: number | null;
  /**
   * 固定時点の要求事項の状態（v2）。v1 のスナップショットには無い（キーごと無い）。
   * 判断・対象外の承認は追記専用の記録の ID で固定し、可変の評価行（SSBJ・CSRD）は値のダイジェストだけを持つ
   */
  requirementState?: SnapshotRequirementState | null;
}

/** 固定時点の要求事項の状態（v2） */
export interface SnapshotRequirementState {
  /** project_requirement_assessment_events の ID（SSBJ・CSRD 以外の基準。固定時点までの記録） */
  assessmentEventIds: Uuid[];
  /** requirement_exclusion_events の ID（固定時点までの申請・承認・差戻し・取り下げ） */
  exclusionEventIds: Uuid[];
  /** 可変の評価行（SSBJ の評価・CSRD の DMA と評価）の値のダイジェスト（16 桁）。それ以外の基準は null */
  assessmentDigest: string | null;
}

/** 節の版の承認の記録（v2）。最終承認で終わった依頼のうち、固定時点の範囲で最も早く承認されたもの */
export interface SnapshotBlockApproval {
  reviewRequestId: Uuid;
  /** 第 1 段（レビュー）を完了した人。記録が無ければ null */
  reviewedBy: Uuid | null;
  approvedBy: Uuid;
  approvedAt: IsoDateTime;
}

export interface SnapshotRequirement {
  itemId: Uuid;
  code: string;
  section: string;
  text: string;
}

export type SnapshotIssueCode =
  | BlockBlockerCode
  | 'not_approved'
  | 'revised_after_approval'
  | 'metric_not_approved'
  | 'metric_value_absent'
  | 'metric_missing'
  /** 推計・目標の数値を引用している（止めない注意。本文・出力では区分を添える） */
  | 'metric_not_actual'
  | 'stale_narrative_refs'
  | 'narrative_missing_fields'
  /** 財務的影響を定量化しない理由（不足ではなく、理由そのものを示す注意） */
  | 'narrative_not_quantified'
  | 'anchor_missing'
  /** 固定する版を読み込めない（Demo Mode で別のサーバーが作った版など） */
  | 'version_missing'
  /** 必須言語の翻訳版が無い・翻訳元の承認後に翻訳が見直されていない */
  | 'translation_missing'
  | 'translation_stale';

export interface SnapshotIssue {
  code: SnapshotIssueCode;
  message: string;
}

export interface SnapshotComment {
  paragraphId: string | null;
  severity: ReviewCommentSeverity;
  body: string;
  createdAt: IsoDateTime;
}

export interface SnapshotBlock extends ReportSnapshotBlock {
  frameworkVersionId: Uuid;
  sortOrder: number;
  versionNo: number | null;
  versionCreatedBy: Uuid | null;
  versionCreatedAt: IsoDateTime | null;
  /** 固定時点の承認済みの版（草稿では固定した版と違うことがある） */
  approvedVersionId: Uuid | null;
  /** 固定した版が承認済みの版か */
  isApprovedVersion: boolean;
  requirements: SnapshotRequirement[];
  /** 未承認・不足情報・阻害条件（社内向けの説明。対外原稿では節名と要約だけを出す） */
  issues: SnapshotIssue[];
  /** 未解決の社内コメント（社内確認用の出力だけに出す） */
  internalComments: SnapshotComment[];
  /**
   * 固定時点で非公開だった資料のうち、この節の本文（地の文・定性情報の引用文）に名前が現れるもの。
   * 対外用の出力で伏せる名前を固定し、後から資料を登録・区分変更しても再出力の本文を変えない（§10.3）。
   * この項目より前に作ったスナップショットでは null（出力時の資料一覧から集める）
   */
  maskedFileNames: string[] | null;
  /** 固定した版の承認の記録（v2）。承認済みの版でなければ null。v1 のスナップショットには無い */
  approval?: SnapshotBlockApproval | null;
}

export interface SnapshotMetricValue extends ReportSnapshotMetricValue {
  versionNo: number;
  metricCode: string;
  metricName: string;
  unitId: Uuid;
  unitName: string;
  periodCode: string;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  /** この版が承認された版か（承認記録がこの版を指す、または承認済みの現在版） */
  versionApproved: boolean;
  changeReason: string | null;
  absenceReason: string | null;
  /** 固定時点に Data Point へ紐付いていた根拠資料の版（v2。file_version の ID の昇順）。v1 には無い */
  evidenceFileVersionIds?: Uuid[];
}

export interface SnapshotAnchor extends ReportSnapshotAnchor {
  fileId: Uuid | null;
  fileName: string;
  fileVersionNo: number | null;
  confidentiality: ConfidentialityLevel;
  editionLabel: string | null;
}

export interface ReportSnapshotDetail extends ReportSnapshot {
  frameworkVersions: SnapshotFramework[];
  blocks: SnapshotBlock[];
  metricValues: SnapshotMetricValue[];
  anchors: SnapshotAnchor[];
}

// ======================================================================
// 内容ハッシュ
// ======================================================================

export type SnapshotContent = Pick<
  ReportSnapshot,
  | 'projectId'
  | 'snapshotKind'
  | 'label'
  | 'frameworkVersions'
  | 'decisionIds'
  | 'blocks'
  | 'metricValues'
  | 'narrativeVersionIds'
  | 'anchors'
  | 'policyVersion'
>;

/**
 * 正規化した内容のハッシュ（report_snapshots.content_hash / export_artifacts.content_hash）。
 * ID・番号・作成日時は含めない（同じ内容なら同じ値。再出力で一致することの検証に使う）。
 * キー順は canonicalJson が固定するため、jsonb を往復してキー順が変わっても同じ値になる。
 */
export function computeSnapshotContentHash(snapshot: SnapshotContent): string {
  const content = {
    hashVersion: snapshotHashVersionOf(snapshot),
    projectId: snapshot.projectId,
    snapshotKind: snapshot.snapshotKind,
    label: snapshot.label,
    frameworkVersions: snapshot.frameworkVersions,
    decisionIds: snapshot.decisionIds,
    blocks: snapshot.blocks,
    metricValues: snapshot.metricValues,
    narrativeVersionIds: snapshot.narrativeVersionIds,
    anchors: snapshot.anchors,
    policyVersion: snapshot.policyVersion,
  };
  return createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex');
}

/**
 * 写しが従う内容ハッシュの規則の版。v2 の写しは基準ごとに requirementState のキーを必ず持つ
 * （値が null でもキーはある）。キーの無い写しは v1（以前に作ったスナップショット）
 */
export function snapshotHashVersionOf(
  snapshot: Pick<SnapshotContent, 'frameworkVersions'>,
): string {
  const frameworks = (snapshot.frameworkVersions ?? []) as unknown as Array<
    Record<string, unknown>
  >;
  return frameworks.some(
    (f) => f !== null && typeof f === 'object' && Object.hasOwn(f, 'requirementState'),
  )
    ? SNAPSHOT_HASH_VERSION
    : SNAPSHOT_HASH_VERSION_V1;
}

/** 写しが v2 の規則（承認の記録・根拠資料・要求事項の状態を持つ）か */
export function isSnapshotV2(snapshot: Pick<SnapshotContent, 'frameworkVersions'>): boolean {
  return snapshotHashVersionOf(snapshot) === SNAPSHOT_HASH_VERSION;
}

// ======================================================================
// v2 の写しの項目（作成時と、Demo Mode の組み立て直しで共通）
// ======================================================================

interface ApprovalRequestLike {
  id: Uuid;
  targetId: Uuid;
  targetVersionId: Uuid;
  status: string;
  projectScopeRevision?: number | null;
}

interface ApprovalEventLike {
  id: Uuid;
  reviewRequestId: Uuid;
  eventType: string;
  targetVersionId: Uuid;
  actorUserId: Uuid;
  createdAt: IsoDateTime;
}

/**
 * 節の版の承認の記録。最終承認で終わった依頼（固定時点の報告範囲の改訂番号以上）のうち、最も早く
 * 最終承認されたもの。依頼・記録は追記専用で、後から足される承認は必ず後の日時になるため、
 * 別のインスタンスで組み立て直しても同じ記録を選ぶ（Cookie に依頼の ID を持たなくてよい）。
 * 承認の記録が無ければ null
 */
export function snapshotApprovalOf(
  blockId: Uuid,
  versionId: Uuid,
  requests: readonly ApprovalRequestLike[],
  events: readonly ApprovalEventLike[],
  minScopeRevision: number,
): SnapshotBlockApproval | null {
  let best: { request: ApprovalRequestLike; approved: ApprovalEventLike } | null = null;
  for (const request of requests) {
    if (
      request.targetId !== blockId ||
      request.targetVersionId !== versionId ||
      request.status !== 'approved' ||
      (request.projectScopeRevision ?? 0) < minScopeRevision
    ) {
      continue;
    }
    const approved = events
      .filter(
        (e) =>
          e.reviewRequestId === request.id &&
          e.eventType === 'approved' &&
          e.targetVersionId === versionId,
      )
      .sort((a, b) =>
        a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
      )[0];
    if (!approved) continue;
    if (
      !best ||
      approved.createdAt < best.approved.createdAt ||
      (approved.createdAt === best.approved.createdAt && request.id < best.request.id)
    ) {
      best = { request, approved };
    }
  }
  if (!best) return null;
  const reviewed = events
    .filter(
      (e) =>
        e.reviewRequestId === best.request.id &&
        e.eventType === 'review_completed' &&
        e.targetVersionId === versionId,
    )
    .sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
    )[0];
  return {
    reviewRequestId: best.request.id,
    reviewedBy: reviewed?.actorUserId ?? null,
    approvedBy: best.approved.actorUserId,
    approvedAt: best.approved.createdAt,
  };
}

interface DatedRecord {
  id: Uuid;
  createdAt: IsoDateTime;
}

/**
 * 固定時点までの追記専用の記録の ID（作成日時・ID の順）。固定した後に足された記録は含めない。
 * 作成時と組み立て直しで同じ規則（日時で切る）を使い、ID の一覧を Cookie に持たずに済ませる
 */
export function recordIdsAsOf(records: readonly DatedRecord[], asOf: IsoDateTime): Uuid[] {
  return records
    .filter((r) => r.createdAt <= asOf)
    .sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
    )
    .map((r) => r.id);
}

/** 可変の評価行の値のダイジェスト（16 桁）。行の内容を正規化した JSON の sha256 の先頭 */
export function requirementStateDigest(values: unknown): string {
  return createHash('sha256').update(canonicalJson(values), 'utf8').digest('hex').slice(0, 16);
}

/**
 * SSBJ の評価行（可変）の値のダイジェスト。要求事項ごとに適用区分・理由・重要性・理由・人の最終判定を並べる
 * （評価の無い要求事項も [id, null] として並べ、行が増えたことも差分になる）
 */
export function ssbjRequirementDigest(
  itemIds: readonly Uuid[],
  rows: ReadonlyArray<
    Pick<
      SsbjAssessment,
      | 'itemId'
      | 'applicability'
      | 'applicabilityReason'
      | 'materiality'
      | 'materialityReason'
      | 'finalStatus'
    >
  >,
): string {
  const byItem = new Map(rows.map((r) => [r.itemId, r]));
  return requirementStateDigest(
    [...itemIds].sort().map((id) => {
      const r = byItem.get(id);
      return r
        ? [
            id,
            r.applicability,
            r.applicabilityReason,
            r.materiality,
            r.materialityReason,
            r.finalStatus,
          ]
        : [id, null];
    }),
  );
}

/** CSRD の DMA（事項の両軸の判断・確定）と評価（人の最終判定）の値のダイジェスト */
export function csrdRequirementDigest(
  itemIds: readonly Uuid[],
  matters: ReadonlyArray<
    Pick<CsrdDmaMatter, 'esrsTopic' | 'impactAssessment' | 'financialAssessment' | 'decidedAt'>
  >,
  dmaConfirmedAt: IsoDateTime | null,
  assessments: ReadonlyArray<Pick<CsrdAssessment, 'itemId' | 'finalStatus'>>,
): string {
  const items = new Set(itemIds);
  return requirementStateDigest({
    matters: matters
      .map((m) => [m.esrsTopic, m.impactAssessment, m.financialAssessment, m.decidedAt])
      .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
    dmaConfirmedAt,
    assessments: assessments
      .filter((a) => items.has(a.itemId))
      .map((a) => [a.itemId, a.finalStatus])
      .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
  });
}

/** 要求事項の状態の写し（ID は日時で切ったもの、ダイジェストはそのまま） */
export function snapshotRequirementStateOf(input: {
  assessmentEvents: readonly DatedRecord[];
  exclusionEvents: readonly DatedRecord[];
  assessmentDigest: string | null;
  asOf: IsoDateTime;
}): SnapshotRequirementState {
  return {
    assessmentEventIds: recordIdsAsOf(input.assessmentEvents, input.asOf),
    exclusionEventIds: recordIdsAsOf(input.exclusionEvents, input.asOf),
    assessmentDigest: input.assessmentDigest,
  };
}

/** 根拠資料の版の一覧（重複を除いて昇順） */
export function sortedEvidenceFileVersionIds(ids: readonly Uuid[]): Uuid[] {
  return [...new Set(ids)].sort();
}

// ======================================================================
// 写しの作り方（作成時と、Demo Mode の組み立て直しで共通）
// ======================================================================

/** 草案の基準か（ESRS-40a 公開草案など）。準備目的（40a）で登録した基準も同じ扱い */
export function isDraftStandard(
  version: Pick<DisclosureFrameworkVersion, 'legalStatus'> | null,
  purpose: DisclosurePurpose | null,
): boolean {
  return version?.legalStatus === 'draft' || purpose === 'csrd_40a_prep';
}

/** 基準の写し。基準の版・基準は固定の表、適用区分・判断・目的とプロジェクトの表示は固定時点の値 */
export function snapshotFrameworkOf(
  pf: Pick<ProjectFramework, 'frameworkVersionId' | 'applicabilityStatus' | 'currentDecisionId'> & {
    purpose: DisclosurePurpose | null;
  },
  version: DisclosureFrameworkVersion | null,
  framework: DisclosureFramework | null,
  project: Pick<
    DisclosureProject,
    'name' | 'reportingEntity' | 'periodStart' | 'periodEnd' | 'scopeRevision'
  >,
  /** v2 の写しのときだけ渡す（キーごと足す。v1 の組み立て直しでは渡さない） */
  v2?: { requirementState: SnapshotRequirementState | null },
): SnapshotFramework {
  const label = version?.label ?? '（基準の版が見つかりません）';
  return {
    ...(v2 ? { requirementState: v2.requirementState } : {}),
    frameworkVersionId: pf.frameworkVersionId,
    frameworkKey: framework?.key ?? 'ssbj',
    label,
    versionCode: version?.versionCode ?? null,
    legalStatus: version?.legalStatus ?? null,
    coverageStatus: version?.coverageStatus ?? null,
    applicabilityStatus: pf.applicabilityStatus,
    decisionId: pf.currentDecisionId,
    purpose: pf.purpose,
    draftStandardPrep: isDraftStandard(version, pf.purpose),
    frameworkName: framework?.name ?? label,
    coverageNote: version?.coverageNote ?? null,
    projectName: project.name,
    reportingEntity: project.reportingEntity,
    periodStart: project.periodStart,
    periodEnd: project.periodEnd,
    scopeRevision: project.scopeRevision ?? 0,
  };
}

/**
 * 数値の写し。値・単位・版番号は追記専用の版、組織・期間・境界は Data Point の業務キー、名称はマスター。
 * 承認の状態（status・versionApproved）は固定時点の判定を渡す
 */
export function snapshotMetricValueOf(
  v: DataPointVersion,
  dp: Pick<DataPoint, 'id' | 'metricId' | 'reportingPeriodId' | 'boundary' | 'unitId'>,
  masters: {
    metric: Pick<MetricDefinition, 'code' | 'name'> | undefined;
    unit: Pick<OrganizationUnit, 'name'> | undefined;
    period: Pick<ReportingPeriod, 'code' | 'startDate' | 'endDate'> | undefined;
  },
  state: { status: SnapshotMetricValue['status']; versionApproved: boolean },
  /** v2 の写しのときだけ渡す（キーごと足す） */
  v2?: { evidenceFileVersionIds: readonly Uuid[] },
): SnapshotMetricValue {
  return {
    ...(v2
      ? { evidenceFileVersionIds: sortedEvidenceFileVersionIds(v2.evidenceFileVersionIds) }
      : {}),
    dataPointId: dp.id,
    dataPointVersionId: v.id,
    metricId: dp.metricId,
    value: v.value,
    textValue: v.textValue,
    unitOfMeasure: v.unitOfMeasure,
    reportingPeriodId: dp.reportingPeriodId,
    boundary: dp.boundary,
    status: state.status,
    valueKind: v.valueKind,
    availabilityStatus: v.availabilityStatus,
    versionNo: v.versionNo,
    metricCode: masters.metric?.code ?? '',
    metricName: masters.metric?.name ?? '（指標名不明）',
    unitId: dp.unitId,
    unitName: masters.unit?.name ?? '（組織不明）',
    periodCode: masters.period?.code ?? '',
    periodStart: masters.period?.startDate ?? '',
    periodEnd: masters.period?.endDate ?? '',
    versionApproved: state.versionApproved,
    changeReason: v.changeReason,
    absenceReason: v.absenceReason,
  };
}

/** 引用位置の写し。引用文・位置は追記専用の引用位置、資料名・区分は資料の行 */
export function snapshotAnchorOf(
  anchor: SourceAnchor,
  fileVersion: Pick<FileVersion, 'versionNo'> | undefined,
  file:
    | Pick<FileObject, 'id' | 'usagePurpose' | 'originalName' | 'confidentiality' | 'editionLabel'>
    | undefined,
): SnapshotAnchor {
  return {
    sourceAnchorId: anchor.id,
    fileVersionId: anchor.fileVersionId,
    anchorKind: anchor.anchorKind,
    page: anchor.page,
    locator: anchor.locator,
    quoteText: anchor.quoteText,
    usagePurpose: file?.usagePurpose ?? null,
    fileId: file?.id ?? null,
    fileName: file?.originalName ?? '（ファイル名不明）',
    fileVersionNo: fileVersion?.versionNo ?? null,
    confidentiality: file?.confidentiality ?? 'confidential',
    editionLabel: file?.editionLabel ?? null,
  };
}

/**
 * 節の写し。本文・内容ハッシュ・版番号・作成者は追記専用の版、節名・並び・言語・基準は節の行、
 * 状態・承認済みの版・注意・社内コメント・伏せる資料名は固定時点の値を渡す
 */
export function snapshotBlockOf(
  block: Pick<
    DisclosureBlock,
    'id' | 'sectionKey' | 'title' | 'language' | 'frameworkVersionId' | 'sortOrder'
  >,
  version: Pick<
    DisclosureBlockVersion,
    'id' | 'body' | 'contentHash' | 'versionNo' | 'createdBy' | 'createdAt'
  > | null,
  frozen: {
    status: SnapshotBlock['status'];
    approvedVersionId: Uuid | null;
    isApprovedVersion: boolean;
    requirements: SnapshotRequirement[];
    issues: SnapshotIssue[];
    internalComments: SnapshotComment[];
    maskedFileNames: string[] | null;
  },
  /** v2 の写しのときだけ渡す（キーごと足す） */
  v2?: { approval: SnapshotBlockApproval | null },
): SnapshotBlock {
  return {
    ...(v2 ? { approval: v2.approval } : {}),
    blockId: block.id,
    versionId: version?.id ?? null,
    sectionKey: block.sectionKey,
    title: block.title,
    language: block.language,
    status: frozen.status,
    body: version?.body ?? { paragraphs: [] },
    contentHash: version?.contentHash ?? null,
    frameworkVersionId: block.frameworkVersionId,
    sortOrder: block.sortOrder,
    versionNo: version?.versionNo ?? null,
    versionCreatedBy: version?.createdBy ?? null,
    versionCreatedAt: version?.createdAt ?? null,
    approvedVersionId: frozen.approvedVersionId,
    isApprovedVersion: frozen.isApprovedVersion,
    requirements: frozen.requirements,
    issues: frozen.issues,
    internalComments: frozen.internalComments,
    maskedFileNames: frozen.maskedFileNames,
  };
}

/** 節の要求事項の写し（本文は 200 文字まで） */
export function snapshotRequirementsOf(
  requirementItemIds: readonly Uuid[],
  itemById: ReadonlyMap<Uuid, Pick<DisclosureItem, 'id' | 'code' | 'section' | 'questionText'>>,
): SnapshotRequirement[] {
  return requirementItemIds
    .map((id) => itemById.get(id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .map((item) => ({
      itemId: item.id,
      code: item.code,
      section: item.section,
      text:
        item.questionText.length > 200 ? `${item.questionText.slice(0, 199)}…` : item.questionText,
    }));
}

/** 本文（地の文・定性情報の引用文）に現れる名前。出典印（cite）は出力側で別に伏せる */
export function namesMentionedIn(body: BlockBody, names: readonly string[]): string[] {
  if (names.length === 0) return [];
  const text = body.paragraphs
    .flatMap((p) =>
      p.children.map((inline) =>
        inline.t === 'text' ? inline.text : inline.t === 'narrative' ? inline.quote : '',
      ),
    )
    .join('\n');
  return names.filter((name) => text.includes(name));
}

/** 固定する社内コメント: 固定時点で未解決のもの（古い順）。写しは snapshotCommentOf で作る */
export function unresolvedCommentsInOrder<
  T extends Pick<ReviewComment, 'createdAt' | 'resolvedAt'>,
>(comments: readonly T[]): T[] {
  return comments
    .filter((c) => c.resolvedAt === null)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

/**
 * 社内コメントの写し。段落・区分・本文・日時はコメントの行で変わらない（後から解決しても変わるのは
 * 解決の記録だけ）ため、組み立て直すときもコメントの行から同じ写しを作れる
 */
export function snapshotCommentOf(
  c: Pick<ReviewComment, 'paragraphId' | 'severity' | 'body' | 'createdAt'>,
): SnapshotComment {
  return {
    paragraphId: c.paragraphId,
    severity: c.severity,
    body: c.body,
    createdAt: c.createdAt,
  };
}

// ======================================================================
// 読み出し（jsonb に拡張項目が無い行でも出力できるよう既定値を補う）
// ======================================================================

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
function strOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function arr<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** v2 の要求事項の状態（形が崩れていれば null として読む） */
function requirementStateOf(value: unknown): SnapshotRequirementState | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<SnapshotRequirementState>;
  return {
    assessmentEventIds: arr<unknown>(v.assessmentEventIds).filter(isString),
    exclusionEventIds: arr<unknown>(v.exclusionEventIds).filter(isString),
    assessmentDigest: strOrNull(v.assessmentDigest),
  };
}

/** v2 の節の承認の記録（形が崩れていれば null として読む） */
function approvalOf(value: unknown): SnapshotBlockApproval | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<SnapshotBlockApproval>;
  if (!isString(v.reviewRequestId) || !isString(v.approvedBy) || !isString(v.approvedAt)) {
    return null;
  }
  return {
    reviewRequestId: v.reviewRequestId,
    reviewedBy: strOrNull(v.reviewedBy),
    approvedBy: v.approvedBy,
    approvedAt: v.approvedAt,
  };
}

/**
 * 行の jsonb を出力用の型へ読み替える。欠けた拡張項目は「不明」を表す値で補い、推測で埋めない。
 * 既定値を補った写しはハッシュ計算に使わない（ハッシュは保存された行そのものから計算する）。
 */
export function asSnapshotDetail(row: ReportSnapshot): ReportSnapshotDetail {
  const frameworks = arr<Partial<SnapshotFramework>>(row.frameworkVersions).map(
    (f): SnapshotFramework => ({
      frameworkVersionId: str(f.frameworkVersionId),
      frameworkKey: (f.frameworkKey ?? 'ssbj') as SnapshotFramework['frameworkKey'],
      label: str(f.label, '（基準名不明）'),
      versionCode: strOrNull(f.versionCode),
      legalStatus: (f.legalStatus ?? null) as SnapshotFramework['legalStatus'],
      coverageStatus: (f.coverageStatus ?? null) as SnapshotFramework['coverageStatus'],
      applicabilityStatus: (f.applicabilityStatus ?? 'not_assessed') as ApplicabilityStatus,
      decisionId: strOrNull(f.decisionId),
      purpose: (f.purpose ?? null) as DisclosurePurpose | null,
      draftStandardPrep: f.draftStandardPrep === true || f.legalStatus === 'draft',
      frameworkName: str(f.frameworkName, str(f.label)),
      coverageNote: strOrNull(f.coverageNote),
      projectName: str(f.projectName, row.label),
      reportingEntity: str(f.reportingEntity),
      periodStart: str(f.periodStart),
      periodEnd: str(f.periodEnd),
      scopeRevision: num(f.scopeRevision),
      // v2 の項目は、写しが持つときだけ読む（v1 の写しにキーを足すと内容ハッシュの検査が合わなくなる）
      ...(Object.hasOwn(f, 'requirementState')
        ? { requirementState: requirementStateOf(f.requirementState) }
        : {}),
    }),
  );
  const blocks = arr<Partial<SnapshotBlock>>(row.blocks).map((b): SnapshotBlock => ({
    blockId: str(b.blockId),
    versionId: strOrNull(b.versionId),
    sectionKey: str(b.sectionKey),
    title: str(b.title, '（節名不明）'),
    language: b.language === 'en' ? 'en' : 'ja',
    status: (b.status ?? 'draft') as SnapshotBlock['status'],
    body: (b.body && Array.isArray((b.body as BlockBody).paragraphs)
      ? b.body
      : { paragraphs: [] }) as BlockBody,
    contentHash: strOrNull(b.contentHash),
    frameworkVersionId: str(b.frameworkVersionId),
    sortOrder: num(b.sortOrder) ?? 0,
    versionNo: num(b.versionNo),
    versionCreatedBy: strOrNull(b.versionCreatedBy),
    versionCreatedAt: strOrNull(b.versionCreatedAt),
    approvedVersionId: strOrNull(b.approvedVersionId),
    isApprovedVersion: b.isApprovedVersion === true,
    requirements: arr<SnapshotRequirement>(b.requirements),
    issues: arr<SnapshotIssue>(b.issues),
    internalComments: arr<SnapshotComment>(b.internalComments),
    maskedFileNames: Array.isArray(b.maskedFileNames)
      ? b.maskedFileNames.filter((n): n is string => typeof n === 'string')
      : null,
    ...(Object.hasOwn(b, 'approval') ? { approval: approvalOf(b.approval) } : {}),
  }));
  const metricValues = arr<Partial<SnapshotMetricValue>>(row.metricValues).map(
    (m): SnapshotMetricValue => ({
      dataPointId: str(m.dataPointId),
      dataPointVersionId: str(m.dataPointVersionId),
      metricId: str(m.metricId),
      value: num(m.value),
      textValue: strOrNull(m.textValue),
      unitOfMeasure: str(m.unitOfMeasure),
      reportingPeriodId: str(m.reportingPeriodId),
      boundary: str(m.boundary),
      status: (m.status ?? 'draft') as SnapshotMetricValue['status'],
      valueKind: (m.valueKind ?? 'actual') as SnapshotMetricValue['valueKind'],
      availabilityStatus: (m.availabilityStatus ??
        'not_entered') as SnapshotMetricValue['availabilityStatus'],
      versionNo: num(m.versionNo) ?? 0,
      metricCode: str(m.metricCode),
      metricName: str(m.metricName, '（指標名不明）'),
      unitId: str(m.unitId),
      unitName: str(m.unitName, '（組織不明）'),
      periodCode: str(m.periodCode),
      periodStart: str(m.periodStart),
      periodEnd: str(m.periodEnd),
      versionApproved: m.versionApproved === true,
      changeReason: strOrNull(m.changeReason),
      absenceReason: strOrNull(m.absenceReason),
      ...(Object.hasOwn(m, 'evidenceFileVersionIds')
        ? { evidenceFileVersionIds: arr<unknown>(m.evidenceFileVersionIds).filter(isString) }
        : {}),
    }),
  );
  const anchors = arr<Partial<SnapshotAnchor>>(row.anchors).map((a): SnapshotAnchor => ({
    sourceAnchorId: str(a.sourceAnchorId),
    fileVersionId: str(a.fileVersionId),
    anchorKind: (a.anchorKind ?? 'manual_excerpt') as SnapshotAnchor['anchorKind'],
    page: num(a.page),
    locator: strOrNull(a.locator),
    quoteText: str(a.quoteText),
    usagePurpose: (a.usagePurpose ?? null) as SnapshotAnchor['usagePurpose'],
    fileId: strOrNull(a.fileId),
    fileName: str(a.fileName, '（ファイル名不明）'),
    fileVersionNo: num(a.fileVersionNo),
    // 機密区分が分からない資料は公開扱いにしない（対外原稿へファイル名を出さない側に倒す）
    confidentiality: (a.confidentiality ?? 'confidential') as ConfidentialityLevel,
    editionLabel: strOrNull(a.editionLabel),
  }));
  return { ...row, frameworkVersions: frameworks, blocks, metricValues, anchors };
}
