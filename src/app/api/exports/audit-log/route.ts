import { NextResponse } from 'next/server';
import { recordAuditEvent } from '@/lib/audit/logger';
import { getSession } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { accessDeniedResponse } from '@/lib/errors/access-denied';
import { contentDisposition, EXPORT_CONTENT_TYPES, toCsv, type ExportColumn } from '@/lib/exports';
import { formatJst } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import {
  auditFilterFrom,
  listOrganizationAuditForExport,
  type AuditLogEntry,
} from '@/lib/services/audit-log';

/**
 * 企業側の監査ログの CSV（トライアル対応 NF-26）。画面と同じ絞り込み（期間・種類・実行者・
 * 監査法人の資料アクセスのみ）の URL の値をそのまま受け取る。
 *
 * 権限（common.audit.read）を ID・絞り込みより先に検査し、403 は JSON（監査ログ access_denied）。
 * 書き出しも監査ログ export_created に残す。値の数式は toCsv が無害化する。上限 10,000 行。
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.context) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const ctx = session.context;
  const db = await getDb();
  if (ctx.workspace.organizationType !== 'enterprise' || !can(ctx, 'common.audit.read')) {
    return accessDeniedResponse(db, ctx, { permission: 'common.audit.read', request });
  }

  const url = new URL(request.url);
  const filter = auditFilterFrom(Object.fromEntries(url.searchParams.entries()));
  const { entries, total } = await listOrganizationAuditForExport(db, ctx, filter);

  const columns: ExportColumn<AuditLogEntry>[] = [
    { key: 'at', header: '日時（日本時間）', value: (e) => formatJst(e.at) },
    { key: 'kind', header: '種類', value: (e) => e.kindLabel },
    // 監査人が照合に使う記録上の識別子（イベントのコード）。画面では種類の名前を主に出す
    { key: 'code', header: '記録の種類コード', value: (e) => e.kindKey },
    { key: 'actor', header: '実行者', value: (e) => e.actorName },
    { key: 'affiliation', header: '所属', value: (e) => e.affiliation.label },
    { key: 'target', header: '対象', value: (e) => e.target },
    { key: 'summary', header: '要約', value: (e) => e.summary },
  ];
  const baseName = `T4D_監査ログ_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;

  await recordAuditEvent(db, ctx, {
    eventType: 'export_created',
    resourceType: 'audit_events',
    afterSummary: `監査ログを CSV で出力（${entries.length} 行${total > entries.length ? `・全 ${total} 件のうち上限まで` : ''}）`,
    metadata: {
      period: filter.period ?? null,
      kind: filter.kind ?? null,
      firmFilesOnly: filter.firmFilesOnly ?? false,
    },
  });

  return new NextResponse(toCsv({ name: '監査ログ', columns, rows: entries }), {
    headers: {
      'Content-Type': EXPORT_CONTENT_TYPES.csv,
      'Content-Disposition': contentDisposition(`${baseName}.csv`),
      'Cache-Control': 'no-store',
    },
  });
}
