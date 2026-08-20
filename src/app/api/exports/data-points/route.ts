import { NextResponse } from 'next/server';
import { recordAuditEvent } from '@/lib/audit/logger';
import { getSession } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import {
  contentDisposition,
  EXPORT_CONTENT_TYPES,
  toCsv,
  toXlsx,
  type ExportColumn,
  type ExportFormat,
} from '@/lib/exports';
import { formatJst } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import {
  buildDataPointRows,
  loadPeriodDataset,
  type DataPointRow,
} from '@/lib/services/enterprise-data';

/** 非財務データ台帳の CSV / XLSX Export（指示書 7.1-16 / 15.2）。 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.context) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const ctx = session.context;
  if (ctx.workspace.organizationType !== 'enterprise' || !can(ctx, 'enterprise.export.run')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const url = new URL(request.url);
  const format = (url.searchParams.get('format') ?? 'csv') as ExportFormat;
  if (format !== 'csv' && format !== 'xlsx') {
    return NextResponse.json({ error: 'unsupported_format' }, { status: 400 });
  }

  const db = await getDb();
  const organizationId = ctx.workspace.organizationId;

  const periods = await db.select('periods', { where: { organizationId } });
  const periodId = url.searchParams.get('period');
  const period = periods.find((p) => p.id === periodId) ?? periods[0];
  if (!period) return NextResponse.json({ error: 'no_period' }, { status: 404 });

  const [metrics, units] = await Promise.all([
    db.select('metrics', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('units', { where: { organizationId, deletedAt: { isNull: true } } }),
  ]);

  const dataset = await loadPeriodDataset(db, ctx, period, metrics, units, periods);
  const rows = buildDataPointRows(dataset, period, ctx);

  const columns: ExportColumn<DataPointRow>[] = [
    { key: 'metricCode', header: '指標コード', value: (r) => r.metric.code },
    { key: 'metricName', header: '指標名', value: (r) => r.metric.name },
    { key: 'unitName', header: '組織・拠点', value: (r) => r.unit.name },
    { key: 'boundary', header: '境界', value: (r) => r.dataPoint.boundary },
    { key: 'period', header: '対象期間', value: (r) => r.period.code },
    { key: 'value', header: '値', value: (r) => r.dataPoint.value, numeric: true },
    { key: 'unitOfMeasure', header: '単位', value: (r) => r.dataPoint.unitOfMeasure },
    { key: 'definedUnit', header: '定義単位', value: (r) => r.metric.unit },
    { key: 'status', header: '状態', value: (r) => r.dataPoint.status },
    { key: 'errors', header: '検証エラー数', value: (r) => r.errorCount, numeric: true },
    { key: 'warnings', header: '検証警告数', value: (r) => r.warningCount, numeric: true },
    { key: 'evidence', header: 'Evidence 件数', value: (r) => r.evidenceCount, numeric: true },
    {
      key: 'evidenceRequired',
      header: 'Evidence 必須',
      value: (r) => (r.metric.requiresEvidence ? 'はい' : 'いいえ'),
    },
    { key: 'methodology', header: '算定方法', value: (r) => r.dataPoint.methodology ?? '' },
    {
      key: 'changedAfterApproval',
      header: '承認後変更',
      value: (r) => (r.dataPoint.changedAfterApproval ? 'あり' : ''),
    },
    { key: 'approvedAt', header: '承認日時', value: (r) => formatJst(r.dataPoint.approvedAt) },
    { key: 'updatedAt', header: '更新日時', value: (r) => formatJst(r.dataPoint.updatedAt) },
    { key: 'dataPointId', header: 'Data Point ID', value: (r) => r.dataPoint.id },
  ];

  const sheet = { name: `非財務データ_${period.code}`, columns, rows };
  const baseName = `T4D_非財務データ_${ctx.workspace.organizationName}_${period.code}`;

  await recordAuditEvent(db, ctx, {
    eventType: 'export_created',
    resourceType: 'data_points',
    afterSummary: `${rows.length} 行を ${format.toUpperCase()} で出力`,
    metadata: { period: period.code, format },
  });

  if (format === 'csv') {
    return new NextResponse(toCsv(sheet), {
      headers: {
        'Content-Type': EXPORT_CONTENT_TYPES.csv,
        'Content-Disposition': contentDisposition(`${baseName}.csv`),
        'Cache-Control': 'no-store',
      },
    });
  }

  const buffer = await toXlsx([sheet], baseName);
  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      'Content-Type': EXPORT_CONTENT_TYPES.xlsx,
      'Content-Disposition': contentDisposition(`${baseName}.xlsx`),
      'Cache-Control': 'no-store',
    },
  });
}
