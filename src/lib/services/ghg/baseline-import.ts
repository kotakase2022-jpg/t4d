import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import {
  assertCan,
  assertEnterpriseWorkspace,
  assertUnitInScope,
  NotFoundError,
} from '@/lib/authorization/can';
import {
  BASELINE_MAX_ROWS,
  extractBaselineRows,
  type BaselineColumnMapping,
  type BaselineParseError,
} from '@/lib/domain/ghg/baseline-parse';
import { DECIMAL_SEPARATORS, type DecimalSeparator } from '@/lib/domain/ghg/number-format';
import { parseUnit } from '@/lib/domain/ghg/units';
import { ValidationError } from '@/lib/errors/user-facing';
import { parseCsv, parseExcel, type ParsedTable } from '@/lib/imports/parsers';
import { DEMO_GHG_LIMITS, GHG_FIXTURE_ROW_IDS } from '@/lib/repositories/demo-ghg-checks';
import type { DbClient } from '@/lib/repositories/types';
import { isUuid } from '@/lib/validation/uuid';
import type {
  AuthorizationContext,
  BaselineGranularity,
  BaselineRow,
  GhgBaselineResult,
  GhgScope,
  OrganizationUnit,
  Uuid,
} from '@/types/domain';

/**
 * 既存の算定結果の取込（plan §2.3 baseline-import.ts・CR-11）。決定論（AI を使わない）。
 *
 *  - 権限は enterprise.import.run ＋ enterprise.data.write。対応付けた拠点はすべて担当拠点（拠点スコープ）
 *  - 流れは「ファイル → 列の対応と拠点の対応付け → 検証 → 確定」。検証の結果は Cookie にもサーバーにも
 *    持たない（本番は要求ごとに別インスタンス）。確定のときにクライアントが同じファイルを送り直し、
 *    サーバーが読み直して検証し直す。検証したファイルと同じかは sha256 で確かめる
 *  - 拠点コード → 拠点の対応付けは利用者が選ぶ（推測で決めない）。選ばれていない拠点コードがあれば確定しない。
 *    「照合に使わない」を選んだ拠点コードの行は拠点を持たないまま残す（照合では使わない）
 *  - 列の対応は見出しの語から既定値を出すが、確定するのは利用者（画面で直せる）
 *  - 数の表記（小数点の記号）は利用者が選ぶ。選ばなければ曖昧な数（3.741 など）は読まない
 *  - 追記専用（差し替えは supersedes_id）。監査ログは既存の種類（取込の確定＝import_committed）
 */

/** 取り込めるファイルの大きさの上限 */
export const BASELINE_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

const BASELINE_FILE_PATTERN = /\.(csv|tsv|txt|xlsx|xlsm)$/i;

/** 照合に使わない拠点コード（対応付けで利用者が選ぶ値） */
export const BASELINE_SITE_EXCLUDED = '__exclude__';

/** ラベル・ファイル名の上限（Demo の Cookie の検査と同じ値。DB の上限より小さい） */
const LABEL_MAX = 100;
const FILE_NAME_MAX = 255;

/** 行の文字の上限（Demo の Cookie の検査 demo-ghg-checks.ts と同じ値。超える行は戻せないため取り込まない） */
const ROW_TEXT_LIMITS: Array<[keyof BaselineRow, number, string]> = [
  ['siteCode', 40, '拠点コード'],
  ['activityCode', 60, '活動'],
  ['shipmentRef', 60, '出荷番号'],
  ['activityUnit', 20, '活動量の単位'],
  ['convertedUnit', 20, '換算後の単位'],
  ['factorUnit', 30, '排出係数の単位'],
  ['method', 40, '算定方法'],
  ['emissionsUnit', 20, '排出量の単位'],
  ['roundingNote', 100, '丸めの記述'],
];

export type BaselineMappingKey = Exclude<keyof BaselineColumnMapping, 'decimalSeparator'>;

export interface BaselineFieldSpec {
  key: BaselineMappingKey;
  label: string;
  required: boolean;
  /** 列の見出しがこの語なら既定値として選ぶ（正規化して比べる。最終的に決めるのは利用者） */
  aliases: readonly string[];
}

/** 列の対応の項目（必須は拠点・区分・排出量。残りは粒度と原因の分解に使う） */
export const BASELINE_FIELD_SPECS: readonly BaselineFieldSpec[] = [
  {
    key: 'siteCode',
    label: '拠点コード',
    required: true,
    aliases: ['拠点コード', '拠点', 'site', 'sitecode', '事業所コード'],
  },
  { key: 'scope', label: '区分（Scope）', required: true, aliases: ['区分', 'scope', 'スコープ'] },
  {
    key: 'emissions',
    label: '排出量',
    required: true,
    aliases: ['排出量', 'emissions', 'co2排出量'],
  },
  {
    key: 'emissionsUnit',
    label: '排出量の単位',
    required: false,
    aliases: ['排出量の単位', 'emissionsunit'],
  },
  {
    key: 'activity',
    label: '活動',
    required: false,
    aliases: ['活動', '活動の種類', 'activity', '燃料'],
  },
  { key: 'month', label: '月', required: false, aliases: ['月', '年月', 'month'] },
  { key: 'shipmentRef', label: '出荷番号', required: false, aliases: ['出荷番号', 'shipment'] },
  { key: 'activityAmount', label: '活動量', required: false, aliases: ['活動量', 'amount'] },
  { key: 'activityUnit', label: '活動量の単位', required: false, aliases: ['活動量の単位'] },
  { key: 'convertedAmount', label: '換算後の量', required: false, aliases: ['換算後の量'] },
  { key: 'convertedUnit', label: '換算後の単位', required: false, aliases: ['換算後の単位'] },
  { key: 'factorValue', label: '排出係数', required: false, aliases: ['排出係数', '係数'] },
  {
    key: 'factorUnit',
    label: '排出係数の単位',
    required: false,
    aliases: ['排出係数の単位', '係数の単位'],
  },
  { key: 'factorYear', label: '係数の年度', required: false, aliases: ['係数の年度', '係数年度'] },
  { key: 'method', label: '算定方法', required: false, aliases: ['算定方法', '方法'] },
  {
    key: 'rounding',
    label: '丸めの記述',
    required: false,
    aliases: ['丸め', '丸めの記述', '端数処理'],
  },
];

/** 単位の列が無いときに選ぶ排出量の単位（選ばなければ確定しない） */
export const BASELINE_EMISSION_UNITS = ['t-CO2e', 'kg-CO2e', 't-CO2', 'kg-CO2'] as const;

export const BASELINE_GRANULARITY_LABELS: Readonly<Record<BaselineGranularity, string>> = {
  site_scope: '拠点×区分の合計',
  site_activity: '拠点×活動',
  line: '行（月・出荷）',
};

export interface BaselineImportSettings {
  mapping: Partial<Record<BaselineMappingKey, string>>;
  decimalSeparator: DecimalSeparator | null;
  /** 単位の列が無いときの排出量の単位 */
  defaultEmissionsUnit: string | null;
  /** 拠点コード → 拠点 ID か BASELINE_SITE_EXCLUDED（選んでいない拠点コードは入れない） */
  sites: Record<string, string>;
}

export interface BaselineValidation {
  rowCount: number;
  granularity: BaselineGranularity;
  errorCount: number;
  /** 先頭 20 件 */
  errors: BaselineParseError[];
  scopes: GhgScope[];
  /** 丸めの記述: 読めた・読めない（丸めの原因を適用しない）・空 */
  rounding: { parsed: number; unreadable: number; empty: number };
  /** 拠点を対応付けた行・照合に使わない行 */
  mappedRows: number;
  excludedRows: number;
  /** 確定できない理由（空なら確定できる） */
  blockers: string[];
}

export interface BaselinePreview {
  fileName: string;
  sha256: string;
  sheetName: string | null;
  headers: string[];
  /** 先頭 5 行（列の対応を選ぶための見本） */
  sampleRows: Array<Record<string, string>>;
  totalRows: number;
  warnings: string[];
  /** この検証に使った設定（既定値を出したときはそれ） */
  settings: BaselineImportSettings;
  /** 拠点コードの列の値（拠点コード・行数）。拠点コードの列が決まっていなければ空 */
  siteCodes: Array<{ code: string; rows: number }>;
  /** 必須の列が揃っていなければ null */
  validation: BaselineValidation | null;
}

function sha256Hex(buffer: Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function normalizeHeader(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_\-・()（）[\]]/g, '');
}

/** 見出しから列の対応の既定値を出す（同じ語の見出しだけ。曖昧なら選ばない） */
export function suggestBaselineMapping(
  headers: readonly string[],
): Partial<Record<BaselineMappingKey, string>> {
  const out: Partial<Record<BaselineMappingKey, string>> = {};
  const used = new Set<string>();
  for (const spec of BASELINE_FIELD_SPECS) {
    const aliases = new Set(spec.aliases.map(normalizeHeader));
    const hits = headers.filter((h) => !used.has(h) && aliases.has(normalizeHeader(h)));
    if (hits.length === 1) {
      out[spec.key] = hits[0]!;
      used.add(hits[0]!);
    }
  }
  return out;
}

function assertCanImport(ctx: AuthorizationContext): void {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.import.run');
  assertCan(ctx, 'enterprise.data.write');
}

/** 取込の可否（見出しの操作の disabledReason に使う。権限が無ければ理由の文） */
export function baselineImportPermissionReason(ctx: AuthorizationContext): string | null {
  try {
    assertCanImport(ctx);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : '既存の算定結果を取り込む権限がありません。';
  }
}

async function readTable(fileName: string, buffer: Uint8Array): Promise<ParsedTable> {
  if (!BASELINE_FILE_PATTERN.test(fileName)) {
    throw new ValidationError(
      `「${fileName}」は取り込めない形式です。CSV（.csv・.tsv・.txt）か Excel（.xlsx・.xlsm）を選んでください。`,
    );
  }
  if (buffer.byteLength === 0) throw new ValidationError('ファイルが空です。');
  if (buffer.byteLength > BASELINE_IMPORT_MAX_BYTES) {
    throw new ValidationError(
      `ファイルが大きすぎます（上限 ${BASELINE_IMPORT_MAX_BYTES / 1024 / 1024}MB）。`,
    );
  }
  try {
    return /\.(xlsx|xlsm)$/i.test(fileName) ? await parseExcel(buffer) : parseCsv(buffer);
  } catch {
    throw new ValidationError(
      'ファイルを表として読めませんでした。形式（CSV・Excel）と中身を確かめてください。',
    );
  }
}

/** 期間（組織の期間だけ） */
async function periodOf(db: DbClient, ctx: AuthorizationContext, periodId: Uuid) {
  const period = isUuid(periodId) ? await db.findById('periods', periodId) : null;
  if (!period || period.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('報告期間が見つかりません。');
  }
  return period;
}

/** 対応付けに選べる拠点（組織の拠点。サプライヤーは除く） */
export async function listBaselineSiteChoices(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<OrganizationUnit[]> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.read');
  const units = await db.select('units', {
    where: { organizationId: ctx.workspace.organizationId, deletedAt: { isNull: true } },
    orderBy: [{ column: 'sortOrder' }, { column: 'code' }],
  });
  return units.filter((u) => u.unitType !== 'supplier');
}

function columnOk(headers: readonly string[], column: string | undefined): boolean {
  return column === undefined || headers.includes(column);
}

function rowLimitProblems(row: BaselineRow): string[] {
  const problems: string[] = [];
  for (const [key, max, label] of ROW_TEXT_LIMITS) {
    const value = row[key];
    if (typeof value === 'string' && value.length > max) {
      problems.push(`${label}が長すぎます（${max} 字まで）`);
    }
  }
  return problems;
}

interface Evaluated {
  validation: BaselineValidation | null;
  rows: BaselineRow[];
  unitMapping: Record<string, Uuid>;
  siteCodes: Array<{ code: string; rows: number }>;
}

/** 設定で読み、確定できるかを検証する（書き込まない） */
function evaluate(
  table: ParsedTable,
  settings: BaselineImportSettings,
  units: readonly OrganizationUnit[],
  ctx: AuthorizationContext,
  demo: boolean,
): Evaluated {
  const siteColumn = settings.mapping.siteCode;
  const siteCodes: Array<{ code: string; rows: number }> = [];
  if (siteColumn && table.headers.includes(siteColumn)) {
    const counts = new Map<string, number>();
    for (const raw of table.rows) {
      const code = (raw[siteColumn] ?? '').trim();
      if (code !== '') counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    for (const [code, rows] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
      siteCodes.push({ code, rows });
    }
  }
  const { siteCode, scope, emissions } = settings.mapping;
  if (!siteCode || !scope || !emissions) {
    return { validation: null, rows: [], unitMapping: {}, siteCodes };
  }
  const blockers: string[] = [];
  for (const spec of BASELINE_FIELD_SPECS) {
    if (!columnOk(table.headers, settings.mapping[spec.key])) {
      blockers.push(`「${spec.label}」に選んだ列がファイルにありません。`);
    }
  }
  const chosen = Object.values(settings.mapping).filter((c): c is string => !!c);
  if (new Set(chosen).size !== chosen.length) {
    blockers.push('同じ列を 2 つの項目に選んでいます。');
  }
  if (!settings.mapping.emissionsUnit) {
    if (!settings.defaultEmissionsUnit) {
      blockers.push('排出量の単位の列が無いときは、排出量の単位を選んでください（推測しません）。');
    } else if (parseUnit(settings.defaultEmissionsUnit)?.dimension !== 'emission') {
      blockers.push('排出量の単位が不正です。');
    }
  }

  // 拠点の対応付け（選ばれた拠点 ID は組織の拠点・担当拠点だけ）
  const unitById = new Map(units.map((u) => [u.id, u]));
  const unitMapping: Record<string, Uuid> = {};
  const unchosen: string[] = [];
  for (const { code } of siteCodes) {
    const value = settings.sites[code];
    if (!value) {
      unchosen.push(code);
      continue;
    }
    if (value === BASELINE_SITE_EXCLUDED) continue;
    const unit = unitById.get(value);
    if (!unit) {
      blockers.push(`拠点コード「${code}」に選んだ拠点が見つかりません。`);
      continue;
    }
    assertUnitInScope(ctx, unit.id);
    unitMapping[code] = unit.id;
  }
  if (unchosen.length > 0) {
    blockers.push(
      `拠点の対応付けを選んでいない拠点コードがあります（${unchosen.join('・')}）。拠点か「照合に使わない」を選んでください。`,
    );
  }

  const mapping: BaselineColumnMapping = { siteCode, scope, emissions };
  for (const spec of BASELINE_FIELD_SPECS) {
    const column = settings.mapping[spec.key];
    if (column) mapping[spec.key] = column;
  }
  if (settings.decimalSeparator) mapping.decimalSeparator = settings.decimalSeparator;
  const parsed = extractBaselineRows(table, mapping, unitMapping, {
    ...(settings.defaultEmissionsUnit
      ? { defaultEmissionsUnit: settings.defaultEmissionsUnit }
      : {}),
  });
  const errors = [...parsed.errors];
  const rows: BaselineRow[] = [];
  for (const row of parsed.rows) {
    const problems = rowLimitProblems(row);
    if (problems.length > 0) errors.push({ rowNo: row.rowNo, message: problems.join('。') });
    else rows.push(row);
  }
  errors.sort((a, b) => a.rowNo - b.rowNo);
  const maxRows = demo ? DEMO_GHG_LIMITS.baselineRows : BASELINE_MAX_ROWS;
  if (rows.length > maxRows) {
    blockers.push(
      demo
        ? `デモでは既存の算定結果は ${maxRows} 行までです（このファイルは ${rows.length} 行）。`
        : `行が多すぎます（上限 ${maxRows} 行）。`,
    );
  }
  if (errors.length > 0) {
    blockers.push(
      `読めない行が ${errors.length} 件あります。列の対応・小数点の記号・ファイルを直してください。`,
    );
  }
  if (rows.length === 0 && errors.length === 0) blockers.push('取り込める行がありません。');
  const mappedRows = rows.filter((r) => r.unitId !== null).length;
  if (rows.length > 0 && mappedRows === 0) {
    blockers.push('拠点に対応付けた行がありません（照合に使える行がありません）。');
  }
  const rounding = { parsed: 0, unreadable: 0, empty: 0 };
  for (const row of rows) {
    if (row.roundingNote === '') rounding.empty += 1;
    else if (row.rounding) rounding.parsed += 1;
    else rounding.unreadable += 1;
  }
  return {
    validation: {
      rowCount: rows.length,
      granularity: parsed.granularity,
      errorCount: errors.length,
      errors: errors.slice(0, 20),
      scopes: [...new Set(rows.map((r) => r.scope))],
      rounding,
      mappedRows,
      excludedRows: rows.length - mappedRows,
      blockers,
    },
    rows,
    unitMapping,
    siteCodes,
  };
}

export interface PreviewBaselineInput {
  periodId: Uuid;
  fileName: string;
  buffer: Uint8Array;
  /** 無ければ見出しから既定値を出す（最初にファイルを選んだとき） */
  settings?: BaselineImportSettings;
}

/** 取込の検証（読むだけ。書き込まない） */
export async function previewBaselineImport(
  db: DbClient,
  ctx: AuthorizationContext,
  input: PreviewBaselineInput,
): Promise<BaselinePreview> {
  assertCanImport(ctx);
  await periodOf(db, ctx, input.periodId);
  const table = await readTable(input.fileName, input.buffer);
  const settings: BaselineImportSettings = input.settings ?? {
    mapping: suggestBaselineMapping(table.headers),
    decimalSeparator: null,
    defaultEmissionsUnit: null,
    sites: {},
  };
  const units = await listBaselineSiteChoices(db, ctx);
  const evaluated = evaluate(table, settings, units, ctx, db.mode === 'demo');
  return {
    fileName: input.fileName,
    sha256: sha256Hex(input.buffer),
    sheetName: table.sheetName,
    headers: table.headers,
    sampleRows: table.rows.slice(0, 5),
    totalRows: table.rows.length,
    warnings: table.warnings,
    settings,
    siteCodes: evaluated.siteCodes,
    validation: evaluated.validation,
  };
}

export interface ConfirmBaselineInput {
  periodId: Uuid;
  fileName: string;
  buffer: Uint8Array;
  settings: BaselineImportSettings;
  label: string;
  /** 検証したファイルの sha256（送り直したファイルが同じかを確かめる） */
  expectedSha256: string;
  supersedesId?: Uuid | null;
}

/** 既存の算定結果を確定する（追記専用の行を 1 つ作る） */
export async function confirmBaselineImport(
  db: DbClient,
  ctx: AuthorizationContext,
  input: ConfirmBaselineInput,
): Promise<GhgBaselineResult> {
  assertCanImport(ctx);
  const period = await periodOf(db, ctx, input.periodId);
  const label = input.label.trim();
  if (label === '') throw new ValidationError('既存の算定結果の名前を入れてください。');
  if (label.length > LABEL_MAX) {
    throw new ValidationError(`既存の算定結果の名前は ${LABEL_MAX} 字までです。`);
  }
  const fileName = input.fileName.replace(/^.*[\\/]/, '').slice(0, FILE_NAME_MAX);
  const sha256 = sha256Hex(input.buffer);
  if (sha256 !== input.expectedSha256) {
    throw new ValidationError(
      '検証したファイルと内容が違います。もう一度ファイルを選んで検証してから確定してください。',
    );
  }
  const table = await readTable(fileName, input.buffer);
  const units = await listBaselineSiteChoices(db, ctx);
  const evaluated = evaluate(table, input.settings, units, ctx, db.mode === 'demo');
  if (!evaluated.validation) {
    throw new ValidationError('拠点コード・区分・排出量の列を選んでください。');
  }
  if (evaluated.validation.blockers.length > 0) {
    throw new ValidationError(evaluated.validation.blockers.join(' '));
  }
  const organizationId = ctx.workspace.organizationId;
  let supersedesId: Uuid | null = null;
  if (input.supersedesId) {
    const previous = isUuid(input.supersedesId)
      ? await db.findById('ghgBaselineResults', input.supersedesId)
      : null;
    if (!previous || previous.organizationId !== organizationId) {
      throw new NotFoundError('差し替える既存の算定結果が見つかりません。');
    }
    if (previous.reportingPeriodId !== period.id) {
      throw new ValidationError('差し替えられるのは同じ期間の既存の算定結果だけです。');
    }
    supersedesId = previous.id;
  }
  if (db.mode === 'demo') {
    const existing = await db.select('ghgBaselineResults', { where: { organizationId } });
    const own = existing.filter((b) => !GHG_FIXTURE_ROW_IDS.has(b.id));
    if (own.length >= DEMO_GHG_LIMITS.userBaselines) {
      throw new ValidationError(
        `デモでは既存の算定結果は ${DEMO_GHG_LIMITS.userBaselines} 件まで取り込めます。開示デモを初期状態に戻してから取り込んでください。`,
      );
    }
  }
  const rows = evaluated.rows;
  const row: GhgBaselineResult = {
    id: randomUUID(),
    organizationId,
    reportingPeriodId: period.id,
    label,
    fileName,
    fileSha256: sha256,
    granularity: evaluated.validation.granularity,
    rows,
    unitMapping: evaluated.unitMapping,
    rowCount: rows.length,
    supersedesId,
    createdAt: new Date().toISOString(),
    createdBy: ctx.userId,
  };
  const [inserted] = await db.insert('ghgBaselineResults', [row]);
  await recordAuditEvent(db, ctx, {
    eventType: 'import_committed',
    resourceType: 'ghg_baseline_result',
    resourceId: row.id,
    afterSummary: `既存の算定結果「${label}」を取込（${period.label}・${rows.length} 行・${BASELINE_GRANULARITY_LABELS[row.granularity]}）`,
    metadata: {
      periodId: period.id,
      fileSha256: sha256,
      granularity: row.granularity,
      unitMapping: row.unitMapping,
      supersedesId,
    },
  });
  return inserted ?? row;
}

/** 期間の既存の算定結果（新しい順） */
export async function listBaselines(
  db: DbClient,
  ctx: AuthorizationContext,
  options: { periodId: Uuid },
): Promise<GhgBaselineResult[]> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.read');
  return db.select('ghgBaselineResults', {
    where: { organizationId: ctx.workspace.organizationId, reportingPeriodId: options.periodId },
    orderBy: [
      { column: 'createdAt', dir: 'desc' },
      { column: 'id', dir: 'desc' },
    ],
  });
}

/** FormData の値から取込の設定を読む（Server Action から使う。検査は evaluate が行う） */
export function baselineSettingsFromForm(formData: FormData): BaselineImportSettings {
  const mapping: Partial<Record<BaselineMappingKey, string>> = {};
  for (const spec of BASELINE_FIELD_SPECS) {
    const value = String(formData.get(`map:${spec.key}`) ?? '').trim();
    if (value !== '') mapping[spec.key] = value;
  }
  const separator = String(formData.get('decimalSeparator') ?? '');
  const unit = String(formData.get('defaultEmissionsUnit') ?? '').trim();
  const sites: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith('site:') || typeof value !== 'string' || value === '') continue;
    sites[key.slice('site:'.length)] = value;
  }
  return {
    mapping,
    decimalSeparator: (DECIMAL_SEPARATORS as readonly string[]).includes(separator)
      ? (separator as DecimalSeparator)
      : null,
    defaultEmissionsUnit: (BASELINE_EMISSION_UNITS as readonly string[]).includes(unit)
      ? unit
      : null,
    sites,
  };
}
