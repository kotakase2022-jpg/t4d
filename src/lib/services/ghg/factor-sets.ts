import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, assertEnterpriseWorkspace, NotFoundError } from '@/lib/authorization/can';
import { canonicalJson } from '@/lib/domain/disclosure-block';
import {
  extractFactorRows,
  FACTOR_IMPORT_FIELDS,
  suggestFactorMapping,
  type FactorColumnMapping,
  type FactorImportResult,
} from '@/lib/domain/ghg/factor-import';
import { DECIMAL_SEPARATORS, type DecimalSeparator } from '@/lib/domain/ghg/number-format';
import { ValidationError } from '@/lib/errors/user-facing';
import { isUuid } from '@/lib/validation/uuid';
import { parseCsv, parseExcel } from '@/lib/imports/parsers';
import { DEMO_GHG_LIMITS, GHG_FIXTURE_ROW_IDS } from '@/lib/repositories/demo-ghg-checks';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  EmissionFactor,
  EmissionFactorAssignment,
  EmissionFactorSet,
  FactorActivityKind,
  FactorSetOrigin,
  IsoDate,
  Uuid,
} from '@/types/domain';

/**
 * 排出係数のセット（plan §2.3 factor-sets.ts・CR-01・CR-16。S1）。
 *
 *  - 閲覧は enterprise.data.read。取込・有効化・取り下げは enterprise.metric.manage（plan K1）
 *  - 取込はプレビュー → 確定。プレビューの結果はサーバーに残さない（Cookie もメモリも使わない）。確定のときに
 *    クライアントが同じファイルと列の対応を送り直し、サーバーがもう一度検証する。本番（Demo）は要求ごとに別の
 *    インスタンスになりうるため（plan §2.7）。プレビューの指紋（ファイルの sha256・列の対応・小数点の記号・
 *    基準年・出典）が違えば確定しない（見た内容と違うものを書かない）
 *  - 取り込んだセットは下書き。有効にすると係数は変えられない（DB のトリガ・RLS と同じ規則。新しいセットを作る）。
 *    有効にしたセットは取り下げられる（割当は残るが、算定は「セットが有効ではありません」のエラーにして黙って
 *    別の係数を使わない。plan K6）
 *  - 利用者が作るセットの出所は「組織指定」か「公的参照」。「架空（デモ）」は Fixture だけ（plan K13）
 * 監査ログは既存の種類（係数の保存・有効化・取り下げ＝settings_changed）。
 */

/** 利用者が選べる出所（架空〔デモ〕は Fixture だけ） */
export const USER_FACTOR_SET_ORIGINS = [
  'customer_specified',
  'public_reference',
] as const satisfies readonly FactorSetOrigin[];
export type UserFactorSetOrigin = (typeof USER_FACTOR_SET_ORIGINS)[number];

/** 取り込めるファイル（PDF は表を読めないため対象外） */
export const FACTOR_IMPORT_EXTENSIONS = /\.(csv|tsv|txt|xlsx|xlsm)$/i;
/** 1 ファイルの大きさの上限 */
export const FACTOR_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

export interface FactorSetListEntry {
  set: EmissionFactorSet;
  factorCount: number;
  kindCounts: Partial<Record<FactorActivityKind, number>>;
  /** 期間の割当のうち、このセットの係数を使っているもの */
  assignmentCount: number;
}

function assertReader(ctx: AuthorizationContext): void {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.read');
}

function assertManager(ctx: AuthorizationContext): void {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.metric.manage');
}

async function profileNames(
  db: DbClient,
  ids: ReadonlyArray<Uuid | null | undefined>,
): Promise<Map<Uuid, string>> {
  const unique = [...new Set(ids.filter((id): id is Uuid => !!id))];
  if (unique.length === 0) return new Map();
  const rows = await db.select('profiles', { where: { id: { in: unique } } });
  return new Map(rows.map((p) => [p.id, p.displayName]));
}

const STATUS_ORDER: Record<EmissionFactorSet['status'], number> = {
  draft: 0,
  active: 1,
  retired: 2,
};

/** 組織の係数のセット（下書き → 有効 → 取り下げの順、同じ状態はコード順） */
export async function listFactorSets(
  db: DbClient,
  ctx: AuthorizationContext,
  options: { periodId?: Uuid | null } = {},
): Promise<FactorSetListEntry[]> {
  assertReader(ctx);
  const organizationId = ctx.workspace.organizationId;
  const [sets, factors, assignments] = await Promise.all([
    db.select('emissionFactorSets', { where: { organizationId } }),
    db.select('emissionFactors', { where: { organizationId, factorSetId: { isNull: false } } }),
    options.periodId
      ? db.select('emissionFactorAssignments', {
          where: { organizationId, reportingPeriodId: options.periodId },
        })
      : Promise.resolve([] as EmissionFactorAssignment[]),
  ]);
  const setOfFactor = new Map(factors.map((f) => [f.id, f.factorSetId]));
  return sets
    .map((set) => {
      const own = factors.filter((f) => f.factorSetId === set.id);
      const kindCounts: Partial<Record<FactorActivityKind, number>> = {};
      for (const f of own) {
        if (f.activityKind) kindCounts[f.activityKind] = (kindCounts[f.activityKind] ?? 0) + 1;
      }
      return {
        set,
        factorCount: own.length,
        kindCounts,
        assignmentCount: assignments.filter((a) => setOfFactor.get(a.factorId) === set.id).length,
      };
    })
    .sort(
      (a, b) =>
        STATUS_ORDER[a.set.status] - STATUS_ORDER[b.set.status] ||
        a.set.code.localeCompare(b.set.code),
    );
}

export interface FactorSetDetail {
  set: EmissionFactorSet;
  factors: EmissionFactor[];
  /** このセットの係数を使っている割当（全期間） */
  assignments: EmissionFactorAssignment[];
  /** 期間の名前（割当の表示用） */
  periodLabels: Map<Uuid, string>;
  /** 拠点の名前（割当の表示用） */
  unitNames: Map<Uuid, string>;
  /** 作成者・有効にした人・取り下げた人の名前 */
  names: Map<Uuid, string>;
}

export async function loadFactorSet(
  db: DbClient,
  ctx: AuthorizationContext,
  setId: Uuid,
): Promise<FactorSetDetail> {
  assertReader(ctx);
  const organizationId = ctx.workspace.organizationId;
  // UUID でない ID は DB に問い合わせない（Supabase Mode では 22P02 の例外＝500 になるため。見つからない扱い）
  if (!isUuid(setId)) throw new NotFoundError('係数のセットが見つかりません。');
  const set = await db.findById('emissionFactorSets', setId);
  if (!set || set.organizationId !== organizationId) {
    throw new NotFoundError('係数のセットが見つかりません。');
  }
  const factors = (
    await db.select('emissionFactors', { where: { organizationId, factorSetId: set.id } })
  ).sort(
    (a, b) =>
      (a.activityKind ?? '').localeCompare(b.activityKind ?? '') ||
      a.code.localeCompare(b.code) ||
      a.factorYear - b.factorYear,
  );
  const factorIds = factors.map((f) => f.id);
  const [assignments, periods, units] = await Promise.all([
    factorIds.length > 0
      ? db.select('emissionFactorAssignments', {
          where: { organizationId, factorId: { in: factorIds } },
        })
      : Promise.resolve([] as EmissionFactorAssignment[]),
    db.select('periods', { where: { organizationId } }),
    db.select('units', { where: { organizationId } }),
  ]);
  const names = await profileNames(db, [set.createdBy, set.activatedBy, set.retiredBy]);
  return {
    set,
    factors,
    assignments,
    periodLabels: new Map(periods.map((p) => [p.id, p.label])),
    unitNames: new Map(units.map((u) => [u.id, u.name])),
    names,
  };
}

// ----------------------------------------------------------------------
// 取込（プレビュー → 確定）
// ----------------------------------------------------------------------

export interface FactorSetMetaInput {
  code: string;
  name: string;
  origin: string;
  sourceLabel: string;
  versionLabel: string;
  publishedOn: string;
  referenceYear: string;
  notes: string;
}

export interface FactorSetMeta {
  code: string;
  name: string;
  origin: UserFactorSetOrigin;
  sourceLabel: string;
  versionLabel: string;
  publishedOn: IsoDate | null;
  referenceYear: number | null;
  notes: string;
}

function textLimit(db: DbClient, demo: number, real: number): number {
  return db.mode === 'demo' ? demo : real;
}

/** セットの見出しの検査（コード・名称・出所・出典・版は必須） */
export function validateFactorSetMeta(db: DbClient, input: FactorSetMetaInput): FactorSetMeta {
  const code = input.code.normalize('NFKC').trim();
  const name = input.name.trim();
  const sourceLabel = input.sourceLabel.trim();
  const versionLabel = input.versionLabel.trim();
  const notes = input.notes.trim();
  if (code === '') throw new ValidationError('セットのコードを入力してください。');
  if (code.length > 40) throw new ValidationError('セットのコードは 40 文字までです。');
  if (/\s/.test(code)) throw new ValidationError('セットのコードに空白は使えません。');
  if (name === '') throw new ValidationError('セットの名称を入力してください。');
  if (name.length > 200) throw new ValidationError('セットの名称は 200 文字までです。');
  if (!(USER_FACTOR_SET_ORIGINS as readonly string[]).includes(input.origin)) {
    throw new ValidationError('出所は「組織指定」か「公的参照」を選んでください。');
  }
  if (sourceLabel === '')
    throw new ValidationError('出典を入力してください（誰が・何の資料で定めた係数か）。');
  const sourceMax = textLimit(db, 300, 500);
  if (sourceLabel.length > sourceMax)
    throw new ValidationError(`出典は ${sourceMax} 文字までです。`);
  if (versionLabel === '') throw new ValidationError('版を入力してください（例 2025 年版）。');
  if (versionLabel.length > 100) throw new ValidationError('版は 100 文字までです。');
  const notesMax = textLimit(db, 300, 2000);
  if (notes.length > notesMax) throw new ValidationError(`メモは ${notesMax} 文字までです。`);
  const published = input.publishedOn.trim();
  if (published !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(published)) {
    throw new ValidationError('公表日は YYYY-MM-DD の形で入力してください。');
  }
  const yearText = input.referenceYear.trim();
  let referenceYear: number | null = null;
  if (yearText !== '') {
    const year = Number(yearText);
    if (!Number.isInteger(year) || year < 1990 || year > 2100) {
      throw new ValidationError('基準年は 1990〜2100 の年で入力してください。');
    }
    referenceYear = year;
  }
  return {
    code,
    name,
    origin: input.origin as UserFactorSetOrigin,
    sourceLabel,
    versionLabel,
    publishedOn: published === '' ? null : published,
    referenceYear,
    notes,
  };
}

export interface FactorFileInput {
  fileName: string;
  bytes: Uint8Array;
  /** 利用者が選んだ列の対応（null は見出しから作った候補を使う＝初回の読み取り） */
  mapping: FactorColumnMapping | null;
  decimalSeparator: DecimalSeparator | null;
  /** 年度の列・適用開始が無い行に使う年度（セットの基準年） */
  referenceYear: number | null;
  /** 出典の列が無い行に使う出典（セットの出典） */
  sourceLabel: string;
}

export interface FactorSetImportPreview {
  fileName: string;
  sha256: string;
  headers: string[];
  /** 読み飛ばした前置き行・別シートなど（エラーではない） */
  sheetNotes: string[];
  mapping: FactorColumnMapping;
  /** 対応付けは見出しから作った候補か（まだ利用者が選んでいない） */
  mappingSuggested: boolean;
  decimalSeparator: DecimalSeparator | null;
  result: FactorImportResult;
  /** 確定のときに同じ内容かを確かめる指紋 */
  previewToken: string;
}

/** 送られた列の対応を、知っている項目だけに絞る */
export function sanitizeMapping(raw: Record<string, string>): FactorColumnMapping {
  const mapping: FactorColumnMapping = {};
  for (const field of FACTOR_IMPORT_FIELDS) {
    const value = raw[field];
    if (typeof value === 'string' && value !== '') mapping[field] = value;
  }
  return mapping;
}

export function parseDecimalSeparator(raw: string | null | undefined): DecimalSeparator | null {
  return (DECIMAL_SEPARATORS as readonly string[]).includes(raw ?? '')
    ? (raw as DecimalSeparator)
    : null;
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readTable(fileName: string, bytes: Uint8Array) {
  if (!FACTOR_IMPORT_EXTENSIONS.test(fileName)) {
    throw new ValidationError(
      `「${fileName}」は読めない形式です。CSV（.csv・.tsv・.txt）か Excel（.xlsx・.xlsm）を選んでください。`,
    );
  }
  if (bytes.byteLength === 0) throw new ValidationError('ファイルが空です。');
  if (bytes.byteLength > FACTOR_IMPORT_MAX_BYTES) {
    throw new ValidationError('ファイルは 5MB までです。');
  }
  if (/\.(xlsx|xlsm)$/i.test(fileName)) {
    try {
      return await parseExcel(bytes);
    } catch {
      throw new ValidationError(`「${fileName}」を Excel として読めませんでした。`);
    }
  }
  return parseCsv(bytes);
}

function previewTokenOf(
  sha256: string,
  mapping: FactorColumnMapping,
  input: Pick<FactorFileInput, 'decimalSeparator' | 'referenceYear' | 'sourceLabel'>,
): string {
  return sha256Hex(
    canonicalJson({
      sha256,
      mapping,
      decimalSeparator: input.decimalSeparator,
      referenceYear: input.referenceYear,
      sourceLabel: input.sourceLabel,
    }),
  ).slice(0, 32);
}

async function inspect(db: DbClient, input: FactorFileInput): Promise<FactorSetImportPreview> {
  const parsed = await readTable(input.fileName, input.bytes);
  const headers = parsed.headers.filter((h) => h.trim() !== '');
  if (headers.length === 0) throw new ValidationError('見出しの行を読めませんでした。');
  const mapping = input.mapping ?? suggestFactorMapping(headers);
  const result = extractFactorRows(
    { headers, rows: parsed.rows, rowNumbers: parsed.rowNumbers },
    mapping,
    {
      decimalSeparator: input.decimalSeparator,
      defaultYear: input.referenceYear,
      defaultSource: input.sourceLabel,
    },
  );
  if (db.mode === 'demo') {
    // Demo の上限（Cookie の容量。サービスの検査と Cookie から戻すときの検査は同じ値）
    if (result.factors.length > DEMO_GHG_LIMITS.factorsPerSet) {
      result.errors.push({
        line: null,
        message: `デモでは 1 つのセットの係数は ${DEMO_GHG_LIMITS.factorsPerSet} 件までです（${result.factors.length} 件）。`,
      });
    }
    for (const f of result.factors) {
      if (JSON.stringify(f.params).length > DEMO_GHG_LIMITS.factorParamsChars) {
        result.errors.push({
          line: f.lines[0] ?? null,
          message: `デモでは係数「${f.code}」の改良トンキロ法の表が大きすぎます（行を減らしてください）。`,
        });
      }
    }
  }
  const sha256 = sha256Hex(input.bytes);
  return {
    fileName: input.fileName,
    sha256,
    headers,
    sheetNotes: parsed.warnings,
    mapping,
    mappingSuggested: input.mapping === null,
    decimalSeparator: input.decimalSeparator,
    result,
    previewToken: previewTokenOf(sha256, mapping, input),
  };
}

/** 取込の検証（書き込みなし）。初回は見出しから列の対応の候補を作る */
export async function previewFactorSetImport(
  db: DbClient,
  ctx: AuthorizationContext,
  input: FactorFileInput,
): Promise<FactorSetImportPreview> {
  assertManager(ctx);
  return inspect(db, input);
}

export interface ConfirmFactorSetInput extends FactorFileInput {
  meta: FactorSetMetaInput;
  /** プレビューで返した指紋（見た内容と同じものだけを書く） */
  previewToken: string;
}

/** 取込の確定（下書きのセットと係数を書く） */
export async function confirmFactorSetImport(
  db: DbClient,
  ctx: AuthorizationContext,
  input: ConfirmFactorSetInput,
): Promise<{ set: EmissionFactorSet; factors: EmissionFactor[] }> {
  assertManager(ctx);
  if (!input.mapping) throw new ValidationError('列の対応を選んでから確定してください。');
  const meta = validateFactorSetMeta(db, input.meta);
  const organizationId = ctx.workspace.organizationId;
  const preview = await inspect(db, {
    ...input,
    referenceYear: meta.referenceYear,
    sourceLabel: meta.sourceLabel,
  });
  if (preview.previewToken !== input.previewToken) {
    throw new ValidationError(
      '検証した内容（ファイル・列の対応・小数点の記号・基準年・出典）と違います。もう一度検証してから確定してください。',
    );
  }
  if (preview.result.errors.length > 0) {
    throw new ValidationError(
      `検証のエラーが ${preview.result.errors.length} 件あります。直してから確定してください。`,
    );
  }
  if (preview.result.factors.length === 0) throw new ValidationError('係数の行がありません。');

  const sets = await db.select('emissionFactorSets', { where: { organizationId } });
  if (sets.some((s) => s.code === meta.code)) {
    throw new ValidationError(
      `セットのコード「${meta.code}」は既にあります。別のコードにしてください。`,
    );
  }
  if (db.mode === 'demo') {
    const own = sets.filter((s) => !GHG_FIXTURE_ROW_IDS.has(s.id));
    if (own.length >= DEMO_GHG_LIMITS.userFactorSets) {
      throw new ValidationError(
        `デモでは取り込める係数のセットは ${DEMO_GHG_LIMITS.userFactorSets} つまでです。開示デモを初期状態に戻してから取り込んでください。`,
      );
    }
  }

  const now = new Date().toISOString();
  const set: EmissionFactorSet = {
    id: randomUUID(),
    organizationId,
    code: meta.code,
    name: meta.name,
    origin: meta.origin,
    sourceLabel: meta.sourceLabel,
    versionLabel: meta.versionLabel,
    publishedOn: meta.publishedOn,
    referenceYear: meta.referenceYear,
    status: 'draft',
    activatedBy: null,
    activatedAt: null,
    retiredBy: null,
    retiredAt: null,
    notes: meta.notes,
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  };
  const [insertedSet] = await db.insert('emissionFactorSets', [set]);
  const factors: EmissionFactor[] = preview.result.factors.map(({ lines: _lines, ...f }) => ({
    ...f,
    id: randomUUID(),
    organizationId,
    factorSetId: set.id,
    createdAt: now,
  }));
  const inserted = await db.insert('emissionFactors', factors);
  await recordAuditEvent(db, ctx, {
    eventType: 'settings_changed',
    resourceType: 'emission_factor_set',
    resourceId: set.id,
    afterSummary: `係数のセット「${set.name}」（${set.code}・${set.versionLabel}）を下書きとして取り込み（係数 ${factors.length} 件・${input.fileName}）`,
    metadata: {
      origin: set.origin,
      fileName: input.fileName,
      fileSha256: preview.sha256,
      factorCount: factors.length,
    },
  });
  return { set: insertedSet ?? set, factors: inserted };
}

async function loadOwnSet(
  db: DbClient,
  ctx: AuthorizationContext,
  setId: Uuid,
): Promise<EmissionFactorSet> {
  // UUID でない ID は DB に問い合わせない（Supabase Mode では 22P02 の例外＝500 になるため。見つからない扱い）
  if (!isUuid(setId)) throw new NotFoundError('係数のセットが見つかりません。');
  const set = await db.findById('emissionFactorSets', setId);
  if (!set || set.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('係数のセットが見つかりません。');
  }
  return set;
}

/** 有効にする（下書きのときだけ。有効にした後は係数を変えられない） */
export async function activateFactorSet(
  db: DbClient,
  ctx: AuthorizationContext,
  setId: Uuid,
): Promise<EmissionFactorSet> {
  assertManager(ctx);
  const set = await loadOwnSet(db, ctx, setId);
  if (set.status !== 'draft') {
    throw new ValidationError('有効にできるのは下書きのセットだけです。');
  }
  const factors = await db.select('emissionFactors', {
    where: { organizationId: set.organizationId, factorSetId: set.id },
  });
  if (factors.length === 0) throw new ValidationError('係数の無いセットは有効にできません。');
  const now = new Date().toISOString();
  const updated = await db.update('emissionFactorSets', set.id, {
    status: 'active',
    activatedBy: ctx.userId,
    activatedAt: now,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'settings_changed',
    resourceType: 'emission_factor_set',
    resourceId: set.id,
    beforeSummary: '下書き',
    afterSummary: `係数のセット「${set.name}」（${set.code}）を有効にした（係数 ${factors.length} 件。以後は変更できない）`,
    metadata: { factorCount: factors.length },
  });
  return updated;
}

/**
 * 取り下げる（有効なセットだけ）。割当は残る（記録の再現のため消さない）が、算定はこのセットの係数を
 * 「有効ではない」としてエラーにする（黙って別の係数を使わない）
 */
export async function retireFactorSet(
  db: DbClient,
  ctx: AuthorizationContext,
  setId: Uuid,
  options: { reason: string },
): Promise<EmissionFactorSet> {
  assertManager(ctx);
  const set = await loadOwnSet(db, ctx, setId);
  if (set.status !== 'active') {
    throw new ValidationError('取り下げられるのは有効なセットだけです。');
  }
  const reason = options.reason.trim();
  if (reason.length > 300) throw new ValidationError('取り下げの理由は 300 文字までです。');
  const now = new Date().toISOString();
  const updated = await db.update('emissionFactorSets', set.id, {
    status: 'retired',
    retiredBy: ctx.userId,
    retiredAt: now,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'settings_changed',
    resourceType: 'emission_factor_set',
    resourceId: set.id,
    beforeSummary: '有効',
    afterSummary: `係数のセット「${set.name}」（${set.code}）を取り下げた${reason ? `（理由: ${reason}）` : ''}`,
    metadata: { reason: reason || null },
  });
  return updated;
}
