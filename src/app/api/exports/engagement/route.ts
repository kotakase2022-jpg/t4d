import { NextResponse } from 'next/server';
import { recordAuditEvent } from '@/lib/audit/logger';
import { getSession } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import {
  contentDisposition,
  EXPORT_CONTENT_TYPES,
  toCsv,
  toXlsx,
  type ExportSheet,
} from '@/lib/exports';
import { formatJst } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import {
  detectSnapshotChanges,
  loadEngagement,
  loadLatestSnapshot,
  loadPopulation,
  loadTestingWorkspace,
} from '@/lib/services/assurance';

/**
 * 案件パッケージ Export（指示書 7.2-20 / ASSUR-P0-013）。
 *
 * 監査法人内部メモ（pbc_requests.internal_note）は含めるが、
 * これは監査法人ユーザー向けの Export であり、企業側からは実行できない。
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.context) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const ctx = session.context;
  if (ctx.workspace.organizationType !== 'assurance_firm' || !can(ctx, 'assurance.export.run')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const url = new URL(request.url);
  const engagementId = url.searchParams.get('engagementId');
  const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'xlsx';
  if (!engagementId) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  const db = await getDb();

  let context;
  try {
    context = await loadEngagement(db, ctx, engagementId);
  } catch {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const [
    scopes,
    snapshot,
    population,
    testing,
    pbcRequests,
    issues,
    reviewNotes,
    signoffs,
    auditEvents,
  ] = await Promise.all([
    db.select('engagementScopes', { where: { engagementId } }),
    loadLatestSnapshot(db, engagementId),
    loadPopulation(db, ctx, engagementId),
    loadTestingWorkspace(db, ctx, engagementId),
    db.select('pbcRequests', { where: { engagementId } }),
    db.select('issues', { where: { engagementId } }),
    db.select('reviewNotes', { where: { engagementId } }),
    db.select('signoffs', { where: { engagementId } }),
    db.select('auditEvents', {
      where: { engagementId },
      orderBy: { column: 'createdAt', dir: 'desc' },
      limit: 500,
    }),
  ]);

  const snapshotItems = snapshot
    ? await db.select('snapshotItems', { where: { snapshotId: snapshot.id } })
    : [];
  const changes = snapshot ? await detectSnapshotChanges(db, ctx, snapshot.id) : [];
  const samples = await db.select('samples', { where: { engagementId } });
  const procedures = await db.select('procedures', { where: { engagementId } });
  const testResults = await db.select('testResults', { where: { engagementId } });
  const responses =
    pbcRequests.length > 0
      ? await db.select('pbcResponses', {
          where: { requestId: { in: pbcRequests.map((r) => r.id) } },
        })
      : [];

  const metricIds = [...new Set(scopes.map((s) => s.metricId))];
  const unitIds = [...new Set(scopes.map((s) => s.unitId))];
  const [metrics, units] = await Promise.all([
    metricIds.length > 0 ? db.select('metrics', { where: { id: { in: metricIds } } }) : [],
    unitIds.length > 0 ? db.select('units', { where: { id: { in: unitIds } } }) : [],
  ]);
  const metricName = (id: string) => metrics.find((m) => m.id === id)?.name ?? id.slice(0, 8);
  const unitName = (id: string) => units.find((u) => u.id === id)?.name ?? id.slice(0, 8);
  const procedureCode = (id: string) => procedures.find((p) => p.id === id)?.code ?? id.slice(0, 8);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 各シートで行型が異なるため
  const sheets: ExportSheet<any>[] = [
    {
      name: 'スコープ',
      columns: [
        { key: 'unit', header: '組織', value: (r) => unitName(r.unitId) },
        { key: 'metric', header: '指標', value: (r) => metricName(r.metricId) },
        { key: 'inclusion', header: '対象区分', value: (r) => r.inclusion },
        { key: 'risk', header: 'リスク', value: (r) => r.riskTag },
        { key: 'materiality', header: '重要', value: (r) => (r.materialityFlag ? 'はい' : '') },
        { key: 'note', header: '備考', value: (r) => r.note ?? '' },
      ],
      rows: scopes,
    },
    {
      name: 'Snapshot項目',
      columns: [
        { key: 'sourceId', header: 'Data Point ID', value: (r) => r.sourceId },
        {
          key: 'value',
          header: '固定値',
          value: (r) => Number(r.valueSnapshot.value ?? 0),
          numeric: true,
        },
        { key: 'unit', header: '単位', value: (r) => String(r.valueSnapshot.unitOfMeasure ?? '') },
        {
          key: 'versionNo',
          header: 'Version',
          value: (r) => Number(r.valueSnapshot.versionNo ?? 0),
          numeric: true,
        },
        { key: 'hash', header: 'Hash', value: (r) => r.hash },
        { key: 'frozenAt', header: '固定日時', value: (r) => formatJst(r.frozenAt) },
      ],
      rows: snapshotItems,
    },
    {
      name: 'Snapshot後変更',
      columns: [
        { key: 'before', header: '固定時点', value: (r) => r.beforeSummary },
        { key: 'after', header: '現在', value: (r) => r.afterSummary },
        { key: 'kind', header: '区分', value: (r) => r.changeKind },
        { key: 'assessment', header: '影響評価', value: (r) => r.assessment ?? '未評価' },
        { key: 'detectedAt', header: '検知', value: (r) => formatJst(r.detectedAt) },
      ],
      rows: changes,
    },
    {
      name: '母集団',
      columns: [
        { key: 'metric', header: '指標', value: (r) => r.metricName },
        { key: 'unit', header: '組織', value: (r) => r.unitName },
        { key: 'value', header: '固定値', value: (r) => r.value, numeric: true },
        { key: 'unitOfMeasure', header: '単位', value: (r) => r.unitOfMeasure },
        { key: 'excluded', header: '除外', value: (r) => (r.excluded ? 'はい' : '') },
      ],
      rows: population?.items ?? [],
    },
    {
      name: 'サンプル',
      columns: [
        { key: 'name', header: 'サンプル名', value: (r) => r.name },
        { key: 'method', header: '方法', value: (r) => r.method },
        { key: 'seed', header: 'Seed', value: (r) => r.seed },
        { key: 'size', header: '件数', value: (r) => r.size, numeric: true },
        { key: 'rationale', header: '選定理由', value: (r) => r.rationale },
        { key: 'createdAt', header: '作成', value: (r) => formatJst(r.createdAt) },
      ],
      rows: samples,
    },
    {
      name: 'テスト',
      columns: [
        { key: 'unit', header: '組織', value: (r) => r.unitName },
        { key: 'metric', header: '指標', value: (r) => r.metricName },
        { key: 'status', header: '状態', value: (r) => r.status },
        {
          key: 'snapshotValue',
          header: 'Snapshot 値',
          value: (r) => r.snapshotValue,
          numeric: true,
        },
        { key: 'currentValue', header: '現在値', value: (r) => r.currentValue, numeric: true },
        { key: 'workpaperRef', header: '調書番号', value: (r) => r.workpaperRef ?? '' },
        { key: 'conclusion', header: '結論', value: (r) => r.conclusionDraft ?? '' },
        { key: 'selectionReason', header: '抽出理由', value: (r) => r.selectionReason },
      ],
      rows: testing.rows,
    },
    {
      name: 'テスト結果',
      columns: [
        { key: 'testId', header: 'Test ID', value: (r) => r.testId },
        { key: 'procedure', header: '手続', value: (r) => procedureCode(r.procedureId) },
        { key: 'result', header: '結果', value: (r) => r.result },
        {
          key: 'recalculation',
          header: '再計算',
          value: (r) => r.recalculationResult,
          numeric: true,
        },
        { key: 'recorded', header: '記録値', value: (r) => r.recordedValue, numeric: true },
        { key: 'difference', header: '差異', value: (r) => r.difference, numeric: true },
        { key: 'note', header: 'メモ', value: (r) => r.note ?? '' },
        { key: 'completedAt', header: '実施', value: (r) => formatJst(r.completedAt) },
      ],
      rows: testResults,
    },
    {
      name: 'PBC',
      columns: [
        { key: 'code', header: 'コード', value: (r) => r.code },
        { key: 'title', header: '件名', value: (r) => r.title },
        { key: 'status', header: '状態', value: (r) => r.status },
        { key: 'priority', header: '優先度', value: (r) => r.priority },
        { key: 'dueDate', header: '期限', value: (r) => r.dueDate },
        { key: 'internalNote', header: '内部メモ', value: (r) => r.internalNote ?? '' },
        {
          key: 'response',
          header: '企業回答',
          value: (r) => responses.find((x) => x.requestId === r.id)?.body ?? '',
        },
        {
          key: 'decision',
          header: '受領判定',
          value: (r) => responses.find((x) => x.requestId === r.id)?.decision ?? '',
        },
      ],
      rows: pbcRequests,
    },
    {
      name: '指摘',
      columns: [
        { key: 'code', header: 'コード', value: (r) => r.code },
        { key: 'title', header: 'タイトル', value: (r) => r.title },
        { key: 'severity', header: '重要度', value: (r) => r.severity },
        { key: 'status', header: '状態', value: (r) => r.status },
        { key: 'impact', header: '定量的影響', value: (r) => r.quantitativeImpact, numeric: true },
        { key: 'impactUnit', header: '単位', value: (r) => r.quantitativeImpactUnit ?? '' },
        { key: 'rootCause', header: '原因', value: (r) => r.rootCause ?? '' },
        { key: 'resolution', header: '解消', value: (r) => r.resolution ?? '' },
      ],
      rows: issues,
    },
    {
      name: 'レビューNote',
      columns: [
        { key: 'body', header: '内容', value: (r) => r.body },
        { key: 'status', header: '状態', value: (r) => r.status },
        {
          key: 'shared',
          header: 'クライアント共有',
          value: (r) => (r.sharedWithClient ? 'はい' : 'いいえ'),
        },
        { key: 'resolution', header: '対応', value: (r) => r.resolutionComment ?? '' },
        { key: 'createdAt', header: '起票', value: (r) => formatJst(r.createdAt) },
      ],
      rows: reviewNotes,
    },
    {
      name: 'Signoff',
      columns: [
        { key: 'stage', header: '段階', value: (r) => r.signoffStage },
        { key: 'userId', header: '実行者 ID', value: (r) => r.userId },
        { key: 'roleKey', header: 'ロール', value: (r) => r.roleKey },
        { key: 'version', header: '版', value: (r) => r.version, numeric: true },
        { key: 'snapshotId', header: '対象 Snapshot', value: (r) => r.snapshotId ?? '' },
        { key: 'createdAt', header: '日時', value: (r) => formatJst(r.createdAt) },
      ],
      rows: signoffs,
    },
    {
      name: '監査ログ',
      columns: [
        { key: 'createdAt', header: '日時', value: (r) => formatJst(r.createdAt) },
        { key: 'eventType', header: 'イベント', value: (r) => r.eventType },
        { key: 'resourceType', header: '対象種別', value: (r) => r.resourceType ?? '' },
        { key: 'before', header: '変更前', value: (r) => r.beforeSummary ?? '' },
        { key: 'after', header: '変更後', value: (r) => r.afterSummary ?? '' },
      ],
      rows: auditEvents,
    },
  ];

  const baseName = `T4D_案件パッケージ_${context.engagement.code}_${context.periodCode}`;

  await recordAuditEvent(db, ctx, {
    eventType: 'export_created',
    resourceType: 'engagement_package',
    resourceId: engagementId,
    engagementId,
    afterSummary: `${sheets.length} シートを ${format.toUpperCase()} で出力`,
  });

  if (format === 'csv') {
    const summary = sheets[5];
    if (!summary) return NextResponse.json({ error: 'no_data' }, { status: 404 });
    return new NextResponse(toCsv(summary), {
      headers: {
        'Content-Type': EXPORT_CONTENT_TYPES.csv,
        'Content-Disposition': contentDisposition(`${baseName}_テスト.csv`),
        'Cache-Control': 'no-store',
      },
    });
  }

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
