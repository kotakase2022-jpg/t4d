import 'server-only';

import { randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import {
  NotFoundError,
  assertAssuranceWorkspace,
  assertCan,
  assertEngagementMember,
  assertEnterpriseWorkspace,
} from '@/lib/authorization/can';
import { copyHasMetric, copyHasParagraph, parseSharedReportCopy } from '@/lib/domain/report-copy';
import { ValidationError } from '@/lib/errors/user-facing';
import type { ClientNoteState } from '@/lib/ui/status/clientNote';
import { DEMO_TEXT_LIMITS } from '@/lib/repositories/demo-trial-checks';
import type { DbClient } from '@/lib/repositories/types';
import { isUuid } from '@/lib/validation/uuid';
import type {
  AuthorizationContext,
  Engagement,
  ReportNoteTargetType,
  ReviewNote,
  ReviewNoteResponse,
  Uuid,
} from '@/types/domain';

/**
 * 保証側のコメント（共有レポートの段落・数値）と企業側の回答（トライアル対応 NF-21 の中核）。
 *
 *  - 起票は保証側（assurance.review.write・案件のメンバー）。対象は共有中の写しの段落・数値に限る。
 *    既定は法人内部限定（クライアントへ共有するかは起票者が選ぶ）
 *  - 企業はクライアントへ共有されたコメントだけを読める。review_notes は監査法人の行なので企業は更新しない。
 *    回答は追記専用の review_note_responses に書き（enterprise.disclosure.write・本人名義）、
 *    「未回答／回答済み／クリア」は回答の有無と保証側の状態から導く
 *  - 本文は Demo Mode で 400 字まで（Cookie の容量。Supabase Mode は 2,000 字）
 *
 * 権限は ID の検索より先に確かめる。他の案件・他テナントの ID は「見つからない」。
 */

/** 本文の上限（Demo Mode は Cookie に載せるため短くする） */
export function noteBodyLimit(ctx: Pick<AuthorizationContext, 'demo'>): number {
  return ctx.demo ? DEMO_TEXT_LIMITS.note : 2000;
}

function cleanBody(ctx: AuthorizationContext, value: string, label: string): string {
  const body = value.trim();
  if (body === '') throw new ValidationError(`${label}を入力してください。`);
  const limit = noteBodyLimit(ctx);
  if (body.length > limit) {
    throw new ValidationError(`${label}は ${limit} 字以内で入力してください。`);
  }
  return body;
}

export type ReportNoteTarget =
  | { kind: 'report_paragraph'; blockId: Uuid; paragraphId: string }
  | { kind: 'report_metric'; dataPointVersionId: Uuid };

/** 企業側から見たコメントの状態（未回答／回答済み／クリア） */
export function clientNoteStateOf(
  note: Pick<ReviewNote, 'status'>,
  responses: readonly Pick<ReviewNoteResponse, 'id'>[],
): ClientNoteState {
  if (note.status === 'cleared') return 'cleared';
  return responses.length > 0 ? 'answered' : 'unanswered';
}

/** 保証側: 共有レポートの段落・数値にコメントを起票する */
export async function createReportNote(
  db: DbClient,
  ctx: AuthorizationContext,
  input: {
    engagementId: Uuid;
    copyId: Uuid;
    target: ReportNoteTarget;
    body: string;
    sharedWithClient: boolean;
    assignedTo?: Uuid | null;
  },
): Promise<ReviewNote> {
  assertAssuranceWorkspace(ctx);
  assertCan(ctx, 'assurance.review.write');
  assertEngagementMember(ctx, input.engagementId);
  const body = cleanBody(ctx, input.body, 'コメント');
  const copy = isUuid(input.copyId) ? await db.findById('sharedReportCopies', input.copyId) : null;
  if (!copy || copy.engagementId !== input.engagementId || copy.withdrawnAt !== null) {
    throw new NotFoundError('開示レポートが見つかりません。');
  }
  const content = parseSharedReportCopy(copy.copy);
  if (!content) throw new NotFoundError('開示レポートが見つかりません。');
  const target = input.target;
  if (
    target.kind === 'report_paragraph'
      ? !copyHasParagraph(content, target.blockId, target.paragraphId)
      : !copyHasMetric(content, target.dataPointVersionId)
  ) {
    throw new ValidationError('コメントの対象（段落・数値）が開示レポートにありません。');
  }
  if (input.assignedTo) {
    const members = await db.select('engagementMembers', {
      where: {
        engagementId: input.engagementId,
        userId: input.assignedTo,
        removedAt: { isNull: true },
      },
    });
    if (members.length === 0)
      throw new ValidationError('担当者は案件のメンバーから選んでください。');
  }

  const now = new Date().toISOString();
  const row: ReviewNote = {
    id: randomUUID(),
    engagementId: input.engagementId,
    assuranceFirmId: copy.assuranceFirmId,
    targetType: target.kind satisfies ReportNoteTargetType,
    targetId: copy.id,
    body,
    raisedBy: ctx.userId,
    assignedTo: input.assignedTo ?? null,
    status: 'open',
    // 既定は法人内部限定（クライアントへ共有するかは起票者が選ぶ）
    sharedWithClient: input.sharedWithClient,
    resolutionComment: null,
    resolvedAt: null,
    targetCopyId: copy.id,
    targetBlockId: target.kind === 'report_paragraph' ? target.blockId : null,
    targetParagraphId: target.kind === 'report_paragraph' ? target.paragraphId : null,
    targetDataPointVersionId: target.kind === 'report_metric' ? target.dataPointVersionId : null,
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  };
  const [inserted] = await db.insert('reviewNotes', [row]);
  await recordAuditEvent(db, ctx, {
    eventType: 'review_note_created',
    resourceType: 'review_note',
    resourceId: row.id,
    engagementId: input.engagementId,
    afterSummary: `開示レポートの${target.kind === 'report_paragraph' ? '段落' : '数値'}にコメント${input.sharedWithClient ? '（クライアントへ共有）' : ''}`,
    metadata: { copyId: copy.id, targetType: target.kind },
  });
  return inserted ?? row;
}

export interface ClientNoteEntry {
  note: ReviewNote;
  engagement: Pick<Engagement, 'id' | 'code' | 'name'>;
  responses: ReviewNoteResponse[];
  state: ClientNoteState;
}

/** 企業側: クライアントへ共有されたコメントの一覧（自社がクライアントの案件だけ） */
export async function listNotesForClient(
  db: DbClient,
  ctx: AuthorizationContext,
  options: { engagementId?: Uuid | null; copyId?: Uuid | null } = {},
): Promise<ClientNoteEntry[]> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.read');
  const engagements = await db.select('engagements', {
    where: { clientOrganizationId: ctx.workspace.organizationId },
  });
  const ids = engagements
    .filter((e) => !options.engagementId || e.id === options.engagementId)
    .map((e) => e.id);
  if (ids.length === 0) return [];
  const notes = (
    await db.select('reviewNotes', {
      where: { engagementId: { in: ids }, sharedWithClient: true },
      orderBy: [
        { column: 'createdAt', dir: 'desc' },
        { column: 'id', dir: 'desc' },
      ],
    })
  ).filter((n) => !options.copyId || n.targetCopyId === options.copyId);
  const responses =
    notes.length > 0
      ? await db.select('reviewNoteResponses', {
          where: { reviewNoteId: { in: notes.map((n) => n.id) } },
          orderBy: [{ column: 'respondedAt' }, { column: 'id' }],
        })
      : [];
  return notes.map((note) => {
    const own = responses.filter((r) => r.reviewNoteId === note.id);
    const engagement = engagements.find((e) => e.id === note.engagementId)!;
    return {
      note,
      engagement: { id: engagement.id, code: engagement.code, name: engagement.name },
      responses: own,
      state: clientNoteStateOf(note, own),
    };
  });
}

/** 企業側: クライアントへ共有されたコメントに回答する（追記。保証側の行は更新しない） */
export async function respondToNote(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { noteId: Uuid; body: string },
): Promise<ReviewNoteResponse> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.write');
  const body = cleanBody(ctx, input.body, '回答');
  const note = isUuid(input.noteId) ? await db.findById('reviewNotes', input.noteId) : null;
  const engagement = note ? await db.findById('engagements', note.engagementId) : null;
  // 共有されていないコメント・他社の案件のコメントは存在を秘匿する
  if (
    !note ||
    !note.sharedWithClient ||
    !engagement ||
    engagement.clientOrganizationId !== ctx.workspace.organizationId
  ) {
    throw new NotFoundError('コメントが見つかりません。');
  }
  if (note.status === 'cleared') {
    throw new ValidationError('このコメントは保証側でクリア済みです。');
  }
  const row: ReviewNoteResponse = {
    id: randomUUID(),
    reviewNoteId: note.id,
    engagementId: note.engagementId,
    clientOrganizationId: ctx.workspace.organizationId,
    body,
    // RLS は responded_by = auth.uid() を求める
    respondedBy: ctx.userId,
    respondedAt: new Date().toISOString(),
  };
  const [inserted] = await db.insert('reviewNoteResponses', [row]);
  await recordAuditEvent(db, ctx, {
    eventType: 'review_note_responded',
    resourceType: 'review_note',
    resourceId: note.id,
    engagementId: note.engagementId,
    afterSummary: '保証側のコメントに回答',
  });
  return inserted ?? row;
}

export interface FirmNoteEntry {
  note: ReviewNote;
  responses: ReviewNoteResponse[];
  state: ClientNoteState;
}

/** 保証側: 共有レポート（写し）に起票したコメントと企業の回答（案件のメンバーだけ） */
export async function listNotesForCopy(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { engagementId: Uuid; copyId: Uuid },
): Promise<FirmNoteEntry[]> {
  assertAssuranceWorkspace(ctx);
  assertCan(ctx, 'assurance.engagement.read');
  assertEngagementMember(ctx, input.engagementId);
  const notes = await db.select('reviewNotes', {
    where: { engagementId: input.engagementId, targetCopyId: input.copyId },
    orderBy: [
      { column: 'createdAt', dir: 'asc' },
      { column: 'id', dir: 'asc' },
    ],
  });
  const responses =
    notes.length > 0
      ? await db.select('reviewNoteResponses', {
          where: { reviewNoteId: { in: notes.map((n) => n.id) } },
          orderBy: [{ column: 'respondedAt' }, { column: 'id' }],
        })
      : [];
  return notes.map((note) => {
    const own = responses.filter((r) => r.reviewNoteId === note.id);
    return { note, responses: own, state: clientNoteStateOf(note, own) };
  });
}
