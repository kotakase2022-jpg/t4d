import { NextResponse } from 'next/server';
import { recordAuditEvent } from '@/lib/audit/logger';
import { getSession } from '@/lib/auth/session';
import { can, NotFoundError } from '@/lib/authorization/can';
import { getBuildInfo } from '@/lib/build-info';
import { accessDeniedResponse } from '@/lib/errors/access-denied';
import { contentDisposition, EXPORT_CONTENT_TYPES, toXlsx } from '@/lib/exports';
import { buildGhgReconciliationSheets } from '@/lib/exports/ghg-reconciliation';
import { toJstDate } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import { loadReconciliation } from '@/lib/services/ghg/reconciliation';
import { isUuid } from '@/lib/validation/uuid';

/**
 * 照合の結果の XLSX（plan E19・CR-15。?id= は照合の記録）。
 *
 * 出力の権限（enterprise.export.run）。権限は何かを読む前に確かめ、断ったら 403 と監査ログ access_denied。
 * 出したら監査ログ export_created（resource_type ghg_reconciliation）。結果を作り直せない照合
 * （入力が変わった・照合の規則の版が違う）は数値を出さず 409。注記の文は画面の固定文と同じ（N3・N4・N9）。
 */
export async function GET(request: Request) {
  const session = await getSession();
  const ctx = session?.context;
  if (!ctx) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const db = await getDb();
  if (ctx.workspace.organizationType !== 'enterprise' || !can(ctx, 'enterprise.export.run')) {
    return accessDeniedResponse(db, ctx, { permission: 'enterprise.export.run', request });
  }
  const id = new URL(request.url).searchParams.get('id');
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  let loaded;
  try {
    loaded = await loadReconciliation(db, ctx, id);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    throw error;
  }
  const items = loaded.items;
  if (!items) return NextResponse.json({ error: 'not_rebuildable' }, { status: 409 });

  const organizationId = ctx.workspace.organizationId;
  const userIds = [
    ...new Set([
      loaded.reconciliation.createdBy,
      ...items.flatMap((i) => i.notes.map((n) => n.decidedBy)),
    ]),
  ];
  const [units, profiles, period] = await Promise.all([
    db.select('units', { where: { organizationId } }),
    db.select('profiles', { where: { id: { in: userIds } } }),
    db.findById('periods', loaded.run.reportingPeriodId),
  ]);
  const generatedAt = new Date().toISOString();
  const build = getBuildInfo().commit;
  const sheets = buildGhgReconciliationSheets({
    loaded: { ...loaded, items },
    units: new Map(units.map((u) => [u.id, { code: u.code, name: u.name }])),
    userNames: new Map(profiles.map((p) => [p.id, p.displayName])),
    periodLabel: period?.label ?? '',
    demo: ctx.demo || db.mode === 'demo',
    build,
    generatedAt,
  });

  await recordAuditEvent(db, ctx, {
    eventType: 'export_created',
    resourceType: 'ghg_reconciliation',
    resourceId: loaded.reconciliation.id,
    afterSummary: `照合の結果を XLSX で出力（項目 ${items.length} 件・確認の記録 ${items.reduce((n, i) => n + i.notes.length, 0)} 件）`,
    metadata: {
      runId: loaded.run.id,
      baselineId: loaded.baseline.id,
      baselineSha256: loaded.baseline.fileSha256,
      checkerVersion: loaded.reconciliation.checkerVersion,
      build,
    },
  });

  const baseName = `T4D_照合結果_${period?.code ?? 'period'}_${toJstDate(generatedAt)}`;
  const buffer = await toXlsx(sheets, baseName);
  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      'Content-Type': EXPORT_CONTENT_TYPES.xlsx,
      'Content-Disposition': contentDisposition(`${baseName}.xlsx`),
      'Cache-Control': 'private, no-store',
    },
  });
}

export const dynamic = 'force-dynamic';
