import 'server-only';

import { randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import {
  AuthorizationError,
  NotFoundError,
  assertEnterpriseWorkspace,
  can,
} from '@/lib/authorization/can';
import {
  RECONCILIATION_CHECKER_VERSION,
  approvalMismatches,
  withApprovalCheck,
} from '@/lib/domain/export-reconciliation';
import { ValidationError } from '@/lib/errors/user-facing';
import { EXPORT_CONTENT_TYPES } from '@/lib/exports';
import {
  DISCLOSURE_REPORT_TEMPLATE_VERSION,
  auxiliaryFileName,
  buildDisclosureDocx,
  buildMappingXlsx,
  buildMetricCsv,
  buildReconciliationXlsx,
  buildTraceXlsx,
  docxExpectation,
  exportFileName,
  mappingWorkbookModel,
  metricCsvExpectation,
  sheetExpectations,
  type ReportExportContext,
  type RequirementExportContext,
} from '@/lib/exports/disclosure-report';
import {
  ExportReconciliationBlockedError,
  listReconciliations,
  reconcileFile,
  recordReconciliation,
  sha256Hex,
  type ReconciliationExpectation,
} from '@/lib/services/export-reconciliation';
import { listNotesForClient } from '@/lib/services/assurance-notes';
import { listSharedReportsForClient } from '@/lib/services/report-share';
import { loadTraceContext } from '@/lib/services/report-trace';
import { loadRequirementMatrix } from '@/lib/services/requirement-matrix';
import {
  frozenMaskedFileNames,
  loadOwnedSnapshot,
  loadRequirementState,
  verifySnapshotIntegrity,
  type ReportSnapshotDetail,
  type SnapshotFramework,
} from '@/lib/services/report-snapshot';
import type { DbClient } from '@/lib/repositories/types';
import {
  EXPORT_AUDIENCES,
  RECONCILED_FORMATS,
  type AuthorizationContext,
  type ExportArtifact,
  type ExportAudience,
  type ExportReconciliation,
  type ReconciledFormat,
  type Uuid,
} from '@/types/domain';

/**
 * スナップショットから原稿・表として出力する形式（DOCX・XLSX・CSV）。XBRL（xbrl_json・ixbrl_html）は
 * 別の出力（社内確認用の XBRL）で扱い、ここでは受け付けない（0051 で出力記録の形式に足したため区別する）
 */
export type SnapshotExportFormat = ReconciledFormat;

/**
 * スナップショットからの出力（指示書 §6.10・§10.2「承認済み版を出力」・§10.3 過去スナップショットの再出力）。
 *
 * - 出力は必ず 1 つのスナップショットから作る（ライブの最新値から組み立て直さない）。
 * - 権限（enterprise.export.run）とテナントは**出力のたびに**確認する。過去のスナップショットの
 *   再出力も同じ経路で、作成時に権限があったことを理由に通さない。
 * - 他テナントのスナップショット ID は「見つからない」として扱い、存在を漏らさない（A29）。
 * - 出力ごとに export_artifacts へ形式・区分・テンプレート版・サイズ・ファイルのハッシュ・
 *   スナップショットの内容ハッシュを記録し、監査ログ（export_created）を残す。
 *   ファイルのハッシュは生成日時を含むため出力ごとに変わりうるが、内容ハッシュは同じスナップショット
 *   なら一致する（A31: 違いを説明できるように両方を残す）。
 * - 生成したファイルは渡す前に必ず読み戻して承認版と突合する（トライアル対応 NF-15）。不一致が 1 件でも
 *   あればファイルを渡さず、突合の記録（export_reconciliations）だけを残す。一致すれば件数を
 *   export_artifacts の突合の列に入れる。
 * - 出力は開示先への提出ではない。記録にも画面にも「提出済み」とは書かない。
 */

export interface ExportSnapshotRequest {
  snapshotId: Uuid;
  format: SnapshotExportFormat;
  audience: ExportAudience;
  /** DOCX の対象の基準（スナップショットに含まれる版）。省略時は先頭の基準 */
  frameworkVersionId?: Uuid | null;
}

export interface ExportSnapshotResult {
  artifact: ExportArtifact;
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
  snapshot: ReportSnapshotDetail;
}

export function parseExportFormat(value: string | null | undefined): SnapshotExportFormat | null {
  return RECONCILED_FORMATS.includes(value as SnapshotExportFormat)
    ? (value as SnapshotExportFormat)
    : null;
}

export function parseExportAudience(value: string | null | undefined): ExportAudience | null {
  return EXPORT_AUDIENCES.includes(value as ExportAudience) ? (value as ExportAudience) : null;
}

/** 組織の非公開の資料のファイル名（固定した一覧を持たない古いスナップショットの対外用の原稿で伏せる） */
async function nonPublicFileNames(db: DbClient, ctx: AuthorizationContext): Promise<string[]> {
  const files = await db.select('files', {
    where: { organizationId: ctx.workspace.organizationId },
  });
  return files.filter((f) => f.confidentiality !== 'public').map((f) => f.originalName);
}

function assertExportPermission(ctx: AuthorizationContext): void {
  assertEnterpriseWorkspace(ctx);
  // 権限は ID の検索より先に確かめる（権限の無い人に、ID の有無で応答を変えない）
  if (!can(ctx, 'enterprise.export.run')) {
    throw new AuthorizationError('出力には出力の権限（enterprise.export.run）が必要です。');
  }
}

/** 内容が書き換わっていないか（追記専用の前提が崩れていれば出力しない） */
function assertIntegrity(snapshot: ReportSnapshotDetail): void {
  if (!verifySnapshotIntegrity(snapshot)) {
    throw new Error(
      `スナップショット ${snapshot.id} の内容ハッシュが一致しません。出力を中止しました。`,
    );
  }
}

// ======================================================================
// 要求事項の判断（対応表に足す列・節の無い要求事項。NF-04・NF-13）
// ======================================================================

/**
 * 固定した後に要求事項の判断が変わったか（基準ごと）。v2 の写しは判断の記録を ID で、可変の評価行
 * （SSBJ の評価・CSRD の DMA と評価）を値のダイジェストで固定しているため、今の記録・値と比べる。
 * v1 の写し（固定していない）・プロジェクトの基準が無いものは null。
 * 今の状態は report-snapshot.ts の loadRequirementState で読む（固定と同じ読み方・同じダイジェスト）
 */
/** 今の要求事項の状態を読むときの固定時点（すべての記録を含める） */
const LATEST_STATE_AS_OF = '9999-12-31T23:59:59.999Z';

export async function requirementStateChanges(
  db: DbClient,
  ctx: AuthorizationContext,
  snapshot: ReportSnapshotDetail,
): Promise<Map<Uuid, boolean | null>> {
  const organizationId = ctx.workspace.organizationId;
  const out = new Map<Uuid, boolean | null>();
  const project = await db.findById('disclosureProjects', snapshot.projectId);
  if (!project || project.organizationId !== organizationId) {
    for (const f of snapshot.frameworkVersions) out.set(f.frameworkVersionId, null);
    return out;
  }
  const projectFrameworks = await db.select('projectFrameworks', {
    where: { organizationId, projectId: project.id },
  });
  for (const f of snapshot.frameworkVersions) {
    const state = f.requirementState;
    const pf = projectFrameworks.find((p) => p.frameworkVersionId === f.frameworkVersionId);
    if (!state || !pf) {
      out.set(f.frameworkVersionId, null);
      continue;
    }
    // 今の状態を固定と同じ関数で読む（すべての記録を含めるため、固定時点は遠い未来にする）
    const current = await loadRequirementState(
      db,
      organizationId,
      project,
      pf,
      f.frameworkKey,
      LATEST_STATE_AS_OF,
    );
    const frozenExclusions = new Set(state.exclusionEventIds);
    const frozenAssessments = new Set(state.assessmentEventIds);
    const changed =
      current.exclusionEventIds.some((id) => !frozenExclusions.has(id)) ||
      current.assessmentEventIds.some((id) => !frozenAssessments.has(id)) ||
      (state.assessmentDigest !== null &&
        current.assessmentDigest !== null &&
        current.assessmentDigest !== state.assessmentDigest);
    out.set(f.frameworkVersionId, changed);
  }
  return out;
}

/** 対応表に足す要求事項の判断（要求事項・情報対応表の行から。プロジェクトが無ければ null） */
async function requirementContext(
  db: DbClient,
  ctx: AuthorizationContext,
  snapshot: ReportSnapshotDetail,
): Promise<RequirementExportContext | null> {
  if (!can(ctx, 'enterprise.disclosure.read')) return null;
  try {
    const matrix = await loadRequirementMatrix(db, ctx, {
      projectId: snapshot.projectId,
      frameworkVersionIds: snapshot.frameworkVersions.map((f) => f.frameworkVersionId),
    });
    return {
      rows: matrix.rows.map((r) => ({
        frameworkVersionId: r.frameworkVersionId,
        itemId: r.itemId,
        code: r.code,
        section: r.section,
        text: r.title,
        decisionLabel: r.decisionLabel,
        decisionSourceLabel: r.decisionSourceLabel,
        exclusionReason: r.exclusionReason,
        decidedByName: r.decidedByName,
        approvedByName: r.approvedByName,
        approvedAt: r.approvedAt,
      })),
      changedSinceSnapshot: await requirementStateChanges(db, ctx, snapshot),
    };
  } catch (error) {
    // プロジェクトを削除した後の古いスナップショットは、節の要求事項の行だけで出す
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

/**
 * 出力の表示の材料（追跡・名前・定性情報の題名・根拠資料。対応表 XLSX は要求事項の判断も）。
 * 画面（トレース）と出力で同じ材料を使い、追跡番号・追跡率を食い違わせない
 */
export async function buildExportContext(
  db: DbClient,
  ctx: AuthorizationContext,
  snapshot: ReportSnapshotDetail,
  options: { requirements: boolean },
): Promise<ReportExportContext> {
  const base = await loadTraceContext(db, ctx, snapshot);
  return {
    ...base,
    requirements: options.requirements ? await requirementContext(db, ctx, snapshot) : null,
  };
}

// ======================================================================
// 出力（DOCX・XLSX・CSV）と突合
// ======================================================================

interface BuiltExport {
  bytes: Uint8Array;
  expectation: ReconciliationExpectation;
  framework: SnapshotFramework | null;
  maskedNames: readonly string[];
  maskedFileNameSource: 'snapshot' | 'live_files' | null;
}

function frameworkFor(
  snapshot: ReportSnapshotDetail,
  format: SnapshotExportFormat,
  frameworkVersionId: Uuid | null | undefined,
): SnapshotFramework | null {
  if (format !== 'docx') return null;
  return frameworkVersionId
    ? (snapshot.frameworkVersions.find((f) => f.frameworkVersionId === frameworkVersionId) ?? null)
    : (snapshot.frameworkVersions[0] ?? null);
}

/** ファイルを作り、同じ中身から突合の期待値を作る（描画と期待値を別に書かない） */
async function buildExport(
  db: DbClient,
  ctx: AuthorizationContext,
  snapshot: ReportSnapshotDetail,
  request: Pick<ExportSnapshotRequest, 'format' | 'audience' | 'frameworkVersionId'>,
  options: { buildBytes: boolean },
): Promise<BuiltExport> {
  if (request.format === 'xlsx' && request.audience !== 'internal') {
    throw new ValidationError('対応表（XLSX）は社内確認用だけです。対外用には出力できません。');
  }
  const framework = frameworkFor(snapshot, request.format, request.frameworkVersionId);
  if (request.format === 'docx') {
    if (!framework) {
      throw new ValidationError('指定した基準はこのスナップショットに含まれていません。');
    }
    const context = await buildExportContext(db, ctx, snapshot, { requirements: false });
    // 対外用は、本文に書かれた非公開資料の名前も伏せる（出典印の伏せ字と同じ扱い）。
    // 伏せる名前はスナップショットに固定した一覧を使う（後から資料を登録・区分変更しても、
    // 同じスナップショットの再出力の本文を変えない）。固定する前のスナップショットだけ、出力時の一覧から集める
    const frozen = frozenMaskedFileNames(snapshot);
    const maskedNames =
      request.audience === 'external' ? (frozen ?? (await nonPublicFileNames(db, ctx))) : [];
    const docxOptions = {
      audience: request.audience,
      frameworkVersionId: framework.frameworkVersionId,
      nonPublicFileNames: maskedNames,
    };
    return {
      bytes: options.buildBytes
        ? await buildDisclosureDocx(snapshot, docxOptions, context)
        : new Uint8Array(),
      expectation: { format: 'docx', docx: docxExpectation(snapshot, docxOptions, context) },
      framework,
      maskedNames,
      maskedFileNameSource:
        request.audience === 'external' ? (frozen === null ? 'live_files' : 'snapshot') : null,
    };
  }
  if (request.format === 'xlsx') {
    const context = await buildExportContext(db, ctx, snapshot, { requirements: true });
    return {
      bytes: options.buildBytes ? await buildMappingXlsx(snapshot, context) : new Uint8Array(),
      expectation: {
        format: 'xlsx',
        sheets: sheetExpectations(mappingWorkbookModel(snapshot, context)),
      },
      framework: null,
      maskedNames: [],
      maskedFileNameSource: null,
    };
  }
  return {
    bytes: options.buildBytes
      ? new TextEncoder().encode(buildMetricCsv(snapshot, request.audience))
      : new Uint8Array(),
    expectation: { format: 'csv', csv: metricCsvExpectation(snapshot, request.audience) },
    framework: null,
    maskedNames: [],
    maskedFileNameSource: null,
  };
}

export async function exportReportSnapshot(
  db: DbClient,
  ctx: AuthorizationContext,
  request: ExportSnapshotRequest,
): Promise<ExportSnapshotResult> {
  assertExportPermission(ctx);
  const snapshot = await loadOwnedSnapshot(db, ctx, request.snapshotId);
  assertIntegrity(snapshot);

  const built = await buildExport(db, ctx, snapshot, request, { buildBytes: true });
  const { bytes, framework, maskedNames } = built;
  const fileSha256 = sha256Hex(bytes);

  // 渡す前に読み戻して承認版と突合する（NF-15）。不一致ならファイルを渡さず、記録だけを残す
  const reconciliation = withApprovalCheck(
    await reconcileFile(bytes, built.expectation),
    approvalMismatches(snapshot, framework?.frameworkVersionId ?? null),
  );
  if (reconciliation.mismatchCount > 0) {
    const record = await recordReconciliation(db, ctx, {
      snapshot,
      source: 'generated_blocked',
      format: request.format,
      audience: request.audience,
      frameworkVersionId: framework?.frameworkVersionId ?? null,
      fileSha256,
      result: reconciliation,
    });
    throw new ExportReconciliationBlockedError(record);
  }

  const fileName = exportFileName(snapshot, request.format, request.audience, framework);
  const artifact: ExportArtifact = {
    id: randomUUID(),
    organizationId: ctx.workspace.organizationId,
    snapshotId: snapshot.id,
    format: request.format,
    audience: request.audience,
    templateVersion: DISCLOSURE_REPORT_TEMPLATE_VERSION,
    fileName,
    byteSize: bytes.byteLength,
    fileSha256,
    contentHash: snapshot.contentHash,
    generatedAt: new Date().toISOString(),
    // RLS は generated_by = auth.uid() を求める
    generatedBy: ctx.userId,
    // 突合（0051）の結果。挿入時に入れ、以後は変えない（追記専用）
    reconciledParagraphs: reconciliation.paragraphs,
    reconciledNumbers: reconciliation.numbers,
    reconciledRows: reconciliation.rows,
    mismatchCount: reconciliation.mismatchCount,
    checkerVersion: RECONCILIATION_CHECKER_VERSION,
    taxonomyPackageId: null,
    mappingSetHash: null,
    validationSummary: null,
  };
  await db.insert('exportArtifacts', [artifact]);

  await recordAuditEvent(db, ctx, {
    eventType: 'export_created',
    resourceType: 'report_snapshot',
    resourceId: snapshot.id,
    afterSummary: `${snapshot.label} No.${snapshot.snapshotNo} を ${request.format.toUpperCase()}（${request.audience === 'internal' ? '社内確認用' : '対外用'}）で出力`,
    metadata: {
      exportArtifactId: artifact.id,
      format: request.format,
      audience: request.audience,
      frameworkVersionId: framework?.frameworkVersionId ?? null,
      templateVersion: artifact.templateVersion,
      fileSha256: artifact.fileSha256,
      contentHash: artifact.contentHash,
      // 伏せた資料名の数と出所（固定した一覧か、出力時の一覧か）。同じスナップショットの出力の違いを説明する
      maskedFileNameCount: maskedNames.length,
      maskedFileNameSource: built.maskedFileNameSource,
      // 突合の結果（NF-15）
      checkerVersion: RECONCILIATION_CHECKER_VERSION,
      reconciledParagraphs: reconciliation.paragraphs,
      reconciledNumbers: reconciliation.numbers,
      reconciledRows: reconciliation.rows,
      mismatchCount: reconciliation.mismatchCount,
    },
  });

  return {
    artifact,
    bytes,
    contentType: EXPORT_CONTENT_TYPES[request.format],
    fileName,
    snapshot,
  };
}

// ======================================================================
// 外部で編集したファイルの照合（NF-15 の P1。ファイルは保存しない）
// ======================================================================

/** 照合できるファイルの大きさの上限（出力した原稿・対応表の数倍） */
export const UPLOADED_RECONCILIATION_MAX_BYTES = 10 * 1024 * 1024;

/** ファイル名と中身から形式を決める（DOCX・XLSX だけ。どちらも ZIP） */
export function uploadedFormatOf(
  fileName: string,
  bytes: Uint8Array,
): Extract<ReconciledFormat, 'docx' | 'xlsx'> | null {
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) return null;
  if (/\.docx$/i.test(fileName)) return 'docx';
  if (/\.xlsx$/i.test(fileName)) return 'xlsx';
  return null;
}

/**
 * 外部（Word・Excel）で編集したファイルを、スナップショットの承認版と照合する。
 * ファイルは保存せず、sha256 と照合の結果だけを記録する（source=uploaded）
 */
export async function reconcileUploadedFile(
  db: DbClient,
  ctx: AuthorizationContext,
  input: {
    snapshotId: Uuid;
    fileName: string;
    bytes: Uint8Array;
    audience: ExportAudience;
    frameworkVersionId?: Uuid | null;
  },
): Promise<ExportReconciliation> {
  assertExportPermission(ctx);
  if (input.bytes.byteLength === 0) {
    throw new ValidationError('照合するファイルを選んでください。');
  }
  if (input.bytes.byteLength > UPLOADED_RECONCILIATION_MAX_BYTES) {
    throw new ValidationError('照合できるファイルは 10 MB までです。');
  }
  const format = uploadedFormatOf(input.fileName, input.bytes);
  if (!format) {
    throw new ValidationError('照合できるのは Word（.docx）と Excel（.xlsx）のファイルだけです。');
  }
  const snapshot = await loadOwnedSnapshot(db, ctx, input.snapshotId);
  if (!verifySnapshotIntegrity(snapshot)) {
    throw new ValidationError(
      'スナップショットの内容ハッシュが一致しないため照合できません（内容が変わった可能性があります）。',
    );
  }
  const built = await buildExport(
    db,
    ctx,
    snapshot,
    { format, audience: input.audience, frameworkVersionId: input.frameworkVersionId },
    { buildBytes: false },
  );
  const result = withApprovalCheck(
    await reconcileFile(input.bytes, built.expectation),
    approvalMismatches(snapshot, built.framework?.frameworkVersionId ?? null),
  );
  return recordReconciliation(db, ctx, {
    snapshot,
    source: 'uploaded',
    format,
    audience: input.audience,
    frameworkVersionId: built.framework?.frameworkVersionId ?? null,
    fileSha256: sha256Hex(input.bytes),
    result,
  });
}

// ======================================================================
// 追跡表・突合結果の出力（社内確認用の XLSX。出力の記録には足さず監査ログだけ）
// ======================================================================

export interface AuxiliaryExportResult {
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
  snapshot: ReportSnapshotDetail;
}

/** 追跡表（トレース画面の「追跡表を出力」）。基準・選定ケースで絞れる */
export async function exportSnapshotTrace(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { snapshotId: Uuid; frameworkVersionId?: Uuid | null; codes?: readonly string[] | null },
): Promise<AuxiliaryExportResult> {
  assertExportPermission(ctx);
  const snapshot = await loadOwnedSnapshot(db, ctx, input.snapshotId);
  assertIntegrity(snapshot);
  const framework = input.frameworkVersionId
    ? (snapshot.frameworkVersions.find((f) => f.frameworkVersionId === input.frameworkVersionId) ??
      null)
    : null;
  if (input.frameworkVersionId && !framework) {
    throw new ValidationError('指定した基準はこのスナップショットに含まれていません。');
  }
  const context = await buildExportContext(db, ctx, snapshot, { requirements: false });
  const bytes = await buildTraceXlsx(snapshot, context, {
    frameworkVersionId: framework?.frameworkVersionId ?? null,
    selectedCodes: input.codes ?? null,
  });
  const fileName = auxiliaryFileName(snapshot, '追跡表');
  await recordAuditEvent(db, ctx, {
    eventType: 'export_created',
    resourceType: 'report_snapshot',
    resourceId: snapshot.id,
    afterSummary: `${snapshot.label} No.${snapshot.snapshotNo} の追跡表を XLSX（社内確認用）で出力`,
    metadata: {
      kind: 'trace_xlsx',
      frameworkVersionId: framework?.frameworkVersionId ?? null,
      selectedCodes: input.codes ?? null,
      templateVersion: DISCLOSURE_REPORT_TEMPLATE_VERSION,
      fileSha256: sha256Hex(bytes),
      contentHash: snapshot.contentHash,
    },
  });
  return { bytes, contentType: EXPORT_CONTENT_TYPES.xlsx, fileName, snapshot };
}

/** 突合結果（出力の記録の突合・止めた出力・外部ファイルの照合と明細） */
export async function exportSnapshotReconciliation(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { snapshotId: Uuid },
): Promise<AuxiliaryExportResult> {
  assertExportPermission(ctx);
  const snapshot = await loadOwnedSnapshot(db, ctx, input.snapshotId);
  const [artifacts, reconciliations] = await Promise.all([
    listExportArtifacts(db, ctx, [snapshot.id]),
    listReconciliations(db, ctx, [snapshot.id]),
  ]);
  const bytes = await buildReconciliationXlsx(snapshot, { artifacts, reconciliations });
  const fileName = auxiliaryFileName(snapshot, '突合結果');
  await recordAuditEvent(db, ctx, {
    eventType: 'export_created',
    resourceType: 'report_snapshot',
    resourceId: snapshot.id,
    afterSummary: `${snapshot.label} No.${snapshot.snapshotNo} の突合結果を XLSX（社内確認用）で出力`,
    metadata: {
      kind: 'reconciliation_xlsx',
      artifacts: artifacts.length,
      reconciliations: reconciliations.length,
      fileSha256: sha256Hex(bytes),
      contentHash: snapshot.contentHash,
    },
  });
  return { bytes, contentType: EXPORT_CONTENT_TYPES.xlsx, fileName, snapshot };
}

// ======================================================================
// 出力の記録・保証側への共有の先
// ======================================================================

export interface ExportArtifactView extends ExportArtifact {
  generatedByName: string;
}

/** スナップショットごとの出力記録（新しい順）。スナップショットが自組織のものであることを前提に呼ぶ */
export async function listExportArtifacts(
  db: DbClient,
  ctx: AuthorizationContext,
  snapshotIds: readonly Uuid[],
): Promise<ExportArtifactView[]> {
  assertEnterpriseWorkspace(ctx);
  if (snapshotIds.length === 0) return [];
  const rows = await db.select('exportArtifacts', {
    where: { organizationId: ctx.workspace.organizationId, snapshotId: { in: [...snapshotIds] } },
    orderBy: [
      { column: 'generatedAt', dir: 'desc' },
      { column: 'id', dir: 'desc' },
    ],
  });
  const userIds = [...new Set(rows.map((r) => r.generatedBy))];
  const profiles =
    userIds.length === 0 ? [] : await db.select('profiles', { where: { id: { in: userIds } } });
  return rows.map((row) => ({
    ...row,
    generatedByName: profiles.find((p) => p.id === row.generatedBy)?.displayName ?? '—',
  }));
}

export interface ShareTarget {
  engagementId: Uuid;
  code: string;
  name: string;
}

export interface SnapshotShareView {
  copyId: Uuid;
  snapshotId: Uuid;
  engagementId: Uuid;
  engagementCode: string;
  engagementName: string;
  sharedAt: string;
  sharedByName: string;
  withdrawnAt: string | null;
  /** 保証側がクライアントへ共有したコメント（この写しの段落・数値を指すもの）の件数と、未回答の件数 */
  noteCount: number;
  unansweredCount: number;
}

/**
 * スナップショットごとの保証側への共有（取り下げ済みも含む。新しい順）。閲覧は開示の閲覧か許諾の管理の権限
 * （listSharedReportsForClient と同じ）
 */
export async function listSnapshotShares(
  db: DbClient,
  ctx: AuthorizationContext,
  snapshotIds: readonly Uuid[],
): Promise<SnapshotShareView[]> {
  assertEnterpriseWorkspace(ctx);
  if (snapshotIds.length === 0) return [];
  const ids = new Set(snapshotIds);
  const entries = (await listSharedReportsForClient(db, ctx)).filter((e) =>
    ids.has(e.copy.snapshotId),
  );
  if (entries.length === 0) return [];
  const engagementIds = [...new Set(entries.map((e) => e.copy.engagementId))];
  const userIds = [...new Set(entries.map((e) => e.copy.sharedBy))];
  const [engagements, profiles, notes] = await Promise.all([
    db.select('engagements', {
      where: { id: { in: engagementIds }, clientOrganizationId: ctx.workspace.organizationId },
    }),
    db.select('profiles', { where: { id: { in: userIds } } }),
    // 保証側のコメントはクライアントへ共有したものだけ（開示の閲覧権限が要る）
    can(ctx, 'enterprise.disclosure.read') ? listNotesForClient(db, ctx) : Promise.resolve([]),
  ]);
  return entries.map(({ copy }) => {
    const engagement = engagements.find((e) => e.id === copy.engagementId);
    return {
      copyId: copy.id,
      snapshotId: copy.snapshotId,
      engagementId: copy.engagementId,
      engagementCode: engagement?.code ?? '（案件不明）',
      engagementName: engagement?.name ?? '',
      sharedAt: copy.sharedAt,
      sharedByName: profiles.find((p) => p.id === copy.sharedBy)?.displayName ?? '—',
      withdrawnAt: copy.withdrawnAt,
      noteCount: notes.filter((n) => n.note.targetCopyId === copy.id).length,
      unansweredCount: notes.filter(
        (n) => n.note.targetCopyId === copy.id && n.state === 'unanswered',
      ).length,
    };
  });
}

/**
 * 承認済みレポートを共有できる案件（自社がクライアントで、有効な許諾がある案件）。
 * 共有そのものの検査（承認済み・完全性・二重共有）は report-share.ts の shareReportSnapshot が行う
 */
export async function listShareTargets(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<ShareTarget[]> {
  assertEnterpriseWorkspace(ctx);
  if (!can(ctx, 'enterprise.grant.manage')) return [];
  const engagements = await db.select('engagements', {
    where: { clientOrganizationId: ctx.workspace.organizationId },
  });
  if (engagements.length === 0) return [];
  const grants = await db.select('grants', {
    where: { engagementId: { in: engagements.map((e) => e.id) }, revokedAt: { isNull: true } },
  });
  return engagements
    .filter((e) => grants.some((g) => g.engagementId === e.id))
    .map((e) => ({ engagementId: e.id, code: e.code, name: e.name }))
    .sort((a, b) => a.code.localeCompare(b.code, 'ja'));
}
