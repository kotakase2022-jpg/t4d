import { NextResponse } from 'next/server';
import { recordAuditEvent } from '@/lib/audit/logger';
import { getSession } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { getBuildInfo } from '@/lib/build-info';
import { accessDeniedResponse } from '@/lib/errors/access-denied';
import { contentDisposition, EXPORT_CONTENT_TYPES, toXlsx } from '@/lib/exports';
import { buildTrialReportSheets } from '@/lib/exports/trial-report';
import { toJstDate } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import { summarizeScenarios } from '@/lib/services/trial-evaluation';
import { summarizeOpenIssues } from '@/lib/services/trial-feedback';
import { loadTrialProgram } from '@/lib/services/trial-program';
import { summarizeTimings } from '@/lib/services/trial-timing';
import { reductionTargetOf } from '@/lib/domain/trial-metrics';

/**
 * 検証結果・改善管理表の XLSX（トライアル対応 NF-33・NF-34・NF-35。plan 付録 D）。
 *
 * 企業管理者（enterprise.org.manage）だけ。権限は何かを読む前に確かめ、断ったら 403（JSON）と
 * 監査ログ access_denied。出力したら監査ログ export_created（resource_type trial_report）。
 * 監査法人のワークスペースからは出せない（トライアルの記録は企業テナントだけのもの）。
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.context) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const ctx = session.context;
  const db = await getDb();
  if (ctx.workspace.organizationType !== 'enterprise' || !can(ctx, 'enterprise.org.manage')) {
    return accessDeniedResponse(db, ctx, { permission: 'enterprise.org.manage', request });
  }

  const [scenarios, feedback, timings, program] = await Promise.all([
    summarizeScenarios(db, ctx),
    summarizeOpenIssues(db, ctx),
    summarizeTimings(db, ctx),
    loadTrialProgram(db, ctx),
  ]);
  const generatedAt = new Date().toISOString();
  const build = getBuildInfo().commit;
  const sheets = buildTrialReportSheets({
    scenarios,
    feedback,
    timings,
    target: program ? reductionTargetOf(program.options) : null,
    demo: ctx.demo || db.mode === 'demo',
    build,
    generatedAt,
  });

  await recordAuditEvent(db, ctx, {
    eventType: 'export_created',
    resourceType: 'trial_report',
    resourceId: program?.id ?? null,
    afterSummary: `検証結果・改善管理表を XLSX で出力（シナリオ ${scenarios.rows.length}・改善 ${feedback.items.length}・作業時間 ${timings.records.length}）`,
    metadata: { build },
  });

  const baseName = `T4D_検証結果・改善管理表_${toJstDate(generatedAt)}`;
  const buffer = await toXlsx(sheets, baseName);
  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      'Content-Type': EXPORT_CONTENT_TYPES.xlsx,
      'Content-Disposition': contentDisposition(`${baseName}.xlsx`),
      'Cache-Control': 'no-store',
    },
  });
}

export const dynamic = 'force-dynamic';
