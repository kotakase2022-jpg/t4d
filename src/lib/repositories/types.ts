/**
 * Repository Interface（指示書 4 章 B「実装 Interface は Demo Mode と共通化」）。
 *
 * Demo Mode（インメモリ Fixture）と Supabase Mode（Postgres + RLS）を
 * 同一の呼び出し形で扱えるようにする、最小のデータアクセス層。
 *
 * 設計方針
 *  - 業務ロジックは `src/lib/services/*` に置き、Repository は「取得・保存」だけを担う。
 *  - Filter は両モードで表現できる範囲（等値 / in / 比較 / null 判定）に限定する。
 *    JOIN や集計は Service 層で組み立てる（Phase 1 のデータ量で問題ない規模）。
 *  - 認可はアプリ層（Service の assertCan*）と DB 層（RLS）の二重で掛ける。
 */

import type {
  Alert,
  Approval,
  AiRun,
  AssuranceIssue,
  AssuranceProcedure,
  AssuranceSnapshot,
  AssuranceSnapshotItem,
  AssuranceTest,
  AssuranceTestResult,
  AuditEvent,
  ClientAccessGrant,
  Comment,
  DataPoint,
  DataPointCalculation,
  DataPointValidationResult,
  DataPointVersion,
  DataRoomItem,
  DisclosureFramework,
  DisclosureFrameworkVersion,
  DisclosureItem,
  Invitation,
  DisclosureItemCondition,
  DisclosureMapping,
  DisclosureResponse,
  DisclosureResponseVersion,
  EmissionFactor,
  Engagement,
  EngagementMember,
  EngagementScope,
  EvidenceLink,
  ExtractedFragment,
  FileObject,
  FileVersion,
  IngestionJob,
  IngestionJobFile,
  IngestionRow,
  ManagementResponse,
  MembershipRole,
  MetricAssignment,
  MetricDefinition,
  Notification,
  Organization,
  OrganizationMembership,
  OrganizationRelationship,
  AggregationRule,
  ApplicabilityResult,
  MaterialityTopic,
  CampaignScope,
  CollectionCampaign,
  OrganizationUnit,
  PbcRequest,
  PbcRequestResponse,
  Population,
  PopulationItem,
  Profile,
  ReportingPeriod,
  ResponseEvidenceLink,
  ReviewNote,
  Sample,
  SampleItem,
  Signoff,
  SnapshotChange,
  StorageAccessEvent,
  Uuid,
  WorkTask,
} from '@/types/domain';

/** テーブル名（TS 側）→ 行型 のマップ。SQL 名との対応は supabase/table-names.ts。 */
export interface TableMap {
  profiles: Profile;
  organizations: Organization;
  memberships: OrganizationMembership;
  invitations: Invitation;
  membershipRoles: MembershipRole;
  relationships: OrganizationRelationship;
  grants: ClientAccessGrant;

  units: OrganizationUnit;
  periods: ReportingPeriod;
  campaigns: CollectionCampaign;
  campaignScopes: CampaignScope;
  metrics: MetricDefinition;
  aggregationRules: AggregationRule;
  metricAssignments: MetricAssignment;
  emissionFactors: EmissionFactor;

  dataPoints: DataPoint;
  dataPointVersions: DataPointVersion;
  calculations: DataPointCalculation;
  validations: DataPointValidationResult;

  files: FileObject;
  fileVersions: FileVersion;
  evidenceLinks: EvidenceLink;
  fragments: ExtractedFragment;
  storageAccessEvents: StorageAccessEvent;

  tasks: WorkTask;
  approvals: Approval;
  comments: Comment;
  notifications: Notification;
  alerts: Alert;

  frameworks: DisclosureFramework;
  frameworkVersions: DisclosureFrameworkVersion;
  disclosureItems: DisclosureItem;
  itemConditions: DisclosureItemCondition;
  applicabilityResults: ApplicabilityResult;
  materialityTopics: MaterialityTopic;
  disclosureResponses: DisclosureResponse;
  disclosureResponseVersions: DisclosureResponseVersion;
  disclosureMappings: DisclosureMapping;
  responseEvidenceLinks: ResponseEvidenceLink;

  ingestionJobs: IngestionJob;
  ingestionJobFiles: IngestionJobFile;
  ingestionRows: IngestionRow;
  aiRuns: AiRun;

  engagements: Engagement;
  engagementMembers: EngagementMember;
  engagementScopes: EngagementScope;
  dataRoomItems: DataRoomItem;
  snapshots: AssuranceSnapshot;
  snapshotItems: AssuranceSnapshotItem;
  snapshotChanges: SnapshotChange;
  populations: Population;
  populationItems: PopulationItem;
  samples: Sample;
  sampleItems: SampleItem;
  procedures: AssuranceProcedure;
  tests: AssuranceTest;
  testResults: AssuranceTestResult;
  pbcRequests: PbcRequest;
  pbcResponses: PbcRequestResponse;
  issues: AssuranceIssue;
  managementResponses: ManagementResponse;
  reviewNotes: ReviewNote;
  signoffs: Signoff;

  auditEvents: AuditEvent;
}

export type TableName = keyof TableMap;
export type Row<K extends TableName> = TableMap[K];

export type Scalar = string | number | boolean | null;

export type Condition =
  | Scalar
  | { in: readonly Scalar[] }
  | { notIn: readonly Scalar[] }
  | { neq: Scalar }
  | { gte: string | number }
  | { lte: string | number }
  | { gt: string | number }
  | { lt: string | number }
  | { isNull: boolean }
  /** 配列カラムに指定値を含むか（例: `answerChoice`）。 */
  | { contains: Scalar };

export type Where<T> = { [P in keyof T]?: Condition };

export interface Query<T> {
  where?: Where<T>;
  /**
   * OR 条件。`where`（AND）と併用すると `where AND (orWhere[0] OR orWhere[1] OR ...)` になる。
   * 一覧の横断検索（指標名 OR 組織名）を DB 側で解決するために使う。
   *
   * 制約: Supabase 側は PostgREST の `or=` 文字列に変換するため、
   * 値にカンマ・括弧を含められない（UUID と enum のみを想定）。
   */
  orWhere?: Array<Where<T>>;
  /** 単一列、または優先順の複数列。ページングを安定させるため一意列を最後に含めること。 */
  orderBy?: OrderBy<T> | Array<OrderBy<T>>;
  limit?: number;
  offset?: number;
}

export interface OrderBy<T> {
  column: keyof T & string;
  dir?: 'asc' | 'desc';
}

export function toOrderByList<T>(orderBy: Query<T>['orderBy']): Array<OrderBy<T>> {
  if (!orderBy) return [];
  return Array.isArray(orderBy) ? orderBy : [orderBy];
}

/**
 * データアクセスの共通契約。
 * `id` 列は全テーブルに存在する前提（`membershipRoles` / `responseEvidenceLinks` などの
 * 例外は `insert` のみを使う）。
 */
export interface DbClient {
  readonly mode: 'demo' | 'supabase';

  select<K extends TableName>(table: K, query?: Query<Row<K>>): Promise<Row<K>[]>;
  count<K extends TableName>(
    table: K,
    query?: Pick<Query<Row<K>>, 'where' | 'orWhere'>,
  ): Promise<number>;
  findById<K extends TableName>(table: K, id: Uuid): Promise<Row<K> | null>;
  insert<K extends TableName>(table: K, rows: Row<K>[]): Promise<Row<K>[]>;
  update<K extends TableName>(table: K, id: Uuid, patch: Partial<Row<K>>): Promise<Row<K>>;
  /** Soft Delete 用（deleted_at を持つテーブルのみ）。物理削除は行わない。 */
  softDelete<K extends TableName>(table: K, id: Uuid, at: string): Promise<void>;
}

export function matchesCondition(value: unknown, condition: Condition): boolean {
  if (condition === null) return value === null || value === undefined;
  if (typeof condition !== 'object') return value === condition;

  if ('in' in condition) return condition.in.includes(value as Scalar);
  if ('notIn' in condition) return !condition.notIn.includes(value as Scalar);
  if ('neq' in condition) return value !== condition.neq;
  if ('isNull' in condition) {
    const isNull = value === null || value === undefined;
    return condition.isNull ? isNull : !isNull;
  }
  if ('contains' in condition) {
    return Array.isArray(value) && (value as Scalar[]).includes(condition.contains);
  }
  if ('gte' in condition)
    return value !== null && value !== undefined && (value as number) >= (condition.gte as number);
  if ('lte' in condition)
    return value !== null && value !== undefined && (value as number) <= (condition.lte as number);
  if ('gt' in condition)
    return value !== null && value !== undefined && (value as number) > (condition.gt as number);
  if ('lt' in condition)
    return value !== null && value !== undefined && (value as number) < (condition.lt as number);
  return false;
}

export function matchesWhere<T extends object>(row: T, where: Where<T> | undefined): boolean {
  if (!where) return true;
  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (!matchesCondition((row as Record<string, unknown>)[key], condition as Condition))
      return false;
  }
  return true;
}

/** `where`（AND）と `orWhere`（OR）の両方を満たすか。 */
export function matchesQueryFilters<T extends object>(row: T, query?: Query<T>): boolean {
  if (!matchesWhere(row, query?.where)) return false;
  const orWhere = query?.orWhere;
  if (!orWhere || orWhere.length === 0) return true;
  return orWhere.some((clause) => matchesWhere(row, clause));
}

export function applyQuery<T extends object>(rows: T[], query?: Query<T>): T[] {
  let out = rows.filter((row) => matchesQueryFilters(row, query));
  const orderByList = toOrderByList(query?.orderBy);
  if (orderByList.length > 0) {
    out = [...out].sort((a, b) => {
      for (const orderBy of orderByList) {
        const dir = orderBy.dir === 'desc' ? -1 : 1;
        const av = (a as Record<string, unknown>)[orderBy.column];
        const bv = (b as Record<string, unknown>)[orderBy.column];
        if (av === bv) continue;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        return (av < bv ? -1 : 1) * dir;
      }
      return 0;
    });
  }
  const offset = query?.offset ?? 0;
  const limit = query?.limit;
  return limit === undefined ? out.slice(offset) : out.slice(offset, offset + limit);
}
