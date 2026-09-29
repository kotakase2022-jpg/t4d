import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import {
  assertCan,
  assertEnterpriseWorkspace,
  assertUnitInScope,
  AuthorizationError,
  can,
  isUnitInScope,
  NotFoundError,
} from '@/lib/authorization/can';
import {
  AVAILABILITY_STATUS_LABELS,
  QUANTITATIVE_IMPORT_DIFF_KIND_LABELS,
  QUANTITATIVE_IMPORT_STATUS_LABELS,
  VALUE_KIND_LABELS,
} from '@/lib/domain/disclosure-status';
import { ValidationError } from '@/lib/errors/user-facing';
import { contentHash, fid } from '@/lib/fixtures/ids';
import { formatJst } from '@/lib/format/datetime';
import {
  interpretStandardRow,
  normalizeUnitForCompare,
  parseStandardCsvBytes,
  parseStandardCsvText,
  STANDARD_FIELD_LABELS,
  type InterpretedStandardRow,
  type NumberNotation,
  type StandardCsvFormat,
  type StandardCsvParseResult,
  type StandardField,
} from '@/lib/imports/standard-csv';
import { recomputePeriodValidations } from '@/lib/services/validation-store';
import { sha256Hex } from '@/lib/storage';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  AvailabilityStatus,
  DataPoint,
  DataPointStatus,
  DataPointVersion,
  IsoDateTime,
  MetricDefinition,
  OrganizationUnit,
  QuantitativeImportBatch,
  QuantitativeImportBatchRow,
  QuantitativeImportDiffKind,
  QuantitativeImportStatus,
  ReportingPeriod,
  Uuid,
  ValueKind,
} from '@/types/domain';

/**
 * 数値を登録（標準 CSV・貼り付け・手入力）: 検証 → 差分確認 → 確定（§6.4 / §7.1 / §7.4 / §12.2）。
 *
 * 既存の取込（imports/service.ts の confirmIngestionJob）との違い
 *  - 画面から送られた値を信用しない。確定はサーバーに保存した検証結果（取込バッチ）だけを読む。
 *  - 既定はエラーが 1 行でもあれば確定しない。「正常行のみ登録」は明示したときだけ行い、除外行を残す。
 *  - 重複はファイル名ではなく業務キー（組織・指標・拠点・期間・集計範囲）で判定する。
 *    同じ内容を別名で再投入しても、値が同じ行は「変更なし」になり版を作らない（A03）。
 *  - 値が変わる行は変更理由を必須にして新しい版を追記する。古い版は残る（A04）。
 *  - 検証の後に既存値が変わっていたら、確定を止めて競合として返す（A05）。
 *  - 同じ確定キーで再送されたら、書き込まずに最初の結果を返す（再試行で二重登録しない）。
 *
 * 取込で承認はしない。承認済みの値を更新すると下書きへ戻し「承認後に変更」を付ける
 * （updateDataPointValue と同じ規則）。
 *
 * DbClient にはトランザクションが無い。そこで「書く前にすべて確かめる → まとめて書く」の順にし、
 * 途中で書き込みに失敗したら、書き終えた行をバッチに記録して利用者へ示す。
 * 同じ確定をもう一度押すと、書き終えた行は重ねて書かずに続きから再開する
 * （docs/known-limitations.md に記載）。
 */

// ======================================================================
// 型
// ======================================================================

export type QuantitativeImportSourceKind = 'file' | 'text' | 'manual';

/** 手入力の 1 行（CSV の 1 行と同じ検証を通す） */
export interface ManualQuantitativeEntry {
  metricCode: string;
  entityCode: string;
  reportingPeriodId: Uuid;
  boundaryCode?: string | null;
  value: string;
  unit: string;
  valueKind?: string | null;
  availabilityStatus?: string | null;
  absenceReason?: string | null;
  methodologyCode?: string | null;
  sourceReference?: string | null;
}

export type QuantitativeImportSource =
  | { kind: 'file'; fileName: string; bytes: Uint8Array }
  | { kind: 'text'; fileName?: string; text: string }
  | { kind: 'manual'; entry: ManualQuantitativeEntry };

export interface ValidateQuantitativeImportInput {
  /** 画面で選んでいる報告期間（行ごとの期間はファイルの期間列で決める） */
  reportingPeriodId: Uuid;
  projectId?: Uuid | null;
  source: QuantitativeImportSource;
  numberNotation?: NumberNotation;
}

/** 検証時点の既存値（確定時にずれていれば競合として止める） */
export interface PreviousValueState {
  versionId: Uuid | null;
  versionNo: number | null;
  value: number | null;
  unitOfMeasure: string;
  valueKind: ValueKind;
  availabilityStatus: AvailabilityStatus;
  absenceReason: string | null;
  status: DataPointStatus;
  methodology: string | null;
}

/**
 * バッチに保存する行（quantitative_import_batches.rows の要素）。
 * 基本の列（QuantitativeImportBatchRow）に、確定と画面表示に必要な情報を足している。
 */
export interface StandardImportRow extends QuantitativeImportBatchRow {
  sourceKind: QuantitativeImportSourceKind;
  reportingPeriodId: Uuid | null;
  periodStart: string | null;
  periodEnd: string | null;
  metricCode: string | null;
  entityCode: string | null;
  /** 値のセルの原文 */
  valueRaw: string;
  /** 変換後の表記（全角・桁区切りを外した数字）。読み取れなければ null */
  valueNormalized: string | null;
  unitRaw: string;
  methodology: string | null;
  /** CSV の出所列（原文のまま。数式に見えても計算しない） */
  sourceReference: string | null;
  businessKey: string | null;
  previous: PreviousValueState | null;
  /** 確定で書き込んだ Data Point と版（途中失敗からの再開にも使う） */
  writtenDataPointId: Uuid | null;
  writtenVersionId: Uuid | null;
}

export interface QuantitativeImportPreviewRow {
  rowNo: number;
  diffKind: QuantitativeImportDiffKind;
  diffLabel: string;
  included: boolean;
  raw: Record<string, string>;
  valueRaw: string;
  /** 変換後の値（単位なし）。値が無い行は値の有無のラベル */
  valueDisplay: string;
  unitOfMeasure: string | null;
  metricCode: string | null;
  metricName: string | null;
  entityCode: string | null;
  unitName: string | null;
  periodLabel: string | null;
  periodRange: string | null;
  boundary: string | null;
  valueKind: ValueKind;
  valueKindLabel: string;
  availabilityStatus: AvailabilityStatus;
  availabilityLabel: string;
  absenceReason: string | null;
  methodology: string | null;
  sourceReference: string | null;
  previous: {
    valueDisplay: string;
    unitOfMeasure: string;
    versionNo: number | null;
    status: DataPointStatus;
    valueKindLabel: string;
    availabilityStatus: AvailabilityStatus;
    availabilityLabel: string;
  } | null;
  /** 既存値との差（同じ単位の数値どうしのときだけ） */
  delta: string | null;
  errors: string[];
  warnings: string[];
}

export interface QuantitativeImportPreview {
  batchId: Uuid;
  fileName: string;
  fileSha256: string;
  previewHash: string;
  status: QuantitativeImportStatus;
  statusLabel: string;
  sourceKind: QuantitativeImportSourceKind;
  reportingPeriodId: Uuid;
  reportingPeriodLabel: string;
  format: StandardCsvFormat;
  formatLabel: string;
  encoding: string;
  delimiterLabel: string;
  mapping: Array<{
    header: string;
    field: StandardField | null;
    fieldLabel: string | null;
    candidate: boolean;
  }>;
  fileWarnings: string[];
  counts: Record<QuantitativeImportDiffKind, number>;
  rows: QuantitativeImportPreviewRow[];
  createdAt: IsoDateTime;
}

export type QuantitativeImportCommitMode = 'all' | 'valid_only';

export interface CommitQuantitativeImportInput {
  batchId: Uuid;
  /** 利用者が確認した差分（プレビューのハッシュ）。サーバーの検証結果と一致しなければ確定しない */
  previewHash: string;
  idempotencyKey: string;
  mode: QuantitativeImportCommitMode;
  /** 既存値を変える行があるときは必須（新しい版の変更理由になる） */
  correctionReason?: string | null;
  /**
   * 検証した元の入力（CSV・貼り付け・手入力）。画面が検証のときと同じものを送り直す。
   *
   * Demo Mode（Vercel）では検証結果（取込バッチ）がインスタンスのメモリにしか無く、確定のリクエストが
   * 別のインスタンスへ届くと見つからない（2026-09-30 本番で「有効期限切れ」になった）。バッチが無いときは
   * ここからサーバーが検証し直し、そのハッシュが利用者の確認したもの（previewHash）と一致するときだけ
   * 確定する。画面から届く解析済みの値は使わない（送られるのは元の入力だけで、解析・照合はサーバーが行う）
   */
  source?: ValidateQuantitativeImportInput;
  /**
   * 利用者が確認した差分の行（行番号・差分区分・既存値の版番号・状態・表示）。検証し直した結果が確認した
   * ものと違うときに、どの行が変わったかを示すためだけに使う（書き込みには使わない）
   */
  confirmedRows?: QuantitativeImportConfirmedRow[];
}

/** 画面が確認した差分の行（競合の説明にだけ使う。信用しない値なので書き込みには使わない） */
export interface QuantitativeImportConfirmedRow {
  rowNo: number;
  diffKind: QuantitativeImportDiffKind;
  previousVersionNo: number | null;
  previousStatus: DataPointStatus | null;
  previousDisplay: string;
}

export interface QuantitativeImportCommitResult {
  batchId: Uuid;
  fileName: string;
  /** 同じ確定キーの再送で、書き込まずに最初の結果を返した */
  replayed: boolean;
  created: number;
  updated: number;
  unchanged: number;
  excluded: number;
  excludedRows: Array<{ rowNo: number; reasons: string[] }>;
  writtenRows: Array<{
    rowNo: number;
    diffKind: 'new' | 'changed';
    dataPointId: Uuid;
    versionId: Uuid;
  }>;
  committedAt: IsoDateTime;
}

export interface QuantitativeImportConflict {
  rowNo: number;
  label: string;
  reason: string;
  previewDisplay: string;
  currentDisplay: string;
}

export const QUANTITATIVE_IMPORT_EXPIRED_MESSAGE =
  '検証結果の有効期限が切れました。もう一度検証してください。';

/**
 * 検証結果（取込バッチ）が見つからず、検証し直す元の入力も届いていない
 * （デモではバッチがサーバーのメモリにしか無い。画面は確定のときに元の入力を送り直す）
 */
export class QuantitativeImportExpiredError extends NotFoundError {
  constructor() {
    super(QUANTITATIVE_IMPORT_EXPIRED_MESSAGE);
    this.name = 'QuantitativeImportExpiredError';
  }
}

/** 検証の後に既存値が変わった（A05）。確定を止め、行ごとの最新値を返す */
export class QuantitativeImportConflictError extends ValidationError {
  constructor(readonly conflicts: QuantitativeImportConflict[]) {
    super(
      `検証の後に既存の値が変わった行が ${conflicts.length} 行あるため、確定を止めました。最新の値で検証し直してください。`,
    );
    this.name = 'QuantitativeImportConflictError';
  }
}

/** 書き込みの途中で失敗した。書き終えた行を示す（DbClient にトランザクションが無いため） */
export class QuantitativeImportPartialError extends ValidationError {
  constructor(
    readonly writtenRowNos: number[],
    readonly failedRowNo: number,
  ) {
    super(
      `${failedRowNo} 行目の保存に失敗しました（保存失敗）。` +
        (writtenRowNos.length > 0
          ? `書き込み済みの行: ${writtenRowNos.join('・')} 行目（新しい版として保存済み）。`
          : '書き込み済みの行はありません。') +
        'もう一度「登録を確定」を押すと、書き込み済みの行は重ねて登録せずに続きから再開します。',
    );
    this.name = 'QuantitativeImportPartialError';
  }
}

// ======================================================================
// 表示用の小道具
// ======================================================================

const DATA_POINT_STATUS_LABELS: Record<DataPointStatus, string> = {
  not_started: '未着手',
  draft: '入力中',
  submitted: '提出済み',
  in_review: 'レビュー中',
  returned: '差戻し',
  approved: '承認済み',
};

const FORMAT_LABELS: Record<StandardCsvFormat, string> = {
  standard: '標準列',
  legacy_template: '既存テンプレート（拠点・項目・値・単位・期間）を標準列の候補に対応付け',
  mapped_candidates: '一部の見出しを標準列の候補に対応付け',
};

const DELIMITER_LABELS: Record<string, string> = {
  ',': 'カンマ区切り',
  ';': 'セミコロン区切り',
  '\t': 'タブ区切り',
};

const exactNumberFormatter = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 10 });

function formatExact(value: number): string {
  return exactNumberFormatter.format(value);
}

function displayState(state: {
  value: number | null;
  unitOfMeasure: string | null;
  availabilityStatus: AvailabilityStatus;
}): string {
  if (state.availabilityStatus === 'value_present' && state.value !== null) {
    return `${formatExact(state.value)}${state.unitOfMeasure ? ` ${state.unitOfMeasure}` : ''}`;
  }
  return AVAILABILITY_STATUS_LABELS[state.availabilityStatus];
}

function fractionDigits(value: number): number {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot === -1 || text.includes('e') ? 0 : text.length - dot - 1;
}

/** 浮動小数の誤差（0.1+0.2）を表示に出さない差分 */
function formatDelta(next: number, previous: number): string {
  const digits = Math.min(10, Math.max(fractionDigits(next), fractionDigits(previous)));
  const scale = 10 ** digits;
  const diff = Math.round((next - previous) * scale) / scale;
  if (diff === 0) return '±0';
  return `${diff > 0 ? '+' : '−'}${formatExact(Math.abs(diff))}`;
}

function nfkcKey(text: string): string {
  return text.normalize('NFKC').trim().toLowerCase();
}

/** 並び順に依存しない JSON（jsonb はキーの順序を保存しないため、ハッシュはこれで作る） */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

async function sha256OfText(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

/**
 * 検証結果のハッシュ。確定時に同じ計算をして、保存した行が書き換えられていないこと、
 * 利用者が確認した差分と同じであることを確かめる。
 * 確定の進み具合（included・書き込み済みの ID）は含めない。
 */
async function computePreviewHash(
  batch: Pick<
    QuantitativeImportBatch,
    'organizationId' | 'reportingPeriodId' | 'fileSha256' | 'createdBy'
  >,
  rows: readonly StandardImportRow[],
): Promise<string> {
  const canonical = rows.map((row) => {
    const { included: _included, writtenDataPointId: _dp, writtenVersionId: _v, ...rest } = row;
    return rest;
  });
  return sha256OfText(
    stableStringify({
      organizationId: batch.organizationId,
      reportingPeriodId: batch.reportingPeriodId,
      fileSha256: batch.fileSha256,
      // 検証した人を含める。確定のときに検証し直す場合（バッチが別インスタンスにある）も、
      // 検証した本人でなければ一致しない（「検証した本人だけが確定できる」を保つ）
      createdBy: batch.createdBy,
      // 行には既存値の現在の版（currentVersionId・previous.versionId）と状態が入っている。
      // 検証の後に既存値が変われば一致しない（A05）
      rows: canonical,
    }),
  );
}

/** jsonb から読んだ行を、足りない項目を補って扱える形にする */
function toStandardRow(row: QuantitativeImportBatchRow): StandardImportRow {
  const r = row as Partial<StandardImportRow> & QuantitativeImportBatchRow;
  return {
    ...r,
    sourceKind: r.sourceKind ?? 'file',
    reportingPeriodId: r.reportingPeriodId ?? null,
    periodStart: r.periodStart ?? null,
    periodEnd: r.periodEnd ?? null,
    metricCode: r.metricCode ?? null,
    entityCode: r.entityCode ?? null,
    valueRaw: r.valueRaw ?? '',
    valueNormalized: r.valueNormalized ?? null,
    unitRaw: r.unitRaw ?? '',
    methodology: r.methodology ?? null,
    sourceReference: r.sourceReference ?? null,
    businessKey: r.businessKey ?? null,
    previous: r.previous ?? null,
    writtenDataPointId: r.writtenDataPointId ?? null,
    writtenVersionId: r.writtenVersionId ?? null,
  };
}

/**
 * 画面から届く ID の形だけを先に確かめる。
 * Supabase Mode で UUID でない文字列を渡すと DB が型エラーを返し、利用者には内部エラーに見えるため。
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canEditApproved(ctx: AuthorizationContext): boolean {
  // DB 側トリガ（t4d.enforce_data_point_transition）と同じく権限で判定する
  return can(ctx, 'enterprise.data.review') || can(ctx, 'enterprise.data.approve');
}

function assertCanImport(ctx: AuthorizationContext): void {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.import.run');
  assertCan(ctx, 'enterprise.data.write');
}

function businessKeyOf(
  organizationId: Uuid,
  metricId: Uuid,
  unitId: Uuid,
  periodId: Uuid,
  boundary: string,
): string {
  return [organizationId, metricId, unitId, periodId, boundary].join('|');
}

function previousStateOf(dp: DataPoint, versionNo: number | null): PreviousValueState {
  return {
    versionId: dp.currentVersionId,
    versionNo,
    value: dp.value,
    unitOfMeasure: dp.unitOfMeasure,
    valueKind: dp.valueKind,
    availabilityStatus: dp.availabilityStatus,
    absenceReason: dp.absenceReason,
    status: dp.status,
    methodology: dp.methodology,
  };
}

// ======================================================================
// マスター照合
// ======================================================================

const BOUNDARY_ALIASES: Record<string, string> = {
  consolidated: '連結',
  group: '連結',
  standalone: '単体',
  non_consolidated: '単体',
  parent_only: '単体',
};

/** 既存の取込・Fixture と同じ既定（連結子会社は「連結」、それ以外は「単体」） */
function defaultBoundary(unit: OrganizationUnit): string {
  return unit.consolidationMethod === 'full' ? '連結' : '単体';
}

interface MasterLookups {
  metricByCode: Map<string, MetricDefinition>;
  metricByName: Map<string, MetricDefinition>;
  unitByCode: Map<string, OrganizationUnit>;
  unitByName: Map<string, OrganizationUnit>;
  periods: ReportingPeriod[];
  periodById: Map<Uuid, ReportingPeriod>;
  periodByCode: Map<string, ReportingPeriod>;
  metricById: Map<Uuid, MetricDefinition>;
  unitById: Map<Uuid, OrganizationUnit>;
}

async function loadMasters(db: DbClient, organizationId: Uuid): Promise<MasterLookups> {
  const [metrics, units, periods] = await Promise.all([
    db.select('metrics', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('units', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('periods', { where: { organizationId } }),
  ]);
  return {
    metricByCode: new Map(metrics.map((m) => [nfkcKey(m.code), m])),
    metricByName: new Map(metrics.map((m) => [nfkcKey(m.name), m])),
    unitByCode: new Map(units.map((u) => [nfkcKey(u.code), u])),
    unitByName: new Map(units.map((u) => [nfkcKey(u.name), u])),
    periods,
    periodById: new Map(periods.map((p) => [p.id, p])),
    periodByCode: new Map(periods.map((p) => [nfkcKey(p.code), p])),
    metricById: new Map(metrics.map((m) => [m.id, m])),
    unitById: new Map(units.map((u) => [u.id, u])),
  };
}

function resolvePeriod(
  interp: InterpretedStandardRow,
  masters: MasterLookups,
  errors: string[],
  warnings: string[],
): ReportingPeriod | null {
  if (interp.periodCode && !interp.periodStart) {
    const byCode = masters.periodByCode.get(nfkcKey(interp.periodCode));
    if (!byCode) {
      errors.push(`期間「${interp.periodCode}」は報告期間にありません。`);
      return null;
    }
    warnings.push(
      `期間を年度コード「${interp.periodCode}」から ${byCode.startDate}〜${byCode.endDate} に対応付けました（候補）。`,
    );
    return byCode;
  }
  const start = interp.periodStart;
  const end = interp.periodEnd;
  if (!start || !end) return null;
  const exact = masters.periods.find((p) => p.startDate === start && p.endDate === end);
  if (exact) return exact;

  const containing = masters.periods.find((p) => p.startDate <= start && end <= p.endDate);
  if (containing) {
    errors.push(
      `期間 ${start}〜${end} は報告期間「${containing.label}」（${containing.startDate}〜${containing.endDate}）の途中の期間です。月次・四半期の値を年次の値と重ねて足さないため、この取込では登録しません。`,
    );
    return null;
  }
  const overlapping = masters.periods.filter((p) => p.startDate <= end && start <= p.endDate);
  if (overlapping.length > 0) {
    errors.push(
      `期間 ${start}〜${end} は報告期間（${overlapping.map((p) => p.label).join('・')}）にまたがっています。年度ごとの行に分けてください。`,
    );
    return null;
  }
  errors.push(`期間 ${start}〜${end} に一致する報告期間がありません。`);
  return null;
}

function resolveMetric(
  key: string,
  masters: MasterLookups,
  errors: string[],
  warnings: string[],
): MetricDefinition | null {
  if (!key) return null;
  const byCode = masters.metricByCode.get(nfkcKey(key));
  const metric = byCode ?? masters.metricByName.get(nfkcKey(key)) ?? null;
  if (!metric) {
    errors.push(`指標「${key}」は指標定義にありません。`);
    return null;
  }
  if (!byCode) {
    warnings.push(`指標を名称「${key}」から指標コード「${metric.code}」に対応付けました（候補）。`);
  }
  if (metric.dataType === 'text' || metric.dataType === 'boolean') {
    errors.push(
      `指標「${metric.name}」は数値の指標ではありません。標準 CSV は数値だけを登録します。`,
    );
    return null;
  }
  return metric;
}

function resolveUnit(
  ctx: AuthorizationContext,
  key: string,
  masters: MasterLookups,
  errors: string[],
  warnings: string[],
): OrganizationUnit | null {
  if (!key) return null;
  const byCode = masters.unitByCode.get(nfkcKey(key));
  const unit = byCode ?? masters.unitByName.get(nfkcKey(key)) ?? null;
  if (!unit) {
    errors.push(`組織コード「${key}」は組織マスターにありません（未知の組織）。`);
    return null;
  }
  if (!byCode) {
    warnings.push(`組織を名称「${key}」から組織コード「${unit.code}」に対応付けました（候補）。`);
  }
  if (unit.unitType === 'supplier') {
    errors.push(
      `「${unit.name}」はサプライヤーです。標準 CSV の登録対象ではありません（Scope3 のサプライヤーデータ取込を使ってください）。`,
    );
    return null;
  }
  if (!isUnitInScope(ctx, unit.id)) {
    errors.push(`「${unit.name}」は担当外の組織です。担当範囲の組織だけ登録できます。`);
    return null;
  }
  return unit;
}

function resolveBoundary(
  code: string | null,
  unit: OrganizationUnit,
  knownBoundaries: ReadonlySet<string>,
  errors: string[],
): string | null {
  if (!code) return defaultBoundary(unit);
  const alias = BOUNDARY_ALIASES[nfkcKey(code).replace(/[\s-]+/g, '_')];
  if (alias) return alias;
  const normalized = code.normalize('NFKC').trim();
  if (knownBoundaries.has(normalized)) return normalized;
  errors.push(
    `集計範囲「${code}」は登録されていません（使える値: ${[...knownBoundaries].join('／')}）。`,
  );
  return null;
}

// ======================================================================
// 検証
// ======================================================================

interface ParsedSource {
  parse: StandardCsvParseResult;
  fileName: string;
  fileSha256: string;
  sourceKind: QuantitativeImportSourceKind;
}

async function parseSource(
  source: QuantitativeImportSource,
  masters: MasterLookups,
): Promise<ParsedSource> {
  if (source.kind === 'file') {
    return {
      parse: parseStandardCsvBytes(source.bytes),
      fileName: source.fileName.trim() || '（名前なし）',
      fileSha256: await sha256Hex(source.bytes),
      sourceKind: 'file',
    };
  }
  if (source.kind === 'text') {
    return {
      parse: parseStandardCsvText(source.text, '貼り付け（UTF-8）'),
      fileName: source.fileName?.trim() || '貼り付け',
      fileSha256: await sha256OfText(source.text),
      sourceKind: 'text',
    };
  }

  const entry = source.entry;
  const period = masters.periodById.get(entry.reportingPeriodId);
  if (!period) throw new NotFoundError('報告期間が見つかりません。');
  const fields: Partial<Record<StandardField, string>> = {
    metric_code: entry.metricCode.trim(),
    period_start: period.startDate,
    period_end: period.endDate,
    entity_code: entry.entityCode.trim(),
    boundary_code: entry.boundaryCode?.trim() ?? '',
    value: entry.value,
    unit: entry.unit.trim(),
    value_kind: entry.valueKind?.trim() ?? '',
    availability_status: entry.availabilityStatus?.trim() ?? '',
    absence_reason: entry.absenceReason?.trim() ?? '',
    methodology_code: entry.methodologyCode?.trim() ?? '',
    source_reference: entry.sourceReference?.trim() ?? '',
  };
  const raw: Record<string, string> = {};
  for (const [field, value] of Object.entries(fields)) raw[field] = value ?? '';
  return {
    parse: {
      format: 'standard',
      encoding: '手入力',
      delimiter: ',',
      headers: Object.keys(raw),
      mapping: Object.keys(raw).map((header) => ({
        header,
        field: header as StandardField,
        candidate: false,
      })),
      fileErrors: [],
      fileWarnings: [],
      rows: [{ rowNo: 1, raw, fields }],
    },
    fileName: '手入力',
    fileSha256: await sha256OfText(stableStringify(fields)),
    sourceKind: 'manual',
  };
}

/**
 * 目標値と実績・推計の入れ替えは、取込では行わない（指示書 §7.1「実績・推計・目標を分離」）。
 * 業務キー（指標・組織・期間・境界）に値の区分は含まれないため、同じキーの行で区分を「目標」へ
 * 変えると実績の版が目標で上書きされ、集計から実績が消える（逆も同じ）。変更理由があっても止める
 */
export const TARGET_KIND_SWITCH_ERROR =
  '目標値と実績・推計は同じ枠で入れ替えられません（区分を切り替えると既存の値が集計から消えます）。目標は ESG 経営の目標登録で管理し、実績・推計はこの取込で登録してください。';

function targetValueKind(
  interp: InterpretedStandardRow,
  existing: DataPoint | null,
  warnings: string[],
  errors: string[],
): ValueKind {
  if (
    interp.valueKind &&
    existing &&
    (interp.valueKind === 'target') !== ((existing.valueKind ?? 'actual') === 'target')
  ) {
    errors.push(TARGET_KIND_SWITCH_ERROR);
    return existing.valueKind ?? 'actual';
  }
  if (interp.valueKind === 'target' && !existing) {
    warnings.push('目標値として登録します。目標値は実績の合計・前年比に入りません。');
  }
  if (interp.valueKind) {
    if (existing && existing.valueKind === 'estimate' && interp.valueKind === 'actual') {
      warnings.push('既存の「推計」を「実績」へ切り替えます。');
    }
    if (existing && existing.valueKind === 'actual' && interp.valueKind === 'estimate') {
      warnings.push('既存の「実績」を「推計」で置き換えます。');
    }
    return interp.valueKind;
  }
  if (existing) {
    // 区分が空欄のときに実績へ変えると、推計が黙って実績になる（A11）。既存の区分を引き継ぐ
    if (existing.valueKind !== 'actual') {
      warnings.push(
        `値の区分が空欄のため、既存の「${VALUE_KIND_LABELS[existing.valueKind]}」を引き継ぎます。実績に切り替える場合は value_kind=actual を明示してください。`,
      );
    }
    return existing.valueKind;
  }
  return 'actual';
}

function sameState(
  a: {
    value: number | null;
    unitOfMeasure: string;
    valueKind: ValueKind;
    availabilityStatus: AvailabilityStatus;
    absenceReason: string | null;
  },
  b: typeof a,
): boolean {
  return (
    a.value === b.value &&
    normalizeUnitForCompare(a.unitOfMeasure) === normalizeUnitForCompare(b.unitOfMeasure) &&
    a.valueKind === b.valueKind &&
    a.availabilityStatus === b.availabilityStatus &&
    (a.absenceReason ?? '').trim() === (b.absenceReason ?? '').trim()
  );
}

interface BuiltBatch {
  batch: QuantitativeImportBatch;
  masters: MasterLookups;
  meta: {
    format: StandardCsvFormat;
    encoding: string;
    delimiter: string;
    mapping: StandardCsvParseResult['mapping'];
    fileWarnings: string[];
  };
}

export async function validateQuantitativeImport(
  db: DbClient,
  ctx: AuthorizationContext,
  input: ValidateQuantitativeImportInput,
): Promise<QuantitativeImportPreview> {
  const built = await buildValidatedBatch(db, ctx, input, crypto.randomUUID());
  await db.insert('quantitativeImportBatches', [built.batch]);
  return buildPreview(built.batch, built.masters, built.meta);
}

/**
 * 入力を解析・照合して、検証結果（まだ保存しないバッチ）を作る。検証と、バッチが見つからない
 * ときの確定（検証し直し）が同じ関数を使う（同じ入力・同じ台帳なら同じハッシュになる）
 */
async function buildValidatedBatch(
  db: DbClient,
  ctx: AuthorizationContext,
  input: ValidateQuantitativeImportInput,
  batchId: Uuid,
): Promise<BuiltBatch> {
  assertCanImport(ctx);
  const organizationId = ctx.workspace.organizationId;
  const notation = input.numberNotation ?? 'auto';

  const masters = await loadMasters(db, organizationId);
  const batchPeriod = masters.periodById.get(input.reportingPeriodId);
  if (!batchPeriod) throw new NotFoundError('報告期間が見つかりません。');
  if (input.projectId) {
    if (!UUID_PATTERN.test(input.projectId)) {
      throw new NotFoundError('開示プロジェクトが見つかりません。');
    }
    const project = await db.findById('disclosureProjects', input.projectId);
    if (!project || project.organizationId !== organizationId || project.deletedAt) {
      throw new NotFoundError('開示プロジェクトが見つかりません。');
    }
  }

  const { parse, fileName, fileSha256, sourceKind } = await parseSource(input.source, masters);
  if (parse.fileErrors.length > 0) {
    throw new ValidationError(`登録できない形式です。${parse.fileErrors.join(' ')}`);
  }

  // 1 周目: 文字列の解釈とマスター照合
  const interpreted = parse.rows.map((row) => {
    const interp = interpretStandardRow(row, notation);
    const errors = [...interp.errors];
    const warnings = [...interp.warnings];
    const period = resolvePeriod(interp, masters, errors, warnings);
    const metric = resolveMetric(interp.metricKey, masters, errors, warnings);
    const unit = resolveUnit(ctx, interp.entityKey, masters, errors, warnings);
    return { row, interp, errors, warnings, period, metric, unit };
  });

  // 既存値は関係する期間の分だけまとめて読む（削除済みも含める: 業務キーの衝突を先に見つける）
  const periodIds = [...new Set(interpreted.flatMap((r) => (r.period ? [r.period.id] : [])))];
  const existingAll =
    periodIds.length === 0
      ? []
      : await db.select('dataPoints', {
          where: { organizationId, reportingPeriodId: { in: periodIds } },
        });
  const knownBoundaries = new Set<string>(['連結', '単体']);
  for (const dp of existingAll) if (!dp.deletedAt) knownBoundaries.add(dp.boundary);
  const liveByKey = new Map<string, DataPoint>();
  const deletedKeys = new Set<string>();
  for (const dp of existingAll) {
    const key = businessKeyOf(
      organizationId,
      dp.metricId,
      dp.unitId,
      dp.reportingPeriodId,
      dp.boundary,
    );
    if (dp.deletedAt) deletedKeys.add(key);
    else liveByKey.set(key, dp);
  }
  // 2 周目: 業務キーと重複
  const withKeys = interpreted.map((entry) => {
    const boundary = entry.unit
      ? resolveBoundary(entry.interp.boundaryCode, entry.unit, knownBoundaries, entry.errors)
      : null;
    const key =
      entry.metric && entry.unit && entry.period && boundary
        ? businessKeyOf(organizationId, entry.metric.id, entry.unit.id, entry.period.id, boundary)
        : null;
    return { ...entry, boundary, key };
  });

  // 画面に「v2 → v3」と出すため、ファイルが触れる既存値の現在版の番号だけを読む
  // （期間の全件を in で渡すと、Supabase Mode では URL が長くなりすぎる）
  const versionNoById = new Map<Uuid, number>();
  const referencedVersionIds = [
    ...new Set(
      withKeys.flatMap((entry) => {
        const dp = entry.key ? liveByKey.get(entry.key) : undefined;
        return dp?.currentVersionId ? [dp.currentVersionId] : [];
      }),
    ),
  ];
  for (let i = 0; i < referencedVersionIds.length; i += 100) {
    const versions = await db.select('dataPointVersions', {
      where: { id: { in: referencedVersionIds.slice(i, i + 100) } },
    });
    for (const v of versions) versionNoById.set(v.id, v.versionNo);
  }
  const rowsByKey = new Map<string, number[]>();
  for (const entry of withKeys) {
    if (!entry.key) continue;
    rowsByKey.set(entry.key, [...(rowsByKey.get(entry.key) ?? []), entry.row.rowNo]);
  }

  const canEditApprovedValues = canEditApproved(ctx);

  // 3 周目: 既存値との差分
  const rows: StandardImportRow[] = withKeys.map((entry) => {
    const { row, interp, errors, warnings, period, metric, unit, boundary, key } = entry;

    if (key) {
      const sameKeyRows = (rowsByKey.get(key) ?? []).filter((n) => n !== row.rowNo);
      if (sameKeyRows.length > 0) {
        errors.push(
          `同じ指標・組織・期間・集計範囲の行が ${sameKeyRows.join('・')} 行目にもあります（重複）。どちらが正しいか判断できないため登録しません。合算もしません。`,
        );
      }
      if (deletedKeys.has(key) && !liveByKey.has(key)) {
        errors.push(
          '削除済みのデータと同じ指標・組織・期間・集計範囲です。管理者に確認してください。',
        );
      }
    }

    let unitOfMeasure: string | null = metric?.unit ?? null;
    if (metric && interp.unitRaw) {
      if (normalizeUnitForCompare(interp.unitRaw) !== normalizeUnitForCompare(metric.unit)) {
        errors.push(
          `単位「${interp.unitRaw}」が指標定義の単位「${metric.unit}」と異なります（単位違い）。換算はしません。指標定義の単位の値にしてください。`,
        );
        unitOfMeasure = interp.unitRaw;
      } else if (interp.unitRaw !== metric.unit) {
        warnings.push(`単位の表記を指標定義に揃えました（${interp.unitRaw} → ${metric.unit}）。`);
      }
    }

    if (metric && interp.value !== null) {
      if (metric.dataType === 'integer' && !Number.isInteger(interp.value)) {
        errors.push(`指標「${metric.name}」は整数の指標ですが、小数が入っています。`);
      }
      if (
        (metric.minValue !== null && interp.value < metric.minValue) ||
        (metric.maxValue !== null && interp.value > metric.maxValue)
      ) {
        warnings.push(
          `指標定義の範囲（${metric.minValue ?? '—'}〜${metric.maxValue ?? '—'}）の外の値です。内容を確認してください。`,
        );
      }
    }

    if (period && period.id !== batchPeriod.id) {
      warnings.push(
        `選択中の期間（${batchPeriod.label}）と異なる期間（${period.label}）の行です。`,
      );
    }
    if (period && period.status === 'closed') {
      warnings.push(`締め済みの期間（${period.label}）の値です。`);
    }

    const existing = key ? (liveByKey.get(key) ?? null) : null;
    const previous = existing
      ? previousStateOf(
          existing,
          existing.currentVersionId ? (versionNoById.get(existing.currentVersionId) ?? null) : null,
        )
      : null;

    let diffKind: QuantitativeImportDiffKind;
    let valueKind: ValueKind = interp.valueKind ?? existing?.valueKind ?? 'actual';
    let value = interp.value;
    let availabilityStatus = interp.availabilityStatus;
    let absenceReason = interp.absenceReason;
    let finalUnit = unitOfMeasure;

    if (errors.length > 0) {
      diffKind = 'error';
    } else if (!existing) {
      diffKind = 'new';
      valueKind = targetValueKind(interp, null, warnings, errors);
    } else if (interp.blankCandidate && existing.availabilityStatus !== 'not_entered') {
      // 空欄は「未入力」の候補。既に値や人の判断（対象外など）がある枠を空欄で消さない
      diffKind = 'unchanged';
      warnings.push(
        `空欄のため、既存の値（${displayState(existing)}）は変更しません。取り消す場合は値の有無を明示してください。`,
      );
      valueKind = existing.valueKind;
      value = existing.value;
      availabilityStatus = existing.availabilityStatus;
      absenceReason = existing.absenceReason;
      finalUnit = existing.unitOfMeasure;
    } else {
      valueKind = targetValueKind(interp, existing, warnings, errors);
      const target = {
        value: interp.value,
        unitOfMeasure: unitOfMeasure ?? existing.unitOfMeasure,
        valueKind,
        availabilityStatus: interp.availabilityStatus,
        absenceReason: interp.absenceReason,
      };
      if (errors.length > 0) {
        diffKind = 'error';
      } else if (sameState(target, existing)) {
        diffKind = 'unchanged';
        warnings.push('既存の値と同じため、新しい版は作りません（重複して登録しません）。');
        if (interp.methodology && interp.methodology !== existing.methodology) {
          warnings.push('算定方法の記載が既存と異なりますが、値が同じため版は作りません。');
        }
      } else {
        diffKind = 'changed';
        if (existing.status === 'approved') {
          if (!canEditApprovedValues) {
            errors.push(
              '承認済みの値の変更にはレビュー権限が必要です。レビュー担当へ差戻しを依頼してください。',
            );
            diffKind = 'error';
          } else {
            warnings.push(
              '承認済みの値です。確定すると下書きへ戻り「承認後に変更」を記録します（取込で承認はしません）。',
            );
          }
        } else if (existing.status === 'submitted' || existing.status === 'in_review') {
          warnings.push(
            `${DATA_POINT_STATUS_LABELS[existing.status]}の値を更新します（状態は変わりません）。`,
          );
        }
        if (
          normalizeUnitForCompare(existing.unitOfMeasure) !==
          normalizeUnitForCompare(target.unitOfMeasure)
        ) {
          warnings.push(
            `既存の値の単位（${existing.unitOfMeasure}）が指標定義の単位と異なります。換算はしていません。`,
          );
        }
      }
    }

    return {
      rowNo: row.rowNo,
      raw: row.raw,
      diffKind,
      included: diffKind !== 'error',
      metricId: metric?.id ?? null,
      unitId: unit?.id ?? null,
      boundary,
      dataPointId: existing?.id ?? null,
      currentVersionId: existing?.currentVersionId ?? null,
      value,
      textValue: null,
      unitOfMeasure: finalUnit,
      valueKind,
      availabilityStatus,
      absenceReason,
      errors,
      warnings,
      sourceKind,
      reportingPeriodId: period?.id ?? null,
      periodStart: period?.startDate ?? interp.periodStart,
      periodEnd: period?.endDate ?? interp.periodEnd,
      metricCode: metric?.code ?? (interp.metricKey || null),
      entityCode: unit?.code ?? (interp.entityKey || null),
      valueRaw: interp.valueRaw,
      valueNormalized: interp.valueNormalized,
      unitRaw: interp.unitRaw,
      methodology: interp.methodology,
      sourceReference: interp.sourceReference,
      businessKey: key,
      previous,
      writtenDataPointId: null,
      writtenVersionId: null,
    };
  });

  // 同じ内容のファイルが確定済みなら、ファイル名が違っても知らせる（A03 の重複理由）
  const fileWarnings = [...parse.fileWarnings];
  const sameContent = await db.select('quantitativeImportBatches', {
    where: { organizationId, fileSha256, status: 'committed' },
    orderBy: { column: 'committedAt', dir: 'desc' },
    limit: 1,
  });
  const earlier = sameContent[0];
  if (earlier && sourceKind !== 'manual') {
    fileWarnings.push(
      `同じ内容のファイルが ${formatJst(earlier.committedAt)} に確定済みです（ファイル名「${earlier.fileName}」）。ファイル名が違っても、値が同じ行は「変更なし」になり二重に登録しません。`,
    );
  }

  const now = new Date().toISOString();
  const base = {
    organizationId,
    reportingPeriodId: batchPeriod.id,
    fileSha256,
    createdBy: ctx.userId,
  };
  const batch: QuantitativeImportBatch = {
    id: batchId,
    ...base,
    projectId: input.projectId ?? null,
    fileName,
    status: 'validated',
    rows,
    previewHash: await computePreviewHash(base, rows),
    commitIdempotencyKey: null,
    committedAt: null,
    committedBy: null,
    excludedCount: 0,
    createdAt: now,
  };
  return {
    batch,
    masters,
    meta: {
      format: parse.format,
      encoding: parse.encoding,
      delimiter: parse.delimiter,
      mapping: parse.mapping,
      fileWarnings,
    },
  };
}

function buildPreview(
  batch: QuantitativeImportBatch,
  masters: MasterLookups,
  meta: {
    format: StandardCsvFormat;
    encoding: string;
    delimiter: string;
    mapping: StandardCsvParseResult['mapping'];
    fileWarnings: string[];
  },
): QuantitativeImportPreview {
  const rows = batch.rows.map(toStandardRow);
  const counts: Record<QuantitativeImportDiffKind, number> = {
    new: 0,
    changed: 0,
    unchanged: 0,
    error: 0,
  };
  for (const row of rows) counts[row.diffKind] += 1;
  const period = masters.periodById.get(batch.reportingPeriodId);

  return {
    batchId: batch.id,
    fileName: batch.fileName,
    fileSha256: batch.fileSha256,
    previewHash: batch.previewHash,
    status: batch.status,
    statusLabel: QUANTITATIVE_IMPORT_STATUS_LABELS[batch.status],
    sourceKind: rows[0]?.sourceKind ?? 'file',
    reportingPeriodId: batch.reportingPeriodId,
    reportingPeriodLabel: period?.label ?? '—',
    format: meta.format,
    formatLabel: FORMAT_LABELS[meta.format],
    encoding: meta.encoding,
    delimiterLabel: DELIMITER_LABELS[meta.delimiter] ?? meta.delimiter,
    mapping: meta.mapping.map((m) => ({
      header: m.header,
      field: m.field,
      fieldLabel: m.field ? STANDARD_FIELD_LABELS[m.field] : null,
      candidate: m.candidate,
    })),
    fileWarnings: meta.fileWarnings,
    counts,
    rows: rows.map((row) => toPreviewRow(row, masters)),
    createdAt: batch.createdAt,
  };
}

function toPreviewRow(
  row: StandardImportRow,
  masters: MasterLookups,
): QuantitativeImportPreviewRow {
  const metric = row.metricId ? masters.metricById.get(row.metricId) : undefined;
  const unit = row.unitId ? masters.unitById.get(row.unitId) : undefined;
  const period = row.reportingPeriodId ? masters.periodById.get(row.reportingPeriodId) : undefined;

  // 値が読み取れなかった行（曖昧な表記など）は「—」。原文セルは別の列に出す
  const valueDisplay =
    row.availabilityStatus !== 'value_present'
      ? AVAILABILITY_STATUS_LABELS[row.availabilityStatus]
      : row.value !== null
        ? formatExact(row.value)
        : '—';

  const previous = row.previous
    ? {
        valueDisplay: displayState({ ...row.previous, unitOfMeasure: null }),
        unitOfMeasure: row.previous.unitOfMeasure,
        versionNo: row.previous.versionNo,
        status: row.previous.status,
        valueKindLabel: VALUE_KIND_LABELS[row.previous.valueKind],
        availabilityStatus: row.previous.availabilityStatus,
        availabilityLabel: AVAILABILITY_STATUS_LABELS[row.previous.availabilityStatus],
      }
    : null;

  // 差は同じ単位の数値どうしのときだけ出す（単位違い・値なしの行で差を計算しない）
  const prev = row.previous;
  const delta =
    prev &&
    prev.availabilityStatus === 'value_present' &&
    row.availabilityStatus === 'value_present' &&
    prev.value !== null &&
    row.value !== null &&
    row.unitOfMeasure !== null &&
    normalizeUnitForCompare(prev.unitOfMeasure) === normalizeUnitForCompare(row.unitOfMeasure)
      ? formatDelta(row.value, prev.value)
      : null;

  return {
    rowNo: row.rowNo,
    diffKind: row.diffKind,
    diffLabel: QUANTITATIVE_IMPORT_DIFF_KIND_LABELS[row.diffKind],
    included: row.included,
    raw: row.raw,
    valueRaw: row.valueRaw,
    valueDisplay,
    unitOfMeasure: row.unitOfMeasure,
    metricCode: row.metricCode,
    metricName: metric?.name ?? null,
    entityCode: row.entityCode,
    unitName: unit?.name ?? null,
    periodLabel: period?.label ?? null,
    // 期間の名称に日付が入っている場合（例: 2026年度（2026-04-01〜2027-03-31））は重ねて出さない
    periodRange:
      row.periodStart && row.periodEnd && !period?.label.includes(row.periodStart)
        ? `${row.periodStart}〜${row.periodEnd}`
        : null,
    boundary: row.boundary,
    valueKind: row.valueKind,
    valueKindLabel: VALUE_KIND_LABELS[row.valueKind],
    availabilityStatus: row.availabilityStatus,
    availabilityLabel: AVAILABILITY_STATUS_LABELS[row.availabilityStatus],
    absenceReason: row.absenceReason,
    methodology: row.methodology,
    sourceReference: row.sourceReference,
    previous,
    delta,
    errors: row.errors,
    warnings: row.warnings,
  };
}

// ======================================================================
// 確定
// ======================================================================

function resultFromCommittedBatch(
  batch: QuantitativeImportBatch,
  replayed: boolean,
): QuantitativeImportCommitResult {
  const rows = batch.rows.map(toStandardRow);
  const writtenRows = rows.flatMap((row) =>
    row.writtenDataPointId &&
    row.writtenVersionId &&
    (row.diffKind === 'new' || row.diffKind === 'changed')
      ? [
          {
            rowNo: row.rowNo,
            diffKind: row.diffKind,
            dataPointId: row.writtenDataPointId,
            versionId: row.writtenVersionId,
          },
        ]
      : [],
  );
  const excludedRows = rows
    .filter((row) => !row.included)
    .map((row) => ({ rowNo: row.rowNo, reasons: row.errors }));
  return {
    batchId: batch.id,
    fileName: batch.fileName,
    replayed,
    created: writtenRows.filter((r) => r.diffKind === 'new').length,
    updated: writtenRows.filter((r) => r.diffKind === 'changed').length,
    unchanged: rows.filter((row) => row.included && row.diffKind === 'unchanged').length,
    excluded: batch.excludedCount,
    excludedRows,
    writtenRows,
    committedAt: batch.committedAt ?? batch.createdAt,
  };
}

function rowLabel(row: StandardImportRow): string {
  return [
    row.metricCode,
    row.entityCode,
    row.periodStart && row.periodEnd ? `${row.periodStart}〜${row.periodEnd}` : null,
    row.boundary,
  ]
    .filter(Boolean)
    .join(' / ');
}

/**
 * 同じ取込バッチの確定を、このインスタンスの中では 1 つずつ順に処理する。
 *
 * 二重押下の 2 通目が 1 通目の書き込み中に届くと、どちらも「未確定」と読んで二重に版を作る。
 * 順に処理すれば、2 通目は 1 通目の結果（確定済み）を読み、同じキーなら最初の結果を返す。
 * 別インスタンスへ同時に届いた場合までは防げない（DbClient に排他が無い。known-limitations に記載）。
 */
const commitQueues = new Map<string, Promise<unknown>>();

function serializeCommit<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = commitQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  commitQueues.set(key, next);
  next
    .finally(() => {
      if (commitQueues.get(key) === next) commitQueues.delete(key);
    })
    .catch(() => undefined);
  return next;
}

export async function commitQuantitativeImport(
  db: DbClient,
  ctx: AuthorizationContext,
  input: CommitQuantitativeImportInput,
): Promise<QuantitativeImportCommitResult> {
  assertCanImport(ctx);
  return serializeCommit(`${ctx.workspace.organizationId}:${input.batchId}`, () =>
    commitSerialized(db, ctx, input),
  );
}

/**
 * 確定のリクエストに検証結果（バッチ）が無いとき、画面が送り直した元の入力から検証し直してバッチを作る。
 *
 * Demo Mode（Vercel・外部ストアなし）では、検証と確定が別のインスタンスに届くとバッチが見つからない。
 * 検証結果（行ごとの解析・差分）は大きく Cookie に載らないため、元の入力（数 KB の CSV）をブラウザが
 * 持ち、確定のときに送り直す。サーバーは送られた解析結果を使わず、元の入力を同じ関数で解析・照合し、
 * 内容・既存値の版と状態・検証した人を含むハッシュが利用者の確認したものと一致するときだけ確定する
 * （一致しなければ、検証の後に何かが変わったとして止める。A05 と同じ）。
 * 確定キーの意味は変えない: 確定の控えは Cookie でも持ち回し（demo-compact.ts）、同じキーの再送は
 * 検証し直す前に控えから最初の結果を返す。
 */
async function rebuildBatchForCommit(
  db: DbClient,
  ctx: AuthorizationContext,
  input: CommitQuantitativeImportInput,
): Promise<QuantitativeImportBatch> {
  if (!input.source) throw new QuantitativeImportExpiredError();
  let built: BuiltBatch;
  try {
    built = await buildValidatedBatch(db, ctx, input.source, input.batchId);
  } catch (error) {
    // 送り直した入力が今は検証を通らない（期間・形式）。確認した差分とは違う結果なので競合として止める
    if (error instanceof ValidationError || error instanceof NotFoundError) {
      throw new QuantitativeImportConflictError([wholeImportConflict()]);
    }
    throw error;
  }
  if (built.batch.previewHash !== input.previewHash) {
    throw new QuantitativeImportConflictError(
      staleRowConflicts(built.batch.rows.map(toStandardRow), input.confirmedRows ?? []),
    );
  }
  await db.insert('quantitativeImportBatches', [built.batch]);
  return built.batch;
}

function wholeImportConflict(): QuantitativeImportConflict {
  return {
    rowNo: 0,
    label: '取込全体',
    reason:
      '検証の後に、台帳・マスター・操作している利用者のいずれかが変わりました（確認した差分と、いまの検証結果が一致しません）。',
    previewDisplay: '—',
    currentDisplay: '—',
  };
}

/**
 * 検証し直した結果と、利用者が確認した差分の違い（どの行の既存値が変わったか）。画面が送る確認済みの行は
 * 説明にだけ使う（検証し直した結果が確認したものと違う時点で確定は止まっている）
 */
function staleRowConflicts(
  rows: readonly StandardImportRow[],
  confirmed: readonly QuantitativeImportConfirmedRow[],
): QuantitativeImportConflict[] {
  const conflicts: QuantitativeImportConflict[] = [];
  for (const row of rows) {
    const seen = confirmed.find((c) => c.rowNo === row.rowNo);
    const now = row.previous;
    let reason: string | null = null;
    if (!seen) {
      reason = '検証の後に、登録する行が変わりました。';
    } else if (seen.diffKind === 'new' && now) {
      reason = '検証の後に、同じ指標・組織・期間・集計範囲の値が登録されました。';
    } else if (seen.previousVersionNo !== null && !now) {
      reason = '検証の後に、既存の値が削除されました。';
    } else if ((seen.previousVersionNo ?? null) !== (now?.versionNo ?? null)) {
      reason = '検証の後に、既存の値が更新されました（新しい版があります）。';
    } else if (seen.previousStatus && now && seen.previousStatus !== now.status) {
      reason = `検証の後に、既存の値の状態が変わりました（${DATA_POINT_STATUS_LABELS[seen.previousStatus]} → ${DATA_POINT_STATUS_LABELS[now.status]}）。`;
    } else if (seen.diffKind !== row.diffKind) {
      reason = '検証の後に、台帳またはマスターが変わり、差分の区分が変わりました。';
    }
    if (!reason) continue;
    conflicts.push({
      rowNo: row.rowNo,
      label: rowLabel(row),
      reason,
      previewDisplay: seen?.previousDisplay ?? '—',
      currentDisplay: now ? displayState(now) : '（既存の値なし）',
    });
  }
  return conflicts.length > 0 ? conflicts : [wholeImportConflict()];
}

async function commitSerialized(
  db: DbClient,
  ctx: AuthorizationContext,
  input: CommitQuantitativeImportInput,
): Promise<QuantitativeImportCommitResult> {
  const organizationId = ctx.workspace.organizationId;
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    throw new ValidationError('確定キーが不正です。画面を開き直してください。');
  }
  if (input.mode !== 'all' && input.mode !== 'valid_only') {
    throw new ValidationError('確定の方法が不正です。');
  }

  // 同じ確定キーの再送（二重押下・通信失敗後の再試行）は、書き込まずに最初の結果を返す
  const replay = (
    await db.select('quantitativeImportBatches', {
      where: { organizationId, commitIdempotencyKey: idempotencyKey },
      limit: 1,
    })
  )[0];
  if (replay) {
    if (replay.id !== input.batchId) {
      throw new ValidationError(
        'この確定キーは別の取込で使われています。画面を開き直してください。',
      );
    }
    if (replay.status === 'committed') return resultFromCommittedBatch(replay, true);
  }

  if (!UUID_PATTERN.test(input.batchId)) throw new QuantitativeImportExpiredError();
  const stored = await db.findById('quantitativeImportBatches', input.batchId);
  if (stored && stored.organizationId !== organizationId) {
    throw new QuantitativeImportExpiredError();
  }
  // 検証結果が無い（Demo Mode で検証したインスタンスと別のインスタンスに届いた）ときは、画面が送り直した
  // 元の入力から検証し直す。検証し直した結果が利用者の確認したものと同じときだけ確定する
  const batch = stored ?? (await rebuildBatchForCommit(db, ctx, input));
  if (batch.status === 'committed') {
    throw new ValidationError(
      `この取込は ${formatJst(batch.committedAt)} に確定済みです。同じ内容をもう一度登録する場合は、改めて検証してください。`,
    );
  }
  if (batch.status === 'rejected') {
    throw new ValidationError('この取込は却下されています。改めて検証してください。');
  }
  if (batch.createdBy !== ctx.userId) {
    throw new AuthorizationError(
      '検証した本人だけが確定できます。ご自身で検証してから確定してください。',
    );
  }

  const rows = batch.rows.map(toStandardRow);
  // サーバーに保存した検証結果が、検証したときのまま・利用者が確認したものと同じであること
  const recomputed = await computePreviewHash(batch, rows);
  if (recomputed !== batch.previewHash || input.previewHash !== batch.previewHash) {
    throw new ValidationError('検証結果が変わっています。もう一度検証してから確定してください。');
  }

  const errorRows = rows.filter((row) => row.diffKind === 'error');
  if (input.mode === 'all' && errorRows.length > 0) {
    throw new ValidationError(
      `エラーの行が ${errorRows.length} 行あるため、確定しませんでした（${errorRows
        .slice(0, 10)
        .map((r) => r.rowNo)
        .join('・')} 行目）。修正して検証し直すか、「正常行のみ登録」を明示して選んでください。`,
    );
  }
  const targets = rows.filter((row) => row.diffKind !== 'error');
  if (targets.length === 0) {
    throw new ValidationError('登録できる行がありません。エラーを修正して検証し直してください。');
  }

  // --- 書く前にすべて確かめる -------------------------------------------------
  for (const row of targets) {
    if (row.unitId) assertUnitInScope(ctx, row.unitId);
  }

  const periodIds = [
    ...new Set(targets.flatMap((r) => (r.reportingPeriodId ? [r.reportingPeriodId] : []))),
  ];
  const current = await db.select('dataPoints', {
    where: { organizationId, reportingPeriodId: { in: periodIds } },
  });
  const currentById = new Map(current.map((dp) => [dp.id, dp]));
  const currentByKey = new Map(
    current
      .filter((dp) => !dp.deletedAt)
      .map((dp) => [
        businessKeyOf(organizationId, dp.metricId, dp.unitId, dp.reportingPeriodId, dp.boundary),
        dp,
      ]),
  );

  const conflicts: QuantitativeImportConflict[] = [];
  /** 前回の途中失敗で書き終えている行（重ねて書かない） */
  const alreadyWritten = new Set<number>();
  for (const row of targets) {
    const now = row.dataPointId
      ? currentById.get(row.dataPointId)
      : row.businessKey
        ? currentByKey.get(row.businessKey)
        : undefined;
    if (row.writtenVersionId && now && now.currentVersionId === row.writtenVersionId) {
      alreadyWritten.add(row.rowNo);
      continue;
    }
    const previewDisplay = row.previous ? displayState(row.previous) : '（既存の値なし）';
    if (row.diffKind === 'new') {
      if (now) {
        conflicts.push({
          rowNo: row.rowNo,
          label: rowLabel(row),
          reason: '検証の後に、同じ指標・組織・期間・集計範囲の値が登録されました。',
          previewDisplay,
          currentDisplay: displayState(now),
        });
      }
      continue;
    }
    if (!now || now.deletedAt) {
      conflicts.push({
        rowNo: row.rowNo,
        label: rowLabel(row),
        reason: '検証の後に、既存の値が削除されました。',
        previewDisplay,
        currentDisplay: '（削除済み）',
      });
      continue;
    }
    if (now.currentVersionId !== row.currentVersionId) {
      conflicts.push({
        rowNo: row.rowNo,
        label: rowLabel(row),
        reason: '検証の後に、既存の値が更新されました（新しい版があります）。',
        previewDisplay,
        currentDisplay: displayState(now),
      });
      continue;
    }
    // 状態の変化（例: 入力中 → 承認済み）は、値を書き込む行だけ止める。
    // 承認済みへ変わった値を黙って下書きへ戻すと、確認した差分と結果が食い違う
    if (row.diffKind === 'changed' && row.previous && now.status !== row.previous.status) {
      conflicts.push({
        rowNo: row.rowNo,
        label: rowLabel(row),
        reason: `検証の後に、既存の値の状態が変わりました（${DATA_POINT_STATUS_LABELS[row.previous.status]} → ${DATA_POINT_STATUS_LABELS[now.status]}）。`,
        previewDisplay,
        currentDisplay: displayState(now),
      });
    }
  }
  if (conflicts.length > 0) throw new QuantitativeImportConflictError(conflicts);

  const toWrite = targets.filter(
    (row) =>
      (row.diffKind === 'new' || row.diffKind === 'changed') && !alreadyWritten.has(row.rowNo),
  );
  const correctionReason = input.correctionReason?.trim() ?? '';
  const changedCount = toWrite.filter((row) => row.diffKind === 'changed').length;
  if (changedCount > 0 && !correctionReason) {
    throw new ValidationError(
      `既存の値を変える行が ${changedCount} 行あります。変更理由を入力してください（新しい版に残ります）。`,
    );
  }
  if (correctionReason.length > 500) {
    throw new ValidationError('変更理由は 500 文字以内で入力してください。');
  }
  const editApproved = canEditApproved(ctx);
  for (const row of toWrite) {
    const dp = row.dataPointId ? currentById.get(row.dataPointId) : undefined;
    if (dp?.status === 'approved' && !editApproved) {
      throw new AuthorizationError(
        `${row.rowNo} 行目: 承認済みの値の変更にはレビュー権限が必要です。レビュー担当へ差戻しを依頼してください。`,
      );
    }
  }

  // --- まとめて書く -----------------------------------------------------------
  const periodsById = new Map(
    (await db.select('periods', { where: { organizationId } })).map((p) => [p.id, p]),
  );
  const [metricsById, unitsById] = await Promise.all([
    db
      .select('metrics', { where: { organizationId } })
      .then((ms) => new Map(ms.map((m) => [m.id, m]))),
    db
      .select('units', { where: { organizationId } })
      .then((us) => new Map(us.map((u) => [u.id, u]))),
  ]);

  const written = new Map<number, { dataPointId: Uuid; versionId: Uuid }>();
  for (const row of rows) {
    if (row.writtenDataPointId && row.writtenVersionId && alreadyWritten.has(row.rowNo)) {
      written.set(row.rowNo, {
        dataPointId: row.writtenDataPointId,
        versionId: row.writtenVersionId,
      });
    }
  }

  const sourceLabel =
    rows[0]?.sourceKind === 'manual'
      ? '手入力'
      : rows[0]?.sourceKind === 'text'
        ? `貼り付け「${batch.fileName}」`
        : `標準CSV「${batch.fileName}」`;

  for (const row of toWrite) {
    try {
      const outcome =
        row.diffKind === 'new'
          ? await writeNewDataPoint(db, ctx, row, {
              batchId: batch.id,
              sourceLabel,
              period: periodsById.get(row.reportingPeriodId ?? ''),
              metric: metricsById.get(row.metricId ?? ''),
              unit: unitsById.get(row.unitId ?? ''),
            })
          : await writeNewVersion(db, ctx, row, {
              batchId: batch.id,
              sourceLabel,
              changeReason: correctionReason,
              dataPoint: currentById.get(row.dataPointId ?? ''),
            });
      written.set(row.rowNo, outcome);
    } catch (error) {
      console.error('[quantitative-import] write failed', {
        batchId: batch.id,
        rowNo: row.rowNo,
        error,
      });
      // 書き終えた行をバッチへ残す（再試行で重ねて書かないため）。ここで失敗しても元の失敗を伝える
      try {
        await db.update('quantitativeImportBatches', batch.id, {
          rows: rows.map((r) => withWritten(r, written.get(r.rowNo))),
        });
      } catch (persistError) {
        console.error('[quantitative-import] progress not saved', persistError);
      }
      throw new QuantitativeImportPartialError(
        [...written.keys()].sort((a, b) => a - b),
        row.rowNo,
      );
    }
  }

  const committedAt = new Date().toISOString();
  const finalRows = rows.map((row) => ({
    ...withWritten(row, written.get(row.rowNo)),
    included: row.diffKind !== 'error',
  }));
  const excludedCount = rows.length - targets.length;
  const committed = await db.update('quantitativeImportBatches', batch.id, {
    status: 'committed',
    rows: finalRows,
    commitIdempotencyKey: idempotencyKey,
    committedAt,
    committedBy: ctx.userId,
    excludedCount,
  });

  const result = resultFromCommittedBatch(committed, false);

  // 取込は複数行をまとめて更新するため、確定後に期間ごと 1 回だけ検証を再計算する
  if (toWrite.length > 0) {
    const touched = new Set(
      toWrite.flatMap((r) => (r.reportingPeriodId ? [r.reportingPeriodId] : [])),
    );
    for (const periodId of touched) {
      const period = periodsById.get(periodId);
      if (period) await recomputePeriodValidations(db, ctx, period);
    }
  }

  await recordAuditEvent(db, ctx, {
    eventType: 'import_committed',
    resourceType: 'quantitative_import_batch',
    resourceId: batch.id,
    afterSummary:
      `${sourceLabel}を確定: 新規 ${result.created} 件 / 新しい版 ${result.updated} 件 / 変更なし ${result.unchanged} 件` +
      (excludedCount > 0 ? ` / 除外 ${excludedCount} 行（未登録）` : ''),
    metadata: {
      mode: input.mode,
      fileSha256: batch.fileSha256,
      excludedRowNos: result.excludedRows.map((r) => r.rowNo),
      changeReason: changedCount > 0 ? correctionReason : null,
    },
  });

  return result;
}

function withWritten(
  row: StandardImportRow,
  written: { dataPointId: Uuid; versionId: Uuid } | undefined,
): StandardImportRow {
  return written
    ? { ...row, writtenDataPointId: written.dataPointId, writtenVersionId: written.versionId }
    : row;
}

function sourceReferenceFor(
  row: StandardImportRow,
  context: { batchId: Uuid; sourceLabel: string },
): string {
  const origin =
    row.sourceKind === 'manual'
      ? `${context.sourceLabel}（取込 ${context.batchId.slice(0, 8)}）`
      : `${context.sourceLabel} ${row.rowNo} 行目（取込 ${context.batchId.slice(0, 8)}）`;
  return row.sourceReference ? `${origin} / 出所: ${row.sourceReference}` : origin;
}

async function writeNewDataPoint(
  db: DbClient,
  ctx: AuthorizationContext,
  row: StandardImportRow,
  context: {
    batchId: Uuid;
    sourceLabel: string;
    period: ReportingPeriod | undefined;
    metric: MetricDefinition | undefined;
    unit: OrganizationUnit | undefined;
  },
): Promise<{ dataPointId: Uuid; versionId: Uuid }> {
  const { period, metric, unit } = context;
  if (!period || !metric || !unit || row.boundary === null || row.unitOfMeasure === null) {
    throw new Error(`row ${row.rowNo}: master data disappeared`);
  }
  const organizationId = ctx.workspace.organizationId;
  const now = new Date().toISOString();
  const dataPointId = fid(
    'data_point',
    `${organizationId}/${period.code}/${unit.code}/${metric.code}/${row.boundary}`,
  );
  const versionId = fid('data_point_version', `${dataPointId}/v1`);

  // Supabase Mode は呼び出しごとに別トランザクション。版より先に親を作り、ポインタは後で付ける
  await db.insert('dataPoints', [
    {
      id: dataPointId,
      organizationId,
      metricId: metric.id,
      unitId: unit.id,
      reportingPeriodId: period.id,
      boundary: row.boundary,
      status: 'draft',
      currentVersionId: null,
      value: row.value,
      textValue: null,
      unitOfMeasure: row.unitOfMeasure,
      methodology: row.methodology ?? '標準 CSV より登録（算定方法の記載なし）',
      ownerUserId: ctx.userId,
      reviewerUserId: null,
      approvedAt: null,
      approvedBy: null,
      changedAfterApproval: false,
      valueKind: row.valueKind,
      availabilityStatus: row.availabilityStatus,
      absenceReason: row.absenceReason,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      deletedAt: null,
    },
  ]);
  const version: DataPointVersion = {
    id: versionId,
    dataPointId,
    organizationId,
    versionNo: 1,
    value: row.value,
    textValue: null,
    unitOfMeasure: row.unitOfMeasure,
    status: 'draft',
    valueKind: row.valueKind,
    availabilityStatus: row.availabilityStatus,
    absenceReason: row.absenceReason,
    sourceType: row.sourceKind === 'manual' ? 'manual' : 'import',
    sourceReference: sourceReferenceFor(row, context),
    changeReason: null,
    contentHash: contentHash(`${dataPointId}|1|${row.value}|${row.unitOfMeasure}`),
    createdAt: now,
    createdBy: ctx.userId,
  };
  await db.insert('dataPointVersions', [version]);
  await db.update('dataPoints', dataPointId, { currentVersionId: versionId });
  return { dataPointId, versionId };
}

async function writeNewVersion(
  db: DbClient,
  ctx: AuthorizationContext,
  row: StandardImportRow,
  context: {
    batchId: Uuid;
    sourceLabel: string;
    changeReason: string;
    dataPoint: DataPoint | undefined;
  },
): Promise<{ dataPointId: Uuid; versionId: Uuid }> {
  const dp = context.dataPoint;
  if (!dp || row.unitOfMeasure === null) {
    throw new Error(`row ${row.rowNo}: data point disappeared`);
  }
  const latest = await db.select('dataPointVersions', {
    where: { dataPointId: dp.id },
    orderBy: { column: 'versionNo', dir: 'desc' },
    limit: 1,
  });
  const versionNo = (latest[0]?.versionNo ?? 0) + 1;
  const now = new Date().toISOString();
  // 承認済み・未着手の値を変えたら下書きへ（取込で承認はしない）。それ以外の状態は保つ
  const nextStatus: DataPointStatus =
    dp.status === 'approved' || dp.status === 'not_started' ? 'draft' : dp.status;
  const version: DataPointVersion = {
    id: fid('data_point_version', `${dp.id}/v${versionNo}`),
    dataPointId: dp.id,
    organizationId: dp.organizationId,
    versionNo,
    value: row.value,
    textValue: null,
    unitOfMeasure: row.unitOfMeasure,
    status: nextStatus,
    valueKind: row.valueKind,
    availabilityStatus: row.availabilityStatus,
    absenceReason: row.absenceReason,
    sourceType: row.sourceKind === 'manual' ? 'manual' : 'import',
    sourceReference: sourceReferenceFor(row, context),
    changeReason: context.changeReason,
    contentHash: contentHash(`${dp.id}|${versionNo}|${row.value}|${row.unitOfMeasure}`),
    createdAt: now,
    createdBy: ctx.userId,
  };
  await db.insert('dataPointVersions', [version]);
  await db.update('dataPoints', dp.id, {
    value: row.value,
    textValue: null,
    unitOfMeasure: row.unitOfMeasure,
    valueKind: row.valueKind,
    availabilityStatus: row.availabilityStatus,
    absenceReason: row.absenceReason,
    methodology: row.methodology ?? dp.methodology,
    currentVersionId: version.id,
    status: nextStatus,
    changedAfterApproval: dp.status === 'approved' ? true : dp.changedAfterApproval,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  return { dataPointId: dp.id, versionId: version.id };
}

// ======================================================================
// 履歴
// ======================================================================

export interface QuantitativeImportHistoryItem {
  id: Uuid;
  fileName: string;
  status: QuantitativeImportStatus;
  statusLabel: string;
  counts: Record<QuantitativeImportDiffKind, number>;
  excludedCount: number;
  createdAt: IsoDateTime;
  committedAt: IsoDateTime | null;
}

/** 直近の取込バッチ（デモでは、このサーバーで検証したものと、Cookie で持ち回した確定の控え） */
export async function listQuantitativeImportBatches(
  db: DbClient,
  ctx: AuthorizationContext,
  limit = 10,
): Promise<QuantitativeImportHistoryItem[]> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.import.run');
  const batches = await db.select('quantitativeImportBatches', {
    where: { organizationId: ctx.workspace.organizationId },
    orderBy: [
      { column: 'createdAt', dir: 'desc' },
      { column: 'id', dir: 'desc' },
    ],
    limit,
  });
  return batches.map((batch) => {
    const counts: Record<QuantitativeImportDiffKind, number> = {
      new: 0,
      changed: 0,
      unchanged: 0,
      error: 0,
    };
    for (const row of batch.rows) counts[row.diffKind] += 1;
    return {
      id: batch.id,
      fileName: batch.fileName,
      status: batch.status,
      statusLabel: QUANTITATIVE_IMPORT_STATUS_LABELS[batch.status],
      counts,
      excludedCount: batch.excludedCount,
      createdAt: batch.createdAt,
      committedAt: batch.committedAt,
    };
  });
}
