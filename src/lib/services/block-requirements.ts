import 'server-only';

import { recordAiDecision } from '@/lib/ai';
import type { RequirementMappingSuggestionOutput } from '@/lib/ai/schemas';
import { recordAuditEvent } from '@/lib/audit/logger';
import { NotFoundError, assertCan, assertEnterpriseWorkspace } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { DEMO_TEXT_LIMITS } from '@/lib/repositories/demo-trial-checks';
import type { DbClient } from '@/lib/repositories/types';
import { isUuid } from '@/lib/validation/uuid';
import type {
  AiRun,
  AuthorizationContext,
  DisclosureBlock,
  DisclosureItem,
  Uuid,
} from '@/types/domain';

/**
 * 原稿の節と要求事項の対応付けの編集（トライアル対応 NF-05）と、AI の対応候補の採用（NF-11 の節）。
 *
 *  - 対応付けは disclosure_blocks.requirement_item_ids（既存の列）。全項目が節の基準の版に属すること
 *    （DB のトリガ t4d.block_requirement_items_guard と同じ規則）
 *  - 承認済みの版がある節の対応付けを変えるときは理由が必須（監査ログに前後と理由を残す）。
 *    本文・承認・**承認済みスナップショットは変えない**（スナップショットは固定時の要求事項を持っている）
 *  - 権限: enterprise.disclosure.write（ID の検索より先に確かめ、他の組織は「見つかりません」）
 *  - AI の候補は ai_runs の出力のまま。採用は人の操作でだけ対応付けに入る（AI は確定しない）
 */

export const BLOCK_REQUIREMENT_LIMIT = 200;

export interface RequirementOption {
  id: Uuid;
  code: string;
  section: string;
  title: string;
}

/** 理由の上限（Demo Mode は Cookie の容量に合わせる） */
export function mappingReasonLimit(ctx: AuthorizationContext): number {
  return ctx.demo ? DEMO_TEXT_LIMITS.note : 2000;
}

/** 承認済みの版がある（承認後の変更を含む）節か。対応付けの変更に理由が要る */
export function blockNeedsMappingReason(
  block: Pick<DisclosureBlock, 'status' | 'approvedVersionId'>,
): boolean {
  return block.status === 'approved' || block.approvedVersionId !== null;
}

function toOption(item: DisclosureItem): RequirementOption {
  return { id: item.id, code: item.code, section: item.section, title: item.questionText };
}

async function loadOwnBlock(
  db: DbClient,
  ctx: AuthorizationContext,
  blockId: Uuid,
): Promise<DisclosureBlock> {
  const block = isUuid(blockId) ? await db.findById('disclosureBlocks', blockId) : null;
  if (!block || block.deletedAt || block.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('節が見つかりません。');
  }
  return block;
}

/**
 * 節の追加・対応付けの編集で選べる要求事項（プロジェクトに付けた基準の版のものだけ）。
 * 開示の編集権限が要る（選んで保存する人だけが使う一覧）
 */
export async function listRequirementOptions(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { projectId: Uuid; frameworkVersionId: Uuid },
): Promise<RequirementOption[]> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.write');
  const organizationId = ctx.workspace.organizationId;
  const project = isUuid(input.projectId)
    ? await db.findById('disclosureProjects', input.projectId)
    : null;
  if (!project || project.deletedAt || project.organizationId !== organizationId) {
    throw new NotFoundError('開示プロジェクトが見つかりません。');
  }
  if (!isUuid(input.frameworkVersionId)) throw new NotFoundError('基準の版が見つかりません。');
  const attached = await db.select('projectFrameworks', {
    where: { organizationId, projectId: project.id, frameworkVersionId: input.frameworkVersionId },
  });
  if (attached.length === 0) throw new NotFoundError('基準の版が見つかりません。');
  const items = await db.select('disclosureItems', {
    where: { frameworkVersionId: input.frameworkVersionId },
  });
  return items
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code))
    .map(toOption);
}

export interface UpdateBlockRequirementsResult {
  block: DisclosureBlock;
  added: string[];
  removed: string[];
  changed: boolean;
}

/** 節の要求事項の対応付けを置き換える */
export async function updateBlockRequirements(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { blockId: Uuid; itemIds: readonly Uuid[]; reason?: string; aiRunId?: Uuid | null },
): Promise<UpdateBlockRequirementsResult> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.write');
  const block = await loadOwnBlock(db, ctx, input.blockId);

  const itemIds = [...new Set(input.itemIds)];
  if (itemIds.length > BLOCK_REQUIREMENT_LIMIT) {
    throw new ValidationError(
      `1 つの節に対応付けられる要求事項は ${BLOCK_REQUIREMENT_LIMIT} 件までです。`,
    );
  }
  if (itemIds.some((id) => !isUuid(id))) {
    throw new ValidationError('節の基準の版に無い要求事項が含まれています。');
  }
  const items =
    itemIds.length > 0
      ? await db.select('disclosureItems', {
          where: { id: { in: itemIds }, frameworkVersionId: block.frameworkVersionId },
        })
      : [];
  if (items.length !== itemIds.length) {
    throw new ValidationError('節の基準の版に無い要求事項が含まれています。');
  }

  const before = new Set(block.requirementItemIds);
  const after = new Set(itemIds);
  const addedIds = itemIds.filter((id) => !before.has(id));
  const removedIds = block.requirementItemIds.filter((id) => !after.has(id));
  if (addedIds.length === 0 && removedIds.length === 0) {
    return { block, added: [], removed: [], changed: false };
  }

  const reason = (input.reason ?? '').trim();
  const limit = mappingReasonLimit(ctx);
  if (reason.length > limit) {
    throw new ValidationError(`変更の理由は ${limit} 字以内で入力してください。`);
  }
  if (blockNeedsMappingReason(block) && reason === '') {
    throw new ValidationError(
      '承認済みの節の対応付けを変えるには、変更の理由を入力してください（承認済みの版・スナップショットは変わりません）。',
    );
  }

  // 監査ログの前後はコードで残す（外した項目のコードも引く）
  const removedItems =
    removedIds.length > 0
      ? await db.select('disclosureItems', { where: { id: { in: removedIds } } })
      : [];
  const codeOf = (id: Uuid) =>
    items.find((i) => i.id === id)?.code ?? removedItems.find((i) => i.id === id)?.code ?? '—';
  const added = addedIds.map(codeOf);
  const removed = removedIds.map(codeOf);

  const updated = await db.update('disclosureBlocks', block.id, {
    requirementItemIds: itemIds,
    updatedAt: new Date().toISOString(),
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'requirement_mapping_changed',
    resourceType: 'disclosure_block',
    resourceId: block.id,
    beforeSummary: block.requirementItemIds.map(codeOf).join('、') || '（なし）',
    afterSummary: itemIds.map(codeOf).join('、') || '（なし）',
    metadata: {
      projectId: block.projectId,
      added,
      removed,
      reason: reason || null,
      aiRunId: input.aiRunId ?? null,
    },
  });
  return { block: updated, added, removed, changed: true };
}

// ======================================================================
// AI の対応候補（節）
// ======================================================================

export interface BlockMappingCandidate extends RequirementOption {
  rationale: string;
  confidence: number;
}

export interface BlockMappingSuggestion {
  run: AiRun;
  candidates: BlockMappingCandidate[];
  warnings: string[];
}

function outputOf(run: AiRun): RequirementMappingSuggestionOutput | null {
  const output = run.outputJson as Partial<RequirementMappingSuggestionOutput>;
  return Array.isArray(output?.candidates) ? (output as RequirementMappingSuggestionOutput) : null;
}

/**
 * 節について、まだ採否を決めていない最新の候補（AI の実行）を読む。候補は節の基準の版の要求事項で、
 * まだ対応付けていないものだけを残す（採用済み・入力に無い ID は出さない）
 */
export async function loadBlockMappingSuggestion(
  db: DbClient,
  ctx: AuthorizationContext,
  blockId: Uuid,
): Promise<BlockMappingSuggestion | null> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.read');
  const block = await loadOwnBlock(db, ctx, blockId);
  const runs = (
    await db.select('aiRuns', {
      where: {
        organizationId: ctx.workspace.organizationId,
        featureType: 'requirementMappingSuggestion',
        status: 'succeeded',
      },
    })
  )
    .filter((r) => r.inputReferenceIds[0] === block.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const run = runs[0];
  if (!run) return null;
  const output = outputOf(run);
  if (!output) return null;
  const ids = output.candidates.map((c) => c.itemId).filter(isUuid);
  const items =
    ids.length > 0
      ? await db.select('disclosureItems', {
          where: { id: { in: ids }, frameworkVersionId: block.frameworkVersionId },
        })
      : [];
  const mapped = new Set(block.requirementItemIds);
  const candidates: BlockMappingCandidate[] = [];
  for (const c of output.candidates) {
    const item = items.find((i) => i.id === c.itemId);
    if (!item || mapped.has(item.id)) continue;
    candidates.push({ ...toOption(item), rationale: c.rationale, confidence: c.confidence });
  }
  return { run, candidates, warnings: run.warnings };
}

async function loadOwnMappingRun(
  db: DbClient,
  ctx: AuthorizationContext,
  block: DisclosureBlock,
  runId: Uuid,
): Promise<{ run: AiRun; output: RequirementMappingSuggestionOutput }> {
  const run = isUuid(runId) ? await db.findById('aiRuns', runId) : null;
  const output = run ? outputOf(run) : null;
  if (
    !run ||
    !output ||
    run.organizationId !== ctx.workspace.organizationId ||
    run.featureType !== 'requirementMappingSuggestion' ||
    run.inputReferenceIds[0] !== block.id
  ) {
    throw new NotFoundError('AI の候補が見つかりません。');
  }
  if (run.status !== 'succeeded') {
    throw new ValidationError('この候補は既に採否を記録しています。もう一度候補を出してください。');
  }
  return { run, output };
}

/**
 * AI の候補から選んだ要求事項を、節の対応付けに足す（人の操作。候補に無い ID は受け付けない）。
 * 採用は ai_runs の採否にも記録する
 */
export async function adoptBlockMappingCandidates(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { blockId: Uuid; runId: Uuid; itemIds: readonly Uuid[]; reason?: string },
): Promise<UpdateBlockRequirementsResult> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.write');
  assertCan(ctx, 'enterprise.ai.run');
  const block = await loadOwnBlock(db, ctx, input.blockId);
  const { run, output } = await loadOwnMappingRun(db, ctx, block, input.runId);
  const offered = new Set(output.candidates.map((c) => c.itemId));
  const chosen = [...new Set(input.itemIds)];
  if (chosen.length === 0) throw new ValidationError('採用する要求事項を選んでください。');
  if (chosen.some((id) => !offered.has(id))) {
    throw new ValidationError('AI の候補に無い要求事項は採用できません。');
  }
  const result = await updateBlockRequirements(db, ctx, {
    blockId: block.id,
    itemIds: [...block.requirementItemIds, ...chosen],
    reason: input.reason,
    aiRunId: run.id,
  });
  await recordAiDecision(db, ctx, run.id, 'accepted', null);
  return result;
}

/** AI の候補を採用しない（理由は任意。理由は ai_feedback に残す: 呼び出し側の recordAiFeedback） */
export async function rejectBlockMappingCandidates(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { blockId: Uuid; runId: Uuid },
): Promise<AiRun> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.ai.run');
  const block = await loadOwnBlock(db, ctx, input.blockId);
  const { run } = await loadOwnMappingRun(db, ctx, block, input.runId);
  await recordAiDecision(db, ctx, run.id, 'rejected', null);
  return run;
}
