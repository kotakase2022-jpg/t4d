import 'server-only';

import { randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import {
  AuthorizationError,
  assertCan,
  assertEnterpriseWorkspace,
  NotFoundError,
} from '@/lib/authorization/can';
import { itemVerdict } from '@/lib/domain/ghg/attribution';
import { ValidationError } from '@/lib/errors/user-facing';
import { DEMO_GHG_LIMITS } from '@/lib/repositories/demo-ghg-checks';
import type { DbClient } from '@/lib/repositories/types';
import { statusLabel } from '@/lib/ui/status/registry';
import { isUuid } from '@/lib/validation/uuid';
import {
  GHG_CAUSES,
  type AuthorizationContext,
  type GhgCause,
  type GhgReconciliationNote,
  type ReconciliationItem,
  type Uuid,
} from '@/types/domain';
import { loadReconciliation } from './reconciliation';

/**
 * 差異の原因の確認の記録（plan §2.3 reconciliation-notes.ts・CR-13）。
 *
 *  - 記録は enterprise.data.review。名義は本人（decided_by ＝ 操作した人。RLS も同じ）
 *  - 追記専用。同じ項目に記録し直すと、前の記録を差し替える新しい記録になる（前の記録は履歴に残る）
 *  - 「その他」と「原因不明（残差）」の項目はコメントが必須（何を確かめたかを残す）
 *  - 原因は人が決める。照合の主な原因（寄与の最も大きい原因）は候補にすぎない。AI は関与しない
 * 監査ログは既存の種類（確認の記録＝data_created）。
 */

/** コメントの上限（DB 1,000 字。Demo は Cookie の都合で 200 字） */
export const NOTE_COMMENT_MAX = 1000;

export function noteCommentLimit(db: Pick<DbClient, 'mode'>): number {
  return db.mode === 'demo' ? DEMO_GHG_LIMITS.noteComment : NOTE_COMMENT_MAX;
}

/** 記録の時点の判定が「原因不明（残差）」の項目（確認の記録を数えない判定） */
export function isResidualItem(
  item: Pick<
    ReconciliationItem,
    'key' | 'withinTolerance' | 'oneSided' | 'mainCause' | 'residual' | 'diff'
  >,
): boolean {
  return itemVerdict(item, []) === 'unexplained';
}

/** 記録の可否（行の操作の出し分けに使う） */
export function notePermissionReason(ctx: AuthorizationContext): string | null {
  try {
    assertEnterpriseWorkspace(ctx);
    assertCan(ctx, 'enterprise.data.review');
    return null;
  } catch (error) {
    return error instanceof AuthorizationError
      ? error.message
      : '差異の原因を記録する権限がありません。';
  }
}

export interface RecordCauseInput {
  reconciliationId: Uuid;
  itemKey: string;
  cause: string;
  comment: string;
}

/** 項目の差異の原因を記録する */
export async function recordCause(
  db: DbClient,
  ctx: AuthorizationContext,
  input: RecordCauseInput,
): Promise<GhgReconciliationNote> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.review');
  if (!(GHG_CAUSES as readonly string[]).includes(input.cause)) {
    throw new ValidationError('原因を選んでください。');
  }
  const cause = input.cause as GhgCause;
  const comment = input.comment.trim();
  const limit = noteCommentLimit(db);
  if (comment.length > limit) {
    throw new ValidationError(`コメントは ${limit} 字までです。`);
  }
  if (!isUuid(input.reconciliationId)) throw new NotFoundError('照合の記録が見つかりません。');
  const loaded = await loadReconciliation(db, ctx, input.reconciliationId);
  if (!loaded.items) {
    throw new ValidationError(
      'この照合は結果を作り直せないため（入力が変わった・照合の規則の版が違う）、原因を記録できません。照合し直してください。',
    );
  }
  const item = loaded.items.find((i) => i.key === input.itemKey);
  if (!item) throw new NotFoundError('照合の項目が見つかりません。');
  if (cause === 'other' && comment === '') {
    throw new ValidationError('原因が「その他」のときは、何が原因かをコメントに書いてください。');
  }
  if (isResidualItem(item) && comment === '') {
    throw new ValidationError(
      `「${statusLabel('ghgCause', 'residual')}」の項目は、何を確かめて原因を決めたかをコメントに書いてください。`,
    );
  }
  if (db.mode === 'demo') {
    const existing = await db.select('ghgReconciliationNotes', {
      where: { organizationId: ctx.workspace.organizationId },
    });
    if (existing.length >= DEMO_GHG_LIMITS.notes) {
      throw new ValidationError(
        `デモでは原因の確認の記録は ${DEMO_GHG_LIMITS.notes} 件までです。開示デモを初期状態に戻してから記録してください。`,
      );
    }
  }
  const row: GhgReconciliationNote = {
    id: randomUUID(),
    organizationId: ctx.workspace.organizationId,
    reconciliationId: loaded.reconciliation.id,
    itemKey: item.key,
    confirmedCause: cause,
    comment,
    decidedBy: ctx.userId,
    decidedAt: new Date().toISOString(),
    supersedesId: item.latestNote?.id ?? null,
  };
  const [inserted] = await db.insert('ghgReconciliationNotes', [row]);
  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'ghg_reconciliation_note',
    resourceId: row.id,
    afterSummary: `照合の項目の差異の原因を「${statusLabel('ghgCause', cause)}」と記録${row.supersedesId ? '（前の記録を差し替え）' : ''}`,
    metadata: {
      reconciliationId: row.reconciliationId,
      itemKey: row.itemKey,
      supersedesId: row.supersedesId,
    },
  });
  return inserted ?? row;
}
