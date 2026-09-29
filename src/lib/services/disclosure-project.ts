import 'server-only';

import { randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, can, NotFoundError, permissionsFor } from '@/lib/authorization/can';
import {
  APPLICABILITY_STATUS_LABELS,
  BLOCK_STATUS_LABELS,
  DISCLOSURE_PURPOSE_LABELS,
  FRAMEWORK_COVERAGE_STATUS_LABELS,
  FRAMEWORK_LEGAL_STATUS_LABELS,
  MATERIALITY_BASIS_LABELS,
} from '@/lib/domain/disclosure-status';
import { COVERAGE_LABEL } from '@/lib/domain/ssbj';
import { ValidationError } from '@/lib/errors/user-facing';
import { formatNumber } from '@/lib/format/datetime';
import { listMembers, type MemberEntry } from '@/lib/services/identity';
import { isUuid } from '@/lib/validation/uuid';
import type { DbClient } from '@/lib/repositories/types';
import {
  DISCLOSURE_LANGUAGES,
  DISCLOSURE_PROJECT_STATUSES,
  DISCLOSURE_PURPOSES,
  type ApplicabilityStatus,
  type AuthorizationContext,
  type BlockStatus,
  type DisclosureBlock,
  type DisclosureBlockVersion,
  type DisclosureFramework,
  type DisclosureFrameworkVersion,
  type DisclosureItem,
  type DisclosureLanguage,
  type DisclosureProject,
  type DisclosureProjectStatus,
  type DisclosurePurpose,
  type FrameworkConditions,
  type FrameworkCoverageStatus,
  type FrameworkKey,
  type FrameworkLegalStatus,
  type IsoDate,
  type ProjectFramework,
  type ProjectFrameworkDecision,
  type ReportingPeriod,
  type SsbjAssessment,
  type SsbjCoverageStatus,
  type Uuid,
} from '@/types/domain';

/**
 * 開示プロジェクト（docs/disclosure-first.md §3 0035、指示書 §6.2・§6.3・§8.2〜§8.4）。
 *
 * プロジェクトは「どの期間を・どの目的で・どの基準の版で・誰が作って確認するか」を束ねる。
 * ここで守ること:
 *  - 基準の版はプロジェクトに固定する。新しい版が登録されても既存プロジェクトは黙って変えない
 *    （A23。版を変えるのは人が「新しい版を追加」したときだけ）。
 *  - 「保存して準備を始める」（project_frameworks の保存）と「適用判断を確定」（判断の追記）を分ける。
 *    確定には理由・参照規則・確認日が要り、判断者は操作した本人（クライアントから受け取らない）。
 *  - 適用条件の未入力は「不明」のまま持つ。0 として扱わず、未入力から「対象外」を推測しない。
 *  - 要求事項の「適用判断（内容評価の前提）」「内容評価（対応済み…）」「本文状態（原稿の工程）」を
 *    同じ列・同じ enum に混ぜない。未判定の要求事項を分母から消さない（A21）。
 */

// ======================================================================
// 目的 → 基準、法定の目的
// ======================================================================

/** 目的ごとに使う基準。社内 ESG 管理は基準を持たない */
export const PURPOSE_FRAMEWORK_KEY: Readonly<Record<DisclosurePurpose, FrameworkKey | null>> = {
  ssbj_statutory: 'ssbj',
  ssbj_voluntary: 'ssbj',
  csrd_40a_prep: 'esrs_40a',
  csrd_eu_entity: 'csrd',
  internal_esg: null,
};

/** 法定提出を目的とする区分（確定パッケージの可否判定に使う） */
export const STATUTORY_PURPOSES: readonly DisclosurePurpose[] = [
  'ssbj_statutory',
  'csrd_eu_entity',
];

/** 「保存して準備を始める」で選べる区分（確定を伴わない） */
export const PREPARATION_STATUSES = ['candidate', 'awaiting_confirmation'] as const;
export type PreparationStatus = (typeof PREPARATION_STATUSES)[number];

/** 「適用判断を確定」で選べる区分（未判定は確定できない） */
export const DECISION_STATUSES = [
  'applicable',
  'not_applicable',
  'voluntary',
  'candidate',
  'awaiting_confirmation',
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** 判断として確定した区分（候補・確認待ちは「確定済み」に数えない） */
const FINAL_APPLICABILITY: readonly ApplicabilityStatus[] = [
  'applicable',
  'not_applicable',
  'voluntary',
];

// ======================================================================
// 入力エラー
// ======================================================================

/**
 * 項目ごとの入力エラー。ValidationError を継承するので、?error= で戻す経路でも
 * 利用者向けの文面として扱われる（内部エラーと混ざらない）。
 */
export class FieldValidationError extends ValidationError {
  constructor(readonly fieldErrors: Record<string, string>) {
    const first = Object.values(fieldErrors)[0];
    super(first ? `入力内容を確認してください（${first}）` : '入力内容を確認してください。');
    this.name = 'FieldValidationError';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function clean(value: string | null | undefined): string {
  return (value ?? '').trim();
}

// ======================================================================
// 基準の版の位置付け（§8.2）
// ======================================================================

export type LegalTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

export interface FrameworkLegalView {
  /** 画面の主表示（例: 公開草案に基づく準備／サンプル（架空）） */
  label: string;
  tone: LegalTone;
  legalStatus: FrameworkLegalStatus | null;
  coverageStatus: FrameworkCoverageStatus | null;
  coverageLabel: string | null;
  coverageNote: string | null;
  materialityLabel: string | null;
  issuedAt: IsoDate | null;
  effectiveAt: IsoDate | null;
  sourceUrl: string | null;
  verifiedAt: IsoDate | null;
  /** 架空の縮小マスター（サンプル）か */
  isSample: boolean;
  /** 草案・サンプル・未収録など、正式な準拠の根拠にできない版か */
  isPreparationOnly: boolean;
}

/**
 * 版の法的な位置付けを画面向けに言い換える。
 * 草案を「対応済み」「準拠」と見せないため、草案は「公開草案に基づく準備」、
 * 架空の縮小マスターは「サンプル（架空）」と必ず表示する（§14.3）。
 */
export function describeFrameworkVersion(version: DisclosureFrameworkVersion): FrameworkLegalView {
  const legal = version.legalStatus;
  const isSample = legal === 'sample' || version.coverageStatus === 'sample' || version.isFixture;
  let label: string;
  let tone: LegalTone;
  if (isSample) {
    label = 'サンプル（架空）';
    tone = 'neutral';
  } else if (legal === 'draft') {
    label = '公開草案に基づく準備';
    tone = 'warning';
  } else if (legal === 'superseded') {
    label = FRAMEWORK_LEGAL_STATUS_LABELS.superseded;
    tone = 'neutral';
  } else if (legal) {
    label = FRAMEWORK_LEGAL_STATUS_LABELS[legal];
    tone = 'brand';
  } else {
    label = '法的位置付け未登録';
    tone = 'neutral';
  }
  return {
    label,
    tone,
    legalStatus: legal,
    coverageStatus: version.coverageStatus,
    coverageLabel: version.coverageStatus
      ? FRAMEWORK_COVERAGE_STATUS_LABELS[version.coverageStatus]
      : null,
    coverageNote: version.coverageNote,
    materialityLabel: version.materialityBasis
      ? MATERIALITY_BASIS_LABELS[version.materialityBasis]
      : null,
    issuedAt: version.issuedAt,
    effectiveAt: version.effectiveAt,
    sourceUrl: version.sourceUrl,
    verifiedAt: version.verifiedAt,
    isSample,
    isPreparationOnly:
      isSample ||
      legal === 'draft' ||
      version.coverageStatus === 'not_loaded' ||
      version.coverageStatus === 'sample',
  };
}

// ======================================================================
// 適用条件（§8.4）
// ======================================================================

export interface ConditionFieldDef {
  key: string;
  label: string;
  kind: 'number' | 'text';
  unit?: string;
  help?: string;
}

const EU_CONDITION_FIELDS: ConditionFieldDef[] = [
  {
    key: 'turnoverFiscalYearsNote',
    label: '売上の対象年度',
    kind: 'text',
    help: '例: FY2024・FY2025（直近 2 連続年度）',
  },
  {
    key: 'euNetTurnoverLatestFy',
    label: 'EU 域内の純売上高（直近年度）',
    kind: 'number',
    unit: 'EUR',
  },
  {
    key: 'euNetTurnoverPreviousFy',
    label: 'EU 域内の純売上高（その前年度）',
    kind: 'number',
    unit: 'EUR',
  },
  {
    key: 'euSubsidiaryBranchTurnoverPrecedingFy',
    label: 'EU 子会社・支店の純売上高（前年度）',
    kind: 'number',
    unit: 'EUR',
  },
  { key: 'groupEmployees', label: '従業員数（連結）', kind: 'number', unit: '人' },
  { key: 'euCountries', label: 'EU 所在国（子会社・支店）', kind: 'text' },
  { key: 'reportingUnitNote', label: '報告単位・親子関係', kind: 'text' },
  { key: 'exemptionNote', label: '免除・代替報告の検討', kind: 'text' },
  { key: 'transpositionNote', label: '国内法への反映状況', kind: 'text' },
];

const CSRD_ENTITY_CONDITION_FIELDS: ConditionFieldDef[] = [
  { key: 'entityName', label: '対象の EU 法人', kind: 'text' },
  { key: 'entityNetTurnover', label: '対象法人の純売上高', kind: 'number', unit: 'EUR' },
  { key: 'entityEmployees', label: '対象法人の従業員数', kind: 'number', unit: '人' },
  { key: 'euCountries', label: 'EU 所在国', kind: 'text' },
  { key: 'exemptionNote', label: '免除・代替報告の検討', kind: 'text' },
  { key: 'transpositionNote', label: '国内法への反映状況', kind: 'text' },
];

const SSBJ_CONDITION_FIELDS: ConditionFieldDef[] = [
  {
    key: 'applicationBasisNote',
    label: '適用の根拠（法令・任意適用の決定など）',
    kind: 'text',
  },
  { key: 'transitionalReliefNote', label: '経過措置の検討（条項・年度）', kind: 'text' },
];

/** 基準ごとに記録できる適用条件。判定エンジンは持たない（§8.4: 人が確定する） */
export const FRAMEWORK_CONDITION_FIELDS: Readonly<Record<FrameworkKey, ConditionFieldDef[]>> = {
  ssbj: SSBJ_CONDITION_FIELDS,
  esrs_40a: EU_CONDITION_FIELDS,
  csrd: CSRD_ENTITY_CONDITION_FIELDS,
  cdp: [],
  msci: [],
  ftse: [],
};

/**
 * 画面に添える参考情報（判定には使わない）。
 * 閾値は W0 で一次資料を確認した内容（docs/disclosure-first.md §1.1）。自動判定はしない。
 */
export const FRAMEWORK_CONDITION_REFERENCE: Readonly<Partial<Record<FrameworkKey, string>>> = {
  esrs_40a:
    '参考（EU 理事会 2026-02-24 公表）: EU 域内売上 4.5 億ユーロ超（直近 2 連続年度）かつ EU 子会社・支店の売上 2 億ユーロ超（前年度）等。' +
    'ここでは自動判定しません。入力した条件と規則の版を示し、人が判断を確定します。',
  csrd: '通常の CSRD（EU 法人）の対象は、法人の売上・従業員数と各国の国内法への反映状況で変わります。ここでは自動判定しません。',
};

/**
 * 条件の数値を厳密に読む。桁区切り・全角数字・末尾の単位（EUR・ユーロ・€・人）だけを許し、
 * 「4億5千万」のような表記は先頭の数字だけを拾わずに null を返す（推測で 4 にしない）。
 */
function parseStrictAmount(raw: string): number | null {
  const v = raw
    .normalize('NFKC')
    .replace(/(EUR|ユーロ|€|人)$/i, '')
    .replace(/[,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 適用条件を読み取る。空欄は「不明」としてキーを持たない（0 と区別する）。
 * 数値として読めない入力は推測せずエラーにする。
 */
export function parseFrameworkConditions(
  frameworkKey: FrameworkKey,
  get: (key: string) => string,
): FrameworkConditions {
  const fields = FRAMEWORK_CONDITION_FIELDS[frameworkKey];
  const conditions: FrameworkConditions = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const raw = clean(get(`condition.${field.key}`));
    if (raw === '') continue;
    if (field.kind === 'number') {
      const value = parseStrictAmount(raw);
      if (value === null) {
        errors[`condition.${field.key}`] =
          `${field.label}は 0 以上の数値で入力してください（分からない場合は空欄のままにします）。`;
        continue;
      }
      conditions[field.key] = value;
    } else {
      conditions[field.key] = raw.slice(0, 2000);
    }
  }
  if (Object.keys(errors).length > 0) throw new FieldValidationError(errors);
  return conditions;
}

/** 条件のうち未入力（不明）の項目 */
export function unknownConditionFields(
  frameworkKey: FrameworkKey,
  conditions: FrameworkConditions,
): ConditionFieldDef[] {
  return FRAMEWORK_CONDITION_FIELDS[frameworkKey].filter(
    (f) => conditions[f.key] === undefined || conditions[f.key] === null,
  );
}

export function formatConditionValue(field: ConditionFieldDef, value: unknown): string {
  if (value === undefined || value === null || value === '') return '未入力（不明）';
  if (field.kind === 'number' && typeof value === 'number') {
    return `${formatNumber(value)}${field.unit ? ` ${field.unit}` : ''}`;
  }
  return String(value);
}

function sameConditions(a: FrameworkConditions, b: FrameworkConditions): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

// ======================================================================
// 読み取り
// ======================================================================

export interface ProjectFrameworkView {
  projectFramework: ProjectFramework;
  version: DisclosureFrameworkVersion;
  framework: DisclosureFramework;
  frameworkKey: FrameworkKey;
  /** 例: SSBJ 2026年3月13日改正基準 */
  label: string;
  purposeLabel: string;
  applicabilityLabel: string;
  legal: FrameworkLegalView;
  /** 新しい順 */
  decisions: ProjectFrameworkDecision[];
  currentDecision: ProjectFrameworkDecision | null;
  /** 適用判断が確定しているか（適用・対象外・任意適用の判断が記録済み） */
  confirmed: boolean;
  conditionFields: ConditionFieldDef[];
  unknownConditions: ConditionFieldDef[];
  /** 判断を確定した後に条件を書き換えたか（判断の根拠と現在の入力が食い違う） */
  conditionsChangedSinceDecision: boolean;
  itemCount: number;
  /** 同じ基準の新しい版（自動では切り替えない。A23） */
  newerVersions: Array<{ version: DisclosureFrameworkVersion; legal: FrameworkLegalView }>;
}

export interface ProjectDetail {
  project: DisclosureProject;
  period: ReportingPeriod | null;
  frameworks: ProjectFrameworkView[];
  blocks: DisclosureBlock[];
  members: MemberEntry[];
  canWrite: boolean;
}

export function nameOf(members: readonly MemberEntry[], userId: Uuid | null): string | null {
  if (!userId) return null;
  return members.find((m) => m.userId === userId)?.displayName ?? '（組織外のユーザー）';
}

/** 開示の閲覧権限（編集権限があれば閲覧もできる）。RLS は組織メンバーに参照を許すが、アプリ層は役割で絞る */
function assertCanReadDisclosure(ctx: AuthorizationContext): void {
  if (!can(ctx, 'enterprise.disclosure.read') && !can(ctx, 'enterprise.disclosure.write')) {
    assertCan(ctx, 'enterprise.disclosure.read');
  }
}

async function loadProjectRow(
  db: DbClient,
  ctx: AuthorizationContext,
  projectId: Uuid,
): Promise<DisclosureProject> {
  assertCanReadDisclosure(ctx);
  const project = isUuid(projectId) ? await db.findById('disclosureProjects', projectId) : null;
  // 他テナント・削除済みは存在自体を伏せる
  if (!project || project.deletedAt || project.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('開示プロジェクトが見つかりません。');
  }
  return project;
}

async function buildFrameworkViews(
  db: DbClient,
  frameworks: readonly ProjectFramework[],
): Promise<ProjectFrameworkView[]> {
  if (frameworks.length === 0) return [];
  const pfIds = frameworks.map((f) => f.id);
  const [versions, allFrameworks, decisions] = await Promise.all([
    db.select('frameworkVersions'),
    db.select('frameworks'),
    db.select('projectFrameworkDecisions', { where: { projectFrameworkId: { in: pfIds } } }),
  ]);
  const versionIds = frameworks.map((f) => f.frameworkVersionId);
  const items = await db.select('disclosureItems', {
    where: { frameworkVersionId: { in: versionIds } },
  });

  const views: ProjectFrameworkView[] = [];
  for (const pf of frameworks) {
    const version = versions.find((v) => v.id === pf.frameworkVersionId);
    const framework = version ? allFrameworks.find((f) => f.id === version.frameworkId) : undefined;
    // 版・基準が引けない行は表示できない（参照整合は DB の外部キーが守る）
    if (!version || !framework) continue;
    const own = decisions
      .filter((d) => d.projectFrameworkId === pf.id)
      .sort((a, b) => b.decisionNo - a.decisionNo);
    const currentDecision = own.find((d) => d.id === pf.currentDecisionId) ?? null;
    const frameworkKey = framework.key;
    const newerVersions = versions
      .filter(
        (v) =>
          v.frameworkId === framework.id &&
          v.id !== version.id &&
          v.status !== 'superseded' &&
          v.legalStatus !== 'superseded' &&
          isNewerVersion(v, version),
      )
      .map((v) => ({ version: v, legal: describeFrameworkVersion(v) }));

    views.push({
      projectFramework: pf,
      version,
      framework,
      frameworkKey,
      label: version.label,
      purposeLabel: DISCLOSURE_PURPOSE_LABELS[pf.purpose],
      applicabilityLabel: APPLICABILITY_STATUS_LABELS[pf.applicabilityStatus],
      legal: describeFrameworkVersion(version),
      decisions: own,
      currentDecision,
      confirmed: currentDecision !== null && FINAL_APPLICABILITY.includes(pf.applicabilityStatus),
      conditionFields: FRAMEWORK_CONDITION_FIELDS[frameworkKey],
      unknownConditions: unknownConditionFields(frameworkKey, pf.conditions),
      conditionsChangedSinceDecision:
        currentDecision !== null &&
        !sameConditions(currentDecision.conditionsSnapshot, pf.conditions),
      itemCount: items.filter((i) => i.frameworkVersionId === version.id).length,
      newerVersions,
    });
  }
  return views;
}

/** 版の新旧（年 → 発行日 → 登録日時の順に比べる） */
function isNewerVersion(
  candidate: DisclosureFrameworkVersion,
  base: DisclosureFrameworkVersion,
): boolean {
  if (candidate.year !== base.year) return candidate.year > base.year;
  const ci = candidate.issuedAt ?? '';
  const bi = base.issuedAt ?? '';
  if (ci !== bi) return ci > bi;
  return candidate.createdAt > base.createdAt;
}

export async function getProject(
  db: DbClient,
  ctx: AuthorizationContext,
  projectId: Uuid,
): Promise<ProjectDetail> {
  const project = await loadProjectRow(db, ctx, projectId);
  const [period, pfs, blocks, members] = await Promise.all([
    db.findById('periods', project.reportingPeriodId),
    db.select('projectFrameworks', {
      where: { projectId: project.id, organizationId: project.organizationId },
      orderBy: { column: 'createdAt' },
    }),
    db.select('disclosureBlocks', {
      where: {
        projectId: project.id,
        organizationId: project.organizationId,
        deletedAt: { isNull: true },
      },
      orderBy: [{ column: 'sortOrder' }, { column: 'id' }],
    }),
    listMembers(db, ctx),
  ]);
  return {
    project,
    period: period && period.organizationId === project.organizationId ? period : null,
    frameworks: await buildFrameworkViews(db, pfs),
    blocks,
    members,
    canWrite: can(ctx, 'enterprise.disclosure.write'),
  };
}

export interface ProjectListRow {
  project: DisclosureProject;
  period: ReportingPeriod | null;
  frameworks: ProjectFrameworkView[];
  ownerName: string | null;
  blockCount: number;
  approvedBlockCount: number;
}

export async function listProjects(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<ProjectListRow[]> {
  assertCanReadDisclosure(ctx);
  const organizationId = ctx.workspace.organizationId;
  const [projects, periods, pfs, blocks, members] = await Promise.all([
    db.select('disclosureProjects', {
      where: { organizationId, deletedAt: { isNull: true } },
      orderBy: [
        { column: 'periodStart', dir: 'desc' },
        { column: 'createdAt', dir: 'desc' },
      ],
    }),
    db.select('periods', { where: { organizationId } }),
    db.select('projectFrameworks', { where: { organizationId } }),
    db.select('disclosureBlocks', { where: { organizationId, deletedAt: { isNull: true } } }),
    listMembers(db, ctx),
  ]);
  const views = await buildFrameworkViews(db, pfs);
  return projects.map((project) => {
    const own = blocks.filter((b) => b.projectId === project.id);
    return {
      project,
      period: periods.find((p) => p.id === project.reportingPeriodId) ?? null,
      frameworks: views.filter((v) => v.projectFramework.projectId === project.id),
      ownerName: nameOf(members, project.ownerUserId),
      blockCount: own.length,
      approvedBlockCount: own.filter((b) => b.status === 'approved' && b.approvedVersionId).length,
    };
  });
}

// ======================================================================
// 作成（§6.2 の 3 段階）
// ======================================================================

export interface CreateProjectInput {
  // 段階 1: 報告主体と期間
  name: string;
  reportingEntity: string;
  reportingPeriodId: Uuid;
  periodStart: string;
  periodEnd: string;
  currency: string;
  ownerUserId: Uuid | null;
  dueDate: string | null;
  // 段階 2: 制度と基準
  purposes: DisclosurePurpose[];
  /** 目的ごとに固定する基準の版（社内 ESG 管理は不要） */
  frameworkVersionByPurpose: Partial<Record<DisclosurePurpose, Uuid>>;
  /** 保存時の準備区分（既定は適用候補。確定はしない） */
  preparationStatus: PreparationStatus;
  // 段階 3: 報告範囲と承認
  scopeOrgNote: string;
  scopeConsolidationNote: string;
  scopeGhgBoundaryNote: string;
  scopeValueChainNote: string;
  includedUnitIds: Uuid[];
  languages: DisclosureLanguage[];
  reviewerUserId: Uuid | null;
  finalApproverUserId: Uuid | null;
}

/** 項目名 → どの段階の項目か（画面がエラーのある段階へ戻るために使う） */
export const PROJECT_FIELD_STEP: Readonly<Record<string, 1 | 2 | 3>> = {
  name: 1,
  reportingEntity: 1,
  reportingPeriodId: 1,
  periodStart: 1,
  periodEnd: 1,
  currency: 1,
  ownerUserId: 1,
  dueDate: 1,
  purposes: 2,
  frameworkVersions: 2,
  scopeOrgNote: 3,
  includedUnitIds: 3,
  languages: 3,
  reviewerUserId: 3,
  finalApproverUserId: 3,
  status: 1,
};

/** 担当の組み合わせ（職務分離）と、最終承認者の承認権限を確かめる */
function validateAssignees(
  members: readonly MemberEntry[],
  input: {
    ownerUserId: Uuid | null;
    reviewerUserId: Uuid | null;
    finalApproverUserId: Uuid | null;
  },
  errors: Record<string, string>,
): void {
  const member = (id: Uuid | null) => (id ? members.find((m) => m.userId === id) : undefined);
  for (const [key, id] of [
    ['ownerUserId', input.ownerUserId],
    ['reviewerUserId', input.reviewerUserId],
    ['finalApproverUserId', input.finalApproverUserId],
  ] as const) {
    if (id && !member(id)) errors[key] = 'この組織のメンバーから選んでください。';
  }
  const approver = member(input.finalApproverUserId);
  if (approver && !permissionsFor(approver.roleKeys).has('enterprise.disclosure.approve')) {
    errors.finalApproverUserId = '最終承認者には、開示の承認権限を持つ人を指定してください。';
  }
  // 依頼者（作成担当）・レビュアー・最終承認者は別の人にする（同じ人だと承認が成立しない）
  if (input.finalApproverUserId && input.finalApproverUserId === input.ownerUserId) {
    errors.finalApproverUserId = '作成担当と最終承認者は別の人にしてください（職務分離）。';
  } else if (input.finalApproverUserId && input.finalApproverUserId === input.reviewerUserId) {
    errors.finalApproverUserId = 'レビュアーと最終承認者は別の人にしてください（職務分離）。';
  }
  if (input.reviewerUserId && input.reviewerUserId === input.ownerUserId) {
    errors.reviewerUserId = '作成担当とレビュアーは別の人にしてください（職務分離）。';
  }
}

export async function createProject(
  db: DbClient,
  ctx: AuthorizationContext,
  input: CreateProjectInput,
): Promise<{ project: DisclosureProject; frameworks: ProjectFramework[] }> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const organizationId = ctx.workspace.organizationId;
  const errors: Record<string, string> = {};

  const name = clean(input.name);
  if (!name) errors.name = 'プロジェクト名を入力してください。';
  else if (name.length > 200) errors.name = 'プロジェクト名は 200 文字以内にしてください。';

  const period = input.reportingPeriodId
    ? await db.findById('periods', input.reportingPeriodId)
    : null;
  if (!period || period.organizationId !== organizationId) {
    errors.reportingPeriodId = '報告期間を選んでください。';
  }

  const periodStart = clean(input.periodStart) || period?.startDate || '';
  const periodEnd = clean(input.periodEnd) || period?.endDate || '';
  if (!isIsoDate(periodStart))
    errors.periodStart = '年度の開始日を YYYY-MM-DD で入力してください。';
  if (!isIsoDate(periodEnd)) errors.periodEnd = '年度の終了日を YYYY-MM-DD で入力してください。';
  if (isIsoDate(periodStart) && isIsoDate(periodEnd) && periodStart > periodEnd) {
    errors.periodEnd = '終了日は開始日以降にしてください。';
  }

  const currency = clean(input.currency).toUpperCase() || 'JPY';
  if (!/^[A-Z]{3}$/.test(currency))
    errors.currency = '通貨は 3 文字の通貨コード（例: JPY）で入力してください。';

  const dueDate = clean(input.dueDate) || null;
  if (dueDate && !isIsoDate(dueDate)) errors.dueDate = '期限を YYYY-MM-DD で入力してください。';

  const purposes = [...new Set(input.purposes)].filter((p) => DISCLOSURE_PURPOSES.includes(p));
  if (purposes.length === 0) errors.purposes = '対応する制度・基準を 1 つ以上選んでください。';
  if (purposes.includes('ssbj_statutory') && purposes.includes('ssbj_voluntary')) {
    errors.purposes = 'SSBJ（法定）と SSBJ（任意）は同じプロジェクトで同時に選べません。';
  }

  // 目的ごとの基準の版。版は必ず明示して固定する（最新版を暗黙に引かない）
  const allVersions = await db.select('frameworkVersions');
  const allFrameworks = await db.select('frameworks');
  const pinned: Array<{ purpose: DisclosurePurpose; versionId: Uuid }> = [];
  for (const purpose of purposes) {
    const key = PURPOSE_FRAMEWORK_KEY[purpose];
    if (!key) continue;
    const versionId = input.frameworkVersionByPurpose[purpose];
    const version = versionId ? allVersions.find((v) => v.id === versionId) : undefined;
    const framework = version ? allFrameworks.find((f) => f.id === version.frameworkId) : undefined;
    if (!version || !framework || framework.key !== key) {
      errors.frameworkVersions = `「${DISCLOSURE_PURPOSE_LABELS[purpose]}」で使う基準の版を選んでください。`;
      continue;
    }
    if (pinned.some((p) => p.versionId === version.id)) {
      errors.frameworkVersions = '同じ基準の版を 2 つの目的に割り当てることはできません。';
      continue;
    }
    pinned.push({ purpose, versionId: version.id });
  }

  const languages = [...new Set(input.languages)].filter((l) => DISCLOSURE_LANGUAGES.includes(l));
  if (languages.length === 0) errors.languages = '原稿の言語を 1 つ以上選んでください。';

  const units = await db.select('units', {
    where: { organizationId, deletedAt: { isNull: true } },
  });
  const includedUnitIds = [...new Set(input.includedUnitIds)];
  if (includedUnitIds.some((id) => !units.some((u) => u.id === id))) {
    errors.includedUnitIds = '対象組織はこの組織の拠点から選んでください。';
  }

  const members = await listMembers(db, ctx);
  validateAssignees(members, input, errors);

  if (!PREPARATION_STATUSES.includes(input.preparationStatus)) {
    errors.frameworkVersions = '準備の区分は「適用候補」か「確認待ち」を選んでください。';
  }

  if (Object.keys(errors).length > 0) throw new FieldValidationError(errors);

  const now = new Date().toISOString();
  const project: DisclosureProject = {
    id: randomUUID(),
    organizationId,
    reportingPeriodId: period!.id,
    name,
    reportingEntity: clean(input.reportingEntity).slice(0, 300),
    periodStart,
    periodEnd,
    currency,
    purposes,
    languages,
    ownerUserId: input.ownerUserId,
    reviewerUserId: input.reviewerUserId,
    finalApproverUserId: input.finalApproverUserId,
    dueDate,
    scopeOrgNote: clean(input.scopeOrgNote).slice(0, 2000),
    scopeConsolidationNote: clean(input.scopeConsolidationNote).slice(0, 2000),
    scopeGhgBoundaryNote: clean(input.scopeGhgBoundaryNote).slice(0, 2000),
    scopeValueChainNote: clean(input.scopeValueChainNote).slice(0, 2000),
    includedUnitIds,
    status: 'preparing',
    scopeRevision: 0,
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
    deletedAt: null,
  };
  await db.insert('disclosureProjects', [project]);

  // 基準は「準備を始める」状態で登録するだけ。判断の確定（decisions）は作らない
  const frameworks: ProjectFramework[] = pinned.map(({ purpose, versionId }) => ({
    id: randomUUID(),
    organizationId,
    projectId: project.id,
    frameworkVersionId: versionId,
    purpose,
    applicabilityStatus: input.preparationStatus,
    currentDecisionId: null,
    conditions: {},
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  }));
  if (frameworks.length > 0) await db.insert('projectFrameworks', frameworks);

  await recordAuditEvent(db, ctx, {
    eventType: 'project_created',
    resourceType: 'disclosure_project',
    resourceId: project.id,
    afterSummary: `${project.name}（${purposes.map((p) => DISCLOSURE_PURPOSE_LABELS[p]).join('・')}）`,
    metadata: {
      frameworkVersionIds: frameworks.map((f) => f.frameworkVersionId),
      preparationStatus: input.preparationStatus,
    },
  });

  return { project, frameworks };
}

// ======================================================================
// 更新と変更の影響（§6.2「対象範囲や基準版を変える際は、影響する原稿・数値・承認の一覧を提示」）
// ======================================================================

export interface UpdateProjectInput {
  name: string;
  reportingEntity: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  dueDate: string | null;
  status: DisclosureProjectStatus;
  ownerUserId: Uuid | null;
  reviewerUserId: Uuid | null;
  finalApproverUserId: Uuid | null;
  languages: DisclosureLanguage[];
  scopeOrgNote: string;
  scopeConsolidationNote: string;
  scopeGhgBoundaryNote: string;
  scopeValueChainNote: string;
  includedUnitIds: Uuid[];
}

/** 変えると原稿・数値・承認の前提が変わる項目 */
const SCOPE_FIELDS = [
  'reportingEntity',
  'periodStart',
  'periodEnd',
  'scopeOrgNote',
  'scopeConsolidationNote',
  'scopeGhgBoundaryNote',
  'scopeValueChainNote',
  'includedUnitIds',
] as const;

export const PROJECT_FIELD_LABELS: Readonly<Record<string, string>> = {
  name: 'プロジェクト名',
  reportingEntity: '報告主体',
  periodStart: '年度の開始日',
  periodEnd: '年度の終了日',
  currency: '報告通貨',
  dueDate: '期限',
  status: '状態',
  ownerUserId: '作成担当',
  reviewerUserId: 'レビュアー',
  finalApproverUserId: '最終承認者',
  languages: '原稿の言語',
  scopeOrgNote: '対象組織',
  scopeConsolidationNote: '財務連結の範囲',
  scopeGhgBoundaryNote: 'GHG 算定境界',
  scopeValueChainNote: 'バリューチェーンの範囲',
  includedUnitIds: '対象に含める拠点',
};

export interface ImpactBlock {
  blockId: Uuid;
  title: string;
  status: BlockStatus;
  statusLabel: string;
  language: DisclosureLanguage;
  frameworkLabel: string;
}

export interface ImpactMetricRef {
  blockId: Uuid;
  blockTitle: string;
  dataPointVersionId: Uuid;
  metricName: string;
  display: string;
  versionNo: number | null;
}

export interface ImpactApproval {
  blockId: Uuid;
  blockTitle: string;
  kind: 'approved_version' | 'open_review';
  label: string;
}

export interface ChangeImpact {
  blocks: ImpactBlock[];
  metricRefs: ImpactMetricRef[];
  approvals: ImpactApproval[];
}

export function isEmptyImpact(impact: ChangeImpact): boolean {
  return (
    impact.blocks.length === 0 && impact.metricRefs.length === 0 && impact.approvals.length === 0
  );
}

/** 指定した節（省略時はプロジェクトの全節）に対する影響の一覧 */
export async function computeBlockImpact(
  db: DbClient,
  detail: Pick<ProjectDetail, 'blocks' | 'frameworks'>,
  blockFilter?: (block: DisclosureBlock) => boolean,
): Promise<ChangeImpact> {
  const blocks = blockFilter ? detail.blocks.filter(blockFilter) : detail.blocks;
  if (blocks.length === 0) return { blocks: [], metricRefs: [], approvals: [] };

  const labelOf = (versionId: Uuid) =>
    detail.frameworks.find((f) => f.version.id === versionId)?.label ?? '（基準不明）';
  const versionIds = blocks.map((b) => b.currentVersionId).filter((id): id is Uuid => id !== null);
  const [blockVersions, requests] = await Promise.all([
    versionIds.length > 0
      ? db.select('disclosureBlockVersions', { where: { id: { in: versionIds } } })
      : Promise.resolve([] as DisclosureBlockVersion[]),
    db.select('reviewRequests', {
      where: { targetId: { in: blocks.map((b) => b.id) }, status: { in: ['open', 'reviewed'] } },
    }),
  ]);

  const metricVersionIds = [...new Set(blockVersions.flatMap((v) => v.metricRefs))];
  const dpVersions =
    metricVersionIds.length > 0
      ? await db.select('dataPointVersions', { where: { id: { in: metricVersionIds } } })
      : [];
  const dataPointIds = [...new Set(dpVersions.map((v) => v.dataPointId))];
  const dataPoints =
    dataPointIds.length > 0
      ? await db.select('dataPoints', { where: { id: { in: dataPointIds } } })
      : [];
  const metricIds = [...new Set(dataPoints.map((d) => d.metricId))];
  const metrics =
    metricIds.length > 0 ? await db.select('metrics', { where: { id: { in: metricIds } } }) : [];

  const metricRefs: ImpactMetricRef[] = [];
  for (const block of blocks) {
    const version = blockVersions.find((v) => v.id === block.currentVersionId);
    for (const ref of version?.metricRefs ?? []) {
      const dpv = dpVersions.find((v) => v.id === ref);
      const dp = dpv ? dataPoints.find((d) => d.id === dpv.dataPointId) : undefined;
      const metric = dp ? metrics.find((m) => m.id === dp.metricId) : undefined;
      metricRefs.push({
        blockId: block.id,
        blockTitle: block.title,
        dataPointVersionId: ref,
        metricName: metric?.name ?? '（指標が見つかりません）',
        display: dpv ? `${formatNumber(dpv.value)} ${dpv.unitOfMeasure}` : '—',
        versionNo: dpv?.versionNo ?? null,
      });
    }
  }

  const approvals: ImpactApproval[] = [];
  for (const block of blocks) {
    if (block.approvedVersionId) {
      approvals.push({
        blockId: block.id,
        blockTitle: block.title,
        kind: 'approved_version',
        label:
          '承認済みの版（変更前の前提で承認されています。変更後は「再確認が必要」になり、再承認するまでレポートを確定できません）',
      });
    }
    for (const request of requests.filter((r) => r.targetId === block.id)) {
      approvals.push({
        blockId: block.id,
        blockTitle: block.title,
        kind: 'open_review',
        label:
          request.status === 'open'
            ? 'レビュー依頼中（変更後は最終承認できません。差し戻して変更後の範囲で確認してください）'
            : 'レビュー完了・承認待ち（変更後は最終承認できません。差し戻して変更後の範囲で確認してください）',
      });
    }
  }

  return {
    blocks: blocks.map((b) => ({
      blockId: b.id,
      title: b.title,
      status: b.status,
      statusLabel: BLOCK_STATUS_LABELS[b.status],
      language: b.language,
      frameworkLabel: labelOf(b.frameworkVersionId),
    })),
    metricRefs,
    approvals,
  };
}

function normalizeUpdate(
  current: DisclosureProject,
  input: UpdateProjectInput,
  units: ReadonlyArray<{ id: Uuid }>,
  members: readonly MemberEntry[],
): Partial<DisclosureProject> {
  const errors: Record<string, string> = {};
  const name = clean(input.name);
  if (!name) errors.name = 'プロジェクト名を入力してください。';
  const periodStart = clean(input.periodStart);
  const periodEnd = clean(input.periodEnd);
  if (!isIsoDate(periodStart))
    errors.periodStart = '年度の開始日を YYYY-MM-DD で入力してください。';
  if (!isIsoDate(periodEnd)) errors.periodEnd = '年度の終了日を YYYY-MM-DD で入力してください。';
  if (isIsoDate(periodStart) && isIsoDate(periodEnd) && periodStart > periodEnd) {
    errors.periodEnd = '終了日は開始日以降にしてください。';
  }
  const currency = clean(input.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency))
    errors.currency = '通貨は 3 文字の通貨コード（例: JPY）で入力してください。';
  const dueDate = clean(input.dueDate) || null;
  if (dueDate && !isIsoDate(dueDate)) errors.dueDate = '期限を YYYY-MM-DD で入力してください。';
  if (!DISCLOSURE_PROJECT_STATUSES.includes(input.status)) errors.status = '状態を選んでください。';
  const languages = [...new Set(input.languages)].filter((l) => DISCLOSURE_LANGUAGES.includes(l));
  if (languages.length === 0) errors.languages = '原稿の言語を 1 つ以上選んでください。';
  const includedUnitIds = [...new Set(input.includedUnitIds)];
  if (includedUnitIds.some((id) => !units.some((u) => u.id === id))) {
    errors.includedUnitIds = '対象組織はこの組織の拠点から選んでください。';
  }
  validateAssignees(members, input, errors);
  if (Object.keys(errors).length > 0) throw new FieldValidationError(errors);

  const next: Partial<DisclosureProject> = {
    name,
    reportingEntity: clean(input.reportingEntity).slice(0, 300),
    periodStart,
    periodEnd,
    currency,
    dueDate,
    status: input.status,
    ownerUserId: input.ownerUserId,
    reviewerUserId: input.reviewerUserId,
    finalApproverUserId: input.finalApproverUserId,
    languages,
    scopeOrgNote: clean(input.scopeOrgNote).slice(0, 2000),
    scopeConsolidationNote: clean(input.scopeConsolidationNote).slice(0, 2000),
    scopeGhgBoundaryNote: clean(input.scopeGhgBoundaryNote).slice(0, 2000),
    scopeValueChainNote: clean(input.scopeValueChainNote).slice(0, 2000),
    includedUnitIds,
  };
  // 変わった項目だけを返す（監査ログと影響判定に使う）
  const changed: Partial<DisclosureProject> = {};
  for (const [key, value] of Object.entries(next) as Array<[keyof DisclosureProject, unknown]>) {
    const before = current[key];
    const same = Array.isArray(value)
      ? JSON.stringify([...(value as string[])].sort()) ===
        JSON.stringify([...((before as string[]) ?? [])].sort())
      : before === value;
    if (!same) (changed as Record<string, unknown>)[key] = value;
  }
  return changed;
}

export type UpdateProjectResult =
  | { status: 'saved'; changedFields: string[]; impact: ChangeImpact }
  | { status: 'unchanged' }
  | { status: 'needs_confirmation'; changedFields: string[]; impact: ChangeImpact };

/**
 * プロジェクトを更新する。報告範囲・期間を変える場合は、影響する原稿・数値・承認を返し、
 * `confirmImpact` が無ければ保存しない（先に一覧を見せる）。原稿は書き換えない。
 */
export async function updateProject(
  db: DbClient,
  ctx: AuthorizationContext,
  projectId: Uuid,
  input: UpdateProjectInput,
  options: { confirmImpact: boolean },
): Promise<UpdateProjectResult> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const detail = await getProject(db, ctx, projectId);
  const units = await db.select('units', {
    where: { organizationId: ctx.workspace.organizationId, deletedAt: { isNull: true } },
  });
  const changed = normalizeUpdate(detail.project, input, units, detail.members);
  const changedFields = Object.keys(changed);
  if (changedFields.length === 0) return { status: 'unchanged' };

  const scopeChanged = changedFields.some((f) => (SCOPE_FIELDS as readonly string[]).includes(f));
  const impact = scopeChanged
    ? await computeBlockImpact(db, detail)
    : { blocks: [], metricRefs: [], approvals: [] };
  if (!isEmptyImpact(impact) && !options.confirmImpact) {
    return { status: 'needs_confirmation', changedFields, impact };
  }

  await db.update('disclosureProjects', projectId, {
    ...changed,
    // 報告範囲・期間を変えたら改訂番号を上げる。これより前の依頼で承認された節は
    // 「再確認が必要」になり、レポートの確定と依頼中の最終承認を止める（指示書 §10.3）
    ...(scopeChanged ? { scopeRevision: (detail.project.scopeRevision ?? 0) + 1 } : {}),
    updatedAt: new Date().toISOString(),
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'project_updated',
    resourceType: 'disclosure_project',
    resourceId: projectId,
    afterSummary: `変更: ${changedFields.map((f) => PROJECT_FIELD_LABELS[f] ?? f).join('・')}`,
    metadata: {
      changedFields,
      scopeRevised: scopeChanged,
      impactedBlocks: impact.blocks.length,
      impactedMetricRefs: impact.metricRefs.length,
      impactedApprovals: impact.approvals.length,
    },
  });
  return { status: 'saved', changedFields, impact };
}

// ======================================================================
// 基準ごとの設定（保存して準備を始める／適用判断を確定）
// ======================================================================

async function loadProjectFramework(
  db: DbClient,
  ctx: AuthorizationContext,
  projectFrameworkId: Uuid,
): Promise<{ pf: ProjectFramework; view: ProjectFrameworkView; detail: ProjectDetail }> {
  const pf = await db.findById('projectFrameworks', projectFrameworkId);
  if (!pf || pf.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('プロジェクトの基準が見つかりません。');
  }
  const detail = await getProject(db, ctx, pf.projectId);
  const view = detail.frameworks.find((f) => f.projectFramework.id === pf.id);
  if (!view) throw new NotFoundError('プロジェクトの基準が見つかりません。');
  return { pf, view, detail };
}

/**
 * 「保存して準備を始める」。適用条件と準備の区分（適用候補／確認待ち）を保存する。
 * 判断は確定しない。確定済みの判断がある基準は区分を変えない（条件の変更は判断との差として示す）。
 * 未入力の条件から「対象外」を推測することはしない。
 */
export async function saveProjectFramework(
  db: DbClient,
  ctx: AuthorizationContext,
  input: {
    projectFrameworkId: Uuid;
    conditions: FrameworkConditions;
    preparationStatus: PreparationStatus;
  },
): Promise<ProjectFramework> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const { pf, view } = await loadProjectFramework(db, ctx, input.projectFrameworkId);
  if (!PREPARATION_STATUSES.includes(input.preparationStatus)) {
    throw new ValidationError('準備の区分は「適用候補」か「確認待ち」を選んでください。');
  }
  // 定義に無いキーは保存しない（画面の改ざんで任意のキーを持ち込ませない）
  const allowed = new Set(view.conditionFields.map((f) => f.key));
  const conditions: FrameworkConditions = {};
  for (const [key, value] of Object.entries(input.conditions)) {
    if (allowed.has(key) && value !== null && value !== '') conditions[key] = value;
  }

  const applicabilityStatus =
    pf.currentDecisionId !== null ? pf.applicabilityStatus : input.preparationStatus;
  const updated = await db.update('projectFrameworks', pf.id, {
    conditions,
    applicabilityStatus,
    updatedAt: new Date().toISOString(),
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'project_updated',
    resourceType: 'project_framework',
    resourceId: pf.id,
    beforeSummary: `${view.label}: ${APPLICABILITY_STATUS_LABELS[pf.applicabilityStatus]}`,
    afterSummary: `${view.label}: ${APPLICABILITY_STATUS_LABELS[applicabilityStatus]}（条件 ${Object.keys(conditions).length} 項目入力）`,
    metadata: { conditionKeys: Object.keys(conditions) },
  });
  return updated;
}

export interface ConfirmApplicabilityInput {
  projectFrameworkId: Uuid;
  applicabilityStatus: DecisionStatus;
  reason: string;
  ruleRef: string;
  confirmedOn: string;
  transitionalNote: string | null;
}

/**
 * 「適用判断を確定」。判断は追記専用で、見直しは新しい判断番号で追記する。
 * 判断者は操作した本人。判断時点の条件の写しを残す（後から条件を直しても根拠は変わらない）。
 */
export async function confirmApplicability(
  db: DbClient,
  ctx: AuthorizationContext,
  input: ConfirmApplicabilityInput,
): Promise<ProjectFrameworkDecision> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const { pf, view } = await loadProjectFramework(db, ctx, input.projectFrameworkId);

  const errors: Record<string, string> = {};
  if (!DECISION_STATUSES.includes(input.applicabilityStatus)) {
    errors.applicabilityStatus = '判断の区分を選んでください（未判定は確定できません）。';
  }
  const reason = clean(input.reason);
  if (!reason) errors.reason = '判断の理由を入力してください。';
  const ruleRef = clean(input.ruleRef);
  if (!ruleRef) errors.ruleRef = '参照した規則とその版を入力してください。';
  const confirmedOn = clean(input.confirmedOn);
  if (!isIsoDate(confirmedOn))
    errors.confirmedOn = '規則を確認した日を YYYY-MM-DD で入力してください。';
  if (Object.keys(errors).length > 0) throw new FieldValidationError(errors);

  const decisionNo = (view.decisions[0]?.decisionNo ?? 0) + 1;
  const decision: ProjectFrameworkDecision = {
    id: randomUUID(),
    organizationId: pf.organizationId,
    projectFrameworkId: pf.id,
    decisionNo,
    applicabilityStatus: input.applicabilityStatus,
    reason: reason.slice(0, 4000),
    ruleRef: ruleRef.slice(0, 1000),
    confirmedOn,
    transitionalNote: clean(input.transitionalNote) || null,
    conditionsSnapshot: { ...pf.conditions },
    decidedBy: ctx.userId,
    decidedAt: new Date().toISOString(),
  };
  // 判断を追記してから、現在の判断を指し直す（DB の複合外部キーは遅延可能）
  await db.insert('projectFrameworkDecisions', [decision]);
  await db.update('projectFrameworks', pf.id, {
    applicabilityStatus: decision.applicabilityStatus,
    currentDecisionId: decision.id,
    updatedAt: decision.decidedAt,
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'framework_decision_confirmed',
    resourceType: 'project_framework',
    resourceId: pf.id,
    beforeSummary: `${view.label}: ${APPLICABILITY_STATUS_LABELS[pf.applicabilityStatus]}`,
    afterSummary: `${view.label}: 判断 ${decisionNo}「${APPLICABILITY_STATUS_LABELS[decision.applicabilityStatus]}」`,
    metadata: { decisionId: decision.id, ruleRef: decision.ruleRef, confirmedOn },
  });
  return decision;
}

// ======================================================================
// 基準の版の移行（A23: 新しい版は既存プロジェクトを変えない。人が明示して追加する）
// ======================================================================

export interface VersionDiff {
  added: Array<{ code: string; title: string }>;
  removed: Array<{ code: string; title: string }>;
  changed: Array<{ code: string; title: string }>;
  unchangedCount: number;
}

/** 2 つの版の要求事項を項番で突き合わせる（公式条項と内部タスクが 1 対 1 とは限らないため、差は人が確認する） */
export async function compareFrameworkVersions(
  db: DbClient,
  fromVersionId: Uuid,
  toVersionId: Uuid,
): Promise<VersionDiff> {
  const [fromItems, toItems] = await Promise.all([
    db.select('disclosureItems', { where: { frameworkVersionId: fromVersionId } }),
    db.select('disclosureItems', { where: { frameworkVersionId: toVersionId } }),
  ]);
  const fromByCode = new Map(fromItems.map((i) => [i.code, i]));
  const toByCode = new Map(toItems.map((i) => [i.code, i]));
  const diff: VersionDiff = { added: [], removed: [], changed: [], unchangedCount: 0 };
  for (const item of toItems) {
    const before = fromByCode.get(item.code);
    if (!before) diff.added.push({ code: item.code, title: item.questionText });
    else if (before.questionText !== item.questionText || before.guidance !== item.guidance) {
      diff.changed.push({ code: item.code, title: item.questionText });
    } else diff.unchangedCount += 1;
  }
  for (const item of fromItems) {
    if (!toByCode.has(item.code)) diff.removed.push({ code: item.code, title: item.questionText });
  }
  return diff;
}

/**
 * 新しい版を「追加で」登録する。既存の版と、その版で書いた原稿・承認・判断はそのまま残す。
 * 新しい版の適用判断は未確定（準備の区分）から始める（旧版の判断を引き継がない）。
 */
export async function attachFrameworkVersion(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { projectFrameworkId: Uuid; newVersionId: Uuid; acknowledgeImpact: boolean },
): Promise<ProjectFramework> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const { pf, view, detail } = await loadProjectFramework(db, ctx, input.projectFrameworkId);
  const target = view.newerVersions.find((v) => v.version.id === input.newVersionId);
  if (!target) throw new ValidationError('追加できる新しい版ではありません。');
  if (detail.frameworks.some((f) => f.version.id === input.newVersionId)) {
    throw new ValidationError('この版は既にプロジェクトに登録されています。');
  }
  const impact = await computeBlockImpact(
    db,
    detail,
    (b) => b.frameworkVersionId === pf.frameworkVersionId,
  );
  if (!isEmptyImpact(impact) && !input.acknowledgeImpact) {
    throw new ValidationError(
      '影響する原稿・数値・承認の一覧を確認し、「影響を確認しました」にチェックしてください。',
    );
  }

  const now = new Date().toISOString();
  const row: ProjectFramework = {
    id: randomUUID(),
    organizationId: pf.organizationId,
    projectId: pf.projectId,
    frameworkVersionId: target.version.id,
    purpose: pf.purpose,
    applicabilityStatus: 'candidate',
    currentDecisionId: null,
    conditions: { ...pf.conditions },
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  };
  await db.insert('projectFrameworks', [row]);
  await recordAuditEvent(db, ctx, {
    eventType: 'project_updated',
    resourceType: 'project_framework',
    resourceId: row.id,
    afterSummary: `${target.version.label} を追加（${view.label} は維持）`,
    metadata: {
      fromVersionId: pf.frameworkVersionId,
      toVersionId: target.version.id,
      impactedBlocks: impact.blocks.length,
    },
  });
  return row;
}

// ======================================================================
// 確定パッケージの可否（§6.2・§5「レポート確定」。S-e の出力が使う）
// ======================================================================

export interface PackageFrameworkInput {
  label: string;
  purpose: DisclosurePurpose;
  applicabilityStatus: ApplicabilityStatus;
  currentDecisionId: Uuid | null;
  legalStatus: FrameworkLegalStatus | null;
  coverageStatus: FrameworkCoverageStatus | null;
  isFixture?: boolean;
}

export interface StatutoryPackageCheck {
  ok: boolean;
  reasons: string[];
  /** 適用判断が確定していない基準（目的を問わない） */
  unconfirmed: string[];
  /** 草案・サンプル・未収録の基準（草案基準による準備としか表示できない） */
  preparationOnly: string[];
}

/** 判断が確定済みか（適用・対象外・任意適用の判断記録がある） */
export function isApplicabilityConfirmed(
  f: Pick<PackageFrameworkInput, 'applicabilityStatus' | 'currentDecisionId'>,
): boolean {
  return f.currentDecisionId !== null && FINAL_APPLICABILITY.includes(f.applicabilityStatus);
}

/**
 * 法定提出用の確定パッケージを作れるか。
 *  - 法定の目的（SSBJ（法定）・CSRD（EU 法人））を含むこと
 *  - どの基準も適用判断が確定していること（未確認のままでは法定パッケージにしない）
 *  - 法定の目的の基準が草案・サンプル・未収録でないこと
 * 下書き準備（草稿スナップショット）はこの判定に関係なく作れる。
 */
export function canCreateStatutoryPackage(input: {
  purposes: readonly DisclosurePurpose[];
  frameworks: readonly PackageFrameworkInput[];
}): StatutoryPackageCheck {
  const reasons: string[] = [];
  if (!input.purposes.some((p) => STATUTORY_PURPOSES.includes(p))) {
    reasons.push(
      '法定提出の目的（SSBJ（法定）・CSRD（EU 法人））を含まないプロジェクトです。社内承認済み版として扱います。',
    );
  }
  const unconfirmed = input.frameworks.filter((f) => !isApplicabilityConfirmed(f));
  for (const f of unconfirmed) {
    reasons.push(
      `「${f.label}」の適用判断が確定していません（現在: ${APPLICABILITY_STATUS_LABELS[f.applicabilityStatus]}）。`,
    );
  }
  const preparationOnly = input.frameworks.filter(
    (f) =>
      f.isFixture === true ||
      f.legalStatus === 'draft' ||
      f.legalStatus === 'sample' ||
      f.coverageStatus === 'not_loaded' ||
      f.coverageStatus === 'sample',
  );
  for (const f of preparationOnly.filter((f) => STATUTORY_PURPOSES.includes(f.purpose))) {
    reasons.push(
      `「${f.label}」は草案・サンプルの基準のため、法定提出用の確定パッケージにできません。`,
    );
  }
  if (input.frameworks.length === 0) reasons.push('基準が登録されていません。');
  return {
    ok: reasons.length === 0,
    reasons,
    unconfirmed: unconfirmed.map((f) => f.label),
    preparationOnly: preparationOnly.map((f) => f.label),
  };
}

export function packageInputOf(view: ProjectFrameworkView): PackageFrameworkInput {
  return {
    label: view.label,
    purpose: view.projectFramework.purpose,
    applicabilityStatus: view.projectFramework.applicabilityStatus,
    currentDecisionId: view.projectFramework.currentDecisionId,
    legalStatus: view.version.legalStatus,
    coverageStatus: view.version.coverageStatus,
    isFixture: view.version.isFixture,
  };
}

/** プロジェクトを読み込んで確定パッケージの可否を返す（出力画面・レポート確定から呼ぶ） */
export async function loadStatutoryPackageCheck(
  db: DbClient,
  ctx: AuthorizationContext,
  projectId: Uuid,
): Promise<StatutoryPackageCheck> {
  const detail = await getProject(db, ctx, projectId);
  return canCreateStatutoryPackage({
    purposes: detail.project.purposes,
    frameworks: detail.frameworks.map(packageInputOf),
  });
}

// ======================================================================
// 要求事項一覧（§6.3・§8.3）
// ======================================================================

export const REQUIREMENT_FILTERS = ['mine', 'missing', 'review', 'returned', 'recheck'] as const;
export type RequirementFilter = (typeof REQUIREMENT_FILTERS)[number];

export const REQUIREMENT_FILTER_LABELS: Readonly<Record<RequirementFilter, string>> = {
  mine: '自分の担当',
  missing: '情報不足',
  review: 'レビュー待ち',
  returned: '差戻し',
  recheck: '要再確認',
};

/** 要求事項の適用判断（内容評価・原稿状態とは別の属性） */
export type RequirementDecisionKind =
  'material' | 'not_applicable' | 'not_material' | 'not_assessed';

export interface RequirementDecision {
  kind: RequirementDecisionKind;
  label: string;
  reason: string | null;
  decidedBy: Uuid | null;
  decidedByName: string | null;
  /** 対象外・非重要のように、分母から外す確定判断か */
  excluded: boolean;
  note: string | null;
}

/**
 * 既存の SSBJ 評価（ssbj_assessments）から、要求事項の適用判断を読む。
 * 既定値（適用・重要性未判定）は人の判断ではないので「未判定」として扱う。
 * 対象外・非重要は理由がある場合だけ「判断済み」にする（理由の無い除外で分母を減らさない）。
 */
export function requirementDecisionOf(
  assessment: SsbjAssessment | undefined,
  members: readonly MemberEntry[],
): RequirementDecision {
  if (!assessment) {
    return {
      kind: 'not_assessed',
      label: '未判定',
      reason: null,
      decidedBy: null,
      decidedByName: null,
      excluded: false,
      note: '評価の行がありません。',
    };
  }
  const decider = assessment.updatedBy ?? assessment.createdBy;
  if (assessment.applicability === 'not_applicable') {
    const reason = clean(assessment.applicabilityReason);
    if (!reason) {
      return {
        kind: 'not_assessed',
        label: '未判定',
        reason: null,
        decidedBy: null,
        decidedByName: null,
        excluded: false,
        note: '対象外の理由が記録されていないため、判断済みとして扱いません。',
      };
    }
    return {
      kind: 'not_applicable',
      label: '対象外と判断',
      reason,
      decidedBy: decider,
      decidedByName: nameOf(members, decider),
      excluded: true,
      note: null,
    };
  }
  if (assessment.materiality === 'not_material') {
    const reason = clean(assessment.materialityReason);
    if (!reason) {
      return {
        kind: 'not_assessed',
        label: '未判定',
        reason: null,
        decidedBy: null,
        decidedByName: null,
        excluded: false,
        note: '非重要の理由が記録されていないため、判断済みとして扱いません。',
      };
    }
    return {
      kind: 'not_material',
      label: '非重要と判断',
      reason,
      decidedBy: decider,
      decidedByName: nameOf(members, decider),
      excluded: true,
      note: null,
    };
  }
  if (assessment.materiality === 'material') {
    return {
      kind: 'material',
      label: '適用（重要）',
      reason: clean(assessment.materialityReason) || null,
      decidedBy: decider,
      decidedByName: nameOf(members, decider),
      excluded: false,
      note: null,
    };
  }
  return {
    kind: 'not_assessed',
    label: '未判定',
    reason: null,
    decidedBy: null,
    decidedByName: null,
    excluded: false,
    note: '重要性が未判定です（対象の既定値は判断として扱いません）。',
  };
}

export interface ContentEvaluation {
  /** human = 担当者の確認済み判定／ai_candidate = AI の候補（未確認）／none = 評価なし */
  source: 'human' | 'ai_candidate' | 'none';
  status: SsbjCoverageStatus | null;
  label: string;
}

function contentEvaluationOf(assessment: SsbjAssessment | undefined): ContentEvaluation {
  if (assessment?.finalStatus && assessment.reviewedAt) {
    return {
      source: 'human',
      status: assessment.finalStatus,
      label: COVERAGE_LABEL[assessment.finalStatus],
    };
  }
  if (assessment?.aiStatus) {
    return {
      source: 'ai_candidate',
      status: assessment.aiStatus,
      label: `候補: ${COVERAGE_LABEL[assessment.aiStatus]}`,
    };
  }
  return { source: 'none', status: null, label: '評価なし' };
}

export type EvidenceKind = 'current' | 'prior_only' | 'none' | 'no_manuscript';
export type MetricKind = 'stale' | 'unapproved' | 'missing_value' | 'ok' | 'none';

export interface RequirementRow {
  item: DisclosureItem;
  isSample: boolean;
  decision: RequirementDecision;
  contentEvaluation: ContentEvaluation;
  blocks: Array<{
    id: Uuid;
    title: string;
    status: BlockStatus;
    language: DisclosureLanguage;
    /** 翻訳版の節（要求事項の承認は元の節で数える） */
    translation: boolean;
  }>;
  manuscript: { status: BlockStatus | 'not_started'; label: string };
  evidence: { kind: EvidenceKind; label: string; count: number };
  metrics: { kind: MetricKind; label: string };
  ownerUserId: Uuid | null;
  ownerLabel: string | null;
  dueDate: IsoDate | null;
  flags: Record<RequirementFilter, boolean>;
}

export interface RequirementSummary {
  /** 収録されている要求事項の数（未収録の版は 0） */
  total: number;
  /** 適用確定済み（重要と判断） */
  applicableConfirmed: number;
  /** うち原稿の節（翻訳版を除く）に割り当て済み */
  assignedOfApplicable: number;
  /** うち割り当てた原稿の節（翻訳版を除く）がすべて承認済み（開示ホームと同じ数え方） */
  approvedOfApplicable: number;
  /** 対象外・非重要と判断（理由・判断者あり） */
  excludedDecided: number;
  /** 適用未判定（分母から消さない） */
  notAssessed: number;
  /** 準備完了か（未判定 0、適用確定分がすべて承認済み、要求事項が収録済み） */
  readyForCompletion: boolean;
  notReadyReasons: string[];
}

export interface RequirementsResult {
  framework: ProjectFrameworkView;
  mode: 'rows' | 'not_loaded';
  rows: RequirementRow[];
  summary: RequirementSummary;
}

/** 数値の状態の優先度（悪いほうを代表にする） */
const METRIC_SEVERITY: Record<MetricKind, number> = {
  stale: 4,
  unapproved: 3,
  missing_value: 2,
  ok: 1,
  none: 0,
};

const BLOCK_STATUS_PRIORITY: Record<BlockStatus, number> = {
  returned: 5,
  review_requested: 4,
  approval_pending: 3,
  draft: 2,
  approved: 1,
};

/**
 * 1 つの基準の版について、要求事項ごとの行と集計を作る。
 * 行は「適用判断」「内容評価」「本文状態」「根拠」「数値」を別々の列として持つ。
 */
export async function buildRequirementRows(
  db: DbClient,
  ctx: AuthorizationContext,
  detail: ProjectDetail,
  framework: ProjectFrameworkView,
): Promise<RequirementsResult> {
  const project = detail.project;
  const organizationId = project.organizationId;
  const items = (
    await db.select('disclosureItems', {
      where: { frameworkVersionId: framework.version.id },
    })
  ).sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));

  if (items.length === 0) {
    const reasons =
      framework.version.coverageStatus === 'not_loaded'
        ? ['要求事項は未収録です（公開草案）。正式版の収録後に判定できます。']
        : ['要求事項が登録されていません。'];
    return {
      framework,
      mode: 'not_loaded',
      rows: [],
      summary: {
        total: 0,
        applicableConfirmed: 0,
        assignedOfApplicable: 0,
        approvedOfApplicable: 0,
        excludedDecided: 0,
        notAssessed: 0,
        readyForCompletion: false,
        notReadyReasons: reasons,
      },
    };
  }

  const itemIds = items.map((i) => i.id);
  const blocks = detail.blocks.filter((b) => b.frameworkVersionId === framework.version.id);
  const versionIds = blocks.map((b) => b.currentVersionId).filter((id): id is Uuid => id !== null);

  const [assessments, blockVersions, mappings] = await Promise.all([
    db.select('ssbjAssessments', {
      where: {
        organizationId,
        reportingPeriodId: project.reportingPeriodId,
        itemId: { in: itemIds },
      },
    }),
    versionIds.length > 0
      ? db.select('disclosureBlockVersions', { where: { id: { in: versionIds } } })
      : Promise.resolve([] as DisclosureBlockVersion[]),
    db.select('disclosureMappings', { where: { organizationId, itemId: { in: itemIds } } }),
  ]);

  // 本文が引用している数値・定性情報・引用位置
  const metricVersionIds = [...new Set(blockVersions.flatMap((v) => v.metricRefs))];
  const narrativeVersionIds = [...new Set(blockVersions.flatMap((v) => v.narrativeRefs))];
  const [dpVersions, narrativeVersions] = await Promise.all([
    metricVersionIds.length > 0
      ? db.select('dataPointVersions', { where: { id: { in: metricVersionIds } } })
      : Promise.resolve([]),
    narrativeVersionIds.length > 0
      ? db.select('narrativeVersions', { where: { id: { in: narrativeVersionIds } } })
      : Promise.resolve([]),
  ]);
  const citedDataPointIds = [...new Set(dpVersions.map((v) => v.dataPointId))];
  const narrativeRecordIds = [...new Set(narrativeVersions.map((v) => v.narrativeRecordId))];
  const anchorIds = [
    ...new Set([
      ...blockVersions.flatMap((v) => v.anchorRefs),
      ...narrativeVersions.flatMap((v) => v.sourceAnchorIds),
    ]),
  ];
  const mappedMetricIds = [...new Set(mappings.map((m) => m.metricId))];
  const [citedDataPoints, narrativeRecords, anchors, mappedDataPoints] = await Promise.all([
    citedDataPointIds.length > 0
      ? db.select('dataPoints', { where: { id: { in: citedDataPointIds } } })
      : Promise.resolve([]),
    narrativeRecordIds.length > 0
      ? db.select('narrativeRecords', { where: { id: { in: narrativeRecordIds } } })
      : Promise.resolve([]),
    anchorIds.length > 0
      ? db.select('sourceAnchors', { where: { id: { in: anchorIds } } })
      : Promise.resolve([]),
    mappedMetricIds.length > 0
      ? db.select('dataPoints', {
          where: {
            organizationId,
            reportingPeriodId: project.reportingPeriodId,
            metricId: { in: mappedMetricIds },
            deletedAt: { isNull: true },
          },
        })
      : Promise.resolve([]),
  ]);
  const fileVersionIds = [...new Set(anchors.map((a) => a.fileVersionId))];
  const fileVersions =
    fileVersionIds.length > 0
      ? await db.select('fileVersions', { where: { id: { in: fileVersionIds } } })
      : [];
  const fileIds = [...new Set(fileVersions.map((v) => v.fileId))];
  const files =
    fileIds.length > 0 ? await db.select('files', { where: { id: { in: fileIds } } }) : [];

  const purposeOfAnchor = (anchorId: Uuid) => {
    const anchor = anchors.find((a) => a.id === anchorId);
    const fv = anchor ? fileVersions.find((v) => v.id === anchor.fileVersionId) : undefined;
    const file = fv ? files.find((f) => f.id === fv.fileId && !f.deletedAt) : undefined;
    return file ? file.usagePurpose : undefined;
  };

  /** 節ごとの根拠・数値・再確認の状態 */
  const blockState = new Map<
    Uuid,
    { anchorIds: Uuid[]; metric: MetricKind; stale: boolean; hasVersion: boolean }
  >();
  for (const block of blocks) {
    const version = blockVersions.find((v) => v.id === block.currentVersionId);
    if (!version) {
      blockState.set(block.id, { anchorIds: [], metric: 'none', stale: false, hasVersion: false });
      continue;
    }
    const cited = narrativeVersions.filter((v) => version.narrativeRefs.includes(v.id));
    const ownAnchors = [
      ...new Set([...version.anchorRefs, ...cited.flatMap((v) => v.sourceAnchorIds)]),
    ];
    let metric: MetricKind = version.metricRefs.length > 0 ? 'ok' : 'none';
    let stale = false;
    for (const ref of version.metricRefs) {
      const dpv = dpVersions.find((v) => v.id === ref);
      const dp = dpv ? citedDataPoints.find((d) => d.id === dpv.dataPointId) : undefined;
      if (dp && dp.currentVersionId !== null && dp.currentVersionId !== ref) {
        stale = true;
        metric = 'stale';
      } else if (dpv && dpv.status !== 'approved' && METRIC_SEVERITY[metric] < 3) {
        metric = 'unapproved';
      }
    }
    for (const v of cited) {
      const record = narrativeRecords.find((r) => r.id === v.narrativeRecordId);
      if (record && record.currentVersionId !== null && record.currentVersionId !== v.id) {
        stale = true;
      }
    }
    blockState.set(block.id, { anchorIds: ownAnchors, metric, stale, hasVersion: true });
  }

  const assessmentByItem = new Map(assessments.map((a) => [a.itemId, a]));
  const isSample = framework.legal.isSample;

  const rows: RequirementRow[] = items.map((item) => {
    const assessment = assessmentByItem.get(item.id);
    const decision = requirementDecisionOf(assessment, detail.members);
    const own = blocks
      .filter((b) => b.requirementItemIds.includes(item.id))
      .sort(
        (a, b) =>
          BLOCK_STATUS_PRIORITY[b.status] - BLOCK_STATUS_PRIORITY[a.status] ||
          a.sortOrder - b.sortOrder,
      );
    const lead = own[0];
    const manuscript = lead
      ? { status: lead.status, label: BLOCK_STATUS_LABELS[lead.status] }
      : { status: 'not_started' as const, label: '未着手' };

    // 根拠: 本文と引用した定性情報の引用位置を、資料の利用目的で分ける
    let evidence: RequirementRow['evidence'];
    const states = own.map((b) => blockState.get(b.id)).filter((s) => s !== undefined);
    if (own.length === 0 || !states.some((s) => s.hasVersion)) {
      evidence = { kind: 'no_manuscript', label: '—（原稿なし）', count: 0 };
    } else {
      const ids = [...new Set(states.flatMap((s) => s.anchorIds))];
      const current = ids.filter((id) => purposeOfAnchor(id) === 'current_fact').length;
      if (current > 0)
        evidence = { kind: 'current', label: `当年度の根拠 ${current} 件`, count: current };
      else if (ids.length > 0)
        evidence = {
          kind: 'prior_only',
          label: `過年度・参考のみ ${ids.length} 件`,
          count: ids.length,
        };
      else evidence = { kind: 'none', label: '根拠なし', count: 0 };
    }

    // 数値: 本文が引用した版の状態。引用が無ければ対応付けた指標の当期値
    let metricKind: MetricKind = 'none';
    for (const s of states) {
      if (METRIC_SEVERITY[s.metric] > METRIC_SEVERITY[metricKind]) metricKind = s.metric;
    }
    let metricLabel: string;
    if (metricKind !== 'none') {
      metricLabel =
        metricKind === 'stale'
          ? '引用後に新しい版あり'
          : metricKind === 'unapproved'
            ? '未承認の数値を引用'
            : '引用中の数値は承認済み';
    } else {
      const mapped = mappings
        .filter((m) => m.itemId === item.id)
        .flatMap((m) => mappedDataPoints.filter((d) => d.metricId === m.metricId));
      if (mapped.length === 0) {
        metricLabel = '—';
      } else {
        const missing = mapped.filter((d) => d.availabilityStatus !== 'value_present').length;
        const approved = mapped.filter((d) => d.status === 'approved').length;
        if (missing > 0) {
          metricKind = 'missing_value';
          metricLabel = `値なし ${missing} 件（対応数値 ${mapped.length} 件）`;
        } else if (approved < mapped.length) {
          metricKind = 'unapproved';
          metricLabel = `未承認 ${mapped.length - approved} 件（対応数値 ${mapped.length} 件）`;
        } else {
          metricKind = 'ok';
          metricLabel = `対応数値 ${mapped.length} 件は承認済み`;
        }
      }
    }

    const ownerUserId = lead?.ownerUserId ?? assessment?.ownerUserId ?? null;
    const ownerLabel = lead?.ownerUserId
      ? nameOf(detail.members, lead.ownerUserId)
      : assessment?.ownerDepartment
        ? `${assessment.ownerDepartment}${assessment.ownerUserId ? `（${nameOf(detail.members, assessment.ownerUserId)}）` : ''}`
        : nameOf(detail.members, assessment?.ownerUserId ?? null);

    const stale = states.some((s) => s.stale);
    const flags: Record<RequirementFilter, boolean> = {
      mine: ownerUserId === ctx.userId || own.some((b) => b.ownerUserId === ctx.userId),
      missing:
        !decision.excluded &&
        (own.length === 0 ||
          evidence.kind === 'none' ||
          evidence.kind === 'prior_only' ||
          evidence.kind === 'no_manuscript' ||
          metricKind === 'missing_value' ||
          metricKind === 'unapproved'),
      review: own.some((b) => b.status === 'review_requested' || b.status === 'approval_pending'),
      returned: own.some((b) => b.status === 'returned'),
      recheck: stale,
    };

    return {
      item,
      isSample,
      decision,
      contentEvaluation: contentEvaluationOf(assessment),
      blocks: own.map((b) => ({
        id: b.id,
        title: b.title,
        status: b.status,
        language: b.language,
        translation: b.translationOfBlockId !== null,
      })),
      manuscript,
      evidence,
      metrics: { kind: metricKind, label: metricLabel },
      ownerUserId,
      ownerLabel,
      dueDate: lead?.dueDate ?? project.dueDate,
      flags,
    };
  });

  return { framework, mode: 'rows', rows, summary: summarizeRequirements(rows) };
}

/**
 * 要求事項が承認済みか: 割り当てた原稿の節（翻訳版を除く）が 1 つ以上あり、すべて承認済み。
 * 開示ホームの「承認済み」と同じ規則（ホームも buildRequirementRows の行からこの判定で数える）
 */
export function isRequirementApproved(row: Pick<RequirementRow, 'blocks'>): boolean {
  const originals = row.blocks.filter((b) => !b.translation);
  return originals.length > 0 && originals.every((b) => b.status === 'approved');
}

export function summarizeRequirements(rows: readonly RequirementRow[]): RequirementSummary {
  const applicable = rows.filter((r) => r.decision.kind === 'material');
  const assignedOfApplicable = applicable.filter((r) =>
    r.blocks.some((b) => !b.translation),
  ).length;
  const approvedOfApplicable = applicable.filter(isRequirementApproved).length;
  const excludedDecided = rows.filter((r) => r.decision.excluded).length;
  const notAssessed = rows.filter((r) => r.decision.kind === 'not_assessed').length;
  const reasons: string[] = [];
  if (notAssessed > 0) reasons.push(`適用未判定が ${notAssessed} 件あります。`);
  if (approvedOfApplicable < applicable.length) {
    reasons.push(
      `適用確定済み ${applicable.length} 項目のうち ${applicable.length - approvedOfApplicable} 項目が未承認です。`,
    );
  }
  return {
    total: rows.length,
    applicableConfirmed: applicable.length,
    assignedOfApplicable,
    approvedOfApplicable,
    excludedDecided,
    notAssessed,
    readyForCompletion: rows.length > 0 && reasons.length === 0,
    notReadyReasons: reasons,
  };
}

export function isRequirementFilter(value: unknown): value is RequirementFilter {
  return typeof value === 'string' && (REQUIREMENT_FILTERS as readonly string[]).includes(value);
}

/** 要求事項タブの読み込み（基準を選び、URL のフィルタを適用する） */
export async function loadProjectRequirements(
  db: DbClient,
  ctx: AuthorizationContext,
  projectId: Uuid,
  options: { projectFrameworkId?: string | null; filter?: RequirementFilter | null },
): Promise<{
  detail: ProjectDetail;
  result: RequirementsResult | null;
  filteredRows: RequirementRow[];
  filterCounts: Record<RequirementFilter, number>;
}> {
  const detail = await getProject(db, ctx, projectId);
  const framework =
    detail.frameworks.find((f) => f.projectFramework.id === options.projectFrameworkId) ??
    detail.frameworks[0];
  const empty = { mine: 0, missing: 0, review: 0, returned: 0, recheck: 0 };
  if (!framework) return { detail, result: null, filteredRows: [], filterCounts: empty };
  const result = await buildRequirementRows(db, ctx, detail, framework);
  const filterCounts = { ...empty };
  for (const row of result.rows) {
    for (const key of REQUIREMENT_FILTERS) if (row.flags[key]) filterCounts[key] += 1;
  }
  const filter = options.filter ?? null;
  return {
    detail,
    result,
    filteredRows: filter ? result.rows.filter((r) => r.flags[filter]) : result.rows,
    filterCounts,
  };
}

/** 概要タブ用: 基準ごとの分母付き進捗 */
export async function summarizeProject(
  db: DbClient,
  ctx: AuthorizationContext,
  detail: ProjectDetail,
): Promise<
  Array<{
    framework: ProjectFrameworkView;
    summary: RequirementSummary;
    mode: 'rows' | 'not_loaded';
  }>
> {
  const out = [];
  for (const framework of detail.frameworks) {
    const result = await buildRequirementRows(db, ctx, detail, framework);
    out.push({ framework, summary: result.summary, mode: result.mode });
  }
  return out;
}

// ======================================================================
// フォーム用の選択肢
// ======================================================================

export interface FrameworkVersionOption {
  versionId: Uuid;
  frameworkKey: FrameworkKey;
  label: string;
  legal: FrameworkLegalView;
  itemCount: number;
}

/** 目的ごとに選べる基準の版（改訂で置き換えられた版は出さない） */
export async function listFrameworkVersionOptions(
  db: DbClient,
): Promise<Record<DisclosurePurpose, FrameworkVersionOption[]>> {
  const [versions, frameworks, items] = await Promise.all([
    db.select('frameworkVersions'),
    db.select('frameworks'),
    db.select('disclosureItems'),
  ]);
  const byKey = new Map<FrameworkKey, FrameworkVersionOption[]>();
  for (const version of versions) {
    if (version.status === 'superseded' || version.legalStatus === 'superseded') continue;
    const framework = frameworks.find((f) => f.id === version.frameworkId);
    if (!framework) continue;
    const list = byKey.get(framework.key) ?? [];
    list.push({
      versionId: version.id,
      frameworkKey: framework.key,
      label: version.label,
      legal: describeFrameworkVersion(version),
      itemCount: items.filter((i) => i.frameworkVersionId === version.id).length,
    });
    byKey.set(framework.key, list);
  }
  const out = {} as Record<DisclosurePurpose, FrameworkVersionOption[]>;
  for (const purpose of DISCLOSURE_PURPOSES) {
    const key = PURPOSE_FRAMEWORK_KEY[purpose];
    out[purpose] = key ? (byKey.get(key) ?? []) : [];
  }
  return out;
}
