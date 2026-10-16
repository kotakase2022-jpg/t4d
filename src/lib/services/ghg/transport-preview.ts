import 'server-only';

import { assertEnterpriseWorkspace, NotFoundError } from '@/lib/authorization/can';
import { calculateRun, LINE_WARNING_LABELS } from '@/lib/domain/ghg/calculate';
import { latestPolicy, type GhgSourceRows } from '@/lib/domain/ghg/select-inputs';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  ConversionStep,
  GhgActivityBatch,
  GhgActivityLine,
  GhgCalculationLine,
  GhgCalculationPolicy,
  GhgMethod,
  GhgScope,
  Uuid,
} from '@/types/domain';
import { loadGhgSource } from './inputs';

/**
 * 活動量のバッチの試算（plan §2.3 transport-preview.ts・P95・CR-06）。**読むだけ**（書き込み 0）。
 *
 * いまの算定方針・係数セット・割当で、行ごとに t·km → 燃料使用原単位（式／見なし積載率の原単位表・積載率の出所）
 * → 燃料 L → kL → CO2 を出す。算定の記録ではない（記録は概要の「算定を実行」だけが作る）。
 * 計算は算定のエンジン（src/lib/domain/ghg/calculate.ts の calculateRun）をそのまま使い、画面のための
 * 別の計算を持たない（試算と算定の記録が食い違わないように）。確定前のバッチ（確認中）でも試算できる。
 * 取込の検証（activity-import.ts の previewActivityImport）も、まだ保存していない行で同じ試算を使う。
 */

/** 改良トンキロ法の段（算定行の methodDetail から取り出したもの） */
export interface TransportTrialDetail {
  tonKm: number;
  /** t·km の出所（ファイルの t·km か、重量 × 距離か） */
  tonKmSource: 'input' | 'weight_distance';
  intensityRaw: number;
  intensity: number;
  intensitySource: 'formula' | 'default_table';
  shape: 'kokuji' | 'log' | null;
  loadFactorUsed: number;
  loadFactorSource: 'measured' | 'default' | 'floored';
  coefficients: { A: number | null; B: number | null; S: number | null; lnA: number | null };
  /** 原単位の係数（式・原単位表）の解決の経路 */
  intensityPath: string;
  fuelLiters: number;
  overseas: boolean;
}

/** 2 段係数の段（熱量・炭素量） */
export interface FuelTrialDetail {
  calorificValue: number;
  calorificUnit: string | null;
  carbonFactor: number;
  carbonFactorUnit: string | null;
  gj: number;
  tc: number;
}

/** 1 行の試算の結果（電力は基準ごとに 2 つ） */
export interface TrialResult {
  method: GhgMethod;
  basis: 'location' | 'market' | null;
  activityAmount: number;
  activityUnit: string;
  convertedAmount: number;
  convertedUnit: string;
  conversionSteps: ConversionStep[];
  factorValue: number;
  factorUnit: string;
  factorYear: number;
  factorSetCode: string;
  factorSetVersion: string;
  resolutionPath: string;
  transport: TransportTrialDetail | null;
  fuel: FuelTrialDetail | null;
  /** t-CO2e（未丸め。丸めは算定の記録の段で行う） */
  emissionsT: number;
  protocolScope: GhgScope;
  reportedScope: GhgScope;
  warnings: string[];
}

export interface LineTrial {
  activityLineId: Uuid;
  results: TrialResult[];
  /** 試算できなかった理由（係数の未割当・単位の次元違い・組織の設定で止めた行など） */
  error: string | null;
}

export interface TrialCounts {
  lines: number;
  calculated: number;
  errors: number;
  /** 見なし積載率の原単位表で算定した行 */
  defaultLoad: number;
  /** 積載率の下限を当てた行 */
  floored: number;
  /** 最大積載量が式の範囲外の行（警告として算定した行） */
  payloadOutOfRange: number;
  /** 積載率 100% 超を 100% として算定した行 */
  loadCapped: number;
  /** 海外拠点の輸送として算定した行 */
  overseas: number;
}

export interface TrialCalculation {
  /** 試算に使った算定方針（期間の最新の版。無ければ null で、全行が試算できない） */
  policy: GhgCalculationPolicy | null;
  /** 行 ID → 試算（配列。画面へ渡せる形） */
  lines: LineTrial[];
  counts: TrialCounts;
  /** 既定区分ごとの合計（t。未丸め。Scope2 の 2 基準は足さず別に持つ） */
  totalsByProtocolScope: Partial<Record<GhgScope, number>>;
}

const NO_POLICY_MESSAGE =
  'この期間の算定方針（丸め・換算・改良トンキロ法の設定）がありません。算定ルールの画面で保存すると試算できます。';

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function transportDetail(
  line: GhgCalculationLine,
  source: GhgActivityLine | undefined,
): TransportTrialDetail | null {
  if (line.method !== 'tonkm_improved') return null;
  const d = line.methodDetail;
  const coefficients = (d.coefficients ?? {}) as Record<string, unknown>;
  const loadSource = str(d.loadFactorSource);
  const intensitySource = str(d.intensitySource);
  const shape = str(d.shape);
  return {
    tonKm: num(d.tonKm) ?? line.activityAmount,
    tonKmSource: source && source.tonKm !== null ? 'input' : 'weight_distance',
    intensityRaw: num(d.intensityRaw) ?? 0,
    intensity: num(d.intensity) ?? 0,
    intensitySource: intensitySource === 'default_table' ? 'default_table' : 'formula',
    shape: shape === 'kokuji' || shape === 'log' ? shape : null,
    loadFactorUsed: num(d.loadFactorUsed) ?? 0,
    loadFactorSource:
      loadSource === 'default' || loadSource === 'floored' ? loadSource : 'measured',
    coefficients: {
      A: num(coefficients.A),
      B: num(coefficients.B),
      S: num(coefficients.S),
      lnA: num(coefficients.lnA),
    },
    intensityPath: str(d.intensityResolutionPath) ?? '',
    fuelLiters: num(d.fuelLiters) ?? 0,
    overseas: d.overseas === true,
  };
}

function fuelDetail(line: GhgCalculationLine): FuelTrialDetail | null {
  const d = line.methodDetail;
  const calorificValue = num(d.calorificValue);
  const carbonFactor = num(d.carbonFactor);
  const gj = num(d.gj);
  const tc = num(d.tc);
  if (calorificValue === null || carbonFactor === null || gj === null || tc === null) return null;
  return {
    calorificValue,
    calorificUnit: str(d.calorificUnit),
    carbonFactor,
    carbonFactorUnit: str(d.carbonFactorUnit),
    gj,
    tc,
  };
}

/** エンジンのエラーの文から、拠点・月・行の前置きを外す（行の表の中では重複するため） */
function reasonOf(message: string): string {
  const index = message.indexOf('）: ');
  return index >= 0 ? message.slice(index + 3) : message;
}

/**
 * 1 つのバッチ（保存前の行でもよい）を試算する。source は期間の算定の入力の元（loadGhgSource）。
 * バッチの状態は問わない（確認中のバッチ・保存前の取込の行も同じ計算で見せる）
 */
export function trialCalculate(
  source: GhgSourceRows,
  batch: Pick<GhgActivityBatch, 'id' | 'unitId' | 'reportingPeriodId'> & Partial<GhgActivityBatch>,
  lines: readonly GhgActivityLine[],
): TrialCalculation {
  const policy = latestPolicy(source.policies, source.period.id);
  const counts: TrialCounts = {
    lines: lines.length,
    calculated: 0,
    errors: 0,
    defaultLoad: 0,
    floored: 0,
    payloadOutOfRange: 0,
    loadCapped: 0,
    overseas: 0,
  };
  if (!policy) {
    counts.errors = lines.length;
    return {
      policy: null,
      lines: lines.map((l) => ({ activityLineId: l.id, results: [], error: NO_POLICY_MESSAGE })),
      counts,
      totalsByProtocolScope: {},
    };
  }
  const virtualBatch: GhgActivityBatch = {
    organizationId: source.organization.id,
    kind: 'energy',
    source: 'upload',
    fileName: '',
    fileSha256: null,
    rowCount: lines.length,
    status: 'draft',
    confirmedBy: null,
    confirmedAt: null,
    supersedesBatchId: null,
    createdAt: new Date(0).toISOString(),
    createdBy: null,
    updatedAt: new Date(0).toISOString(),
    ...batch,
  };
  const output = calculateRun(
    {
      organizationId: source.organization.id,
      organizationCountryCode: source.organization.countryCode,
      period: source.period,
      periods: source.periods,
      units: source.units.filter((u) => u.organizationId === source.organization.id),
      unitIds: [batch.unitId],
      policy,
      factorSets: source.sets,
      factors: source.factors,
      assignments: source.assignments,
      rules: source.rules,
      batches: [virtualBatch],
      lines: lines.map((l) => ({ ...l, batchId: virtualBatch.id })),
    },
    // 試算の行の ID は表示にしか使わない（保存しない）
    { runId: `trial-${batch.id}`, createdAt: new Date(0).toISOString() },
  );
  const sourceById = new Map(lines.map((l) => [l.id, l]));
  const resultsByLine = new Map<string, TrialResult[]>();
  const totals: Partial<Record<GhgScope, number>> = {};
  for (const line of output.lines) {
    const result: TrialResult = {
      method: line.method,
      basis:
        line.method === 'electricity_location'
          ? 'location'
          : line.method === 'electricity_market'
            ? 'market'
            : null,
      activityAmount: line.activityAmount,
      activityUnit: line.activityUnit,
      convertedAmount: line.convertedAmount,
      convertedUnit: line.convertedUnit,
      conversionSteps: line.conversionSteps,
      factorValue: line.factorValue,
      factorUnit: line.factorUnit,
      factorYear: line.factorYear,
      factorSetCode: line.factorSetCode,
      factorSetVersion: line.factorSetVersion,
      resolutionPath: line.resolutionPath,
      transport: transportDetail(line, sourceById.get(line.activityLineId)),
      fuel: fuelDetail(line),
      emissionsT: line.emissionsUnrounded,
      protocolScope: line.protocolScope,
      reportedScope: line.reportedScope,
      warnings: line.warnings,
    };
    resultsByLine.set(line.activityLineId, [
      ...(resultsByLine.get(line.activityLineId) ?? []),
      result,
    ]);
    totals[line.protocolScope] = (totals[line.protocolScope] ?? 0) + line.emissionsUnrounded;
  }
  const errorByLine = new Map(output.errors.map((e) => [e.activityLineId, reasonOf(e.message)]));
  const trialLines: LineTrial[] = lines.map((l) => {
    const results = resultsByLine.get(l.id) ?? [];
    const warnings = new Set(results.flatMap((r) => r.warnings));
    if (results.length > 0) counts.calculated += 1;
    if (warnings.has('default_load_factor')) counts.defaultLoad += 1;
    if (warnings.has('load_floored')) counts.floored += 1;
    if (warnings.has('payload_out_of_range')) counts.payloadOutOfRange += 1;
    if (warnings.has('load_capped')) counts.loadCapped += 1;
    if (warnings.has('overseas_transport')) counts.overseas += 1;
    const error = errorByLine.get(l.id) ?? null;
    if (error) counts.errors += 1;
    return { activityLineId: l.id, results, error };
  });
  return { policy, lines: trialLines, counts, totalsByProtocolScope: totals };
}

/** 算定行の警告の語（画面と取込の検証で同じ語を使う） */
export function trialWarningLabel(code: string): string {
  return LINE_WARNING_LABELS[code] ?? code;
}

export interface BatchTrial {
  batch: GhgActivityBatch;
  trial: TrialCalculation;
}

/**
 * バッチの試算（P95）。閲覧の権限（enterprise.data.read。loadGhgSource が確かめる）だけで見られる。
 * 他の組織のバッチは「見つかりません」
 */
export async function previewTransportCalculation(
  db: DbClient,
  ctx: AuthorizationContext,
  batchId: Uuid,
): Promise<BatchTrial> {
  assertEnterpriseWorkspace(ctx);
  const batch = await db.findById('ghgActivityBatches', batchId);
  if (!batch || batch.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('活動量の取込が見つかりません。');
  }
  const source = await loadGhgSource(db, ctx, batch.reportingPeriodId);
  const lines = source.lines
    .filter((l) => l.batchId === batch.id)
    .sort((a, b) => a.lineNo - b.lineNo);
  return { batch, trial: trialCalculate(source, batch, lines) };
}
