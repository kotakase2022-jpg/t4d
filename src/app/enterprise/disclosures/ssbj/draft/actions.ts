'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import { importDraftToProject } from '@/lib/services/draft-import';

/**
 * SSBJ 開示ドラフトの Server Action（トライアル対応 NF-19）。入力の取り出しと revalidate だけ。
 * 草案の生成・保存・確定の Action は src/app/enterprise/actions.ts のまま
 */

const DRAFT = '/enterprise/disclosures/ssbj/draft';

/** 確定本文を開示プロジェクトの原稿の節へ取り込む（新しい版は下書き。承認は原稿で） */
export async function importSsbjDraftToProjectAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const projectId = String(formData.get('projectId') ?? '');
  let target = '';
  await withUserFacingError(DRAFT, async () => {
    const result = await importDraftToProject(db, ctx, {
      source: 'ssbj',
      draftId: String(formData.get('draftId') ?? ''),
      projectId,
    });
    target = `/enterprise/disclosure-projects/${result.block.projectId}/blocks/${result.block.id}?flash=draftImported&ai=${result.aiParagraphs}`;
  });
  revalidatePath(DRAFT);
  revalidatePath(`/enterprise/disclosure-projects/${projectId}`);
  redirect(target);
}
