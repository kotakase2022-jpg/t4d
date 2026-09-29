import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { AuthorizationError, assertCan, can, canAny, NotFoundError } from '@/lib/authorization/can';
import { collectRefs, contentHashOf, hasBodyContent } from '@/lib/domain/disclosure-block';
import {
  DEFAULT_REVIEW_POLICY,
  DEFAULT_REVIEW_POLICY_VERSION,
  REVIEW_EVENT_TYPE_LABELS,
  REVIEW_REQUEST_STATUS_LABELS,
  REVIEW_STAGE_LABELS,
  canCompleteReview,
  canFinalApprove,
  reviewEventIdempotencyKey,
  transitionBlock,
  validateReturn,
  type BlockBlocker,
} from '@/lib/domain/disclosure-status';
import { ValidationError } from '@/lib/errors/user-facing';
import { fid } from '@/lib/fixtures/ids';
import {
  appendBlockVersion,
  currentVersionBody,
  evaluateBlockBlockersFor,
  loadBlock,
  loadBlockVersion,
  loadMembers,
  loadProject,
  nameOf,
  sortReviewEvents,
  validateBodyRefs,
  VERSION_UNAVAILABLE_MESSAGE,
  BlockRefValidationError,
  type EditorMember,
} from '@/lib/services/disclosure-block';
import { computeBlockFreshness, unresolvedFreshnessItems } from '@/lib/services/disclosure-recheck';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  BlockBody,
  DisclosureBlock,
  DisclosureBlockVersion,
  IsoDateTime,
  ReviewComment,
  ReviewCommentSeverity,
  ReviewEvent,
  ReviewEventType,
  ReviewRequest,
  ReviewRequestStatus,
  ReviewStage,
  Uuid,
} from '@/types/domain';

/**
 * 開示本文のレビューと最終承認（docs/disclosure-first.md §2-2・§5、指示書 §6.9・§10）。
 *
 *  - 依頼時に「審査する版」「規則（sod-3role-v1）」「適用判断の版」「引用した版」を固定する（A24）
 *  - 職務分離: 依頼者・版の作成者はレビューを完了できない。依頼者・版の作成者・同じ依頼のレビュー完了者は
 *    最終承認できない。同じ規則を DB トリガ（t4d.enforce_review_event）も強制する（A28）
 *  - 最終承認の直前に、引用した数値・定性情報がまだ現在の版か（または理由付きで維持と判断済みか）を
 *    同じ呼び出しの中で確かめ直す（A26）。DbClient はトランザクションを持たないため、
 *    確認と記録の間の極めて短い時間の更新までは防げない（known-limitations に記載する前提の best-effort）
 *  - 判断はすべて review_events に追記する。二重押下は idempotency_key（依頼＋段階＋対象版）で 1 回に抑える
 *  - 企業内の承認であり、第三者保証ではない（画面でも「保証」と表示しない）
 */

// ======================================================================
// 共通
// ======================================================================

/** 阻害条件があって依頼・承認できない。項目ごとの理由を持つ */
export class ReviewBlockedError extends ValidationError {
  constructor(readonly blockers: BlockBlocker[]) {
    super(`次の条件を解消してください: ${blockers.map((b) => b.message).join(' ／ ')}`);
    this.name = 'ReviewBlockedError';
  }
}

async function loadRequest(
  db: DbClient,
  ctx: AuthorizationContext,
  requestId: Uuid,
): Promise<ReviewRequest> {
  assertCan(ctx, 'enterprise.disclosure.read');
  const request = await db.findById('reviewRequests', requestId);
  if (!request || request.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('レビュー依頼が見つかりません。');
  }
  return request;
}

async function eventsOf(
  db: DbClient,
  ctx: AuthorizationContext,
  requestId: Uuid,
): Promise<ReviewEvent[]> {
  return sortReviewEvents(
    await db.select('reviewEvents', {
      where: { organizationId: ctx.workspace.organizationId, reviewRequestId: requestId },
    }),
  );
}

async function unresolvedMajorComments(
  db: DbClient,
  ctx: AuthorizationContext,
  blockId: Uuid,
): Promise<ReviewComment[]> {
  const comments = await db.select('reviewComments', {
    where: { organizationId: ctx.workspace.organizationId, blockId, severity: 'major' },
  });
  return comments.filter((c) => c.resolvedAt === null);
}

async function notify(
  db: DbClient,
  ctx: AuthorizationContext,
  userId: Uuid | null,
  title: string,
  body: string,
  href: string,
): Promise<void> {
  if (!userId || userId === ctx.userId) return;
  const now = new Date().toISOString();
  await db.insert('notifications', [
    {
      id: fid('notification', `review/${userId}/${now}/${href}`),
      organizationId: ctx.workspace.organizationId,
      userId,
      title,
      body,
      category: 'review',
      href,
      readAt: null,
      createdAt: now,
    },
  ]);
}

function blockHref(block: Pick<DisclosureBlock, 'id' | 'projectId'>): string {
  return `/enterprise/disclosure-projects/${block.projectId}/blocks/${block.id}`;
}

/**
 * 判断の記録（追記）。同じ idempotency_key の記録が既にあれば何もしない（二重押下で 2 回記録しない）。
 * 戻り値が false なら「既に記録済み」。
 */
async function appendEvent(
  db: DbClient,
  ctx: AuthorizationContext,
  request: ReviewRequest,
  eventType: ReviewEventType,
  stage: ReviewStage,
  idempotencyKey: string,
  extra: { reason?: string | null; paragraphId?: string | null } = {},
): Promise<boolean> {
  const existing = await db.select('reviewEvents', {
    where: { organizationId: ctx.workspace.organizationId, idempotencyKey },
  });
  if (existing.length > 0) return false;
  const now = new Date().toISOString();
  const event: ReviewEvent = {
    id: fid('review_event', `${request.id}/${eventType}/${idempotencyKey}/${now}`),
    organizationId: ctx.workspace.organizationId,
    reviewRequestId: request.id,
    eventType,
    stage,
    actorUserId: ctx.userId,
    // 依頼で固定した版と同じ値（DB トリガも一致を強制する）
    targetVersionId: request.targetVersionId,
    reason: extra.reason ?? null,
    paragraphId: extra.paragraphId ?? null,
    idempotencyKey,
    createdAt: now,
  };
  await db.insert('reviewEvents', [event]);
  return true;
}

async function setRequestStatus(
  db: DbClient,
  ctx: AuthorizationContext,
  request: ReviewRequest,
  status: ReviewRequestStatus,
): Promise<ReviewRequest> {
  const now = new Date().toISOString();
  // 依頼時点の内容（対象の版・規則・参照版）は変えない。状態と更新記録だけ
  return db.update('reviewRequests', request.id, { status, updatedAt: now, updatedBy: ctx.userId });
}

async function setBlockStatus(
  db: DbClient,
  ctx: AuthorizationContext,
  block: DisclosureBlock,
  patch: Pick<Partial<DisclosureBlock>, 'status' | 'submittedVersionId' | 'approvedVersionId'>,
): Promise<DisclosureBlock> {
  const now = new Date().toISOString();
  // 承認だけの権限の人が更新できる列（状態・提出版・承認版）に限る（0037 のトリガと同じ）
  return db.update('disclosureBlocks', block.id, {
    ...patch,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
}

function memberHas(
  members: Map<Uuid, EditorMember>,
  userId: Uuid,
  permission: 'enterprise.disclosure.write' | 'enterprise.disclosure.approve',
): boolean {
  return members.get(userId)?.permissions.includes(permission) ?? false;
}

// ======================================================================
// レビュー依頼
// ======================================================================

export interface RequestReviewInput {
  blockId: Uuid;
  /** 省略時はプロジェクトのレビュー担当 */
  reviewerUserId?: Uuid | null;
  /** 省略時はプロジェクトの最終承認者 */
  approverUserId?: Uuid | null;
}

export async function requestReview(
  db: DbClient,
  ctx: AuthorizationContext,
  input: RequestReviewInput,
): Promise<{ request: ReviewRequest; version: DisclosureBlockVersion; createdVersion: boolean }> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const organizationId = ctx.workspace.organizationId;
  let block = await loadBlock(db, ctx, input.blockId);
  const project = await loadProject(db, ctx, block.projectId);

  // 二重押下: 同じ節に進行中の依頼があれば、それを返す（2 本目を作らない）
  const active = (
    await db.select('reviewRequests', {
      where: {
        organizationId,
        targetType: 'disclosure_block',
        targetId: block.id,
        status: { in: ['open', 'reviewed'] },
      },
    })
  )[0];
  if (active) {
    if (active.targetVersionId === block.submittedVersionId) {
      const version = await loadBlockVersion(db, ctx, active.targetVersionId);
      return { request: active, version, createdVersion: false };
    }
    throw new ValidationError('この節には進行中のレビュー依頼があります。');
  }

  const transition = transitionBlock('request_review', block.status);
  if (!transition.ok) throw new ValidationError(transition.reason);
  if (!block.ownerUserId) {
    throw new ValidationError('節の担当者が未設定です。担当者を決めてから依頼してください。');
  }

  // 依頼先（レビュー担当・最終承認者）
  const members = await loadMembers(db, ctx);
  const reviewerUserId =
    input.reviewerUserId === undefined ? project.reviewerUserId : input.reviewerUserId;
  const approverUserId =
    input.approverUserId === undefined ? project.finalApproverUserId : input.approverUserId;
  if (reviewerUserId) {
    if (!memberHas(members, reviewerUserId, 'enterprise.disclosure.write')) {
      throw new ValidationError(
        'レビュー担当に指定した人に、開示の編集（レビュー）権限がありません。',
      );
    }
    if (reviewerUserId === ctx.userId) {
      throw new ValidationError('自分自身をレビュー担当にはできません（職務分離）。');
    }
  }
  if (approverUserId) {
    if (!memberHas(members, approverUserId, 'enterprise.disclosure.approve')) {
      throw new ValidationError('最終承認者に指定した人に、開示の承認権限がありません。');
    }
    if (approverUserId === ctx.userId) {
      throw new ValidationError('自分自身を最終承認者にはできません（職務分離）。');
    }
  }
  if (reviewerUserId && approverUserId && reviewerUserId === approverUserId) {
    throw new ValidationError('レビュー担当と最終承認者は別の人にしてください（職務分離）。');
  }

  // 提出する版を決める。作業本文が現在の版と違えば、依頼の前に版として保存する
  const current = await currentVersionBody(db, ctx, block);
  if (block.currentVersionId && !current.version) {
    throw new NotFoundError(VERSION_UNAVAILABLE_MESSAGE);
  }
  let version = current.version;
  let createdVersion = false;
  if (block.workingBody) {
    if ((block.workingBaseVersionId ?? null) !== (block.currentVersionId ?? null)) {
      throw new ValidationError(
        '作業中の本文が古い版を土台にしています。原稿の画面で差分を確認してから依頼してください。',
      );
    }
    if (!current.version || current.version.contentHash !== contentHashOf(block.workingBody)) {
      if (!hasBodyContent(block.workingBody)) {
        throw new ReviewBlockedError([{ code: 'no_body', message: '本文がありません。' }]);
      }
      const issues = await validateBodyRefs(db, ctx, block.id, block.workingBody);
      if (issues.length > 0) throw new BlockRefValidationError(issues);
      version = await appendBlockVersion(db, ctx, block, block.workingBody, {
        changeReason: 'レビュー依頼時の版',
        baseVersionId: block.currentVersionId,
      });
      createdVersion = true;
      const now = new Date().toISOString();
      block = await db.update('disclosureBlocks', block.id, {
        currentVersionId: version.id,
        workingBody: null,
        workingBaseVersionId: null,
        workingSavedAt: null,
        updatedAt: now,
        updatedBy: ctx.userId,
      });
    }
  }
  if (!version) {
    throw new ReviewBlockedError([{ code: 'no_body', message: '本文がありません。' }]);
  }

  const blockers = await evaluateBlockBlockersFor(db, ctx, block, version.body);
  if (blockers.length > 0) throw new ReviewBlockedError(blockers);

  // 依頼時点の適用判断の版と、本文が引用している版を固定する
  const projectFrameworks = await db.select('projectFrameworks', {
    where: { organizationId, projectId: project.id },
  });
  const decisionIds = projectFrameworks
    .map((pf) => pf.currentDecisionId)
    .filter((id): id is Uuid => Boolean(id));
  const refs = collectRefs(version.body);

  const now = new Date().toISOString();
  const request: ReviewRequest = {
    id: fid('review_request', `${block.id}/${version.id}/${now}`),
    organizationId,
    projectId: project.id,
    targetType: 'disclosure_block',
    targetId: block.id,
    targetVersionId: version.id,
    requestedBy: ctx.userId,
    reviewerUserId: reviewerUserId ?? null,
    approverUserId: approverUserId ?? null,
    policyVersion: DEFAULT_REVIEW_POLICY_VERSION,
    // 依頼時点の規則の写し。後で既定の規則が変わっても、この依頼の判断基準は変わらない
    policy: { ...DEFAULT_REVIEW_POLICY, stages: [...DEFAULT_REVIEW_POLICY.stages] },
    decisionIds,
    referencedVersions: {
      metricVersionIds: refs.metricVersionIds,
      narrativeVersionIds: refs.narrativeVersionIds,
      anchorIds: refs.anchorIds,
    },
    status: 'open',
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  };
  await db.insert('reviewRequests', [request]);
  await appendEvent(
    db,
    ctx,
    request,
    'requested',
    'request',
    reviewEventIdempotencyKey(request.id, 'request', version.id),
  );
  await setBlockStatus(db, ctx, block, {
    status: 'review_requested',
    submittedVersionId: version.id,
  });
  await notify(
    db,
    ctx,
    reviewerUserId ?? null,
    `レビュー依頼: ${block.title}`,
    `${project.name} の「${block.title}」（版 ${version.versionNo}）のレビューを依頼されました。`,
    blockHref(block),
  );
  await recordAuditEvent(db, ctx, {
    eventType: 'review_requested',
    resourceType: 'review_request',
    resourceId: request.id,
    afterSummary: `${block.title} 版 ${version.versionNo} のレビューを依頼`,
    metadata: { blockId: block.id, versionId: version.id, policyVersion: request.policyVersion },
  });
  return { request, version, createdVersion };
}

// ======================================================================
// 操作できるか（画面のボタンの出し分けと、サーバーでの検証に同じ関数を使う）
// ======================================================================

export interface ReviewActionState {
  stage: 'review' | 'final' | null;
  canReturn: boolean;
  canComplete: boolean;
  canApprove: boolean;
  canWithdraw: boolean;
  /** できない理由（画面に出す） */
  reasons: string[];
}

export async function reviewActionsFor(
  db: DbClient,
  ctx: AuthorizationContext,
  request: ReviewRequest,
): Promise<ReviewActionState> {
  const reasons: string[] = [];
  const block = await loadBlock(db, ctx, request.targetId);
  const version = await db.findById('disclosureBlockVersions', request.targetVersionId);
  const author = version?.createdBy ?? null;
  const stage =
    request.status === 'open' ? 'review' : request.status === 'reviewed' ? 'final' : null;
  const canWithdraw =
    (request.status === 'open' || request.status === 'reviewed') &&
    can(ctx, 'enterprise.disclosure.write') &&
    (request.requestedBy === ctx.userId || block.ownerUserId === ctx.userId);

  let canReturn = false;
  let canComplete = false;
  let canApprove = false;
  if (stage === 'review') {
    const assigned = !request.reviewerUserId || request.reviewerUserId === ctx.userId;
    const sod = canCompleteReview({
      actorId: ctx.userId,
      request,
      targetVersionCreatedBy: author ?? '',
    });
    if (!can(ctx, 'enterprise.disclosure.write')) reasons.push('レビューの権限がありません。');
    else if (!assigned) reasons.push('この依頼のレビュー担当ではありません。');
    else if (!sod.ok) reasons.push(sod.reason);
    canReturn =
      can(ctx, 'enterprise.disclosure.write') && assigned && request.requestedBy !== ctx.userId;
    canComplete = can(ctx, 'enterprise.disclosure.write') && assigned && sod.ok;
  } else if (stage === 'final') {
    const events = await eventsOf(db, ctx, request.id);
    const assigned = !request.approverUserId || request.approverUserId === ctx.userId;
    const sod = canFinalApprove({
      actorId: ctx.userId,
      request,
      targetVersionCreatedBy: author ?? '',
      reviewCompletedBy: events
        .filter((e) => e.eventType === 'review_completed')
        .map((e) => e.actorUserId),
    });
    if (!can(ctx, 'enterprise.disclosure.approve')) reasons.push('最終承認の権限がありません。');
    else if (!assigned) reasons.push('この依頼の最終承認者ではありません。');
    else if (!sod.ok) reasons.push(sod.reason);
    canReturn =
      can(ctx, 'enterprise.disclosure.approve') && assigned && request.requestedBy !== ctx.userId;
    canApprove = can(ctx, 'enterprise.disclosure.approve') && assigned && sod.ok;
  }
  return { stage, canReturn, canComplete, canApprove, canWithdraw, reasons };
}

// ======================================================================
// 差戻し・レビュー完了・最終承認・取下げ
// ======================================================================

export interface ReturnReviewInput {
  requestId: Uuid;
  reason: string;
  paragraphId: string;
}

export async function returnReview(
  db: DbClient,
  ctx: AuthorizationContext,
  input: ReturnReviewInput,
): Promise<ReviewRequest> {
  const request = await loadRequest(db, ctx, input.requestId);
  const block = await loadBlock(db, ctx, request.targetId);
  const stage: ReviewStage | null =
    request.status === 'open' ? 'review' : request.status === 'reviewed' ? 'final' : null;
  if (!stage) throw new ValidationError('レビュー中ではない依頼は差し戻せません。');

  if (stage === 'review') {
    assertCan(ctx, 'enterprise.disclosure.write');
    if (request.reviewerUserId && request.reviewerUserId !== ctx.userId) {
      throw new AuthorizationError('この依頼のレビュー担当ではありません。');
    }
  } else {
    assertCan(ctx, 'enterprise.disclosure.approve');
    if (request.approverUserId && request.approverUserId !== ctx.userId) {
      throw new AuthorizationError('この依頼の最終承認者ではありません。');
    }
  }
  if (request.requestedBy === ctx.userId) {
    throw new AuthorizationError('依頼した本人は差し戻せません。依頼の取下げを使ってください。');
  }

  const version = await loadBlockVersion(db, ctx, request.targetVersionId);
  const check = validateReturn({
    reason: input.reason,
    paragraphId: input.paragraphId,
    body: version.body,
  });
  if (!check.ok) throw new ValidationError(check.reason);

  const recorded = await appendEvent(
    db,
    ctx,
    request,
    'returned',
    stage,
    reviewEventIdempotencyKey(request.id, stage, request.targetVersionId),
    { reason: input.reason.trim(), paragraphId: input.paragraphId },
  );
  if (!recorded) return request;

  const transition = transitionBlock('return', block.status);
  if (!transition.ok) throw new ValidationError(transition.reason);
  const updated = await setRequestStatus(db, ctx, request, 'returned');
  await setBlockStatus(db, ctx, block, { status: 'returned' });
  await notify(
    db,
    ctx,
    request.requestedBy,
    `差戻し: ${block.title}`,
    `「${block.title}」（版 ${version.versionNo}）が差し戻されました: ${input.reason.trim()}`,
    blockHref(block),
  );
  await recordAuditEvent(db, ctx, {
    eventType: 'review_returned',
    resourceType: 'review_request',
    resourceId: request.id,
    afterSummary: `${block.title} 版 ${version.versionNo} を差戻し（${REVIEW_STAGE_LABELS[stage]}）`,
    metadata: { blockId: block.id, stage, paragraphId: input.paragraphId },
  });
  return updated;
}

export async function completeReview(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { requestId: Uuid },
): Promise<ReviewRequest> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const request = await loadRequest(db, ctx, input.requestId);
  const block = await loadBlock(db, ctx, request.targetId);
  const idempotencyKey = reviewEventIdempotencyKey(request.id, 'review', request.targetVersionId);

  if (request.status === 'reviewed') {
    // 二重押下: 同じ人が同じ段階を完了済みなら、そのまま返す
    const done = (await eventsOf(db, ctx, request.id)).find(
      (e) => e.idempotencyKey === idempotencyKey && e.eventType === 'review_completed',
    );
    if (done && done.actorUserId === ctx.userId) return request;
  }
  if (request.reviewerUserId && request.reviewerUserId !== ctx.userId) {
    throw new AuthorizationError('この依頼のレビュー担当ではありません。');
  }
  const version = await loadBlockVersion(db, ctx, request.targetVersionId);
  const sod = canCompleteReview({
    actorId: ctx.userId,
    request,
    targetVersionCreatedBy: version.createdBy,
  });
  if (!sod.ok) {
    if (sod.code === 'request_not_open') throw new ValidationError(sod.reason);
    throw new AuthorizationError(sod.reason);
  }
  const major = await unresolvedMajorComments(db, ctx, block.id);
  if (major.length > 0) {
    throw new ReviewBlockedError([
      {
        code: 'unresolved_major_comments',
        message: `未解決の要対応コメントが ${major.length} 件あります。`,
      },
    ]);
  }

  const recorded = await appendEvent(
    db,
    ctx,
    request,
    'review_completed',
    'review',
    idempotencyKey,
  );
  if (!recorded) return request;
  const transition = transitionBlock('complete_review', block.status);
  if (!transition.ok) throw new ValidationError(transition.reason);
  const updated = await setRequestStatus(db, ctx, request, 'reviewed');
  await setBlockStatus(db, ctx, block, { status: 'approval_pending' });
  await notify(
    db,
    ctx,
    request.approverUserId,
    `最終承認の依頼: ${block.title}`,
    `「${block.title}」（版 ${version.versionNo}）のレビューが完了しました。最終承認をお願いします。`,
    blockHref(block),
  );
  await recordAuditEvent(db, ctx, {
    eventType: 'review_completed',
    resourceType: 'review_request',
    resourceId: request.id,
    afterSummary: `${block.title} 版 ${version.versionNo} のレビュー完了`,
    metadata: { blockId: block.id },
  });
  return updated;
}

/** 最終承認の直前に、引用した版が現在の版（または理由付きで維持）かを確かめる（A26） */
export async function assertReferencesStillValid(
  db: DbClient,
  ctx: AuthorizationContext,
  block: DisclosureBlock,
  body: BlockBody,
): Promise<void> {
  const freshness = await computeBlockFreshness(db, ctx, block, body);
  const unresolved = unresolvedFreshnessItems(freshness);
  if (unresolved.length > 0) {
    throw new ReviewBlockedError([
      {
        code: 'stale_metric_refs',
        message: `承認の直前に引用先が更新されています（${unresolved.map((i) => i.label).join('、')}）。差し戻して再確認してください`,
      },
    ]);
  }
}

export async function finalApprove(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { requestId: Uuid },
): Promise<ReviewRequest> {
  // 作成担当（承認権限なし）が直接呼んでもここで止まる（A28）
  assertCan(ctx, 'enterprise.disclosure.approve');
  const request = await loadRequest(db, ctx, input.requestId);
  const block = await loadBlock(db, ctx, request.targetId);
  const idempotencyKey = reviewEventIdempotencyKey(request.id, 'final', request.targetVersionId);
  const events = await eventsOf(db, ctx, request.id);

  if (request.status === 'approved') {
    const done = events.find(
      (e) => e.idempotencyKey === idempotencyKey && e.eventType === 'approved',
    );
    if (done && done.actorUserId === ctx.userId) return request;
  }
  if (request.approverUserId && request.approverUserId !== ctx.userId) {
    throw new AuthorizationError('この依頼の最終承認者ではありません。');
  }
  const version = await loadBlockVersion(db, ctx, request.targetVersionId);
  const sod = canFinalApprove({
    actorId: ctx.userId,
    request,
    targetVersionCreatedBy: version.createdBy,
    reviewCompletedBy: events
      .filter((e) => e.eventType === 'review_completed')
      .map((e) => e.actorUserId),
  });
  if (!sod.ok) {
    if (sod.code === 'request_not_reviewed') throw new ValidationError(sod.reason);
    throw new AuthorizationError(sod.reason);
  }
  const major = await unresolvedMajorComments(db, ctx, block.id);
  if (major.length > 0) {
    throw new ReviewBlockedError([
      {
        code: 'unresolved_major_comments',
        message: `未解決の要対応コメントが ${major.length} 件あります。`,
      },
    ]);
  }
  // 画面のボタンを消すだけでなく、記録する直前にサーバーで確かめ直す
  await assertReferencesStillValid(db, ctx, block, version.body);

  const recorded = await appendEvent(db, ctx, request, 'approved', 'final', idempotencyKey);
  if (!recorded) return request;
  const transition = transitionBlock('approve', block.status);
  if (!transition.ok) throw new ValidationError(transition.reason);
  const updated = await setRequestStatus(db, ctx, request, 'approved');
  await setBlockStatus(db, ctx, block, {
    status: 'approved',
    approvedVersionId: request.targetVersionId,
  });
  await notify(
    db,
    ctx,
    request.requestedBy,
    `承認: ${block.title}`,
    `「${block.title}」（版 ${version.versionNo}）が社内で最終承認されました（第三者保証ではありません）。`,
    blockHref(block),
  );
  await recordAuditEvent(db, ctx, {
    eventType: 'review_approved',
    resourceType: 'review_request',
    resourceId: request.id,
    afterSummary: `${block.title} 版 ${version.versionNo} を最終承認`,
    metadata: { blockId: block.id, versionId: request.targetVersionId },
  });
  return updated;
}

export async function withdrawReview(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { requestId: Uuid; reason?: string | null },
): Promise<ReviewRequest> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const request = await loadRequest(db, ctx, input.requestId);
  const block = await loadBlock(db, ctx, request.targetId);
  if (request.status === 'withdrawn') return request;
  if (request.status !== 'open' && request.status !== 'reviewed') {
    throw new ValidationError('完了したレビュー依頼は取り下げられません。');
  }
  if (request.requestedBy !== ctx.userId && block.ownerUserId !== ctx.userId) {
    throw new AuthorizationError('依頼した本人か節の担当者だけが取り下げられます。');
  }
  const recorded = await appendEvent(
    db,
    ctx,
    request,
    'withdrawn',
    'request',
    `${reviewEventIdempotencyKey(request.id, 'request', request.targetVersionId)}:withdrawn`,
    { reason: input.reason?.trim() || null },
  );
  if (!recorded) return request;
  const transition = transitionBlock('withdraw', block.status);
  if (!transition.ok) throw new ValidationError(transition.reason);
  const updated = await setRequestStatus(db, ctx, request, 'withdrawn');
  await setBlockStatus(db, ctx, block, { status: transition.to });
  await recordAuditEvent(db, ctx, {
    eventType: 'review_withdrawn',
    resourceType: 'review_request',
    resourceId: request.id,
    afterSummary: `${block.title} のレビュー依頼を取下げ`,
    metadata: { blockId: block.id },
  });
  return updated;
}

// ======================================================================
// コメント（版・段落に紐付く）
// ======================================================================

export interface AddReviewCommentInput {
  blockId: Uuid;
  /** 省略時はレビュー中なら提出版、それ以外は現在の版 */
  blockVersionId?: Uuid | null;
  paragraphId?: string | null;
  body: string;
  severity: ReviewCommentSeverity;
}

export const REVIEW_COMMENT_MAX_LENGTH = 2000;

/** 同じ人が同じミリ秒に 2 件書いても ID が重ならないようにする */
let commentSequence = 0;

export async function addReviewComment(
  db: DbClient,
  ctx: AuthorizationContext,
  input: AddReviewCommentInput,
): Promise<ReviewComment> {
  if (!canAny(ctx, ['enterprise.disclosure.write', 'enterprise.disclosure.approve'])) {
    throw new AuthorizationError('コメントするには開示の編集または承認の権限が必要です。');
  }
  const block = await loadBlock(db, ctx, input.blockId);
  const body = input.body.trim();
  if (!body) throw new ValidationError('コメントを入力してください。');
  if (body.length > REVIEW_COMMENT_MAX_LENGTH) {
    throw new ValidationError(
      `コメントは ${REVIEW_COMMENT_MAX_LENGTH} 文字以内で入力してください。`,
    );
  }
  if (input.severity !== 'info' && input.severity !== 'major') {
    throw new ValidationError('コメントの区分が正しくありません。');
  }
  const versionId =
    input.blockVersionId ??
    (block.status === 'review_requested' || block.status === 'approval_pending'
      ? block.submittedVersionId
      : block.currentVersionId);
  if (!versionId) {
    throw new ValidationError('版が無い節にはコメントできません。先に版として保存してください。');
  }
  const version = await loadBlockVersion(db, ctx, versionId);
  if (version.blockId !== block.id) throw new NotFoundError('本文の版が見つかりません。');
  const paragraphId = input.paragraphId?.trim() || null;
  if (paragraphId && !version.body.paragraphs.some((p) => p.id === paragraphId)) {
    throw new ValidationError('コメントの対象の段落が、この版に見つかりません。');
  }

  const now = new Date().toISOString();
  const comment: ReviewComment = {
    id: fid('review_comment', `${block.id}/${ctx.userId}/${now}/${(commentSequence += 1)}`),
    organizationId: ctx.workspace.organizationId,
    blockId: block.id,
    blockVersionId: version.id,
    paragraphId,
    body,
    severity: input.severity,
    createdAt: now,
    createdBy: ctx.userId,
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
  };
  await db.insert('reviewComments', [comment]);
  await notify(
    db,
    ctx,
    block.ownerUserId,
    `コメント: ${block.title}`,
    body.slice(0, 120),
    blockHref(block),
  );
  await recordAuditEvent(db, ctx, {
    eventType: 'comment_created',
    resourceType: 'review_comment',
    resourceId: comment.id,
    afterSummary: `${block.title} にコメント（${input.severity === 'major' ? '要対応' : '参考'}）`,
    metadata: { blockId: block.id, versionId: version.id, paragraphId },
  });
  return comment;
}

export async function resolveReviewComment(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { commentId: Uuid; note?: string | null },
): Promise<ReviewComment> {
  if (!canAny(ctx, ['enterprise.disclosure.write', 'enterprise.disclosure.approve'])) {
    throw new AuthorizationError('コメントを解決するには開示の編集または承認の権限が必要です。');
  }
  const comment = await db.findById('reviewComments', input.commentId);
  if (!comment || comment.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('コメントが見つかりません。');
  }
  if (comment.resolvedAt) return comment;
  const now = new Date().toISOString();
  // 更新できるのは解決の記録だけ（0037 のトリガと同じ）
  const updated = await db.update('reviewComments', comment.id, {
    resolvedAt: now,
    resolvedBy: ctx.userId,
    resolutionNote: input.note?.trim() || null,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'comment_resolved',
    resourceType: 'review_comment',
    resourceId: comment.id,
    metadata: { blockId: comment.blockId },
  });
  return updated;
}

// ======================================================================
// 一覧（プロジェクトのレビュー・自分のレビュー）
// ======================================================================

export interface ReviewListEvent {
  id: Uuid;
  label: string;
  stageLabel: string;
  actorName: string;
  createdAt: IsoDateTime;
  reason: string | null;
  paragraphId: string | null;
}

export interface ReviewListItem {
  id: Uuid;
  projectId: Uuid;
  projectName: string;
  blockId: Uuid;
  blockTitle: string;
  targetVersionNo: number | null;
  status: ReviewRequestStatus;
  statusLabel: string;
  requestedByName: string;
  reviewerName: string;
  approverName: string;
  policyVersion: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  events: ReviewListEvent[];
  /** 自分の段階か（レビュー待ちで自分がレビュー担当／承認待ちで自分が最終承認者） */
  myStage: 'review' | 'final' | null;
}

async function toListItems(
  db: DbClient,
  ctx: AuthorizationContext,
  requests: ReviewRequest[],
): Promise<ReviewListItem[]> {
  if (requests.length === 0) return [];
  const organizationId = ctx.workspace.organizationId;
  const blockIds = [...new Set(requests.map((r) => r.targetId))];
  const projectIds = [...new Set(requests.map((r) => r.projectId))];
  const [members, blocks, projects, rawEvents, versions] = await Promise.all([
    loadMembers(db, ctx),
    db.select('disclosureBlocks', { where: { organizationId, id: { in: blockIds } } }),
    db.select('disclosureProjects', { where: { organizationId, id: { in: projectIds } } }),
    db.select('reviewEvents', {
      where: { organizationId, reviewRequestId: { in: requests.map((r) => r.id) } },
    }),
    db.select('disclosureBlockVersions', {
      where: { organizationId, id: { in: [...new Set(requests.map((r) => r.targetVersionId))] } },
    }),
  ]);
  const events = sortReviewEvents(rawEvents);
  return requests.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    projectName: projects.find((p) => p.id === r.projectId)?.name ?? '—',
    blockId: r.targetId,
    blockTitle: blocks.find((b) => b.id === r.targetId)?.title ?? '（節が見つかりません）',
    targetVersionNo: versions.find((v) => v.id === r.targetVersionId)?.versionNo ?? null,
    status: r.status,
    statusLabel: REVIEW_REQUEST_STATUS_LABELS[r.status],
    requestedByName: nameOf(members, r.requestedBy),
    reviewerName: nameOf(members, r.reviewerUserId),
    approverName: nameOf(members, r.approverUserId),
    policyVersion: r.policyVersion,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    events: events
      .filter((e) => e.reviewRequestId === r.id)
      .map((e) => ({
        id: e.id,
        label: REVIEW_EVENT_TYPE_LABELS[e.eventType],
        stageLabel: REVIEW_STAGE_LABELS[e.stage],
        actorName: nameOf(members, e.actorUserId),
        createdAt: e.createdAt,
        reason: e.reason,
        paragraphId: e.paragraphId,
      })),
    myStage:
      r.status === 'open' && r.reviewerUserId === ctx.userId
        ? 'review'
        : r.status === 'reviewed' && r.approverUserId === ctx.userId
          ? 'final'
          : null,
  }));
}

export async function listProjectReviews(
  db: DbClient,
  ctx: AuthorizationContext,
  projectId: Uuid,
): Promise<ReviewListItem[]> {
  const project = await loadProject(db, ctx, projectId);
  const requests = await db.select('reviewRequests', {
    where: { organizationId: ctx.workspace.organizationId, projectId: project.id },
    orderBy: [{ column: 'updatedAt', dir: 'desc' }, { column: 'id' }],
  });
  return toListItems(db, ctx, requests);
}

export interface MyReviewTasks {
  /** 自分の段階の依頼（レビュー待ちで自分がレビュー担当・承認待ちで自分が最終承認者） */
  awaitingMe: ReviewListItem[];
  /** 自分が依頼して差し戻された節（まだ再依頼していないもの） */
  returnedToMe: ReviewListItem[];
}

export async function listMyReviewTasks(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<MyReviewTasks> {
  if (!can(ctx, 'enterprise.disclosure.read')) return { awaitingMe: [], returnedToMe: [] };
  const organizationId = ctx.workspace.organizationId;
  const [asReviewer, asApprover, returned] = await Promise.all([
    db.select('reviewRequests', {
      where: { organizationId, status: 'open', reviewerUserId: ctx.userId },
    }),
    db.select('reviewRequests', {
      where: { organizationId, status: 'reviewed', approverUserId: ctx.userId },
    }),
    db.select('reviewRequests', {
      where: { organizationId, status: 'returned', requestedBy: ctx.userId },
    }),
  ]);
  const byOldest = (a: ReviewRequest, b: ReviewRequest) =>
    a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.id.localeCompare(b.id);
  // 差戻し後に再依頼した節は「対応済み」なので除く（同じ節に新しい依頼があるもの）
  const returnedBlockIds = [...new Set(returned.map((r) => r.targetId))];
  const blocks = returnedBlockIds.length
    ? await db.select('disclosureBlocks', {
        where: { organizationId, id: { in: returnedBlockIds } },
      })
    : [];
  const stillReturned = returned.filter(
    (r) => blocks.find((b) => b.id === r.targetId)?.status === 'returned',
  );
  const latestPerBlock = new Map<Uuid, ReviewRequest>();
  for (const r of stillReturned) {
    const seen = latestPerBlock.get(r.targetId);
    if (!seen || seen.updatedAt < r.updatedAt) latestPerBlock.set(r.targetId, r);
  }
  return {
    awaitingMe: await toListItems(db, ctx, [...asReviewer, ...asApprover].sort(byOldest)),
    returnedToMe: await toListItems(db, ctx, [...latestPerBlock.values()].sort(byOldest)),
  };
}
