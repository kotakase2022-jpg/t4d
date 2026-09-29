import { notFound } from 'next/navigation';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { getProject } from '@/lib/services/disclosure-project';
import { loadEnterpriseShell } from '@/lib/services/shell';

/**
 * プロジェクト配下（タブ・原稿編集など）の共通の入口。
 *
 * 別テナント・削除済みのプロジェクトは配下のどの画面も 404 にする（存在を伏せる）。
 * 見た目（見出し・タブ）は各ページが持つ。原稿編集のように画面全体を使うページに
 * 余計な枠を重ねないため、ここでは表示を足さない。
 */
export default async function DisclosureProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const { db, ctx } = await loadEnterpriseShell();
  try {
    await getProject(db, ctx, projectId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    // 閲覧権限が無い場合は各ページが「権限なし」を表示する
    if (!(error instanceof AuthorizationError)) throw error;
  }
  return <>{children}</>;
}
