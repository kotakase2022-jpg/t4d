import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { contentDisposition } from '@/lib/exports';
import { getDb } from '@/lib/repositories';
import { isUuid } from '@/lib/validation/uuid';
import {
  exportReportSnapshot,
  parseExportAudience,
  parseExportFormat,
} from '@/lib/services/disclosure-export';

/** 出力するスナップショットが見つからないときの説明（存在の有無・所属は区別しない） */
const SNAPSHOT_UNAVAILABLE_MESSAGE =
  'スナップショットが見つからないため出力できませんでした。デモ環境ではスナップショットをこのブラウザの Cookie で持ち回すため、別のブラウザで作成したもの・Cookie の容量不足で古い操作が押し出された後のもの・固定した元の行が変わったものは見つからないことがあります。一覧を開き直し、無ければ作成し直してから出力してください。';

/**
 * 開示レポートのスナップショットからの出力（DOCX 原稿 / XLSX 対応表 / 定量 CSV）。
 *
 * GET /api/exports/disclosure-snapshots/[snapshotId]?format=docx|xlsx|csv&audience=internal|external
 *     [&framework=<frameworkVersionId>]（DOCX の対象の基準）
 *
 * 認証・権限・テナントの確認はサービス（exportReportSnapshot）が毎回行う。
 * 他テナントの ID・存在しない ID は同じ 404 を返し、存在を漏らさない（A29）。
 */
export async function GET(request: Request, context: { params: Promise<{ snapshotId: string }> }) {
  const { snapshotId } = await context.params;
  const session = await getSession();
  if (!session?.context) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const ctx = session.context;
  if (ctx.workspace.organizationType !== 'enterprise') {
    // 企業のスナップショットは企業ワークスペースからだけ扱う（監査法人には存在も示さない）
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const url = new URL(request.url);
  const format = parseExportFormat(url.searchParams.get('format'));
  const audience = parseExportAudience(url.searchParams.get('audience') ?? 'internal');
  if (!format || !audience) {
    return NextResponse.json({ error: 'unsupported_format' }, { status: 400 });
  }

  const db = await getDb();
  try {
    const result = await exportReportSnapshot(db, ctx, {
      snapshotId,
      format,
      audience,
      frameworkVersionId: url.searchParams.get('framework'),
    });
    return new NextResponse(result.bytes as unknown as BodyInit, {
      headers: {
        'Content-Type': result.contentType,
        'Content-Disposition': contentDisposition(result.fileName),
        'Cache-Control': 'no-store',
        // 同じスナップショットからの再出力で一致する値（ファイルのハッシュは生成日時で変わりうる）
        'X-T4D-Content-Hash': result.artifact.contentHash,
        'X-T4D-File-Sha256': result.artifact.fileSha256,
      },
    });
  } catch (error) {
    if (error instanceof NotFoundError) {
      // 画面の出力リンク（project 付き）からなら、出力タブへ戻して理由を示す（JSON の 404 を
      // ダウンロードとして見せない）。デモではスナップショットがサーバーのメモリにだけあり、一覧を描いた
      // サーバーと出力を受けたサーバーが違うと見つからない。他テナントの ID と同じ文言にする（A29）
      const project = url.searchParams.get('project');
      if (project && isUuid(project)) {
        const back = new URL(`/enterprise/disclosure-projects/${project}`, url.origin);
        back.searchParams.set('tab', 'outputs');
        back.searchParams.set('outputError', SNAPSHOT_UNAVAILABLE_MESSAGE);
        return NextResponse.redirect(back, 303);
      }
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    if (error instanceof AuthorizationError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    if (error instanceof ValidationError) {
      return NextResponse.json(
        { error: 'invalid_request', message: error.message },
        { status: 400 },
      );
    }
    throw error;
  }
}

export const dynamic = 'force-dynamic';
