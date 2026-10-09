'use server';

import { revalidatePath } from 'next/cache';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { isUserFacingError, ValidationError, withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import type { DbClient } from '@/lib/repositories/types';
import { frameworkKeyOfItem } from '@/lib/services/disclosure';
import {
  addDisclosureMapping,
  addResponseContentLink,
  assignDisclosureItems,
  confirmQuestionMappingCandidate,
  linkResponseEvidence,
  removeDisclosureMapping,
  removeResponseContentLink,
  startDisclosureDraft,
  startDisclosureResponse,
  type AssignInput,
} from '@/lib/services/disclosure-write';
import { RESPONSE_CONTENT_TARGET_KINDS, type ResponseContentTargetKind } from '@/types/domain';

/**
 * CDP 回答管理の強化（トライアル対応 NF-39）の Server Action。回答画面は CDP と CSRD で共用なので、
 * 戻り先・再検証は質問の基準で決める。業務の検査（権限・組織・契約・職務分離）はサービスが行い、
 * ここは入力の取り出しと revalidate だけ（CLAUDE.md §1）
 */

const CDP_BASE = '/enterprise/disclosures/cdp';
const CSRD_BASE = '/enterprise/disclosures/csrd';

/** 質問の回答画面のパス（質問はマスターなので、組織を問わず同じ。無い ID は CDP の一覧） */
async function questionPath(db: DbClient, itemId: string): Promise<string> {
  const item = itemId ? await db.findById('disclosureItems', itemId) : null;
  if (!item) return CDP_BASE;
  return `${(await frameworkKeyOfItem(db, item)) === 'csrd' ? CSRD_BASE : CDP_BASE}/${item.id}`;
}

function revalidateResponses(itemId: string | null): void {
  for (const base of [CDP_BASE, CSRD_BASE]) {
    if (itemId) revalidatePath(`${base}/${itemId}`);
    revalidatePath(base);
  }
  // CSRD の回答の状態は要求事項の一覧と分析（規制対応度）にも出る
  revalidatePath(CSRD_BASE, 'layout');
  revalidatePath('/enterprise/analysis', 'layout');
}

function text(formData: FormData, name: string): string {
  return String(formData.get(name) ?? '').trim();
}

/** 担当の選択肢の値（'' = 変更しない、'none' = 外す、それ以外 = 利用者 ID） */
function assigneeOf(value: string): string | null | undefined {
  if (value === '') return undefined;
  if (value === 'none') return null;
  return value;
}

function assignInputOf(formData: FormData): AssignInput {
  return {
    ownerUserId: assigneeOf(text(formData, 'ownerUserId')),
    reviewerUserId: assigneeOf(text(formData, 'reviewerUserId')),
  };
}

/** 回答の行が無い質問の最初の保存（回答の開始。C-02） */
export async function startResponseAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const itemId = text(formData, 'itemId');
  const numericRaw = String(formData.get('answerNumeric') ?? '').replace(/,/g, '');
  const answerNumeric = numericRaw === '' ? null : Number(numericRaw);

  await withUserFacingError(await questionPath(db, itemId), async () => {
    // 数値として読めない入力を黙って null に落とさない（入力した値が消える）
    if (numericRaw !== '' && !Number.isFinite(answerNumeric)) {
      throw new ValidationError('数値欄には数値を入力してください（例: 1234.5）。');
    }
    await startDisclosureResponse(db, ctx, {
      itemId,
      periodId: text(formData, 'periodId'),
      answerText: String(formData.get('answerText') ?? ''),
      answerNumeric,
      answerChoice: formData.getAll('answerChoice').map(String).filter(Boolean),
      aiRunId: null,
      editedFromAi: false,
      carryForwardDecision:
        (text(formData, 'carryForwardDecision') as 'reuse' | 'update' | 'new') || null,
    });
  });
  revalidateResponses(itemId);
}

/** 回答の行が無い質問の最初の AI 草案（C-02。草案は候補で、確定は人） */
export async function startResponseDraftAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const itemId = text(formData, 'itemId');
  await withUserFacingError(await questionPath(db, itemId), async () => {
    await startDisclosureDraft(db, ctx, { itemId, periodId: text(formData, 'periodId') });
  });
  revalidateResponses(itemId);
}

/** 回答画面の「担当」（C-01） */
export async function assignResponseAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const itemId = text(formData, 'itemId');
  await withUserFacingError(await questionPath(db, itemId), async () => {
    await assignDisclosureItems(db, ctx, {
      ...assignInputOf(formData),
      periodId: text(formData, 'periodId'),
      itemIds: [itemId],
    });
  });
  revalidateResponses(itemId);
}

export interface BulkAssignState {
  ok: boolean;
  message: string;
}

/** 一覧の一括割当（C-01。BulkActionBar から useActionState で呼ぶ。結果をバーの下に出す） */
export async function bulkAssignResponsesAction(
  _previous: BulkAssignState | null,
  formData: FormData,
): Promise<BulkAssignState> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const itemIds = formData.getAll('selected').map(String).filter(Boolean);
  try {
    const updated = await assignDisclosureItems(db, ctx, {
      ...assignInputOf(formData),
      periodId: text(formData, 'periodId'),
      itemIds,
    });
    revalidateResponses(null);
    return { ok: true, message: `${updated.length} 件の担当を割り当てました。` };
  } catch (error) {
    // 利用者に見せてよい理由（入力・権限・契約）だけを返す。内部エラーは error.tsx へ
    if (isUserFacingError(error)) return { ok: false, message: error.message };
    throw error;
  }
}

/** AI の質問マッピングの候補を 1 件確定する（不具合 B-3: 確定する操作が無かった） */
export async function confirmMappingCandidateAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const aiRunId = text(formData, 'aiRunId');
  // 断ったときは候補の一覧（?mapping=）へ理由を付けて戻す。runId は画面の URL と同じ識別子
  const back = aiRunId ? `${CDP_BASE}?mapping=${encodeURIComponent(aiRunId)}` : CDP_BASE;
  let itemId: string | null = null;
  await withUserFacingError(back, async () => {
    const mapping = await confirmQuestionMappingCandidate(db, ctx, {
      aiRunId,
      itemCode: text(formData, 'itemCode'),
      metricCode: text(formData, 'metricCode'),
    });
    itemId = mapping.itemId;
  });
  revalidateResponses(itemId);
}

/**
 * 回答画面「対応する T4D の情報」の追加（C-03）。選択肢の値は「種類:ID」
 * （metric = 指標、narrative_record・disclosure_block・requirement_item = T4D の情報）
 */
export async function addResponseLinkAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const itemId = text(formData, 'itemId');
  const [kind = '', targetId = ''] = text(formData, 'target').split(':');
  await withUserFacingError(await questionPath(db, itemId), async () => {
    if (!targetId) throw new ValidationError('対応付ける情報を選んでください。');
    if (kind === 'metric') {
      await addDisclosureMapping(db, ctx, { itemId, metricId: targetId });
      return;
    }
    if (!(RESPONSE_CONTENT_TARGET_KINDS as readonly string[]).includes(kind)) {
      throw new ValidationError('対応付ける情報の種類が正しくありません。');
    }
    await addResponseContentLink(db, ctx, {
      itemId,
      targetKind: kind as ResponseContentTargetKind,
      targetId,
    });
  });
  revalidateResponses(itemId);
}

/** 指標の対応付けを外す（確定を外す。行は残る） */
export async function removeMetricMappingAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const itemId = text(formData, 'itemId');
  await withUserFacingError(await questionPath(db, itemId), async () => {
    await removeDisclosureMapping(db, ctx, { mappingId: text(formData, 'mappingId') });
  });
  revalidateResponses(itemId);
}

/** 定性情報・原稿・要求事項との対応付けを外す（deleted_at を入れる） */
export async function removeResponseLinkAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const itemId = text(formData, 'itemId');
  await withUserFacingError(await questionPath(db, itemId), async () => {
    await removeResponseContentLink(db, ctx, { linkId: text(formData, 'linkId') });
  });
  revalidateResponses(itemId);
}

/** 対応付けた指標の承認済みデータの根拠を、回答の根拠として紐付ける（C-04。外さない） */
export async function linkResponseEvidenceAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const itemId = text(formData, 'itemId');
  await withUserFacingError(await questionPath(db, itemId), async () => {
    await linkResponseEvidence(db, ctx, {
      responseId: text(formData, 'responseId'),
      evidenceLinkId: text(formData, 'evidenceLinkId'),
    });
  });
  revalidateResponses(itemId);
}
