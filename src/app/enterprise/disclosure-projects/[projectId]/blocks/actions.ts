'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { isUserFacingError, withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import {
  adoptDraftParagraphs,
  closeDraftRun,
  generateBlockDraft,
  type AdoptDraftResult,
  type GenerateBlockDraftResult,
  type SelectableSourceKind,
} from '@/lib/services/disclosure-ai-draft';
import {
  BlockConflictError,
  BlockRefValidationError,
  autosaveWorkingBody,
  createBlock,
  saveBlockVersion,
  type AutosaveResult,
  type RefValidationIssue,
} from '@/lib/services/disclosure-block';
import { decideRecheck } from '@/lib/services/disclosure-recheck';
import {
  addReviewComment,
  completeReview,
  finalApprove,
  requestReview,
  resolveReviewComment,
  returnReview,
  withdrawReview,
} from '@/lib/services/disclosure-review';
import type { DisclosureDraftOperation } from '@/lib/ai/schemas';
import type {
  BlockBody,
  DisclosureLanguage,
  RecheckDecisionKind,
  RecheckRefKind,
  ReviewCommentSeverity,
} from '@/types/domain';

/**
 * 原稿編集・レビュー・再確認の Server Action。
 * 入力の取り出しと revalidate だけを行い、判断はすべて Service（src/lib/services/disclosure-*）が持つ。
 * 画面に返すのは利用者向けのエラーだけ（内部エラーの文面・SQL は返さない）。
 */

const ID_RE = /^[0-9a-f-]{36}$/;

function safeId(value: unknown): string {
  const id = typeof value === 'string' ? value : '';
  // 戻り先のパスに使うため、UUID の形以外は受け付けない
  return ID_RE.test(id) ? id : '';
}

function projectPath(projectId: string): string {
  return `/enterprise/disclosure-projects/${safeId(projectId)}`;
}

function blockPath(projectId: string, blockId: string): string {
  return `${projectPath(projectId)}/blocks/${safeId(blockId)}`;
}

function revalidateBlock(projectId: string, blockId: string): void {
  revalidatePath(blockPath(projectId, blockId));
  revalidatePath(projectPath(projectId));
  revalidatePath('/enterprise/workflows');
}

export type ActionError = { status: 'error'; message: string; issues?: RefValidationIssue[] };

const INTERNAL_ERROR =
  '処理に失敗しました。入力は画面に残っています。時間をおいて再試行してください。';

function toActionError(error: unknown): ActionError {
  if (error instanceof BlockRefValidationError) {
    return { status: 'error', message: error.message, issues: error.issues };
  }
  if (isUserFacingError(error)) return { status: 'error', message: error.message };
  console.error('[disclosure-block action]', error);
  return { status: 'error', message: INTERNAL_ERROR };
}

// ======================================================================
// 本文（自動保存・版の保存）— 結果を返す（画面に入力を残したまま結果を示すため）
// ======================================================================

export interface BlockBodyActionInput {
  projectId: string;
  blockId: string;
  baseVersionId: string | null;
  body: BlockBody;
}

export type AutosaveActionResult = AutosaveResult | ActionError;

export async function autosaveBlockAction(
  input: BlockBodyActionInput,
): Promise<AutosaveActionResult> {
  try {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    return await autosaveWorkingBody(db, ctx, {
      blockId: safeId(input.blockId),
      baseVersionId: input.baseVersionId,
      body: input.body,
    });
  } catch (error) {
    return toActionError(error);
  }
}

export type SaveVersionActionResult =
  | { status: 'saved'; versionNo: number; versionId: string }
  | { status: 'conflict'; message: string; currentVersionId: string | null; currentBody: BlockBody }
  | ActionError;

export async function saveBlockVersionAction(
  input: BlockBodyActionInput & { changeReason: string },
): Promise<SaveVersionActionResult> {
  try {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const { version } = await saveBlockVersion(db, ctx, {
      blockId: safeId(input.blockId),
      baseVersionId: input.baseVersionId,
      body: input.body,
      changeReason: input.changeReason,
    });
    revalidateBlock(input.projectId, input.blockId);
    return { status: 'saved', versionNo: version.versionNo, versionId: version.id };
  } catch (error) {
    if (error instanceof BlockConflictError) {
      return {
        status: 'conflict',
        message: error.message,
        currentVersionId: error.currentVersionId,
        currentBody: error.currentBody,
      };
    }
    return toActionError(error);
  }
}

// ======================================================================
// AI 下書き
// ======================================================================

export interface GenerateDraftActionInput {
  projectId: string;
  blockId: string;
  operation: DisclosureDraftOperation;
  sources: Array<{ kind: SelectableSourceKind; id: string }>;
  paragraphIds?: string[];
  workingBody: BlockBody;
  regenerate?: boolean;
}

export async function generateBlockDraftAction(
  input: GenerateDraftActionInput,
): Promise<GenerateBlockDraftResult | ActionError> {
  try {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const result = await generateBlockDraft(db, ctx, {
      blockId: safeId(input.blockId),
      operation: input.operation,
      sources: input.sources.slice(0, 50),
      paragraphIds: input.paragraphIds,
      workingBody: input.workingBody,
      regenerate: input.regenerate,
    });
    revalidateBlock(input.projectId, input.blockId);
    return result;
  } catch (error) {
    return toActionError(error);
  }
}

export async function adoptDraftAction(input: {
  projectId: string;
  blockId: string;
  runId: string;
  candidateIndexes: number[];
  workingBody: BlockBody;
  baseVersionId: string | null;
  allowOnConflict?: boolean;
}): Promise<AdoptDraftResult | ActionError> {
  try {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const result = await adoptDraftParagraphs(db, ctx, {
      blockId: safeId(input.blockId),
      runId: safeId(input.runId),
      candidateIndexes: input.candidateIndexes,
      workingBody: input.workingBody,
      baseVersionId: input.baseVersionId,
      allowOnConflict: input.allowOnConflict,
    });
    revalidateBlock(input.projectId, input.blockId);
    return result;
  } catch (error) {
    return toActionError(error);
  }
}

export async function closeDraftRunAction(input: {
  projectId: string;
  blockId: string;
  runId: string;
  discard?: boolean;
}): Promise<{ status: 'closed'; decision: 'accepted' | 'rejected' } | ActionError> {
  try {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const decision = await closeDraftRun(db, ctx, {
      blockId: safeId(input.blockId),
      runId: safeId(input.runId),
      discard: input.discard,
    });
    revalidateBlock(input.projectId, input.blockId);
    return { status: 'closed', decision };
  } catch (error) {
    return toActionError(error);
  }
}

// ======================================================================
// コメント（入力中の本文を保ったまま結果を返す）
// ======================================================================

export async function addReviewCommentAction(input: {
  projectId: string;
  blockId: string;
  paragraphId: string | null;
  body: string;
  severity: ReviewCommentSeverity;
}): Promise<{ status: 'ok' } | ActionError> {
  try {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await addReviewComment(db, ctx, {
      blockId: safeId(input.blockId),
      paragraphId: input.paragraphId,
      body: input.body,
      severity: input.severity === 'major' ? 'major' : 'info',
    });
    revalidateBlock(input.projectId, input.blockId);
    return { status: 'ok' };
  } catch (error) {
    return toActionError(error);
  }
}

export async function resolveReviewCommentAction(input: {
  projectId: string;
  blockId: string;
  commentId: string;
  note: string;
}): Promise<{ status: 'ok' } | ActionError> {
  try {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await resolveReviewComment(db, ctx, { commentId: safeId(input.commentId), note: input.note });
    revalidateBlock(input.projectId, input.blockId);
    return { status: 'ok' };
  } catch (error) {
    return toActionError(error);
  }
}

// ======================================================================
// レビュー（明示操作。完了後は結果を URL で知らせる）
// ======================================================================

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

export async function requestReviewAction(formData: FormData): Promise<void> {
  const projectId = safeId(field(formData, 'projectId'));
  const blockId = safeId(field(formData, 'blockId'));
  const back = blockPath(projectId, blockId);
  await withUserFacingError(back, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await requestReview(db, ctx, { blockId });
  });
  revalidateBlock(projectId, blockId);
  redirect(`${back}?flash=reviewRequested`);
}

export async function returnReviewAction(formData: FormData): Promise<void> {
  const projectId = safeId(field(formData, 'projectId'));
  const blockId = safeId(field(formData, 'blockId'));
  const back = blockPath(projectId, blockId);
  await withUserFacingError(back, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await returnReview(db, ctx, {
      requestId: safeId(field(formData, 'requestId')),
      reason: field(formData, 'reason'),
      paragraphId: field(formData, 'paragraphId'),
    });
  });
  revalidateBlock(projectId, blockId);
  redirect(`${back}?flash=reviewReturned`);
}

export async function completeReviewAction(formData: FormData): Promise<void> {
  const projectId = safeId(field(formData, 'projectId'));
  const blockId = safeId(field(formData, 'blockId'));
  const back = blockPath(projectId, blockId);
  await withUserFacingError(back, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await completeReview(db, ctx, { requestId: safeId(field(formData, 'requestId')) });
  });
  revalidateBlock(projectId, blockId);
  redirect(`${back}?flash=reviewCompleted`);
}

export async function finalApproveAction(formData: FormData): Promise<void> {
  const projectId = safeId(field(formData, 'projectId'));
  const blockId = safeId(field(formData, 'blockId'));
  const back = blockPath(projectId, blockId);
  await withUserFacingError(back, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await finalApprove(db, ctx, { requestId: safeId(field(formData, 'requestId')) });
  });
  revalidateBlock(projectId, blockId);
  redirect(`${back}?flash=reviewApproved`);
}

export async function withdrawReviewAction(formData: FormData): Promise<void> {
  const projectId = safeId(field(formData, 'projectId'));
  const blockId = safeId(field(formData, 'blockId'));
  const back = blockPath(projectId, blockId);
  await withUserFacingError(back, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await withdrawReview(db, ctx, {
      requestId: safeId(field(formData, 'requestId')),
      reason: field(formData, 'reason'),
    });
  });
  revalidateBlock(projectId, blockId);
  redirect(`${back}?flash=reviewWithdrawn`);
}

// ======================================================================
// 再確認・節の追加
// ======================================================================

export async function decideRecheckAction(formData: FormData): Promise<void> {
  const projectId = safeId(field(formData, 'projectId'));
  const blockId = safeId(field(formData, 'blockId'));
  const back = `${blockPath(projectId, blockId)}/recheck`;
  const refKind = field(formData, 'refKind') as RecheckRefKind;
  const decision = field(formData, 'decision') as RecheckDecisionKind;
  await withUserFacingError(back, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await decideRecheck(db, ctx, {
      blockId,
      refKind: refKind === 'narrative' ? 'narrative' : 'metric',
      oldRefId: safeId(field(formData, 'oldRefId')),
      decision: decision === 'keep_old' || decision === 'return_to_owner' ? decision : 'adopt_new',
      reason: field(formData, 'reason'),
    });
  });
  revalidateBlock(projectId, blockId);
  redirect(`${back}?flash=recheckDecided&decision=${encodeURIComponent(decision)}`);
}

export async function createBlockAction(formData: FormData): Promise<void> {
  const projectId = safeId(field(formData, 'projectId'));
  const back = `${projectPath(projectId)}?tab=manuscripts`;
  let created = '';
  await withUserFacingError(back, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const language = field(formData, 'language') as DisclosureLanguage;
    const block = await createBlock(db, ctx, {
      projectId,
      frameworkVersionId: safeId(field(formData, 'frameworkVersionId')),
      sectionKey: field(formData, 'sectionKey'),
      title: field(formData, 'title'),
      language: language === 'en' ? 'en' : 'ja',
      translationOfBlockId: safeId(field(formData, 'translationOfBlockId')) || null,
    });
    created = block.id;
  });
  revalidatePath(projectPath(projectId));
  redirect(`${blockPath(projectId, created)}?flash=blockCreated`);
}
