'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { ValidationError, withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import { parseExportAudience, reconcileUploadedFile } from '@/lib/services/disclosure-export';
import { confirmReport, createReviewDraftSnapshot } from '@/lib/services/report-snapshot';
import { shareReportSnapshot, withdrawSharedReport } from '@/lib/services/report-share';

/**
 * 出力タブの Server Actions。入力の取り出しと画面の再検証だけを行い、
 * 業務の判定（権限・阻害条件・職務分離・共有の条件・突合）はサービスが行う
 * （src/lib/services/report-snapshot.ts・report-share.ts・disclosure-export.ts）。
 *
 * 作成できたときは出力タブ専用のクエリ（snapshotCreated・kind）で戻す（出力タブが作成した番号を示す）。
 * 保証側への共有・取り下げ（トライアル対応 NF-20）は outputNotice、外部で編集したファイルの照合
 * （NF-15 の P1）は reconciliation（照合の記録の ID）で戻し、出力タブが結果を示す。
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

/**
 * 承認済みのスナップショットを案件へ共有する（保証側用の写しを作る。取り消せないため画面では
 * 区分 1 の確認ダイアログを通す）。条件（承認済み・完全性・有効な許諾・二重共有しない）はサービスが検査する
 */
export async function shareReportAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get('projectId') ?? '');
  const snapshotId = String(formData.get('snapshotId') ?? '');
  const engagementId = String(formData.get('engagementId') ?? '');
  await withUserFacingError(outputsPath(projectId), async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await shareReportSnapshot(db, ctx, { snapshotId, engagementId });
    revalidatePath(`/enterprise/disclosure-projects/${projectId}`);
    redirect(outputsPath(projectId, { outputNotice: 'shared' }));
  });
}

/** 保証側への共有を取り下げる（写しは消さない。保証側から見えなくなる） */
export async function withdrawSharedReportAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get('projectId') ?? '');
  const copyId = String(formData.get('copyId') ?? '');
  await withUserFacingError(outputsPath(projectId), async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await withdrawSharedReport(db, ctx, { copyId });
    revalidatePath(`/enterprise/disclosure-projects/${projectId}`);
    redirect(outputsPath(projectId, { outputNotice: 'withdrawn' }));
  });
}

/**
 * 外部（Word・Excel）で編集したファイルを承認版と照合する。ファイルは保存せず、sha256 と照合の結果だけを
 * 記録する。結果（照合の記録）を出力タブで示す
 */
export async function reconcileUploadedFileAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get('projectId') ?? '');
  const snapshotId = String(formData.get('snapshotId') ?? '');
  const back = outputsPath(projectId, { reconcile: '1', rs: snapshotId });
  await withUserFacingError(back, async () => {
    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) {
      throw new ValidationError('照合するファイルを選んでください。');
    }
    const audience = parseExportAudience(String(formData.get('audience') ?? 'internal'));
    if (!audience) throw new ValidationError('出力区分を選んでください。');
    const framework = String(formData.get('framework') ?? '');
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const record = await reconcileUploadedFile(db, ctx, {
      snapshotId,
      fileName: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
      audience,
      frameworkVersionId: framework || null,
    });
    revalidatePath(`/enterprise/disclosure-projects/${projectId}`);
    redirect(outputsPath(projectId, { reconciliation: record.id }));
  });
}
