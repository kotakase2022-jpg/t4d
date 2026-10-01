import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, can, NotFoundError } from '@/lib/authorization/can';
import { getReferenceDate } from '@/lib/clock';
import {
  csrdDataStateOf,
  csrdSectionOfItem,
  deriveCsrdApplicability,
  isCsrdInScope,
  type CsrdApplicability,
  type CsrdDataState,
} from '@/lib/domain/csrd';
import { ACTION_STATUS_LABEL } from '@/lib/domain/ssbj';
import { ValidationError } from '@/lib/errors/user-facing';
import { fid } from '@/lib/fixtures/ids';
import { daysUntilJst } from '@/lib/format/datetime';
import { hasUsableValue } from '@/lib/services/aggregation';
import { ensureMetricAssignment } from '@/lib/services/collection-item';
import type { DbClient } from '@/lib/repositories/types';
import {
  SSBJ_ACTION_STATUSES,
  SSBJ_ACTION_TYPES,
  SSBJ_GAP_KINDS,
  SSBJ_PRIORITIES,
  type AuthorizationContext,
  type CsrdActionPlan,
  type CsrdSection,
  type DisclosureItem,
  type ReportingPeriod,
  type SsbjActionStatus,
  type SsbjActionType,
  type SsbjGapKind,
  type SsbjPriority,
  type Uuid,
  type ValueKind,
} from '@/types/domain';
import {
  assertCsrdWrite,
  assertSameBase,
  cleanText,
  findCsrdPeriod,
  loadCsrdContext,
  type CsrdContext,
} from './core';
import {
  approvedValueKind,
  ensureCsrdAssessment,
  metricDataRows,
  type CsrdMetricDataRow,
  type CsrdReferenceDateOption,
} from './requirements';

/**
 * CSRD の対応計画とデータ収集（docs/disclosure-first.md §9.4）。
 *
 *  - 計画を立てられるのは評価対象（常に適用・重要と判断した事項）の要求事項だけ。評価行が無ければ作る
 *  - 収集項目は SSBJ と同じ共通処理（collection-item.ts）で作る。新しく作る指標の出所は CSRD
 *  - 読込関数は書かない。SSBJ の計画（ssbj_action_plans）を読まない・書かない
 */

const TITLE_MAX = 200;
const DETAIL_MAX = 1000;
const DEPARTMENT_MAX = 100;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function itemSectionApplicability(
  context: CsrdContext,
  item: DisclosureItem,
): { section: CsrdSection | null; applicability: CsrdApplicability } {
  const section = csrdSectionOfItem(item);
  const matter =
    section && section !== 'ESRS2'
      ? (context.matters.find((m) => m.topic === section)?.matter ?? null)
      : null;
  return { section, applicability: deriveCsrdApplicability(section, matter, context.dmaConfirmed) };
}

function assertDueDate(value: string | null): string | null {
  if (value === null || value === '') return null;
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new ValidationError('期限は YYYY-MM-DD の形式で入力してください。');
  }
  return value;
}

/** 担当者は自組織の有効なメンバーに限る（他社の利用者を担当にさせない） */
async function assertMember(
  db: DbClient,
  ctx: AuthorizationContext,
  userId: Uuid | null,
): Promise<Uuid | null> {
  if (!userId) return null;
  const memberships = await db.select('memberships', {
    where: { organizationId: ctx.workspace.organizationId, userId, status: 'active' },
    limit: 1,
  });
  if (memberships.length === 0) {
    throw new ValidationError('担当者はこの組織のメンバーから選んでください。');
  }
  return userId;
}

function assertOneOf<T extends string>(values: readonly T[], value: unknown, message: string): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new ValidationError(message);
  }
  return value as T;
}

// ----------------------------------------------------------------------
// 対応計画
// ----------------------------------------------------------------------

export interface CreateCsrdActionPlanInput {
  reportingPeriodId: Uuid;
  itemId: Uuid;
  gapKind: SsbjGapKind;
  title: string;
  detail: string;
  actionType: SsbjActionType;
  department: string;
  assigneeUserId: Uuid | null;
  dueDate: string | null;
  priority: SsbjPriority;
}

/** 対応計画を追加する（評価対象の要求事項のみ。評価行が無ければ作る） */
export async function createCsrdActionPlan(
  db: DbClient,
  ctx: AuthorizationContext,
  input: CreateCsrdActionPlanInput,
): Promise<CsrdActionPlan> {
  assertCsrdWrite(ctx);
  const period = await findCsrdPeriod(db, ctx, input.reportingPeriodId);
  const context = await loadCsrdContext(db, ctx, period);
  if (!context) throw new NotFoundError('CSRD の要求事項マスターが見つかりません。');
  const item = context.items.find((i) => i.id === input.itemId);
  if (!item) throw new NotFoundError('CSRD の要求事項が見つかりません。');
  const { applicability } = itemSectionApplicability(context, item);
  if (!isCsrdInScope(applicability)) {
    throw new ValidationError(
      '評価対象（常に適用・重要と判断した事項）の要求事項にだけ対応計画を立てられます。',
    );
  }
  const title = cleanText(input.title, TITLE_MAX, '対応内容');
  if (title === '') throw new ValidationError('対応内容を入力してください。');
  const gapKind = assertOneOf(SSBJ_GAP_KINDS, input.gapKind, '観点を選んでください。');
  const actionType = assertOneOf(SSBJ_ACTION_TYPES, input.actionType, '対応区分を選んでください。');
  const priority = assertOneOf(SSBJ_PRIORITIES, input.priority, '優先度を選んでください。');
  const assigneeUserId = await assertMember(db, ctx, input.assigneeUserId);
  const dueDate = assertDueDate(input.dueDate);

  const now = new Date().toISOString();
  const assessment = await ensureCsrdAssessment(db, ctx, context, item, now);
  const plan: CsrdActionPlan = {
    id: fid('csrd_action_plan', `${assessment.id}/${gapKind}/${now}`),
    organizationId: ctx.workspace.organizationId,
    reportingPeriodId: period.id,
    assessmentId: assessment.id,
    gapKind,
    title,
    detail: cleanText(input.detail, DETAIL_MAX, '詳細'),
    actionType,
    department: cleanText(input.department, DEPARTMENT_MAX, '担当部署'),
    assigneeUserId,
    dueDate,
    priority,
    status: 'not_started',
    linkedMetricCode: null,
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  };
  await db.insert('csrdActionPlans', [plan]);
  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'csrd_action_plan',
    resourceId: plan.id,
    afterSummary: `CSRD の対応計画を追加（${item.code}）: ${plan.title}`,
    metadata: { gapKind, actionType },
  });
  return plan;
}

export interface UpdateCsrdActionPlanInput {
  planId: Uuid;
  status: SsbjActionStatus;
  department: string;
  assigneeUserId: Uuid | null;
  dueDate: string | null;
  priority: SsbjPriority;
  /**
   * 画面が表示したときの計画の updatedAt。表示の後に別の操作（収集項目の作成で「対応中」へ進んだ、
   * 別のタブで更新した）で変わっていれば、古い値で上書きしないよう断る
   */
  baseUpdatedAt: string;
}

/** 対応状況・担当・期限・優先度を更新する */
export async function updateCsrdActionPlan(
  db: DbClient,
  ctx: AuthorizationContext,
  input: UpdateCsrdActionPlanInput,
): Promise<CsrdActionPlan> {
  assertCsrdWrite(ctx);
  const plan = await db.findById('csrdActionPlans', input.planId);
  if (!plan || plan.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('対応計画が見つかりません。');
  }
  assertSameBase(plan.updatedAt, input.baseUpdatedAt);
  const status = assertOneOf(SSBJ_ACTION_STATUSES, input.status, '対応状況を選んでください。');
  const priority = assertOneOf(SSBJ_PRIORITIES, input.priority, '優先度を選んでください。');
  const department = cleanText(input.department, DEPARTMENT_MAX, '担当部署');
  const updated = await db.update('csrdActionPlans', plan.id, {
    status,
    department,
    assigneeUserId: await assertMember(db, ctx, input.assigneeUserId),
    dueDate: assertDueDate(input.dueDate),
    priority,
    updatedAt: new Date().toISOString(),
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'csrd_action_plan',
    resourceId: plan.id,
    beforeSummary: `対応状況 ${ACTION_STATUS_LABEL[plan.status]} / 担当部署 ${plan.department || '未設定'}`,
    afterSummary: `対応状況 ${ACTION_STATUS_LABEL[status]} / 担当部署 ${department || '未設定'}`,
  });
  return updated;
}

export interface CsrdActionPlanView {
  plan: CsrdActionPlan;
  item: DisclosureItem | null;
  section: CsrdSection | null;
  applicability: CsrdApplicability | null;
  /** 計画を立てた後に対象外・未判定になった要求事項の計画（「対象外の要求事項」バッジ） */
  outOfScope: boolean;
  assigneeName: string | null;
  /** 期限までの残り日数（マイナスは超過） */
  daysLeft: number | null;
}

/** CSRD の計画だけの一覧。書かない */
export async function loadCsrdActionPlans(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  options: CsrdReferenceDateOption = {},
): Promise<CsrdActionPlanView[]> {
  const context = await loadCsrdContext(db, ctx, period);
  if (!context) return [];
  const referenceDate = options.referenceDate ?? getReferenceDate();
  const assessmentById = new Map(context.assessments.map((a) => [a.id, a]));
  const itemById = new Map(context.items.map((i) => [i.id, i]));
  const assigneeIds = [
    ...new Set(context.plans.map((p) => p.assigneeUserId).filter((id): id is Uuid => !!id)),
  ];
  const profiles =
    assigneeIds.length > 0
      ? await db.select('profiles', { where: { id: { in: assigneeIds } } })
      : [];
  const nameById = new Map(profiles.map((p) => [p.id, p.displayName]));

  return context.plans.map((plan) => {
    const assessment = assessmentById.get(plan.assessmentId);
    const item = assessment ? (itemById.get(assessment.itemId) ?? null) : null;
    const resolved = item ? itemSectionApplicability(context, item) : null;
    return {
      plan,
      item,
      section: resolved?.section ?? null,
      applicability: resolved?.applicability ?? null,
      outOfScope: resolved ? !isCsrdInScope(resolved.applicability) : true,
      assigneeName: plan.assigneeUserId ? (nameById.get(plan.assigneeUserId) ?? null) : null,
      daysLeft: plan.dueDate ? daysUntilJst(plan.dueDate, referenceDate) : null,
    };
  });
}

// ----------------------------------------------------------------------
// データ収集
// ----------------------------------------------------------------------

export interface CreateCsrdCollectionItemInput {
  planId: Uuid;
  metricCode: string;
  metricName: string;
  unit: string;
  unitId: Uuid;
  ownerUserId: Uuid | null;
  dueDate: string;
  requiresEvidence: boolean;
  department: string;
}

export interface CreateCsrdCollectionItemResult {
  metricCode: string;
  /** 指標マスターへ新しく作ったか */
  metricCreated: boolean;
  /**
   * 割当（指標 × 拠点 × 期間）を新しく作ったか。既にあれば作り直さず、入力した担当者・期限は使わない
   * （画面は「既存の割当を使った」と伝える）
   */
  assignmentCreated: boolean;
  /** 計画の対応状況（更新後） */
  planStatus: SsbjActionStatus;
  /** 未着手から対応中へ進めたか */
  planStatusChanged: boolean;
}

/**
 * 計画から収集項目（指標 × 拠点 × 期間の担当・期限）を作る。指標マスターに無ければ作る（出所は CSRD）。
 * 計画には指標コードを結び付け、未着手なら対応中にする
 */
export async function createCsrdCollectionItem(
  db: DbClient,
  ctx: AuthorizationContext,
  input: CreateCsrdCollectionItemInput,
): Promise<CreateCsrdCollectionItemResult> {
  assertCsrdWrite(ctx);
  assertCan(ctx, 'enterprise.metric.manage');
  const organizationId = ctx.workspace.organizationId;
  const plan = await db.findById('csrdActionPlans', input.planId);
  if (!plan || plan.organizationId !== organizationId) {
    throw new NotFoundError('対応計画が見つかりません。');
  }
  if (input.metricCode.trim() === '' || input.metricName.trim() === '') {
    throw new ValidationError('データ項目のコードと名称を入力してください。');
  }
  cleanText(input.metricCode, 100, 'データ項目のコード');
  cleanText(input.metricName, 200, 'データ項目の名称');
  const unit = await db.findById('units', input.unitId);
  if (!unit || unit.organizationId !== organizationId || unit.deletedAt !== null) {
    throw new ValidationError('拠点はこの組織のものから選んでください。');
  }
  const dueDate = assertDueDate(input.dueDate);
  if (!dueDate) throw new ValidationError('期限を入力してください。');

  const { metricId, metricCode, metricCreated, assignmentCreated } = await ensureMetricAssignment(
    db,
    ctx,
    {
      frameworks: ['csrd'],
      description: `CSRD 対応計画「${plan.title}」から作成したデータ項目`,
      reportingPeriodId: plan.reportingPeriodId,
      metricCode: input.metricCode,
      metricName: input.metricName,
      unit: input.unit,
      unitId: input.unitId,
      ownerUserId: await assertMember(db, ctx, input.ownerUserId),
      dueDate,
      requiresEvidence: input.requiresEvidence,
      department: cleanText(input.department, DEPARTMENT_MAX, '担当部署'),
    },
  );
  const now = new Date().toISOString();
  const planStatus: SsbjActionStatus = plan.status === 'not_started' ? 'in_progress' : plan.status;
  await db.update('csrdActionPlans', plan.id, {
    linkedMetricCode: metricCode,
    status: planStatus,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'metric_assignment',
    resourceId: metricId,
    afterSummary: assignmentCreated
      ? `CSRD のデータ収集項目を作成: ${input.metricName.trim()}（${metricCode}）`
      : `CSRD の計画に既存の収集項目を結び付け: ${input.metricName.trim()}（${metricCode}。担当・期限は変更なし）`,
    metadata: { planId: plan.id, dueDate, assignmentCreated },
  });
  return {
    metricCode,
    metricCreated,
    assignmentCreated,
    planStatus,
    planStatusChanged: planStatus !== plan.status,
  };
}

/** 評価対象の要求事項 × 対応指標 × 拠点の当期の状況 */
export interface CsrdRequirementDataRow extends CsrdMetricDataRow {
  item: DisclosureItem;
  section: CsrdSection | null;
}

/** 計画から作った収集項目（指標 × 拠点の割当） */
export interface CsrdCollectionRow {
  plan: CsrdActionPlan;
  item: DisclosureItem | null;
  metricCode: string;
  metricName: string;
  unitName: string;
  unit: string;
  ownerName: string | null;
  dueDate: string | null;
  daysLeft: number | null;
  state: CsrdDataState;
  /** 承認済みの値だけ（承認済み以外は null） */
  collectedValue: number | null;
  /** 承認済みの値の区分（実績・推計）。値が無ければ null */
  valueKind: Exclude<ValueKind, 'target'> | null;
  dataPointId: Uuid | null;
}

export interface CsrdDataCollection {
  requirementRows: CsrdRequirementDataRow[];
  planRows: CsrdCollectionRow[];
}

/** 収集画面。書かない */
export async function loadCsrdDataCollection(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  options: CsrdReferenceDateOption = {},
): Promise<CsrdDataCollection> {
  const context = await loadCsrdContext(db, ctx, period);
  if (!context) return { requirementRows: [], planRows: [] };
  const organizationId = ctx.workspace.organizationId;
  const referenceDate = options.referenceDate ?? getReferenceDate();
  const [dataPoints, assignments, units, metrics] = await Promise.all([
    db.select('dataPoints', {
      where: { organizationId, reportingPeriodId: period.id, deletedAt: { isNull: true } },
    }),
    db.select('metricAssignments', { where: { organizationId, reportingPeriodId: period.id } }),
    db.select('units', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('metrics', { where: { organizationId, deletedAt: { isNull: true } } }),
  ]);
  const assignmentUnits = new Map<Uuid, Set<Uuid>>();
  for (const a of assignments) {
    const set = assignmentUnits.get(a.metricId) ?? new Set<Uuid>();
    set.add(a.unitId);
    assignmentUnits.set(a.metricId, set);
  }

  const requirementRows: CsrdRequirementDataRow[] = [];
  for (const item of context.items) {
    const { section, applicability } = itemSectionApplicability(context, item);
    if (!isCsrdInScope(applicability)) continue;
    const rows = metricDataRows(
      context.metricsByItem.get(item.id) ?? [],
      dataPoints,
      assignmentUnits,
      units,
    );
    for (const row of rows) requirementRows.push({ ...row, item, section });
  }

  const unitById = new Map(units.map((u) => [u.id, u]));
  const metricByCode = new Map(metrics.map((m) => [m.code, m]));
  const assessmentById = new Map(context.assessments.map((a) => [a.id, a]));
  const itemById = new Map(context.items.map((i) => [i.id, i]));
  const ownerIds = [
    ...new Set(assignments.map((a) => a.ownerUserId).filter((id): id is Uuid => !!id)),
  ];
  const profiles =
    ownerIds.length > 0 ? await db.select('profiles', { where: { id: { in: ownerIds } } }) : [];
  const nameById = new Map(profiles.map((p) => [p.id, p.displayName]));

  const planRows: CsrdCollectionRow[] = [];
  for (const plan of context.plans) {
    if (!plan.linkedMetricCode) continue;
    const metric = metricByCode.get(plan.linkedMetricCode);
    if (!metric) continue;
    const assessment = assessmentById.get(plan.assessmentId);
    const item = assessment ? (itemById.get(assessment.itemId) ?? null) : null;
    const related = assignments
      .filter((a) => a.metricId === metric.id)
      .sort(
        (a, b) =>
          (unitById.get(a.unitId)?.sortOrder ?? 999) - (unitById.get(b.unitId)?.sortOrder ?? 999),
      );
    for (const assignment of related) {
      const dp = dataPoints.find((d) => d.metricId === metric.id && d.unitId === assignment.unitId);
      const state = csrdDataStateOf(dp);
      planRows.push({
        plan,
        item,
        metricCode: metric.code,
        metricName: metric.name,
        unitName: unitById.get(assignment.unitId)?.name ?? '—',
        unit: metric.unit,
        ownerName: assignment.ownerUserId ? (nameById.get(assignment.ownerUserId) ?? null) : null,
        dueDate: assignment.dueDate,
        daysLeft: assignment.dueDate ? daysUntilJst(assignment.dueDate, referenceDate) : null,
        state,
        collectedValue: dp && state === 'approved' && hasUsableValue(dp) ? dp.value : null,
        valueKind: approvedValueKind(dp, state),
        dataPointId: dp?.id ?? null,
      });
    }
  }
  return { requirementRows, planRows };
}

/** 画面が使う: 計画の作成・収集項目の作成ができる権限か */
export function csrdPlanPermissions(ctx: AuthorizationContext): {
  canWrite: boolean;
  canCreateCollection: boolean;
} {
  const canWrite = can(ctx, 'enterprise.disclosure.write');
  return { canWrite, canCreateCollection: canWrite && can(ctx, 'enterprise.metric.manage') };
}
