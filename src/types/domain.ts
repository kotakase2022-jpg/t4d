/**
 * T4D ドメイン型定義
 *
 * `supabase/migrations/*.sql` のテーブル定義と 1:1 で対応させる。
 * SQL を変更したら必ず本ファイルも更新すること（`tests/unit/schema-parity.test.ts` が検査する）。
 *
 * 命名規約:
 *  - TypeScript: camelCase
 *  - Postgres  : snake_case
 *  - 変換は `src/lib/repositories/supabase/mappers.ts` に集約する。
 */

// ======================================================================
// 共通
// ======================================================================

export type Uuid = string;
/** ISO 8601 UTC 文字列。表示は必ず `formatJst` を通す。 */
export type IsoDateTime = string;
/** `YYYY-MM-DD` */
export type IsoDate = string;

export interface AuditColumns {
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  createdBy: Uuid | null;
  updatedBy: Uuid | null;
}

export interface SoftDeletable {
  deletedAt: IsoDateTime | null;
}

// ======================================================================
// 10.1 Identity / Tenant
// ======================================================================

export const ORGANIZATION_TYPES = ['enterprise', 'assurance_firm', 'platform_admin'] as const;
export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];

export const ENTERPRISE_ROLES = [
  'enterprise_admin',
  'sustainability_manager',
  'site_contributor',
  'supplier_contributor',
  'reviewer',
  'approver',
  'external_advisor',
  'viewer',
] as const;
export type EnterpriseRole = (typeof ENTERPRISE_ROLES)[number];

export const ASSURANCE_ROLES = [
  'assurance_admin',
  'engagement_partner',
  'assurance_manager',
  'assurance_staff',
  'specialist',
  'assurance_viewer',
] as const;
export type AssuranceRole = (typeof ASSURANCE_ROLES)[number];

export const PLATFORM_ROLES = ['platform_admin'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export type RoleKey = EnterpriseRole | AssuranceRole | PlatformRole;

export interface Profile {
  id: Uuid;
  email: string;
  displayName: string;
  jobTitle: string | null;
  locale: 'ja' | 'en';
  timezone: string;
  createdAt: IsoDateTime;
}

export interface Organization extends AuditColumns, SoftDeletable {
  id: Uuid;
  type: OrganizationType;
  name: string;
  legalName: string | null;
  code: string;
  countryCode: string;
}

export const MEMBERSHIP_STATUSES = ['invited', 'active', 'suspended'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export interface OrganizationMembership extends AuditColumns {
  id: Uuid;
  organizationId: Uuid;
  userId: Uuid;
  status: MembershipStatus;
  /** 企業側ロールの担当 Unit 制限。空配列 = 全社スコープ。 */
  unitScopeIds: Uuid[];
  invitedBy: Uuid | null;
  joinedAt: IsoDateTime | null;
}

export interface MembershipRole {
  membershipId: Uuid;
  roleKey: RoleKey;
  grantedAt: IsoDateTime;
  grantedBy: Uuid | null;
}

export interface RoleDefinition {
  key: RoleKey;
  organizationType: OrganizationType;
  name: string;
  description: string;
}

export interface PermissionDefinition {
  key: PermissionKey;
  description: string;
}

/** アプリ層の認可単位。RLS と対で使う（片方だけに依存しない）。 */
export const PERMISSION_KEYS = [
  // 企業
  'enterprise.org.manage',
  'enterprise.period.manage',
  'enterprise.metric.manage',
  'enterprise.member.manage',
  'enterprise.data.read',
  'enterprise.data.write',
  'enterprise.data.submit',
  'enterprise.data.review',
  'enterprise.data.approve',
  'enterprise.evidence.read',
  'enterprise.evidence.write',
  'enterprise.import.run',
  'enterprise.disclosure.read',
  'enterprise.disclosure.write',
  'enterprise.disclosure.approve',
  'enterprise.export.run',
  'enterprise.ai.run',
  'enterprise.grant.manage',
  'enterprise.pbc.respond',
  // 監査法人
  'assurance.firm.manage',
  'assurance.engagement.manage',
  'assurance.engagement.read',
  'assurance.scope.manage',
  'assurance.snapshot.create',
  'assurance.population.manage',
  'assurance.sampling.run',
  'assurance.testing.write',
  'assurance.pbc.manage',
  'assurance.issue.manage',
  'assurance.review.write',
  'assurance.signoff.prepared',
  'assurance.signoff.reviewed',
  'assurance.signoff.partner',
  'assurance.export.run',
  'assurance.ai.run',
  // 共通
  'common.audit.read',
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export interface Invitation extends AuditColumns {
  id: Uuid;
  organizationId: Uuid;
  email: string;
  roleKeys: RoleKey[];
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: IsoDateTime;
}

export const RELATIONSHIP_STATUSES = ['pending', 'active', 'suspended', 'terminated'] as const;
export type RelationshipStatus = (typeof RELATIONSHIP_STATUSES)[number];

/** 企業テナント ↔ 監査法人テナントの唯一の接続点（契約レベル）。 */
export interface OrganizationRelationship extends AuditColumns {
  id: Uuid;
  clientOrganizationId: Uuid;
  providerOrganizationId: Uuid;
  relationshipType: 'assurance' | 'advisory';
  status: RelationshipStatus;
  startedAt: IsoDate;
  endedAt: IsoDate | null;
}

export const GRANT_SUBJECT_TYPES = [
  'metric',
  'organization_unit',
  'reporting_period',
  'evidence_category',
  'disclosure_item',
] as const;
export type GrantSubjectType = (typeof GRANT_SUBJECT_TYPES)[number];

/**
 * 企業が「何を、どの案件に、いつまで見せるか」の唯一の真実。
 * RLS はこのテーブルを必ず経由する（Engagement Member であるだけでは不可視）。
 */
export interface ClientAccessGrant extends AuditColumns {
  id: Uuid;
  engagementId: Uuid;
  clientOrganizationId: Uuid;
  assuranceFirmId: Uuid;
  subjectType: GrantSubjectType;
  subjectId: Uuid;
  /** true の場合、監査法人は Evidence 実体（Signed URL）まで取得できる。 */
  includesEvidence: boolean;
  grantedBy: Uuid;
  grantedAt: IsoDateTime;
  revokedBy: Uuid | null;
  revokedAt: IsoDateTime | null;
  note: string | null;
}

export interface UserPreference {
  userId: Uuid;
  density: 'compact' | 'standard';
  defaultWorkspaceOrganizationId: Uuid | null;
  savedViews: SavedView[];
  updatedAt: IsoDateTime;
}

export interface SavedView {
  id: Uuid;
  key: string;
  name: string;
  query: Record<string, string | string[]>;
  visibleColumns: string[];
}

// ======================================================================
// 10.2 Organization / Period
// ======================================================================

export const UNIT_TYPES = ['headquarters', 'division', 'site', 'subsidiary', 'supplier'] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

export const CONSOLIDATION_METHODS = ['full', 'proportionate', 'equity', 'excluded'] as const;
export type ConsolidationMethod = (typeof CONSOLIDATION_METHODS)[number];

export interface OrganizationUnit extends AuditColumns, SoftDeletable {
  id: Uuid;
  organizationId: Uuid;
  parentId: Uuid | null;
  code: string;
  name: string;
  unitType: UnitType;
  countryCode: string;
  currencyCode: string;
  timezone: string;
  consolidationMethod: ConsolidationMethod;
  ownershipPercent: number;
  exclusionReason: string | null;
  sortOrder: number;
}

export const PERIOD_STATUSES = ['planning', 'collecting', 'reviewing', 'closed'] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

export interface ReportingPeriod extends AuditColumns {
  id: Uuid;
  organizationId: Uuid;
  code: string;
  label: string;
  startDate: IsoDate;
  endDate: IsoDate;
  status: PeriodStatus;
  submissionDueDate: IsoDate | null;
}

export interface CollectionCampaign extends AuditColumns {
  id: Uuid;
  organizationId: Uuid;
  reportingPeriodId: Uuid;
  name: string;
  status: 'draft' | 'open' | 'closed';
  dueDate: IsoDate;
  description: string | null;
}

export interface CampaignScope {
  id: Uuid;
  campaignId: Uuid;
  unitId: Uuid;
  metricId: Uuid;
  ownerUserId: Uuid | null;
  dueDate: IsoDate;
}

export const METRIC_DATA_TYPES = ['number', 'integer', 'ratio', 'text', 'boolean'] as const;
export type MetricDataType = (typeof METRIC_DATA_TYPES)[number];

export const AGGREGATION_METHODS = [
  'sum',
  'average',
  'weighted_average',
  'ratio',
  'latest',
  'none',
] as const;
export type AggregationMethod = (typeof AGGREGATION_METHODS)[number];

export const METRIC_CATEGORIES = [
  'ghg',
  'energy',
  'water',
  'waste',
  'human_capital',
  'governance',
  /** 移行リスク資産・資本投下・内部炭素価格など、SSBJ 第2号 第79〜84項の財務寄りの指標 */
  'climate_transition',
] as const;
export type MetricCategory = (typeof METRIC_CATEGORIES)[number];

/** 指標を要求している開示基準。指標マスターの出所を示す */
export const METRIC_FRAMEWORK_KEYS = ['ssbj', 'cdp', 'csrd'] as const;
export type MetricFrameworkKey = (typeof METRIC_FRAMEWORK_KEYS)[number];

export interface MetricDefinition extends AuditColumns, SoftDeletable {
  id: Uuid;
  organizationId: Uuid;
  code: string;
  name: string;
  description: string;
  category: MetricCategory;
  unit: string;
  /** 単位変換の基準単位（例: kg → t なら baseUnit='t'） */
  baseUnit: string;
  dataType: MetricDataType;
  aggregationMethod: AggregationMethod;
  /** ratio 型のときの分子・分母指標 */
  numeratorMetricCode: string | null;
  denominatorMetricCode: string | null;
  formula: string | null;
  requiresEvidence: boolean;
  /** 本社（連結全体）でのみ収集する指標。拠点別のテンプレート・割り当てから除外する。 */
  hqOnly: boolean;
  /**
   * この指標を要求している開示基準。空配列は自社独自の指標。
   * 「基準が求めているのに社内に指標が無い」を機械的に検知するための出所。
   */
  frameworks: MetricFrameworkKey[];
  materiality: 'high' | 'medium' | 'low';
  reportingFrequency: 'annual' | 'quarterly' | 'monthly';
  responsibleDepartment: string | null;
  /** 前年比の許容変動率（超過で警告）。null = 判定しない。 */
  yoyWarningRatio: number | null;
  minValue: number | null;
  maxValue: number | null;
}

export interface MetricAssignment extends AuditColumns {
  id: Uuid;
  organizationId: Uuid;
  metricId: Uuid;
  unitId: Uuid;
  reportingPeriodId: Uuid;
  ownerUserId: Uuid | null;
  reviewerUserId: Uuid | null;
  dueDate: IsoDate;
}

// ======================================================================
// 10.3 Data
// ======================================================================

export const DATA_POINT_STATUSES = [
  'not_started',
  'draft',
  'submitted',
  'in_review',
  'returned',
  'approved',
] as const;
export type DataPointStatus = (typeof DATA_POINT_STATUSES)[number];

export const DATA_SOURCE_TYPES = ['manual', 'import', 'calculation', 'carry_forward'] as const;
export type DataSourceType = (typeof DATA_SOURCE_TYPES)[number];

/**
 * 現在値の区分（0039）。業務キーには含めない（同じ枠に実績と推計を並べない）。
 * 値の出所（sourceType）とは別の軸。
 */
export const VALUE_KINDS = ['actual', 'estimate', 'target'] as const;
export type ValueKind = (typeof VALUE_KINDS)[number];

/**
 * 値の有無の状態（0039）。value が null の理由を区別し、0 と未入力を混同しない。
 * `not_applicable` は人が理由を添えて判断するもので、値が無いことから推測しない。
 */
export const AVAILABILITY_STATUSES = [
  'value_present',
  'not_entered',
  'not_obtained',
  'not_applicable',
  'not_calculated',
] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

export interface DataPoint extends AuditColumns, SoftDeletable {
  id: Uuid;
  organizationId: Uuid;
  metricId: Uuid;
  unitId: Uuid;
  reportingPeriodId: Uuid;
  /** 業務キー: organization_id + metric_id + unit_id + reporting_period_id + boundary */
  boundary: string;
  status: DataPointStatus;
  currentVersionId: Uuid | null;
  value: number | null;
  textValue: string | null;
  unitOfMeasure: string;
  methodology: string | null;
  ownerUserId: Uuid | null;
  reviewerUserId: Uuid | null;
  approvedAt: IsoDateTime | null;
  approvedBy: Uuid | null;
  /** 承認後に変更が入ったか（監査法人向け Change Alert の一次情報） */
  changedAfterApproval: boolean;
  /** 現在値の区分（実績／推計／目標） */
  valueKind: ValueKind;
  /** 値の有無の状態。value_present 以外の行は集計に含めない */
  availabilityStatus: AvailabilityStatus;
  /** 値が無い理由（未取得・対象外・未算定のときに人が書く） */
  absenceReason: string | null;
}

export interface DataPointVersion {
  id: Uuid;
  dataPointId: Uuid;
  organizationId: Uuid;
  versionNo: number;
  value: number | null;
  textValue: string | null;
  unitOfMeasure: string;
  status: DataPointStatus;
  /** その版の時点の区分・値の有無（開示本文はこの版を引用する） */
  valueKind: ValueKind;
  availabilityStatus: AvailabilityStatus;
  absenceReason: string | null;
  sourceType: DataSourceType;
  sourceReference: string | null;
  changeReason: string | null;
  /** 値の同一性検証に使う（Snapshot と突合） */
  contentHash: string;
  createdAt: IsoDateTime;
  createdBy: Uuid | null;
}

export interface DataPointCalculation {
  id: Uuid;
  dataPointId: Uuid;
  organizationId: Uuid;
  formula: string;
  inputs: CalculationInput[];
  result: number;
  resultUnit: string;
  calculatedAt: IsoDateTime;
  calculatedBy: Uuid | null;
}

export interface CalculationInput {
  label: string;
  value: number;
  unit: string;
  sourceType: 'data_point' | 'emission_factor' | 'constant' | 'rate';
  sourceId: Uuid | null;
  note: string | null;
  /**
   * 物理量・金額データ由来の行の活動量（例: 42,000 kWh・5,200 千円）。
   * 排出量原単位の再紐づけ時に value を再計算するために持つ。
   * サプライヤー報告排出量（sourceType 'constant'）や旧形式の行は未設定。
   */
  activityAmount?: number | null;
  activityUnit?: string | null;
  /**
   * 算定データの区分（Scope3 の一次データ比率の定義に使う。W0 O6）。
   * 旧形式の行は未設定で、読み出し側が note・activityUnit から推定する。
   */
  dataClass?: CalculationDataClass;
}

/**
 * 算定データの区分。
 * - supplier_specific: サプライヤー固有の排出量（報告排出量）
 * - activity_based:    活動量（物理量）× 排出係数
 * - spend_based:       購買金額 × 排出係数（推計）
 * 金額ベースを一次データとして数えないために分ける。
 */
export const CALCULATION_DATA_CLASSES = [
  'supplier_specific',
  'activity_based',
  'spend_based',
] as const;
export type CalculationDataClass = (typeof CALCULATION_DATA_CLASSES)[number];

export const VALIDATION_SEVERITIES = ['error', 'warning', 'info'] as const;
export type ValidationSeverity = (typeof VALIDATION_SEVERITIES)[number];

export const VALIDATION_RULE_KEYS = [
  'required',
  'data_type',
  'range',
  'unit_mismatch',
  'unit_inconsistent_across_units',
  'yoy_deviation',
  'ratio_numerator_exceeds_denominator',
  'duplicate',
  'missing_evidence',
  'formula_mismatch',
  'changed_after_approval',
] as const;
export type ValidationRuleKey = (typeof VALIDATION_RULE_KEYS)[number];

export interface DataPointValidationResult {
  id: Uuid;
  dataPointId: Uuid;
  organizationId: Uuid;
  ruleKey: ValidationRuleKey;
  severity: ValidationSeverity;
  message: string;
  details: Record<string, unknown>;
  detectedAt: IsoDateTime;
  resolvedAt: IsoDateTime | null;
}

export interface AggregationRule extends AuditColumns {
  id: Uuid;
  organizationId: Uuid;
  metricId: Uuid;
  method: AggregationMethod;
  includeUnitTypes: UnitType[];
  applyOwnershipPercent: boolean;
  eliminateIntercompany: boolean;
}

export interface AggregationRun {
  id: Uuid;
  organizationId: Uuid;
  reportingPeriodId: Uuid;
  metricId: Uuid;
  status: 'queued' | 'running' | 'completed' | 'failed';
  resultValue: number | null;
  resultUnit: string | null;
  contributingDataPointIds: Uuid[];
  startedAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
  errorMessage: string | null;
}

export interface EmissionFactor {
  id: Uuid;
  organizationId: Uuid;
  code: string;
  name: string;
  category: string;
  factorValue: number;
  factorUnit: string;
  activityUnit: string;
  factorYear: number;
  /** Fixture では必ず「FIXTURE（架空値）」を表示する */
  factorSource: string;
  createdAt: IsoDateTime;
}

// ======================================================================
// 10.4 File / Evidence
// ======================================================================

export const STORAGE_BUCKETS = [
  'brand-public',
  'enterprise-originals-private',
  'evidence-private',
  'assurance-workpapers-private',
  'exports-private',
] as const;
export type StorageBucket = (typeof STORAGE_BUCKETS)[number];

export const CONFIDENTIALITY_LEVELS = ['public', 'internal', 'confidential', 'restricted'] as const;
export type ConfidentialityLevel = (typeof CONFIDENTIALITY_LEVELS)[number];

/**
 * 根拠資料の利用目的（0034）。
 * current_fact 以外（前年度の記載・文体の参考）は当年度の事実の根拠として引用しない。
 */
export const EVIDENCE_USAGE_PURPOSES = [
  'current_fact',
  'prior_year_text',
  'style_reference',
] as const;
export type EvidenceUsagePurpose = (typeof EVIDENCE_USAGE_PURPOSES)[number];

export interface FileObject extends AuditColumns, SoftDeletable {
  id: Uuid;
  organizationId: Uuid;
  bucket: StorageBucket;
  originalName: string;
  mimeType: string;
  confidentiality: ConfidentialityLevel;
  currentVersionId: Uuid | null;
  documentType: string | null;
  reportingPeriodId: Uuid | null;
  /** ウイルススキャン結果。Interface 化のみ（Phase 1 は 'skipped'）。 */
  scanStatus: 'pending' | 'clean' | 'infected' | 'skipped';
  /** 利用目的。null は未設定（当年度の根拠としては扱わない） */
  usagePurpose: EvidenceUsagePurpose | null;
  /** 版の表示名（例: 2025 年 6 月発行版） */
  editionLabel: string | null;
  issuedOn: IsoDate | null;
}

export interface FileVersion {
  id: Uuid;
  fileId: Uuid;
  organizationId: Uuid;
  versionNo: number;
  /** Original Name とは分離した安全なキー。Path Traversal 不能。 */
  storageKey: string;
  sizeBytes: number;
  sha256: string;
  createdAt: IsoDateTime;
  createdBy: Uuid | null;
}

export const EVIDENCE_TARGET_TYPES = [
  'data_point',
  'disclosure_response',
  'assurance_test',
  'pbc_request_response',
  'assurance_issue',
] as const;
export type EvidenceTargetType = (typeof EVIDENCE_TARGET_TYPES)[number];

export interface EvidenceLink extends AuditColumns {
  id: Uuid;
  organizationId: Uuid;
  fileVersionId: Uuid;
  targetType: EvidenceTargetType;
  targetId: Uuid;
  page: number | null;
  cellRef: string | null;
  fragmentId: Uuid | null;
  sourceUrl: string | null;
  coveragePeriodStart: IsoDate | null;
  coveragePeriodEnd: IsoDate | null;
  obtainedAt: IsoDate | null;
  note: string | null;
}

export interface ExtractedFragment {
  id: Uuid;
  fileVersionId: Uuid;
  organizationId: Uuid;
  page: number;
  kind: 'text' | 'table' | 'cell';
  text: string;
  locator: string | null;
  createdAt: IsoDateTime;
}

export interface StorageAccessEvent {
  id: Uuid;
  organizationId: Uuid;
  actorUserId: Uuid;
  fileVersionId: Uuid;
  action: 'signed_url_created' | 'downloaded' | 'viewed';
  engagementId: Uuid | null;
  expiresAt: IsoDateTime | null;
  createdAt: IsoDateTime;
}

// ======================================================================
// 10.5 Workflow
// ======================================================================

export const WORKFLOW_STEP_KEYS = ['input', 'review', 'approval'] as const;
export type WorkflowStepKey = (typeof WORKFLOW_STEP_KEYS)[number];

export interface WorkflowDefinition {
  id: Uuid;
  organizationId: Uuid;
  key: string;
  name: string;
  targetType: 'data_point' | 'disclosure_response';
  steps: WorkflowStepKey[];
}

export interface WorkflowInstance extends AuditColumns {
  id: Uuid;
  organizationId: Uuid;
  definitionId: Uuid;
  targetType: 'data_point' | 'disclosure_response';
  targetId: Uuid;
  currentStep: WorkflowStepKey;
  status: 'open' | 'completed' | 'cancelled';
}

export interface WorkflowStep {
  id: Uuid;
  instanceId: Uuid;
  organizationId: Uuid;
  stepKey: WorkflowStepKey;
  assigneeUserId: Uuid | null;
  status: 'pending' | 'active' | 'done' | 'skipped';
  enteredAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
}

export const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface WorkTask extends AuditColumns {
  id: Uuid;
  organizationId: Uuid;
  title: string;
  description: string | null;
  targetType: string;
  targetId: Uuid | null;
  assigneeUserId: Uuid | null;
  dueDate: IsoDate | null;
  status: TaskStatus;
  priority: Priority;
  engagementId: Uuid | null;
}

export const APPROVAL_DECISIONS = ['approved', 'returned'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export interface Approval {
  id: Uuid;
  organizationId: Uuid;
  targetType: 'data_point' | 'disclosure_response';
  targetId: Uuid;
  targetVersionId: Uuid | null;
  stage: 'review' | 'final';
  decision: ApprovalDecision;
  actorUserId: Uuid;
  comment: string | null;
  decidedAt: IsoDateTime;
}

// ----------------------------------------------------------------------
// 承認の道筋（最大 5 階層）
// ----------------------------------------------------------------------

/** 承認段階は最大 5 階層。これ以上は業務上現実的でなく、検証も発散する */
export const MAX_APPROVAL_STAGES = 5;

export const APPROVAL_STEP_STATUSES = [
  /** 前の段階が終わっていない */
  'waiting',
  /** この段階の承認待ち */
  'pending',
  'approved',
  'returned',
] as const;
export type ApprovalStepStatus = (typeof APPROVAL_STEP_STATUSES)[number];

/** 承認の道筋のテンプレート */
export interface ApprovalRoute extends AuditColumns {
  id: Uuid;
  organizationId: Uuid;
  name: string;
  description: string;
  /** 指定が無いデータに使う道筋。組織にひとつだけ true */
  isDefault: boolean;
}

/** 道筋の 1 段階 */
export interface ApprovalRouteStage extends SoftDeletable {
  id: Uuid;
  organizationId: Uuid;
  routeId: Uuid;
  /** 1 から 5 */
  stageNo: number;
  name: string;
  /** この段階を承認できる役割。空なら承認権限を持つ誰でも */
  approverRole: string;
  /** 承認者を個人まで指定する場合。null なら役割で判定する */
  approverUserId: Uuid | null;
  department: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/**
 * データごとの承認段階。道筋の写しで、いつ誰が承認・差し戻したかを段階ごとに残す。
 *
 * 差し戻し後に出し直すと round が増え、前の巡の記録はそのまま残る
 * （何度差し戻されたかが後から辿れる）。
 */
export interface DataPointApprovalStep {
  id: Uuid;
  organizationId: Uuid;
  dataPointId: Uuid;
  routeId: Uuid | null;
  stageNo: number;
  stageName: string;
  approverRole: string;
  approverUserId: Uuid | null;
  department: string;
  status: ApprovalStepStatus;
  decidedAt: IsoDateTime | null;
  decidedBy: Uuid | null;
  comment: string;
  /** 何回目の申請か */
  round: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface Comment extends AuditColumns {
  id: Uuid;
  organizationId: Uuid;
  targetType: string;
  targetId: Uuid;
  body: string;
  authorUserId: Uuid;
  /** internal = 自テナント内のみ。shared = 相手テナントにも見える。 */
  visibility: 'internal' | 'shared';
  mentions: Uuid[];
}

export interface Notification {
  id: Uuid;
  organizationId: Uuid;
  userId: Uuid;
  title: string;
  body: string;
  category: 'task' | 'alert' | 'pbc' | 'review' | 'system';
  href: string | null;
  readAt: IsoDateTime | null;
  createdAt: IsoDateTime;
}

export const ALERT_KINDS = [
  'overdue',
  'not_submitted',
  'validation_error',
  'missing_evidence',
  'changed_after_approval',
  'question_updated',
  'assurance_request',
  'snapshot_change',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export interface Alert {
  id: Uuid;
  organizationId: Uuid;
  kind: AlertKind;
  severity: Priority;
  title: string;
  detail: string;
  targetType: string;
  targetId: Uuid | null;
  href: string;
  resolvedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
}

// ======================================================================
// 10.6 Disclosure
// ======================================================================

/**
 * `esrs_40a` は EU 域外企業向け ESRS（Art. 40a）。CSRD（EU 法人向け）とは
 * 重要性の考え方も適用条件も異なるため、別フレームワークとして持つ（0034）。
 */
export const FRAMEWORK_KEYS = ['cdp', 'ssbj', 'csrd', 'esrs_40a', 'msci', 'ftse'] as const;
export type FrameworkKey = (typeof FRAMEWORK_KEYS)[number];

export interface DisclosureFramework {
  id: Uuid;
  key: FrameworkKey;
  name: string;
  description: string;
}

/** 基準の版の法的な位置付け（0034）。sample は架空の縮小マスター */
export const FRAMEWORK_LEGAL_STATUSES = [
  'draft',
  'adopted',
  'promulgated',
  'effective',
  'superseded',
  'sample',
] as const;
export type FrameworkLegalStatus = (typeof FRAMEWORK_LEGAL_STATUSES)[number];

/** 要求事項の収録範囲（0034）。not_loaded は版だけ登録して要求事項を収録していない */
export const FRAMEWORK_COVERAGE_STATUSES = [
  'full_for_scope',
  'partial',
  'not_loaded',
  'sample',
] as const;
export type FrameworkCoverageStatus = (typeof FRAMEWORK_COVERAGE_STATUSES)[number];

/** 基準が求める重要性の考え方（0034）。ESRS-40a 草案はインパクト重要性 */
export const MATERIALITY_BASES = ['financial', 'impact', 'double', 'not_specified'] as const;
export type MaterialityBasis = (typeof MATERIALITY_BASES)[number];

export interface DisclosureFrameworkVersion {
  id: Uuid;
  frameworkId: Uuid;
  year: number;
  label: string;
  status: 'draft' | 'published' | 'superseded';
  /** Fixture である旨を UI に必ず出す */
  isFixture: boolean;
  createdAt: IsoDateTime;
  // 以下は 0034 で追加した版メタデータ。すべて null 可で、未確認のものを推測で埋めない
  versionCode: string | null;
  legalStatus: FrameworkLegalStatus | null;
  issuedAt: IsoDate | null;
  effectiveAt: IsoDate | null;
  jurisdiction: string | null;
  materialityBasis: MaterialityBasis | null;
  sourceUrl: string | null;
  verifiedAt: IsoDate | null;
  verifiedBy: string | null;
  coverageStatus: FrameworkCoverageStatus | null;
  coverageNote: string | null;
}

export const ANSWER_TYPES = ['text', 'numeric', 'single_choice', 'multi_choice', 'table'] as const;
export type AnswerType = (typeof ANSWER_TYPES)[number];

export const ITEM_CHANGE_TYPES = ['new', 'changed', 'carry_forward', 'retired'] as const;
export type ItemChangeType = (typeof ITEM_CHANGE_TYPES)[number];

export interface DisclosureItem {
  id: Uuid;
  frameworkVersionId: Uuid;
  code: string;
  section: string;
  sortOrder: number;
  questionText: string;
  guidance: string;
  answerType: AnswerType;
  options: string[];
  required: boolean;
  parentCode: string | null;
  /** 前年 Version からの差分区分 */
  changeType: ItemChangeType;
  previousItemCode: string | null;
  createdAt: IsoDateTime;
}

export interface DisclosureItemCondition {
  id: Uuid;
  itemId: Uuid;
  /** 依存する質問コード */
  dependsOnItemCode: string;
  operator: 'equals' | 'not_equals' | 'in' | 'exists';
  value: string;
}

export const MATERIALITY_LEVELS = [
  'high',
  'medium',
  'low',
  'not_material',
  'not_assessed',
] as const;
export type MaterialityLevel = (typeof MATERIALITY_LEVELS)[number];

export const MATERIALITY_CATEGORIES = ['environment', 'social', 'governance'] as const;
export type MaterialityCategory = (typeof MATERIALITY_CATEGORIES)[number];

/**
 * マテリアリティ評価（SSBJ 開示の起点）。
 * 組織 × 報告期間 × トピックで一意。対象指標は code で保持する。
 */
export interface MaterialityTopic extends AuditColumns, SoftDeletable {
  id: Uuid;
  organizationId: Uuid;
  reportingPeriodId: Uuid;
  topicKey: string;
  title: string;
  /** 課題の内容の簡潔な説明。区分の提示（名前と内容を合わせて判断）にも使う */
  description: string;
  category: MaterialityCategory;
  materiality: MaterialityLevel;
  rationale: string;
  /** この課題がもたらすリスク（SSBJ 一般-12(1)・一般-14 の識別。戦略開示の材料） */
  risks: string;
  /** この課題がもたらす機会（同上） */
  opportunities: string;
  metricCodes: string[];
  assessedAt: IsoDateTime | null;
  assessedBy: Uuid | null;
}

export interface ApplicabilityResult {
  id: Uuid;
  organizationId: Uuid;
  itemId: Uuid;
  reportingPeriodId: Uuid;
  applicability: 'applicable' | 'not_applicable' | 'needs_check';
  reason: string;
  evaluatedAt: IsoDateTime;
}

export const RESPONSE_STATUSES = [
  'not_started',
  'draft',
  'in_review',
  'returned',
  'approved',
] as const;
export type ResponseStatus = (typeof RESPONSE_STATUSES)[number];

export interface DisclosureResponse extends AuditColumns {
  id: Uuid;
  organizationId: Uuid;
  itemId: Uuid;
  reportingPeriodId: Uuid;
  status: ResponseStatus;
  currentVersionId: Uuid | null;
  answerText: string | null;
  answerNumeric: number | null;
  answerChoice: string[];
  ownerUserId: Uuid | null;
  reviewerUserId: Uuid | null;
  approvedAt: IsoDateTime | null;
  approvedBy: Uuid | null;
  /** 前年度の回答（Carry Forward 判定用） */
  previousResponseId: Uuid | null;
  carryForwardDecision: 'reuse' | 'update' | 'new' | null;
}

export interface DisclosureResponseVersion {
  id: Uuid;
  responseId: Uuid;
  organizationId: Uuid;
  versionNo: number;
  answerText: string | null;
  answerNumeric: number | null;
  answerChoice: string[];
  status: ResponseStatus;
  /** AI Draft 由来かどうか。人が編集して確定するまで approved にできない。 */
  originatedFromAiRunId: Uuid | null;
  changeReason: string | null;
  contentHash: string;
  createdAt: IsoDateTime;
  createdBy: Uuid | null;
}

export interface DisclosureMapping extends AuditColumns {
  id: Uuid;
  organizationId: Uuid;
  itemId: Uuid;
  metricId: Uuid;
  unitId: Uuid | null;
  /** 値の変換式（例: "value / 1000"）。null = そのまま。 */
  transform: string | null;
  mappingSource: 'manual' | 'ai_suggested';
  aiRunId: Uuid | null;
  confirmedBy: Uuid | null;
  confirmedAt: IsoDateTime | null;
}

export interface ResponseEvidenceLink {
  id: Uuid;
  organizationId: Uuid;
  responseId: Uuid;
  evidenceLinkId: Uuid;
  createdAt: IsoDateTime;
}

// ----------------------------------------------------------------------
// SSBJ ギャップ分析
//
// SSBJ 対応は「要求事項を ○△× で採点する」ものではない。
//   ① その企業に適用される要求事項か（適用区分）
//   ② その情報に重要性があるか（重要性）
//   ③ 現在どこまで対応できているか（対応状況）
// を分けて管理する。さらに③は 1 つの要求事項に対して
//   開示（資料に書かれているか）／データ（社内で取得できているか）／
//   業務プロセス・内部統制（継続的に正確に集められる仕組みがあるか）
// の 3 観点で別々に評価する。
//
// AI の判定はそのまま最終判定にしない。必ず担当者の確認を挟む
// （AI は確定しない・CLAUDE.md §0.4）。
// ----------------------------------------------------------------------

/** 対応状況。単純な ○△× ではなく、現在の状況が具体的に分かる 5 段階 */
export const SSBJ_COVERAGE_STATUSES = [
  'covered',
  'mostly_covered',
  'partial',
  'not_covered',
  'unconfirmed',
] as const;
export type SsbjCoverageStatus = (typeof SSBJ_COVERAGE_STATUSES)[number];

/** ギャップの種類（開示／データ／業務プロセス・内部統制） */
export const SSBJ_GAP_KINDS = ['disclosure', 'data', 'process'] as const;
export type SsbjGapKind = (typeof SSBJ_GAP_KINDS)[number];

/** 適用区分。対応状況とは別に管理する */
export const SSBJ_APPLICABILITIES = ['applicable', 'not_applicable'] as const;
export type SsbjApplicability = (typeof SSBJ_APPLICABILITIES)[number];

/** 重要性。適用区分・対応状況とは別に管理する */
export const SSBJ_MATERIALITIES = ['material', 'not_material', 'not_assessed'] as const;
export type SsbjMateriality = (typeof SSBJ_MATERIALITIES)[number];

/** 担当者による確認の結果（AI 判定を承認したか、修正したか） */
export const SSBJ_REVIEW_DECISIONS = ['approved', 'modified'] as const;
export type SsbjReviewDecision = (typeof SSBJ_REVIEW_DECISIONS)[number];

/** 優先度の 3 段階 */
export const SSBJ_PRIORITIES = ['high', 'medium', 'low'] as const;
export type SsbjPriority = (typeof SSBJ_PRIORITIES)[number];

/**
 * 要求事項ごとの評価。組織 × 報告期間 × 要求事項で一意。
 *
 * 優先度は保存しない。重要性・3 観点の対応状況・必須区分から毎回計算する
 * （保存すると入力が変わったときに古い優先度が残り、根拠と食い違うため）。
 */
export interface SsbjAssessment extends AuditColumns {
  id: Uuid;
  organizationId: Uuid;
  reportingPeriodId: Uuid;
  /** disclosure_items.id（SSBJ 版の要求事項） */
  itemId: Uuid;

  applicability: SsbjApplicability;
  applicabilityReason: string;
  materiality: SsbjMateriality;
  materialityReason: string;

  /** ③ 対応状況を 3 観点で持つ */
  disclosureStatus: SsbjCoverageStatus;
  dataStatus: SsbjCoverageStatus;
  processStatus: SsbjCoverageStatus;

  /** AI による判定（候補）。承認されるまで最終判定にはならない */
  aiStatus: SsbjCoverageStatus | null;
  aiComment: string;
  /** 不足している情報の列挙 */
  aiMissingInfo: string[];
  aiRecommendation: string;
  aiRunId: Uuid | null;
  aiEvaluatedAt: IsoDateTime | null;

  /** AI が既存資料から見つけた該当箇所（判定の根拠） */
  sourceDocument: string | null;
  sourcePage: string | null;
  sourceExcerpt: string | null;

  /** 担当者による確認 */
  reviewDecision: SsbjReviewDecision | null;
  reviewedBy: Uuid | null;
  reviewedAt: IsoDateTime | null;
  reviewComment: string;

  /** 最終判定。担当者が確認して初めて入る */
  finalStatus: SsbjCoverageStatus | null;

  /** 担当部署・担当者（要求事項の一次窓口） */
  ownerDepartment: string;
  ownerUserId: Uuid | null;

  /** 前年度の評価から引き継いだか */
  carriedOverFrom: Uuid | null;
  /** 今年度に再評価が必要と判定された理由（引き継ぎ時に設定） */
  recheckReason: string;
}

/** 連結範囲の考え方 */
export const SSBJ_CONSOLIDATION_SCOPES = ['same_as_financial', 'custom'] as const;
export type SsbjConsolidationScope = (typeof SSBJ_CONSOLIDATION_SCOPES)[number];

/** バリューチェーンをどこまで報告に含めるか */
export const SSBJ_VALUE_CHAIN_SCOPES = [
  'not_decided',
  'upstream',
  'downstream',
  'both',
  'none',
] as const;
export type SsbjValueChainScope = (typeof SSBJ_VALUE_CHAIN_SCOPES)[number];

/**
 * SSBJ 対応の分析条件。組織 × 報告期間で 1 件。
 *
 * 8 ステップの入口である①で決めるもの。ここが確定しないと、
 * どの要求事項を評価対象にするのか自体が定まらない。
 * confirmedAt は人の操作でのみ入る（AI は確定しない）。
 */
export interface SsbjAnalysisSettings extends AuditColumns {
  id: Uuid;
  organizationId: Uuid;
  reportingPeriodId: Uuid;

  /** 適用する基準 */
  applyGeneral: boolean;
  applyClimate: boolean;
  applyPractical: boolean;
  /** 初年度適用（経過措置を使うか） */
  firstTimeAdoption: boolean;

  /** 報告の範囲 */
  consolidationScope: SsbjConsolidationScope;
  consolidationNote: string;
  /** 報告対象に含める組織・拠点。空配列は全社（未指定） */
  includedUnitIds: Uuid[];
  valueChainScope: SsbjValueChainScope;
  valueChainNote: string;

  /** 確定日時。null は未完了 */
  confirmedAt: IsoDateTime | null;
  confirmedBy: Uuid | null;
}

/**
 * SSBJ 開示ドラフトの節ごとの草案。
 *
 * AI が書いた文章（aiBody）と、人が直した文章（body）を分けて持つ。
 * 分けておかないと「どこを人が直したのか」が分からなくなり、
 * AI の出力をそのまま開示したのかどうかを後から説明できない。
 */
export interface SsbjDisclosureDraft extends AuditColumns {
  id: Uuid;
  organizationId: Uuid;
  reportingPeriodId: Uuid;
  /** 開示書類の節。src/lib/domain/ssbj.ts の SsbjArea と対応する */
  area: 'governance' | 'strategy' | 'risk' | 'metrics' | 'other';

  /** 開示に載せる文章（人が直したもの） */
  body: string;
  /** AI が草案を書いた時点の本文 */
  aiBody: string;
  coveredItemCodes: string[];
  /** 書けなかった箇所 */
  gaps: Array<{ itemCode: string; reason: string }>;

  aiRunId: Uuid | null;
  aiConfidence: number | null;
  aiWarnings: string[];
  aiGeneratedAt: IsoDateTime | null;

  /** 人が確定した日時。null は未確定。AI では入らない */
  confirmedAt: IsoDateTime | null;
  confirmedBy: Uuid | null;
}

/** 対応区分。ギャップに対して何をするか */
export const SSBJ_ACTION_TYPES = [
  'data_collection',
  'disclosure_addition',
  'governance',
  'policy',
  'internal_control',
  'system',
  'calculation_method',
] as const;
export type SsbjActionType = (typeof SSBJ_ACTION_TYPES)[number];

/** 対応状況（対応計画側） */
export const SSBJ_ACTION_STATUSES = ['not_started', 'in_progress', 'in_review', 'done'] as const;
export type SsbjActionStatus = (typeof SSBJ_ACTION_STATUSES)[number];

/**
 * 対応計画。ギャップ（要求事項 × 観点）ごとに、誰がいつまでに何をするかを持つ。
 * データ収集が必要な場合は `linkedMetricCode` で指標マスターへ接続する。
 */
export interface SsbjActionPlan extends AuditColumns {
  id: Uuid;
  organizationId: Uuid;
  reportingPeriodId: Uuid;
  assessmentId: Uuid;
  /** どの観点のギャップに対する対応か */
  gapKind: SsbjGapKind;
  title: string;
  detail: string;
  actionType: SsbjActionType;
  department: string;
  assigneeUserId: Uuid | null;
  dueDate: IsoDate | null;
  priority: SsbjPriority;
  status: SsbjActionStatus;
  /** データ収集項目を作った場合の指標コード */
  linkedMetricCode: string | null;
}

// ======================================================================
// 開示優先モード（docs/disclosure-first.md §3・§4。migration 0033〜0039）
//
// 表示ラベルは src/lib/domain/disclosure-status.ts に集約する（画面ごとに訳さない）。
// ======================================================================

/** 組織単位の機能設定（0033）。行が無い組織は既定値（disclosureFirst = false）として扱う */
export interface OrganizationFeatureSettings extends AuditColumns {
  id: Uuid;
  organizationId: Uuid;
  disclosureFirst: boolean;
}

export const DISCLOSURE_PURPOSES = [
  'ssbj_statutory',
  'ssbj_voluntary',
  'csrd_40a_prep',
  'csrd_eu_entity',
  'internal_esg',
] as const;
export type DisclosurePurpose = (typeof DISCLOSURE_PURPOSES)[number];

export const DISCLOSURE_LANGUAGES = ['ja', 'en'] as const;
export type DisclosureLanguage = (typeof DISCLOSURE_LANGUAGES)[number];

export const DISCLOSURE_PROJECT_STATUSES = ['preparing', 'active', 'closed'] as const;
export type DisclosureProjectStatus = (typeof DISCLOSURE_PROJECT_STATUSES)[number];

/** 開示プロジェクト（0035）。報告期間・目的・担当・報告範囲を束ねる */
export interface DisclosureProject extends AuditColumns, SoftDeletable {
  id: Uuid;
  organizationId: Uuid;
  reportingPeriodId: Uuid;
  name: string;
  reportingEntity: string;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  currency: string;
  purposes: DisclosurePurpose[];
  languages: DisclosureLanguage[];
  ownerUserId: Uuid | null;
  reviewerUserId: Uuid | null;
  finalApproverUserId: Uuid | null;
  dueDate: IsoDate | null;
  scopeOrgNote: string;
  scopeConsolidationNote: string;
  scopeGhgBoundaryNote: string;
  scopeValueChainNote: string;
  /** 報告対象に含める組織・拠点。空配列は全社（未指定） */
  includedUnitIds: Uuid[];
  status: DisclosureProjectStatus;
}

export const APPLICABILITY_STATUSES = [
  'not_assessed',
  'candidate',
  'applicable',
  'not_applicable',
  'voluntary',
  'awaiting_confirmation',
] as const;
export type ApplicabilityStatus = (typeof APPLICABILITY_STATUSES)[number];

/**
 * 適用条件の入力（§8.4: EU 域内売上・従業員数など）。
 * 未入力の項目はキー自体を持たない（0 と「分からない」を混同しない）。
 */
export type FrameworkConditionValue = number | string | boolean | null;
export type FrameworkConditions = Record<string, FrameworkConditionValue>;

/** プロジェクトが扱う基準の版と適用区分（0035）。保存しただけでは判断は確定しない */
export interface ProjectFramework extends AuditColumns {
  id: Uuid;
  organizationId: Uuid;
  projectId: Uuid;
  /** 使う版を固定する（最新版を引き直すと、改正で黙って判断根拠が変わる） */
  frameworkVersionId: Uuid;
  purpose: DisclosurePurpose;
  applicabilityStatus: ApplicabilityStatus;
  currentDecisionId: Uuid | null;
  conditions: FrameworkConditions;
}

/** 適用判断の確定記録（0035・追記専用）。未判定（not_assessed）は確定できない */
export interface ProjectFrameworkDecision {
  id: Uuid;
  organizationId: Uuid;
  projectFrameworkId: Uuid;
  decisionNo: number;
  applicabilityStatus: Exclude<ApplicabilityStatus, 'not_assessed'>;
  reason: string;
  /** 参照した規則とその版 */
  ruleRef: string;
  /** 規則を確認した日 */
  confirmedOn: IsoDate;
  transitionalNote: string | null;
  /** 判断時点の適用条件の写し */
  conditionsSnapshot: FrameworkConditions;
  decidedBy: Uuid;
  decidedAt: IsoDateTime;
}

export const NARRATIVE_THEMES = [
  'risk_opportunity',
  'financial_impact',
  'governance',
  'strategy',
  'policy_other',
] as const;
export type NarrativeTheme = (typeof NARRATIVE_THEMES)[number];

export const NARRATIVE_STATUSES = ['draft', 'confirmed', 'needs_recheck'] as const;
export type NarrativeStatus = (typeof NARRATIVE_STATUSES)[number];

/** 定性情報の台帳（0036）。内容は NarrativeVersion に版として追記する */
export interface NarrativeRecord extends AuditColumns, SoftDeletable {
  id: Uuid;
  organizationId: Uuid;
  theme: NarrativeTheme;
  title: string;
  ownerUserId: Uuid | null;
  ownerDepartment: string;
  tags: string[];
  status: NarrativeStatus;
  currentVersionId: Uuid | null;
  /** 人が確認した版。確認後に版を追加しても残る */
  confirmedVersionId: Uuid | null;
  confirmedBy: Uuid | null;
  confirmedAt: IsoDateTime | null;
}

/** 定性情報の版（0036・追記専用） */
export interface NarrativeVersion {
  id: Uuid;
  organizationId: Uuid;
  narrativeRecordId: Uuid;
  versionNo: number;
  reportingPeriodId: Uuid;
  scopeNote: string;
  /** テンプレート項目。値が無い項目はキー自体を持たない */
  fields: Record<string, string>;
  body: string;
  sourceAnchorIds: Uuid[];
  carriedFromVersionId: Uuid | null;
  changeReason: string | null;
  /** AI の候補を人が採用して作った版なら、その実行 ID */
  originatedFromAiRunId: Uuid | null;
  contentHash: string;
  createdAt: IsoDateTime;
  createdBy: Uuid | null;
}

export const ANCHOR_KINDS = [
  'pdf_page',
  'heading_paragraph',
  'sheet_cell',
  'text_range',
  'manual_excerpt',
] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

export const ANCHOR_ACQUIRED_BY = ['manual', 'extracted'] as const;
export type AnchorAcquiredBy = (typeof ANCHOR_ACQUIRED_BY)[number];

/** 根拠資料の引用位置（0036・追記専用）。利用目的は FileObject.usagePurpose で判定する */
export interface SourceAnchor {
  id: Uuid;
  organizationId: Uuid;
  fileVersionId: Uuid;
  /** extracted のときは必須（抽出結果を指す） */
  fragmentId: Uuid | null;
  anchorKind: AnchorKind;
  /** pdf_page のときは必須 */
  page: number | null;
  /** 見出し・段落番号・シート!セル */
  locator: string | null;
  /** 引用した文言の写し */
  quoteText: string;
  acquiredBy: AnchorAcquiredBy;
  createdAt: IsoDateTime;
  createdBy: Uuid | null;
}

// ----------------------------------------------------------------------
// 本文 AST（§4）。disclosure_block_versions.body / disclosure_blocks.working_body の中身。
// 数値・定性情報は「版」を参照し、表示用の文字列は挿入・採用時点の値を持つ
// （参照先に新しい版ができても、承認済み本文の見た目が黙って変わらないように）。
// ----------------------------------------------------------------------

export type BlockInline =
  | { t: 'text'; text: string }
  /** 表示用文字列は挿入時の値 */
  | { t: 'metric'; dataPointId: Uuid; dataPointVersionId: Uuid; display: string }
  /** 採用時の本文を保持 */
  | { t: 'narrative'; narrativeVersionId: Uuid; quote: string }
  /** 出典印 */
  | { t: 'cite'; sourceAnchorId: Uuid };

export interface BlockParagraph {
  /** 安定 ID（差戻し・コメントの紐付け先）。編集しても変えない */
  id: string;
  kind: 'paragraph' | 'heading';
  children: BlockInline[];
  /** AI の候補を採用した段落なら、その実行 ID */
  aiRunId?: Uuid;
}

export interface BlockBody {
  paragraphs: BlockParagraph[];
}

export const BLOCK_STATUSES = [
  'draft',
  'review_requested',
  'returned',
  'approval_pending',
  'approved',
] as const;
export type BlockStatus = (typeof BLOCK_STATUSES)[number];

/** 開示本文の節（0037）。本文そのものは DisclosureBlockVersion に版として追記する */
export interface DisclosureBlock extends AuditColumns, SoftDeletable {
  id: Uuid;
  organizationId: Uuid;
  projectId: Uuid;
  /** プロジェクトが扱う基準の版（ProjectFramework にある版に限る） */
  frameworkVersionId: Uuid;
  sectionKey: string;
  title: string;
  sortOrder: number;
  language: DisclosureLanguage;
  translationOfBlockId: Uuid | null;
  requirementItemIds: Uuid[];
  ownerUserId: Uuid | null;
  dueDate: IsoDate | null;
  status: BlockStatus;
  currentVersionId: Uuid | null;
  /** レビュー依頼で固定した版 */
  submittedVersionId: Uuid | null;
  /** 承認された版。承認後に修正しても残る */
  approvedVersionId: Uuid | null;
  /** 自動保存中の作業本文。業務上の版ではない */
  workingBody: BlockBody | null;
  workingBaseVersionId: Uuid | null;
  workingSavedAt: IsoDateTime | null;
}

export const BLOCK_VERSION_ORIGINS = ['human', 'human_adopted_ai'] as const;
export type BlockVersionOrigin = (typeof BLOCK_VERSION_ORIGINS)[number];

/** 開示本文の版（0037・追記専用）。版は必ず人が保存する */
export interface DisclosureBlockVersion {
  id: Uuid;
  organizationId: Uuid;
  blockId: Uuid;
  versionNo: number;
  baseVersionId: Uuid | null;
  body: BlockBody;
  plainText: string;
  /** 引用した data_point_versions.id */
  metricRefs: Uuid[];
  /** 引用した narrative_versions.id */
  narrativeRefs: Uuid[];
  /** 出典印の source_anchors.id */
  anchorRefs: Uuid[];
  changeReason: string | null;
  origin: BlockVersionOrigin;
  originatedFromAiRunId: Uuid | null;
  contentHash: string;
  createdAt: IsoDateTime;
  createdBy: Uuid;
}

export const REVIEW_TARGET_TYPES = ['disclosure_block'] as const;
export type ReviewTargetType = (typeof REVIEW_TARGET_TYPES)[number];

export const REVIEW_REQUEST_STATUSES = [
  'open',
  'returned',
  'reviewed',
  'approved',
  'withdrawn',
] as const;
export type ReviewRequestStatus = (typeof REVIEW_REQUEST_STATUSES)[number];

/** 依頼時点の規則の写し（review_requests.policy）。後から規則を変えても依頼の判断基準は変わらない */
export interface ReviewPolicy {
  /** policy_version と同じ値（例: sod-3role-v1） */
  version: string;
  /** 依頼の後に通す段階（第 1 段レビュー → 最終承認） */
  stages: Array<'review' | 'final'>;
  /** 依頼者・対象版の作成者はレビュー完了できない */
  forbidRequesterOrAuthorReview: boolean;
  /** 依頼者・対象版の作成者・同じ依頼のレビュー完了者は最終承認できない */
  forbidRequesterAuthorOrReviewerApproval: boolean;
  /** 差戻しには理由と対象段落を必須にする */
  requireReturnReasonAndParagraph: boolean;
}

/** 依頼時点で本文が引用していた版（review_requests.referenced_versions） */
export interface ReviewReferencedVersions {
  metricVersionIds: Uuid[];
  narrativeVersionIds: Uuid[];
  anchorIds: Uuid[];
}

/** レビュー依頼（0037）。対象の版・規則・参照版を依頼時点で固定する */
export interface ReviewRequest extends AuditColumns {
  id: Uuid;
  organizationId: Uuid;
  projectId: Uuid;
  targetType: ReviewTargetType;
  targetId: Uuid;
  targetVersionId: Uuid;
  requestedBy: Uuid;
  reviewerUserId: Uuid | null;
  approverUserId: Uuid | null;
  policyVersion: string;
  policy: ReviewPolicy;
  /** 依頼時点の適用判断の版（ProjectFrameworkDecision.id） */
  decisionIds: Uuid[];
  referencedVersions: ReviewReferencedVersions;
  status: ReviewRequestStatus;
}

export const REVIEW_EVENT_TYPES = [
  'requested',
  'returned',
  'review_completed',
  'approved',
  'withdrawn',
] as const;
export type ReviewEventType = (typeof REVIEW_EVENT_TYPES)[number];

export const REVIEW_STAGES = ['request', 'review', 'final'] as const;
export type ReviewStage = (typeof REVIEW_STAGES)[number];

/**
 * レビューの記録（0037・追記専用）。
 * 職務分離と差戻しの必須項目は DB トリガ（t4d.enforce_review_event）でも強制する。
 */
export interface ReviewEvent {
  id: Uuid;
  organizationId: Uuid;
  reviewRequestId: Uuid;
  eventType: ReviewEventType;
  stage: ReviewStage;
  actorUserId: Uuid;
  /** 依頼で固定した版と同じ値でなければならない */
  targetVersionId: Uuid;
  reason: string | null;
  /** 差戻しの対象段落（BlockParagraph.id） */
  paragraphId: string | null;
  /** 依頼 ID＋段階＋対象版。二重押下で同じ判断を 2 回記録しない */
  idempotencyKey: string | null;
  createdAt: IsoDateTime;
}

export const REVIEW_COMMENT_SEVERITIES = ['info', 'major'] as const;
export type ReviewCommentSeverity = (typeof REVIEW_COMMENT_SEVERITIES)[number];

/** 版・段落に紐付くレビューコメント（0037）。更新できるのは解決の記録だけ */
export interface ReviewComment {
  id: Uuid;
  organizationId: Uuid;
  blockId: Uuid;
  blockVersionId: Uuid;
  paragraphId: string | null;
  body: string;
  /** 未解決の major はレビュー完了・承認の阻害条件 */
  severity: ReviewCommentSeverity;
  createdAt: IsoDateTime;
  createdBy: Uuid;
  resolvedAt: IsoDateTime | null;
  resolvedBy: Uuid | null;
  resolutionNote: string | null;
}

export const RECHECK_REF_KINDS = ['metric', 'narrative'] as const;
export type RecheckRefKind = (typeof RECHECK_REF_KINDS)[number];

export const RECHECK_DECISIONS = ['adopt_new', 'keep_old', 'return_to_owner'] as const;
export type RecheckDecisionKind = (typeof RECHECK_DECISIONS)[number];

/** 引用先が更新されたときの判断（0037・追記専用） */
export interface RecheckDecision {
  id: Uuid;
  organizationId: Uuid;
  blockId: Uuid;
  blockVersionId: Uuid;
  refKind: RecheckRefKind;
  /** refKind に応じて data_point_versions.id / narrative_versions.id */
  oldRefId: Uuid;
  newRefId: Uuid;
  decision: RecheckDecisionKind;
  reason: string;
  decidedBy: Uuid;
  decidedAt: IsoDateTime;
}

export const REPORT_SNAPSHOT_KINDS = ['review_draft', 'approved'] as const;
export type ReportSnapshotKind = (typeof REPORT_SNAPSHOT_KINDS)[number];

/** スナップショットに固定した基準の版 */
export interface ReportSnapshotFramework {
  frameworkVersionId: Uuid;
  frameworkKey: FrameworkKey;
  label: string;
  versionCode: string | null;
  legalStatus: FrameworkLegalStatus | null;
  coverageStatus: FrameworkCoverageStatus | null;
  applicabilityStatus: ApplicabilityStatus;
  decisionId: Uuid | null;
}

/** スナップショットに固定した節 */
export interface ReportSnapshotBlock {
  blockId: Uuid;
  /** 固定した版。版が無い節は null（草稿のみ。確定版では必ず版がある） */
  versionId: Uuid | null;
  sectionKey: string;
  title: string;
  language: DisclosureLanguage;
  status: BlockStatus;
  body: BlockBody;
  contentHash: string | null;
}

/** スナップショットに固定した数値（参照した data_point_version の写し） */
export interface ReportSnapshotMetricValue {
  dataPointId: Uuid;
  dataPointVersionId: Uuid;
  metricId: Uuid;
  value: number | null;
  textValue: string | null;
  unitOfMeasure: string;
  reportingPeriodId: Uuid;
  boundary: string;
  status: DataPointStatus;
  valueKind: ValueKind;
  availabilityStatus: AvailabilityStatus;
}

/** スナップショットに固定した引用位置 */
export interface ReportSnapshotAnchor {
  sourceAnchorId: Uuid;
  fileVersionId: Uuid;
  anchorKind: AnchorKind;
  page: number | null;
  locator: string | null;
  quoteText: string;
  usagePurpose: EvidenceUsagePurpose | null;
}

/** レポートのスナップショット（0038・追記専用）。出力は必ずここから作る */
export interface ReportSnapshot {
  id: Uuid;
  organizationId: Uuid;
  projectId: Uuid;
  snapshotKind: ReportSnapshotKind;
  snapshotNo: number;
  label: string;
  frameworkVersions: ReportSnapshotFramework[];
  decisionIds: Uuid[];
  blocks: ReportSnapshotBlock[];
  metricValues: ReportSnapshotMetricValue[];
  narrativeVersionIds: Uuid[];
  anchors: ReportSnapshotAnchor[];
  policyVersion: string | null;
  /** 正規化した内容のハッシュ。再出力で一致する */
  contentHash: string;
  createdAt: IsoDateTime;
  createdBy: Uuid;
}

export const EXPORT_ARTIFACT_FORMATS = ['docx', 'xlsx', 'csv'] as const;
export type ExportArtifactFormat = (typeof EXPORT_ARTIFACT_FORMATS)[number];

export const EXPORT_AUDIENCES = ['internal', 'external'] as const;
export type ExportAudience = (typeof EXPORT_AUDIENCES)[number];

/** 出力ファイルの記録（0038・追記専用） */
export interface ExportArtifact {
  id: Uuid;
  organizationId: Uuid;
  snapshotId: Uuid;
  format: ExportArtifactFormat;
  audience: ExportAudience;
  templateVersion: string;
  fileName: string;
  byteSize: number;
  fileSha256: string;
  /** スナップショットの正規化内容のハッシュ（再出力で一致する） */
  contentHash: string;
  generatedAt: IsoDateTime;
  generatedBy: Uuid;
}

export const KPI_TARGET_TYPES = ['absolute', 'intensity'] as const;
export type KpiTargetType = (typeof KPI_TARGET_TYPES)[number];

export const KPI_DIRECTIONS = ['reduce', 'increase'] as const;
export type KpiDirection = (typeof KPI_DIRECTIONS)[number];

/** KPI 目標（0038・追記専用の版）。変更は改訂理由付きの新しい版で行う */
export interface KpiTarget {
  id: Uuid;
  organizationId: Uuid;
  /** 版が変わっても同じ値 */
  targetKey: string;
  versionNo: number;
  metricId: Uuid;
  boundary: string;
  scopeNote: string;
  baseYear: number | null;
  baseValue: number | null;
  targetYear: number;
  targetValue: number;
  targetType: KpiTargetType;
  direction: KpiDirection;
  methodologyNote: string;
  ownerUserId: Uuid | null;
  /** 2 版目以降は必須 */
  revisionReason: string | null;
  createdAt: IsoDateTime;
  createdBy: Uuid | null;
}

export const QUANTITATIVE_IMPORT_STATUSES = ['validated', 'committed', 'rejected'] as const;
export type QuantitativeImportStatus = (typeof QUANTITATIVE_IMPORT_STATUSES)[number];

/** 取込行の差分区分（既存の値に対して新規・変更・同一・エラー） */
export const QUANTITATIVE_IMPORT_DIFF_KINDS = ['new', 'changed', 'unchanged', 'error'] as const;
export type QuantitativeImportDiffKind = (typeof QUANTITATIVE_IMPORT_DIFF_KINDS)[number];

/** 標準 CSV の 1 行の解析結果（quantitative_import_batches.rows の要素） */
export interface QuantitativeImportBatchRow {
  /** CSV 上の行番号（見出し行を 1 とする） */
  rowNo: number;
  raw: Record<string, string>;
  diffKind: QuantitativeImportDiffKind;
  /** 確定の対象に含めるか（「有効な行だけ確定」で外した行は false） */
  included: boolean;
  metricId: Uuid | null;
  unitId: Uuid | null;
  boundary: string | null;
  /** 既存の Data Point と、検証時点の現在版（確定時にずれていれば拒否する） */
  dataPointId: Uuid | null;
  currentVersionId: Uuid | null;
  value: number | null;
  textValue: string | null;
  unitOfMeasure: string | null;
  valueKind: ValueKind;
  availabilityStatus: AvailabilityStatus;
  absenceReason: string | null;
  errors: string[];
  warnings: string[];
}

/** 標準 CSV の取込バッチ（0039）。確定・却下したバッチは変更しない */
export interface QuantitativeImportBatch {
  id: Uuid;
  organizationId: Uuid;
  reportingPeriodId: Uuid;
  projectId: Uuid | null;
  fileName: string;
  fileSha256: string;
  status: QuantitativeImportStatus;
  rows: QuantitativeImportBatchRow[];
  /** 検証結果のハッシュ。確定時に再計算して一致しなければ拒否する */
  previewHash: string;
  commitIdempotencyKey: string | null;
  committedAt: IsoDateTime | null;
  committedBy: Uuid | null;
  excludedCount: number;
  createdAt: IsoDateTime;
  createdBy: Uuid | null;
}

// ======================================================================
// 10.7 Import / AI
// ======================================================================

export const JOB_STATUSES = [
  'queued',
  'processing',
  'needs_review',
  'completed',
  'failed',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface IngestionJob extends AuditColumns {
  id: Uuid;
  organizationId: Uuid;
  reportingPeriodId: Uuid;
  unitId: Uuid | null;
  status: JobStatus;
  progressPercent: number;
  errorCode: string | null;
  errorMessage: string | null;
  retryCount: number;
  idempotencyKey: string;
  startedAt: IsoDateTime | null;
  finishedAt: IsoDateTime | null;
  totalRows: number;
  mappedRows: number;
  warningRows: number;
  errorRows: number;
}

export interface IngestionJobFile {
  id: Uuid;
  jobId: Uuid;
  organizationId: Uuid;
  fileVersionId: Uuid;
  originalName: string;
  mimeType: string;
  parseStatus: 'pending' | 'parsed' | 'needs_ocr' | 'failed';
  parseMessage: string | null;
  sheetName: string | null;
  detectedEncoding: string | null;
  createdAt: IsoDateTime;
}

export const INGESTION_ROW_STATUSES = [
  'pending',
  'mapped',
  'needs_review',
  'duplicate',
  'rejected',
  'confirmed',
  /**
   * 指標マスターと無関係と判断して自動で対象外にした行。警告は出さない。
   * needs_review（人が直せば取り込める）でも rejected（人が外すと決めた）でもない。
   */
  'ignored',
] as const;
export type IngestionRowStatus = (typeof INGESTION_ROW_STATUSES)[number];

export interface IngestionRow {
  id: Uuid;
  jobId: Uuid;
  jobFileId: Uuid;
  organizationId: Uuid;
  rowIndex: number;
  raw: Record<string, string>;
  metricId: Uuid | null;
  unitId: Uuid | null;
  reportingPeriodId: Uuid | null;
  value: number | null;
  unitOfMeasure: string | null;
  /** AI / ルールベースの確信度 0..1 */
  confidence: number;
  warnings: string[];
  status: IngestionRowStatus;
  /** 元資料の該当箇所（"Sheet1!C12" / "p.3" 等） */
  sourceLocator: string | null;
  duplicateOfDataPointId: Uuid | null;
  aiRunId: Uuid | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export const AI_FEATURE_TYPES = [
  'importMapping',
  'anomalyExplanation',
  'cdpQuestionMapping',
  'cdpDraftGeneration',
  'ssbjGapAnalysis',
  'ssbjDisclosureDraft',
  'evidenceMapping',
  'inconsistencyCheck',
  'insightDiscovery',
  'copilotChat',
  'assuranceEvidenceSummary',
  'assuranceChangeSummary',
  // 開示優先モード: 節の下書き候補（docs/disclosure-first.md §2-3）
  'disclosureBlockDraft',
] as const;
export type AiFeatureType = (typeof AI_FEATURE_TYPES)[number];

export const AI_RUN_STATUSES = ['running', 'succeeded', 'failed', 'accepted', 'rejected'] as const;
export type AiRunStatus = (typeof AI_RUN_STATUSES)[number];

export interface AiJob extends AuditColumns {
  id: Uuid;
  organizationId: Uuid;
  featureType: AiFeatureType;
  status: JobStatus;
  targetType: string;
  targetId: Uuid | null;
  engagementId: Uuid | null;
}

export interface AiRun {
  id: Uuid;
  organizationId: Uuid;
  jobId: Uuid | null;
  featureType: AiFeatureType;
  provider: 'openai' | 'mock';
  model: string;
  promptVersion: string;
  inputReferenceIds: string[];
  outputJson: Record<string, unknown>;
  sourceReferences: AiSourceReference[];
  confidence: number;
  warnings: string[];
  latencyMs: number;
  tokenUsage: { input: number; output: number; total: number };
  estimatedCostUsd: number;
  status: AiRunStatus;
  errorMessage: string | null;
  engagementId: Uuid | null;
  reviewedBy: Uuid | null;
  acceptedAt: IsoDateTime | null;
  rejectedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  createdBy: Uuid | null;
}

export interface AiSourceReference {
  kind:
    | 'data_point'
    | 'evidence'
    | 'previous_response'
    | 'disclosure_response'
    | 'metric_definition'
    | 'snapshot_item'
    // 開示本文の下書き（disclosureBlockDraft）が引用する版・位置
    | 'narrative_version'
    | 'source_anchor'
    | 'metric_version'
    | 'prior_block'
    | 'requirement';
  id: Uuid | null;
  label: string;
  locator: string | null;
  periodLabel: string | null;
}

export interface AiFeedback {
  id: Uuid;
  aiRunId: Uuid;
  organizationId: Uuid;
  userId: Uuid;
  decision: 'accepted' | 'edited_accepted' | 'rejected';
  comment: string | null;
  createdAt: IsoDateTime;
}

// ======================================================================
// 10.8 Assurance
// ======================================================================

export const ASSURANCE_LEVELS = ['limited', 'reasonable'] as const;
export type AssuranceLevel = (typeof ASSURANCE_LEVELS)[number];

export const ENGAGEMENT_STATUSES = [
  'planning',
  'fieldwork',
  'review',
  'completed',
  'archived',
] as const;
export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];

export interface Engagement extends AuditColumns {
  id: Uuid;
  /** 所有者は監査法人。企業テナントからは read のみ（自社が client の案件だけ）。 */
  assuranceFirmId: Uuid;
  clientOrganizationId: Uuid;
  clientReportingPeriodId: Uuid;
  code: string;
  name: string;
  assuranceLevel: AssuranceLevel;
  frameworkKey: FrameworkKey | 'issb' | 'other';
  status: EngagementStatus;
  plannedStartDate: IsoDate;
  deadlineDate: IsoDate;
  partnerUserId: Uuid | null;
  managerUserId: Uuid | null;
  materialityBasis: string | null;
  materialityValue: number | null;
  materialityUnit: string | null;
}

export interface EngagementMember {
  id: Uuid;
  engagementId: Uuid;
  assuranceFirmId: Uuid;
  userId: Uuid;
  roleKey: AssuranceRole;
  assignedAt: IsoDateTime;
  assignedBy: Uuid | null;
  removedAt: IsoDateTime | null;
}

export const SCOPE_INCLUSIONS = ['included', 'excluded', 'pending'] as const;
export type ScopeInclusion = (typeof SCOPE_INCLUSIONS)[number];

export interface EngagementScope extends AuditColumns {
  id: Uuid;
  engagementId: Uuid;
  assuranceFirmId: Uuid;
  unitId: Uuid;
  metricId: Uuid;
  reportingPeriodId: Uuid;
  inclusion: ScopeInclusion;
  riskTag: 'high' | 'medium' | 'low';
  materialityFlag: boolean;
  note: string | null;
}

export const DATA_ROOM_SOURCE_TYPES = ['data_point', 'evidence', 'disclosure_response'] as const;
export type DataRoomSourceType = (typeof DATA_ROOM_SOURCE_TYPES)[number];

export interface DataRoomItem {
  id: Uuid;
  engagementId: Uuid;
  assuranceFirmId: Uuid;
  clientOrganizationId: Uuid;
  sourceType: DataRoomSourceType;
  sourceId: Uuid;
  sourceVersionId: Uuid | null;
  sharedAt: IsoDateTime;
  sharedBy: Uuid;
  clientApprovalStatus: DataPointStatus | ResponseStatus | 'n_a';
  withdrawnAt: IsoDateTime | null;
}

export interface AssuranceSnapshot {
  id: Uuid;
  engagementId: Uuid;
  assuranceFirmId: Uuid;
  label: string;
  /** Immutable。作成後 UPDATE / DELETE 不可（RLS + トリガ）。 */
  frozenAt: IsoDateTime;
  frozenBy: Uuid;
  itemCount: number;
  hash: string;
  note: string | null;
}

export interface AssuranceSnapshotItem {
  id: Uuid;
  snapshotId: Uuid;
  engagementId: Uuid;
  assuranceFirmId: Uuid;
  sourceType: DataRoomSourceType;
  sourceId: Uuid;
  sourceVersionId: Uuid | null;
  sourceDataPointVersionId: Uuid | null;
  sourceFileVersionId: Uuid | null;
  /** 固定時点の値のコピー（企業側が変更しても不変） */
  valueSnapshot: Record<string, unknown>;
  hash: string;
  frozenAt: IsoDateTime;
  frozenBy: Uuid;
}

export const CHANGE_KINDS = [
  'value_changed',
  'version_added',
  'evidence_replaced',
  'grant_revoked',
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export interface SnapshotChange {
  id: Uuid;
  snapshotId: Uuid;
  engagementId: Uuid;
  assuranceFirmId: Uuid;
  snapshotItemId: Uuid;
  changeKind: ChangeKind;
  beforeSummary: string;
  afterSummary: string;
  detectedAt: IsoDateTime;
  assessedBy: Uuid | null;
  assessedAt: IsoDateTime | null;
  assessment: 'no_impact' | 'retest_required' | 'issue_raised' | null;
}

export interface Population {
  id: Uuid;
  engagementId: Uuid;
  assuranceFirmId: Uuid;
  snapshotId: Uuid;
  name: string;
  versionNo: number;
  filter: PopulationFilter;
  itemCount: number;
  totalValue: number;
  missingCount: number;
  duplicateCount: number;
  excludedCount: number;
  reconciliationNote: string | null;
  completenessProcedureNote: string | null;
  createdAt: IsoDateTime;
  createdBy: Uuid;
}

export interface PopulationFilter {
  metricIds: Uuid[];
  unitIds: Uuid[];
  reportingPeriodIds: Uuid[];
  minValue: number | null;
  maxValue: number | null;
}

export interface PopulationItem {
  id: Uuid;
  populationId: Uuid;
  engagementId: Uuid;
  assuranceFirmId: Uuid;
  snapshotItemId: Uuid;
  sourceDataPointId: Uuid;
  metricId: Uuid;
  unitId: Uuid;
  value: number;
  unitOfMeasure: string;
  stratum: string | null;
  excluded: boolean;
  exclusionReason: string | null;
}

export const SAMPLING_METHODS = ['random', 'stratified', 'key_item', 'judgmental'] as const;
export type SamplingMethod = (typeof SAMPLING_METHODS)[number];

export interface Sample {
  id: Uuid;
  populationId: Uuid;
  engagementId: Uuid;
  assuranceFirmId: Uuid;
  populationVersionNo: number;
  name: string;
  method: SamplingMethod;
  /** 同一 Seed で再現可能であること（テストで検証） */
  seed: string;
  parameters: SamplingParameters;
  size: number;
  rationale: string;
  createdAt: IsoDateTime;
  createdBy: Uuid;
}

export interface SamplingParameters {
  targetSize: number;
  strataKey?: 'unit' | 'metric' | 'magnitude';
  perStratum?: number;
  keyItemThreshold?: number;
  selectedItemIds?: Uuid[];
}

export interface SampleItem {
  id: Uuid;
  sampleId: Uuid;
  populationItemId: Uuid;
  engagementId: Uuid;
  assuranceFirmId: Uuid;
  selectionReason: string;
  stratum: string | null;
  sortOrder: number;
}

export interface AssuranceProcedure extends AuditColumns {
  id: Uuid;
  engagementId: Uuid;
  assuranceFirmId: Uuid;
  code: string;
  title: string;
  description: string;
  category: 'completeness' | 'accuracy' | 'cutoff' | 'recalculation' | 'inquiry' | 'inspection';
  required: boolean;
  sortOrder: number;
}

export const TEST_STATUSES = [
  'not_started',
  'in_progress',
  'prepared',
  'reviewed',
  'exception',
] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

export interface AssuranceTest extends AuditColumns {
  id: Uuid;
  engagementId: Uuid;
  assuranceFirmId: Uuid;
  sampleItemId: Uuid;
  status: TestStatus;
  conclusionDraft: string | null;
  preparedBy: Uuid | null;
  preparedAt: IsoDateTime | null;
  reviewedBy: Uuid | null;
  reviewedAt: IsoDateTime | null;
  workpaperRef: string | null;
}

export const TEST_RESULTS = ['pass', 'exception', 'not_applicable'] as const;
export type TestResultValue = (typeof TEST_RESULTS)[number];

export interface AssuranceTestResult {
  id: Uuid;
  testId: Uuid;
  procedureId: Uuid;
  engagementId: Uuid;
  assuranceFirmId: Uuid;
  result: TestResultValue;
  recalculationInput: CalculationInput[] | null;
  recalculationResult: number | null;
  recordedValue: number | null;
  difference: number | null;
  note: string | null;
  completedBy: Uuid;
  completedAt: IsoDateTime;
}

export const PBC_STATUSES = [
  'draft',
  'sent',
  'acknowledged',
  'submitted',
  'under_review',
  'accepted',
  'rejected',
  'overdue',
  'closed',
] as const;
export type PbcStatus = (typeof PBC_STATUSES)[number];

export interface PbcRequest extends AuditColumns {
  id: Uuid;
  engagementId: Uuid;
  assuranceFirmId: Uuid;
  clientOrganizationId: Uuid;
  code: string;
  title: string;
  description: string;
  targetType: string | null;
  targetId: Uuid | null;
  dueDate: IsoDate;
  priority: Priority;
  status: PbcStatus;
  /** 監査法人内部メモ。企業側からは不可視。 */
  internalNote: string | null;
  requestedBy: Uuid;
  sentAt: IsoDateTime | null;
  closedAt: IsoDateTime | null;
}

export interface PbcRequestResponse {
  id: Uuid;
  requestId: Uuid;
  engagementId: Uuid;
  clientOrganizationId: Uuid;
  body: string;
  fileVersionIds: Uuid[];
  submittedBy: Uuid;
  submittedAt: IsoDateTime;
  decision: 'accepted' | 'rejected' | null;
  decidedBy: Uuid | null;
  decidedAt: IsoDateTime | null;
  rejectReason: string | null;
}

export const ISSUE_SEVERITIES = ['high', 'medium', 'low'] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

export const ISSUE_STATUSES = ['open', 'management_response', 'resolved', 'closed'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export interface AssuranceIssue extends AuditColumns {
  id: Uuid;
  engagementId: Uuid;
  assuranceFirmId: Uuid;
  clientOrganizationId: Uuid;
  code: string;
  title: string;
  description: string;
  affectedMetricId: Uuid | null;
  affectedSampleItemId: Uuid | null;
  severity: IssueSeverity;
  quantitativeImpact: number | null;
  quantitativeImpactUnit: string | null;
  rootCause: string | null;
  status: IssueStatus;
  resolution: string | null;
  reviewerUserId: Uuid | null;
  resolvedAt: IsoDateTime | null;
}

export interface ManagementResponse {
  id: Uuid;
  issueId: Uuid;
  engagementId: Uuid;
  clientOrganizationId: Uuid;
  body: string;
  proposedCorrection: string | null;
  respondedBy: Uuid;
  respondedAt: IsoDateTime;
}

export const REVIEW_NOTE_STATUSES = ['open', 'responded', 'cleared'] as const;
export type ReviewNoteStatus = (typeof REVIEW_NOTE_STATUSES)[number];

export interface ReviewNote extends AuditColumns {
  id: Uuid;
  engagementId: Uuid;
  assuranceFirmId: Uuid;
  targetType: string;
  targetId: Uuid | null;
  body: string;
  raisedBy: Uuid;
  assignedTo: Uuid | null;
  status: ReviewNoteStatus;
  /** 既定 false。false の間は企業側から一切見えない。 */
  sharedWithClient: boolean;
  resolutionComment: string | null;
  resolvedAt: IsoDateTime | null;
}

export const SIGNOFF_STAGES = ['prepared', 'reviewed', 'partner_approved'] as const;
export type SignoffStage = (typeof SIGNOFF_STAGES)[number];

export interface Signoff {
  id: Uuid;
  engagementId: Uuid;
  assuranceFirmId: Uuid;
  signoffStage: SignoffStage;
  /** 代理 Sign-off 禁止: 常に実行者本人。RLS の WITH CHECK で強制。 */
  userId: Uuid;
  roleKey: AssuranceRole;
  version: number;
  snapshotId: Uuid | null;
  comment: string | null;
  createdAt: IsoDateTime;
}

export interface SignoffBlocker {
  code:
    | 'required_procedure_incomplete'
    | 'required_sample_incomplete'
    | 'high_issue_unresolved'
    | 'critical_pbc_outstanding'
    | 'snapshot_change_unassessed'
    | 'previous_stage_missing';
  message: string;
  count: number;
  href: string | null;
}

export interface WorkpaperReference {
  id: Uuid;
  engagementId: Uuid;
  assuranceFirmId: Uuid;
  reference: string;
  targetType: string;
  targetId: Uuid;
  createdAt: IsoDateTime;
  createdBy: Uuid;
}

// ======================================================================
// 10.9 Audit
// ======================================================================

export const AUDIT_EVENT_TYPES = [
  'login_success',
  'login_failure',
  'logout',
  'workspace_selected',
  'record_viewed',
  'file_uploaded',
  'file_downloaded',
  'signed_url_created',
  'data_created',
  'data_updated',
  'data_submitted',
  'data_returned',
  'data_approved',
  'permission_changed',
  'access_grant_created',
  'access_grant_revoked',
  'snapshot_created',
  'snapshot_change_detected',
  'sample_created',
  'procedure_completed',
  'pbc_created',
  'pbc_submitted',
  'issue_created',
  'issue_resolved',
  'review_note_created',
  'signoff_created',
  'ai_run_started',
  'ai_run_completed',
  'ai_output_accepted',
  'export_created',
  // 開示優先モード（0040）。開示業務の操作を data_* で代用しない
  'settings_changed',
  'project_created',
  'project_updated',
  'framework_decision_confirmed',
  'narrative_version_created',
  'narrative_confirmed',
  'block_version_created',
  'review_requested',
  'review_returned',
  'review_completed',
  'review_approved',
  'review_withdrawn',
  'comment_created',
  'comment_resolved',
  'recheck_decided',
  'report_snapshot_created',
  'import_committed',
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export interface AuditEvent {
  id: Uuid;
  actorUserId: Uuid | null;
  actorOrganizationId: Uuid | null;
  eventType: AuditEventType;
  resourceType: string | null;
  resourceId: Uuid | null;
  engagementId: Uuid | null;
  /** 生 IP は保存しない。SHA-256 の先頭 16 文字のみ。 */
  clientIpHash: string | null;
  userAgent: string | null;
  /** PII / Evidence 本文は入れない。要約のみ。 */
  beforeSummary: string | null;
  afterSummary: string | null;
  metadata: Record<string, unknown>;
  createdAt: IsoDateTime;
}

// ======================================================================
// 認可コンテキスト（Repository / Service の全メソッドに必須）
// ======================================================================

export interface WorkspaceContext {
  organizationId: Uuid;
  organizationType: OrganizationType;
  organizationName: string;
  roleKeys: RoleKey[];
  /** 企業側: 担当 Unit 制限。空 = 全社。 */
  unitScopeIds: Uuid[];
}

export interface AuthorizationContext {
  userId: Uuid;
  email: string;
  displayName: string;
  workspace: WorkspaceContext;
  /** 監査法人側でのみ有効。所属している Engagement の ID 一覧。 */
  engagementIds: Uuid[];
  /** Demo Mode か否か。UI のバッジ表示に使う。 */
  demo: boolean;
}

// ======================================================================
// 一覧取得の共通形
// ======================================================================

export interface PageRequest {
  page: number;
  pageSize: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}

export interface Page<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const DEFAULT_PAGE_SIZE = 25;
