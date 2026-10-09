import { NextResponse } from 'next/server';
import { accessDeniedResponse } from '@/lib/errors/access-denied';
import { recordAuditEvent } from '@/lib/audit/logger';
import { getSession } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { contentDisposition, EXPORT_CONTENT_TYPES, toCsv } from '@/lib/exports';
import { SSBJ_REQUIREMENT_EXPORT_COLUMNS } from '@/lib/exports/ssbj-requirements';
import { getDb } from '@/lib/repositories';
import {
  filterRequirements,
  loadSsbjRequirementViews,
  resolveSsbjVersion,
} from '@/lib/services/ssbj-gap';

/**
 * 「SSBJ 要求事項の評価」一覧の CSV Export。
 *
 * 画面と同じ読み取り（loadSsbjRequirementViews）と同じ絞り込み
 * （filterRequirements）を通す。別ロジックで組み直すと、画面の件数と
 * CSV の行数が食い違ったときに原因を追えなくなる。
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.context) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const ctx = session.context;
  if (ctx.workspace.organizationType !== 'enterprise' || !can(ctx, 'enterprise.export.run')) {
    return accessDeniedResponse(await getDb(), ctx, {
      permission: 'enterprise.export.run',
      request,
    });
  }

  const url = new URL(request.url);
  const db = await getDb();
  const organizationId = ctx.workspace.organizationId;

  const periods = await db.select('periods', { where: { organizationId } });
  const period = periods.find((p) => p.id === url.searchParams.get('period')) ?? periods[0];
  if (!period) return NextResponse.json({ error: 'no_period' }, { status: 404 });

  const loaded = await loadSsbjRequirementViews(db, ctx, period);
  if (!loaded) return NextResponse.json({ error: 'no_master' }, { status: 404 });

  const rows = filterRequirements(loaded.views, {
    area: url.searchParams.getAll('area'),
    coverage: url.searchParams.getAll('coverage'),
    materiality: url.searchParams.getAll('materiality'),
    priority: url.searchParams.getAll('priority'),
    department: url.searchParams.getAll('department'),
    linkage: url.searchParams.getAll('linkage'),
    // 一覧画面の CSV リンクは scope=in_scope を渡す。落とすと対象外の行まで CSV に入る
    scope: url.searchParams.getAll('scope'),
    search: url.searchParams.get('q') ?? undefined,
  });

  // ファイル名に対象年度×基準版を入れる（列は変えない。NF-12）。ファイル名に使えない文字は除く
  const resolved = await resolveSsbjVersion(db, organizationId, period.id);
  const versionPart = resolved ? `_${resolved.version.label.replace(/[\\/:*?"<>|\s]+/g, '')}` : '';
  const baseName = `T4D_SSBJ要求事項の評価_${ctx.workspace.organizationName}_${period.code}${versionPart}`;

  await recordAuditEvent(db, ctx, {
    eventType: 'export_created',
    resourceType: 'ssbj_requirements',
    afterSummary: `${rows.length} 行を CSV で出力`,
    metadata: { period: period.code, filtered: rows.length !== loaded.views.length },
  });

  return new NextResponse(
    toCsv({ name: `SSBJ要求事項_${period.code}`, columns: SSBJ_REQUIREMENT_EXPORT_COLUMNS, rows }),
    {
      headers: {
        'Content-Type': EXPORT_CONTENT_TYPES.csv,
        'Content-Disposition': contentDisposition(`${baseName}.csv`),
        'Cache-Control': 'no-store',
      },
    },
  );
}
