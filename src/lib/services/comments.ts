import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, NotFoundError } from '@/lib/authorization/can';
import { fid } from '@/lib/fixtures/ids';
import type { DbClient } from '@/lib/repositories/types';
import type { AuthorizationContext, Comment, Profile, Uuid } from '@/types/domain';

/**
 * コメントとメンション（WF-P0-002）。
 *
 * 本文中の `@表示名` を組織メンバーへ解決して `comments.mentions` に保存し、
 * メンションされた本人へ通知（notifications）を作る。
 * 表示名の空白・全角半角の揺れは正規化して照合する（"青海 太郎" を "@青海太郎" で呼べる）。
 */

export interface MentionCandidate {
  userId: Uuid;
  displayName: string;
}

const normalize = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

/**
 * 本文から `@表示名` を抽出してメンバーへ解決する（純関数）。
 *
 * 正規化後に同名となるメンバー（"田中 太郎" と "田中太郎" など）が複数いる場合は
 * **全員へ通知する**。1 人に絞ると、宛先のつもりだった相手に通知が届かないまま
 * レビューが進んでしまう（取りこぼしより過剰通知の方が安全）。
 */
export function resolveMentions(body: string, members: MentionCandidate[]): Uuid[] {
  const found = new Set<Uuid>();
  // 長い名前から照合する（"@青海太" と "@青海太郎" の誤マッチを防ぐ）
  const sorted = [...members].sort((a, b) => b.displayName.length - a.displayName.length);
  for (const raw of body.matchAll(/@([^\s@,、。]+)/g)) {
    const token = normalize(raw[1] ?? '');
    if (!token) continue;
    for (const m of sorted) {
      if (normalize(m.displayName) === token) found.add(m.userId);
    }
  }
  return [...found];
}

/** 組織のアクティブメンバー（メンション候補）。 */
export async function listMentionCandidates(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<MentionCandidate[]> {
  const memberships = await db.select('memberships', {
    where: { organizationId: ctx.workspace.organizationId, status: 'active' },
  });
  const userIds = memberships.map((m) => m.userId);
  if (userIds.length === 0) return [];
  const profiles = await db.select('profiles', { where: { id: { in: userIds } } });
  return profiles.map((p: Profile) => ({ userId: p.id, displayName: p.displayName }));
}

/** コメント本文の共通検証。遷移コメントなど別経路からも必ずここを通す。 */
export const COMMENT_MAX_LENGTH = 2000;

export function assertValidCommentBody(raw: string): string {
  const body = raw.trim();
  if (!body) throw new Error('コメントを入力してください。');
  if (body.length > COMMENT_MAX_LENGTH) {
    throw new Error(`コメントは ${COMMENT_MAX_LENGTH} 文字以内で入力してください。`);
  }
  return body;
}

export type CommentTarget =
  | { targetType: 'data_point'; targetId: Uuid }
  | { targetType: 'disclosure_response'; targetId: Uuid };

/**
 * コメントを追加し、メンション相手へ通知する。
 * 対象（Data Point / 開示回答）が自組織のものであることを必ず確認する
 * （Demo Mode の DbClient に行レベル防御は無いため）。
 */
export async function addComment(
  db: DbClient,
  ctx: AuthorizationContext,
  input: CommentTarget & { body: string; href: string },
): Promise<Comment> {
  // 権限は対象の種別に合わせる。開示回答へのコメントに data.read だけを要求すると、
  // 開示画面を閲覧できないロールが Server Action 直叩きで書き込めてしまう。
  assertCan(
    ctx,
    input.targetType === 'data_point' ? 'enterprise.data.read' : 'enterprise.disclosure.read',
  );
  const body = assertValidCommentBody(input.body);

  const organizationId = ctx.workspace.organizationId;
  if (input.targetType === 'data_point') {
    const dp = await db.findById('dataPoints', input.targetId);
    if (!dp || dp.deletedAt || dp.organizationId !== organizationId) {
      throw new NotFoundError('データが見つかりません。');
    }
  } else {
    const response = await db.findById('disclosureResponses', input.targetId);
    if (!response || response.organizationId !== organizationId) {
      throw new NotFoundError('回答が見つかりません。');
    }
  }

  const members = await listMentionCandidates(db, ctx);
  const mentions = resolveMentions(body, members);
  const now = new Date().toISOString();

  const comment: Comment = {
    id: fid('comment', `${input.targetId}/${ctx.userId}/${now}`),
    organizationId,
    targetType: input.targetType,
    targetId: input.targetId,
    body,
    authorUserId: ctx.userId,
    visibility: 'internal',
    mentions,
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  };
  await db.insert('comments', [comment]);

  await notifyMentions(db, ctx, { mentions, body, href: input.href });

  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'comment',
    resourceId: comment.id,
    afterSummary: `コメントを追加（メンション ${mentions.length} 件）`,
  });

  return comment;
}

/** メンションされた本人へアプリ内通知を作る（自分自身へは通知しない）。 */
export async function notifyMentions(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { mentions: Uuid[]; body: string; href: string },
): Promise<void> {
  const targets = input.mentions.filter((userId) => userId !== ctx.userId);
  if (targets.length === 0) return;
  const now = new Date().toISOString();
  await db.insert(
    'notifications',
    targets.map((userId) => ({
      id: fid('notification', `mention/${userId}/${now}/${input.href}`),
      organizationId: ctx.workspace.organizationId,
      userId,
      title: `${ctx.displayName} さんからメンションされました`,
      body: input.body.slice(0, 140),
      category: 'review' as const,
      href: input.href,
      readAt: null,
      createdAt: now,
    })),
  );
}
