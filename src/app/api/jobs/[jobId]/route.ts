import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { processIngestionJob } from '@/lib/imports/service';
import { getDb } from '@/lib/repositories';

/**
 * 取込ジョブの状態取得 + ワーカー起動。
 *
 * `queued` の場合はこのリクエストが処理を進める（pull 型ワーカー）。
 * Upload リクエスト自体をブロックしないための構成（指示書 13 章）。
 *
 * Supabase Edge Function へ移す場合は `supabase/functions/process-ingestion-job` が
 * 同じ `processIngestionJob` を呼ぶ。
 */
export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  const session = await getSession();
  if (!session?.context) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const ctx = session.context;
  if (ctx.workspace.organizationType !== 'enterprise') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const db = await getDb();
  let job = await db.findById('ingestionJobs', jobId);
  if (!job || job.organizationId !== ctx.workspace.organizationId) {
    // 権限外は存在を秘匿する
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  if (job.status === 'queued') {
    job = await processIngestionJob(db, ctx, jobId);
  }

  return NextResponse.json(
    {
      id: job.id,
      status: job.status,
      progressPercent: job.progressPercent,
      totalRows: job.totalRows,
      mappedRows: job.mappedRows,
      warningRows: job.warningRows,
      errorMessage: job.errorMessage,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
