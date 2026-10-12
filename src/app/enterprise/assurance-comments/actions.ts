'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { runPreservingAction } from '@/lib/errors/form-action';
import type { FormActionState } from '@/lib/errors/form-action-state';
import { getDb } from '@/lib/repositories';
import { respondToNote } from '@/lib/services/assurance-notes';

/** 保証側のコメント（企業側）の Server Actions。入力の取り出しと revalidate だけ（業務の規則はサービス） */

const BASE = '/enterprise/assurance-comments';

/**
 * 企業側: クライアントへ共有された保証側のコメントに回答する（追記。保証側の行は更新しない）。
 * 入力の誤り・権限なし・コメントのクリアで断られたときは、書いた回答を残したまま理由を回答欄に示す
 * （PreservingForm。?error= で戻すと本文が消えるため）
 */
export async function respondToAssuranceNoteAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const noteId = String(formData.get('noteId') ?? '');
  const failure = await runPreservingAction(formData, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await respondToNote(db, ctx, { noteId, body: String(formData.get('body') ?? '') });
    revalidatePath(BASE);
    revalidatePath('/enterprise/workflows');
  });
  if (failure) return failure;
  redirect(`${BASE}?result=responded`);
}
