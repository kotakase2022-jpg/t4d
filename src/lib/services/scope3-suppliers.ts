import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, assertUnitInScope } from '@/lib/authorization/can';
import {
  matchSupplierByLabel,
  SCOPE3_FORMULA,
  supplierInputLabel,
} from '@/lib/domain/scope3-labels';
import { ValidationError } from '@/lib/errors/user-facing';
import { contentHash, fid } from '@/lib/fixtures/ids';
import { decodeText, detectDelimiter, detectHeaderRow, parseCsvText } from '@/lib/imports/parsers';
import { parseFlexibleNumber } from '@/lib/imports/number';
import { classifyRowRoles } from '@/lib/imports/row-role';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  CalculationInput,
  DataPoint,
  DataPointCalculation,
  EmissionFactor,
  MetricDefinition,
  OrganizationUnit,
  Uuid,
} from '@/types/domain';

/**
 * Scope3 Category 1 のサプライヤーデータ（一次データ）。
 *
 * 受け付ける素データは 3 種類:
 *  - 排出量データ（emissions）: サプライヤーが算定した t-CO2e。係数は不要
 *  - 物理データ（physical）: kWh・m3・L・kg などの活動量 × 物理量ベース原単位
 *  - 金額データ（monetary）: 購買金額（千円） × 金額ベース原単位
 *
 * 種別の判定（自動仕訳）・列の割り当て・原単位の解決はすべて規則ベース。
 * AI 判定にしないのは、どの行をなぜその種別・係数で取り込んだかを
 * 監査法人へそのまま再現して説明するため（imports/row-role.ts と同じ方針）。
 *
 * 算定根拠は `data_point_calculations`（追記専用）へ版として積む。
 * サプライヤーの識別は CalculationInput.label の
 * 「<コード> <サプライヤー名> / <品目>」規約（domain/scope3-labels.ts）で行い、
 * 金額・物理量の行は活動量を activityAmount / activityUnit に構造化して持つ
 * （排出量原単位の再紐づけで value を再計算するため）。
 */

export const SCOPE3_METRIC_CODE = 'scope3_cat1';

export type SupplierDataType = 'emissions' | 'physical' | 'monetary';

export const SUPPLIER_DATA_TYPE_LABELS: Record<SupplierDataType, string> = {
  emissions: '排出量データ',
  physical: '物理データ',
  monetary: '金額データ',
};

// ----------------------------------------------------------------------
// 単位の正規化
// ----------------------------------------------------------------------

interface NormalizedUnit {
  kind: 'emissions' | 'monetary' | 'physical';
  /** 正規化後の単位（monetary は常に 千円） */
  unit: string;
  /** 正規化後の単位へ揃えるための倍率（例: 円 → 千円 は 0.001） */
  multiplier: number;
}

/** 単位表記のゆらぎを吸収する（NFKC + 小文字化した表記 → 正規形） */
function normalizeUnit(raw: string): NormalizedUnit | null {
  const v = raw.normalize('NFKC').trim().toLowerCase();
  if (v === '') return null;
  // 排出量
  if (/^t-?co2e?$/.test(v)) return { kind: 'emissions', unit: 't-CO2e', multiplier: 1 };
  if (/^kg-?co2e?$/.test(v)) return { kind: 'emissions', unit: 't-CO2e', multiplier: 0.001 };
  // 金額（円建てのみ。外貨は換算根拠を持てないため受け付けない）
  if (v === '千円' || v === 'kjpy' || v === 'k jpy' || v === 'jpy k' || v === 'thousand jpy') {
    return { kind: 'monetary', unit: '千円', multiplier: 1 };
  }
  if (v === '円' || v === 'jpy') return { kind: 'monetary', unit: '千円', multiplier: 0.001 };
  if (v === '百万円') return { kind: 'monetary', unit: '千円', multiplier: 1000 };
  // 物理量
  if (v === 'kwh') return { kind: 'physical', unit: 'kWh', multiplier: 1 };
  if (v === 'mwh') return { kind: 'physical', unit: 'kWh', multiplier: 1000 };
  if (v === 'm3' || v === '㎥' || v === 'm³' || v === 'nm3') {
    return { kind: 'physical', unit: 'm3', multiplier: 1 };
  }
  if (v === 'l' || v === 'ℓ' || v === 'リットル')
    return { kind: 'physical', unit: 'L', multiplier: 1 };
  if (v === 'kl') return { kind: 'physical', unit: 'L', multiplier: 1000 };
  if (v === 'kg') return { kind: 'physical', unit: 'kg', multiplier: 1 };
  if (v === 't' || v === 'トン') return { kind: 'physical', unit: 't', multiplier: 1 };
  return null;
}

const SUPPORTED_UNITS_HINT =
  '対応単位: t-CO2e（排出量）／ 千円・円・百万円（金額）／ kWh・MWh・m3・L・kL・kg・t（物理量）';

// ----------------------------------------------------------------------
// CSV の解釈（純粋・決定論）
// ----------------------------------------------------------------------

export interface SupplierCsvRow {
  /** ヘッダーを除いた 1 始まりの行番号 */
  rowIndex: number;
  supplierCode: string;
  item: string;
  /** 自動仕訳した種別。判定できない行は null（errors に理由が入る） */
  dataType: SupplierDataType | null;
  amountRaw: string;
  /** 解釈・単位換算後の数値（monetary は 千円、physical は正規化単位） */
  amount: number | null;
  /** 正規化後の単位。判定できなければ null */
  unit: string | null;
  factorCode: string;
  /** 合計行・注記行として除外した理由。null なら取込候補 */
  skippedReason: string | null;
  errors: string[];
}

export interface SupplierCsvExtract {
  rows: SupplierCsvRow[];
  fileErrors: string[];
}

type ColumnRole =
  'factor' | 'supplier' | 'dtype' | 'emissions' | 'quantity' | 'amount' | 'value' | 'unit' | 'item';

/**
 * 列の役割判定。上から順に試し、1 列につき 1 役割・1 役割につき最初の 1 列。
 * 「排出係数コード」が排出量の列と誤認されないよう factor を最優先にする。
 */
const COLUMN_ROLE_RULES: Array<{ role: ColumnRole; match: RegExp }> = [
  { role: 'factor', match: /係数|原単位|factor/i },
  { role: 'supplier', match: /サプライヤ|供給|仕入|supplier|lieferant/i },
  { role: 'dtype', match: /データ種別|data\s*type|^種別$|^art$/i },
  { role: 'emissions', match: /排出量|emissions?|t-?co2/i },
  { role: 'quantity', match: /活動量|数量|使用量|quantity|menge|volume/i },
  { role: 'amount', match: /購買金額|金額|amount|spend|betrag/i },
  { role: 'value', match: /^数値$|^値$|^value$|wert/i },
  { role: 'unit', match: /単位|einheit|^unit$/i },
  { role: 'item', match: /品目|品名|item|position|内容|燃料種|fuel/i },
];

function classifyDataTypeCell(raw: string): SupplierDataType | 'unknown' | null {
  const v = raw.normalize('NFKC').trim().toLowerCase();
  if (v === '') return null;
  if (/排出|emission/.test(v)) return 'emissions';
  if (/物理|活動|activity|physical/.test(v)) return 'physical';
  if (/金額|購買|spend|monetary/.test(v)) return 'monetary';
  return 'unknown';
}

/**
 * サプライヤー一次データ CSV を列役割の規則で割り当て、行を種別へ自動仕訳する。
 * 前置き行（帳票名など）はヘッダー行の自動検出（detectHeaderRow）で読み飛ばす。
 * マスターとの突き合わせ（コード解決・原単位解決・排出量計算）は
 * previewSupplierImport が行う。
 */
export function extractSupplierCsvRows(text: string): SupplierCsvExtract {
  const table = parseCsvText(text, detectDelimiter(text)).filter((cells) =>
    cells.some((cell) => cell.trim() !== ''),
  );
  if (table.length === 0) {
    return { rows: [], fileErrors: ['データ行がありません。ヘッダー行と明細行を含めてください。'] };
  }

  const headerIndex = detectHeaderRow(table);
  const header = table[headerIndex] ?? [];

  const columnOfRole = new Map<ColumnRole, number>();
  const roleOfColumn = new Map<number, ColumnRole>();
  header.forEach((cell, index) => {
    const normalized = cell.normalize('NFKC').trim();
    if (normalized === '') return;
    for (const rule of COLUMN_ROLE_RULES) {
      if (!rule.match.test(normalized)) continue;
      // 同役割の 2 列目はその役割としては使わないが、後続の規則は試し続ける。
      // ここで打ち切ると「仕入先コード＋仕入金額(千円)」のような実在ヘッダーで
      // 金額列が /仕入/ に先取りされて消え、ファイルごと弾かれてしまう
      if (columnOfRole.has(rule.role)) continue;
      columnOfRole.set(rule.role, index);
      roleOfColumn.set(index, rule.role);
      break;
    }
  });

  const missing: string[] = [];
  if (!columnOfRole.has('supplier')) missing.push('サプライヤーコード');
  const hasValueColumn =
    columnOfRole.has('emissions') ||
    columnOfRole.has('quantity') ||
    columnOfRole.has('amount') ||
    columnOfRole.has('value');
  if (!hasValueColumn) missing.push('数値（排出量・数量・金額のいずれか）');
  if (missing.length > 0) {
    return {
      rows: [],
      fileErrors: [
        `必須列が見つかりません: ${missing.join(' / ')}（検出したヘッダー: ${header.join(', ')}）。テンプレート CSV の列名を参考にしてください。`,
      ],
    };
  }

  // 「購買金額(千円)」「Betrag (JPY k)」のようにヘッダー側が通貨単位を持つ場合の補完
  const amountHeader = (header[columnOfRole.get('amount') ?? -1] ?? '').normalize('NFKC');
  const amountHeaderMonetary = /千円|kjpy|jpy\s*k|thousand\s*jpy/i.test(amountHeader);

  const dataRows = table.slice(headerIndex + 1);
  // 合計行・注記行の除外は一般取込と同じ規則ベース判定を使う（二重計上の防止）
  const roles = classifyRowRoles(
    dataRows.map((cells) =>
      Object.fromEntries(cells.map((cell, i) => [header[i] ?? `col_${i}`, cell])),
    ),
  );

  const rows: SupplierCsvRow[] = dataRows.map((cells, index) => {
    const pick = (role: ColumnRole) => (cells[columnOfRole.get(role) ?? -1] ?? '').trim();
    const rowRole = roles[index] ?? 'detail';
    const errors: string[] = [];

    const explicitRaw = pick('dtype');
    const explicitCell = classifyDataTypeCell(explicitRaw);
    if (explicitCell === 'unknown') {
      errors.push(`データ種別「${explicitRaw}」を判定できません（排出量／物理量／金額）。`);
    }
    const explicit: SupplierDataType | null = explicitCell === 'unknown' ? null : explicitCell;

    const emissionsRaw = pick('emissions');
    const quantityRaw = pick('quantity');
    const amountRaw = pick('amount');
    const valueRaw = pick('value');
    const unitRaw = pick('unit');
    const unitSpec = unitRaw === '' ? null : normalizeUnit(unitRaw);
    if (unitRaw !== '' && unitSpec === null && rowRole === 'detail') {
      errors.push(`単位「${unitRaw}」は解釈できません。${SUPPORTED_UNITS_HINT}`);
    }

    let dataType: SupplierDataType | null = null;
    let raw: string;
    let amount: number | null;
    let unit: string | null;

    const treatAsEmissions = explicit === 'emissions' || (explicit === null && emissionsRaw !== '');
    if (treatAsEmissions) {
      dataType = 'emissions';
      raw = emissionsRaw !== '' ? emissionsRaw : valueRaw !== '' ? valueRaw : quantityRaw;
      const parsed = raw === '' ? null : parseFlexibleNumber(raw);
      if (unitSpec && unitSpec.kind !== 'emissions') {
        errors.push(`排出量データの単位は t-CO2e で入力してください（指定: ${unitRaw}）。`);
      }
      amount = parsed === null ? null : parsed * (unitSpec?.multiplier ?? 1);
      unit = 't-CO2e';
    } else {
      // 物理量・金額: 数量 → 金額 → 汎用数値 の順で値セルを拾う
      const source =
        quantityRaw !== ''
          ? { raw: quantityRaw, from: 'quantity' as const }
          : amountRaw !== ''
            ? { raw: amountRaw, from: 'amount' as const }
            : { raw: valueRaw, from: 'value' as const };
      raw = source.raw;
      const parsed = raw === '' ? null : parseFlexibleNumber(raw);

      let resolvedUnit = unitSpec;
      if (!resolvedUnit && source.from === 'amount' && amountHeaderMonetary) {
        resolvedUnit = { kind: 'monetary', unit: '千円', multiplier: 1 };
      }

      if (rowRole === 'detail' && raw !== '') {
        if (!resolvedUnit) {
          if (unitRaw === '') {
            errors.push(`単位が特定できません。単位列を追加してください。${SUPPORTED_UNITS_HINT}`);
          }
        } else if (resolvedUnit.kind === 'emissions') {
          dataType = 'emissions';
        } else {
          dataType = resolvedUnit.kind === 'monetary' ? 'monetary' : 'physical';
        }
        if (explicit && dataType && explicit !== dataType) {
          errors.push(
            `データ種別（${SUPPLIER_DATA_TYPE_LABELS[explicit]}）と単位「${resolvedUnit?.unit ?? unitRaw}」が矛盾しています。`,
          );
          dataType = null;
        } else if (explicit && !dataType) {
          dataType = explicit;
        }
      }

      amount = parsed === null ? null : parsed * (resolvedUnit?.multiplier ?? 1);
      unit = resolvedUnit?.unit ?? null;
      if (dataType === 'emissions') unit = 't-CO2e';
    }

    const supplierCode = pick('supplier');
    let item = pick('item');
    if (item === '' && dataType === 'emissions') item = '報告排出量';

    if (rowRole === 'detail') {
      if (supplierCode === '') errors.push('サプライヤーコードが空です。');
      if (item === '') errors.push('品目が空です。');
      if (raw === '' || amount === null) {
        errors.push(`数値「${raw}」を読み取れません。`);
      } else if (amount <= 0) {
        errors.push('数値は 0 より大きい値で入力してください。');
      }
      if (dataType === null && errors.length === 0) {
        errors.push(`データ種別を判定できません。${SUPPORTED_UNITS_HINT}`);
      }
    }

    return {
      rowIndex: index + 1,
      supplierCode,
      item,
      dataType,
      amountRaw: raw,
      amount,
      unit,
      factorCode: pick('factor').normalize('NFKC').toUpperCase(),
      skippedReason:
        rowRole === 'total'
          ? '合計行と判定したため取込対象外です（明細行と重複するため）。'
          : rowRole === 'note'
            ? '注記・フッター行と判定したため取込対象外です。'
            : null,
      errors,
    };
  });

  return { rows, fileErrors: [] };
}

// ----------------------------------------------------------------------
// プレビュー（マスターとの突き合わせ・原単位の解決）
// ----------------------------------------------------------------------

export interface FactorCandidate {
  id: Uuid;
  code: string;
  name: string;
  factorValue: number;
  factorUnit: string;
  factorYear: number;
}

export interface SupplierPreviewRow extends SupplierCsvRow {
  supplierUnitId: Uuid | null;
  supplierName: string | null;
  /** 解決済みの原単位（emissions 行と未解決の行は null） */
  factor: FactorCandidate | null;
  /** 原単位の決まり方: 行の係数コード ／ 過去実績からの学習 ／ 単位から一意 */
  factorResolution: 'row' | 'learned' | 'unit' | null;
  /** 単位は合うが複数候補があり、人の紐づけが要る行の選択肢 */
  factorCandidates: FactorCandidate[];
  needsFactorChoice: boolean;
  /** 購買金額 × 係数（0.1 t-CO2e 丸め）。emissions 行は報告値そのもの */
  emissions: number | null;
  /** この社は最新の算定内訳に既に載っており、確定すると置き換えになる */
  replacesExisting: boolean;
}

export interface SupplierImportPreview {
  fileName: string;
  encoding: string;
  rows: SupplierPreviewRow[];
  fileErrors: string[];
  /** エラーなし・除外なし・原単位選択も不要で、そのまま確定できる行数 */
  validCount: number;
  /** 原単位の紐づけ（選択）が必要な行数 */
  needsMappingCount: number;
}

function roundEmissions(value: number): number {
  return Math.round(value * 10) / 10;
}

function toCandidate(factor: EmissionFactor): FactorCandidate {
  return {
    id: factor.id,
    code: factor.code,
    name: factor.name,
    factorValue: factor.factorValue,
    factorUnit: factor.factorUnit,
    factorYear: factor.factorYear,
  };
}

async function loadSupplierMaster(db: DbClient, ctx: AuthorizationContext) {
  const organizationId = ctx.workspace.organizationId;
  const [units, factors] = await Promise.all([
    db.select('units', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('emissionFactors', { where: { organizationId }, orderBy: { column: 'code' } }),
  ]);
  const suppliers = units
    .filter((unit) => unit.unitType === 'supplier')
    .sort((a, b) => a.code.localeCompare(b.code));
  return { suppliers, factors };
}

function findSupplier(suppliers: OrganizationUnit[], codeOrName: string): OrganizationUnit | null {
  const normalized = codeOrName.normalize('NFKC').trim();
  return (
    suppliers.find((unit) => unit.code.toUpperCase() === normalized.toUpperCase()) ??
    suppliers.find((unit) => unit.name === normalized) ??
    null
  );
}

/** 最新の算定内訳に載っているサプライヤーのコード集合（ラベル規約で引き当てる） */
function submittedSupplierCodes(
  suppliers: OrganizationUnit[],
  inputs: readonly CalculationInput[],
): Set<string> {
  const codes = new Set<string>();
  for (const input of inputs) {
    const matched = matchSupplierByLabel(suppliers, input.label);
    if (matched) codes.add(matched.supplier.code);
  }
  return codes;
}

/**
 * 過去に確定した算定版から「このサプライヤー×品目（×単位）にはこの原単位」を学ぶ。
 * 新しい版を優先する。決定論（多数決や AI ではなく、最新の確定実績をそのまま使う）。
 */
function buildLearnedFactorIndex(
  calculations: readonly DataPointCalculation[],
  suppliers: OrganizationUnit[],
): Map<string, Uuid> {
  const learned = new Map<string, Uuid>();
  for (let i = calculations.length - 1; i >= 0; i -= 1) {
    for (const input of calculations[i]?.inputs ?? []) {
      if (!input.sourceId || !input.activityUnit) continue;
      const matched = matchSupplierByLabel(suppliers, input.label);
      if (!matched) continue;
      const itemKey = `${matched.supplier.code}|${matched.item}|${input.activityUnit}`;
      if (!learned.has(itemKey)) learned.set(itemKey, input.sourceId);
    }
  }
  return learned;
}

async function loadScope3Context(db: DbClient, ctx: AuthorizationContext, reportingPeriodId: Uuid) {
  const organizationId = ctx.workspace.organizationId;
  const metrics = await db.select('metrics', {
    where: { organizationId, code: SCOPE3_METRIC_CODE },
  });
  const metric = metrics[0] ?? null;

  let dataPoint: DataPoint | null = null;
  let calculations: DataPointCalculation[] = [];
  if (metric) {
    const dataPoints = await db.select('dataPoints', {
      where: { organizationId, metricId: metric.id, reportingPeriodId },
    });
    // 「内部取引」boundary は二重計上控除のための行なので、算定根拠の親にはしない
    dataPoint =
      dataPoints
        .filter((dp) => dp.boundary !== '内部取引')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
    if (dataPoint) {
      calculations = (
        await db.select('calculations', { where: { dataPointId: dataPoint.id } })
      ).sort((a, b) => a.calculatedAt.localeCompare(b.calculatedAt));
    }
  }
  return { metric, dataPoint, calculations, latest: calculations[calculations.length - 1] ?? null };
}

export async function previewSupplierImport(
  db: DbClient,
  ctx: AuthorizationContext,
  reportingPeriodId: Uuid,
  fileName: string,
  bytes: Uint8Array,
): Promise<SupplierImportPreview> {
  assertCan(ctx, 'enterprise.import.run');

  const decoded = decodeText(bytes);
  const extract = extractSupplierCsvRows(decoded.text);
  const fileErrors = [...extract.fileErrors];
  if (decoded.warning) fileErrors.push(decoded.warning);

  const [{ suppliers, factors }, scope3] = await Promise.all([
    loadSupplierMaster(db, ctx),
    loadScope3Context(db, ctx, reportingPeriodId),
  ]);
  const factorByCode = new Map(factors.map((f) => [f.code.toUpperCase(), f]));
  const factorById = new Map(factors.map((f) => [f.id, f]));
  const factorsByUnit = new Map<string, EmissionFactor[]>();
  for (const factor of factors) {
    const list = factorsByUnit.get(factor.activityUnit) ?? [];
    list.push(factor);
    factorsByUnit.set(factor.activityUnit, list);
  }
  const submittedCodes = submittedSupplierCodes(suppliers, scope3.latest?.inputs ?? []);
  const learned = buildLearnedFactorIndex(scope3.calculations, suppliers);

  const rows: SupplierPreviewRow[] = extract.rows.map((row) => {
    const errors = [...row.errors];
    const supplier = row.supplierCode === '' ? null : findSupplier(suppliers, row.supplierCode);
    if (row.skippedReason === null && row.supplierCode !== '' && !supplier) {
      errors.push(
        `サプライヤーコード「${row.supplierCode}」が組織・拠点（サプライヤー）に見つかりません。`,
      );
    }

    let factor: EmissionFactor | null = null;
    let factorResolution: SupplierPreviewRow['factorResolution'] = null;
    let factorCandidates: EmissionFactor[] = [];
    let needsFactorChoice = false;

    if (
      row.skippedReason === null &&
      (row.dataType === 'physical' || row.dataType === 'monetary') &&
      row.unit !== null
    ) {
      const rowUnit = row.unit;
      if (row.factorCode !== '') {
        const byCode = factorByCode.get(row.factorCode) ?? null;
        if (!byCode) {
          errors.push(`排出係数コード「${row.factorCode}」が排出係数マスターに見つかりません。`);
        } else if (byCode.activityUnit !== rowUnit) {
          errors.push(
            `排出係数コード「${row.factorCode}」の活動量単位（${byCode.activityUnit}）が行の単位（${rowUnit}）と一致しません。`,
          );
        } else {
          factor = byCode;
          factorResolution = 'row';
        }
      } else if (supplier) {
        const learnedId = learned.get(`${supplier.code}|${row.item}|${rowUnit}`);
        const learnedFactor = learnedId ? (factorById.get(learnedId) ?? null) : null;
        if (learnedFactor && learnedFactor.activityUnit === rowUnit) {
          factor = learnedFactor;
          factorResolution = 'learned';
        } else {
          const candidates = factorsByUnit.get(rowUnit) ?? [];
          if (candidates.length === 1) {
            factor = candidates[0] ?? null;
            factorResolution = 'unit';
          } else if (candidates.length === 0) {
            errors.push(
              `単位「${rowUnit}」に対応する排出量原単位がマスターにありません。原単位を登録するか、単位を見直してください。`,
            );
          } else {
            needsFactorChoice = true;
            factorCandidates = candidates;
          }
        }
      }
    }

    const emissions =
      row.skippedReason !== null || errors.length > 0 || row.amount === null
        ? null
        : row.dataType === 'emissions'
          ? roundEmissions(row.amount)
          : factor
            ? roundEmissions(row.amount * factor.factorValue)
            : null;

    return {
      ...row,
      errors,
      supplierUnitId: supplier?.id ?? null,
      supplierName: supplier?.name ?? null,
      factor: factor ? toCandidate(factor) : null,
      factorResolution,
      factorCandidates: factorCandidates.map(toCandidate),
      needsFactorChoice,
      emissions,
      replacesExisting: supplier ? submittedCodes.has(supplier.code) : false,
    };
  });

  return {
    fileName,
    encoding: decoded.encoding,
    rows,
    fileErrors,
    validCount: rows.filter(
      (row) => row.skippedReason === null && row.errors.length === 0 && !row.needsFactorChoice,
    ).length,
    needsMappingCount: rows.filter(
      (row) => row.skippedReason === null && row.errors.length === 0 && row.needsFactorChoice,
    ).length,
  };
}

// ----------------------------------------------------------------------
// 確定（算定版の追記）
// ----------------------------------------------------------------------

export interface SupplierRowDecision {
  supplierCode: string;
  item: string;
  dataType: SupplierDataType;
  amount: number;
  unit: string;
  factorCode: string | null;
}

export interface SupplierImportResult {
  calculationId: Uuid;
  /** 新しく内訳に加わった社（コード順） */
  addedSuppliers: string[];
  /** 最新版の中で行が置き換わった社（コード順） */
  replacedSuppliers: string[];
  /** 新しい算定版の合計（t-CO2e） */
  result: number;
  inputCount: number;
}

interface ValidatedDecision {
  supplier: OrganizationUnit;
  factor: EmissionFactor | null;
  decision: SupplierRowDecision;
}

function buildInput({ supplier, factor, decision }: ValidatedDecision): CalculationInput {
  const label = supplierInputLabel(supplier, decision.item.trim());
  if (decision.dataType === 'emissions') {
    return {
      label,
      value: roundEmissions(decision.amount),
      unit: 't-CO2e',
      sourceType: 'constant',
      sourceId: null,
      note: 'サプライヤー報告排出量（一次データ）',
      activityAmount: null,
      activityUnit: null,
    };
  }
  const f = factor as EmissionFactor;
  return {
    label,
    value: roundEmissions(decision.amount * f.factorValue),
    unit: 't-CO2e',
    sourceType: 'emission_factor',
    sourceId: f.id,
    note:
      decision.dataType === 'monetary'
        ? `購買金額 ${decision.amount.toLocaleString('ja-JP')} 千円 × 係数 ${f.factorValue} (${f.factorYear}年度)`
        : `活動量 ${decision.amount.toLocaleString('ja-JP')} ${decision.unit} × 係数 ${f.factorValue} (${f.factorYear}年度)`,
    activityAmount: decision.amount,
    activityUnit: decision.unit,
  };
}

async function appendCalculationVersion(
  db: DbClient,
  ctx: AuthorizationContext,
  dataPoint: DataPoint,
  previousCount: number,
  inputs: CalculationInput[],
): Promise<DataPointCalculation> {
  const result = roundEmissions(inputs.reduce((sum, input) => sum + input.value, 0));
  const now = new Date().toISOString();
  const calculation: DataPointCalculation = {
    id: fid(
      'calculation',
      `${dataPoint.id}/${contentHash(`${now}|${previousCount}|${JSON.stringify(inputs)}`)}`,
    ),
    dataPointId: dataPoint.id,
    organizationId: ctx.workspace.organizationId,
    formula: SCOPE3_FORMULA,
    inputs,
    result,
    resultUnit: 't-CO2e',
    calculatedAt: now,
    calculatedBy: ctx.userId,
  };
  await db.insert('calculations', [calculation]);
  return calculation;
}

/**
 * サプライヤー一次データを確定し、Scope3 Cat.1 の算定根拠へ新しい版を追記する。
 *
 * Data Point の確定値は変更しない。確定値は金額ベース推計を含む承認済みの値であり、
 * 値の変更は承認フロー（data-point-workflow）で行う。ここで更新するのは
 * 一次データの算定根拠（内訳）だけ。
 */
export async function confirmSupplierImport(
  db: DbClient,
  ctx: AuthorizationContext,
  reportingPeriodId: Uuid,
  decisions: SupplierRowDecision[],
): Promise<SupplierImportResult> {
  // 画面と同じ二段の門: 取込の実行（プレビューと同じ）＋データの書き込み（RLS と対）
  assertCan(ctx, 'enterprise.import.run');
  assertCan(ctx, 'enterprise.data.write');

  if (decisions.length === 0) {
    throw new ValidationError('取り込む行がありません。プレビューで行を選択してください。');
  }

  const period = await db.findById('periods', reportingPeriodId);
  if (!period || period.organizationId !== ctx.workspace.organizationId) {
    throw new ValidationError('対象の報告期間が見つかりません。');
  }

  const [{ suppliers, factors }, scope3] = await Promise.all([
    loadSupplierMaster(db, ctx),
    loadScope3Context(db, ctx, reportingPeriodId),
  ]);
  if (!scope3.metric || !scope3.dataPoint) {
    throw new ValidationError(
      'Scope3 Category 1 の Data Point がこの期間にありません。先に非財務データで Data Point を作成してください。',
    );
  }
  // 拠点担当スコープの利用者が全社（本社）の算定根拠を書き換えられないようにする
  // （data-point-workflow と同じ守り。RLS は組織単位までしか見ない）
  assertUnitInScope(ctx, scope3.dataPoint.unitId);

  const factorByCode = new Map(factors.map((f) => [f.code.toUpperCase(), f]));

  // 全行を書き込み前にまとめて検証する（途中まで書いて止まる中途半端な版を作らない）
  const validated: ValidatedDecision[] = decisions.map((decision) => {
    // 行番号はチェック済み行だけの連番になり画面と一致しないため、
    // エラーはプレビューで探せる「サプライヤー×品目」で名指しする
    const at = `行「${decision.supplierCode} / ${decision.item || '(品目なし)'}」`;
    const supplier = findSupplier(suppliers, decision.supplierCode);
    if (!supplier) {
      throw new ValidationError(
        `${at}: サプライヤーコード「${decision.supplierCode}」が見つかりません。`,
      );
    }
    if (decision.item.trim() === '') {
      throw new ValidationError(`${at}: 品目が空です。`);
    }
    if (!Number.isFinite(decision.amount) || decision.amount <= 0) {
      throw new ValidationError(`${at}: 数値は 0 より大きい値で入力してください。`);
    }

    if (decision.dataType === 'emissions') {
      if (decision.unit !== 't-CO2e') {
        throw new ValidationError(`${at}: 排出量データの単位は t-CO2e で入力してください。`);
      }
      return { supplier, factor: null, decision };
    }

    if (decision.dataType === 'monetary' && decision.unit !== '千円') {
      throw new ValidationError(`${at}: 金額データの単位は 千円 で入力してください。`);
    }
    const code = (decision.factorCode ?? '').normalize('NFKC').toUpperCase();
    if (code === '') {
      throw new ValidationError(
        `${at}: 排出量原単位（排出係数）が未選択です。プレビューで原単位を紐づけてください。`,
      );
    }
    const factor = factorByCode.get(code);
    if (!factor) {
      throw new ValidationError(
        `${at}: 排出係数コード「${decision.factorCode}」が見つかりません。`,
      );
    }
    if (factor.activityUnit !== decision.unit) {
      throw new ValidationError(
        `${at}: 排出係数コード「${factor.code}」の活動量単位（${factor.activityUnit}）が行の単位（${decision.unit}）と一致しません。`,
      );
    }
    return { supplier, factor, decision };
  });

  // ラベル規約と再紐づけは「サプライヤー×品目」を 1 行の識別子として扱う。
  // 重複したまま確定すると、後から区別も個別修正もできなくなるため先に弾く
  const seenPairs = new Set<string>();
  for (const { supplier, decision } of validated) {
    const pairKey = `${supplier.code}|${decision.item.trim()}`;
    if (seenPairs.has(pairKey)) {
      throw new ValidationError(
        `同じサプライヤー×品目の行が重複しています（${supplier.code} / ${decision.item.trim()}）。合算するか、品目名を分けてください。`,
      );
    }
    seenPairs.add(pairKey);
  }

  // 置き換え判定は不変・一意なコードで行う（名前は改名でき一意でもない）
  const resubmittedCodes = new Set(validated.map((v) => v.supplier.code));
  const previousInputs = scope3.latest?.inputs ?? [];
  const keptInputs = previousInputs.filter((input) => {
    const matched = matchSupplierByLabel(suppliers, input.label);
    return !matched || !resubmittedCodes.has(matched.supplier.code);
  });
  const previousCodes = submittedSupplierCodes(suppliers, previousInputs);
  const replacedSuppliers = [...resubmittedCodes].filter((code) => previousCodes.has(code)).sort();
  const addedSuppliers = [...resubmittedCodes].filter((code) => !previousCodes.has(code)).sort();

  const newInputs = validated
    .slice()
    .sort((a, b) =>
      a.supplier.code === b.supplier.code
        ? a.decision.item.localeCompare(b.decision.item)
        : a.supplier.code.localeCompare(b.supplier.code),
    )
    .map(buildInput);

  const calculation = await appendCalculationVersion(
    db,
    ctx,
    scope3.dataPoint,
    scope3.calculations.length,
    [...keptInputs, ...newInputs],
  );

  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'data_point_calculation',
    resourceId: calculation.id,
    afterSummary: `Scope3 Cat.1 算定根拠を更新（サプライヤー ${resubmittedCodes.size} 社 / 内訳 ${calculation.inputs.length} 行 / 合計 ${calculation.result} t-CO2e）`,
    metadata: {
      dataPointId: scope3.dataPoint.id,
      addedSuppliers,
      replacedSuppliers,
    },
  });

  return {
    calculationId: calculation.id,
    addedSuppliers,
    replacedSuppliers,
    result: calculation.result,
    inputCount: calculation.inputs.length,
  };
}

// ----------------------------------------------------------------------
// 排出量原単位の再紐づけ
// ----------------------------------------------------------------------

export interface RelinkResult {
  calculationId: Uuid;
  /** 再計算後の対象行の排出量合計（t-CO2e） */
  value: number;
  /** 紐づけ直した行数（同じサプライヤー×品目で単位が合う行すべて） */
  relinkedCount: number;
  /** 新しい算定版の合計（t-CO2e） */
  result: number;
}

/**
 * 確定済みの内訳行（金額・物理量データ）の排出量原単位を紐づけ直す。
 *
 * 追記専用の算定根拠を書き換えず、対象行だけ再計算した新しい版を積む。
 * 活動量（activityAmount / activityUnit）を持たない行
 * （サプライヤー報告排出量・旧形式）は再計算できないため対象外。
 */
export async function relinkSupplierFactor(
  db: DbClient,
  ctx: AuthorizationContext,
  reportingPeriodId: Uuid,
  params: { supplierCode: string; item: string; factorCode: string },
): Promise<RelinkResult> {
  assertCan(ctx, 'enterprise.import.run');
  assertCan(ctx, 'enterprise.data.write');

  const [{ suppliers, factors }, scope3] = await Promise.all([
    loadSupplierMaster(db, ctx),
    loadScope3Context(db, ctx, reportingPeriodId),
  ]);
  if (!scope3.dataPoint || !scope3.latest) {
    throw new ValidationError(
      '算定内訳がまだありません。先にサプライヤーデータを取り込んでください。',
    );
  }
  assertUnitInScope(ctx, scope3.dataPoint.unitId);

  const factor = factors.find(
    (f) => f.code.toUpperCase() === params.factorCode.normalize('NFKC').toUpperCase(),
  );
  if (!factor) {
    throw new ValidationError(`排出係数コード「${params.factorCode}」が見つかりません。`);
  }

  // 同じサプライヤー×品目でも単位の違う行が混ざりうる（旧データ）。
  // 単位の合わない行はスキップして「合う行だけ」を紐づけ直し、
  // 1 行も合わなければ理由を分けて説明する（途中で throw すると、
  // 合う行まで巻き添えで再紐づけ不能になる）
  const relinkedRows: CalculationInput[] = [];
  let unitMismatch: string | null = null;
  const inputs = scope3.latest.inputs.map((input): CalculationInput => {
    const matched = matchSupplierByLabel(suppliers, input.label);
    if (
      !matched ||
      matched.supplier.code !== params.supplierCode ||
      matched.item !== params.item ||
      input.activityAmount === null ||
      input.activityAmount === undefined ||
      !input.activityUnit
    ) {
      return input;
    }
    if (factor.activityUnit !== input.activityUnit) {
      unitMismatch = input.activityUnit;
      return input;
    }
    const isMonetary = input.activityUnit === '千円';
    const next: CalculationInput = {
      ...input,
      value: roundEmissions(input.activityAmount * factor.factorValue),
      sourceId: factor.id,
      note: `${isMonetary ? '購買金額' : '活動量'} ${input.activityAmount.toLocaleString('ja-JP')} ${isMonetary ? '千円' : input.activityUnit} × 係数 ${factor.factorValue} (${factor.factorYear}年度)`,
    };
    relinkedRows.push(next);
    return next;
  });

  if (relinkedRows.length === 0) {
    if (unitMismatch) {
      throw new ValidationError(
        `排出係数コード「${factor.code}」の活動量単位（${factor.activityUnit}）が行の単位（${unitMismatch}）と一致しません。`,
      );
    }
    throw new ValidationError(
      '対象の内訳行が見つからないか、活動量を持たないため再紐づけできません（報告排出量の行は対象外です）。',
    );
  }

  const calculation = await appendCalculationVersion(
    db,
    ctx,
    scope3.dataPoint,
    scope3.calculations.length,
    inputs,
  );

  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'data_point_calculation',
    resourceId: calculation.id,
    afterSummary: `Scope3 Cat.1 の原単位を再紐づけ（${params.supplierCode} / ${params.item} → ${factor.code}）`,
    metadata: { dataPointId: scope3.dataPoint.id, factorCode: factor.code },
  });

  return {
    calculationId: calculation.id,
    value: roundEmissions(relinkedRows.reduce((sum, row) => sum + row.value, 0)),
    relinkedCount: relinkedRows.length,
    result: calculation.result,
  };
}

// ----------------------------------------------------------------------
// 内訳の読み出し（GHG 画面・取込画面）
// ----------------------------------------------------------------------

export interface SupplierBreakdownInput {
  item: string;
  value: number;
  note: string | null;
  activityAmount: number | null;
  activityUnit: string | null;
  /** 紐づいている原単位の ID（報告排出量は null） */
  factorId: Uuid | null;
}

export interface SupplierBreakdownEntry {
  unitId: Uuid;
  code: string;
  name: string;
  submitted: boolean;
  inputs: SupplierBreakdownInput[];
  /** この社の排出量合計（t-CO2e） */
  total: number;
  /** 一次データ合計に占める構成比（%）。未提出は null */
  sharePercent: number | null;
}

export interface Scope3SupplierBreakdown {
  metric: MetricDefinition | null;
  dataPoint: DataPoint | null;
  /** 最新の算定版。無ければ null */
  calculation: DataPointCalculation | null;
  calculationCount: number;
  suppliers: SupplierBreakdownEntry[];
  submittedCount: number;
  /** 一次データ（サプライヤー実績）の合計 t-CO2e */
  primaryTotal: number;
  /** どのサプライヤーにも紐付かない内訳行（規約外ラベル） */
  otherInputs: CalculationInput[];
  /** Data Point 確定値に対する一次データの割合（%）。確定値が無ければ null */
  coveragePercent: number | null;
  /** 排出量原単位（排出係数）マスター全件（金額・物理量ベース両方） */
  factors: EmissionFactor[];
}

export async function loadScope3SupplierBreakdown(
  db: DbClient,
  ctx: AuthorizationContext,
  reportingPeriodId: Uuid,
): Promise<Scope3SupplierBreakdown> {
  assertCan(ctx, 'enterprise.data.read');

  const [{ suppliers, factors }, scope3] = await Promise.all([
    loadSupplierMaster(db, ctx),
    loadScope3Context(db, ctx, reportingPeriodId),
  ]);

  const inputs = scope3.latest?.inputs ?? [];
  const inputsByCode = new Map<string, SupplierBreakdownInput[]>();
  const otherInputs: CalculationInput[] = [];
  for (const input of inputs) {
    const matched = matchSupplierByLabel(suppliers, input.label);
    if (matched) {
      const list = inputsByCode.get(matched.supplier.code) ?? [];
      list.push({
        item: matched.item,
        value: input.value,
        note: input.note,
        activityAmount: input.activityAmount ?? null,
        activityUnit: input.activityUnit ?? null,
        factorId: input.sourceType === 'emission_factor' ? input.sourceId : null,
      });
      inputsByCode.set(matched.supplier.code, list);
    } else {
      otherInputs.push(input);
    }
  }

  const primaryTotal = roundEmissions(inputs.reduce((sum, input) => sum + input.value, 0));
  const entries: SupplierBreakdownEntry[] = suppliers.map((unit) => {
    const supplierInputs = inputsByCode.get(unit.code) ?? [];
    const total = roundEmissions(supplierInputs.reduce((sum, input) => sum + input.value, 0));
    return {
      unitId: unit.id,
      code: unit.code,
      name: unit.name,
      submitted: supplierInputs.length > 0,
      inputs: supplierInputs,
      total,
      sharePercent:
        supplierInputs.length > 0 && primaryTotal > 0
          ? Math.round((total / primaryTotal) * 1000) / 10
          : null,
    };
  });

  return {
    metric: scope3.metric,
    dataPoint: scope3.dataPoint,
    calculation: scope3.latest,
    calculationCount: scope3.calculations.length,
    suppliers: entries,
    submittedCount: entries.filter((entry) => entry.submitted).length,
    primaryTotal,
    otherInputs,
    coveragePercent:
      scope3.dataPoint && scope3.dataPoint.value !== null && scope3.dataPoint.value > 0
        ? Math.round((primaryTotal / scope3.dataPoint.value) * 1000) / 10
        : null,
    factors,
  };
}
