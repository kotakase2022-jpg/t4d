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
  type BlockConflictKind,
  type RefValidationIssue,
} from '@/lib/services/disclosure-block';
import { decideRecheck } from '@/lib/services/disclosure-recheck';
import {
  addReviewComment,
  completeReview,
  finalApprove,
  notifiesNextStage,
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
  /** 画面が読み込んだ・最後に保存した作業本文の保存時刻（別の人の自動保存との競合の検出） */
  knownWorkingSavedAt: string | null;
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
      knownWorkingSavedAt: input.knownWorkingSavedAt,
    });
  } catch (error) {
    return toActionError(error);
  }
}

export type SaveVersionActionResult =
  | { status: 'saved'; versionNo: number; versionId: string }
  | {
      status: 'conflict';
      kind: BlockConflictKind;
      message: string;
      currentVersionId: string | null;
      currentBody: BlockBody;
    }
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
      knownWorkingSavedAt: input.knownWorkingSavedAt,
    });
    revalidateBlock(input.projectId, input.blockId);
    return { status: 'saved', versionNo: version.versionNo, versionId: version.id };
  } catch (error) {
    if (error instanceof BlockConflictError) return conflictResult(error);
    return toActionError(error);
  }
}

function conflictResult(error: BlockConflictError) {
  return {
    status: 'conflict' as const,
    kind: error.kind,
    message: error.message,
    currentVersionId: error.currentVersionId,
    currentBody: error.currentBody,
  };
}

export type RequestReviewActionResult =
  | { status: 'requested'; href: string }
  | {
      status: 'conflict';
      kind: BlockConflictKind;
      message: string;
      currentVersionId: string | null;
      currentBody: BlockBody;
    }
  | ActionError;

/**
 * レビュー依頼（画面の本文を送る）。
 * Demo Mode では自動保存の作業本文がインスタンスのメモリにしか無く、依頼を受けたサーバーに無いことがある。
 * 画面で見ている本文を送り、その本文を提出する版にする（サーバーに残った古い版を黙って提出しない）。
 */
export async function requestReviewWithBodyAction(
  input: BlockBodyActionInput,
): Promise<RequestReviewActionResult> {
  const projectId = safeId(input.projectId);
  const blockId = safeId(input.blockId);
  try {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const result = await requestReview(db, ctx, {
      blockId,
      body: input.body,
      baseVersionId: input.baseVersionId,
      knownWorkingSavedAt: input.knownWorkingSavedAt,
    });
    revalidateBlock(projectId, blockId);
    return {
      status: 'requested',
      href: `${blockPath(projectId, blockId)}?flash=reviewRequested&notified=${result.notified ? '1' : '0'}`,
    };
  } catch (error) {
    if (error instanceof BlockConflictError) return conflictResult(error);
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
  knownWorkingSavedAt?: string | null;
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
      knownWorkingSavedAt: input.knownWorkingSavedAt,
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
  /** 画面で編集中の本文（採用した段落があるかの判定に使う。作業本文は別のサーバーに無いことがある） */
  workingBody?: BlockBody;
}): Promise<{ status: 'closed'; decision: 'accepted' | 'rejected' } | ActionError> {
  try {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const decision = await closeDraftRun(db, ctx, {
      blockId: safeId(input.blockId),
      runId: safeId(input.runId),
      discard: input.discard,
      workingBody: input.workingBody,
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
  let notified = false;
  await withUserFacingError(back, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const result = await requestReview(db, ctx, { blockId });
    notified = result.notified;
  });
  revalidateBlock(projectId, blockId);
  redirect(`${back}?flash=reviewRequested&notified=${notified ? '1' : '0'}`);
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
  let notified = false;
  await withUserFacingError(back, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const request = await completeReview(db, ctx, {
      requestId: safeId(field(formData, 'requestId')),
    });
    notified = notifiesNextStage(request, ctx.userId);
  });
  revalidateBlock(projectId, blockId);
  redirect(`${back}?flash=reviewCompleted&notified=${notified ? '1' : '0'}`);
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

export interface RecheckFormState {
  status: 'idle' | 'error';
  /** 失敗した判断（その判断のフォームに理由を出す） */
  decision: RecheckDecisionKind | null;
  message: string | null;
  /** 入力した理由（失敗しても消さない） */
  reason: string;
}

/**
 * 再確認の判断（フォームの状態を返す版）。失敗したときはリダイレクトせず、入力した理由と
 * 断られた理由を返す（リダイレクトするとフォームが作り直され、書いた理由が消えていた）。
 */
export async function decideRecheckFormAction(
  _previous: RecheckFormState,
  formData: FormData,
): Promise<RecheckFormState> {
  const projectId = safeId(field(formData, 'projectId'));
  const blockId = safeId(field(formData, 'blockId'));
  const refKind = field(formData, 'refKind') === 'narrative' ? 'narrative' : 'metric';
  const raw = field(formData, 'decision');
  const decision: RecheckDecisionKind =
    raw === 'keep_old' || raw === 'return_to_owner' ? raw : 'adopt_new';
  const reason = field(formData, 'reason');
  try {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await decideRecheck(db, ctx, {
      blockId,
      refKind,
      oldRefId: safeId(field(formData, 'oldRefId')),
      decision,
      reason,
    });
  } catch (error) {
    return { status: 'error', decision, message: toActionError(error).message, reason };
  }
  revalidateBlock(projectId, blockId);
  redirect(
    `${blockPath(projectId, blockId)}/recheck?flash=recheckDecided&decision=${encodeURIComponent(decision)}`,
  );
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
