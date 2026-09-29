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

/** 内容ハッシュの計算規則の版。規則を変えたら上げる（過去のハッシュと混同しない） */
export const SNAPSHOT_HASH_VERSION = 'report-snapshot-v1';

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
    hashVersion: SNAPSHOT_HASH_VERSION,
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
): SnapshotFramework {
  const label = version?.label ?? '（基準の版が見つかりません）';
  return {
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
): SnapshotMetricValue {
  return {
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
): SnapshotBlock {
  return {
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
