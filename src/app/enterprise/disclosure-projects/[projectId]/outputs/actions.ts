'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { isUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import { confirmReport, createReviewDraftSnapshot } from '@/lib/services/report-snapshot';

/**
 * 出力タブの Server Actions。入力の取り出しと画面の再検証だけを行い、
 * 業務の判定（権限・阻害条件・職務分離）は src/lib/services/report-snapshot.ts が行う。
 *
 * 結果は出力タブ専用のクエリ（snapshotCreated / outputError）で戻す。
 * プロジェクト画面の共通メッセージ（?flash= / ?error=）と二重に表示しないため。
 */

const MAX_MESSAGE_LENGTH = 160;

function outputsPath(projectId: string, params: Record<string, string>): string {
  const query = new URLSearchParams({ tab: 'outputs', ...params });
  return `/enterprise/disclosure-projects/${encodeURIComponent(projectId)}?${query.toString()}`;
}

async function run(formData: FormData, operation: typeof createReviewDraftSnapshot): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const projectId = String(formData.get('projectId') ?? '');

  let target: string;
  try {
    const snapshot = await operation(db, ctx, projectId);
    target = outputsPath(projectId, {
      snapshotCreated: String(snapshot.snapshotNo),
      kind: snapshot.snapshotKind,
    });
  } catch (error) {
    // 利用者に見せてよい理由（権限・阻害条件・対象なし）だけを戻す。内部エラーは error.tsx へ
    if (!isUserFacingError(error)) throw error;
    target = outputsPath(projectId, { outputError: error.message.slice(0, MAX_MESSAGE_LENGTH) });
  }
  revalidatePath(`/enterprise/disclosure-projects/${projectId}`);
  redirect(target);
}

/** レビュー用草稿のスナップショットを作る */
export async function createReviewDraftSnapshotAction(formData: FormData): Promise<void> {
  await run(formData, createReviewDraftSnapshot);
}

/** レポートを確定して社内承認済み版を作る（阻害条件・権限はサーバーで再検証する） */
export async function confirmReportAction(formData: FormData): Promise<void> {
  await run(formData, confirmReport);
}
