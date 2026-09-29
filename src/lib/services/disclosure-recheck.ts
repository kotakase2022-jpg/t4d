import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, can, NotFoundError } from '@/lib/authorization/can';
import { collectRefs, latestRecheckDecision, paragraphText } from '@/lib/domain/disclosure-block';
import {
  BLOCK_STATUS_LABELS,
  RECHECK_DECISION_LABELS,
  RECHECK_REF_KIND_LABELS,
} from '@/lib/domain/disclosure-status';
import { ValidationError } from '@/lib/errors/user-facing';
import { fid } from '@/lib/fixtures/ids';
import {
  appendBlockVersion,
  approvedDataPointVersionIds,
  contributorsWith,
  currentVersionBody,
  isVersionApproved,
  loadBlock,
  loadMembers,
  metricDisplay,
  nameOf,
  VERSION_UNAVAILABLE_MESSAGE,
} from '@/lib/services/disclosure-block';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  BlockBody,
  BlockInline,
  BlockStatus,
  DisclosureBlock,
  IsoDateTime,
  RecheckDecision,
  RecheckDecisionKind,
  RecheckRefKind,
  Uuid,
} from '@/types/domain';

/**
 * 上流の変更と再確認（docs/disclosure-first.md §2-4、指示書 §10.3・§10.4）。
 *
 * 引用した数値・定性情報に新しい版ができても、承認済みの版・スナップショットは書き換えない。
 * 現在の作業対象（作業本文、無ければ現在の版）に「再確認が必要」を付け、
 * 担当者が「新しい版を採用」「引用中の版を維持（理由付き）」「担当者へ差戻し」を選ぶ。
 * 判断は recheck_decisions に追記する（追記専用）。
 */

export const FRESHNESS_STATUSES = [
  'current',
  'upstream_updated',
  'evidence_invalid',
  'rechecked',
  'version_unavailable',
] as const;
export type FreshnessStatus = (typeof FRESHNESS_STATUSES)[number];

/** 参照の鮮度（指示書 §10.1 の表の表記） */
export const FRESHNESS_LABELS: Record<FreshnessStatus, string> = {
  current: '現行',
  upstream_updated: '上流に新版あり',
  evidence_invalid: '根拠失効',
  rechecked: '再確認済み',
  version_unavailable: '版を読み込めません',
};

export interface FreshnessItem {
  refKind: RecheckRefKind | 'evidence';
  /** 本文が引用している版（evidence は引用位置） */
  oldRefId: Uuid;
  /** 現在の版。根拠失効では null */
  newRefId: Uuid | null;
  label: string;
  oldDisplay: string;
  newDisplay: string | null;
  /** 新しい版の変更理由 */
  changeReason: string | null;
  newApproved: boolean;
  paragraphIds: string[];
  /** この組み合わせ（旧版 → 現在の版）について「引用中の版を維持」と判断済みなら、その記録 */
  keptOld: RecheckDecision | null;
  /** 担当者へ差し戻した記録（再確認は未了のまま） */
  returnedToOwner: RecheckDecision | null;
  /**
   * この項目で選べる判断と、選べない判断の理由（サーバーが decideRecheck と同じ条件で決める）。
   * 画面は選べない判断のフォームを出さず、理由を示す（押してから断られ、入力が消えることを防ぐ）
   */
  decisions: Record<RecheckDecisionKind, { allowed: boolean; reason: string | null }>;
}

export interface BlockFreshness {
  status: FreshnessStatus;
  label: string;
  items: FreshnessItem[];
}

function paragraphsWith(body: BlockBody, match: (inline: BlockInline) => boolean): string[] {
  return body.paragraphs.filter((p) => p.children.some(match)).map((p) => p.id);
}

/**
 * 鮮度を判定する本文（作業本文があればそれ。無ければ現在の版）。
 * 節が版を指しているのにその版を読めない（Demo Mode で別のサーバーが作った版など）ときは null。
 * 空の本文として判定すると、引用が 1 件も無い「現行」と誤って示してしまう
 */
async function freshnessBody(
  db: DbClient,
  ctx: AuthorizationContext,
  block: DisclosureBlock,
  body?: BlockBody,
): Promise<BlockBody | null> {
  if (body) return body;
  if (block.workingBody) return block.workingBody;
  const current = await currentVersionBody(db, ctx, block);
  if (block.currentVersionId && !current.version) return null;
  return current.body;
}

const ALLOWED = { allowed: true, reason: null } as const;
const denied = (reason: string) => ({ allowed: false, reason });

/** 根拠失効（削除された資料・数値）の項目は、どの判断でも解消できない */
const EVIDENCE_DECISIONS: FreshnessItem['decisions'] = {
  adopt_new: denied(
    '削除された資料・数値には新しい版がありません。本文から引用を外して版を作り直してください。',
  ),
  keep_old: denied('失効した資料・削除された数値は維持を選べません。'),
  return_to_owner: denied('根拠の失効は差戻しでは解消しません。本文から引用を外してください。'),
};

/**
 * 節（または指定した本文）の参照の鮮度。
 *  - 現行: 引用した版がすべて現在の版
 *  - 上流に新版あり: 数値・定性情報に新しい版がある（維持の判断が無い）
 *  - 根拠失効: 引用した資料・数値が削除されている（維持の判断では解消できない）
 *  - 再確認済み: 新しい版はあるが、すべて理由付きで維持と判断済み
 */
export async function computeBlockFreshness(
  db: DbClient,
  ctx: AuthorizationContext,
  block: DisclosureBlock,
  body?: BlockBody,
): Promise<BlockFreshness> {
  const organizationId = ctx.workspace.organizationId;
  const target = await freshnessBody(db, ctx, block, body);
  if (target === null) {
    return {
      status: 'version_unavailable',
      label: FRESHNESS_LABELS.version_unavailable,
      items: [],
    };
  }
  const refs = collectRefs(target);
  const decisions = await db.select('recheckDecisions', {
    where: { organizationId, blockId: block.id },
  });
  // レポートの確定（report-snapshot.ts）と同じ規則で判断を引く（domain/disclosure-block.ts）
  const latestDecision = (kind: RecheckRefKind, oldId: Uuid, newId: Uuid) =>
    latestRecheckDecision(decisions, {
      blockId: block.id,
      refKind: kind,
      oldRefId: oldId,
      newRefId: newId,
    });

  const items: FreshnessItem[] = [];

  // 数値
  const metricVersions = await Promise.all(
    refs.metricVersionIds.map((id) => db.findById('dataPointVersions', id)),
  );
  const dpIds = [...new Set(metricVersions.filter((v) => v !== null).map((v) => v!.dataPointId))];
  const approvedIds = await approvedDataPointVersionIds(db, ctx, dpIds);
  const metrics = await db.select('metrics', { where: { organizationId } });
  for (const [index, versionId] of refs.metricVersionIds.entries()) {
    const version = metricVersions[index];
    const paragraphIds = paragraphsWith(
      target,
      (i) => i.t === 'metric' && i.dataPointVersionId === versionId,
    );
    if (!version || version.organizationId !== organizationId) {
      items.push({
        refKind: 'evidence',
        oldRefId: versionId,
        newRefId: null,
        label: '数値の版が見つかりません',
        oldDisplay: '—',
        newDisplay: null,
        changeReason: null,
        newApproved: false,
        paragraphIds,
        keptOld: null,
        returnedToOwner: null,
        decisions: EVIDENCE_DECISIONS,
      });
      continue;
    }
    const dp = await db.findById('dataPoints', version.dataPointId);
    const label = `${metrics.find((m) => m.id === dp?.metricId)?.name ?? '数値'}${dp ? `（${dp.boundary}）` : ''}`;
    if (!dp || dp.deletedAt) {
      items.push({
        refKind: 'evidence',
        oldRefId: versionId,
        newRefId: null,
        label: `${label} は削除されています`,
        oldDisplay: metricDisplay(version),
        newDisplay: null,
        changeReason: null,
        newApproved: false,
        paragraphIds,
        keptOld: null,
        returnedToOwner: null,
        decisions: EVIDENCE_DECISIONS,
      });
      continue;
    }
    if (!dp.currentVersionId || dp.currentVersionId === version.id) continue;
    const current = await db.findById('dataPointVersions', dp.currentVersionId);
    const decision = latestDecision('metric', version.id, dp.currentVersionId);
    const newApproved = current ? isVersionApproved(current, dp, approvedIds) : false;
    items.push({
      decisions: {
        adopt_new: !current
          ? denied('新しい数値の版が見つかりません。')
          : !newApproved
            ? denied(
                `新しい数値の版（版 ${current.versionNo}）はまだ承認されていません。承認されてから採用できます。`,
              )
            : current.availabilityStatus !== 'value_present'
              ? denied(
                  '新しい版に値がありません（未入力・対象外など）。担当者へ差し戻してください。',
                )
              : ALLOWED,
        keep_old: isVersionApproved(version, null, approvedIds)
          ? ALLOWED
          : denied('引用中の数値の版は承認された版ではないため、維持を選べません。'),
        return_to_owner: ALLOWED,
      },
      refKind: 'metric',
      oldRefId: version.id,
      newRefId: dp.currentVersionId,
      label,
      oldDisplay: `${metricDisplay(version)}（版 ${version.versionNo}）`,
      newDisplay: current ? `${metricDisplay(current)}（版 ${current.versionNo}）` : null,
      changeReason: current?.changeReason ?? null,
      newApproved,
      paragraphIds,
      keptOld: decision?.decision === 'keep_old' ? decision : null,
      returnedToOwner: decision?.decision === 'return_to_owner' ? decision : null,
    });
  }

  // 定性情報
  for (const versionId of refs.narrativeVersionIds) {
    const paragraphIds = paragraphsWith(
      target,
      (i) => i.t === 'narrative' && i.narrativeVersionId === versionId,
    );
    const version = await db.findById('narrativeVersions', versionId);
    const record = version
      ? await db.findById('narrativeRecords', version.narrativeRecordId)
      : null;
    if (!version || version.organizationId !== organizationId || !record || record.deletedAt) {
      items.push({
        refKind: 'evidence',
        oldRefId: versionId,
        newRefId: null,
        label: '引用した定性情報が見つかりません（削除された可能性があります）',
        oldDisplay: version?.organizationId === organizationId ? `版 ${version.versionNo}` : '—',
        newDisplay: null,
        changeReason: null,
        newApproved: false,
        paragraphIds,
        keptOld: null,
        returnedToOwner: null,
        decisions: EVIDENCE_DECISIONS,
      });
      continue;
    }
    if (!record.currentVersionId || record.currentVersionId === version.id) continue;
    const current = await db.findById('narrativeVersions', record.currentVersionId);
    const decision = latestDecision('narrative', version.id, record.currentVersionId);
    items.push({
      decisions: {
        adopt_new: current ? ALLOWED : denied('新しい定性情報の版が見つかりません。'),
        keep_old: ALLOWED,
        return_to_owner: ALLOWED,
      },
      refKind: 'narrative',
      oldRefId: version.id,
      newRefId: record.currentVersionId,
      label: record.title,
      oldDisplay: `版 ${version.versionNo}: ${version.body}`,
      newDisplay: current ? `版 ${current.versionNo}: ${current.body}` : null,
      changeReason: current?.changeReason ?? null,
      newApproved: record.confirmedVersionId === record.currentVersionId,
      paragraphIds,
      keptOld: decision?.decision === 'keep_old' ? decision : null,
      returnedToOwner: decision?.decision === 'return_to_owner' ? decision : null,
    });
  }

  // 出典（資料が削除されていれば根拠失効）
  for (const anchorId of refs.anchorIds) {
    const anchor = await db.findById('sourceAnchors', anchorId);
    const fileVersion = anchor ? await db.findById('fileVersions', anchor.fileVersionId) : null;
    const file = fileVersion ? await db.findById('files', fileVersion.fileId) : null;
    if (anchor && anchor.organizationId === organizationId && file && !file.deletedAt) continue;
    items.push({
      refKind: 'evidence',
      oldRefId: anchorId,
      newRefId: null,
      // 別組織の引用位置・資料の名前と位置は出さない（存在も含めて漏らさない。A29）
      label:
        anchor?.organizationId === organizationId && file?.organizationId === organizationId
          ? `資料「${file.originalName}」は削除されています`
          : '出典の資料が見つかりません',
      oldDisplay: anchor?.organizationId === organizationId ? (anchor.locator ?? '—') : '—',
      newDisplay: null,
      changeReason: null,
      newApproved: false,
      paragraphIds: paragraphsWith(target, (i) => i.t === 'cite' && i.sourceAnchorId === anchorId),
      keptOld: null,
      returnedToOwner: null,
      decisions: EVIDENCE_DECISIONS,
    });
  }

  const status: FreshnessStatus = items.some((i) => i.refKind === 'evidence')
    ? 'evidence_invalid'
    : items.some((i) => !i.keptOld)
      ? 'upstream_updated'
      : items.length > 0
        ? 'rechecked'
        : 'current';
  // 失効した根拠があるあいだは、ほかの引用も「維持」で覆い隠せない（decideRecheck と同じ条件）
  const finalItems =
    status === 'evidence_invalid'
      ? items.map((i) =>
          i.refKind === 'evidence'
            ? i
            : {
                ...i,
                decisions: {
                  ...i.decisions,
                  keep_old: denied(
                    '根拠が失効している節では、引用中の版の維持を選べません（先に失効した引用を本文から外してください）。',
                  ),
                },
              },
        )
      : items;
  return { status, label: FRESHNESS_LABELS[status], items: finalItems };
}

/** 未解消の参照（承認・確定を止めるもの）。維持と判断済みの組み合わせは除く */
export function unresolvedFreshnessItems(freshness: BlockFreshness): FreshnessItem[] {
  return freshness.items.filter((i) => i.refKind === 'evidence' || !i.keptOld);
}

// ======================================================================
// 再確認の画面
// ======================================================================

export interface RecheckViewItem extends FreshnessItem {
  refKindLabel: string;
  paragraphs: Array<{ id: string; text: string }>;
}

export interface RecheckView {
  block: {
    id: Uuid;
    projectId: Uuid;
    title: string;
    status: BlockStatus;
    statusLabel: string;
    approvedVersionNo: number | null;
    currentVersionNo: number | null;
  };
  freshness: BlockFreshness;
  items: RecheckViewItem[];
  decisions: Array<{
    id: Uuid;
    refKindLabel: string;
    decisionLabel: string;
    reason: string;
    decidedByName: string;
    decidedAt: IsoDateTime;
  }>;
  canDecide: boolean;
  lockedReason: string | null;
}

export async function getRecheckView(
  db: DbClient,
  ctx: AuthorizationContext,
  blockId: Uuid,
): Promise<RecheckView> {
  const block = await loadBlock(db, ctx, blockId);
  const [freshness, members, decisions, current] = await Promise.all([
    computeBlockFreshness(db, ctx, block),
    loadMembers(db, ctx),
    db.select('recheckDecisions', {
      where: { organizationId: ctx.workspace.organizationId, blockId: block.id },
      orderBy: [{ column: 'decidedAt', dir: 'desc' }, { column: 'id' }],
    }),
    currentVersionBody(db, ctx, block),
  ]);
  const approved = block.approvedVersionId
    ? await db.findById('disclosureBlockVersions', block.approvedVersionId)
    : null;
  const body = block.workingBody ?? current.body;
  const locked = block.status === 'review_requested' || block.status === 'approval_pending';

  return {
    block: {
      id: block.id,
      projectId: block.projectId,
      title: block.title,
      status: block.status,
      statusLabel: BLOCK_STATUS_LABELS[block.status],
      approvedVersionNo: approved?.versionNo ?? null,
      currentVersionNo: current.version?.versionNo ?? null,
    },
    freshness,
    items: freshness.items.map((item) => ({
      ...item,
      refKindLabel: item.refKind === 'evidence' ? '根拠' : RECHECK_REF_KIND_LABELS[item.refKind],
      paragraphs: body.paragraphs
        .filter((p) => item.paragraphIds.includes(p.id))
        .map((p) => ({ id: p.id, text: paragraphText(p) })),
    })),
    decisions: decisions.map((d) => ({
      id: d.id,
      refKindLabel: RECHECK_REF_KIND_LABELS[d.refKind],
      decisionLabel: RECHECK_DECISION_LABELS[d.decision],
      reason: d.reason,
      decidedByName: nameOf(members, d.decidedBy),
      decidedAt: d.decidedAt,
    })),
    canDecide: can(ctx, 'enterprise.disclosure.write') && !locked,
    lockedReason: locked
      ? 'レビュー中の節は再確認の判断ができません。依頼を取り下げるか、差戻し後に判断してください。'
      : null,
  };
}

// ======================================================================
// 再確認の判断
// ======================================================================

export interface DecideRecheckInput {
  blockId: Uuid;
  refKind: RecheckRefKind;
  oldRefId: Uuid;
  decision: RecheckDecisionKind;
  reason: string | null;
}

function replaceRef(
  body: BlockBody,
  refKind: RecheckRefKind,
  oldRefId: Uuid,
  replacement: BlockInline,
): BlockBody {
  return {
    paragraphs: body.paragraphs.map((p) => ({
      ...p,
      children: p.children.map((inline) => {
        if (
          refKind === 'metric' &&
          inline.t === 'metric' &&
          inline.dataPointVersionId === oldRefId
        ) {
          return replacement;
        }
        if (
          refKind === 'narrative' &&
          inline.t === 'narrative' &&
          inline.narrativeVersionId === oldRefId
        ) {
          return replacement;
        }
        return inline;
      }),
    })),
  };
}

export async function decideRecheck(
  db: DbClient,
  ctx: AuthorizationContext,
  input: DecideRecheckInput,
): Promise<{ decision: RecheckDecision; newVersionId: Uuid | null }> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const organizationId = ctx.workspace.organizationId;
  const block = await loadBlock(db, ctx, input.blockId);
  if (block.status === 'review_requested' || block.status === 'approval_pending') {
    throw new ValidationError(
      'レビュー中の節は再確認の判断ができません。依頼を取り下げるか、差戻し後に判断してください。',
    );
  }
  if (!block.currentVersionId) {
    throw new ValidationError('版が無い節には再確認の判断を記録できません。');
  }
  if (!(await currentVersionBody(db, ctx, block)).version) {
    // 版を読めないまま判定すると「既に最新の版を引用しています」と誤って断ってしまう
    throw new NotFoundError(VERSION_UNAVAILABLE_MESSAGE);
  }

  const freshness = await computeBlockFreshness(db, ctx, block);
  const item = freshness.items.find(
    (i) => i.refKind === input.refKind && i.oldRefId === input.oldRefId && i.newRefId,
  );
  if (!item || !item.newRefId) {
    throw new ValidationError('再確認が必要な参照ではありません（既に最新の版を引用しています）。');
  }
  const newRefId = item.newRefId;
  const reason = input.reason?.trim() ?? '';

  let newVersionId: Uuid | null = null;

  if (input.decision === 'keep_old') {
    if (!reason) throw new ValidationError('引用中の版を維持する理由を入力してください。');
    if (freshness.status === 'evidence_invalid') {
      // 失効した資料・削除された数値を「維持」で覆い隠せないようにする（指示書 §10.3）
      throw new ValidationError('根拠が失効している節では、引用中の版の維持を選べません。');
    }
    if (input.refKind === 'metric') {
      const old = await db.findById('dataPointVersions', input.oldRefId);
      const dp = old ? await db.findById('dataPoints', old.dataPointId) : null;
      const approvedIds = dp
        ? await approvedDataPointVersionIds(db, ctx, [dp.id])
        : new Set<Uuid>();
      if (!old || !dp || dp.deletedAt || !isVersionApproved(old, null, approvedIds)) {
        throw new ValidationError(
          '引用中の数値の版は承認された版ではないため、維持を選べません。新しい版を採用してください。',
        );
      }
    } else {
      const old = await db.findById('narrativeVersions', input.oldRefId);
      const record = old ? await db.findById('narrativeRecords', old.narrativeRecordId) : null;
      if (!old || !record || record.deletedAt) {
        throw new ValidationError('引用中の定性情報の版が有効ではないため、維持を選べません。');
      }
    }
  } else if (input.decision === 'return_to_owner') {
    if (!reason) throw new ValidationError('担当者へ差し戻す理由を入力してください。');
    if (block.ownerUserId) {
      const now = new Date().toISOString();
      await db.insert('notifications', [
        {
          id: fid('notification', `recheck/${block.id}/${block.ownerUserId}/${now}`),
          organizationId,
          userId: block.ownerUserId,
          title: `「${block.title}」の引用先に新しい版があります`,
          body: `再確認を依頼されました: ${reason}`,
          category: 'review',
          href: `/enterprise/disclosure-projects/${block.projectId}/blocks/${block.id}/recheck`,
          readAt: null,
          createdAt: now,
        },
      ]);
    }
  } else {
    // 新しい版を採用: 引用先の新しい版で本文を書き換えた新しい版を作る（承認済みの版はそのまま残る）
    let replacement: BlockInline;
    if (input.refKind === 'metric') {
      const next = await db.findById('dataPointVersions', newRefId);
      const dp = next ? await db.findById('dataPoints', next.dataPointId) : null;
      if (!next || !dp || next.organizationId !== organizationId) {
        throw new NotFoundError('新しい数値の版が見つかりません。');
      }
      const approvedIds = await approvedDataPointVersionIds(db, ctx, [dp.id]);
      if (!isVersionApproved(next, dp, approvedIds)) {
        throw new ValidationError(
          '新しい数値の版はまだ承認されていません。承認後に採用してください。',
        );
      }
      if (next.availabilityStatus !== 'value_present') {
        throw new ValidationError(
          '新しい版に値がありません（未入力・対象外など）。担当者へ差し戻してください。',
        );
      }
      replacement = {
        t: 'metric',
        dataPointId: dp.id,
        dataPointVersionId: next.id,
        display: metricDisplay(next),
      };
    } else {
      const next = await db.findById('narrativeVersions', newRefId);
      if (!next || next.organizationId !== organizationId) {
        throw new NotFoundError('新しい定性情報の版が見つかりません。');
      }
      replacement = { t: 'narrative', narrativeVersionId: next.id, quote: next.body };
    }

    const current = await currentVersionBody(db, ctx, block);
    const nextBody = replaceRef(current.body, input.refKind, input.oldRefId, replacement);
    const version = await appendBlockVersion(db, ctx, block, nextBody, {
      changeReason: reason || '引用先の新しい版を採用',
      baseVersionId: block.currentVersionId,
    });
    newVersionId = version.id;
    const now = new Date().toISOString();
    await db.update('disclosureBlocks', block.id, {
      currentVersionId: version.id,
      // 承認済みの節は「承認後に修正」と同じく下書きへ戻す。承認済みの版（approvedVersionId）は変えない
      status: block.status === 'approved' ? 'draft' : block.status,
      // 自動保存中の本文があれば、同じ置き換えをして新しい版を土台にする（利用者の編集を捨てない）
      ...(block.workingBody
        ? {
            workingBody: replaceRef(block.workingBody, input.refKind, input.oldRefId, replacement),
            workingBaseVersionId: version.id,
            workingUpdatedBy: ctx.userId,
            workingContributorIds: contributorsWith(block, ctx.userId),
          }
        : {}),
      updatedAt: now,
      updatedBy: ctx.userId,
    });
  }

  const decidedAt = new Date().toISOString();
  const decision: RecheckDecision = {
    id: fid('recheck_decision', `${block.id}/${input.oldRefId}/${newRefId}/${decidedAt}`),
    organizationId,
    blockId: block.id,
    // 判断の対象は「古い版を引用していた版」（新しい版を作った場合もその前の版）
    blockVersionId: block.currentVersionId,
    refKind: input.refKind,
    oldRefId: input.oldRefId,
    newRefId,
    decision: input.decision,
    reason: reason || '引用先の新しい版を採用',
    decidedBy: ctx.userId,
    decidedAt,
  };
  await db.insert('recheckDecisions', [decision]);
  await recordAuditEvent(db, ctx, {
    eventType: 'recheck_decided',
    resourceType: 'disclosure_block',
    resourceId: block.id,
    afterSummary: `${block.title}: ${RECHECK_DECISION_LABELS[input.decision]}（${item.label}）`,
    metadata: {
      refKind: input.refKind,
      oldRefId: input.oldRefId,
      newRefId,
      decision: input.decision,
      newVersionId,
    },
  });
  return { decision, newVersionId };
}
