import { NextResponse } from 'next/server';
import { can } from '@/lib/authorization/can';
import { getSession } from '@/lib/auth/session';
import { contentDisposition } from '@/lib/exports';
import { buildSupplierDemoFiles } from '@/lib/fixtures/supplier-demo-files';

/**
 * サプライヤーデータ取込のデモ用サンプルファイル（架空データ）の配布。
 * 内容は決定論生成（supplier-demo-files.ts）で、取り込むと自動仕訳が体験できる。
 */
export async function GET(request: Request) {
  const session = await getSession();
  const ctx = session?.context;
  if (!ctx || ctx.workspace.organizationType !== 'enterprise') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!can(ctx, 'enterprise.import.run')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const key = new URL(request.url).searchParams.get('file');
  const file = buildSupplierDemoFiles().find((f) => f.key === key);
  if (!file) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return new NextResponse(file.content, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': contentDisposition(file.fileName),
      'Cache-Control': 'private, no-store',
    },
  });
}
