import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { AuthorizationError, NotFoundError, can } from '@/lib/authorization/can';
import { accessDeniedResponse } from '@/lib/errors/access-denied';
import { ValidationError } from '@/lib/errors/user-facing';
import { contentDisposition } from '@/lib/exports';
import {
  exportRequirementMatrix,
  parseRequirementMatrixFormat,
} from '@/lib/exports/requirement-matrix';
import { getDb } from '@/lib/repositories';
import { isUuid } from '@/lib/validation/uuid';

/**
 * 要求事項・情報対応表（全基準・全件）の出力（トライアル対応 NF-04。スライド 11 の成果物 #01）。
 *
 * GET /api/exports/requirement-matrix?project=<projectId>&format=xlsx|csv
 *
 * 出力の権限（enterprise.export.run）を ID より先に確かめる（403 は JSON・監査ログ access_denied）。
 * 他テナント・存在しないプロジェクトは同じ 404 を返し、存在を漏らさない。行は画面の要求事項タブと同じ関数で作る。
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.context) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const ctx = session.context;
  if (ctx.workspace.organizationType !== 'enterprise') {
    // 企業の対応表は企業ワークスペースからだけ扱う（監査法人には存在も示さない）
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const db = await getDb();
  if (!can(ctx, 'enterprise.export.run')) {
    return accessDeniedResponse(db, ctx, { permission: 'enterprise.export.run', request });
  }

  const url = new URL(request.url);
  const format = parseRequirementMatrixFormat(url.searchParams.get('format'));
  if (!format) return NextResponse.json({ error: 'unsupported_format' }, { status: 400 });
  const projectId = url.searchParams.get('project') ?? '';
  if (!isUuid(projectId)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  try {
    const result = await exportRequirementMatrix(db, ctx, { projectId, format });
    return new NextResponse(result.bytes as unknown as BodyInit, {
      headers: {
        'Content-Type': result.contentType,
        'Content-Disposition': contentDisposition(result.fileName),
        'Cache-Control': 'no-store',
        'X-T4D-Row-Count': String(result.rowCount),
      },
    });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    if (error instanceof AuthorizationError) {
      return accessDeniedResponse(db, ctx, { permission: error.permission ?? null, request });
    }
    if (error instanceof ValidationError) {
      return NextResponse.json({ error: 'invalid', message: error.message }, { status: 400 });
    }
    throw error;
  }
}
