import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, assertEnterpriseWorkspace, NotFoundError } from '@/lib/authorization/can';
import {
  RECONCILIATION_CHECKER_VERSION,
  RECONCILIATION_MISMATCH_LIMIT,
  compareDocx,
  compareSheets,
  parseCsv,
  type ActualSheet,
  type DocxExpectation,
  type ReconciliationResult,
  type SheetExpectation,
} from '@/lib/domain/export-reconciliation';
import { ValidationError } from '@/lib/errors/user-facing';
import { parseDocx } from '@/lib/imports/docx-text';
import { DEMO_RECONCILIATION_MISMATCH_MAX } from '@/lib/repositories/demo-trial-checks';
import type { DbClient } from '@/lib/repositories/types';
import type { ReportSnapshotDetail } from '@/lib/services/report-snapshot';
import { isUuid } from '@/lib/validation/uuid';
import type {
  AuthorizationContext,
  ExportAudience,
  ExportReconciliation,
  ExportReconciliationSource,
  ReconciledFormat,
  Uuid,
} from '@/types/domain';

/**
 * 出力の自動突合（トライアル対応 NF-15）のサービス: ファイルの読み戻し・照合・記録。
 *
 *  - 生成した出力は、利用者へ渡す前に必ず読み戻して照合する（src/lib/services/disclosure-export.ts）。
 *    不一致が 1 件でもあればファイルを渡さず、照合の記録（source=generated_blocked）だけを残す（§5 D6）
 *  - 外部で編集したファイル（DOCX・XLSX）の照合（P1）は、ファイルを保存せず sha256 と結果だけを記録する
 *    （source=uploaded）
 *  - 記録は追記専用（export_reconciliations）。明細は Supabase で先頭 50 件、Demo は Cookie の都合で 5 件まで
 *  - 照合は決定論（AI を使わない）。照合の規則の版（checker_version）を記録する
 */

export type ReconciliationExpectation =
  | { format: 'docx'; docx: DocxExpectation }
  | { format: 'xlsx'; sheets: SheetExpectation[] }
  | { format: 'csv'; csv: SheetExpectation };

/** 不一致があったため出力を止めた（記録は残した）。画面は理由と明細へのリンクを示す */
export class ExportReconciliationBlockedError extends ValidationError {
  readonly reconciliationId: Uuid;
  readonly mismatchCount: number;

  constructor(record: ExportReconciliation) {
    super(
      `出力したファイルと承認版の突合で不一致が ${record.mismatchCount} 件見つかったため、ファイルを渡しませんでした（突合の記録は残しました）。`,
    );
    this.name = 'ExportReconciliationBlockedError';
    this.reconciliationId = record.id;
    this.mismatchCount = record.mismatchCount;
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** exceljs のセルの値を比べられる値にする（文字列の装飾・式の結果・日付を素の値へ） */
function cellValueOf(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const v = value as {
      richText?: Array<{ text?: string }>;
      text?: unknown;
      result?: unknown;
      error?: unknown;
    };
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text ?? '').join('');
    if (v.text !== undefined) return cellValueOf(v.text);
    if (v.result !== undefined) return cellValueOf(v.result);
    if (v.error !== undefined) return String(v.error);
  }
  return String(value);
}

/** XLSX をシート名 → 行（セルの値）に読み戻す */
export async function readXlsxSheets(bytes: Uint8Array): Promise<Map<string, ActualSheet>> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  const sheets = new Map<string, ActualSheet>();
  workbook.eachSheet((ws) => {
    const width = ws.columnCount;
    const rows: unknown[][] = [];
    for (let n = 1; n <= ws.rowCount; n += 1) {
      const row = ws.getRow(n);
      rows.push(Array.from({ length: width }, (_, i) => cellValueOf(row.getCell(i + 1).value)));
    }
    sheets.set(ws.name, rows);
  });
  return sheets;
}

/** ファイルを読み戻して期待値と照合する（承認の照合は呼び出し側が足す） */
export async function reconcileFile(
  bytes: Uint8Array,
  expectation: ReconciliationExpectation,
): Promise<ReconciliationResult> {
  switch (expectation.format) {
    case 'docx': {
      const parsed = await parseDocx(bytes);
      return compareDocx(expectation.docx, parsed.paragraphs);
    }
    case 'xlsx':
      return compareSheets(expectation.sheets, await readXlsxSheets(bytes));
    case 'csv': {
      const rows = parseCsv(new TextDecoder('utf-8').decode(bytes));
      return compareSheets([expectation.csv], new Map([[expectation.csv.name, rows]]));
    }
  }
}

/** 照合の記録を追記する（明細は上限で切る。件数は全件） */
export async function recordReconciliation(
  db: DbClient,
  ctx: AuthorizationContext,
  input: {
    snapshot: Pick<ReportSnapshotDetail, 'id' | 'label' | 'snapshotNo'>;
    source: ExportReconciliationSource;
    format: ReconciledFormat;
    audience: ExportAudience;
    frameworkVersionId: Uuid | null;
    fileSha256: string;
    result: ReconciliationResult;
  },
): Promise<ExportReconciliation> {
  assertEnterpriseWorkspace(ctx);
  // RLS（INSERT）と同じ条件: 出力の権限と本人名義
  assertCan(ctx, 'enterprise.export.run');
  const limit =
    db.mode === 'demo' ? DEMO_RECONCILIATION_MISMATCH_MAX : RECONCILIATION_MISMATCH_LIMIT;
  const row: ExportReconciliation = {
    id: randomUUID(),
    organizationId: ctx.workspace.organizationId,
    snapshotId: input.snapshot.id,
    source: input.source,
    format: input.format,
    audience: input.audience,
    frameworkVersionId: input.frameworkVersionId,
    fileSha256: input.fileSha256,
    checkerVersion: RECONCILIATION_CHECKER_VERSION,
    paragraphsChecked: input.result.paragraphs,
    numbersChecked: input.result.numbers,
    rowsChecked: input.result.rows,
    mismatchCount: input.result.mismatchCount,
    mismatches: input.result.mismatches.slice(0, limit),
    createdBy: ctx.userId,
    createdAt: new Date().toISOString(),
  };
  const [inserted] = await db.insert('exportReconciliations', [row]);
  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'export_reconciliation',
    resourceId: row.id,
    afterSummary: `${input.snapshot.label} No.${input.snapshot.snapshotNo} の ${input.format.toUpperCase()} を突合（${
      input.source === 'uploaded' ? '外部で編集したファイル' : '不一致のため出力を停止'
    }・不一致 ${row.mismatchCount} 件）`,
    metadata: {
      snapshotId: input.snapshot.id,
      source: input.source,
      format: input.format,
      audience: input.audience,
      fileSha256: input.fileSha256,
      checkerVersion: RECONCILIATION_CHECKER_VERSION,
      mismatchCount: row.mismatchCount,
    },
  });
  return inserted ?? row;
}

export interface ReconciliationView extends ExportReconciliation {
  createdByName: string;
}

/** スナップショットごとの照合の記録（新しい順）。スナップショットが自組織のものであることを前提に呼ぶ */
export async function listReconciliations(
  db: DbClient,
  ctx: AuthorizationContext,
  snapshotIds: readonly Uuid[],
): Promise<ReconciliationView[]> {
  assertEnterpriseWorkspace(ctx);
  if (snapshotIds.length === 0) return [];
  const rows = await db.select('exportReconciliations', {
    where: { organizationId: ctx.workspace.organizationId, snapshotId: { in: [...snapshotIds] } },
    orderBy: [
      { column: 'createdAt', dir: 'desc' },
      { column: 'id', dir: 'desc' },
    ],
  });
  const userIds = [...new Set(rows.map((r) => r.createdBy))];
  const profiles =
    userIds.length === 0 ? [] : await db.select('profiles', { where: { id: { in: userIds } } });
  return rows.map((row) => ({
    ...row,
    createdByName: profiles.find((p) => p.id === row.createdBy)?.displayName ?? '—',
  }));
}

/** 照合の記録を 1 件（自組織だけ。他組織・存在しない ID は「見つからない」） */
export async function loadReconciliation(
  db: DbClient,
  ctx: AuthorizationContext,
  reconciliationId: Uuid,
): Promise<ReconciliationView> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.read');
  const row = isUuid(reconciliationId)
    ? await db.findById('exportReconciliations', reconciliationId)
    : null;
  if (!row || row.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('突合の記録が見つかりません。');
  }
  const profile = await db.findById('profiles', row.createdBy);
  return { ...row, createdByName: profile?.displayName ?? '—' };
}
