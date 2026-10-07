'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import { confirmReport, createReviewDraftSnapshot } from '@/lib/services/report-snapshot';

/**
 * 出力タブの Server Actions。入力の取り出しと画面の再検証だけを行い、
 * 業務の判定（権限・阻害条件・職務分離）は src/lib/services/report-snapshot.ts が行う。
 *
 * 作成できたときは出力タブ専用のクエリ（snapshotCreated・kind）で戻す（出力タブが作成した番号を示す）。
 * 利用者に見せてよい理由（権限・阻害条件・対象なし）は withUserFacingError で出力タブの ?error= に載せ、
 * プロジェクト画面の共通の通知（FlashMessage）が出す（本番でも理由が識別子に化けない。plan §4 B3）。
 * 内部エラーは error.tsx へ。出力 API の失敗（outputError）は従来どおり出力タブが出す。
 */

function outputsPath(projectId: string, params: Record<string, string> = {}): string {
  const query = new URLSearchParams({ tab: 'outputs', ...params });
  return `/enterprise/disclosure-projects/${encodeURIComponent(projectId)}?${query.toString()}`;
}

async function run(projectId: string, operation: typeof createReviewDraftSnapshot): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const snapshot = await operation(db, ctx, projectId);
  revalidatePath(`/enterprise/disclosure-projects/${projectId}`);
  redirect(
    outputsPath(projectId, {
      snapshotCreated: String(snapshot.snapshotNo),
      kind: snapshot.snapshotKind,
    }),
  );
}

/** レビュー用草稿のスナップショットを作る */
export async function createReviewDraftSnapshotAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get('projectId') ?? '');
  await withUserFacingError(outputsPath(projectId), () =>
    run(projectId, createReviewDraftSnapshot),
  );
}

/**
 * レポートを確定して社内承認済み版を作る（阻害条件・権限はサーバーで再検証する）。
 * 画面では区分 1（取り消せない）の確認ダイアログを通してから送る
 */
export async function confirmReportAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get('projectId') ?? '');
  await withUserFacingError(outputsPath(projectId), () => run(projectId, confirmReport));
}
