import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import {
  assertCan,
  assertUnitInScope,
  AuthorizationError,
  can,
  NotFoundError,
} from '@/lib/authorization/can';
import { contentHash, fid } from '@/lib/fixtures/ids';
import {
  assertValidCommentBody,
  listMentionCandidates,
  notifyMentions,
  resolveMentions,
} from '@/lib/services/comments';
import { recomputePeriodValidations } from '@/lib/services/validation-store';
import type { DbClient } from '@/lib/repositories/types';
import type {
  Approval,
  AuthorizationContext,
  DataPoint,
  DataPointStatus,
  DataPointVersion,
  Uuid,
} from '@/types/domain';

/**
 * Data Point のワークフロー（指示書 7.1-11 / 15.3）。
 *
 * 状態遷移:
 *   not_started → draft → submitted → in_review → approved
 *                                   ↘ returned → draft
 *
 * 権限:
 *   draft/submitted  : enterprise.data.write（+ Unit スコープ）
 *   in_review/returned: enterprise.data.review
 *   approved         : enterprise.data.approve
 *
 * DB 側でも同じ制約を掛けている（0012 の RLS と 0014 のトリガ）。
 */

const ALLOWED_TRANSITIONS: Record<DataPointStatus, DataPointStatus[]> = {
  not_started: ['draft'],
  draft: ['submitted'],
  submitted: ['in_review', 'returned', 'approved'],
  in_review: ['approved', 'returned'],
  returned: ['draft', 'submitted'],
  approved: ['in_review'],
};

export function canTransition(from: DataPointStatus, to: DataPointStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

function permissionForStatus(status: DataPointStatus): Parameters<typeof assertCan>[1] {
  switch (status) {
    case 'approved':
      return 'enterprise.data.approve';
    case 'in_review':
    case 'returned':
      return 'enterprise.data.review';
    default:
      return 'enterprise.data.write';
  }
}

async function loadOwned(
  db: DbClient,
  ctx: AuthorizationContext,
  dataPointId: Uuid,
): Promise<DataPoint> {
  const dp = await db.findById('dataPoints', dataPointId);
  if (!dp || dp.organizationId !== ctx.workspace.organizationId || dp.deletedAt) {
    throw new NotFoundError('Data Point が見つかりません。');
  }
  return dp;
}

/**
 * 検証結果を再計算して materialize する。
 * 行をまたぐルールを含むため対象期間分をまとめて再計算する。
 */
async function revalidatePeriodOf(
  db: DbClient,
  ctx: AuthorizationContext,
  dataPoint: DataPoint,
): Promise<void> {
  const period = await db.findById('periods', dataPoint.reportingPeriodId);
  if (period) await recomputePeriodValidations(db, ctx, period);
}

export interface TransitionInput {
  dataPointId: Uuid;
  to: DataPointStatus;
  comment?: string | null;
  /** 一括操作では最後に 1 回だけ再計算するため、個別呼び出しでは抑止する。 */
  skipRevalidate?: boolean;
}

export async function transitionDataPoint(
  db: DbClient,
  ctx: AuthorizationContext,
  input: TransitionInput,
): Promise<DataPoint> {
  const dp = await loadOwned(db, ctx, input.dataPointId);
  assertCan(ctx, permissionForStatus(input.to));
  assertUnitInScope(ctx, dp.unitId);

  if (!canTransition(dp.status, input.to)) {
    throw new AuthorizationError(`${dp.status} から ${input.to} への遷移は許可されていません。`);
  }

  // 承認には Evidence 必須指標の Evidence が揃っている必要がある
  if (input.to === 'approved') {
    const metric = await db.findById('metrics', dp.metricId);
    if (metric?.requiresEvidence) {
      const links = await db.select('evidenceLinks', {
        where: { targetType: 'data_point', targetId: dp.id },
        limit: 1,
      });
      if (links.length === 0) {
        throw new AuthorizationError(
          'この指標は Evidence が必須です。Evidence を紐付けてから承認してください。',
        );
      }
    }
  }

  const now = new Date().toISOString();
  const updated = await db.update('dataPoints', dp.id, {
    status: input.to,
    approvedAt: input.to === 'approved' ? now : null,
    approvedBy: input.to === 'approved' ? ctx.userId : null,
    reviewerUserId:
      input.to === 'in_review' || input.to === 'returned' ? ctx.userId : dp.reviewerUserId,
    changedAfterApproval: input.to === 'approved' ? false : dp.changedAfterApproval,
    updatedAt: now,
    updatedBy: ctx.userId,
  });

  if (input.to === 'approved' || input.to === 'returned') {
    const approval: Approval = {
      id: fid('approval', `${dp.id}/${input.to}/${now}`),
      organizationId: dp.organizationId,
      targetType: 'data_point',
      targetId: dp.id,
      targetVersionId: dp.currentVersionId,
      stage: input.to === 'approved' ? 'final' : 'review',
      decision: input.to === 'approved' ? 'approved' : 'returned',
      actorUserId: ctx.userId,
      comment: input.comment ?? null,
      decidedAt: now,
    };
    await db.insert('approvals', [approval]);
  }

  // 空白だけの入力は「コメント無し」として扱う（差戻しフォームで空欄のまま押しても
  // 例外にしない）。中身がある場合だけ、通常コメントと同じ検証を通す。
  if (input.comment && input.comment.trim()) {
    const commentBody = assertValidCommentBody(input.comment);
    // 遷移時コメントも @メンションを解決して本人へ通知する（WF-P0-002）
    const members = await listMentionCandidates(db, ctx);
    const mentions = resolveMentions(commentBody, members);
    await db.insert('comments', [
      {
        id: fid('comment', `${dp.id}/${now}`),
        organizationId: dp.organizationId,
        targetType: 'data_point',
        targetId: dp.id,
        body: commentBody,
        authorUserId: ctx.userId,
        visibility: 'internal',
        mentions,
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    ]);
    await notifyMentions(db, ctx, {
      mentions,
      body: commentBody,
      href: `/enterprise/data/${dp.id}`,
    });
  }

  await recordAuditEvent(db, ctx, {
    eventType:
      input.to === 'approved'
        ? 'data_approved'
        : input.to === 'returned'
          ? 'data_returned'
          : input.to === 'submitted'
            ? 'data_submitted'
            : 'data_updated',
    resourceType: 'data_point',
    resourceId: dp.id,
    beforeSummary: `status=${dp.status}`,
    afterSummary: `status=${input.to}`,
  });

  // 承認後変更フラグや Evidence 不足の解消など、状態遷移で検証結果が変わりうる
  if (!input.skipRevalidate) await revalidatePeriodOf(db, ctx, updated);

  return updated;
}

export interface UpdateValueInput {
  dataPointId: Uuid;
  value: number | null;
  unitOfMeasure: string;
  methodology?: string | null;
  changeReason: string;
}

/** 値を更新し、必ず新しい Version を追記する（履歴を上書きしない）。 */
export async function updateDataPointValue(
  db: DbClient,
  ctx: AuthorizationContext,
  input: UpdateValueInput,
): Promise<{ dataPoint: DataPoint; version: DataPointVersion }> {
  const dp = await loadOwned(db, ctx, input.dataPointId);
  assertCan(ctx, 'enterprise.data.write');
  assertUnitInScope(ctx, dp.unitId);

  // DB 側トリガ（t4d.enforce_data_point_transition）と同じ判定にする。
  // ロール名ではなく権限で判定すること（ロールは組織ごとに増えうるため）。
  const canEditApproved = can(ctx, 'enterprise.data.review') || can(ctx, 'enterprise.data.approve');
  if (dp.status === 'approved' && !canEditApproved) {
    throw new AuthorizationError(
      '承認済みデータの変更にはレビュー権限が必要です。レビュー担当へ差戻しを依頼してください。',
    );
  }

  const versions = await db.select('dataPointVersions', {
    where: { dataPointId: dp.id },
    orderBy: { column: 'versionNo', dir: 'desc' },
    limit: 1,
  });
  const nextVersionNo = (versions[0]?.versionNo ?? 0) + 1;
  const now = new Date().toISOString();

  const version: DataPointVersion = {
    id: fid('data_point_version', `${dp.id}/v${nextVersionNo}`),
    dataPointId: dp.id,
    organizationId: dp.organizationId,
    versionNo: nextVersionNo,
    value: input.value,
    textValue: null,
    unitOfMeasure: input.unitOfMeasure,
    status: dp.status === 'approved' ? 'draft' : dp.status,
    sourceType: 'manual',
    sourceReference: '画面からの手入力',
    changeReason: input.changeReason,
    contentHash: contentHash(`${dp.id}|${nextVersionNo}|${input.value}|${input.unitOfMeasure}`),
    createdAt: now,
    createdBy: ctx.userId,
  };
  await db.insert('dataPointVersions', [version]);

  const dataPoint = await db.update('dataPoints', dp.id, {
    value: input.value,
    unitOfMeasure: input.unitOfMeasure,
    methodology: input.methodology ?? dp.methodology,
    currentVersionId: version.id,
    status: dp.status === 'approved' ? 'draft' : dp.status === 'not_started' ? 'draft' : dp.status,
    changedAfterApproval: dp.status === 'approved' ? true : dp.changedAfterApproval,
    updatedAt: now,
    updatedBy: ctx.userId,
  });

  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'data_point',
    resourceId: dp.id,
    beforeSummary: `${dp.value ?? '—'} ${dp.unitOfMeasure}`,
    afterSummary: `${input.value ?? '—'} ${input.unitOfMeasure}（v${nextVersionNo}）`,
    metadata: { changeReason: input.changeReason },
  });

  await revalidatePeriodOf(db, ctx, dataPoint);

  return { dataPoint, version };
}

/** 一括の状態遷移（一覧の Bulk Submit 等）。失敗した行はスキップして理由を返す。 */
export async function bulkTransition(
  db: DbClient,
  ctx: AuthorizationContext,
  dataPointIds: Uuid[],
  to: DataPointStatus,
): Promise<{ succeeded: number; failures: Array<{ id: Uuid; reason: string }> }> {
  let succeeded = 0;
  const failures: Array<{ id: Uuid; reason: string }> = [];
  let last: DataPoint | null = null;

  for (const id of dataPointIds) {
    try {
      // 件数分の再計算を避けるため、ここでは抑止して最後に 1 回だけ行う
      last = await transitionDataPoint(db, ctx, { dataPointId: id, to, skipRevalidate: true });
      succeeded += 1;
    } catch (error) {
      failures.push({ id, reason: error instanceof Error ? error.message : '不明なエラー' });
    }
  }

  if (last) await revalidatePeriodOf(db, ctx, last);
  return { succeeded, failures };
}

/** Evidence を Data Point へ紐付ける。 */
export async function linkEvidence(
  db: DbClient,
  ctx: AuthorizationContext,
  input: {
    dataPointId: Uuid;
    fileVersionId: Uuid;
    page?: number | null;
    cellRef?: string | null;
    note?: string | null;
  },
): Promise<void> {
  assertCan(ctx, 'enterprise.evidence.write');
  const dp = await loadOwned(db, ctx, input.dataPointId);
  assertUnitInScope(ctx, dp.unitId);

  const fileVersion = await db.findById('fileVersions', input.fileVersionId);
  if (!fileVersion || fileVersion.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('Evidence ファイルが見つかりません。');
  }

  const now = new Date().toISOString();
  await db.insert('evidenceLinks', [
    {
      id: fid('evidence_link', `${dp.id}/${input.fileVersionId}/${input.page ?? 'x'}`),
      organizationId: dp.organizationId,
      fileVersionId: input.fileVersionId,
      targetType: 'data_point',
      targetId: dp.id,
      page: input.page ?? null,
      cellRef: input.cellRef ?? null,
      fragmentId: null,
      sourceUrl: null,
      coveragePeriodStart: null,
      coveragePeriodEnd: null,
      obtainedAt: now.slice(0, 10),
      note: input.note ?? null,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    },
  ]);

  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'evidence_link',
    resourceId: dp.id,
    afterSummary: `Evidence を紐付け（file_version=${input.fileVersionId.slice(0, 8)}）`,
  });
}
