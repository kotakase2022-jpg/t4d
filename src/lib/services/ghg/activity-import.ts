import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import {
  suggestActivityMapping,
  validateActivityMapping,
  type ActivityMappingSelection,
} from '@/app/enterprise/ghg/calculation/activity/_lib/activity-mapping';
import { BATCH_KIND_LABELS } from '@/app/enterprise/ghg/calculation/activity/_lib/labels';
import { recordAuditEvent } from '@/lib/audit/logger';
import {
  AuthorizationError,
  assertCan,
  assertEnterpriseWorkspace,
  assertUnitInScope,
  can,
  isUnitInScope,
  NotFoundError,
} from '@/lib/authorization/can';
import { ACTIVITY_MAX_ROWS, extractActivityRows } from '@/lib/domain/ghg/activity-parse';
import { activityLabel, ACTIVITY_CODE_LABELS } from '@/lib/domain/ghg/calculate';
import type { DecimalSeparator } from '@/lib/domain/ghg/number-format';
import { latestPolicy, type GhgSourceRows } from '@/lib/domain/ghg/select-inputs';
import { ValidationError } from '@/lib/errors/user-facing';
import { parseUploadedFile } from '@/lib/imports/parsers';
import { DEMO_GHG_LIMITS } from '@/lib/repositories/demo-ghg-checks';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  GhgActivityBatch,
  GhgActivityKind,
  GhgActivityLine,
  GhgBatchKind,
  IsoDate,
  OrganizationUnit,
  ReportingPeriod,
  Uuid,
} from '@/types/domain';
import { loadGhgSource } from './inputs';
import { trialCalculate, trialWarningLabel, type TrialCounts } from './transport-preview';

/**
 * 活動量の取込（plan §2.3 activity-import.ts・CR-05・P94・P95）。
 *
 * 流れ: 種類（エネルギー／輸送実績）と拠点 → ファイル → 列の対応 → 検証（previewActivityImport。書き込み 0）
 * → 取込（createActivityBatch。確認中のバッチとして保存）→ 確定（confirmActivityImport）／破棄（discardActivityBatch）。
 *
 *  - 権限: 取込は enterprise.import.run ＋ enterprise.data.write、確定・破棄は enterprise.data.write。
 *    どちらも担当拠点だけ（RLS の t4d.unit_in_scope と同じ）。閲覧は enterprise.data.read
 *  - 検証の結果は Cookie にもサーバーにも残さない。取込の時はファイルを送り直し、サーバーが同じ規則で
 *    検証し直す（本番は要求ごとに別のインスタンスになりうるため）。検証したファイルと同じかは sha256 で確かめる
 *  - 読めない値は推測で埋めない。エラーの行が 1 つでもあれば取り込まない（直したファイルを送り直す）
 *  - 差し替えは新しいバッチ（supersedes_batch_id）。確定と同時に元の確定済みのバッチを差し替え済みにする
 *  - 締めた期間には取り込まない・確定しない
 * 監査ログは既存の種類（取込＝data_created、確定＝import_committed、破棄＝data_updated）。
 */

/** 取込のファイルの上限（バイト。活動量の表は大きくならない） */
export const ACTIVITY_FILE_MAX_BYTES = 5 * 1024 * 1024;

/** 画面に返す行の上限（検証の結果。件数は全行で数える） */
const PREVIEW_ROW_LIMIT = 200;

const TABLE_EXTENSIONS = ['.csv', '.tsv', '.txt', '.xlsx', '.xlsm'];

export interface ActivityImportFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

export interface ActivityImportRequest {
  periodId: Uuid;
  unitId: Uuid;
  kind: GhgBatchKind;
  /** 差し替える確定済みのバッチ（null は追加） */
  replaceBatchId: Uuid | null;
  file: ActivityImportFile;
  /** 列の対応（null は列名から提案する） */
  mapping: ActivityMappingSelection | null;
  decimalSeparator: DecimalSeparator | null;
}

export interface ActivityPreviewTransport {
  shipmentRef: string | null;
  carrierKind: string | null;
  fuelCode: string | null;
  tonKm: number | null;
  cargoWeightT: number | null;
  distanceKm: number | null;
  maxPayloadKg: number | null;
  loadFactorPct: number | null;
  fuelEconomyClass: string | null;
  vehicleUse: string | null;
}

export interface ActivityPreviewRow {
  rowNo: number;
  month: IsoDate | null;
  activity: string;
  amount: number | null;
  unit: string | null;
  transport: ActivityPreviewTransport | null;
  /** 試算（t-CO2e・未丸め。電力はロケーション基準。試算できなければ null） */
  trialT: number | null;
  loadFactorSource: 'measured' | 'default' | 'floored' | null;
  /** 検証の警告と試算の印（語） */
  warnings: string[];
  /** 取り込めない理由（null は取り込める） */
  error: string | null;
  /** 試算できない理由（係数の未割当など。取込はできる） */
  trialError: string | null;
}

export interface ActivityImportPreview {
  /** 取り込めるか（blockers が空） */
  canImport: boolean;
  /** 取り込めない理由（ファイル・列の対応・行のエラー・デモの上限） */
  blockers: string[];
  file: { name: string; sha256: string; sizeBytes: number };
  headers: string[];
  mapping: ActivityMappingSelection;
  /** 対応を列名から提案した（利用者が選んでいない） */
  mappingSuggested: boolean;
  mappingProblems: string[];
  decimalSeparator: DecimalSeparator | null;
  unit: { id: Uuid; code: string; name: string; countryCode: string; overseas: boolean };
  kind: GhgBatchKind;
  period: { id: Uuid; label: string };
  rowCount: number;
  validCount: number;
  errorCount: number;
  warningCount: number;
  /** 画面に出す行（先頭の PREVIEW_ROW_LIMIT 行。エラーの行を先に） */
  rows: ActivityPreviewRow[];
  /** ファイルの行の月 */
  months: IsoDate[];
  counts: TrialCounts;
  /** 積載率の下限（%。算定方針が無ければ null） */
  minLoadPct: number | null;
  policyMissing: boolean;
  /** 差し替える確定済みのバッチ（追加なら null） */
  replace: {
    batchId: Uuid;
    fileName: string;
    rowCount: number;
    /** このファイルに無い月（差し替えると算定に使われなくなる） */
    droppedMonths: IsoDate[];
    droppedLines: number;
  } | null;
  /** 追加のとき、確定済みの活動量と同じ月・活動（輸送は出荷番号）の行の数（両方が算定に入る） */
  overlaps: number;
}

// ----------------------------------------------------------------------
// 権限
// ----------------------------------------------------------------------

function assertCanImport(ctx: AuthorizationContext, unitId: Uuid): void {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.import.run');
  assertCan(ctx, 'enterprise.data.write');
  assertUnitInScope(ctx, unitId);
}

function assertCanWriteBatch(ctx: AuthorizationContext, batch: GhgActivityBatch): void {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.write');
  assertUnitInScope(ctx, batch.unitId);
}

/** 取込の操作を出さない理由（画面の disabledReason。権限が無ければ文、あれば null） */
export function activityImportPermissionReason(ctx: AuthorizationContext): string | null {
  try {
    assertEnterpriseWorkspace(ctx);
    assertCan(ctx, 'enterprise.import.run');
    assertCan(ctx, 'enterprise.data.write');
    return null;
  } catch (error) {
    return error instanceof AuthorizationError
      ? error.message
      : '活動量を取り込む権限がありません。';
  }
}

/** バッチの確定・破棄を押せない理由（権限・担当拠点・状態） */
export function activityBatchWriteReason(
  ctx: AuthorizationContext,
  batch: Pick<GhgActivityBatch, 'unitId' | 'status'>,
): string | null {
  if (ctx.workspace.organizationType !== 'enterprise' || !can(ctx, 'enterprise.data.write')) {
    return '確定・破棄にはデータ入力の権限が必要です。';
  }
  if (!isUnitInScope(ctx, batch.unitId)) return '担当外の拠点の活動量は確定・破棄できません。';
  if (batch.status !== 'draft') return '確認中のバッチだけを確定・破棄できます。';
  return null;
}

// ----------------------------------------------------------------------
// 検証（書き込み 0）
// ----------------------------------------------------------------------

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function baseName(name: string): string {
  return name
    .replace(/^.*[\\/]/, '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, 255);
}

function monthKey(date: string): IsoDate {
  return `${date.slice(0, 7)}-01`;
}

/** 期間の月（月初日の並び） */
export function periodMonths(period: Pick<ReportingPeriod, 'startDate' | 'endDate'>): IsoDate[] {
  const out: IsoDate[] = [];
  let [y, m] = period.startDate.split('-').map(Number) as [number, number];
  const [ey, em] = period.endDate.split('-').map(Number) as [number, number];
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    if (out.length > 240) break;
  }
  return out;
}

/** 同じ活動の行かどうかの鍵（重複・差し替えの確認。輸送は出荷番号があればそれで） */
function overlapKey(
  line: Pick<
    GhgActivityLine,
    'month' | 'activityKind' | 'activityCode' | 'contractCode' | 'shipmentRef' | 'fuelCode'
  >,
): string {
  if (line.activityKind === 'transport' && line.shipmentRef) return `ref|${line.shipmentRef}`;
  return [
    line.month,
    line.activityKind,
    line.activityCode,
    line.contractCode ?? '',
    line.fuelCode ?? '',
  ].join('|');
}

interface Analysis {
  preview: ActivityImportPreview;
  /** 取り込む行（保存の形。ID・バッチは作成時に付ける） */
  lines: Array<Omit<GhgActivityLine, 'id' | 'organizationId' | 'batchId' | 'createdAt'>>;
  unit: OrganizationUnit;
  period: ReportingPeriod;
}

async function userBatchCount(db: DbClient, organizationId: Uuid): Promise<number> {
  const batches = await db.select('ghgActivityBatches', { where: { organizationId } });
  return batches.filter((b) => b.source !== 'fixture').length;
}

function fileProblem(file: ActivityImportFile): string | null {
  const name = baseName(file.name);
  if (!name) return 'ファイルを選んでください。';
  const ext = name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
  if (!TABLE_EXTENSIONS.includes(ext)) {
    return `表のファイル（${TABLE_EXTENSIONS.join(' / ')}）を選んでください（${ext || '拡張子なし'} は読めません）。`;
  }
  if (file.bytes.byteLength === 0) return 'ファイルが空です。';
  if (file.bytes.byteLength > ACTIVITY_FILE_MAX_BYTES) {
    return `ファイルが大きすぎます（上限 ${ACTIVITY_FILE_MAX_BYTES / 1024 / 1024}MB）。`;
  }
  return null;
}

async function analyze(
  db: DbClient,
  ctx: AuthorizationContext,
  request: ActivityImportRequest,
): Promise<Analysis> {
  assertCanImport(ctx, request.unitId);
  const organizationId = ctx.workspace.organizationId;
  const source: GhgSourceRows = await loadGhgSource(db, ctx, request.periodId);
  const period = source.period;
  if (period.status === 'closed') {
    throw new ValidationError(`期間「${period.label}」は締めています。活動量は取り込めません。`);
  }
  const unit = source.units.find(
    (u) => u.id === request.unitId && u.organizationId === organizationId,
  );
  if (!unit) throw new NotFoundError('拠点が見つかりません。');
  const overseas = unit.countryCode !== source.organization.countryCode;
  const policy = latestPolicy(source.policies, period.id);

  const blockers: string[] = [];
  const problem = fileProblem(request.file);
  const fileInfo = {
    name: baseName(request.file.name),
    sha256: sha256(request.file.bytes),
    sizeBytes: request.file.bytes.byteLength,
  };

  // 差し替える確定済みのバッチ（同じ拠点・期間・種類だけ）
  const confirmedSame = source.batches.filter(
    (b) => b.unitId === unit.id && b.kind === request.kind && b.status === 'confirmed',
  );
  let replaceTarget: GhgActivityBatch | null = null;
  if (request.replaceBatchId) {
    replaceTarget = confirmedSame.find((b) => b.id === request.replaceBatchId) ?? null;
    if (!replaceTarget) {
      blockers.push(
        '差し替える確定済みのバッチが見つかりません（同じ拠点・種類の確定済みのバッチだけを差し替えられます）。',
      );
    }
  }

  const empty: ActivityImportPreview = {
    canImport: false,
    blockers,
    file: fileInfo,
    headers: [],
    mapping: {},
    mappingSuggested: false,
    mappingProblems: [],
    decimalSeparator: request.decimalSeparator,
    unit: {
      id: unit.id,
      code: unit.code,
      name: unit.name,
      countryCode: unit.countryCode,
      overseas,
    },
    kind: request.kind,
    period: { id: period.id, label: period.label },
    rowCount: 0,
    validCount: 0,
    errorCount: 0,
    warningCount: 0,
    rows: [],
    months: [],
    counts: {
      lines: 0,
      calculated: 0,
      errors: 0,
      defaultLoad: 0,
      floored: 0,
      payloadOutOfRange: 0,
      loadCapped: 0,
      overseas: 0,
    },
    minLoadPct: policy?.tonkm.minLoadPct ?? null,
    policyMissing: !policy,
    replace: null,
    overlaps: 0,
  };
  if (problem) {
    blockers.push(problem);
    return { preview: empty, lines: [], unit, period };
  }
  const parsed = await parseUploadedFile(fileInfo.name, request.file.type, request.file.bytes);
  if (parsed.kind !== 'table') {
    blockers.push(
      parsed.kind === 'unsupported'
        ? parsed.message
        : '表として読めませんでした。CSV か Excel の表を選んでください。',
    );
    return { preview: empty, lines: [], unit, period };
  }
  const table = parsed.table;
  const mappingSuggested = request.mapping === null;
  const selection = request.mapping ?? suggestActivityMapping(table.headers, request.kind);
  const validation = validateActivityMapping(selection, table.headers, request.kind);
  const base: ActivityImportPreview = {
    ...empty,
    headers: table.headers,
    mapping: selection,
    mappingSuggested,
    mappingProblems: validation.problems,
    rowCount: table.rows.length,
  };
  if (!validation.mapping) {
    blockers.push('列の対応を直してください。');
    return { preview: base, lines: [], unit, period };
  }

  const rowLimit = db.mode === 'demo' ? DEMO_GHG_LIMITS.linesPerBatch : ACTIVITY_MAX_ROWS;
  if (table.rows.length > rowLimit) {
    blockers.push(
      db.mode === 'demo'
        ? `デモでは 1 回の取込は ${rowLimit} 行までです（このファイルは ${table.rows.length} 行）。`
        : `行が多すぎます（上限 ${rowLimit} 行。このファイルは ${table.rows.length} 行）。`,
    );
  }
  if (table.rows.length === 0) blockers.push('取り込む行がありません。');

  const extracted = extractActivityRows(table, request.kind, {
    ...validation.mapping,
    decimalSeparator: request.decimalSeparator ?? undefined,
  });
  const months = new Set(periodMonths(period));
  const errorByRow = new Map<number, string>();
  for (const issue of extracted.errors) errorByRow.set(issue.rowNo, issue.message);
  const accepted = extracted.rows.filter((row) => {
    if (months.has(row.month)) return true;
    errorByRow.set(
      row.rowNo,
      `月 ${row.month.slice(0, 7)} は期間「${period.label}」（${period.startDate}〜${period.endDate}）の外です`,
    );
    return false;
  });
  const fileErrors = extracted.errors.filter((e) => e.rowNo === 0);
  for (const e of fileErrors) blockers.push(e.message);
  const rowErrors = [...errorByRow.entries()].filter(([rowNo]) => rowNo > 0);
  if (rowErrors.length > 0) {
    blockers.push(
      `読めない行が ${rowErrors.length} 行あります。ファイルを直してから検証し直してください（推測で埋めずに止めています）。`,
    );
  }
  const warningsByRow = new Map<number, string[]>();
  for (const w of extracted.warnings) {
    warningsByRow.set(w.rowNo, [...(warningsByRow.get(w.rowNo) ?? []), w.message]);
  }

  const lines: Analysis['lines'] = accepted.map((row, index) => ({
    lineNo: index + 1,
    month: row.month,
    activityKind: row.activityKind,
    activityCode: row.activityCode,
    amount: row.amount,
    unit: row.unit,
    contractCode: row.contractCode,
    shipmentRef: row.shipmentRef,
    cargoWeightT: row.cargoWeightT,
    distanceKm: row.distanceKm,
    tonKm: row.tonKm,
    fuelCode: row.fuelCode,
    maxPayloadKg: row.maxPayloadKg,
    loadFactorPct: row.loadFactorPct,
    vehicleUse: row.vehicleUse,
    fuelEconomyClass: row.fuelEconomyClass,
    carrierKind: row.carrierKind,
    cargoKind: row.cargoKind,
    attributes: { sourceRowNo: row.rowNo },
    note: row.note,
  }));

  // 試算（保存しない行で。算定のエンジンと同じ計算）
  const previewBatchId = `preview-${fileInfo.sha256.slice(0, 12)}`;
  const virtualLines: GhgActivityLine[] = lines.map((l, i) => ({
    ...l,
    id: `${previewBatchId}/${i + 1}`,
    organizationId,
    batchId: previewBatchId,
    createdAt: new Date(0).toISOString(),
  }));
  const trial = trialCalculate(
    source,
    { id: previewBatchId, unitId: unit.id, reportingPeriodId: period.id, kind: request.kind },
    virtualLines,
  );
  const trialById = new Map(trial.lines.map((t) => [t.activityLineId, t]));

  // 追加: 確定済みの行と同じ鍵の行。差し替え: このファイルに無い月の元の行
  const confirmedIds = new Set(confirmedSame.map((b) => b.id));
  const confirmedLines = source.lines.filter((l) => confirmedIds.has(l.batchId));
  let overlaps = 0;
  let replace: ActivityImportPreview['replace'] = null;
  const fileMonths = [...new Set(lines.map((l) => l.month))].sort();
  if (replaceTarget) {
    const targetLines = source.lines.filter((l) => l.batchId === replaceTarget!.id);
    const dropped = targetLines.filter((l) => !fileMonths.includes(l.month));
    replace = {
      batchId: replaceTarget.id,
      fileName: replaceTarget.fileName,
      rowCount: targetLines.length,
      droppedMonths: [...new Set(dropped.map((l) => l.month))].sort(),
      droppedLines: dropped.length,
    };
  } else {
    const existing = new Set(confirmedLines.map(overlapKey));
    overlaps = lines.filter((l) => existing.has(overlapKey(l))).length;
  }

  if (
    db.mode === 'demo' &&
    (await userBatchCount(db, organizationId)) >= DEMO_GHG_LIMITS.userBatches
  ) {
    blockers.push(
      `デモでは活動量の取込は ${DEMO_GHG_LIMITS.userBatches} 回までです（確認中・破棄したものを含む）。開示デモを初期状態に戻してから取り込んでください。`,
    );
  }

  const rows: ActivityPreviewRow[] = [];
  for (const [rowNo, message] of rowErrors) {
    rows.push({
      rowNo,
      month: null,
      activity: '—',
      amount: null,
      unit: null,
      transport: null,
      trialT: null,
      loadFactorSource: null,
      warnings: [],
      error: message,
      trialError: null,
    });
  }
  accepted.forEach((row, index) => {
    const t = trialById.get(virtualLines[index]!.id);
    const first = t?.results.find((r) => r.method !== 'electricity_market') ?? t?.results[0];
    const trialWarnings = [...new Set((t?.results ?? []).flatMap((r) => r.warnings))].map(
      trialWarningLabel,
    );
    rows.push({
      rowNo: row.rowNo,
      month: row.month,
      activity: activityLabelFor(row.activityKind, row.activityCode, row.fuelCode),
      amount: row.amount,
      unit: row.unit,
      transport:
        row.activityKind === 'transport'
          ? {
              shipmentRef: row.shipmentRef,
              carrierKind: row.carrierKind,
              fuelCode: row.fuelCode,
              tonKm: first?.transport?.tonKm ?? row.tonKm,
              cargoWeightT: row.cargoWeightT,
              distanceKm: row.distanceKm,
              maxPayloadKg: row.maxPayloadKg,
              loadFactorPct: row.loadFactorPct,
              fuelEconomyClass: row.fuelEconomyClass,
              vehicleUse: row.vehicleUse,
            }
          : null,
      trialT: first ? first.emissionsT : null,
      loadFactorSource: first?.transport?.loadFactorSource ?? null,
      warnings: [...(warningsByRow.get(row.rowNo) ?? []), ...trialWarnings],
      error: null,
      trialError: t?.error ?? null,
    });
  });
  rows.sort((a, b) => (a.error ? 0 : 1) - (b.error ? 0 : 1) || a.rowNo - b.rowNo);

  const preview: ActivityImportPreview = {
    ...base,
    canImport: blockers.length === 0,
    blockers,
    rowCount: table.rows.length,
    validCount: accepted.length,
    errorCount: rowErrors.length,
    warningCount: rows.filter((r) => r.warnings.length > 0).length,
    rows: rows.slice(0, PREVIEW_ROW_LIMIT),
    months: fileMonths,
    counts: trial.counts,
    replace,
    overlaps,
  };
  return { preview, lines, unit, period };
}

function activityLabelFor(kind: GhgActivityKind, code: string, fuelCode: string | null): string {
  if (kind !== 'transport') return activityLabel(kind, code);
  const carrier = ACTIVITY_CODE_LABELS[code] ?? code;
  const fuel = fuelCode ? (ACTIVITY_CODE_LABELS[fuelCode] ?? fuelCode) : null;
  return fuel ? `${carrier}（${fuel}）` : carrier;
}

/** 取込の検証（書き込み 0。監査ログも書かない） */
export async function previewActivityImport(
  db: DbClient,
  ctx: AuthorizationContext,
  request: ActivityImportRequest,
): Promise<ActivityImportPreview> {
  return (await analyze(db, ctx, request)).preview;
}

// ----------------------------------------------------------------------
// 取込（確認中のバッチとして保存）
// ----------------------------------------------------------------------

/** Supabase へ行をまとめて書く件数 */
const LINE_CHUNK = 500;

/**
 * 検証し直して、確認中のバッチと行を書く。検証したファイルと違う（sha256 が違う）・取り込めない理由が
 * 1 つでもあれば書かない
 */
export async function createActivityBatch(
  db: DbClient,
  ctx: AuthorizationContext,
  request: ActivityImportRequest & { expectedSha256: string },
): Promise<GhgActivityBatch> {
  const { preview, lines, unit, period } = await analyze(db, ctx, request);
  if (preview.file.sha256 !== request.expectedSha256) {
    throw new ValidationError(
      '検証したファイルと違うファイルが届きました。もう一度「検証する」を押してから取り込んでください。',
    );
  }
  if (!preview.canImport) {
    throw new ValidationError(
      preview.blockers[0] ?? '取り込めません。検証の結果を確かめてください。',
    );
  }
  const now = new Date().toISOString();
  const batch: GhgActivityBatch = {
    id: randomUUID(),
    organizationId: ctx.workspace.organizationId,
    reportingPeriodId: period.id,
    unitId: unit.id,
    kind: request.kind,
    source: 'upload',
    fileName: preview.file.name,
    fileSha256: preview.file.sha256,
    rowCount: lines.length,
    status: 'draft',
    confirmedBy: null,
    confirmedAt: null,
    supersedesBatchId: preview.replace?.batchId ?? null,
    createdAt: now,
    createdBy: ctx.userId,
    updatedAt: now,
  };
  await db.insert('ghgActivityBatches', [batch]);
  const rows: GhgActivityLine[] = lines.map((line) => ({
    ...line,
    id: randomUUID(),
    organizationId: batch.organizationId,
    batchId: batch.id,
    createdAt: now,
  }));
  for (let i = 0; i < rows.length; i += LINE_CHUNK) {
    await db.insert('ghgActivityLines', rows.slice(i, i + LINE_CHUNK));
  }
  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'ghg_activity_batch',
    resourceId: batch.id,
    afterSummary: `活動量を取り込みました（${unit.name}・${BATCH_KIND_LABELS[batch.kind]}・${rows.length} 行・確認中）`,
    metadata: {
      periodId: period.id,
      unitId: unit.id,
      kind: batch.kind,
      fileSha256: batch.fileSha256,
      rowCount: rows.length,
      supersedesBatchId: batch.supersedesBatchId,
    },
  });
  return batch;
}

// ----------------------------------------------------------------------
// 確定・破棄
// ----------------------------------------------------------------------

async function loadOwnBatch(
  db: DbClient,
  ctx: AuthorizationContext,
  batchId: Uuid,
): Promise<GhgActivityBatch> {
  assertEnterpriseWorkspace(ctx);
  const batch = await db.findById('ghgActivityBatches', batchId);
  if (!batch || batch.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('活動量の取込が見つかりません。');
  }
  return batch;
}

async function assertPeriodOpen(db: DbClient, batch: GhgActivityBatch): Promise<void> {
  const period = await db.findById('periods', batch.reportingPeriodId);
  if (period?.status === 'closed') {
    throw new ValidationError(
      `期間「${period.label}」は締めています。活動量は確定・破棄できません。`,
    );
  }
}

/**
 * 取込の確定（確認中 → 確定）。差し替えなら元の確定済みのバッチを差し替え済みにする。
 * 行の数がバッチの記録と違う（デモで行の一部が失われた等）なら確定しない
 */
export async function confirmActivityImport(
  db: DbClient,
  ctx: AuthorizationContext,
  batchId: Uuid,
): Promise<{ batch: GhgActivityBatch; superseded: GhgActivityBatch | null }> {
  const batch = await loadOwnBatch(db, ctx, batchId);
  assertCanWriteBatch(ctx, batch);
  if (batch.status !== 'draft') {
    throw new ValidationError('確認中のバッチだけを確定できます。');
  }
  await assertPeriodOpen(db, batch);
  const lineCount = await db.count('ghgActivityLines', {
    where: { organizationId: batch.organizationId, batchId: batch.id },
  });
  if (lineCount !== batch.rowCount) {
    throw new ValidationError(
      `行の数が取込の記録と合いません（記録 ${batch.rowCount} 行・見つかった行 ${lineCount} 行）。破棄して取り込み直してください。`,
    );
  }
  let target: GhgActivityBatch | null = null;
  if (batch.supersedesBatchId) {
    target = await db.findById('ghgActivityBatches', batch.supersedesBatchId);
    if (
      !target ||
      target.organizationId !== batch.organizationId ||
      target.status !== 'confirmed'
    ) {
      throw new ValidationError(
        '差し替える確定済みのバッチは、既に差し替え済みか見つかりません。破棄して取り込み直してください。',
      );
    }
  }
  const now = new Date().toISOString();
  const confirmed = await db.update('ghgActivityBatches', batch.id, {
    status: 'confirmed',
    confirmedBy: ctx.userId,
    confirmedAt: now,
    updatedAt: now,
  });
  let superseded: GhgActivityBatch | null = null;
  if (target) {
    // Supabase では確定のトリガが差し替え済みにする。Demo Mode（トリガが無い）ではここで同じ遷移をする
    const current = await db.findById('ghgActivityBatches', target.id);
    superseded =
      current && current.status === 'confirmed'
        ? await db.update('ghgActivityBatches', target.id, {
            status: 'superseded',
            updatedAt: now,
          })
        : current;
  }
  const unit = await db.findById('units', batch.unitId);
  await recordAuditEvent(db, ctx, {
    eventType: 'import_committed',
    resourceType: 'ghg_activity_batch',
    resourceId: batch.id,
    beforeSummary: '確認中',
    afterSummary: `活動量を確定しました（${unit?.name ?? '拠点'}・${BATCH_KIND_LABELS[batch.kind]}・${batch.rowCount} 行${target ? `・差し替え: ${target.fileName}` : ''}）`,
    metadata: {
      kind: batch.kind,
      rowCount: batch.rowCount,
      fileSha256: batch.fileSha256,
      supersededBatchId: target?.id ?? null,
    },
  });
  return { batch: confirmed, superseded };
}

/** 確認中のバッチの破棄（行は消さずに残し、算定に使わない） */
export async function discardActivityBatch(
  db: DbClient,
  ctx: AuthorizationContext,
  batchId: Uuid,
): Promise<GhgActivityBatch> {
  const batch = await loadOwnBatch(db, ctx, batchId);
  assertCanWriteBatch(ctx, batch);
  if (batch.status !== 'draft') {
    throw new ValidationError(
      '確認中のバッチだけを破棄できます（確定したバッチは差し替えで直します）。',
    );
  }
  await assertPeriodOpen(db, batch);
  const now = new Date().toISOString();
  const discarded = await db.update('ghgActivityBatches', batch.id, {
    status: 'discarded',
    updatedAt: now,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'ghg_activity_batch',
    resourceId: batch.id,
    beforeSummary: '確認中',
    afterSummary: `活動量の取込を破棄しました（${batch.fileName}・${batch.rowCount} 行）`,
    metadata: { kind: batch.kind, rowCount: batch.rowCount },
  });
  return discarded;
}

// ----------------------------------------------------------------------
// 読む（P94・P95）
// ----------------------------------------------------------------------

export interface CoverageKind {
  kind: GhgActivityKind;
  /** 確定済みの行がある月の数 */
  monthsCovered: number;
  missingMonths: IsoDate[];
  confirmedLines: number;
  draftLines: number;
}

export interface CoverageSite {
  unit: OrganizationUnit;
  overseas: boolean;
  /** トライアルの算定の検証拠点か */
  verification: boolean;
  kinds: CoverageKind[];
}

export interface CoverageBatch {
  batch: GhgActivityBatch;
  unitName: string;
  unitCode: string;
  createdByName: string | null;
  confirmedByName: string | null;
  /** 差し替えたバッチ（このバッチが差し替え済みなら、差し替えた側） */
  supersededByFileName: string | null;
}

export interface ActivityCoverage {
  period: ReportingPeriod;
  months: IsoDate[];
  organizationCountryCode: string;
  minLoadPct: number | null;
  sites: CoverageSite[];
  batches: CoverageBatch[];
  counts: {
    confirmedBatches: number;
    draftBatches: number;
    /** 検証拠点 × 活動の、確定済みの行が無い月の数 */
    missingMonths: number;
    /** 確定済みの輸送の行のうち、積載率が無く見なし積載率の原単位表で算定する行 */
    defaultLoadLines: number;
    /** 確定済みの輸送の行のうち、積載率が下限未満の行（算定方針が無ければ null） */
    flooredLoadLines: number | null;
    /** 海外拠点の輸送の行（確定済み・確認中） */
    overseasTransportLines: number;
  };
}

const KIND_ORDER: readonly GhgActivityKind[] = ['electricity', 'fuel', 'gas', 'heat', 'transport'];

function hasTonKm(line: GhgActivityLine): boolean {
  return line.tonKm !== null || (line.cargoWeightT !== null && line.distanceKm !== null);
}

async function namesOf(db: DbClient, ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return new Map();
  const profiles = await db.select('profiles', { where: { id: { in: unique } } });
  return new Map(profiles.map((p) => [p.id, p.displayName]));
}

/**
 * 拠点 × 活動 × 月の充足と取込の一覧（P94）。読むだけ。拠点は検証拠点（無ければ活動量のある拠点）
 */
export async function loadActivityCoverage(
  db: DbClient,
  ctx: AuthorizationContext,
  options: { periodId: Uuid; unitIds: readonly Uuid[] },
): Promise<ActivityCoverage> {
  const source = await loadGhgSource(db, ctx, options.periodId);
  const organizationId = ctx.workspace.organizationId;
  const months = periodMonths(source.period);
  const policy = latestPolicy(source.policies, source.period.id);
  const unitById = new Map(source.units.map((u) => [u.id, u]));
  const batches = [...source.batches].sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
  );
  const batchById = new Map(batches.map((b) => [b.id, b]));
  const verification = new Set(options.unitIds.filter((id) => unitById.has(id)));
  const siteIds = [
    ...verification,
    ...[...new Set(batches.map((b) => b.unitId))].filter((id) => !verification.has(id)),
  ];

  let missing = 0;
  let defaultLoad = 0;
  let floored = 0;
  let overseasTransport = 0;
  const sites: CoverageSite[] = [];
  for (const unitId of siteIds) {
    const unit = unitById.get(unitId);
    if (!unit || unit.organizationId !== organizationId) continue;
    const overseas = unit.countryCode !== source.organization.countryCode;
    const lines = source.lines.filter((l) => batchById.get(l.batchId)?.unitId === unitId);
    const confirmed = lines.filter((l) => batchById.get(l.batchId)?.status === 'confirmed');
    const drafts = lines.filter((l) => batchById.get(l.batchId)?.status === 'draft');
    const kinds: CoverageKind[] = KIND_ORDER.filter((kind) =>
      [...confirmed, ...drafts].some((l) => l.activityKind === kind),
    ).map((kind) => {
      const covered = new Set(
        confirmed.filter((l) => l.activityKind === kind).map((l) => monthKey(l.month)),
      );
      const missingMonths = months.filter((m) => !covered.has(m));
      return {
        kind,
        monthsCovered: months.length - missingMonths.length,
        missingMonths,
        confirmedLines: confirmed.filter((l) => l.activityKind === kind).length,
        draftLines: drafts.filter((l) => l.activityKind === kind).length,
      };
    });
    if (verification.has(unitId)) {
      // 活動量が 1 行も無い検証拠点は、期間の全月を未受領として数える（0 件を「足りている」と読ませない）
      missing +=
        kinds.length === 0
          ? months.length
          : kinds.reduce((sum, k) => sum + k.missingMonths.length, 0);
    }
    for (const line of confirmed) {
      if (line.activityKind !== 'transport' || !hasTonKm(line)) continue;
      if (line.loadFactorPct === null) defaultLoad += 1;
      else if (policy && line.loadFactorPct < policy.tonkm.minLoadPct) floored += 1;
    }
    if (overseas) {
      overseasTransport += [...confirmed, ...drafts].filter(
        (l) => l.activityKind === 'transport',
      ).length;
    }
    sites.push({ unit, overseas, verification: verification.has(unitId), kinds });
  }

  const names = await namesOf(
    db,
    batches.flatMap((b) => [b.createdBy, b.confirmedBy]),
  );
  return {
    period: source.period,
    months,
    organizationCountryCode: source.organization.countryCode,
    minLoadPct: policy?.tonkm.minLoadPct ?? null,
    sites,
    batches: batches.map((batch) => {
      const unit = unitById.get(batch.unitId);
      const successor = batches.find(
        (b) => b.supersedesBatchId === batch.id && b.status === 'confirmed',
      );
      return {
        batch,
        unitName: unit?.name ?? '（削除された拠点）',
        unitCode: unit?.code ?? '',
        createdByName: batch.createdBy ? (names.get(batch.createdBy) ?? null) : null,
        confirmedByName: batch.confirmedBy ? (names.get(batch.confirmedBy) ?? null) : null,
        supersededByFileName: batch.status === 'superseded' ? (successor?.fileName ?? null) : null,
      };
    }),
    counts: {
      confirmedBatches: batches.filter((b) => b.status === 'confirmed').length,
      draftBatches: batches.filter((b) => b.status === 'draft').length,
      missingMonths: missing,
      defaultLoadLines: defaultLoad,
      flooredLoadLines: policy ? floored : null,
      overseasTransportLines: overseasTransport,
    },
  };
}

export interface ActivityBatchDetail {
  batch: GhgActivityBatch;
  unit: OrganizationUnit;
  period: ReportingPeriod;
  overseas: boolean;
  lines: GhgActivityLine[];
  createdByName: string | null;
  confirmedByName: string | null;
  /** このバッチが差し替える（差し替えた）確定済みのバッチ */
  supersedes: Pick<GhgActivityBatch, 'id' | 'fileName' | 'rowCount' | 'status'> | null;
  /** このバッチを差し替えたバッチ（差し替え済みのとき） */
  supersededBy: Pick<GhgActivityBatch, 'id' | 'fileName' | 'status'> | null;
  /** 同じ拠点・種類の確定済みの行のうち、このバッチの行と同じ月・活動（輸送は出荷番号）の行 */
  overlaps: number;
}

/** バッチの詳細（P95）。閲覧の権限だけで見られる */
export async function loadActivityBatch(
  db: DbClient,
  ctx: AuthorizationContext,
  batchId: Uuid,
): Promise<ActivityBatchDetail> {
  const batch = await loadOwnBatch(db, ctx, batchId);
  const source = await loadGhgSource(db, ctx, batch.reportingPeriodId);
  const unit = source.units.find((u) => u.id === batch.unitId);
  if (!unit) throw new NotFoundError('拠点が見つかりません。');
  const lines = source.lines
    .filter((l) => l.batchId === batch.id)
    .sort((a, b) => a.lineNo - b.lineNo);
  const supersedes = batch.supersedesBatchId
    ? (source.batches.find((b) => b.id === batch.supersedesBatchId) ?? null)
    : null;
  const supersededBy =
    source.batches.find((b) => b.supersedesBatchId === batch.id && b.status === 'confirmed') ??
    null;
  let overlaps = 0;
  if (batch.status === 'draft' && !batch.supersedesBatchId) {
    const confirmedIds = new Set(
      source.batches
        .filter(
          (b) => b.unitId === batch.unitId && b.kind === batch.kind && b.status === 'confirmed',
        )
        .map((b) => b.id),
    );
    const existing = new Set(
      source.lines.filter((l) => confirmedIds.has(l.batchId)).map(overlapKey),
    );
    overlaps = lines.filter((l) => existing.has(overlapKey(l))).length;
  }
  const names = await namesOf(db, [batch.createdBy, batch.confirmedBy]);
  return {
    batch,
    unit,
    period: source.period,
    overseas: unit.countryCode !== source.organization.countryCode,
    lines,
    createdByName: batch.createdBy ? (names.get(batch.createdBy) ?? null) : null,
    confirmedByName: batch.confirmedBy ? (names.get(batch.confirmedBy) ?? null) : null,
    supersedes: supersedes
      ? {
          id: supersedes.id,
          fileName: supersedes.fileName,
          rowCount: supersedes.rowCount,
          status: supersedes.status,
        }
      : null,
    supersededBy: supersededBy
      ? { id: supersededBy.id, fileName: supersededBy.fileName, status: supersededBy.status }
      : null,
    overlaps,
  };
}
