import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, AuthorizationError, can, NotFoundError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { fid } from '@/lib/fixtures/ids';
import type { DbClient } from '@/lib/repositories/types';
import type {
  ApprovalRoute,
  ApprovalRouteStage,
  AuthorizationContext,
  DataPoint,
  DataPointApprovalStep,
  Uuid,
} from '@/types/domain';
import { MAX_APPROVAL_STAGES } from '@/types/domain';

/**
 * 最大 5 階層の承認フロー。
 *
 * 非財務データは、拠点の入力担当 → 拠点長 → 本社の主管部門 → 経理・内部統制 → 役員、
 * のように複数の部署を通って初めて開示に載る。1 段階しか無いと、
 * どこまで進んでいるのか、誰の承認で確定したのか、誰の判断で差し戻されたのかが残らない。
 *
 * 守っていること:
 *  - 道筋（テンプレート）を変えても、進行中・確定済みのデータの経路は変わらない
 *    （データごとに写しを作る）
 *  - 承認・差し戻しは追記のみ。更新も削除もしない
 *  - 差し戻し後の出し直しは round を増やし、前の巡の記録を残す
 *  - AI は承認しない。決めるのは必ず人（CLAUDE.md §0.4）
 */

// ----------------------------------------------------------------------
// 道筋の定義
// ----------------------------------------------------------------------

export interface ApprovalRouteView {
  route: ApprovalRoute;
  stages: ApprovalRouteStage[];
}

export async function loadApprovalRoutes(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<ApprovalRouteView[]> {
  const organizationId = ctx.workspace.organizationId;
  const [routes, stages] = await Promise.all([
    db.select('approvalRoutes', {
      where: { organizationId },
      orderBy: { column: 'name', dir: 'asc' },
    }),
    db.select('approvalRouteStages', {
      where: { organizationId, deletedAt: { isNull: true } },
    }),
  ]);
  return routes.map((route) => ({
    route,
    stages: stages.filter((s) => s.routeId === route.id).sort((a, b) => a.stageNo - b.stageNo),
  }));
}

export async function loadDefaultRoute(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<ApprovalRouteView | null> {
  const routes = await loadApprovalRoutes(db, ctx);
  return routes.find((r) => r.route.isDefault) ?? routes[0] ?? null;
}

export interface RouteStageInput {
  name: string;
  approverRole: string;
  approverUserId: Uuid | null;
  department: string;
}

export interface SaveRouteInput {
  routeId?: Uuid;
  name: string;
  description: string;
  isDefault: boolean;
  stages: RouteStageInput[];
}

/**
 * 道筋を作る・書き換える。
 * 段階は 1〜5。0 段階の道筋は承認そのものが無くなるので許さない。
 */
export async function saveApprovalRoute(
  db: DbClient,
  ctx: AuthorizationContext,
  input: SaveRouteInput,
): Promise<ApprovalRouteView> {
  assertCan(ctx, 'enterprise.org.manage');
  const organizationId = ctx.workspace.organizationId;

  const name = input.name.trim();
  if (name === '') throw new ValidationError('承認の道筋の名称を入力してください。');

  const stages = input.stages.filter((s) => s.name.trim() !== '');
  if (stages.length === 0) {
    throw new ValidationError('承認段階を 1 つ以上入力してください。');
  }
  if (stages.length > MAX_APPROVAL_STAGES) {
    throw new ValidationError(`承認段階は最大 ${MAX_APPROVAL_STAGES} 階層までです。`);
  }

  const now = new Date().toISOString();
  const routeId = input.routeId ?? fid('approval_route', `${organizationId}/${name}`);

  const existing = await db.findById('approvalRoutes', routeId);
  if (existing && existing.organizationId !== organizationId) {
    throw new NotFoundError('承認の道筋が見つかりません。');
  }

  // 既定はひとつだけ。別の道筋を既定にしたら、元の既定は外す
  if (input.isDefault) {
    const others = await db.select('approvalRoutes', {
      where: { organizationId, isDefault: true },
    });
    for (const other of others) {
      if (other.id === routeId) continue;
      await db.update('approvalRoutes', other.id, {
        isDefault: false,
        updatedAt: now,
        updatedBy: ctx.userId,
      });
    }
  }

  if (existing) {
    await db.update('approvalRoutes', routeId, {
      name,
      description: input.description.trim(),
      isDefault: input.isDefault,
      updatedAt: now,
      updatedBy: ctx.userId,
    });
    // 段階は作り直す。進行中のデータは自分の写しを持っているので影響しない。
    // 古い段階は消さずに論理削除で残し、その時点の道筋を後から辿れるようにする
    const old = await db.select('approvalRouteStages', {
      where: { organizationId, routeId, deletedAt: { isNull: true } },
    });
    for (const stage of old) await db.softDelete('approvalRouteStages', stage.id, now);
  } else {
    await db.insert('approvalRoutes', [
      {
        id: routeId,
        organizationId,
        name,
        description: input.description.trim(),
        isDefault: input.isDefault,
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    ]);
  }

  await db.insert(
    'approvalRouteStages',
    stages.map((stage, index) => ({
      // 論理削除した段階が同じ id で残っているため、保存時刻も種に混ぜて別の行にする
      id: fid('approval_route_stage', `${routeId}/${now}/${index + 1}`),
      organizationId,
      routeId,
      stageNo: index + 1,
      name: stage.name.trim(),
      approverRole: stage.approverRole.trim(),
      approverUserId: stage.approverUserId,
      department: stage.department.trim(),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })),
  );

  await recordAuditEvent(db, ctx, {
    eventType: existing ? 'data_updated' : 'data_created',
    resourceType: 'approval_route',
    resourceId: routeId,
    afterSummary: `承認の道筋「${name}」（${stages.length} 階層）`,
  });

  const route = (await db.findById('approvalRoutes', routeId))!;
  const saved = await db.select('approvalRouteStages', {
    where: { organizationId, routeId, deletedAt: { isNull: true } },
  });
  return { route, stages: saved.sort((a, b) => a.stageNo - b.stageNo) };
}

// ----------------------------------------------------------------------
// データごとの承認
// ----------------------------------------------------------------------

export interface ApprovalProgress {
  steps: DataPointApprovalStep[];
  /** 現在の巡 */
  round: number;
  /** 承認待ちの段階。すべて承認済みなら null */
  currentStep: DataPointApprovalStep | null;
  /** 承認済みの段階数 */
  approvedCount: number;
  /** 全段階数 */
  totalCount: number;
  /** 差し戻された段階（あれば） */
  returnedStep: DataPointApprovalStep | null;
  /** すべての段階が承認済みか */
  complete: boolean;
}

/** 承認段階を、現在の巡だけ取り出して進捗にまとめる */
export function summarizeProgress(all: DataPointApprovalStep[]): ApprovalProgress {
  const round = all.reduce((max, s) => Math.max(max, s.round), 0);
  const steps = all.filter((s) => s.round === round).sort((a, b) => a.stageNo - b.stageNo);
  const approved = steps.filter((s) => s.status === 'approved');
  return {
    steps,
    round,
    currentStep: steps.find((s) => s.status === 'pending') ?? null,
    approvedCount: approved.length,
    totalCount: steps.length,
    returnedStep: steps.find((s) => s.status === 'returned') ?? null,
    complete: steps.length > 0 && approved.length === steps.length,
  };
}

export async function loadApprovalProgress(
  db: DbClient,
  ctx: AuthorizationContext,
  dataPointId: Uuid,
): Promise<ApprovalProgress> {
  const steps = await db.select('dataPointApprovalSteps', {
    where: { organizationId: ctx.workspace.organizationId, dataPointId },
  });
  return summarizeProgress(steps);
}

/** 複数データの進捗をまとめて読む（一覧画面で 1 件ずつ問い合わせない） */
export async function loadApprovalProgressMap(
  db: DbClient,
  ctx: AuthorizationContext,
  dataPointIds: Uuid[],
): Promise<Map<Uuid, ApprovalProgress>> {
  const result = new Map<Uuid, ApprovalProgress>();
  if (dataPointIds.length === 0) return result;

  const steps = await db.select('dataPointApprovalSteps', {
    where: { organizationId: ctx.workspace.organizationId, dataPointId: { in: dataPointIds } },
  });
  const byDataPoint = new Map<Uuid, DataPointApprovalStep[]>();
  for (const step of steps) {
    const list = byDataPoint.get(step.dataPointId) ?? [];
    list.push(step);
    byDataPoint.set(step.dataPointId, list);
  }
  for (const [dataPointId, list] of byDataPoint) {
    result.set(dataPointId, summarizeProgress(list));
  }
  return result;
}

/**
 * 承認の道筋をデータへ適用する（提出時に呼ぶ）。
 *
 * テンプレートの写しを作るので、あとで道筋の定義を変えても
 * このデータの経路は変わらない。既に進行中なら何もしない。
 */
export async function startApprovalRoute(
  db: DbClient,
  ctx: AuthorizationContext,
  dataPointId: Uuid,
): Promise<ApprovalProgress> {
  const organizationId = ctx.workspace.organizationId;
  const dataPoint = await db.findById('dataPoints', dataPointId);
  if (!dataPoint || dataPoint.organizationId !== organizationId) {
    throw new NotFoundError('データが見つかりません。');
  }

  const existing = await db.select('dataPointApprovalSteps', {
    where: { organizationId, dataPointId },
  });
  const current = summarizeProgress(existing);
  // 承認待ちが残っているなら、そのまま続ける（二重に道筋を作らない）
  if (current.currentStep) return current;

  const route = await loadDefaultRoute(db, ctx);
  if (!route || route.stages.length === 0) {
    // 道筋が定義されていない組織では、これまでどおり単段階の承認で進む
    return current;
  }

  // 差し戻し後の出し直しは次の巡として記録する（前の巡は残す）
  const round = current.round + 1;
  const now = new Date().toISOString();

  const steps: DataPointApprovalStep[] = route.stages.map((stage) => ({
    id: fid('data_point_approval_step', `${dataPointId}/${round}/${stage.stageNo}`),
    organizationId,
    dataPointId,
    routeId: route.route.id,
    stageNo: stage.stageNo,
    stageName: stage.name,
    approverRole: stage.approverRole,
    approverUserId: stage.approverUserId,
    department: stage.department,
    // 1 段目だけが承認待ち。以降は前の段階が終わってから
    status: stage.stageNo === 1 ? 'pending' : 'waiting',
    decidedAt: null,
    decidedBy: null,
    comment: '',
    round,
    createdAt: now,
    updatedAt: now,
  }));
  await db.insert('dataPointApprovalSteps', steps);

  await recordAuditEvent(db, ctx, {
    eventType: 'data_submitted',
    resourceType: 'data_point',
    resourceId: dataPointId,
    afterSummary: `承認の道筋「${route.route.name}」を開始（${steps.length} 階層・${round} 巡目）`,
  });

  return summarizeProgress([...existing, ...steps]);
}

/** 今の利用者がこの段階を決められるか */
export function canDecideStep(ctx: AuthorizationContext, step: DataPointApprovalStep): boolean {
  if (!can(ctx, 'enterprise.data.review')) return false;
  // 個人指定があるなら本人だけ
  if (step.approverUserId) return step.approverUserId === ctx.userId;
  // 役割指定があるならその役割の保持者だけ
  if (step.approverRole) return ctx.workspace.roleKeys.includes(step.approverRole as never);
  return true;
}

export interface DecideStepInput {
  dataPointId: Uuid;
  decision: 'approved' | 'returned';
  comment: string;
}

export interface DecideStepResult {
  progress: ApprovalProgress;
  /** すべての段階を承認し終えたか（呼び出し側がデータの状態を確定させる） */
  completed: boolean;
  dataPoint: DataPoint;
}

/**
 * 承認待ちの段階を決める。
 *
 * 承認 → 次の段階が承認待ちになる。最後の段階まで承認されたら完了。
 * 差し戻し → その段階を差し戻しとして残し、巡はそこで終わる。
 *            出し直すと次の巡が始まり、1 段目から積み直す。
 */
export async function decideApprovalStep(
  db: DbClient,
  ctx: AuthorizationContext,
  input: DecideStepInput,
): Promise<DecideStepResult> {
  assertCan(ctx, 'enterprise.data.review');
  const organizationId = ctx.workspace.organizationId;

  const dataPoint = await db.findById('dataPoints', input.dataPointId);
  if (!dataPoint || dataPoint.organizationId !== organizationId) {
    throw new NotFoundError('データが見つかりません。');
  }

  const all = await db.select('dataPointApprovalSteps', {
    where: { organizationId, dataPointId: input.dataPointId },
  });
  const progress = summarizeProgress(all);
  const step = progress.currentStep;
  if (!step) {
    throw new ValidationError('承認待ちの段階がありません。');
  }
  if (!canDecideStep(ctx, step)) {
    throw new AuthorizationError(
      `この段階（${step.stageNo}. ${step.stageName}）を承認できるのは${
        step.department ? `${step.department}の` : ''
      }担当者だけです。`,
    );
  }
  if (input.decision === 'returned' && input.comment.trim() === '') {
    // 差し戻しは相手の作業を止める行為なので、理由の無い差し戻しは許さない
    throw new ValidationError('差し戻すときは理由を書いてください。');
  }

  const now = new Date().toISOString();
  await db.update('dataPointApprovalSteps', step.id, {
    status: input.decision,
    decidedAt: now,
    decidedBy: ctx.userId,
    comment: input.comment.trim(),
    updatedAt: now,
  });

  let completed = false;
  if (input.decision === 'approved') {
    const next = progress.steps.find((s) => s.stageNo === step.stageNo + 1);
    if (next) {
      await db.update('dataPointApprovalSteps', next.id, { status: 'pending', updatedAt: now });
    } else {
      completed = true;
    }
  }

  await recordAuditEvent(db, ctx, {
    eventType: input.decision === 'approved' ? 'data_approved' : 'data_returned',
    resourceType: 'data_point',
    resourceId: input.dataPointId,
    beforeSummary: `承認段階 ${step.stageNo}/${progress.totalCount}（${step.stageName}）`,
    afterSummary:
      input.decision === 'approved'
        ? `${step.stageName} が承認${completed ? '（全段階完了）' : ''}`
        : `${step.stageName} が差し戻し: ${input.comment.trim()}`,
  });

  const after = await db.select('dataPointApprovalSteps', {
    where: { organizationId, dataPointId: input.dataPointId },
  });

  return {
    progress: summarizeProgress(after),
    completed,
    dataPoint,
  };
}

// ----------------------------------------------------------------------
// 履歴（いつ・誰が・承認／修正／差し戻し したか）
// ----------------------------------------------------------------------

export type ApprovalTimelineKind = 'modified' | 'approved' | 'returned';

export interface ApprovalTimelineEntry {
  kind: ApprovalTimelineKind;
  at: string;
  actorUserId: Uuid | null;
  actorName: string;
  /** 「2. 拠点長」など。修正には段階が無いので null */
  stageLabel: string | null;
  /** 何巡目か。修正には無いので null */
  round: number | null;
  /** 修正なら変更後の値、承認・差し戻しならコメント */
  detail: string;
}

/**
 * 1 つのデータについて「いつ・誰が・何をしたか」を時系列でまとめる。
 *
 * 承認段階（承認・差し戻し）と値の版（修正）は別の表に分かれている。
 * 監査法人へ説明するときに見たいのは、それらが混ざった 1 本の流れなので、
 * ここで突き合わせる。新しいものを上にする。
 */
export async function loadApprovalTimeline(
  db: DbClient,
  ctx: AuthorizationContext,
  dataPointId: Uuid,
): Promise<ApprovalTimelineEntry[]> {
  const organizationId = ctx.workspace.organizationId;
  const dataPoint = await db.findById('dataPoints', dataPointId);
  if (!dataPoint || dataPoint.organizationId !== organizationId) {
    throw new NotFoundError('データが見つかりません。');
  }

  const [steps, versions] = await Promise.all([
    db.select('dataPointApprovalSteps', { where: { organizationId, dataPointId } }),
    db.select('dataPointVersions', { where: { organizationId, dataPointId } }),
  ]);

  const userIds = new Set<Uuid>();
  for (const step of steps) if (step.decidedBy) userIds.add(step.decidedBy);
  for (const version of versions) if (version.createdBy) userIds.add(version.createdBy);
  const profiles =
    userIds.size > 0 ? await db.select('profiles', { where: { id: { in: [...userIds] } } }) : [];
  const nameById = new Map(profiles.map((p) => [p.id, p.displayName]));
  const nameOf = (id: Uuid | null) => (id ? (nameById.get(id) ?? '不明な利用者') : 'システム');

  const entries: ApprovalTimelineEntry[] = [];

  for (const version of versions) {
    entries.push({
      kind: 'modified',
      at: version.createdAt,
      actorUserId: version.createdBy,
      actorName: nameOf(version.createdBy),
      stageLabel: null,
      round: null,
      detail:
        `第 ${version.versionNo} 版: ${version.value ?? version.textValue ?? '—'} ${version.unitOfMeasure}` +
        (version.changeReason ? `（理由: ${version.changeReason}）` : ''),
    });
  }

  for (const step of steps) {
    if (step.status !== 'approved' && step.status !== 'returned') continue;
    entries.push({
      kind: step.status,
      at: step.decidedAt ?? step.updatedAt,
      actorUserId: step.decidedBy,
      actorName: nameOf(step.decidedBy),
      stageLabel: `${step.stageNo}. ${step.stageName}`,
      round: step.round,
      detail: step.comment || (step.status === 'approved' ? '承認' : '差し戻し'),
    });
  }

  // 新しいものが上。同時刻なら承認・差し戻しを先に出す（修正の結果として決裁が起きるため）
  const order: Record<ApprovalTimelineKind, number> = { approved: 0, returned: 0, modified: 1 };
  return entries.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? 1 : -1;
    return order[a.kind] - order[b.kind];
  });
}
