'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import { respondToNote } from '@/lib/services/assurance-notes';

/** 保証側のコメント（企業側）の Server Actions。入力の取り出しと revalidate だけ（業務の規則はサービス） */

const BASE = '/enterprise/assurance-comments';

/** コメント ID はフォーム由来なので、戻り先の URL では 1 つの値として符号化する */
function panelHref(noteId: string): string {
  return `${BASE}?new=1&note=${encodeURIComponent(noteId)}`;
}

/**
 * 企業側: クライアントへ共有された保証側のコメントに回答する（追記。保証側の行は更新しない）。
 * 入力の誤り・権限なしは回答欄を開いたまま ?error= で戻す
 */
export async function respondToAssuranceNoteAction(formData: FormData): Promise<void> {
  const noteId = String(formData.get('noteId') ?? '');
  await withUserFacingError(panelHref(noteId), async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await respondToNote(db, ctx, { noteId, body: String(formData.get('body') ?? '') });
    revalidatePath(BASE);
    revalidatePath('/enterprise/workflows');
  });
  redirect(`${BASE}?result=responded`);
}
