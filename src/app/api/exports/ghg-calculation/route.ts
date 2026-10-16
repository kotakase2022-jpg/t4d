import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { AuthorizationError, NotFoundError, can } from '@/lib/authorization/can';
import { accessDeniedResponse } from '@/lib/errors/access-denied';
import { contentDisposition, EXPORT_CONTENT_TYPES } from '@/lib/exports';
import { exportGhgCalculationCsv } from '@/lib/exports/ghg-calculation';
import { getDb } from '@/lib/repositories';
import { isUuid } from '@/lib/validation/uuid';

/**
 * 算定明細 CSV（plan E18・CR-15）。GET /api/exports/ghg-calculation?run=<算定の記録の ID>
 *
 * 出力の権限（enterprise.export.run）を ID より先に確かめる（403 は JSON・監査ログ access_denied）。
 * 他テナント・存在しない記録は同じ 404（存在を漏らさない）。入力が変わって数値を作り直せない記録は 409
 * （画面も数値を出さない。plan K11）。出したら監査ログ export_created（サービスが記録する）。
 */
export async function GET(request: Request) {
  const session = await getSession();
  const ctx = session?.context;
  if (!ctx) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (ctx.workspace.organizationType !== 'enterprise') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const db = await getDb();
  if (!can(ctx, 'enterprise.export.run')) {
    return accessDeniedResponse(db, ctx, { permission: 'enterprise.export.run', request });
  }
  const runId = new URL(request.url).searchParams.get('run') ?? '';
  if (!isUuid(runId)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  try {
    const result = await exportGhgCalculationCsv(db, ctx, runId);
    if (!result.ok) {
      return NextResponse.json(
        {
          error: 'input_changed',
          message: '入力が変わったため、この記録の明細を作り直せません。算定をやり直してください。',
        },
        { status: 409 },
      );
    }
    return new NextResponse(result.csv, {
      headers: {
        'Content-Type': EXPORT_CONTENT_TYPES.csv,
        'Content-Disposition': contentDisposition(result.fileName),
        'Cache-Control': 'private, no-store',
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
    throw error;
  }
}

export const dynamic = 'force-dynamic';
