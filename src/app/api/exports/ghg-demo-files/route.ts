import { NextResponse } from 'next/server';
import { recordAuditEvent } from '@/lib/audit/logger';
import { getSession } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { accessDeniedResponse } from '@/lib/errors/access-denied';
import { contentDisposition, EXPORT_CONTENT_TYPES, toCsv, toXlsx } from '@/lib/exports';
import { buildGhgDemoFile, isGhgDemoFileKind } from '@/lib/fixtures/ghg-demo-files';
import { createFixtureDb } from '@/lib/fixtures/store';
import { getDb } from '@/lib/repositories';

/**
 * Scope1・2 の算定と照合の架空のサンプルファイル（plan E20。?kind=factor-set|energy|transport|baseline）。
 *
 * Demo Mode だけ。Supabase Mode では 404（架空のファイルを実データの環境に置かない）。
 * 内容は Fixture の初期状態から決定論で作る（利用者の編集に左右されない）。閲覧の権限（enterprise.data.read）で
 * 取れる。権限は何かを読む前に確かめ、断ったら 403 と監査ログ access_denied。出したら監査ログ export_created。
 */
export async function GET(request: Request) {
  const session = await getSession();
  const ctx = session?.context;
  if (!ctx) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const db = await getDb();
  if (db.mode !== 'demo') return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (ctx.workspace.organizationType !== 'enterprise' || !can(ctx, 'enterprise.data.read')) {
    return accessDeniedResponse(db, ctx, { permission: 'enterprise.data.read', request });
  }

  const kind = new URL(request.url).searchParams.get('kind');
  if (!isGhgDemoFileKind(kind)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const file = buildGhgDemoFile(kind, createFixtureDb());

  await recordAuditEvent(db, ctx, {
    eventType: 'export_created',
    resourceType: 'ghg_demo_file',
    resourceId: null,
    afterSummary: `Scope1・2 の算定の架空のサンプルファイルを出力（${file.label}・${file.sheet.rows.length} 行）`,
    metadata: { kind },
  });

  if (file.format === 'csv') {
    return new NextResponse(toCsv(file.sheet), {
      headers: {
        'Content-Type': EXPORT_CONTENT_TYPES.csv,
        'Content-Disposition': contentDisposition(file.fileName),
        'Cache-Control': 'private, no-store',
      },
    });
  }
  const buffer = await toXlsx([file.sheet], file.fileName.replace(/\.xlsx$/, ''));
  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      'Content-Type': EXPORT_CONTENT_TYPES.xlsx,
      'Content-Disposition': contentDisposition(file.fileName),
      'Cache-Control': 'private, no-store',
    },
  });
}

export const dynamic = 'force-dynamic';
