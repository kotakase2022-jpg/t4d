import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { accessDeniedResponse } from '@/lib/errors/access-denied';
import { ValidationError } from '@/lib/errors/user-facing';
import { contentDisposition } from '@/lib/exports';
import { getDb } from '@/lib/repositories';
import { isUuid } from '@/lib/validation/uuid';
import { parseExportAudience } from '@/lib/services/disclosure-export';
import { XbrlExportError, exportXbrl, parseXbrlExportFormat } from '@/lib/services/xbrl-export';

/**
 * XBRL の社内確認用の出力（トライアル対応 NF-42 Stage 1。提出用ではない）。
 *
 * GET /api/exports/xbrl/[snapshotId]?format=xbrl_json|ixbrl_html|trace_csv
 *     [&audience=internal]（対外用は断る）[&framework=<frameworkVersionId>][&download=1][&project=<projectId>]
 *
 * - 認証・権限（enterprise.export.run を ID より先）・テナントの確認はサービス（exportXbrl）が毎回行う。
 *   他テナントの ID・存在しない ID は同じ 404（存在を漏らさない）。403 は access_denied を記録する
 * - 検証（T4D の簡易検査）にエラーがあれば出力しない
 * - iXBRL は既定で画面に開くプレビュー（inline）。download=1 でファイルとして保存（出力の記録を残す）
 * - プレビューの HTML はスクリプトを動かさない（CSP）。利用者の文字列は生成時にエスケープ済み
 * - 画面のリンク（project 付き）から失敗したときは、XBRL タブへ戻して理由の符号を示す（JSON をファイルとして
 *   保存させない。URL に任意の文を載せない）
 */

function inlineDisposition(fileName: string): string {
  return contentDisposition(fileName).replace(/^attachment;/, 'inline;');
}

/** プレビューの HTML に付ける制限（スクリプト・外部の読み込み・フォーム送信・埋め込みを禁止） */
const PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

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
  const format = parseXbrlExportFormat(url.searchParams.get('format'));
  const audience = parseExportAudience(url.searchParams.get('audience') ?? 'internal');
  if (!format || !audience) {
    return NextResponse.json({ error: 'unsupported_format' }, { status: 400 });
  }
  const project = url.searchParams.get('project');
  const backToTab = (code: string) => {
    const back = new URL(`/enterprise/disclosure-projects/${project}`, url.origin);
    back.searchParams.set('tab', 'xbrl');
    back.searchParams.set('xbrlError', code);
    return NextResponse.redirect(back, 303);
  };

  const db = await getDb();
  try {
    const result = await exportXbrl(db, ctx, {
      snapshotId,
      format,
      audience,
      frameworkVersionId: url.searchParams.get('framework'),
      download: url.searchParams.get('download') === '1',
    });
    const headers: Record<string, string> = {
      'Content-Type': result.contentType,
      'Content-Disposition': result.inline
        ? inlineDisposition(result.fileName)
        : contentDisposition(result.fileName),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // 同じスナップショット・同じ対応付け・同じパッケージ・同じ生成器の版なら一致する
      'X-T4D-Content-Hash': result.contentHash,
      'X-T4D-Mapping-Set-Hash': result.mappingSetHash,
      'X-T4D-Snapshot-Content-Hash': result.snapshotContentHash,
    };
    if (format === 'ixbrl_html') headers['Content-Security-Policy'] = PREVIEW_CSP;
    return new NextResponse(result.bytes as unknown as BodyInit, { headers });
  } catch (error) {
    if (error instanceof NotFoundError) {
      if (project && isUuid(project)) return backToTab('not_found');
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    if (error instanceof AuthorizationError) {
      return accessDeniedResponse(db, ctx, { permission: error.permission ?? null, request });
    }
    if (error instanceof XbrlExportError) {
      if (project && isUuid(project)) return backToTab(error.code);
      return NextResponse.json(
        {
          error: error.code === 'blocked' ? 'validation_failed' : 'invalid_request',
          code: error.code,
          message: error.message,
        },
        { status: error.code === 'blocked' ? 422 : 400 },
      );
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
