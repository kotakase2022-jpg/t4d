import { NextResponse } from 'next/server';
import { can } from '@/lib/authorization/can';
import { getSession } from '@/lib/auth/session';
import { contentDisposition } from '@/lib/exports';
import { getDb } from '@/lib/repositories';
import { buildTemplateWorkbook } from '@/lib/services/data-entry';

/**
 * 標準入力テンプレート（Excel）のダウンロード（DATA-P0-004）。
 * 記入後はそのまま「データ収集」へドロップすれば再取込できる標準形で出す。
 */
export async function GET() {
  const session = await getSession();
  const ctx = session?.context;
  if (!ctx || ctx.workspace.organizationType !== 'enterprise') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!can(ctx, 'enterprise.import.run')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const db = await getDb();
  const organizationId = ctx.workspace.organizationId;
  const [metrics, units, periods] = await Promise.all([
    db.select('metrics', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('units', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('periods', { where: { organizationId } }),
  ]);
  const period =
    periods.find((p) => p.status === 'collecting') ??
    periods.sort((a, b) => (a.endDate < b.endDate ? 1 : -1))[0];
  if (!period) return NextResponse.json({ error: 'no_period' }, { status: 404 });

  const bytes = await buildTemplateWorkbook(metrics, units, period, ctx.workspace.unitScopeIds);
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': contentDisposition(`データ入力テンプレート_${period.code}.xlsx`),
      'Cache-Control': 'private, no-store',
    },
  });
}
