/**
 * Fixture データベース（インメモリ）。
 *
 * `createFixtureDb()` は毎回まっさらな架空データを構築する。
 * Demo Mode のサーバープロセスでは `getDemoDb()` が同一インスタンスを共有し、
 * Server Action による更新（承認・Snapshot・Sign-off 等）が反映される。
 */

import { isCountedInTotals } from '@/lib/domain/boundaries';
import { buildEvidenceText } from './evidence-documents';
import { selectSample } from '@/lib/services/sampling';
import { validateDataPoints } from '@/lib/validation/data-point-rules';
import {
  AOMI_UNITS,
  CDP_ITEM_CONDITIONS,
  CDP_ITEM_SPECS,
  CSRD_ITEM_SPECS,
  DEMO_USERS,
  EMISSION_FACTOR_SPECS,
  ENGAGEMENT_IDS,
  ISSUE_SPECS,
  METRIC_SPECS,
  ORG_IDS,
  PBC_SPECS,
  PERIOD_IDS,
  PROCEDURE_SPECS,
  REVIEW_NOTE_SPECS,
  SCOPE3_PURCHASE_ROWS,
  UNIT_IDS,
  at,
  buildDataPointSeeds,
  dataPointId,
  day,
  metricId,
  userId,
} from './dataset';
import { SSBJ_FRAMEWORK_INFO, SSBJ_MASTER_ITEMS } from '@/lib/frameworks/ssbj-2026';
import { contentHash, fid } from './ids';
import type {
  Alert,
  Approval,
  AssuranceIssue,
  AssuranceProcedure,
  AssuranceSnapshot,
  AssuranceSnapshotItem,
  AssuranceTest,
  AssuranceTestResult,
  AiRun,
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
  SsbjActionPlan,
  SsbjActionStatus,
  SsbjActionType,
  SsbjAssessment,
  SsbjCoverageStatus,
  SsbjGapKind,
  SsbjPriority,
  ReviewNote,
  Sample,
  SampleItem,
  Signoff,
  SnapshotChange,
  StorageAccessEvent,
  Uuid,
  WorkTask,
} from '@/types/domain';

export interface FixtureDb {
  profiles: Profile[];
  organizations: Organization[];
  memberships: OrganizationMembership[];
  invitations: Invitation[];
  membershipRoles: MembershipRole[];
  relationships: OrganizationRelationship[];
  grants: ClientAccessGrant[];

  units: OrganizationUnit[];
  periods: ReportingPeriod[];
  campaigns: CollectionCampaign[];
  campaignScopes: CampaignScope[];
  metrics: MetricDefinition[];
  aggregationRules: AggregationRule[];
  metricAssignments: MetricAssignment[];
  emissionFactors: EmissionFactor[];

  dataPoints: DataPoint[];
  dataPointVersions: DataPointVersion[];
  calculations: DataPointCalculation[];
  validations: DataPointValidationResult[];

  files: FileObject[];
  fileVersions: FileVersion[];
  evidenceLinks: EvidenceLink[];
  fragments: ExtractedFragment[];
  storageAccessEvents: StorageAccessEvent[];

  tasks: WorkTask[];
  approvals: Approval[];
  comments: Comment[];
  notifications: Notification[];
  alerts: Alert[];

  frameworks: DisclosureFramework[];
  frameworkVersions: DisclosureFrameworkVersion[];
  disclosureItems: DisclosureItem[];
  itemConditions: DisclosureItemCondition[];
  applicabilityResults: ApplicabilityResult[];
  materialityTopics: MaterialityTopic[];
  disclosureResponses: DisclosureResponse[];
  disclosureResponseVersions: DisclosureResponseVersion[];
  disclosureMappings: DisclosureMapping[];
  responseEvidenceLinks: ResponseEvidenceLink[];
  ssbjAssessments: SsbjAssessment[];
  ssbjActionPlans: SsbjActionPlan[];

  ingestionJobs: IngestionJob[];
  ingestionJobFiles: IngestionJobFile[];
  ingestionRows: IngestionRow[];
  aiRuns: AiRun[];

  engagements: Engagement[];
  engagementMembers: EngagementMember[];
  engagementScopes: EngagementScope[];
  dataRoomItems: DataRoomItem[];
  snapshots: AssuranceSnapshot[];
  snapshotItems: AssuranceSnapshotItem[];
  snapshotChanges: SnapshotChange[];
  populations: Population[];
  populationItems: PopulationItem[];
  samples: Sample[];
  sampleItems: SampleItem[];
  procedures: AssuranceProcedure[];
  tests: AssuranceTest[];
  testResults: AssuranceTestResult[];
  pbcRequests: PbcRequest[];
  pbcResponses: PbcRequestResponse[];
  issues: AssuranceIssue[];
  managementResponses: ManagementResponse[];
  reviewNotes: ReviewNote[];
  signoffs: Signoff[];

  auditEvents: AuditEvent[];
}

const SYSTEM = null;

function audit(created: string, updated = created, by: Uuid | null = SYSTEM) {
  return { createdAt: created, updatedAt: updated, createdBy: by, updatedBy: by };
}

function must<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(`Fixture inconsistency: ${message}`);
  return value;
}

// ======================================================================

export function createFixtureDb(): FixtureDb {
  const db: FixtureDb = {
    profiles: [],
    organizations: [],
    memberships: [],
    invitations: [],
    membershipRoles: [],
    relationships: [],
    grants: [],
    units: [],
    periods: [],
    campaigns: [],
    campaignScopes: [],
    metrics: [],
    aggregationRules: [],
    metricAssignments: [],
    emissionFactors: [],
    dataPoints: [],
    dataPointVersions: [],
    calculations: [],
    validations: [],
    files: [],
    fileVersions: [],
    evidenceLinks: [],
    fragments: [],
    storageAccessEvents: [],
    tasks: [],
    approvals: [],
    comments: [],
    notifications: [],
    alerts: [],
    frameworks: [],
    frameworkVersions: [],
    disclosureItems: [],
    itemConditions: [],
    applicabilityResults: [],
    materialityTopics: [],
    disclosureResponses: [],
    disclosureResponseVersions: [],
    disclosureMappings: [],
    responseEvidenceLinks: [],
    ssbjAssessments: [],
    ssbjActionPlans: [],
    ingestionJobs: [],
    ingestionJobFiles: [],
    ingestionRows: [],
    aiRuns: [],
    engagements: [],
    engagementMembers: [],
    engagementScopes: [],
    dataRoomItems: [],
    snapshots: [],
    snapshotItems: [],
    snapshotChanges: [],
    populations: [],
    populationItems: [],
    samples: [],
    sampleItems: [],
    procedures: [],
    tests: [],
    testResults: [],
    pbcRequests: [],
    pbcResponses: [],
    issues: [],
    managementResponses: [],
    reviewNotes: [],
    signoffs: [],
    auditEvents: [],
  };

  // ------------------------------------------------------------------
  // 組織 / ユーザー
  // ------------------------------------------------------------------
  db.organizations.push(
    {
      id: ORG_IDS.aomi,
      type: 'enterprise',
      name: '青海テクノロジー株式会社',
      legalName: '青海テクノロジー株式会社',
      code: 'AOMI',
      countryCode: 'JP',
      deletedAt: null,
      ...audit(at(400)),
    },
    {
      id: ORG_IDS.soten,
      type: 'enterprise',
      name: '蒼天マテリアル株式会社',
      legalName: '蒼天マテリアル株式会社',
      code: 'SOTEN',
      countryCode: 'JP',
      deletedAt: null,
      ...audit(at(380)),
    },
    {
      id: ORG_IDS.aoba,
      type: 'assurance_firm',
      name: 'あおば保証監査法人',
      legalName: 'あおば保証監査法人',
      code: 'AOBA',
      countryCode: 'JP',
      deletedAt: null,
      ...audit(at(390)),
    },
    {
      id: ORG_IDS.kurobe,
      type: 'assurance_firm',
      name: 'くろべ監査法人',
      legalName: 'くろべ監査法人',
      code: 'KUROBE',
      countryCode: 'JP',
      deletedAt: null,
      ...audit(at(370)),
    },
    {
      id: ORG_IDS.platform,
      type: 'platform_admin',
      name: 'T4D 運営',
      legalName: null,
      code: 'PLATFORM',
      countryCode: 'JP',
      deletedAt: null,
      ...audit(at(400)),
    },
  );

  for (const spec of DEMO_USERS) {
    const uid = userId(spec.email);
    db.profiles.push({
      id: uid,
      email: spec.email,
      displayName: spec.displayName,
      jobTitle: spec.jobTitle,
      locale: 'ja',
      timezone: 'Asia/Tokyo',
      createdAt: at(360),
    });
    const membershipId = fid('membership', `${spec.organizationId}/${spec.email}`);
    db.memberships.push({
      id: membershipId,
      organizationId: spec.organizationId,
      userId: uid,
      status: 'active',
      unitScopeIds: spec.unitScopeIds,
      invitedBy: null,
      joinedAt: at(355),
      ...audit(at(360)),
    });
    for (const roleKey of spec.roleKeys) {
      db.membershipRoles.push({ membershipId, roleKey, grantedAt: at(355), grantedBy: null });
    }
  }

  // ------------------------------------------------------------------
  // 組織階層 / 報告期間 / 指標
  // ------------------------------------------------------------------
  AOMI_UNITS.forEach((u, index) => {
    db.units.push({
      id: u.id,
      organizationId: ORG_IDS.aomi,
      parentId: u.parent ? UNIT_IDS[u.parent] : null,
      code: u.code,
      name: u.name,
      unitType: u.unitType,
      countryCode: u.countryCode,
      currencyCode: u.currencyCode,
      timezone: u.timezone,
      consolidationMethod: u.consolidationMethod,
      ownershipPercent: u.ownershipPercent,
      exclusionReason: u.consolidationMethod === 'excluded' ? 'サプライヤーのため連結対象外' : null,
      sortOrder: index,
      deletedAt: null,
      ...audit(at(350)),
    });
  });
  db.units.push({
    id: UNIT_IDS.sotenHq,
    organizationId: ORG_IDS.soten,
    parentId: null,
    code: 'HQ',
    name: '本社',
    unitType: 'headquarters',
    countryCode: 'JP',
    currencyCode: 'JPY',
    timezone: 'Asia/Tokyo',
    consolidationMethod: 'full',
    ownershipPercent: 100,
    exclusionReason: null,
    sortOrder: 0,
    deletedAt: null,
    ...audit(at(340)),
  });

  db.periods.push(
    {
      id: PERIOD_IDS.fy2025,
      organizationId: ORG_IDS.aomi,
      code: 'FY2025',
      label: '2025年度（2025-04-01〜2026-03-31）',
      startDate: '2025-04-01',
      endDate: '2026-03-31',
      status: 'closed',
      submissionDueDate: '2026-06-30',
      ...audit(at(340)),
    },
    {
      id: PERIOD_IDS.fy2026,
      organizationId: ORG_IDS.aomi,
      code: 'FY2026',
      label: '2026年度（2026-04-01〜2027-03-31）',
      startDate: '2026-04-01',
      endDate: '2027-03-31',
      status: 'collecting',
      submissionDueDate: day(30),
      ...audit(at(140)),
    },
    {
      id: PERIOD_IDS.sotenFy2026,
      organizationId: ORG_IDS.soten,
      code: 'FY2026',
      label: '2026年度',
      startDate: '2026-04-01',
      endDate: '2027-03-31',
      status: 'collecting',
      submissionDueDate: day(30),
      ...audit(at(140)),
    },
  );

  for (const spec of METRIC_SPECS) {
    db.metrics.push({
      id: metricId('AOMI', spec.code),
      organizationId: ORG_IDS.aomi,
      code: spec.code,
      name: spec.name,
      description: spec.description,
      category: spec.category,
      unit: spec.unit,
      baseUnit: spec.baseUnit,
      dataType: spec.dataType,
      aggregationMethod: spec.aggregationMethod,
      numeratorMetricCode: spec.numerator ?? null,
      denominatorMetricCode: spec.denominator ?? null,
      formula:
        spec.numerator && spec.denominator ? `${spec.numerator} / ${spec.denominator} * 100` : null,
      requiresEvidence: spec.requiresEvidence,
      hqOnly: spec.hqOnly ?? false,
      materiality: spec.materiality,
      reportingFrequency: 'annual',
      responsibleDepartment:
        spec.category === 'human_capital' || spec.category === 'governance'
          ? '人事部'
          : '環境管理部',
      yoyWarningRatio: spec.yoyWarningRatio ?? null,
      minValue: spec.minValue ?? null,
      maxValue: spec.maxValue ?? null,
      deletedAt: null,
      ...audit(at(345)),
    });
    // 別テナントにも同名の指標を持たせ、テナント越境が起きないことを検証できるようにする
    db.metrics.push({
      id: metricId('SOTEN', spec.code),
      organizationId: ORG_IDS.soten,
      code: spec.code,
      name: spec.name,
      description: spec.description,
      category: spec.category,
      unit: spec.unit,
      baseUnit: spec.baseUnit,
      dataType: spec.dataType,
      aggregationMethod: spec.aggregationMethod,
      numeratorMetricCode: spec.numerator ?? null,
      denominatorMetricCode: spec.denominator ?? null,
      formula: null,
      requiresEvidence: spec.requiresEvidence,
      hqOnly: spec.hqOnly ?? false,
      materiality: spec.materiality,
      reportingFrequency: 'annual',
      responsibleDepartment: null,
      yoyWarningRatio: spec.yoyWarningRatio ?? null,
      minValue: spec.minValue ?? null,
      maxValue: spec.maxValue ?? null,
      deletedAt: null,
      ...audit(at(340)),
    });
  }

  for (const spec of EMISSION_FACTOR_SPECS) {
    db.emissionFactors.push({
      id: fid('emission_factor', `AOMI/${spec.code}`),
      organizationId: ORG_IDS.aomi,
      code: spec.code,
      name: spec.name,
      category: spec.category,
      factorValue: spec.factorValue,
      factorUnit: spec.factorUnit,
      activityUnit: spec.activityUnit,
      factorYear: spec.factorYear,
      factorSource: 'FIXTURE（架空値・実係数ではありません）',
      createdAt: at(200),
    });
  }

  // ------------------------------------------------------------------
  // Evidence ファイル
  // ------------------------------------------------------------------
  const FILE_SPECS: Array<{
    key: string;
    name: string;
    mime: string;
    docType: string;
    pages: number;
  }> = [
    {
      key: 'power-invoice',
      name: '電力請求書_{P}.pdf',
      mime: 'application/pdf',
      docType: '請求書',
      pages: 6,
    },
    {
      key: 'waste-manifest',
      name: '廃棄物マニフェスト_{P}.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      docType: 'マニフェスト',
      pages: 1,
    },
    {
      key: 'hr-data',
      name: '人事データ_{P}.csv',
      mime: 'text/csv',
      docType: '人事データ',
      pages: 1,
    },
    {
      key: 'purchase-ledger',
      name: '購買明細_{P}.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      docType: '購買台帳',
      pages: 1,
    },
    {
      key: 'fuel-log',
      name: '燃料使用記録_{P}.pdf',
      mime: 'application/pdf',
      docType: '計測記録',
      pages: 3,
    },
  ];

  const fileVersionByKey = new Map<string, string>();

  for (const periodCode of ['FY2025', 'FY2026'] as const) {
    const periodId = periodCode === 'FY2025' ? PERIOD_IDS.fy2025 : PERIOD_IDS.fy2026;
    for (const spec of FILE_SPECS) {
      const fileKey = `${spec.key}/${periodCode}`;
      const fileIdValue = fid('file', `AOMI/${fileKey}`);
      const versionId = fid('file_version', `AOMI/${fileKey}/v1`);
      const name = spec.name.replace('{P}', periodCode);
      const storageKey = `enterprise/${ORG_IDS.aomi}/evidence/${versionId}/${spec.key}.bin`;
      db.files.push({
        id: fileIdValue,
        organizationId: ORG_IDS.aomi,
        bucket: 'evidence-private',
        originalName: name,
        mimeType: spec.mime,
        confidentiality: 'confidential',
        currentVersionId: versionId,
        documentType: spec.docType,
        reportingPeriodId: periodId,
        scanStatus: 'skipped',
        deletedAt: null,
        ...audit(
          at(periodCode === 'FY2025' ? 300 : 60),
          at(periodCode === 'FY2025' ? 300 : 60),
          userId('site-user@demo.local'),
        ),
      });
      db.fileVersions.push({
        id: versionId,
        fileId: fileIdValue,
        organizationId: ORG_IDS.aomi,
        versionNo: 1,
        storageKey,
        sizeBytes: 120_000 + spec.key.length * 731,
        sha256: contentHash(`${fileKey}/content`),
        createdAt: at(periodCode === 'FY2025' ? 300 : 60),
        createdBy: userId('site-user@demo.local'),
      });
      fileVersionByKey.set(fileKey, versionId);

      for (let p = 1; p <= spec.pages; p += 1) {
        db.fragments.push({
          id: fid('fragment', `${fileKey}/p${p}`),
          fileVersionId: versionId,
          organizationId: ORG_IDS.aomi,
          page: p,
          kind: spec.mime === 'application/pdf' ? 'text' : 'table',
          // 書類らしい紙面（発行者・番号・明細・合計）を入れる。
          // Fixture は実体を持たないため、ここが Evidence Viewer に出る唯一の中身になる。
          text: buildEvidenceText(spec.key, periodCode, p),
          locator: spec.mime === 'application/pdf' ? `p.${p}` : 'Sheet1!A1:E40',
          createdAt: at(periodCode === 'FY2025' ? 300 : 60),
        });
      }
    }
  }

  function evidenceFileKeyFor(metricCode: string): string | null {
    if (metricCode === 'scope1') return 'fuel-log';
    if (metricCode === 'scope2' || metricCode === 'energy') return 'power-invoice';
    if (metricCode === 'waste') return 'waste-manifest';
    if (metricCode === 'scope3_cat1') return 'purchase-ledger';
    if (
      metricCode === 'employees' ||
      metricCode === 'managers_total' ||
      metricCode === 'female_managers'
    )
      return 'hr-data';
    return null;
  }

  // ------------------------------------------------------------------
  // Data Point / Version / Validation / Evidence Link
  // ------------------------------------------------------------------
  const seeds = buildDataPointSeeds();
  const metricByCode = new Map(METRIC_SPECS.map((m) => [m.code, m]));
  const unitByCode = new Map(AOMI_UNITS.map((u) => [u.code, u]));

  for (const seed of seeds) {
    const spec = must(metricByCode.get(seed.metricCode), `metric ${seed.metricCode}`);
    const unit = must(unitByCode.get(seed.unitCode), `unit ${seed.unitCode}`);
    const periodId = seed.periodCode === 'FY2025' ? PERIOD_IDS.fy2025 : PERIOD_IDS.fy2026;
    const dpId = dataPointId(seed.unitCode, seed.metricCode, seed.periodCode);
    const createdAt = seed.periodCode === 'FY2025' ? at(300) : at(70);
    const owner =
      seed.unitCode === 'EAST'
        ? userId('site-user@demo.local')
        : userId('sustainability@demo.local');

    // Version 履歴。Snapshot 後変更 / 承認後変更のケースは v2 を持つ。
    const versions: DataPointVersion[] = [];
    const hasSecondVersion = Boolean(seed.changedAfterSnapshot || seed.changedAfterApproval);
    const originalValue =
      hasSecondVersion && seed.value !== null
        ? Math.round(seed.value * 0.94 * 10) / 10
        : seed.value;

    versions.push({
      id: fid('data_point_version', `${dpId}/v1`),
      dataPointId: dpId,
      organizationId: ORG_IDS.aomi,
      versionNo: 1,
      value: originalValue,
      textValue: null,
      unitOfMeasure: seed.unitOfMeasure,
      status: seed.status === 'approved' ? 'approved' : seed.status,
      sourceType: seed.metricCode === 'scope3_cat1' ? 'calculation' : 'import',
      sourceReference:
        seed.metricCode === 'scope3_cat1' ? '購買明細からの算定' : '拠点提出ファイル',
      changeReason: null,
      contentHash: contentHash(`${dpId}|1|${originalValue}|${seed.unitOfMeasure}`),
      createdAt,
      createdBy: owner,
    });

    // 承認後変更（Snapshot 固定より前）と Snapshot 後変更を時刻で区別する。
    // Snapshot は at(21) に固定されるため、前者は at(30)、後者は at(14)。
    const secondVersionAt = seed.changedAfterApproval ? at(30) : at(14);
    if (hasSecondVersion) {
      versions.push({
        id: fid('data_point_version', `${dpId}/v2`),
        dataPointId: dpId,
        organizationId: ORG_IDS.aomi,
        versionNo: 2,
        value: seed.value,
        textValue: null,
        unitOfMeasure: seed.unitOfMeasure,
        status: seed.status,
        sourceType: 'manual',
        sourceReference: '拠点からの再提出',
        changeReason: seed.changedAfterApproval
          ? '承認後に計測記録の誤りが判明したため修正'
          : '検針票の再集計により修正',
        contentHash: contentHash(`${dpId}|2|${seed.value}|${seed.unitOfMeasure}`),
        createdAt: secondVersionAt,
        createdBy: owner,
      });
    }
    db.dataPointVersions.push(...versions);
    const current = must(versions[versions.length - 1], `version for ${dpId}`);

    db.dataPoints.push({
      id: dpId,
      organizationId: ORG_IDS.aomi,
      metricId: metricId('AOMI', seed.metricCode),
      unitId: unit.id,
      reportingPeriodId: periodId,
      boundary: unit.consolidationMethod === 'full' ? '連結' : '単体',
      status: seed.status,
      currentVersionId: current.id,
      value: current.value,
      textValue: null,
      unitOfMeasure: seed.unitOfMeasure,
      methodology:
        seed.metricCode === 'scope3_cat1'
          ? '購買金額 × 排出係数（金額ベース）'
          : spec.dataType === 'ratio'
            ? `${spec.numerator} ÷ ${spec.denominator} × 100`
            : '実測値の集計',
      ownerUserId: owner,
      reviewerUserId: userId('reviewer@demo.local'),
      approvedAt: seed.status === 'approved' ? at(seed.periodCode === 'FY2025' ? 280 : 35) : null,
      approvedBy: seed.status === 'approved' ? userId('approver@demo.local') : null,
      changedAfterApproval: Boolean(seed.changedAfterApproval),
      deletedAt: null,
      ...audit(createdAt, hasSecondVersion ? secondVersionAt : createdAt, owner),
    });

    if (seed.status === 'approved') {
      db.approvals.push({
        id: fid('approval', `${dpId}/final`),
        organizationId: ORG_IDS.aomi,
        targetType: 'data_point',
        targetId: dpId,
        targetVersionId: must(versions[0], 'v1').id,
        stage: 'final',
        decision: 'approved',
        actorUserId: userId('approver@demo.local'),
        comment: null,
        decidedAt: at(seed.periodCode === 'FY2025' ? 280 : 35),
      });
    }
    if (seed.status === 'returned') {
      db.approvals.push({
        id: fid('approval', `${dpId}/return`),
        organizationId: ORG_IDS.aomi,
        targetType: 'data_point',
        targetId: dpId,
        targetVersionId: must(versions[0], 'v1').id,
        stage: 'review',
        decision: 'returned',
        actorUserId: userId('reviewer@demo.local'),
        comment: '検針票の対象期間が報告対象期間とずれています。再確認してください。',
        decidedAt: at(12),
      });
    }

    // Evidence 紐付け
    if (seed.hasEvidence) {
      const fileKeyBase = evidenceFileKeyFor(seed.metricCode);
      if (fileKeyBase) {
        const fvId = fileVersionByKey.get(`${fileKeyBase}/${seed.periodCode}`);
        if (fvId) {
          db.evidenceLinks.push({
            id: fid('evidence_link', `${dpId}/${fileKeyBase}`),
            organizationId: ORG_IDS.aomi,
            fileVersionId: fvId,
            targetType: 'data_point',
            targetId: dpId,
            page: fileKeyBase.endsWith('log') || fileKeyBase.endsWith('invoice') ? 2 : null,
            cellRef: fileKeyBase.endsWith('invoice') ? null : 'Sheet1!C12',
            fragmentId: fid('fragment', `${fileKeyBase}/${seed.periodCode}/p1`),
            sourceUrl: null,
            coveragePeriodStart: seed.periodCode === 'FY2025' ? '2025-04-01' : '2026-04-01',
            coveragePeriodEnd: seed.periodCode === 'FY2025' ? '2026-03-31' : '2027-03-31',
            obtainedAt: seed.periodCode === 'FY2025' ? '2026-04-15' : day(-50),
            note: null,
            ...audit(
              at(seed.periodCode === 'FY2025' ? 295 : 55),
              at(seed.periodCode === 'FY2025' ? 295 : 55),
              owner,
            ),
          });
        }
      }
    }
  }

  // Scope3 Cat.1 の算定内訳
  const scope3DpId = dataPointId('HQ', 'scope3_cat1', 'FY2026');
  const factorByCode = new Map(EMISSION_FACTOR_SPECS.map((f) => [f.code, f]));
  const scope3Inputs = SCOPE3_PURCHASE_ROWS.map((row) => {
    const factor = must(factorByCode.get(row.factorCode), `factor ${row.factorCode}`);
    return {
      label: `${must(unitByCode.get(row.supplierUnitCode), row.supplierUnitCode).name} / ${row.item}`,
      value: Math.round(row.amountThousandJpy * factor.factorValue * 10) / 10,
      unit: 't-CO2e',
      sourceType: 'emission_factor' as const,
      sourceId: fid('emission_factor', `AOMI/${row.factorCode}`),
      note: `購買金額 ${row.amountThousandJpy.toLocaleString('ja-JP')} 千円 × 係数 ${factor.factorValue} (${factor.factorYear}年度)`,
    };
  });
  db.calculations.push({
    id: fid('calculation', `${scope3DpId}/v1`),
    dataPointId: scope3DpId,
    organizationId: ORG_IDS.aomi,
    formula: 'Σ(購買金額[千円] × 排出係数[t-CO2e/千円])',
    inputs: scope3Inputs,
    result: Math.round(scope3Inputs.reduce((s, i) => s + i.value, 0) * 10) / 10,
    resultUnit: 't-CO2e',
    calculatedAt: at(65),
    calculatedBy: userId('sustainability@demo.local'),
  });

  // ------------------------------------------------------------------
  // 開示フレームワーク（架空縮小マスター）
  // ------------------------------------------------------------------
  const cdpFrameworkId = fid('framework', 'cdp');
  const ssbjFrameworkId = fid('framework', 'ssbj');
  db.frameworks.push(
    {
      id: cdpFrameworkId,
      key: 'cdp',
      name: 'CDP 気候変動質問書（架空縮小版）',
      description:
        '正式質問書ではありません。年度 Version 差分の再現を目的とした架空マスターです。',
    },
    {
      id: ssbjFrameworkId,
      key: 'ssbj',
      name: SSBJ_FRAMEWORK_INFO.name,
      description: SSBJ_FRAMEWORK_INFO.description,
    },
  );

  const cdp2025 = fid('framework_version', 'cdp/2025');
  const cdp2026 = fid('framework_version', 'cdp/2026');
  const ssbj2026 = fid('framework_version', 'ssbj/2026');
  db.frameworkVersions.push(
    {
      id: cdp2025,
      frameworkId: cdpFrameworkId,
      year: 2025,
      label: 'CDP 2025（架空）',
      status: 'superseded',
      isFixture: true,
      createdAt: at(400),
    },
    {
      id: cdp2026,
      frameworkId: cdpFrameworkId,
      year: 2026,
      label: 'CDP 2026（架空）',
      status: 'published',
      isFixture: true,
      createdAt: at(120),
    },
    {
      id: ssbj2026,
      frameworkId: ssbjFrameworkId,
      year: SSBJ_FRAMEWORK_INFO.year,
      label: SSBJ_FRAMEWORK_INFO.versionLabel,
      status: 'published',
      // 正式基準の条文（SSBJ の転載許可取得済み）なので架空フラグを立てない
      isFixture: false,
      createdAt: at(120),
    },
  );

  CDP_ITEM_SPECS.forEach((spec, index) => {
    // 2025 版（前年）— 新規質問は 2025 に存在しない
    if (spec.changeType2026 !== 'new') {
      db.disclosureItems.push({
        id: fid('disclosure_item', `cdp/2025/${spec.code}`),
        frameworkVersionId: cdp2025,
        code: spec.code,
        section: spec.section,
        sortOrder: index,
        questionText: spec.questionText,
        guidance: spec.guidance,
        answerType: spec.answerType,
        options: spec.options ?? [],
        required: spec.required,
        parentCode: null,
        changeType: 'carry_forward',
        previousItemCode: null,
        createdAt: at(400),
      });
    }
    db.disclosureItems.push({
      id: fid('disclosure_item', `cdp/2026/${spec.code}`),
      frameworkVersionId: cdp2026,
      code: spec.code,
      section: spec.section,
      sortOrder: index,
      questionText: spec.questionText,
      guidance: spec.guidance,
      answerType: spec.answerType,
      options: spec.options ?? [],
      required: spec.required,
      parentCode: null,
      changeType: spec.changeType2026,
      previousItemCode: spec.changeType2026 === 'new' ? null : spec.code,
      createdAt: at(120),
    });
  });

  // 適用条件（CDP-P0-002）。依存先の回答によって適用／非適用が決まる質問。
  // 2025 版・2026 版のどちらにも同じ条件を付ける。
  for (const versionId of [cdp2025, cdp2026]) {
    for (const cond of CDP_ITEM_CONDITIONS) {
      const item = db.disclosureItems.find(
        (i) => i.frameworkVersionId === versionId && i.code === cond.itemCode,
      );
      if (!item) continue;
      db.itemConditions.push({
        id: fid('disclosure_item_condition', `${item.id}/${cond.dependsOnItemCode}`),
        itemId: item.id,
        dependsOnItemCode: cond.dependsOnItemCode,
        operator: cond.operator,
        value: cond.value,
      });
    }
  }

  // SSBJ は正式基準の条文マスター（src/lib/frameworks/ssbj-2026.ts）。
  // questionText に要約タイトル、guidance に原文を入れる。
  SSBJ_MASTER_ITEMS.forEach((spec, index) => {
    db.disclosureItems.push({
      id: fid('disclosure_item', `ssbj/2026/${spec.code}`),
      frameworkVersionId: ssbj2026,
      code: spec.code,
      section: spec.section,
      sortOrder: index,
      questionText: spec.title,
      guidance: spec.text,
      answerType: spec.answerType,
      options: [],
      required: spec.required,
      parentCode: null,
      changeType: spec.changeType,
      previousItemCode: null,
      createdAt: at(120),
    });
  });

  // FY2025 回答（承認済み）と FY2026 回答（未着手中心）
  for (const spec of CDP_ITEM_SPECS) {
    const prevItemId = fid('disclosure_item', `cdp/2025/${spec.code}`);
    const curItemId = fid('disclosure_item', `cdp/2026/${spec.code}`);
    const prevResponseId = fid('disclosure_response', `AOMI/FY2025/${spec.code}`);
    const curResponseId = fid('disclosure_response', `AOMI/FY2026/${spec.code}`);

    if (spec.changeType2026 !== 'new') {
      const versionId = fid('disclosure_response_version', `AOMI/FY2025/${spec.code}/v1`);
      db.disclosureResponses.push({
        id: prevResponseId,
        organizationId: ORG_IDS.aomi,
        itemId: prevItemId,
        reportingPeriodId: PERIOD_IDS.fy2025,
        status: 'approved',
        currentVersionId: versionId,
        answerText: spec.previousAnswer ?? null,
        answerNumeric: spec.previousNumeric ?? null,
        answerChoice:
          spec.answerType === 'single_choice' && spec.previousAnswer ? [spec.previousAnswer] : [],
        ownerUserId: userId('sustainability@demo.local'),
        reviewerUserId: userId('reviewer@demo.local'),
        approvedAt: at(280),
        approvedBy: userId('approver@demo.local'),
        previousResponseId: null,
        carryForwardDecision: null,
        ...audit(at(300), at(280), userId('sustainability@demo.local')),
      });
      db.disclosureResponseVersions.push({
        id: versionId,
        responseId: prevResponseId,
        organizationId: ORG_IDS.aomi,
        versionNo: 1,
        answerText: spec.previousAnswer ?? null,
        answerNumeric: spec.previousNumeric ?? null,
        answerChoice:
          spec.answerType === 'single_choice' && spec.previousAnswer ? [spec.previousAnswer] : [],
        status: 'approved',
        originatedFromAiRunId: null,
        changeReason: null,
        contentHash: contentHash(
          `${prevResponseId}|1|${spec.previousAnswer ?? spec.previousNumeric ?? ''}`,
        ),
        createdAt: at(300),
        createdBy: userId('sustainability@demo.local'),
      });
    }

    db.disclosureResponses.push({
      id: curResponseId,
      organizationId: ORG_IDS.aomi,
      itemId: curItemId,
      reportingPeriodId: PERIOD_IDS.fy2026,
      status: 'not_started',
      currentVersionId: null,
      answerText: null,
      answerNumeric: null,
      answerChoice: [],
      ownerUserId: userId('sustainability@demo.local'),
      reviewerUserId: userId('reviewer@demo.local'),
      approvedAt: null,
      approvedBy: null,
      previousResponseId: spec.changeType2026 !== 'new' ? prevResponseId : null,
      carryForwardDecision: null,
      ...audit(at(120)),
    });

    if (spec.metricCode) {
      db.disclosureMappings.push({
        id: fid('disclosure_mapping', `cdp/2026/${spec.code}/${spec.metricCode}`),
        organizationId: ORG_IDS.aomi,
        itemId: curItemId,
        metricId: metricId('AOMI', spec.metricCode),
        unitId: null,
        transform: null,
        mappingSource: 'manual',
        aiRunId: null,
        confirmedBy: userId('sustainability@demo.local'),
        confirmedAt: at(100),
        ...audit(at(100), at(100), userId('sustainability@demo.local')),
      });
    }
  }

  for (const spec of SSBJ_MASTER_ITEMS) {
    if (!spec.metricCode) continue;
    db.disclosureMappings.push({
      id: fid('disclosure_mapping', `ssbj/2026/${spec.code}/${spec.metricCode}`),
      organizationId: ORG_IDS.aomi,
      itemId: fid('disclosure_item', `ssbj/2026/${spec.code}`),
      metricId: metricId('AOMI', spec.metricCode),
      unitId: null,
      transform: null,
      mappingSource: 'manual',
      aiRunId: null,
      confirmedBy: userId('sustainability@demo.local'),
      confirmedAt: at(100),
      ...audit(at(100), at(100), userId('sustainability@demo.local')),
    });
  }

  // ------------------------------------------------------------------
  // SSBJ ギャップ評価
  //
  // 133 要求事項それぞれについて、適用区分・重要性・3 観点の対応状況を持つ。
  // 「初年度の途中」を想定した分布にしてある（対応済みが積み上がりつつ、
  // データ整備と業務プロセスの整備が遅れている状態）。決定論的に割り当てる。
  // ------------------------------------------------------------------
  {
    const period = PERIOD_IDS.fy2026;
    const owner = userId('sustainability@demo.local');
    const reviewer = userId('reviewer@demo.local');

    /** 決定論的な擬似乱数（項目コードから作る。実行のたびに同じ分布になる） */
    const bucket = (code: string, mod: number): number => {
      let h = 0;
      for (const ch of code) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return h % mod;
    };

    const DEPARTMENTS = [
      'サステナビリティ推進部',
      '経営企画部',
      '財務経理部',
      '人事総務部',
      '生産本部',
    ];

    SSBJ_MASTER_ITEMS.forEach((spec, index) => {
      const itemId = fid('disclosure_item', `ssbj/2026/${spec.code}`);
      const seed = bucket(spec.code, 100);

      // 実務対応基準（温対法 SHK 制度を選択していない）は対象外
      const notApplicable = spec.code.startsWith('実務-') && seed % 2 === 0;
      // 金融活動に関する要求事項は当社に重要性なし
      const notMaterial = /ファイナンスド|金融活動|カーボン・クレジット/.test(spec.title);

      let disclosure: SsbjCoverageStatus;
      let data: SsbjCoverageStatus;
      let process: SsbjCoverageStatus;
      if (notApplicable || notMaterial) {
        disclosure = 'unconfirmed';
        data = 'unconfirmed';
        process = 'unconfirmed';
      } else if (seed < 26) {
        // 3 観点そろって対応できている
        disclosure = 'covered';
        data = 'covered';
        process = 'covered';
      } else if (seed < 40) {
        // 開示は済み、データと仕組みが仕上げ段階
        disclosure = 'covered';
        data = 'mostly_covered';
        process = 'mostly_covered';
      } else if (seed < 62) {
        // 書いてはあるが、データか仕組みが途中
        disclosure = seed < 52 ? 'covered' : 'mostly_covered';
        data = 'partial';
        process = 'partial';
      } else if (seed < 84) {
        // データか仕組みが無く、継続的な開示ができない
        disclosure = seed < 74 ? 'partial' : 'not_covered';
        data = seed < 70 ? 'partial' : 'not_covered';
        process = 'not_covered';
      } else {
        // まだ確認していない
        disclosure = 'unconfirmed';
        data = 'unconfirmed';
        process = 'unconfirmed';
      }

      const reviewed = !notApplicable && !notMaterial && seed < 88 && seed % 7 !== 0;
      const aiEvaluated = !notApplicable && seed < 96;
      const combined = [disclosure, data, process].includes('not_covered')
        ? 'not_covered'
        : [disclosure, data, process].includes('unconfirmed')
          ? 'unconfirmed'
          : [disclosure, data, process].includes('partial')
            ? 'partial'
            : [disclosure, data, process].includes('mostly_covered')
              ? 'mostly_covered'
              : 'covered';

      const missing: string[] = [];
      if (disclosure !== 'covered') missing.push(`${spec.title}のうち、記述が確認できない事項`);
      if (data === 'not_covered') missing.push('開示に必要な数値が台帳に存在しません');
      if (process === 'not_covered') missing.push('継続的に収集・承認する仕組みが未整備です');

      db.ssbjAssessments.push({
        id: fid('ssbj_assessment', `${ORG_IDS.aomi}/${period}/${spec.code}`),
        organizationId: ORG_IDS.aomi,
        reportingPeriodId: period,
        itemId,
        applicability: notApplicable ? 'not_applicable' : 'applicable',
        applicabilityReason: notApplicable
          ? '温対法 SHK 制度の方法を用いていないため、本実務対応基準の適用対象外です。'
          : '',
        materiality: notMaterial ? 'not_material' : seed < 78 ? 'material' : 'not_assessed',
        materialityReason: notMaterial
          ? '当社は資産運用・商業銀行・保険のいずれの活動も行っていないため、重要性なしと判断しました。'
          : '',
        disclosureStatus: disclosure,
        dataStatus: data,
        processStatus: process,
        aiStatus: aiEvaluated ? combined : null,
        aiComment: aiEvaluated
          ? `統合報告書2026 の該当箇所に関連する記述が見つかりました。ただし SSBJ ${spec.code} が求める事項のうち、不足している情報に挙げた点について十分な説明が確認できません。`
          : '',
        aiMissingInfo: aiEvaluated ? missing : [],
        aiRecommendation: aiEvaluated
          ? data === 'not_covered'
            ? 'まず必要な数値の収集方法を決め、データ収集項目として担当部署へ依頼してください。'
            : '不足している事項について、追加開示を検討してください。'
          : '',
        aiRunId: null,
        aiEvaluatedAt: aiEvaluated ? at(30) : null,
        sourceDocument: aiEvaluated ? '統合報告書2026' : null,
        sourcePage: aiEvaluated ? `${28 + (index % 60)} ページ` : null,
        sourceExcerpt: aiEvaluated
          ? 'サステナビリティ委員会は、気候関連を含むサステナビリティ関連のリスク及び機会について四半期ごとに審議し、その結果を取締役会へ報告しています。'
          : null,
        reviewDecision: reviewed ? (seed % 3 === 0 ? 'modified' : 'approved') : null,
        reviewedBy: reviewed ? reviewer : null,
        reviewedAt: reviewed ? at(24) : null,
        reviewComment: reviewed
          ? seed % 3 === 0
            ? '記載箇所を確認し、開示の対応状況を一段引き下げました。'
            : 'AI の判定内容を確認し、妥当と判断しました。'
          : '',
        finalStatus: reviewed ? combined : null,
        ownerDepartment: DEPARTMENTS[bucket(spec.code, DEPARTMENTS.length)] ?? DEPARTMENTS[0]!,
        ownerUserId: owner,
        carriedOverFrom: null,
        recheckReason: spec.changeType === 'new' ? 'SSBJ 基準の改正で追加された要求事項です。' : '',
        ...audit(at(40), reviewed ? at(24) : at(40), owner),
      });
    });

    // 対応計画。優先度の高いギャップから 6 件を起票済みにしておく
    const planSpecs: Array<{
      code: string;
      gapKind: SsbjGapKind;
      title: string;
      detail: string;
      actionType: SsbjActionType;
      department: string;
      dueDate: string;
      priority: SsbjPriority;
      status: SsbjActionStatus;
      linkedMetricCode: string | null;
    }> = [
      {
        code: '気候-47(3)',
        gapKind: 'data',
        title: 'スコープ3 カテゴリー別排出量の収集方法を決めて収集する',
        detail:
          'カテゴリー1 以外の排出量が算定できていない。カテゴリーごとの算定方法（金額ベース／物量ベース）を決めたうえで、調達部・物流部から一次データを集める。',
        actionType: 'data_collection',
        department: '調達部',
        dueDate: '2026-11-28',
        priority: 'high',
        status: 'in_progress',
        linkedMetricCode: 'scope3_cat1',
      },
      {
        code: '気候-10',
        gapKind: 'disclosure',
        title: '取締役会への報告頻度と監督プロセスを追加開示する',
        detail:
          '監督主体は記載済みだが、報告の頻度と、監督結果を経営判断へ反映するプロセスの記述が不足している。統合報告書のガバナンス章へ追記する。',
        actionType: 'disclosure_addition',
        department: '経営企画部',
        dueDate: '2026-10-31',
        priority: 'high',
        status: 'in_progress',
        linkedMetricCode: null,
      },
      {
        code: '気候-63',
        gapKind: 'process',
        title: '排出量の算定根拠と承認履歴を残す運用へ切り替える',
        detail:
          '子会社から表計算ファイルをメールで集めているだけで、証跡と承認履歴が残っていない。本システムのデータ収集・承認フローへ移行する。',
        actionType: 'internal_control',
        department: 'サステナビリティ推進部',
        dueDate: '2026-12-19',
        priority: 'high',
        status: 'not_started',
        linkedMetricCode: null,
      },
      {
        code: '一般-29',
        gapKind: 'process',
        title: 'サステナビリティ関連リスクの識別・評価プロセスを規程化する',
        detail:
          '全社のリスク管理プロセスへ統合されている程度を説明できるよう、リスク管理規程へサステナビリティ関連リスクの取扱いを明記する。',
        actionType: 'policy',
        department: '経営企画部',
        dueDate: '2027-01-30',
        priority: 'medium',
        status: 'not_started',
        linkedMetricCode: null,
      },
      {
        code: '気候-84',
        gapKind: 'data',
        title: '役員報酬に占める気候関連評価項目の割合を集計する',
        detail:
          '報酬委員会の評価表から、気候関連の評価項目に結び付く報酬の割合を算定できるようにする。',
        actionType: 'calculation_method',
        department: '人事総務部',
        dueDate: '2026-12-05',
        priority: 'medium',
        status: 'not_started',
        linkedMetricCode: null,
      },
      {
        code: '気候-92',
        gapKind: 'disclosure',
        title: '温室効果ガス排出目標の対象範囲と算定基礎を明記する',
        detail:
          '目標が企業全体に適用されるのか一部か、絶対量か原単位かを明記する。中間目標の内容も併記する。',
        actionType: 'disclosure_addition',
        department: 'サステナビリティ推進部',
        dueDate: '2026-11-14',
        priority: 'medium',
        status: 'in_review',
        linkedMetricCode: null,
      },
    ];

    for (const [index, plan] of planSpecs.entries()) {
      const assessmentId = fid('ssbj_assessment', `${ORG_IDS.aomi}/${period}/${plan.code}`);
      db.ssbjActionPlans.push({
        id: fid('ssbj_action_plan', `${ORG_IDS.aomi}/${period}/${plan.code}/${plan.gapKind}`),
        organizationId: ORG_IDS.aomi,
        reportingPeriodId: period,
        assessmentId,
        gapKind: plan.gapKind,
        title: plan.title,
        detail: plan.detail,
        actionType: plan.actionType,
        department: plan.department,
        assigneeUserId: index % 2 === 0 ? owner : userId('approver@demo.local'),
        dueDate: plan.dueDate,
        priority: plan.priority,
        status: plan.status,
        linkedMetricCode: plan.linkedMetricCode,
        ...audit(at(28), at(20), owner),
      });
    }

    // データ収集項目（対応計画から作られたもの）。担当と期限を持つ
    const scope3MetricId = metricId('AOMI', 'scope3_cat1');
    for (const [index, unitId] of [UNIT_IDS.hq, UNIT_IDS.east, UNIT_IDS.west].entries()) {
      db.metricAssignments.push({
        id: fid('metric_assignment', `${scope3MetricId}/${unitId}/${period}`),
        organizationId: ORG_IDS.aomi,
        metricId: scope3MetricId,
        unitId,
        reportingPeriodId: period,
        ownerUserId: index === 0 ? owner : userId('site-user@demo.local'),
        reviewerUserId: reviewer,
        dueDate: '2026-11-28',
        ...audit(at(28), at(28), owner),
      });
    }
  }

  // ------------------------------------------------------------------
  // CSRD（ESRS 架空縮小マスター）。当社は初年度対応＝前年回答なし・全項目 new
  // ------------------------------------------------------------------
  const csrdFrameworkId = fid('framework', 'csrd');
  db.frameworks.push({
    id: csrdFrameworkId,
    key: 'csrd',
    name: 'CSRD / ESRS 開示項目（架空縮小版）',
    description:
      '正式な ESRS 全量ではありません。初年度ギャップ分析を目的とした架空縮小マスターです。',
  });
  const csrd2026 = fid('framework_version', 'csrd/2026');
  db.frameworkVersions.push({
    id: csrd2026,
    frameworkId: csrdFrameworkId,
    year: 2026,
    label: 'ESRS 2026（架空）',
    status: 'published',
    isFixture: true,
    createdAt: at(90),
  });

  CSRD_ITEM_SPECS.forEach((spec, index) => {
    const itemId = fid('disclosure_item', `csrd/2026/${spec.code}`);
    db.disclosureItems.push({
      id: itemId,
      frameworkVersionId: csrd2026,
      code: spec.code,
      section: spec.section,
      sortOrder: index,
      questionText: spec.questionText,
      guidance: spec.guidance,
      answerType: spec.answerType,
      options: spec.options ?? [],
      required: spec.required,
      parentCode: null,
      changeType: spec.changeType2026,
      previousItemCode: null,
      createdAt: at(90),
    });

    db.disclosureResponses.push({
      id: fid('disclosure_response', `AOMI/FY2026/${spec.code}`),
      organizationId: ORG_IDS.aomi,
      itemId,
      reportingPeriodId: PERIOD_IDS.fy2026,
      status: 'not_started',
      currentVersionId: null,
      answerText: null,
      answerNumeric: null,
      answerChoice: [],
      ownerUserId: userId('sustainability@demo.local'),
      reviewerUserId: userId('reviewer@demo.local'),
      approvedAt: null,
      approvedBy: null,
      previousResponseId: null,
      carryForwardDecision: null,
      ...audit(at(90)),
    });

    if (spec.metricCode) {
      db.disclosureMappings.push({
        id: fid('disclosure_mapping', `csrd/2026/${spec.code}/${spec.metricCode}`),
        organizationId: ORG_IDS.aomi,
        itemId,
        metricId: metricId('AOMI', spec.metricCode),
        unitId: null,
        transform: null,
        mappingSource: 'manual',
        aiRunId: null,
        confirmedBy: userId('sustainability@demo.local'),
        confirmedAt: at(88),
        ...audit(at(88), at(88), userId('sustainability@demo.local')),
      });
    }
  });

  // ------------------------------------------------------------------
  // 取込ジョブ Fixture
  // ------------------------------------------------------------------
  const completedJobId = fid('ingestion_job', 'AOMI/JOB-001');
  db.ingestionJobs.push({
    id: completedJobId,
    organizationId: ORG_IDS.aomi,
    reportingPeriodId: PERIOD_IDS.fy2026,
    unitId: UNIT_IDS.east,
    status: 'completed',
    progressPercent: 100,
    errorCode: null,
    errorMessage: null,
    retryCount: 0,
    idempotencyKey: 'fixture-job-001',
    startedAt: at(58, 2),
    finishedAt: at(58, 2, 4),
    totalRows: 6,
    mappedRows: 6,
    warningRows: 1,
    errorRows: 0,
    ...audit(at(58), at(58), userId('site-user@demo.local')),
  });

  const reviewJobId = fid('ingestion_job', 'AOMI/JOB-002');
  db.ingestionJobs.push({
    id: reviewJobId,
    organizationId: ORG_IDS.aomi,
    reportingPeriodId: PERIOD_IDS.fy2026,
    unitId: UNIT_IDS.west,
    status: 'needs_review',
    progressPercent: 100,
    errorCode: null,
    errorMessage: null,
    retryCount: 0,
    idempotencyKey: 'fixture-job-002',
    startedAt: at(9, 2),
    finishedAt: at(9, 2, 6),
    totalRows: 5,
    mappedRows: 3,
    warningRows: 2,
    errorRows: 0,
    ...audit(at(9), at(9), userId('sustainability@demo.local')),
  });

  const reviewJobFileId = fid('ingestion_job_file', `${reviewJobId}/f1`);
  db.ingestionJobFiles.push({
    id: reviewJobFileId,
    jobId: reviewJobId,
    organizationId: ORG_IDS.aomi,
    fileVersionId: must(fileVersionByKey.get('waste-manifest/FY2026'), 'waste manifest FY2026'),
    originalName: '西日本工場_環境データ_FY2026.csv',
    mimeType: 'text/csv',
    parseStatus: 'parsed',
    parseMessage: null,
    sheetName: null,
    detectedEncoding: 'Shift_JIS',
    createdAt: at(9),
  });

  const reviewRows: Array<{
    metricCode: string | null;
    value: number | null;
    unit: string | null;
    confidence: number;
    warnings: string[];
    status: IngestionRow['status'];
    raw: Record<string, string>;
  }> = [
    {
      metricCode: 'scope1',
      value: 2971.2,
      unit: 't-CO2e',
      confidence: 0.96,
      warnings: [],
      status: 'mapped',
      raw: { 拠点: '西日本工場', 項目: 'Scope1', 値: '2971.2', 単位: 't-CO2e', 期間: 'FY2026' },
    },
    {
      metricCode: 'scope2',
      value: 6944.2,
      unit: 't-CO2e',
      confidence: 0.94,
      warnings: [],
      status: 'mapped',
      raw: { 拠点: '西日本工場', 項目: 'Scope2', 値: '6944.2', 単位: 't-CO2e', 期間: 'FY2026' },
    },
    {
      metricCode: 'water',
      value: 924_000,
      unit: 'm3',
      confidence: 0.71,
      warnings: ['前年比 10.0 倍です。単位または桁を確認してください。'],
      status: 'needs_review',
      raw: { 拠点: '西日本工場', 項目: '用水使用量', 値: '924000', 単位: 'm3', 期間: 'FY2026' },
    },
    {
      metricCode: 'waste',
      value: 1070.4,
      unit: 't',
      confidence: 0.88,
      warnings: [],
      status: 'mapped',
      raw: { 拠点: '西日本工場', 項目: '廃棄物', 値: '1070.4', 単位: 't', 期間: 'FY2026' },
    },
    {
      metricCode: null,
      value: 18.4,
      unit: 'GJ',
      confidence: 0.32,
      warnings: ['指標を特定できませんでした。手動で選択してください。'],
      status: 'needs_review',
      raw: { 拠点: '西日本工場', 項目: '蒸気（購入分）', 値: '18.4', 単位: 'GJ', 期間: 'FY2026' },
    },
  ];

  reviewRows.forEach((row, index) => {
    db.ingestionRows.push({
      id: fid('ingestion_row', `${reviewJobId}/${index}`),
      jobId: reviewJobId,
      jobFileId: reviewJobFileId,
      organizationId: ORG_IDS.aomi,
      rowIndex: index + 2,
      raw: row.raw,
      metricId: row.metricCode ? metricId('AOMI', row.metricCode) : null,
      unitId: UNIT_IDS.west,
      reportingPeriodId: PERIOD_IDS.fy2026,
      value: row.value,
      unitOfMeasure: row.unit,
      confidence: row.confidence,
      warnings: row.warnings,
      status: row.status,
      sourceLocator: `行 ${index + 2}`,
      duplicateOfDataPointId: null,
      aiRunId: null,
      createdAt: at(9),
      updatedAt: at(9),
    });
  });

  // ------------------------------------------------------------------
  // 連結集計（DATA-P0-006）: Scope3 Cat.1 の集計ルールと内部取引の明細
  // 「内部取引」boundary の行はグループ内調達由来の二重計上分。
  // 通常の合計からは除外し（aggregation.ts の isCountedInTotals）、
  // 連結集計では控除額として表示する。
  // ------------------------------------------------------------------
  db.aggregationRules.push({
    id: fid('aggregation_rule', 'AOMI/scope3_cat1'),
    organizationId: ORG_IDS.aomi,
    metricId: metricId('AOMI', 'scope3_cat1'),
    method: 'sum',
    includeUnitTypes: ['headquarters', 'division', 'site', 'subsidiary'],
    applyOwnershipPercent: true,
    eliminateIntercompany: true,
    ...audit(at(200), at(200), userId('sustainability@demo.local')),
  });

  const intercompanySeeds: Array<{ unitKey: keyof typeof UNIT_IDS; value: number }> = [
    { unitKey: 'hq', value: 1850.0 },
    { unitKey: 'east', value: 640.5 },
  ];
  for (const seed of intercompanySeeds) {
    const dpId = fid('data_point', `AOMI/${seed.unitKey}/scope3_cat1/FY2026/内部取引`);
    const versionId = fid('data_point_version', `${dpId}/v1`);
    db.dataPointVersions.push({
      id: versionId,
      dataPointId: dpId,
      organizationId: ORG_IDS.aomi,
      versionNo: 1,
      value: seed.value,
      textValue: null,
      unitOfMeasure: 't-CO2e',
      sourceType: 'manual',
      sourceReference: 'グループ内取引の集計',
      status: 'approved',
      changeReason: null,
      contentHash: contentHash(`${dpId}|1|${seed.value}`),
      createdAt: at(40),
      createdBy: userId('sustainability@demo.local'),
    });
    // scope3_cat1 は Evidence 必須指標。承認済みで Evidence 無しの状態は
    // アプリの承認ゲート（data-point-workflow.ts）では作れず、品質指標に
    // 「意図しない missing_evidence」を混ぜてしまうため購買台帳を紐付ける。
    const intercompanyFvId = fileVersionByKey.get('purchase-ledger/FY2026');
    if (intercompanyFvId) {
      db.evidenceLinks.push({
        id: fid('evidence_link', `${dpId}/purchase-ledger`),
        organizationId: ORG_IDS.aomi,
        fileVersionId: intercompanyFvId,
        targetType: 'data_point',
        targetId: dpId,
        page: null,
        cellRef: 'Sheet1!C12',
        fragmentId: fid('fragment', 'purchase-ledger/FY2026/p1'),
        sourceUrl: null,
        coveragePeriodStart: '2026-04-01',
        coveragePeriodEnd: '2027-03-31',
        obtainedAt: day(-50),
        note: 'グループ内取引分の内訳（連結時に控除）',
        ...audit(at(40), at(40), userId('sustainability@demo.local')),
      });
    }
    db.dataPoints.push({
      id: dpId,
      organizationId: ORG_IDS.aomi,
      metricId: metricId('AOMI', 'scope3_cat1'),
      unitId: UNIT_IDS[seed.unitKey],
      reportingPeriodId: PERIOD_IDS.fy2026,
      boundary: '内部取引',
      status: 'approved',
      currentVersionId: versionId,
      value: seed.value,
      textValue: null,
      unitOfMeasure: 't-CO2e',
      methodology: 'グループ会社からの調達額 × 排出係数（連結時に控除）',
      ownerUserId: userId('sustainability@demo.local'),
      reviewerUserId: userId('reviewer@demo.local'),
      approvedAt: at(35),
      approvedBy: userId('approver@demo.local'),
      changedAfterApproval: false,
      deletedAt: null,
      ...audit(at(40), at(35), userId('sustainability@demo.local')),
    });
  }

  // ------------------------------------------------------------------
  // マテリアリティ評価（SSBJ 開示の起点）
  // 当期は評価済み、前期は未評価にして「期ごとに見直す」運用を表す。
  // ------------------------------------------------------------------
  const materialitySeed: Array<
    [
      string,
      string,
      'environment' | 'social' | 'governance',
      'high' | 'medium' | 'low' | 'not_material',
      string,
      string[],
    ]
  > = [
    [
      'climate_ghg',
      '気候変動（GHG 排出）',
      'environment',
      'high',
      '主要製品の製造工程がエネルギー多消費型であり、規制・炭素価格の影響を直接受けるため。',
      ['scope1', 'scope2', 'scope3_cat1', 'energy'],
    ],
    [
      'human_capital',
      '人的資本（人材の育成・多様性）',
      'social',
      'high',
      '技術者の確保と定着が事業継続の前提であり、投資家からの関心も高いため。',
      ['employees', 'female_employees', 'female_manager_ratio', 'training_hours', 'avg_tenure'],
    ],
    [
      'supply_chain',
      'サプライチェーン管理',
      'social',
      'medium',
      '購入部品の調達先が特定地域に集中しており、Scope3 の大半を占めるため。',
      ['scope3_cat1'],
    ],
    [
      'safety',
      '労働安全衛生',
      'social',
      'medium',
      '製造拠点における休業災害の低減が操業継続に直結するため。',
      ['ltifr'],
    ],
    [
      'water',
      '水資源の利用',
      'environment',
      'low',
      '主要拠点が水ストレスの低い地域にあり、使用量も限定的なため。',
      ['water'],
    ],
    [
      'circular',
      '資源循環・廃棄物',
      'environment',
      'medium',
      '産業廃棄物の処理費用と再生利用率が事業コストに影響するため。',
      ['waste'],
    ],
    [
      'governance',
      'コーポレートガバナンス',
      'governance',
      'medium',
      '取締役会の実効性評価と多様性が投資家との対話の中心にあるため。',
      ['officers_total', 'female_officers', 'directors_count'],
    ],
  ];
  for (const [topicKey, title, category, materiality, rationale, metricCodes] of materialitySeed) {
    db.materialityTopics.push({
      id: fid('materiality_topic', `${ORG_IDS.aomi}/${PERIOD_IDS.fy2026}/${topicKey}`),
      organizationId: ORG_IDS.aomi,
      reportingPeriodId: PERIOD_IDS.fy2026,
      topicKey,
      title,
      category,
      materiality,
      rationale,
      metricCodes,
      assessedAt: at(210),
      assessedBy: userId('sustainability@demo.local'),
      ...audit(at(215), at(210), userId('sustainability@demo.local')),
    });
  }

  // ------------------------------------------------------------------
  // 事前学習の材料（機能追加要望 ①）
  // 過年度に人が確定した多言語ラベルの取込実績。以後の取込で
  // 「元ファイルのラベル → 指標・拠点」の学習例として使われる。
  // ------------------------------------------------------------------
  const learnedJobId = fid('ingestion_job', 'AOMI/learned-history');
  const learnedJobFileId = fid('ingestion_job_file', `${learnedJobId}/past.csv`);
  db.ingestionJobs.push({
    id: learnedJobId,
    organizationId: ORG_IDS.aomi,
    reportingPeriodId: PERIOD_IDS.fy2025,
    unitId: null,
    status: 'completed',
    progressPercent: 100,
    errorCode: null,
    errorMessage: null,
    retryCount: 0,
    idempotencyKey: 'learned-history',
    startedAt: at(320),
    finishedAt: at(320),
    totalRows: 8,
    mappedRows: 8,
    warningRows: 0,
    errorRows: 0,
    ...audit(at(320), at(320), userId('sustainability@demo.local')),
  });
  db.ingestionJobFiles.push({
    id: learnedJobFileId,
    jobId: learnedJobId,
    organizationId: ORG_IDS.aomi,
    // 実在する過年度 Evidence の Version を参照する（FK 制約を満たすため）
    fileVersionId: must(fileVersionByKey.get('hr-data/FY2025'), 'hr-data FY2025'),
    originalName: '過年度_拠点別実績（多言語）.csv',
    mimeType: 'text/csv',
    parseStatus: 'parsed',
    parseMessage: null,
    sheetName: null,
    detectedEncoding: 'UTF-8',
    createdAt: at(320),
  });
  const learnedRows: Array<{
    raw: Record<string, string>;
    metricCode: string;
    unitKey: keyof typeof UNIT_IDS;
    value: number;
    unit: string;
  }> = [
    {
      raw: {
        Standort: 'München Büro',
        Kennzahl: 'Stromverbrauch',
        Wert: '1.180,2',
        Einheit: 'kWh',
      },
      metricCode: 'energy',
      unitKey: 'eu',
      value: 1180.2,
      unit: 'kWh',
    },
    {
      raw: { Standort: 'München Büro', Kennzahl: 'Wasserverbrauch', Wert: '2.640', Einheit: 'm3' },
      metricCode: 'water',
      unitKey: 'eu',
      value: 2640,
      unit: 'm3',
    },
    {
      raw: { Site: 'Europe Sales Office', Metric: 'Waste generated', Value: '11.8', Unit: 't' },
      metricCode: 'waste',
      unitKey: 'eu',
      value: 11.8,
      unit: 't',
    },
    {
      raw: { 站点: '华东供应商工厂', 指标: '用电量', 数值: '4,980.4', 单位: 'MWh' },
      metricCode: 'energy',
      unitKey: 'sup1',
      value: 4980.4,
      unit: 'MWh',
    },
    {
      raw: { 拠点: '西日本工場', 項目: '蒸気（購入分）', 値: '17.9', 単位: 'GJ' },
      metricCode: 'energy',
      unitKey: 'west',
      value: 5.0,
      unit: 'MWh',
    },
    {
      raw: {
        Site: 'Bureau Europe',
        Indicateur: "Consommation d'eau",
        Valeur: '1 150',
        Unité: 'm3',
      },
      metricCode: 'water',
      unitKey: 'eu',
      value: 1150,
      unit: 'm3',
    },
    {
      raw: { 場所: '東日本工場', データ種別: '構内車両燃料', 数量: '84.2', 備考: '軽油換算' },
      metricCode: 'scope1',
      unitKey: 'east',
      value: 84.2,
      unit: 't-CO2e',
    },
    {
      raw: { 拠点: '本社', 項目: '社宅エネルギー', 値: '210.6', 単位: 'MWh' },
      metricCode: 'energy',
      unitKey: 'hq',
      value: 210.6,
      unit: 'MWh',
    },
  ];
  learnedRows.forEach((row, index) => {
    db.ingestionRows.push({
      id: fid('ingestion_row', `${learnedJobId}/${index}`),
      jobId: learnedJobId,
      jobFileId: learnedJobFileId,
      organizationId: ORG_IDS.aomi,
      rowIndex: index + 2,
      raw: row.raw,
      metricId: metricId('AOMI', row.metricCode),
      unitId: UNIT_IDS[row.unitKey],
      reportingPeriodId: PERIOD_IDS.fy2025,
      value: row.value,
      unitOfMeasure: row.unit,
      confidence: 1,
      warnings: [],
      status: 'confirmed',
      sourceLocator: `行 ${index + 2}`,
      duplicateOfDataPointId: null,
      aiRunId: null,
      createdAt: at(320),
      updatedAt: at(320),
    });
  });

  // ------------------------------------------------------------------
  // 監査法人テナント: 契約 / 許諾 / Data Room
  // ------------------------------------------------------------------
  db.relationships.push({
    id: fid('relationship', 'AOMI-AOBA'),
    clientOrganizationId: ORG_IDS.aomi,
    providerOrganizationId: ORG_IDS.aoba,
    relationshipType: 'assurance',
    status: 'active',
    startedAt: '2026-05-01',
    endedAt: null,
    ...audit(at(105)),
  });

  const partner = userId('assurance-partner@demo.local');
  const manager = userId('assurance-manager@demo.local');
  const staff = userId('assurance-staff@demo.local');

  db.engagements.push({
    id: ENGAGEMENT_IDS.main,
    assuranceFirmId: ORG_IDS.aoba,
    clientOrganizationId: ORG_IDS.aomi,
    clientReportingPeriodId: PERIOD_IDS.fy2026,
    code: 'ENG-2026-001',
    name: '青海テクノロジー FY2026 非財務情報 限定的保証業務',
    assuranceLevel: 'limited',
    frameworkKey: 'ssbj',
    status: 'fieldwork',
    plannedStartDate: '2026-06-01',
    deadlineDate: day(45),
    partnerUserId: partner,
    managerUserId: manager,
    materialityBasis: 'Scope1 + Scope2 合計の 5%',
    materialityValue: 1580.0,
    materialityUnit: 't-CO2e',
    ...audit(at(100), at(20), manager),
  });

  db.engagements.push({
    id: ENGAGEMENT_IDS.other,
    assuranceFirmId: ORG_IDS.kurobe,
    clientOrganizationId: ORG_IDS.soten,
    clientReportingPeriodId: PERIOD_IDS.sotenFy2026,
    code: 'ENG-2026-900',
    name: '蒼天マテリアル FY2026 保証業務',
    assuranceLevel: 'limited',
    frameworkKey: 'ssbj',
    status: 'planning',
    plannedStartDate: '2026-07-01',
    deadlineDate: day(70),
    partnerUserId: userId('other-assurance-manager@demo.local'),
    managerUserId: userId('other-assurance-manager@demo.local'),
    materialityBasis: null,
    materialityValue: null,
    materialityUnit: null,
    ...audit(at(90)),
  });

  const memberSpecs: Array<[Uuid, 'engagement_partner' | 'assurance_manager' | 'assurance_staff']> =
    [
      [partner, 'engagement_partner'],
      [manager, 'assurance_manager'],
      [staff, 'assurance_staff'],
    ];
  for (const [uid, roleKey] of memberSpecs) {
    db.engagementMembers.push({
      id: fid('engagement_member', `${ENGAGEMENT_IDS.main}/${uid}`),
      engagementId: ENGAGEMENT_IDS.main,
      assuranceFirmId: ORG_IDS.aoba,
      userId: uid,
      roleKey,
      assignedAt: at(98),
      assignedBy: partner,
      removedAt: null,
    });
  }
  db.engagementMembers.push({
    id: fid('engagement_member', `${ENGAGEMENT_IDS.other}/kurobe`),
    engagementId: ENGAGEMENT_IDS.other,
    assuranceFirmId: ORG_IDS.kurobe,
    userId: userId('other-assurance-manager@demo.local'),
    roleKey: 'assurance_manager',
    assignedAt: at(88),
    assignedBy: null,
    removedAt: null,
  });

  // 許諾（企業が決定）: 指標 6 / 組織 3（欧州は含めない）/ 期間 FY2026 / Evidence
  const GRANTED_METRIC_CODES = ['scope1', 'scope2', 'scope3_cat1', 'energy', 'waste', 'employees'];
  const GRANTED_UNIT_CODES = ['HQ', 'EAST', 'WEST'];
  const grantedBy = userId('enterprise-admin@demo.local');

  function pushGrant(
    subjectType: ClientAccessGrant['subjectType'],
    subjectId: Uuid,
    includesEvidence: boolean,
    note: string | null,
  ) {
    db.grants.push({
      id: fid('grant', `${ENGAGEMENT_IDS.main}/${subjectType}/${subjectId}`),
      engagementId: ENGAGEMENT_IDS.main,
      clientOrganizationId: ORG_IDS.aomi,
      assuranceFirmId: ORG_IDS.aoba,
      subjectType,
      subjectId,
      includesEvidence,
      grantedBy,
      grantedAt: at(96),
      revokedBy: null,
      revokedAt: null,
      note,
      ...audit(at(96), at(96), grantedBy),
    });
  }

  for (const code of GRANTED_METRIC_CODES) pushGrant('metric', metricId('AOMI', code), true, null);
  for (const code of GRANTED_UNIT_CODES) {
    const u = must(unitByCode.get(code), `unit ${code}`);
    pushGrant('organization_unit', u.id, true, null);
  }
  pushGrant('reporting_period', PERIOD_IDS.fy2026, true, '保証対象期間');

  // Scope（Matrix）: 許諾範囲は included、欧州は excluded として明示
  for (const unitCode of ['HQ', 'EAST', 'WEST', 'EU']) {
    const u = must(unitByCode.get(unitCode), unitCode);
    for (const metricCode of GRANTED_METRIC_CODES) {
      const spec = must(metricByCode.get(metricCode), metricCode);
      if (spec.hqOnly && unitCode !== 'HQ') continue;
      const included = GRANTED_UNIT_CODES.includes(unitCode);
      db.engagementScopes.push({
        id: fid('engagement_scope', `${ENGAGEMENT_IDS.main}/${unitCode}/${metricCode}`),
        engagementId: ENGAGEMENT_IDS.main,
        assuranceFirmId: ORG_IDS.aoba,
        unitId: u.id,
        metricId: metricId('AOMI', metricCode),
        reportingPeriodId: PERIOD_IDS.fy2026,
        inclusion: included ? 'included' : 'excluded',
        riskTag:
          metricCode === 'scope3_cat1' ? 'high' : metricCode === 'employees' ? 'low' : 'medium',
        materialityFlag: metricCode === 'scope1' || metricCode === 'scope2',
        note: included ? null : '企業からのアクセス許諾範囲外のため保証対象外',
        ...audit(at(95), at(95), manager),
      });
    }
  }

  // Data Room: 許諾範囲内かつ承認済みの Data Point を共有
  const grantedMetricIds = new Set(GRANTED_METRIC_CODES.map((c) => metricId('AOMI', c)));
  const grantedUnitIds = new Set(GRANTED_UNIT_CODES.map((c) => must(unitByCode.get(c), c).id));
  const sharedDataPoints = db.dataPoints.filter(
    (dp) =>
      dp.organizationId === ORG_IDS.aomi &&
      dp.reportingPeriodId === PERIOD_IDS.fy2026 &&
      dp.status === 'approved' &&
      grantedMetricIds.has(dp.metricId) &&
      grantedUnitIds.has(dp.unitId) &&
      // 内部取引の明細行は連結時の**控除額**であり、母集団に入れると
      // 二重計上になる（完全性手続の欠損件数も誤って 0 になる）。
      isCountedInTotals(dp),
  );

  for (const dp of sharedDataPoints) {
    db.dataRoomItems.push({
      id: fid('data_room_item', `${ENGAGEMENT_IDS.main}/dp/${dp.id}`),
      engagementId: ENGAGEMENT_IDS.main,
      assuranceFirmId: ORG_IDS.aoba,
      clientOrganizationId: ORG_IDS.aomi,
      sourceType: 'data_point',
      sourceId: dp.id,
      sourceVersionId: dp.currentVersionId,
      sharedAt: at(94),
      sharedBy: grantedBy,
      clientApprovalStatus: 'approved',
      withdrawnAt: null,
    });
    for (const link of db.evidenceLinks.filter(
      (l) => l.targetType === 'data_point' && l.targetId === dp.id,
    )) {
      db.dataRoomItems.push({
        id: fid('data_room_item', `${ENGAGEMENT_IDS.main}/ev/${link.id}`),
        engagementId: ENGAGEMENT_IDS.main,
        assuranceFirmId: ORG_IDS.aoba,
        clientOrganizationId: ORG_IDS.aomi,
        sourceType: 'evidence',
        sourceId: link.id,
        sourceVersionId: link.fileVersionId,
        sharedAt: at(94),
        sharedBy: grantedBy,
        clientApprovalStatus: 'n_a',
        withdrawnAt: null,
      });
    }
  }

  // ------------------------------------------------------------------
  // Snapshot（Immutable）
  // ------------------------------------------------------------------
  const snapshotId = fid('snapshot', `${ENGAGEMENT_IDS.main}/SNAP-1`);
  const frozenAt = at(21, 5);
  const snapshotItems: AssuranceSnapshotItem[] = [];

  for (const dp of sharedDataPoints) {
    // Snapshot は「固定時点で最新だった Version」を保持する。
    // frozenAt より後に作られた Version は含まれない → 後続の変更が差分として検知される。
    const versions = db.dataPointVersions
      .filter((v) => v.dataPointId === dp.id && v.createdAt <= frozenAt)
      .sort((a, b) => a.versionNo - b.versionNo);
    const frozenVersion = must(versions[versions.length - 1], `version of ${dp.id}`);
    snapshotItems.push({
      id: fid('snapshot_item', `${snapshotId}/dp/${dp.id}`),
      snapshotId,
      engagementId: ENGAGEMENT_IDS.main,
      assuranceFirmId: ORG_IDS.aoba,
      sourceType: 'data_point',
      sourceId: dp.id,
      sourceVersionId: frozenVersion.id,
      sourceDataPointVersionId: frozenVersion.id,
      sourceFileVersionId: null,
      valueSnapshot: {
        value: frozenVersion.value,
        unitOfMeasure: frozenVersion.unitOfMeasure,
        status: frozenVersion.status,
        metricId: dp.metricId,
        unitId: dp.unitId,
        reportingPeriodId: dp.reportingPeriodId,
        versionNo: frozenVersion.versionNo,
      },
      hash: frozenVersion.contentHash,
      frozenAt,
      frozenBy: manager,
    });
  }

  db.snapshots.push({
    id: snapshotId,
    engagementId: ENGAGEMENT_IDS.main,
    assuranceFirmId: ORG_IDS.aoba,
    label: 'SNAP-1（往査開始時点）',
    frozenAt,
    frozenBy: manager,
    itemCount: snapshotItems.length,
    hash: contentHash(snapshotItems.map((i) => i.hash).join('|')),
    note: '限定的保証手続の起点として固定。',
  });
  db.snapshotItems.push(...snapshotItems);

  // ------------------------------------------------------------------
  // 母集団 / サンプル
  // ------------------------------------------------------------------
  const populationId = fid('population', `${ENGAGEMENT_IDS.main}/POP-1`);
  const populationItems: PopulationItem[] = snapshotItems.map((item) => {
    const dp = must(
      db.dataPoints.find((d) => d.id === item.sourceId),
      `data point ${item.sourceId}`,
    );
    const unitRow = must(
      db.units.find((u) => u.id === dp.unitId),
      `unit ${dp.unitId}`,
    );
    const snapValue = Number(item.valueSnapshot.value ?? 0);
    return {
      id: fid('population_item', `${populationId}/${dp.id}`),
      populationId,
      engagementId: ENGAGEMENT_IDS.main,
      assuranceFirmId: ORG_IDS.aoba,
      snapshotItemId: item.id,
      sourceDataPointId: dp.id,
      metricId: dp.metricId,
      unitId: dp.unitId,
      value: snapValue,
      unitOfMeasure: String(item.valueSnapshot.unitOfMeasure ?? ''),
      stratum: unitRow.name,
      excluded: false,
      exclusionReason: null,
    };
  });
  db.populationItems.push(...populationItems);

  // 完全性: Scope 上「対象」だが承認されておらず母集団に入らなかった件数を欠損として記録
  const inScopeExpected = db.engagementScopes.filter(
    (s) => s.engagementId === ENGAGEMENT_IDS.main && s.inclusion === 'included',
  ).length;

  db.populations.push({
    id: populationId,
    engagementId: ENGAGEMENT_IDS.main,
    assuranceFirmId: ORG_IDS.aoba,
    snapshotId,
    name: '保証対象 Data Point 母集団（SNAP-1）',
    versionNo: 1,
    filter: {
      metricIds: [...grantedMetricIds],
      unitIds: [...grantedUnitIds],
      reportingPeriodIds: [PERIOD_IDS.fy2026],
      minValue: null,
      maxValue: null,
    },
    itemCount: populationItems.length,
    totalValue: Math.round(populationItems.reduce((s, i) => s + i.value, 0) * 1000) / 1000,
    missingCount: Math.max(0, inScopeExpected - populationItems.length),
    duplicateCount: 0,
    excludedCount: 0,
    reconciliationNote:
      '企業側の承認済み Data Point 件数と Data Room 共有件数を突合。差異は未承認（レビュー中・差戻し）のため。',
    completenessProcedureNote:
      'P-01 実施。組織マスター（本社・東日本工場・西日本工場）と報告期間 FY2026 を基準に網羅性を確認した。欧州販売子会社は許諾範囲外のため保証対象外である旨を記載。',
    createdAt: at(20),
    createdBy: staff,
  });

  const sampleId = fid('sample', `${ENGAGEMENT_IDS.main}/SMP-1`);
  const sampleSeed = 'AOBA-ENG-2026-001-S1';
  const selection = selectSample({
    candidates: populationItems.map((p) => ({
      id: p.id,
      value: p.value,
      stratum: p.stratum,
      label: p.id,
    })),
    method: 'random',
    seed: sampleSeed,
    parameters: { targetSize: 10 },
  });

  db.samples.push({
    id: sampleId,
    populationId,
    engagementId: ENGAGEMENT_IDS.main,
    assuranceFirmId: ORG_IDS.aoba,
    populationVersionNo: 1,
    name: 'SMP-1 無作為抽出 10 件',
    method: 'random',
    seed: sampleSeed,
    parameters: { targetSize: 10 },
    size: selection.length,
    rationale:
      '限定的保証水準に基づき、母集団から無作為に 10 件を抽出した。Seed を記録し再現可能とする。',
    createdAt: at(19),
    createdBy: staff,
  });

  selection.forEach((sel) => {
    db.sampleItems.push({
      id: fid('sample_item', `${sampleId}/${sel.populationItemId}`),
      sampleId,
      populationItemId: sel.populationItemId,
      engagementId: ENGAGEMENT_IDS.main,
      assuranceFirmId: ORG_IDS.aoba,
      selectionReason: sel.selectionReason,
      stratum: sel.stratum,
      sortOrder: sel.sortOrder,
    });
  });

  // ------------------------------------------------------------------
  // 手続 / テスト
  // ------------------------------------------------------------------
  PROCEDURE_SPECS.forEach((spec, index) => {
    db.procedures.push({
      id: fid('procedure', `${ENGAGEMENT_IDS.main}/${spec.code}`),
      engagementId: ENGAGEMENT_IDS.main,
      assuranceFirmId: ORG_IDS.aoba,
      code: spec.code,
      title: spec.title,
      description: spec.description,
      category: spec.category,
      required: spec.required,
      sortOrder: index,
      ...audit(at(97), at(97), manager),
    });
  });

  const requiredProcedures = db.procedures.filter((p) => p.required);
  const sortedSampleItems = [...db.sampleItems].sort((a, b) => a.sortOrder - b.sortOrder);

  sortedSampleItems.forEach((sampleItem, index) => {
    const status: AssuranceTest['status'] =
      index === 0 ? 'reviewed' : index <= 2 ? 'prepared' : 'not_started';
    const testId = fid('test', `${ENGAGEMENT_IDS.main}/${sampleItem.id}`);
    db.tests.push({
      id: testId,
      engagementId: ENGAGEMENT_IDS.main,
      assuranceFirmId: ORG_IDS.aoba,
      sampleItemId: sampleItem.id,
      status,
      conclusionDraft:
        status === 'not_started'
          ? null
          : '重要な相違は識別されなかった。記録値と Evidence は整合している。',
      preparedBy: status === 'not_started' ? null : staff,
      preparedAt: status === 'not_started' ? null : at(15 - index),
      reviewedBy: status === 'reviewed' ? manager : null,
      reviewedAt: status === 'reviewed' ? at(12) : null,
      workpaperRef: `WP-${1000 + index}`,
      ...audit(at(18), at(12), staff),
    });

    if (status !== 'not_started') {
      const popItem = must(
        populationItems.find((p) => p.id === sampleItem.populationItemId),
        `population item ${sampleItem.populationItemId}`,
      );
      for (const proc of requiredProcedures.slice(
        0,
        status === 'reviewed' ? requiredProcedures.length : 3,
      )) {
        const isRecalc = proc.category === 'recalculation';
        db.testResults.push({
          id: fid('test_result', `${testId}/${proc.code}`),
          testId,
          procedureId: proc.id,
          engagementId: ENGAGEMENT_IDS.main,
          assuranceFirmId: ORG_IDS.aoba,
          result: 'pass',
          recalculationInput: isRecalc
            ? [
                {
                  label: '記録値',
                  value: popItem.value,
                  unit: popItem.unitOfMeasure,
                  sourceType: 'data_point',
                  sourceId: popItem.sourceDataPointId,
                  note: 'Snapshot 固定値',
                },
              ]
            : null,
          recalculationResult: isRecalc ? popItem.value : null,
          recordedValue: isRecalc ? popItem.value : null,
          difference: isRecalc ? 0 : null,
          note: isRecalc
            ? '独立再計算の結果、差異なし。'
            : `${proc.title}を実施し、相違は識別されなかった。`,
          completedBy: staff,
          completedAt: at(15 - index),
        });
      }
    }
  });

  // ------------------------------------------------------------------
  // PBC / Issue / Review Note
  // ------------------------------------------------------------------
  for (const spec of PBC_SPECS) {
    const requestId = fid('pbc_request', `${ENGAGEMENT_IDS.main}/${spec.code}`);
    db.pbcRequests.push({
      id: requestId,
      engagementId: ENGAGEMENT_IDS.main,
      assuranceFirmId: ORG_IDS.aoba,
      clientOrganizationId: ORG_IDS.aomi,
      code: spec.code,
      title: spec.title,
      description: spec.description,
      targetType: null,
      targetId: null,
      dueDate: day(spec.dueOffsetDays),
      priority: spec.priority,
      status: spec.status,
      internalNote: spec.internalNote,
      requestedBy: manager,
      sentAt: spec.status === 'draft' ? null : at(28),
      closedAt: null,
      ...audit(at(30), at(10), manager),
    });
    if (spec.responseBody) {
      db.pbcResponses.push({
        id: fid('pbc_response', `${requestId}/r1`),
        requestId,
        engagementId: ENGAGEMENT_IDS.main,
        clientOrganizationId: ORG_IDS.aomi,
        body: spec.responseBody,
        fileVersionIds: [must(fileVersionByKey.get('power-invoice/FY2026'), 'power invoice')],
        submittedBy: userId('sustainability@demo.local'),
        submittedAt: at(22),
        decision: spec.decision ?? null,
        decidedBy: spec.decision ? manager : null,
        decidedAt: spec.decision ? at(21) : null,
        rejectReason: null,
      });
    }
  }

  for (const spec of ISSUE_SPECS) {
    const issueId = fid('issue', `${ENGAGEMENT_IDS.main}/${spec.code}`);
    db.issues.push({
      id: issueId,
      engagementId: ENGAGEMENT_IDS.main,
      assuranceFirmId: ORG_IDS.aoba,
      clientOrganizationId: ORG_IDS.aomi,
      code: spec.code,
      title: spec.title,
      description: spec.description,
      affectedMetricId: spec.metricCode ? metricId('AOMI', spec.metricCode) : null,
      affectedSampleItemId: null,
      severity: spec.severity,
      quantitativeImpact: spec.quantitativeImpact,
      quantitativeImpactUnit: spec.quantitativeImpactUnit,
      rootCause: spec.rootCause,
      status: spec.status,
      resolution: spec.resolution,
      reviewerUserId: manager,
      resolvedAt: spec.status === 'resolved' ? at(8) : null,
      ...audit(at(16), at(8), staff),
    });
    if (spec.managementResponse) {
      db.managementResponses.push({
        id: fid('management_response', `${issueId}/r1`),
        issueId,
        engagementId: ENGAGEMENT_IDS.main,
        clientOrganizationId: ORG_IDS.aomi,
        body: spec.managementResponse,
        proposedCorrection: spec.severity === 'medium' ? 'FY2026 データを t 単位で再登録' : null,
        respondedBy: userId('sustainability@demo.local'),
        respondedAt: at(10),
      });
    }
  }

  REVIEW_NOTE_SPECS.forEach((spec, index) => {
    db.reviewNotes.push({
      id: fid('review_note', `${ENGAGEMENT_IDS.main}/RN-${index + 1}`),
      engagementId: ENGAGEMENT_IDS.main,
      assuranceFirmId: ORG_IDS.aoba,
      targetType: 'engagement',
      targetId: ENGAGEMENT_IDS.main,
      body: spec.body,
      raisedBy: manager,
      assignedTo: staff,
      status: spec.status,
      sharedWithClient: spec.sharedWithClient,
      resolutionComment: spec.resolutionComment,
      resolvedAt: spec.status === 'cleared' ? at(7) : null,
      ...audit(at(13), at(7), manager),
    });
  });

  // ------------------------------------------------------------------
  // タスク / 通知 / アラート
  // ------------------------------------------------------------------
  const taskSpecs: Array<{
    title: string;
    assignee: string;
    dueOffset: number;
    status: WorkTask['status'];
    priority: WorkTask['priority'];
    targetType: string;
    href: string;
  }> = [
    {
      title: '西日本工場 水使用量の異常値を確認',
      assignee: 'sustainability@demo.local',
      dueOffset: -2,
      status: 'open',
      priority: 'critical',
      targetType: 'data_point',
      href: '/enterprise/data',
    },
    {
      title: '東日本工場 廃棄物の単位を t へ修正',
      assignee: 'site-user@demo.local',
      dueOffset: -1,
      status: 'in_progress',
      priority: 'high',
      targetType: 'data_point',
      href: '/enterprise/data',
    },
    {
      title: '欧州販売子会社の Scope1 Evidence を取得',
      assignee: 'sustainability@demo.local',
      dueOffset: 3,
      status: 'open',
      priority: 'high',
      targetType: 'evidence',
      href: '/enterprise/evidence',
    },
    {
      title: '役員構成データの整合を確認（女性役員数 > 役員総数）',
      assignee: 'enterprise-admin@demo.local',
      dueOffset: -4,
      status: 'open',
      priority: 'critical',
      targetType: 'data_point',
      href: '/enterprise/data',
    },
    {
      title: 'CDP 2026 の新規質問 2 件に回答',
      assignee: 'sustainability@demo.local',
      dueOffset: 9,
      status: 'open',
      priority: 'medium',
      targetType: 'disclosure_response',
      href: '/enterprise/disclosures/cdp',
    },
    {
      title: 'PBC-002 への回答を提出',
      assignee: 'sustainability@demo.local',
      dueOffset: -3,
      status: 'in_progress',
      priority: 'critical',
      targetType: 'pbc_request',
      href: '/enterprise/workflows',
    },
    {
      title: '取込ジョブ JOB-002 のプレビューを確定',
      assignee: 'sustainability@demo.local',
      dueOffset: 1,
      status: 'open',
      priority: 'high',
      targetType: 'ingestion_job',
      href: '/enterprise/imports',
    },
    {
      title: 'FY2026 レビュー待ちデータ 3 件を処理',
      assignee: 'reviewer@demo.local',
      dueOffset: 2,
      status: 'open',
      priority: 'medium',
      targetType: 'data_point',
      href: '/enterprise/data',
    },
  ];
  taskSpecs.forEach((spec, index) => {
    db.tasks.push({
      id: fid('task', `AOMI/T-${index + 1}`),
      organizationId: ORG_IDS.aomi,
      title: spec.title,
      description: null,
      targetType: spec.targetType,
      targetId: null,
      assigneeUserId: userId(spec.assignee),
      dueDate: day(spec.dueOffset),
      status: spec.status,
      priority: spec.priority,
      engagementId: null,
      ...audit(at(20)),
    });
  });

  const assuranceTaskSpecs: Array<{
    title: string;
    assignee: string;
    dueOffset: number;
    priority: WorkTask['priority'];
  }> = [
    {
      title: 'SMP-1 の未実施テスト 7 件を完了',
      assignee: 'assurance-staff@demo.local',
      dueOffset: 4,
      priority: 'high',
    },
    {
      title: 'ISS-001（女性役員数の矛盾）の企業回答を督促',
      assignee: 'assurance-manager@demo.local',
      dueOffset: -1,
      priority: 'critical',
    },
    {
      title: 'Snapshot 後変更 2 件の影響評価',
      assignee: 'assurance-manager@demo.local',
      dueOffset: 2,
      priority: 'high',
    },
    {
      title: 'レビューNote RN-1 へ対応',
      assignee: 'assurance-staff@demo.local',
      dueOffset: 3,
      priority: 'medium',
    },
  ];
  assuranceTaskSpecs.forEach((spec, index) => {
    db.tasks.push({
      id: fid('task', `AOBA/T-${index + 1}`),
      organizationId: ORG_IDS.aoba,
      title: spec.title,
      description: null,
      targetType: 'engagement',
      targetId: ENGAGEMENT_IDS.main,
      assigneeUserId: userId(spec.assignee),
      dueDate: day(spec.dueOffset),
      status: 'open',
      priority: spec.priority,
      engagementId: ENGAGEMENT_IDS.main,
      ...audit(at(15)),
    });
  });

  db.notifications.push(
    {
      id: fid('notification', 'AOMI/N-1'),
      organizationId: ORG_IDS.aomi,
      userId: userId('sustainability@demo.local'),
      title: 'PBC-002 の期限が超過しています',
      body: 'あおば保証監査法人からの資料依頼「西日本工場 水使用量の異常値説明」が未提出です。',
      category: 'pbc',
      href: '/enterprise/workflows',
      readAt: null,
      createdAt: at(3),
    },
    {
      id: fid('notification', 'AOMI/N-2'),
      organizationId: ORG_IDS.aomi,
      userId: userId('reviewer@demo.local'),
      title: 'レビュー待ちのデータが 3 件あります',
      body: 'FY2026 の Data Point 3 件がレビュー待ちです。',
      category: 'review',
      href: '/enterprise/data?status=in_review',
      readAt: null,
      createdAt: at(2),
    },
    {
      id: fid('notification', 'AOBA/N-1'),
      organizationId: ORG_IDS.aoba,
      userId: manager,
      title: 'Snapshot 固定後にクライアント側の変更を検知しました',
      body: 'SNAP-1 固定後に 2 件の Data Point が変更されています。影響評価を実施してください。',
      category: 'alert',
      href: `/assurance/engagements/${ENGAGEMENT_IDS.main}/data-room`,
      readAt: null,
      createdAt: at(1),
    },
  );

  // ------------------------------------------------------------------
  // 監査ログ（初期分）
  // ------------------------------------------------------------------
  const auditSeed: Array<
    [AuditEvent['eventType'], Uuid | null, Uuid, string | null, Uuid | null, number]
  > = [
    ['access_grant_created', grantedBy, ORG_IDS.aomi, 'client_access_grant', null, 96],
    ['snapshot_created', manager, ORG_IDS.aoba, 'assurance_snapshot', snapshotId, 21],
    ['sample_created', staff, ORG_IDS.aoba, 'sample', sampleId, 19],
    ['pbc_created', manager, ORG_IDS.aoba, 'pbc_request', null, 30],
    [
      'pbc_submitted',
      userId('sustainability@demo.local'),
      ORG_IDS.aomi,
      'pbc_request_response',
      null,
      22,
    ],
    ['issue_created', staff, ORG_IDS.aoba, 'assurance_issue', null, 16],
    ['issue_resolved', manager, ORG_IDS.aoba, 'assurance_issue', null, 8],
    ['review_note_created', manager, ORG_IDS.aoba, 'review_note', null, 13],
    ['data_approved', userId('approver@demo.local'), ORG_IDS.aomi, 'data_point', null, 35],
    ['file_uploaded', userId('site-user@demo.local'), ORG_IDS.aomi, 'file', null, 60],
    ['procedure_completed', staff, ORG_IDS.aoba, 'assurance_test', null, 15],
  ];
  auditSeed.forEach(([eventType, actor, orgId, resourceType, resourceId, daysAgo], index) => {
    db.auditEvents.push({
      id: fid('audit_event', `seed-${index}`),
      actorUserId: actor,
      actorOrganizationId: orgId,
      eventType,
      resourceType,
      resourceId,
      engagementId: orgId === ORG_IDS.aoba ? ENGAGEMENT_IDS.main : null,
      clientIpHash: contentHash(`ip-${index}`).slice(0, 16),
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) T4D-Demo',
      beforeSummary: null,
      afterSummary: null,
      metadata: {},
      createdAt: at(daysAgo),
    });
  });

  // ------------------------------------------------------------------
  // 検証結果の materialize
  //
  // 「前年比」「単位の混在」「分子分母」など行をまたぐ判定を含むため、
  // 実行時に毎回計算せず data_point_validation_results へ保存する。
  // これにより一覧を DB 側でページングできる（src/lib/services/validation-store.ts）。
  // ------------------------------------------------------------------
  const evidenceCountByDataPoint = new Map<Uuid, number>();
  for (const link of db.evidenceLinks) {
    if (link.targetType !== 'data_point') continue;
    evidenceCountByDataPoint.set(
      link.targetId,
      (evidenceCountByDataPoint.get(link.targetId) ?? 0) + 1,
    );
  }

  const aomiMetrics = db.metrics.filter((m) => m.organizationId === ORG_IDS.aomi);
  const aomiUnits = db.units.filter((u) => u.organizationId === ORG_IDS.aomi);

  for (const period of [PERIOD_IDS.fy2025, PERIOD_IDS.fy2026]) {
    const periodRow = db.periods.find((p) => p.id === period);
    if (!periodRow) continue;
    const previous = db.periods
      .filter((p) => p.organizationId === ORG_IDS.aomi && p.startDate < periodRow.startDate)
      .sort((a, b) => (a.startDate < b.startDate ? 1 : -1))[0];

    db.validations.push(
      ...validateDataPoints({
        dataPoints: db.dataPoints.filter((dp) => dp.reportingPeriodId === period),
        metrics: aomiMetrics,
        units: aomiUnits,
        periods: db.periods,
        evidenceCountByDataPoint,
        previousPeriodDataPoints: previous
          ? db.dataPoints.filter((dp) => dp.reportingPeriodId === previous.id)
          : [],
        detectedAt: at(1),
      }),
    );
  }

  return db;
}

// ======================================================================
// Demo Mode 用シングルトン
// ======================================================================

const GLOBAL_KEY = '__t4d_demo_db__';

type GlobalWithDb = typeof globalThis & { [GLOBAL_KEY]?: FixtureDb };

export function getDemoDb(): FixtureDb {
  const g = globalThis as GlobalWithDb;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = createFixtureDb();
  }
  return g[GLOBAL_KEY];
}

/** テスト用: シングルトンを作り直す。 */
export function resetDemoDb(): FixtureDb {
  const g = globalThis as GlobalWithDb;
  g[GLOBAL_KEY] = createFixtureDb();
  return g[GLOBAL_KEY];
}
