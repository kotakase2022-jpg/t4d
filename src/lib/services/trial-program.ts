import 'server-only';

import { randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import {
  assertCan,
  assertEnterpriseWorkspace,
  AuthorizationError,
  can,
  NotFoundError,
} from '@/lib/authorization/can';
import { backupPurgeDueOn } from '@/lib/domain/data-disposal';
import {
  reductionTargetOf,
  TRIAL_DECISION_LABELS,
  type ReductionTarget,
} from '@/lib/domain/trial-metrics';
import {
  parseTrialOptions,
  ROLLOUT_NOTE_MAX,
  validateTrialOptionsPatch,
  verificationUnitIds,
  type DisposalOptions,
  type FreeScopeOptions,
  type GhgVerificationOptions,
  type RolloutOptions,
  type TrialOptions,
} from '@/lib/domain/trial-options';
import { isPdf, scopeSignals, type ScopeSignal } from '@/lib/domain/trial-scope';
import { ValidationError } from '@/lib/errors/user-facing';
import { toJstDate } from '@/lib/format/datetime';
import { DEMO_TEXT_LIMITS } from '@/lib/repositories/demo-trial-checks';
import type { DbClient } from '@/lib/repositories/types';
import { loadGhgVerificationStatus, type GhgVerificationStatus } from '@/lib/services/ghg/status';
import { cdpOptionState } from '@/lib/services/organization-options';
import type { CdpOptionState } from '@/lib/ui/status/cdpOption';
import { isUuid } from '@/lib/validation/uuid';
import {
  TRIAL_AGREEMENT_KEYS,
  TRIAL_DECISIONS,
  TRIAL_END_DISPOSITIONS,
  TRIAL_PHASES,
  TRIAL_SCOPE_KINDS,
  type AuthorizationContext,
  type DisclosureProject,
  type GhgActivityKind,
  type GhgScope,
  type IsoDate,
  type OrganizationUnit,
  type ReportingPeriod,
  type TrialAgreement,
  type TrialAgreementKey,
  type TrialDecision,
  type TrialEndDisposition,
  type TrialPhase,
  type TrialProgram,
  type TrialScopeKind,
  type Uuid,
} from '@/types/domain';

/**
 * トライアルの計画・利用枠・選定ケース・終了時の扱いと導入判断（トライアル対応 NF-32・NF-37 の概要の合計）。
 *
 *  - 閲覧は企業の組織メンバー（enterprise.data.read）。監査法人は読めない（企業ワークスペースだけ）
 *  - 計画の作成・更新は enterprise.org.manage（RLS 0055 と同じ。新しい権限キーは足さない）
 *  - 「実績」は既存の表の件数から毎回導く（保存しない）。計画を超えても止めない（画面は Notice で知らせる）
 *  - 終了時の扱い・導入判断は人が入力する（AI は関与しない）
 *  - Demo Mode では本文を Cookie の容量に合わせて短くする（DEMO_TEXT_LIMITS。超えると Cookie から戻らない）
 *
 * トライアルの記録の他のサービス（trial-evaluation・trial-feedback・trial-timing）も、ここの検査と上限を使う。
 */

// ----------------------------------------------------------------------
// 共通の検査（トライアルの記録の全サービス）
// ----------------------------------------------------------------------

/** 閲覧: 企業ワークスペースの組織メンバー（監査法人のワークスペースからは見えない） */
export function assertTrialReader(ctx: AuthorizationContext): void {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.read');
}

/** 管理（計画・判定・改善管理表の更新・出力）: enterprise.org.manage */
export function assertTrialManager(ctx: AuthorizationContext): void {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.org.manage');
}

export function canManageTrial(ctx: AuthorizationContext): boolean {
  return ctx.workspace.organizationType === 'enterprise' && can(ctx, 'enterprise.org.manage');
}

/**
 * 記録（実施・フィードバック・作業時間）: 組織の有効なメンバー本人（RLS: is_org_member かつ本人名義）。
 * 停止中・招待中のメンバーは記録できない（Cookie の検査 demo-trial-checks.ts と同じ）
 */
export async function assertActiveMember(db: DbClient, ctx: AuthorizationContext): Promise<void> {
  assertTrialReader(ctx);
  const rows = await db.select('memberships', {
    where: { organizationId: ctx.workspace.organizationId, userId: ctx.userId, status: 'active' },
    limit: 1,
  });
  if (rows.length === 0) {
    throw new AuthorizationError('この組織の有効なメンバーだけが記録できます。');
  }
}

export interface TrialTextLimits {
  /** 件名・名前・役割名・担当などの短い欄 */
  title: number;
  /** 本文・コメント・理由 */
  text: number;
  /** 合意のメモ（3 つまとめて Cookie に載るため、さらに短い） */
  agreementNote: number;
  /** 将来の展開対象のメモ（options に載る。trial-options.ts の検査と同じ値） */
  rolloutNote: number;
}

/** 入力の上限（Demo Mode は Cookie の容量。Supabase Mode は DB の上限） */
export function trialTextLimits(db: DbClient, ctx: AuthorizationContext): TrialTextLimits {
  const demo = db.mode === 'demo' || ctx.demo;
  return demo
    ? {
        title: DEMO_TEXT_LIMITS.trialTitle,
        text: DEMO_TEXT_LIMITS.trialText,
        agreementNote: 100,
        rolloutNote: ROLLOUT_NOTE_MAX,
      }
    : { title: 200, text: 2000, agreementNote: 500, rolloutNote: 1000 };
}

/** 文字列の欄を検査する（前後の空白を除く。必須で空・上限超えは利用者向けのエラー） */
export function checkedText(
  value: string | null | undefined,
  label: string,
  max: number,
  { required = false }: { required?: boolean } = {},
): string {
  const text = (value ?? '').trim();
  if (required && text === '') throw new ValidationError(`${label}を入力してください。`);
  if (text.length > max) throw new ValidationError(`${label}は ${max} 字以内で入力してください。`);
  return text;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function checkedDate(value: string | null | undefined, label: string): IsoDate | null {
  const text = (value ?? '').trim();
  if (text === '') return null;
  if (!DATE_PATTERN.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new ValidationError(`${label}は日付（YYYY-MM-DD）で入力してください。`);
  }
  return text;
}

function oneOf<T extends string>(values: readonly T[], value: unknown, label: string): T {
  if (typeof value === 'string' && (values as readonly string[]).includes(value)) return value as T;
  throw new ValidationError(`${label}を選んでください。`);
}

// ----------------------------------------------------------------------
// 計画の読み込み
// ----------------------------------------------------------------------

/** 組織のトライアル計画（複数あれば最新の 1 件）。無ければ null */
export async function loadTrialProgram(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<TrialProgram | null> {
  assertTrialReader(ctx);
  const rows = await db.select('trialPrograms', {
    where: { organizationId: ctx.workspace.organizationId },
    orderBy: [
      { column: 'createdAt', dir: 'desc' },
      { column: 'id', dir: 'asc' },
    ],
    limit: 1,
  });
  return rows[0] ?? null;
}

/** 計画値の項目（trial_programs.planned_*） */
export const PLANNED_KEYS = [
  'plannedMembers',
  'plannedSites',
  'plannedQuantitativeMetrics',
  'plannedNarrativeBlocks',
  'plannedRequirements',
  'plannedFiscalYears',
  'plannedFiles',
  'plannedApprovalLevels',
] as const;
export type PlannedKey = (typeof PLANNED_KEYS)[number];

export const PLANNED_LABELS: Readonly<Record<PlannedKey, string>> = {
  plannedMembers: '利用者（ID）',
  plannedSites: '対象拠点',
  plannedQuantitativeMetrics: '定量指標',
  plannedNarrativeBlocks: '定性情報',
  plannedRequirements: '要求事項',
  plannedFiscalYears: '年度',
  plannedFiles: '資料',
  plannedApprovalLevels: '承認段階',
};

export type ActualKey =
  | 'members'
  | 'sites'
  | 'quantitativeMetrics'
  | 'narratives'
  | 'blocks'
  | 'requirements'
  | 'fiscalYears'
  | 'files'
  | 'approvalLevels';

export interface PlanActualRow {
  key: ActualKey;
  label: string;
  /** 実績。数えられない（対象プロジェクトが未設定など）ときは null */
  actual: number | null;
  /** 計画値。計画に無い項目は null */
  planned: number | null;
  over: boolean;
  /** 何を数えたか（1 行） */
  hint: string;
}

export interface SelectedRequirementView {
  id: Uuid;
  code: string;
  title: string;
  frameworkLabel: string;
  isSample: boolean;
  /** 対象プロジェクトの基準に無い（プロジェクトを変えた・版を外した） */
  outsideProject: boolean;
}

export interface TrialOverview {
  program: TrialProgram | null;
  project: DisclosureProject | null;
  includedUnits: OrganizationUnit[];
  rows: PlanActualRow[];
  overages: PlanActualRow[];
  cdp: { state: CdpOptionState; planned: boolean | null; differs: boolean };
  selectedRequirements: SelectedRequirementView[];
  selectedMetrics: Array<{ id: Uuid; name: string; hasData: boolean }>;
  reductionTarget: ReductionTarget | null;
  /** 算定の検証範囲・将来の展開対象・無償の範囲と別途協議・返却／削除の日付（計画が無ければ null） */
  scope: TrialScopeOverview | null;
}

/** 拠点の名前と国（国内／海外は組織の国コードと比べる） */
export interface TrialSiteView {
  id: Uuid;
  name: string;
  countryCode: string;
  domestic: boolean;
}

export interface TrialScopeOverview {
  options: TrialOptions;
  verification: {
    /** 算定の検証範囲（options.ghgVerification）を設定しているか */
    configured: boolean;
    /** 算定の検証期間（未設定・組織に無い期間は null） */
    period: ReportingPeriod | null;
    sites: TrialSiteView[];
    /** 算定の検証拠点が空で、計画の対象拠点を使っている（plan K9） */
    fromIncludedUnits: boolean;
    domestic: number;
    overseas: number;
    scopes: GhgScope[];
    activityKinds: GhgActivityKind[];
    /** 拠点ごとの検証の状況（期間と拠点が揃っているときだけ。算定の概要と同じ関数） */
    status: GhgVerificationStatus | null;
  };
  rollout: {
    totalSites: number | null;
    note: string;
    /** 検証対象の拠点数（算定の検証拠点） */
    verifying: number;
    /** 残り（総拠点数 − 検証対象。総拠点数が未設定なら null） */
    remaining: number | null;
  };
  freeScope: TrialScopeSignals & { agreement: TrialAgreement | null };
  disposal: {
    /** 返却・削除の予定日 */
    plannedOn: IsoDate | null;
    /** データ取扱条件の最新の版のバックアップの残存期間（未合意は null） */
    backupResidualDays: number | null;
    /** バックアップから消える見込み日（予定日 + 残存期間。どちらかが無ければ null） */
    purgeDueOn: IsoDate | null;
  };
}

export interface TrialScopeSignals {
  signals: ScopeSignal[];
  /** 目安を超えた（別途協議の候補の）区分 */
  over: ScopeSignal[];
  /** 区分の無い別途協議の件数（どの区分にも数えない） */
  unclassifiedSeparate: number;
}

/**
 * 無償の範囲と別途協議の 4 区分の信号（読むだけ・保存しない。自組織の行だけを数える）。
 * トライアル概要と検証結果の XLSX が同じ関数を使う。
 *
 *  - 拠点: トライアルの拠点（計画の対象拠点と算定の検証拠点の和）と計画の対象拠点数、対象プロジェクトの期間に
 *    データがあるトライアルの拠点の外の拠点（サプライヤーを除く）
 *  - PDF: トライアルの期間（開始日〜終了日。未設定の端は区切らない）に取込に使った PDF・資料として登録した PDF。
 *    文字を取れない PDF（needs_ocr）は 1 件でも標準機能の外
 *  - 改善管理表: 費用区分が別途協議の件数（区分ごと）
 */
export async function loadTrialScopeSignals(
  db: DbClient,
  ctx: AuthorizationContext,
  program: TrialProgram | null,
): Promise<TrialScopeSignals> {
  assertTrialReader(ctx);
  const organizationId = ctx.workspace.organizationId;
  const options = parseTrialOptions(program?.options);
  const project =
    program?.projectId && isUuid(program.projectId)
      ? ((
          await db.select('disclosureProjects', {
            where: { id: program.projectId, organizationId, deletedAt: { isNull: true } },
            limit: 1,
          })
        )[0] ?? null)
      : null;
  const [units, ingestionFiles, files, feedback] = await Promise.all([
    db.select('units', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('ingestionJobFiles', { where: { organizationId } }),
    db.select('files', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('trialFeedbackItems', {
      where: { organizationId, deletedAt: { isNull: true }, costClass: 'separate_estimate' },
    }),
  ]);

  // トライアルの拠点（全社なら null。全社のときは外の拠点が無い）
  const included = program?.includedUnitIds ?? [];
  const trialSiteIds =
    included.length === 0
      ? null
      : new Set([...included, ...verificationUnitIds(options, included)]);
  const supplier = new Set(units.filter((u) => u.unitType === 'supplier').map((u) => u.id));
  const live = new Set(units.map((u) => u.id));
  let outsideRows = 0;
  const outsideUnits = new Set<Uuid>();
  if (trialSiteIds && project) {
    const points = await db.select('dataPoints', {
      where: {
        organizationId,
        reportingPeriodId: project.reportingPeriodId,
        deletedAt: { isNull: true },
      },
    });
    for (const point of points) {
      if (!hasValue(point) || trialSiteIds.has(point.unitId)) continue;
      if (supplier.has(point.unitId) || !live.has(point.unitId)) continue;
      outsideRows += 1;
      outsideUnits.add(point.unitId);
    }
  }

  const startsOn = program?.startsOn ?? null;
  const endsOn = program?.endsOn ?? null;
  const inPeriod = (createdAt: string) => {
    const date = toJstDate(createdAt);
    return (startsOn === null || date >= startsOn) && (endsOn === null || date <= endsOn);
  };
  const pdfIngestion = ingestionFiles.filter((f) => isPdf(f) && inPeriod(f.createdAt));
  const pdfRegistered = files.filter((f) => isPdf(f) && inPeriod(f.createdAt));
  const periodLabel =
    startsOn === null && endsOn === null
      ? '全期間（トライアルの期間が未設定）'
      : `トライアルの期間 ${startsOn ?? '未設定'}〜${endsOn ?? '未設定'}`;

  const byKind = Object.fromEntries(TRIAL_SCOPE_KINDS.map((k) => [k, 0])) as Record<
    TrialScopeKind,
    number
  >;
  let unclassified = 0;
  for (const item of feedback) {
    if (item.scopeKind) byKind[item.scopeKind] += 1;
    else unclassified += 1;
  }

  const signals = scopeSignals({
    sites: {
      trialSites: trialSiteIds ? trialSiteIds.size : null,
      plannedSites: program?.plannedSites ?? null,
      outsideUnits: outsideUnits.size,
      outsideRows,
    },
    pdf: {
      ingestionPdf: pdfIngestion.length,
      needsOcr: pdfIngestion.filter((f) => f.parseStatus === 'needs_ocr').length,
      registeredPdf: pdfRegistered.length,
      threshold: options.freeScope?.pdfFiles ?? null,
      periodLabel,
    },
    feedback: { byKind, unclassified },
  });
  return {
    signals,
    over: signals.filter((s) => s.state === 'over'),
    unclassifiedSeparate: unclassified,
  };
}

/** 算定の検証範囲・将来の展開対象・無償の範囲・返却／削除の日付（トライアル概要。読むだけ） */
async function loadTrialScopeOverview(
  db: DbClient,
  ctx: AuthorizationContext,
  program: TrialProgram,
  units: readonly OrganizationUnit[],
): Promise<TrialScopeOverview> {
  const organizationId = ctx.workspace.organizationId;
  const options = parseTrialOptions(program.options);
  const [organization, periods, terms, signals] = await Promise.all([
    db.findById('organizations', organizationId),
    db.select('periods', { where: { organizationId } }),
    db.select('organizationDataTerms', {
      where: { organizationId },
      orderBy: { column: 'versionNo', dir: 'desc' },
      limit: 1,
    }),
    loadTrialScopeSignals(db, ctx, program),
  ]);
  const homeCountry = (organization?.countryCode ?? '').toUpperCase();
  const siteIds = verificationUnitIds(options, program.includedUnitIds);
  const sites: TrialSiteView[] = siteIds.flatMap((id) => {
    const unit = units.find((u) => u.id === id);
    return unit
      ? [
          {
            id,
            name: unit.name,
            countryCode: unit.countryCode,
            domestic: homeCountry !== '' && unit.countryCode.toUpperCase() === homeCountry,
          },
        ]
      : [];
  });
  const ghg = options.ghgVerification;
  const period = ghg?.periodId ? (periods.find((p) => p.id === ghg.periodId) ?? null) : null;
  const status =
    period && sites.length > 0
      ? await loadGhgVerificationStatus(db, ctx, {
          periodId: period.id,
          unitIds: sites.map((s) => s.id),
        })
      : null;
  const totalSites = options.rollout?.totalSites ?? null;
  const backupResidualDays = terms[0]?.backupResidualDays ?? null;
  const plannedOn = options.disposal?.plannedOn ?? null;
  return {
    options,
    verification: {
      configured: ghg !== null,
      period,
      sites,
      fromIncludedUnits: (ghg?.unitIds.length ?? 0) === 0,
      domestic: sites.filter((s) => s.domestic).length,
      overseas: sites.filter((s) => !s.domestic).length,
      scopes: ghg?.scopes ?? [],
      activityKinds: ghg?.activityKinds ?? [],
      status,
    },
    rollout: {
      totalSites,
      note: options.rollout?.note ?? '',
      verifying: sites.length,
      remaining: totalSites === null ? null : Math.max(0, totalSites - sites.length),
    },
    freeScope: { ...signals, agreement: program.agreements.freeScope ?? null },
    disposal: {
      plannedOn,
      backupResidualDays,
      purgeDueOn: backupPurgeDueOn(plannedOn, backupResidualDays),
    },
  };
}

function hasValue(point: { value: number | null; textValue: string | null }): boolean {
  return point.value !== null || (point.textValue !== null && point.textValue !== '');
}

function namesOf(names: readonly string[], max = 3): string {
  if (names.length <= max) return names.join('・');
  return `${names.slice(0, max).join('・')} ほか ${names.length - max}`;
}

/**
 * 概要: 計画値と実績を分母付きで並べる。実績は既存の表の件数（他組織の行は数えない）
 * now は「直近 30 日」の基準（テスト用）
 */
export async function loadTrialOverview(
  db: DbClient,
  ctx: AuthorizationContext,
  now: Date = new Date(),
): Promise<TrialOverview> {
  assertTrialReader(ctx);
  const organizationId = ctx.workspace.organizationId;
  const program = await loadTrialProgram(db, ctx);

  const [memberships, allUnits, cdp] = await Promise.all([
    db.select('memberships', { where: { organizationId, status: 'active' } }),
    db.select('units', { where: { organizationId, deletedAt: { isNull: true } } }),
    cdpOptionState(db, ctx),
  ]);
  const project =
    program?.projectId && isUuid(program.projectId)
      ? ((
          await db.select('disclosureProjects', {
            where: { id: program.projectId, organizationId, deletedAt: { isNull: true } },
            limit: 1,
          })
        )[0] ?? null)
      : null;

  const includedUnits = program
    ? allUnits.filter((u) => program.includedUnitIds.includes(u.id))
    : [];
  const unitFilter = includedUnits.length > 0 ? new Set(includedUnits.map((u) => u.id)) : null;
  const periodId = project?.reportingPeriodId ?? null;

  // 期間にデータのある指標・年度（拠点を指定していれば、その拠点のデータだけ）
  // 拠点を指定していれば DB 側でも絞る（読む行を減らす。数え方は下の filter と同じ）
  const dataPoints = await db.select('dataPoints', {
    where: {
      organizationId,
      deletedAt: { isNull: true },
      ...(unitFilter ? { unitId: { in: [...unitFilter] } } : {}),
    },
  });
  const inScope = dataPoints.filter(
    (d) => hasValue(d) && (unitFilter === null || unitFilter.has(d.unitId)),
  );
  const metricsWithData = periodId
    ? new Set(inScope.filter((d) => d.reportingPeriodId === periodId).map((d) => d.metricId))
    : null;
  const periodsWithData = new Set(inScope.map((d) => d.reportingPeriodId));
  const periods =
    periodsWithData.size > 0
      ? await db.select('periods', { where: { organizationId, id: { in: [...periodsWithData] } } })
      : [];

  const [blocks, narrativeVersions, files, routes, links, frameworks] = await Promise.all([
    project
      ? db.select('disclosureBlocks', {
          where: { organizationId, projectId: project.id, deletedAt: { isNull: true } },
        })
      : Promise.resolve([]),
    periodId
      ? db.select('narrativeVersions', { where: { organizationId, reportingPeriodId: periodId } })
      : Promise.resolve([]),
    periodId
      ? db.select('files', { where: { organizationId, deletedAt: { isNull: true } } })
      : Promise.resolve([]),
    db.select('approvalRoutes', { where: { organizationId, isDefault: true } }),
    db.select('narrativeRequirementLinks', {
      where: { organizationId, deletedAt: { isNull: true } },
    }),
    project
      ? db.select('projectFrameworks', { where: { organizationId, projectId: project.id } })
      : Promise.resolve([]),
  ]);
  const liveNarratives =
    narrativeVersions.length > 0
      ? await db.select('narrativeRecords', {
          where: {
            organizationId,
            deletedAt: { isNull: true },
            id: { in: [...new Set(narrativeVersions.map((v) => v.narrativeRecordId))] },
          },
        })
      : [];
  const projectVersionIds = new Set(frameworks.map((f) => f.frameworkVersionId));
  const requirementIds = new Set<Uuid>(blocks.flatMap((b) => b.requirementItemIds));
  for (const link of links) {
    if (projectVersionIds.has(link.frameworkVersionId)) requirementIds.add(link.itemId);
  }
  const defaultRoute = routes.find((r) => r.purpose === 'default') ?? routes[0] ?? null;
  const stages = defaultRoute
    ? await db.select('approvalRouteStages', {
        where: { organizationId, routeId: defaultRoute.id, deletedAt: { isNull: true } },
      })
    : [];
  const periodFiles = periodId ? files.filter((f) => f.reportingPeriodId === periodId) : [];
  const undatedFiles = periodId ? files.filter((f) => f.reportingPeriodId === null).length : 0;

  // 直近 30 日に操作した人（合計だけ。個人ごとの記録は監査ログを読める人だけ。§5 D13）
  let recentActive: number | null = null;
  if (can(ctx, 'common.audit.read')) {
    const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    const events = await db.select('auditEvents', {
      where: { actorOrganizationId: organizationId, createdAt: { gte: since } },
    });
    const active = new Set(memberships.map((m) => m.userId));
    recentActive = new Set(
      events.map((e) => e.actorUserId).filter((id): id is Uuid => id !== null && active.has(id)),
    ).size;
  }

  const planned = (key: PlannedKey): number | null => (program ? program[key] : null);
  const noProject = '対象プロジェクトを設定すると数えます';
  const selectedMetricIds = program?.selectedMetricIds ?? [];
  // 将来の展開対象の総拠点数（検証対象を含む全体の数。plan CR-21）は対象拠点のタイルの補足に添える
  const rolloutTotal = program
    ? (parseTrialOptions(program.options).rollout?.totalSites ?? null)
    : null;
  const rolloutHint = rolloutTotal === null ? '' : `・展開対象 全 ${rolloutTotal}`;
  const base: PlanActualRow[] = [
    {
      key: 'members',
      label: '有効メンバー',
      actual: memberships.length,
      planned: planned('plannedMembers'),
      over: false,
      hint:
        recentActive === null
          ? '有効なメンバー（停止中・招待中を除く）'
          : `直近 30 日に操作した人 ${recentActive}（監査ログから。合計のみ）`,
    },
    {
      key: 'sites',
      label: '対象拠点',
      actual: includedUnits.length > 0 ? includedUnits.length : null,
      planned: planned('plannedSites'),
      over: false,
      hint:
        (includedUnits.length > 0
          ? namesOf(includedUnits.map((u) => u.name))
          : '拠点を指定していません（全社）') + rolloutHint,
    },
    {
      key: 'quantitativeMetrics',
      label: '定量指標（期間にデータあり）',
      actual: metricsWithData ? metricsWithData.size : null,
      planned: planned('plannedQuantitativeMetrics'),
      over: false,
      hint: metricsWithData
        ? `選定 ${selectedMetricIds.length} 指標のうちデータあり ${
            selectedMetricIds.filter((id) => metricsWithData.has(id)).length
          }`
        : noProject,
    },
    {
      key: 'narratives',
      label: '定性情報',
      actual: periodId ? liveNarratives.length : null,
      planned: planned('plannedNarrativeBlocks'),
      over: false,
      hint: periodId ? '対象期間の版がある定性情報' : noProject,
    },
    {
      key: 'blocks',
      label: '原稿の節',
      actual: project ? blocks.length : null,
      planned: null,
      over: false,
      hint: project ? '対象プロジェクトの節（計画値はありません）' : noProject,
    },
    {
      key: 'requirements',
      label: '対応付けた要求事項',
      actual: project ? requirementIds.size : null,
      planned: planned('plannedRequirements'),
      over: false,
      hint: project
        ? `節・定性情報に対応付けた要求事項（選定ケース ${program?.selectedRequirementItemIds.length ?? 0} 件）`
        : noProject,
    },
    {
      key: 'fiscalYears',
      label: '年度（データのある期間）',
      actual: periodsWithData.size,
      planned: planned('plannedFiscalYears'),
      over: false,
      hint:
        periods.length > 0
          ? periods
              .map((p) => p.code)
              .sort()
              .join('・')
          : 'データのある期間はありません',
    },
    {
      key: 'files',
      label: '資料（対象期間）',
      actual: periodId ? periodFiles.length : null,
      planned: planned('plannedFiles'),
      over: false,
      hint: periodId
        ? undatedFiles > 0
          ? `期間を指定していない資料 ${undatedFiles} 件は数えていません`
          : '対象期間を指定した資料'
        : noProject,
    },
    {
      key: 'approvalLevels',
      label: '承認段階（既定のルート）',
      actual: defaultRoute ? stages.length : null,
      planned: planned('plannedApprovalLevels'),
      over: false,
      hint: defaultRoute ? defaultRoute.name : '既定の承認ルートがありません',
    },
  ];
  const rows = base.map((row) => ({
    ...row,
    over: row.actual !== null && row.planned !== null && row.actual > row.planned,
  }));

  // 選定ケース（要求事項）の表示
  const selectedIds = program?.selectedRequirementItemIds ?? [];
  const items =
    selectedIds.length > 0
      ? await db.select('disclosureItems', { where: { id: { in: selectedIds } } })
      : [];
  const versionIds = [...new Set(items.map((i) => i.frameworkVersionId))];
  const versions =
    versionIds.length > 0
      ? await db.select('frameworkVersions', { where: { id: { in: versionIds } } })
      : [];
  const selectedRequirements: SelectedRequirementView[] = selectedIds.flatMap((id) => {
    const item = items.find((i) => i.id === id);
    if (!item) return [];
    const version = versions.find((v) => v.id === item.frameworkVersionId);
    return [
      {
        id,
        code: item.code,
        title: item.questionText,
        frameworkLabel: version?.label ?? '基準',
        isSample: version?.legalStatus === 'sample',
        outsideProject: !projectVersionIds.has(item.frameworkVersionId),
      },
    ];
  });

  const metrics =
    selectedMetricIds.length > 0
      ? await db.select('metrics', { where: { organizationId, id: { in: selectedMetricIds } } })
      : [];
  const selectedMetrics = selectedMetricIds.flatMap((id) => {
    const metric = metrics.find((m) => m.id === id);
    return metric ? [{ id, name: metric.name, hasData: metricsWithData?.has(id) ?? false }] : [];
  });

  const cdpPlanned =
    program && typeof program.options.cdp === 'boolean' ? (program.options.cdp as boolean) : null;

  return {
    program,
    project,
    includedUnits,
    rows,
    overages: rows.filter((r) => r.over),
    cdp: {
      state: cdp.state,
      planned: cdpPlanned,
      differs: cdpPlanned !== null && cdpPlanned !== (cdp.state === 'contracted'),
    },
    selectedRequirements,
    selectedMetrics,
    reductionTarget: program ? reductionTargetOf(program.options) : null,
    scope: program ? await loadTrialScopeOverview(db, ctx, program, allUnits) : null,
  };
}

// ----------------------------------------------------------------------
// 編集の選択肢
// ----------------------------------------------------------------------

export interface TrialFormChoices {
  projects: Array<{ id: Uuid; name: string }>;
  /** 拠点（サプライヤーを除く。既に選んだものは残す）。国コードは算定の検証拠点の選択に添える */
  units: Array<{ id: Uuid; name: string; countryCode: string }>;
  /** 算定の検証期間の候補（組織の報告期間。コードの降順） */
  periods: Array<{ id: Uuid; code: string; label: string }>;
  /** 対象プロジェクトの基準の要求事項（選定ケースの候補） */
  frameworks: Array<{
    versionId: Uuid;
    label: string;
    isSample: boolean;
    items: Array<{ id: Uuid; code: string; title: string }>;
  }>;
  metrics: Array<{ id: Uuid; code: string; name: string }>;
}

export async function loadTrialFormChoices(
  db: DbClient,
  ctx: AuthorizationContext,
  program: TrialProgram | null,
): Promise<TrialFormChoices> {
  assertTrialReader(ctx);
  const organizationId = ctx.workspace.organizationId;
  const [projects, units, metrics, periods] = await Promise.all([
    db.select('disclosureProjects', {
      where: { organizationId, deletedAt: { isNull: true } },
      orderBy: { column: 'createdAt', dir: 'desc' },
    }),
    db.select('units', {
      where: { organizationId, deletedAt: { isNull: true } },
      orderBy: { column: 'sortOrder' },
    }),
    db.select('metrics', {
      where: { organizationId, deletedAt: { isNull: true } },
      orderBy: { column: 'code' },
    }),
    db.select('periods', {
      where: { organizationId },
      orderBy: { column: 'code', dir: 'desc' },
    }),
  ]);
  const selectedUnits = new Set([
    ...(program?.includedUnitIds ?? []),
    ...(program ? (parseTrialOptions(program.options).ghgVerification?.unitIds ?? []) : []),
  ]);
  const projectId = program?.projectId ?? null;
  const projectFrameworks = projectId
    ? await db.select('projectFrameworks', { where: { organizationId, projectId } })
    : [];
  const versionIds = projectFrameworks.map((f) => f.frameworkVersionId);
  const [versions, items] =
    versionIds.length > 0
      ? await Promise.all([
          db.select('frameworkVersions', { where: { id: { in: versionIds } } }),
          db.select('disclosureItems', {
            where: { frameworkVersionId: { in: versionIds } },
            orderBy: { column: 'sortOrder' },
          }),
        ])
      : [[], []];
  return {
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    units: units
      .filter((u) => u.unitType !== 'supplier' || selectedUnits.has(u.id))
      .map((u) => ({ id: u.id, name: u.name, countryCode: u.countryCode })),
    periods: periods.map((p) => ({ id: p.id, code: p.code, label: p.label })),
    frameworks: versionIds.flatMap((versionId) => {
      const version = versions.find((v) => v.id === versionId);
      if (!version) return [];
      return [
        {
          versionId,
          label: version.label,
          isSample: version.legalStatus === 'sample',
          items: items
            .filter((i) => i.frameworkVersionId === versionId)
            .map((i) => ({ id: i.id, code: i.code, title: i.questionText })),
        },
      ];
    }),
    metrics: metrics.map((m) => ({ id: m.id, code: m.code, name: m.name })),
  };
}

// ----------------------------------------------------------------------
// 保存
// ----------------------------------------------------------------------

export interface TrialProgramPatch {
  name?: string;
  phase?: string;
  startsOn?: string | null;
  endsOn?: string | null;
  projectId?: string | null;
  includedUnitIds?: string[];
  targetDataNote?: string;
  planned?: Partial<Record<PlannedKey, number | null>>;
  /** CDP オプションを計画に含めるか（options.cdp） */
  cdpPlanned?: boolean | null;
  /** 作業時間の短縮の目標（options.reductionTarget。合意した値を人が入れる） */
  reductionTarget?: ReductionTarget | null;
  /**
   * 算定の検証範囲（options.ghgVerification。期間・算定の検証拠点・Scope・活動）。null は外す。
   * 拠点が空なら計画の対象拠点を使う（plan K9）
   */
  ghgVerification?: GhgVerificationOptions | null;
  /** 将来の展開対象（options.rollout。総拠点数は検証対象を含む全体の数）。null は外す */
  rollout?: RolloutOptions | null;
  /** 無償の範囲の目安（options.freeScope。PDF 等の一次データの件数）。null は外す */
  freeScope?: FreeScopeOptions | null;
  /** 返却・削除の予定日（options.disposal）。null は外す */
  disposal?: DisposalOptions | null;
  selectedRequirementItemIds?: string[];
  selectedMetricIds?: string[];
  agreements?: Partial<Record<TrialAgreementKey, { agreedOn: string | null; note: string }>>;
  endDisposition?: string;
  endAgreedOn?: string | null;
  decision?: string;
  decisionConditions?: string;
  decidedByLabel?: string;
}

const MAX_SELECTION = 200;
const MAX_PLANNED = 100_000;

function uniqueIds(ids: readonly string[], label: string): Uuid[] {
  const unique = [...new Set(ids.map((id) => id.trim()).filter((id) => id !== ''))];
  if (unique.length > MAX_SELECTION) {
    throw new ValidationError(`${label}は ${MAX_SELECTION} 件までにしてください。`);
  }
  if (!unique.every(isUuid)) throw new ValidationError(`${label}の指定が正しくありません。`);
  return unique;
}

export interface SaveTrialProgramResult {
  program: TrialProgram;
  created: boolean;
}

/** options の中で、このサービスが形を検査して書くキー（plan K9。既存のキー cdp・reductionTarget は別に扱う） */
const TRIAL_OPTION_KEYS = ['ghgVerification', 'rollout', 'freeScope', 'disposal'] as const;
type TrialOptionKey = (typeof TRIAL_OPTION_KEYS)[number];

/** 入力を正規化する（前後の空白・空の項目。全部空なら null＝キーを外す） */
function normalizedOption(
  key: TrialOptionKey,
  value: TrialProgramPatch[TrialOptionKey],
): TrialOptions[TrialOptionKey] {
  if (value === null || value === undefined) return null;
  switch (key) {
    case 'ghgVerification': {
      const v = value as GhgVerificationOptions;
      const periodId = (v.periodId ?? '').trim() || null;
      const unitIds = v.unitIds.map((id) => id.trim()).filter((id) => id !== '');
      const empty =
        periodId === null &&
        unitIds.length === 0 &&
        v.scopes.length === 0 &&
        v.activityKinds.length === 0;
      return empty
        ? null
        : { periodId, unitIds, scopes: [...v.scopes], activityKinds: [...v.activityKinds] };
    }
    case 'rollout': {
      const v = value as RolloutOptions;
      const note = (v.note ?? '').trim();
      return v.totalSites === null && note === '' ? null : { totalSites: v.totalSites, note };
    }
    case 'freeScope': {
      const v = value as FreeScopeOptions;
      return v.pdfFiles === null ? null : { pdfFiles: v.pdfFiles };
    }
    case 'disposal': {
      const v = value as DisposalOptions;
      const plannedOn = checkedDate(v.plannedOn, '返却・削除の予定日');
      return plannedOn === null ? null : { plannedOn };
    }
  }
}

/**
 * options の検証範囲・展開対象・目安・予定日を検査して書き戻す（既存のキーは残す）。
 * 期間・拠点は組織のもの（サプライヤーを除く）、展開対象の総拠点数は検証対象の拠点数以上
 * （展開対象は検証対象を含む全体の数）、メモは Demo で 100 字、PDF の目安は 0〜100,000
 */
async function applyTrialOptions(
  db: DbClient,
  ctx: AuthorizationContext,
  options: Record<string, unknown>,
  patch: TrialProgramPatch,
  keys: readonly TrialOptionKey[],
  context: { includedUnitIds: readonly Uuid[]; textLimitDemo: boolean },
): Promise<void> {
  const organizationId = ctx.workspace.organizationId;
  const before = parseTrialOptions(options);
  const touched: Partial<Record<TrialOptionKey, TrialOptions[TrialOptionKey]>> = {};
  for (const key of keys) touched[key] = normalizedOption(key, patch[key]);
  // 検査は入力そのもの（読み直すと知らない値が落ちて素通りするため）。触っていないキーは保存済みの形
  const ghg = (
    keys.includes('ghgVerification') ? touched.ghgVerification : before.ghgVerification
  ) as GhgVerificationOptions | null;
  const rollout = (
    keys.includes('rollout') ? touched.rollout : before.rollout
  ) as RolloutOptions | null;
  const check: Partial<TrialOptions> = {};
  if (keys.includes('ghgVerification') && ghg) check.ghgVerification = ghg;
  // 検証拠点の数が変わりうるときは、触っていない展開対象も検査する
  if (
    rollout &&
    (keys.includes('rollout') ||
      keys.includes('ghgVerification') ||
      patch.includedUnitIds !== undefined)
  ) {
    check.rollout = rollout;
  }
  if (keys.includes('freeScope') && touched.freeScope) {
    check.freeScope = touched.freeScope as FreeScopeOptions;
  }
  if (keys.includes('disposal') && touched.disposal) {
    check.disposal = touched.disposal as DisposalOptions;
  }
  if (Object.keys(check).length > 0) {
    const [periods, units] = await Promise.all([
      db.select('periods', { where: { organizationId } }),
      db.select('units', { where: { organizationId, deletedAt: { isNull: true } } }),
    ]);
    const errors = validateTrialOptionsPatch(check, {
      organizationPeriodIds: new Set(periods.map((p) => p.id)),
      organizationUnitIds: new Set(units.filter((u) => u.unitType !== 'supplier').map((u) => u.id)),
      includedUnitIds: verificationUnitIds(
        { ...before, ghgVerification: ghg },
        context.includedUnitIds,
      ),
      demo: context.textLimitDemo,
    });
    if (errors.length > 0) throw new ValidationError(errors.join(' '));
  }
  for (const key of keys) {
    const value = touched[key];
    if (value === null || value === undefined) delete options[key];
    else options[key] = value;
  }
}

/**
 * 計画を保存する（無ければ作る）。渡した項目だけを検査して変える。enterprise.org.manage のみ。
 * 監査ログ settings_changed（resource_type trial_program）
 */
export async function saveTrialProgram(
  db: DbClient,
  ctx: AuthorizationContext,
  patch: TrialProgramPatch,
): Promise<SaveTrialProgramResult> {
  assertTrialManager(ctx);
  const organizationId = ctx.workspace.organizationId;
  const limits = trialTextLimits(db, ctx);
  const existing = await loadTrialProgram(db, ctx);
  const next: Partial<TrialProgram> = {};

  if (patch.name !== undefined) {
    next.name = checkedText(patch.name, '計画の名前', limits.title, { required: true });
  }
  if (patch.phase !== undefined) {
    next.phase = oneOf<TrialPhase>(TRIAL_PHASES, patch.phase, '段階');
  }
  if (patch.startsOn !== undefined) next.startsOn = checkedDate(patch.startsOn, '開始日');
  if (patch.endsOn !== undefined) next.endsOn = checkedDate(patch.endsOn, '終了日');
  if (patch.targetDataNote !== undefined) {
    next.targetDataNote = checkedText(patch.targetDataNote, '対象データの説明', limits.text);
  }
  if (patch.projectId !== undefined) {
    const projectId = (patch.projectId ?? '').trim();
    if (projectId === '') {
      next.projectId = null;
    } else {
      const project = isUuid(projectId)
        ? await db.select('disclosureProjects', {
            where: { id: projectId, organizationId, deletedAt: { isNull: true } },
            limit: 1,
          })
        : [];
      if (project.length === 0) throw new NotFoundError('対象プロジェクトが見つかりません。');
      next.projectId = projectId;
    }
  }
  if (patch.includedUnitIds !== undefined) {
    const ids = uniqueIds(patch.includedUnitIds, '対象拠点');
    if (ids.length > 0) {
      const units = await db.select('units', {
        where: { organizationId, id: { in: ids }, deletedAt: { isNull: true } },
      });
      if (units.length !== ids.length) throw new NotFoundError('対象拠点が見つかりません。');
    }
    next.includedUnitIds = ids;
  }
  if (patch.planned) {
    for (const key of PLANNED_KEYS) {
      if (!(key in patch.planned)) continue;
      const value = patch.planned[key];
      if (value === null || value === undefined) {
        next[key] = null;
        continue;
      }
      if (!Number.isInteger(value) || value < 0 || value > MAX_PLANNED) {
        throw new ValidationError(
          `${PLANNED_LABELS[key]}の計画値は 0〜${MAX_PLANNED.toLocaleString('ja-JP')} の整数で入力してください。`,
        );
      }
      next[key] = value;
    }
  }
  const optionKeys = TRIAL_OPTION_KEYS.filter((key) => patch[key] !== undefined);
  if (
    patch.cdpPlanned !== undefined ||
    patch.reductionTarget !== undefined ||
    optionKeys.length > 0
  ) {
    const options: Record<string, unknown> = { ...(existing?.options ?? {}) };
    if (optionKeys.length > 0) {
      await applyTrialOptions(db, ctx, options, patch, optionKeys, {
        includedUnitIds: next.includedUnitIds ?? existing?.includedUnitIds ?? [],
        textLimitDemo: db.mode === 'demo' || ctx.demo,
      });
    }
    if (patch.cdpPlanned !== undefined) {
      if (patch.cdpPlanned === null) delete options.cdp;
      else options.cdp = patch.cdpPlanned;
    }
    if (patch.reductionTarget !== undefined) {
      if (patch.reductionTarget === null) {
        delete options.reductionTarget;
      } else {
        const target = reductionTargetOf({ reductionTarget: patch.reductionTarget });
        if (!target) {
          throw new ValidationError(
            '短縮の目標は 0〜100 の数値で、下限を上限以下にして入力してください。',
          );
        }
        options.reductionTarget = target;
      }
    }
    next.options = options;
  }

  const projectId = next.projectId !== undefined ? next.projectId : (existing?.projectId ?? null);
  if (patch.selectedRequirementItemIds !== undefined) {
    const ids = uniqueIds(patch.selectedRequirementItemIds, '選定ケース');
    if (ids.length > 0) {
      if (!projectId) {
        throw new ValidationError('選定ケースを選ぶ前に、対象プロジェクトを設定してください。');
      }
      const frameworks = await db.select('projectFrameworks', {
        where: { organizationId, projectId },
      });
      const versionIds = new Set(frameworks.map((f) => f.frameworkVersionId));
      const items = await db.select('disclosureItems', { where: { id: { in: ids } } });
      if (
        items.length !== ids.length ||
        !items.every((item) => versionIds.has(item.frameworkVersionId))
      ) {
        throw new ValidationError('対象プロジェクトの基準に無い要求事項は選定ケースにできません。');
      }
    }
    next.selectedRequirementItemIds = ids;
  }
  if (patch.selectedMetricIds !== undefined) {
    const ids = uniqueIds(patch.selectedMetricIds, '選定する指標');
    if (ids.length > 0) {
      const metrics = await db.select('metrics', {
        where: { organizationId, id: { in: ids }, deletedAt: { isNull: true } },
      });
      if (metrics.length !== ids.length) throw new NotFoundError('指標が見つかりません。');
    }
    next.selectedMetricIds = ids;
  }
  if (patch.agreements !== undefined) {
    const agreements: Partial<Record<TrialAgreementKey, TrialAgreement>> = {
      ...(existing?.agreements ?? {}),
    };
    for (const key of TRIAL_AGREEMENT_KEYS) {
      const entry = patch.agreements[key];
      if (!entry) continue;
      const agreedOn = checkedDate(entry.agreedOn, '合意日');
      const note = checkedText(entry.note, '合意のメモ', limits.agreementNote);
      if (agreedOn === null && note === '') delete agreements[key];
      else agreements[key] = { agreedOn, note };
    }
    next.agreements = agreements;
  }
  if (patch.endDisposition !== undefined) {
    next.endDisposition = oneOf<TrialEndDisposition>(
      TRIAL_END_DISPOSITIONS,
      patch.endDisposition,
      '終了時の扱い',
    );
  }
  if (patch.endAgreedOn !== undefined) {
    next.endAgreedOn = checkedDate(patch.endAgreedOn, '終了時の扱いの合意日');
  }
  if (patch.decision !== undefined) {
    next.decision = oneOf<TrialDecision>(TRIAL_DECISIONS, patch.decision, '導入判断');
  }
  if (patch.decisionConditions !== undefined) {
    next.decisionConditions = checkedText(patch.decisionConditions, '条件', limits.text);
  }
  if (patch.decidedByLabel !== undefined) {
    next.decidedByLabel = checkedText(patch.decidedByLabel, '判断者', limits.title);
  }

  const startsOn = next.startsOn !== undefined ? next.startsOn : (existing?.startsOn ?? null);
  const endsOn = next.endsOn !== undefined ? next.endsOn : (existing?.endsOn ?? null);
  if (startsOn && endsOn && startsOn > endsOn) {
    throw new ValidationError('終了日は開始日以降にしてください。');
  }
  const decision = next.decision ?? existing?.decision ?? 'undecided';
  const conditions = next.decisionConditions ?? existing?.decisionConditions ?? '';
  if (decision === 'conditional' && conditions === '') {
    throw new ValidationError('条件付き導入では、条件を入力してください。');
  }

  const now = new Date().toISOString();
  if (!existing) {
    if (!next.name) throw new ValidationError('計画の名前を入力してください。');
    const row: TrialProgram = {
      id: randomUUID(),
      organizationId,
      name: next.name,
      startsOn: next.startsOn ?? null,
      endsOn: next.endsOn ?? null,
      phase: next.phase ?? 'setup',
      projectId: next.projectId ?? null,
      includedUnitIds: next.includedUnitIds ?? [],
      targetDataNote: next.targetDataNote ?? '',
      selectedRequirementItemIds: next.selectedRequirementItemIds ?? [],
      selectedMetricIds: next.selectedMetricIds ?? [],
      plannedMembers: next.plannedMembers ?? null,
      plannedSites: next.plannedSites ?? null,
      plannedQuantitativeMetrics: next.plannedQuantitativeMetrics ?? null,
      plannedNarrativeBlocks: next.plannedNarrativeBlocks ?? null,
      plannedRequirements: next.plannedRequirements ?? null,
      plannedFiscalYears: next.plannedFiscalYears ?? null,
      plannedFiles: next.plannedFiles ?? null,
      plannedApprovalLevels: next.plannedApprovalLevels ?? null,
      options: next.options ?? {},
      agreements: next.agreements ?? {},
      endDisposition: next.endDisposition ?? 'undecided',
      endAgreedOn: next.endAgreedOn ?? null,
      decision: next.decision ?? 'undecided',
      decisionConditions: next.decisionConditions ?? '',
      decidedByLabel: next.decidedByLabel ?? '',
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    };
    const [inserted] = await db.insert('trialPrograms', [row]);
    const program = inserted ?? row;
    await recordAuditEvent(db, ctx, {
      eventType: 'settings_changed',
      resourceType: 'trial_program',
      resourceId: program.id,
      afterSummary: `トライアルの計画を作成（${program.name}）`,
    });
    return { program, created: true };
  }

  const program = await db.update('trialPrograms', existing.id, {
    ...next,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  const changed = Object.keys(next);
  await recordAuditEvent(db, ctx, {
    eventType: 'settings_changed',
    resourceType: 'trial_program',
    resourceId: existing.id,
    beforeSummary:
      existing.decision !== program.decision
        ? `導入判断: ${TRIAL_DECISION_LABELS[existing.decision]} → ${TRIAL_DECISION_LABELS[program.decision]}`
        : null,
    afterSummary: `トライアルの計画を更新（${changed.length} 項目）`,
    metadata: { fields: changed },
  });
  return { program, created: false };
}
