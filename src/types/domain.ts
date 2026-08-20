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
] as const;
export type MetricCategory = (typeof METRIC_CATEGORIES)[number];

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
}

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

export const FRAMEWORK_KEYS = ['cdp', 'ssbj', 'csrd', 'msci', 'ftse'] as const;
export type FrameworkKey = (typeof FRAMEWORK_KEYS)[number];

export interface DisclosureFramework {
  id: Uuid;
  key: FrameworkKey;
  name: string;
  description: string;
}

export interface DisclosureFrameworkVersion {
  id: Uuid;
  frameworkId: Uuid;
  year: number;
  label: string;
  status: 'draft' | 'published' | 'superseded';
  /** Fixture である旨を UI に必ず出す */
  isFixture: boolean;
  createdAt: IsoDateTime;
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
export interface MaterialityTopic extends AuditColumns {
  id: Uuid;
  organizationId: Uuid;
  reportingPeriodId: Uuid;
  topicKey: string;
  title: string;
  category: MaterialityCategory;
  materiality: MaterialityLevel;
  rationale: string;
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
  'evidenceMapping',
  'inconsistencyCheck',
  'insightDiscovery',
  'copilotChat',
  'assuranceEvidenceSummary',
  'assuranceChangeSummary',
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
    | 'snapshot_item';
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
