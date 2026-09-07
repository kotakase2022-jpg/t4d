import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, assertUnitInScope } from '@/lib/authorization/can';
import { matchSupplierByLabel, supplierInputLabel } from '@/lib/domain/scope3-labels';
import { ValidationError } from '@/lib/errors/user-facing';
import { contentHash, fid } from '@/lib/fixtures/ids';
import { decodeText, detectDelimiter, parseCsvText } from '@/lib/imports/parsers';
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
 * 算定根拠は `data_point_calculations`（追記専用）へ版として積む。
 * サプライヤーの識別は CalculationInput.label の
 * 「<コード> <サプライヤー名> / <品目>」規約（domain/scope3-labels.ts）で行う。
 * 突き合わせは不変・一意な**コード**で行い、名前は読み手のための併記
 * （名前は改名でき一意でもないため、キーにすると二重計上・欠落を作る）。
 *
 * 取込は規則ベース（AI 不使用）。どの行がなぜ取り込めなかったかを
 * そのまま説明できるようにするため（row-role.ts と同じ方針）。
 */

export const SCOPE3_METRIC_CODE = 'scope3_cat1';

// ----------------------------------------------------------------------
// CSV の解釈（純粋・決定論）
// ----------------------------------------------------------------------

export interface SupplierCsvRow {
  /** ヘッダーを除いた 1 始まりの行番号 */
  rowIndex: number;
  supplierCode: string;
  item: string;
  amountRaw: string;
  amountThousandJpy: number | null;
  factorCode: string;
  /** 合計行・注記行として除外した理由。null なら取込候補 */
  skippedReason: string | null;
  errors: string[];
}

export interface SupplierCsvExtract {
  rows: SupplierCsvRow[];
  fileErrors: string[];
}

const HEADER_RULES: Array<{
  key: 'supplier' | 'item' | 'amount' | 'factor';
  label: string;
  match: RegExp;
}> = [
  { key: 'supplier', label: 'サプライヤーコード', match: /サプライヤ|供給|仕入|supplier/i },
  { key: 'item', label: '品目', match: /品目|品名|item/i },
  { key: 'amount', label: '購買金額(千円)', match: /金額|amount/i },
  { key: 'factor', label: '排出係数コード', match: /係数|factor/i },
];

/**
 * サプライヤー購買 CSV をヘッダー規則で列に割り当て、行へ分解する。
 * マスターとの突き合わせ（コード解決・排出量計算）は previewSupplierImport が行う。
 */
export function extractSupplierCsvRows(text: string): SupplierCsvExtract {
  const table = parseCsvText(text, detectDelimiter(text)).filter((cells) =>
    cells.some((cell) => cell.trim() !== ''),
  );
  const header = table[0];
  if (!header) {
    return { rows: [], fileErrors: ['データ行がありません。ヘッダー行と明細行を含めてください。'] };
  }

  const columnIndex = new Map<string, number>();
  for (const rule of HEADER_RULES) {
    const index = header.findIndex((cell) => rule.match.test(cell.normalize('NFKC')));
    if (index >= 0) columnIndex.set(rule.key, index);
  }
  const missing = HEADER_RULES.filter((rule) => !columnIndex.has(rule.key));
  if (missing.length > 0) {
    return {
      rows: [],
      fileErrors: [
        `必須列が見つかりません: ${missing.map((m) => m.label).join(' / ')}（ヘッダー: ${header.join(', ')}）。テンプレート CSV の列名に合わせてください。`,
      ],
    };
  }

  const dataRows = table.slice(1);
  // 合計行・注記行の除外は取込画面と同じ規則ベース判定を使う（二重計上の防止）
  const roles = classifyRowRoles(
    dataRows.map((cells) =>
      Object.fromEntries(cells.map((cell, i) => [header[i] ?? `col_${i}`, cell])),
    ),
  );

  const rows: SupplierCsvRow[] = dataRows.map((cells, index) => {
    const pick = (key: string) => (cells[columnIndex.get(key) ?? -1] ?? '').trim();
    const amountRaw = pick('amount');
    const amount = parseFlexibleNumber(amountRaw);
    const role = roles[index] ?? 'detail';

    const errors: string[] = [];
    if (role === 'detail') {
      if (pick('supplier') === '') errors.push('サプライヤーコードが空です。');
      if (pick('item') === '') errors.push('品目が空です。');
      if (amount === null) errors.push(`購買金額「${amountRaw}」を数値として読み取れません。`);
      else if (amount <= 0) errors.push('購買金額は 0 より大きい数値で入力してください。');
      if (pick('factor') === '') errors.push('排出係数コードが空です。');
    }

    return {
      rowIndex: index + 1,
      supplierCode: pick('supplier'),
      item: pick('item'),
      amountRaw,
      amountThousandJpy: amount,
      factorCode: pick('factor').normalize('NFKC').toUpperCase(),
      skippedReason:
        role === 'total'
          ? '合計行と判定したため取込対象外です（明細行と重複するため）。'
          : role === 'note'
            ? '注記・フッター行と判定したため取込対象外です。'
            : null,
      errors,
    };
  });

  return { rows, fileErrors: [] };
}

// ----------------------------------------------------------------------
// プレビュー（マスターとの突き合わせ）
// ----------------------------------------------------------------------

export interface SupplierPreviewRow extends SupplierCsvRow {
  supplierUnitId: Uuid | null;
  supplierName: string | null;
  factorId: Uuid | null;
  factorName: string | null;
  factorValue: number | null;
  factorYear: number | null;
  /** 購買金額 × 係数（0.1 t-CO2e 丸め） */
  emissions: number | null;
  /** この社は最新の算定内訳に既に載っており、確定すると置き換えになる */
  replacesExisting: boolean;
}

export interface SupplierImportPreview {
  fileName: string;
  encoding: string;
  rows: SupplierPreviewRow[];
  fileErrors: string[];
  /** エラーなし・除外なしで確定できる行数 */
  validCount: number;
}

function roundEmissions(value: number): number {
  return Math.round(value * 10) / 10;
}

async function loadSupplierMaster(db: DbClient, ctx: AuthorizationContext) {
  const organizationId = ctx.workspace.organizationId;
  const [units, allFactors] = await Promise.all([
    db.select('units', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('emissionFactors', { where: { organizationId }, orderBy: { column: 'code' } }),
  ]);
  const suppliers = units
    .filter((unit) => unit.unitType === 'supplier')
    .sort((a, b) => a.code.localeCompare(b.code));
  // 算定式は Σ(購買金額[千円] × 係数[t-CO2e/千円])。次元の合わない係数
  // （kWh ベースの電力係数など）を紐付けると監査に耐えない値になるため、
  // 金額（千円）ベースの係数だけを突き合わせ対象にする
  const factors = allFactors.filter((factor) => factor.activityUnit === '千円');
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
  const submittedCodes = submittedSupplierCodes(suppliers, scope3.latest?.inputs ?? []);

  const rows: SupplierPreviewRow[] = extract.rows.map((row) => {
    const errors = [...row.errors];
    const supplier = row.supplierCode === '' ? null : findSupplier(suppliers, row.supplierCode);
    if (row.skippedReason === null && row.supplierCode !== '' && !supplier) {
      errors.push(
        `サプライヤーコード「${row.supplierCode}」が組織・拠点（サプライヤー）に見つかりません。`,
      );
    }
    const factor = row.factorCode === '' ? null : (factorByCode.get(row.factorCode) ?? null);
    if (row.skippedReason === null && row.factorCode !== '' && !factor) {
      errors.push(
        `排出係数コード「${row.factorCode}」が購買金額（千円）ベースの排出係数マスターに見つかりません。`,
      );
    }
    const emissions =
      supplier && factor && row.amountThousandJpy !== null && row.amountThousandJpy > 0
        ? roundEmissions(row.amountThousandJpy * factor.factorValue)
        : null;

    return {
      ...row,
      errors,
      supplierUnitId: supplier?.id ?? null,
      supplierName: supplier?.name ?? null,
      factorId: factor?.id ?? null,
      factorName: factor?.name ?? null,
      factorValue: factor?.factorValue ?? null,
      factorYear: factor?.factorYear ?? null,
      emissions,
      replacesExisting: supplier ? submittedCodes.has(supplier.code) : false,
    };
  });

  return {
    fileName,
    encoding: decoded.encoding,
    rows,
    fileErrors,
    validCount: rows.filter((row) => row.skippedReason === null && row.errors.length === 0).length,
  };
}

// ----------------------------------------------------------------------
// 確定（算定版の追記）
// ----------------------------------------------------------------------

export interface SupplierRowDecision {
  supplierCode: string;
  item: string;
  amountThousandJpy: number;
  factorCode: string;
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

/**
 * サプライヤー購買データを確定し、Scope3 Cat.1 の算定根拠へ新しい版を追記する。
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
  const validated = decisions.map((decision, index) => {
    const supplier = findSupplier(suppliers, decision.supplierCode);
    if (!supplier) {
      throw new ValidationError(
        `${index + 1} 行目: サプライヤーコード「${decision.supplierCode}」が見つかりません。`,
      );
    }
    const factor = factorByCode.get(decision.factorCode.normalize('NFKC').toUpperCase());
    if (!factor) {
      throw new ValidationError(
        `${index + 1} 行目: 排出係数コード「${decision.factorCode}」が購買金額（千円）ベースの排出係数マスターに見つかりません。`,
      );
    }
    if (!Number.isFinite(decision.amountThousandJpy) || decision.amountThousandJpy <= 0) {
      throw new ValidationError(
        `${index + 1} 行目: 購買金額は 0 より大きい数値で入力してください。`,
      );
    }
    if (decision.item.trim() === '') {
      throw new ValidationError(`${index + 1} 行目: 品目が空です。`);
    }
    return { supplier, factor, decision };
  });

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

  const newInputs: CalculationInput[] = validated
    .slice()
    .sort((a, b) =>
      a.supplier.code === b.supplier.code
        ? a.decision.item.localeCompare(b.decision.item)
        : a.supplier.code.localeCompare(b.supplier.code),
    )
    .map(({ supplier, factor, decision }) => ({
      label: supplierInputLabel(supplier, decision.item.trim()),
      value: roundEmissions(decision.amountThousandJpy * factor.factorValue),
      unit: 't-CO2e',
      sourceType: 'emission_factor',
      sourceId: factor.id,
      note: `購買金額 ${decision.amountThousandJpy.toLocaleString('ja-JP')} 千円 × 係数 ${factor.factorValue} (${factor.factorYear}年度)`,
    }));

  const inputs = [...keptInputs, ...newInputs];
  const result = roundEmissions(inputs.reduce((sum, input) => sum + input.value, 0));
  const now = new Date().toISOString();
  const calculation: DataPointCalculation = {
    id: fid(
      'calculation',
      `${scope3.dataPoint.id}/${contentHash(`${now}|${scope3.calculations.length}|${JSON.stringify(inputs)}`)}`,
    ),
    dataPointId: scope3.dataPoint.id,
    organizationId: ctx.workspace.organizationId,
    formula: 'Σ(購買金額[千円] × 排出係数[t-CO2e/千円])',
    inputs,
    result,
    resultUnit: 't-CO2e',
    calculatedAt: now,
    calculatedBy: ctx.userId,
  };
  await db.insert('calculations', [calculation]);

  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'data_point_calculation',
    resourceId: calculation.id,
    afterSummary: `Scope3 Cat.1 算定根拠を更新（サプライヤー ${resubmittedCodes.size} 社 / 内訳 ${inputs.length} 行 / 合計 ${result} t-CO2e）`,
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
    result,
    inputCount: inputs.length,
  };
}

// ----------------------------------------------------------------------
// 内訳の読み出し（GHG 画面・取込画面）
// ----------------------------------------------------------------------

export interface SupplierBreakdownEntry {
  unitId: Uuid;
  code: string;
  name: string;
  submitted: boolean;
  inputs: Array<{ item: string; value: number; note: string | null }>;
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
  const inputsByCode = new Map<
    string,
    Array<{ item: string; value: number; note: string | null }>
  >();
  const otherInputs: CalculationInput[] = [];
  for (const input of inputs) {
    const matched = matchSupplierByLabel(suppliers, input.label);
    if (matched) {
      const list = inputsByCode.get(matched.supplier.code) ?? [];
      list.push({ item: matched.item, value: input.value, note: input.note });
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
