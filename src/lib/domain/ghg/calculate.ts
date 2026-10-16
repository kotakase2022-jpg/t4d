import { createHash } from 'node:crypto';
import { canonicalJson } from '@/lib/domain/disclosure-block';
import { fid } from '@/lib/fixtures/ids';
import { classify, ruleEffectiveIn } from './classification';
import {
  assignmentsAtResolvedLevel,
  factorNeedsOfLine,
  resolveFactor,
  RESOLUTION_ERROR_LABELS,
  type FactorNeed,
} from './factor-resolution';
import { CO2_PER_C, fuelToCo2 } from './fuel-co2';
import { ACTIVITY_CODE_LABELS } from './labels';
import { applyRoundingStages, cleanFloat, roundEmission, ruleFor } from './rounding';
import {
  fuelIntensity,
  tonKm,
  transportFuelLiters,
  type IntensityError,
  type TransportDefaultParams,
  type TransportFormulaParams,
} from './tonkm';
import { convert, emissionToTonnes, parseUnit, splitFactorUnit } from './units';
import type {
  ConversionStep,
  EmissionFactor,
  EmissionFactorAssignment,
  EmissionFactorSet,
  FactorActivityKind,
  GhgActivityBatch,
  GhgActivityKind,
  GhgActivityLine,
  GhgCalculationLine,
  GhgCalculationPolicy,
  GhgClassificationRule,
  GhgMethod,
  GhgRunSummary,
  GhgScope,
  GhgViewSummary,
  OrganizationUnit,
  ReportingPeriod,
  RoundingRule,
  UnitConversionRule,
} from '@/types/domain';

/**
 * Scope1・2 の算定（plan §2.2 calculate.ts・CR-08）。純関数（DB・画面・AI に依存しない）。
 *
 * 順: 換算（方針）→ 係数の解決 → 2 段係数か 1 段係数（電力は 2 基準で 2 行）→ 輸送は t·km → 原単位 → 燃料 L→kL
 * → CO2 → t への正規化（未丸めを残す）→ 丸めの段（line → month → site_activity → site_scope → total。
 * 段に規則があればその段の丸め後の値を次の段で足す）→ 区分（既定区分・報告区分）。各段の値を行に残す。
 *
 * 同じ入力から同じ結果を返す（行の ID は `fid('ghg_line', 記録/n)`）。係数が解決できない・単位の次元が合わない・
 * 区分規則が衝突する行は、エラーの一覧に入れて行を作らない（呼び出し側は 1 件でもあれば記録を作らない。plan K6）。
 */

/**
 * エンジンの版（式・規則を変えたら上げる。記録と一緒に残し、作り直しの照合に使う）。
 * 2: 購入した熱を 2 基準で算定・入力ハッシュに係数のセットの状態・拠点の国・解決で選ばれる段の割当だけを含める
 */
export const GHG_ENGINE_VERSION = 'ghg-engine/2';

export interface GhgCalculationInputs {
  organizationId: string;
  /** 組織の国（これと違う国の拠点の輸送は「海外拠点」。改良トンキロ法は国内の方法） */
  organizationCountryCode: string;
  period: Pick<ReportingPeriod, 'id' | 'code' | 'startDate' | 'endDate'>;
  periods: ReadonlyArray<Pick<ReportingPeriod, 'id' | 'startDate' | 'endDate'>>;
  units: ReadonlyArray<Pick<OrganizationUnit, 'id' | 'code' | 'name' | 'countryCode'>>;
  /** 算定する拠点 */
  unitIds: readonly string[];
  policy: GhgCalculationPolicy;
  factorSets: readonly EmissionFactorSet[];
  factors: readonly EmissionFactor[];
  assignments: readonly EmissionFactorAssignment[];
  /** 区分規則（承認済み・適用期間内のものだけが効く） */
  rules: readonly GhgClassificationRule[];
  /** 確定済みの活動量のバッチ（拠点・期間の最新） */
  batches: readonly GhgActivityBatch[];
  lines: readonly GhgActivityLine[];
}

export interface GhgCalcError {
  activityLineId: string;
  unitId: string;
  code: string;
  message: string;
}

export interface GhgCalculationOutput {
  lines: GhgCalculationLine[];
  summary: GhgRunSummary;
  inputHash: string;
  engineVersion: string;
  errors: GhgCalcError[];
  /** 記録に残す入力の ID（解決に使った係数のセット・効いた区分規則・活動量のバッチ） */
  factorSetIds: string[];
  ruleIds: string[];
  activityBatchIds: string[];
}

/** 仮説の再計算（照合・CR-14）の置き換え。保存しない */
export interface GhgSubstitutions {
  /** 解決した係数を、別の係数セットの同じ種類・コード・基準・国の係数に置き換える */
  factorSetId?: string;
  /** 丸めの規則を置き換える */
  rounding?: RoundingRule[];
  /** 区分規則を使わない（既定区分のまま） */
  noClassificationRules?: boolean;
  /** 改良トンキロ法の式の形 */
  shape?: 'kokuji' | 'log';
  /** 組織の換算を使わない（倍率 1 として扱う。例: m3 を Nm3 として） */
  noConversions?: boolean;
}

// ----------------------------------------------------------------------
// 表示の語
// ----------------------------------------------------------------------

/** 活動の名前（経路の文・明細に使う。知らないコードはコードのまま。置き場所は labels.ts） */
export { ACTIVITY_CODE_LABELS };

export const ACTIVITY_KIND_LABELS: Readonly<Record<GhgActivityKind, string>> = {
  fuel: '燃料',
  electricity: '電力',
  gas: 'ガス',
  heat: '熱',
  transport: '輸送',
};

export function activityLabel(kind: GhgActivityKind, code: string): string {
  if (kind === 'electricity') return '電力';
  return ACTIVITY_CODE_LABELS[code] ?? code;
}

/** 算定行の警告の語 */
export const LINE_WARNING_LABELS: Readonly<Record<string, string>> = {
  default_load_factor: '見なし積載率（原単位表）',
  load_floored: '積載率の下限を適用',
  load_capped: '積載率 100% 超を 100% として算定',
  payload_out_of_range: '最大積載量が式の範囲外',
  overseas_transport: '海外拠点の輸送（国内の方法を適用）',
};

const INTENSITY_ERROR_LABELS: Record<IntensityError, string> = {
  no_formula: '改良トンキロ法の式の係数が割り当てられていません',
  no_default_table: '見なし積載率の原単位表が割り当てられていません',
  no_formula_for_class: 'この燃費区分の式の係数が係数セットにありません',
  no_log_coefficient: '対数式の定数（lnA）が係数セットにありません',
  no_default_value: '原単位表にこの区分の値がありません',
  no_payload: '最大積載量がありません',
  no_economy_class: '燃費区分がありません',
  load_over_100: '積載率が 100% を超えています（組織の設定で止めています）',
  invalid_load_factor: '積載率が正の数ではありません',
  payload_out_of_range: '最大積載量が式の範囲外です（組織の設定で止めています）',
  overseas_blocked: '海外拠点の輸送です（組織の設定で改良トンキロ法を止めています）',
};

// ----------------------------------------------------------------------
// 入力ハッシュ
// ----------------------------------------------------------------------

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 期間に効く区分規則（承認済み・適用期間内） */
export function effectiveRules(
  rules: readonly GhgClassificationRule[],
  period: GhgCalculationInputs['period'],
  periods: GhgCalculationInputs['periods'],
): GhgClassificationRule[] {
  return rules
    .filter((r) => r.status === 'approved' && ruleEffectiveIn(r, period, periods))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** 算定する活動量のバッチ（対象拠点・期間）。算定と入力ハッシュが同じ規則で選ぶ */
function targetBatches(inputs: GhgCalculationInputs): GhgActivityBatch[] {
  const units = new Set(inputs.unitIds);
  return inputs.batches.filter(
    (b) => units.has(b.unitId) && b.reportingPeriodId === inputs.period.id,
  );
}

/**
 * 算定に関わる割当: 算定する活動量の行が要る組（拠点 × 種類 × 活動 × 基準）ごとに、解決で選ばれる段
 * （拠点 ＞ 国 ＞ 全社既定）の割当だけ。算定する拠点の国に関係しない国の割当・より低い段の割当は結果を変えないため
 * 含めない（含めると、将来の拠点の準備で国の割当を足しただけで記録が「入力が変わった」になり、反映が止まる）
 */
function relevantAssignments(inputs: GhgCalculationInputs): EmissionFactorAssignment[] {
  const unitById = new Map(inputs.units.map((u) => [u.id, u]));
  const batchUnit = new Map(targetBatches(inputs).map((b) => [b.id, b.unitId]));
  const picked = new Map<string, EmissionFactorAssignment>();
  const seen = new Set<string>();
  for (const line of inputs.lines) {
    const unitId = batchUnit.get(line.batchId);
    const unit = unitId ? unitById.get(unitId) : undefined;
    if (!unit) continue;
    for (const need of factorNeedsOfLine(line)) {
      const key = [unit.id, need.kind, need.code, need.basis ?? ''].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const level = assignmentsAtResolvedLevel(
        {
          reportingPeriodId: inputs.period.id,
          unitId: unit.id,
          countryCode: unit.countryCode,
          activityKind: need.kind,
          activityCode: need.code,
          basis: need.basis,
        },
        inputs.assignments,
      );
      for (const a of level?.list ?? []) picked.set(a.id, a);
    }
  }
  return [...picked.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * 入力ハッシュ（並べ替えた正規 JSON の sha256）。結果を変えうる入力だけを含める:
 * 方針の中身・解決で選ばれる割当と係数の中身・係数のセットの状態（取り下げると記録は「入力が変わった」になり、
 * 取り下げたセットの値を Data Point へ反映しない。plan K6）・拠点の国（国の割当・国の不一致・海外拠点の輸送を決める）・
 * 効く区分規則の中身・活動量のバッチと行・エンジンの版
 */
export function computeInputHash(inputs: GhgCalculationInputs): string {
  const assignments = relevantAssignments(inputs);
  const factorIds = new Set(assignments.map((a) => a.factorId));
  const factors = inputs.factors
    .filter((f) => factorIds.has(f.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((f) => ({
      id: f.id,
      set: f.factorSetId,
      kind: f.activityKind,
      code: f.activityCode,
      basis: f.basis,
      country: f.countryCode,
      value: f.factorValue,
      unit: f.factorUnit,
      activityUnit: f.activityUnit,
      year: f.factorYear,
      calorific: [f.calorificValue, f.calorificUnit],
      carbon: [f.carbonFactor, f.carbonFactorUnit],
      params: f.params,
    }));
  const setIds = new Set(factors.map((f) => f.set));
  const sets = inputs.factorSets
    .filter((s) => setIds.has(s.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((s) => ({ id: s.id, code: s.code, version: s.versionLabel, status: s.status }));
  const batchIds = new Set(targetBatches(inputs).map((b) => b.id));
  const unitCountry = new Map(inputs.units.map((u) => [u.id, u.countryCode]));
  const lines = inputs.lines
    .filter((l) => batchIds.has(l.batchId))
    .map((l) => l.id)
    .sort();
  return sha256(
    canonicalJson({
      engine: GHG_ENGINE_VERSION,
      organizationId: inputs.organizationId,
      country: inputs.organizationCountryCode,
      period: inputs.period.id,
      units: [...inputs.unitIds].sort().map((id) => ({ id, country: unitCountry.get(id) ?? null })),
      policy: {
        rounding: inputs.policy.rounding,
        conversions: inputs.policy.conversions,
        tonkm: inputs.policy.tonkm,
      },
      assignments: assignments.map((a) => ({
        unit: a.unitId,
        country: a.countryCode,
        kind: a.activityKind,
        code: a.activityCode,
        basis: a.basis,
        factor: a.factorId,
      })),
      factors,
      sets,
      rules: effectiveRules(inputs.rules, inputs.period, inputs.periods).map((r) => ({
        id: r.id,
        match: r.match,
        protocol: r.protocolScope,
        reported: r.reportedScope,
      })),
      batches: [...batchIds].sort(),
      lines,
    }),
  );
}

// ----------------------------------------------------------------------
// 1 行の算定
// ----------------------------------------------------------------------

type LineDraft = Omit<
  GhgCalculationLine,
  | 'id'
  | 'runId'
  | 'organizationId'
  | 'createdAt'
  | 'emissionsRounded'
  | 'roundingApplied'
  | 'protocolScope'
  | 'reportedScope'
  | 'classificationRuleId'
>;

interface LineContext {
  inputs: GhgCalculationInputs;
  unit: Pick<OrganizationUnit, 'id' | 'code' | 'name' | 'countryCode'>;
  conversions: readonly UnitConversionRule[];
  shape: 'kokuji' | 'log';
  substitutions: GhgSubstitutions;
}

type Resolved = {
  factor: EmissionFactor;
  set: EmissionFactorSet;
  description: string;
};

function resolveFor(
  ctx: LineContext,
  line: GhgActivityLine,
  activityKind: FactorActivityKind,
  activityCode: string,
  basis: 'location' | 'market' | null,
  labelText: string,
): Resolved | { error: string } {
  const need: FactorNeed = {
    reportingPeriodId: ctx.inputs.period.id,
    unitId: ctx.unit.id,
    unitName: ctx.unit.name,
    countryCode: ctx.unit.countryCode,
    activityKind,
    activityCode,
    activityLabel: labelText,
    basis,
  };
  const resolved = resolveFactor(
    need,
    ctx.inputs.assignments,
    ctx.inputs.factors,
    ctx.inputs.factorSets,
  );
  if ('error' in resolved) {
    return { error: `${labelText}: ${RESOLUTION_ERROR_LABELS[resolved.error]}` };
  }
  const alternativeSetId = ctx.substitutions.factorSetId;
  if (alternativeSetId && resolved.factor.factorSetId !== alternativeSetId) {
    const alt = ctx.inputs.factors.find(
      (f) =>
        f.factorSetId === alternativeSetId &&
        f.activityKind === resolved.factor.activityKind &&
        f.activityCode === resolved.factor.activityCode &&
        (f.basis ?? null) === (resolved.factor.basis ?? null) &&
        (f.countryCode ?? null) === (resolved.factor.countryCode ?? null) &&
        f.gas === resolved.factor.gas,
    );
    const altSet = ctx.inputs.factorSets.find((s) => s.id === alternativeSetId);
    if (!alt || !altSet) {
      return { error: `${labelText}: 置き換える係数セットに同じ係数がありません` };
    }
    return {
      factor: alt,
      set: altSet,
      description: `仮説の再計算（${altSet.versionLabel}）`,
    };
  }
  void line;
  return { factor: resolved.factor, set: resolved.set, description: resolved.description };
}

interface Co2Result {
  tco2: number;
  /** t-CO2e / 換算後の活動量の単位 */
  effectiveFactorT: number;
  factorValue: number;
  factorUnit: string;
  detail: Record<string, unknown>;
}

/** 係数で CO2 にする（2 段係数があれば 2 段、無ければ 1 段）。換算後の量は係数の活動量の単位 */
function co2With(factor: EmissionFactor, converted: number): Co2Result | { error: string } {
  if (factor.calorificValue !== null && factor.carbonFactor !== null) {
    // 炭素排出係数が kgC/GJ なら tC/GJ に揃える
    const carbonUnit = (factor.carbonFactorUnit ?? 'tC/GJ').normalize('NFKC').toLowerCase();
    const carbon = carbonUnit.startsWith('kg') ? factor.carbonFactor / 1000 : factor.carbonFactor;
    const r = fuelToCo2({ amountKl: converted, calorific: factor.calorificValue, carbon });
    const effective = factor.calorificValue * carbon * CO2_PER_C;
    return {
      tco2: r.tco2,
      effectiveFactorT: effective,
      factorValue: effective,
      factorUnit: `t-CO2/${factor.activityUnit}`,
      detail: {
        calorificValue: factor.calorificValue,
        calorificUnit: factor.calorificUnit,
        carbonFactor: factor.carbonFactor,
        carbonFactorUnit: factor.carbonFactorUnit,
        gj: r.gj,
        tc: r.tc,
      },
    };
  }
  const split = splitFactorUnit(factor.factorUnit);
  if (!split) return { error: `係数の単位（${factor.factorUnit}）を読めません` };
  const toT = emissionToTonnes(split.emission);
  const r = fuelToCo2({ amount: converted, directFactor: factor.factorValue * toT });
  return {
    tco2: r.tco2,
    effectiveFactorT: factor.factorValue * toT,
    factorValue: factor.factorValue,
    factorUnit: factor.factorUnit,
    detail: {},
  };
}

function convertTo(
  ctx: LineContext,
  amount: number,
  from: string,
  to: string,
): { value: number; steps: ConversionStep[] } | { error: string } {
  const r = convert(amount, from, to, ctx.conversions);
  if ('error' in r) {
    const reason =
      r.error === 'dimension_mismatch'
        ? `単位 ${from} を係数の単位 ${to} に換算できません（組織の換算がありません）`
        : r.error === 'ambiguous_conversion'
          ? `単位 ${from} から ${to} への組織の換算が 2 つ以上あります`
          : `単位（${from} または ${to}）を読めません`;
    return { error: reason };
  }
  return r;
}

function baseDraft(
  line: GhgActivityLine,
  unitId: string,
): Pick<LineDraft, 'unitId' | 'month' | 'activityLineId' | 'activityKind' | 'activityCode'> {
  return {
    unitId,
    month: line.month,
    activityLineId: line.id,
    activityKind: line.activityKind,
    activityCode: line.activityCode,
  };
}

function factorSnapshot(
  r: Resolved,
): Pick<
  LineDraft,
  'factorId' | 'factorYear' | 'factorSetCode' | 'factorSetVersion' | 'resolutionPath'
> {
  return {
    factorId: r.factor.id,
    factorYear: r.factor.factorYear,
    factorSetCode: r.set.code,
    factorSetVersion: r.set.versionLabel,
    resolutionPath: r.description,
  };
}

function computeFuelLike(
  ctx: LineContext,
  line: GhgActivityLine,
  method: GhgMethod,
  kind: FactorActivityKind,
  code: string,
): LineDraft[] | { error: string } {
  if (line.amount === null || !line.unit) return { error: '活動量または単位がありません' };
  const label = ACTIVITY_CODE_LABELS[code] ?? code;
  const resolved = resolveFor(ctx, line, kind, code, null, label);
  if ('error' in resolved) return resolved;
  const converted = convertTo(ctx, line.amount, line.unit, resolved.factor.activityUnit);
  if ('error' in converted) return converted;
  const co2 = co2With(resolved.factor, converted.value);
  if ('error' in co2) return co2;
  return [
    {
      ...baseDraft(line, ctx.unit.id),
      method,
      activityAmount: line.amount,
      activityUnit: line.unit,
      convertedAmount: converted.value,
      convertedUnit: resolved.factor.activityUnit,
      conversionSteps: converted.steps,
      factorValue: co2.factorValue,
      factorUnit: co2.factorUnit,
      ...factorSnapshot(resolved),
      methodDetail: { ...co2.detail, effectiveFactorT: co2.effectiveFactorT },
      emissionsUnrounded: co2.tco2,
      warnings: [],
    },
  ];
}

/**
 * 購入したエネルギー（電力・熱）。ロケーション基準とマーケット基準で 1 行ずつ（決して足さない。plan K7）。
 * 係数の組は factorNeedsOfLine と同じ（電力のマーケット基準は契約のコード、熱は活動のコード）
 */
function computePurchasedEnergy(
  ctx: LineContext,
  line: GhgActivityLine,
): LineDraft[] | { error: string } {
  const electricity = line.activityKind === 'electricity';
  const noun = electricity ? '電力' : '購入した熱';
  if (line.amount === null || !line.unit) {
    return { error: electricity ? '電力量または単位がありません' : '熱量または単位がありません' };
  }
  const out: LineDraft[] = [];
  const methods: Record<'location' | 'market', GhgMethod> = electricity
    ? { location: 'electricity_location', market: 'electricity_market' }
    : { location: 'heat_location', market: 'heat_market' };
  const kind: FactorActivityKind = electricity ? 'electricity' : 'heat';
  for (const need of factorNeedsOfLine(line)) {
    const basis = need.basis === 'market' ? 'market' : 'location';
    const method = methods[basis];
    const code = need.code;
    const label = `${noun}（${basis === 'location' ? 'ロケーション基準' : 'マーケット基準'}）`;
    const resolved = resolveFor(ctx, line, kind, code, basis, label);
    if ('error' in resolved) return resolved;
    const converted = convertTo(ctx, line.amount, line.unit, resolved.factor.activityUnit);
    if ('error' in converted) return converted;
    const co2 = co2With(resolved.factor, converted.value);
    if ('error' in co2) return co2;
    out.push({
      ...baseDraft(line, ctx.unit.id),
      method,
      activityAmount: line.amount,
      activityUnit: line.unit,
      convertedAmount: converted.value,
      convertedUnit: resolved.factor.activityUnit,
      conversionSteps: converted.steps,
      factorValue: co2.factorValue,
      factorUnit: co2.factorUnit,
      ...factorSnapshot(resolved),
      methodDetail: {
        ...co2.detail,
        effectiveFactorT: co2.effectiveFactorT,
        basis,
        contractCode: basis === 'market' ? line.contractCode : null,
      },
      emissionsUnrounded: co2.tco2,
      warnings: [],
    });
  }
  return out;
}

function isFormulaParams(value: unknown): value is TransportFormulaParams {
  const v = value as TransportFormulaParams | null;
  return (
    !!v &&
    typeof v === 'object' &&
    typeof v.S === 'number' &&
    !!v.classes &&
    typeof v.classes === 'object'
  );
}

function isDefaultParams(value: unknown): value is TransportDefaultParams {
  const v = value as TransportDefaultParams | null;
  return !!v && typeof v === 'object' && Array.isArray(v.table);
}

function computeTransport(
  ctx: LineContext,
  line: GhgActivityLine,
): LineDraft[] | { error: string } {
  const fuelCode = line.fuelCode ?? line.activityCode;
  const hasTonKmData =
    line.tonKm !== null || (line.cargoWeightT !== null && line.distanceKm !== null);
  if (!hasTonKmData) {
    // 燃料法（自社便など、燃料の使用量が分かる輸送）
    return computeFuelLike(ctx, line, 'fuel_method', 'fuel', fuelCode);
  }
  const tkm = tonKm(line);
  if (typeof tkm !== 'number') return { error: '輸送トンキロ（重量×距離か t·km）がありません' };
  const label = ACTIVITY_CODE_LABELS[fuelCode] ?? fuelCode;
  const measured = line.loadFactorPct !== null;
  const intensityFactor = resolveFor(
    ctx,
    line,
    measured ? 'transport_formula' : 'transport_default',
    fuelCode,
    null,
    measured ? `改良トンキロ法の式（${label}）` : `見なし積載率の原単位表（${label}）`,
  );
  if ('error' in intensityFactor) return intensityFactor;
  const params = intensityFactor.factor.params;
  if (measured && !isFormulaParams(params))
    return { error: '改良トンキロ法の式の係数の形が不正です' };
  if (!measured && !isDefaultParams(params))
    return { error: '見なし積載率の原単位表の形が不正です' };
  const overseas = ctx.unit.countryCode !== ctx.inputs.organizationCountryCode;
  const intensity = fuelIntensity(
    {
      formula: measured ? (params as unknown as TransportFormulaParams) : undefined,
      defaults: measured ? undefined : (params as unknown as TransportDefaultParams),
      policy: { ...ctx.inputs.policy.tonkm, shape: ctx.shape },
    },
    {
      fuelEconomyClass: line.fuelEconomyClass,
      maxPayloadKg: line.maxPayloadKg,
      loadFactorPct: line.loadFactorPct,
      vehicleUse: line.vehicleUse,
      overseas,
    },
  );
  if ('error' in intensity) return { error: INTENSITY_ERROR_LABELS[intensity.error] };
  const liters = transportFuelLiters(tkm, intensity.value);
  const fuelFactor = resolveFor(ctx, line, 'fuel', fuelCode, null, label);
  if ('error' in fuelFactor) return fuelFactor;
  const converted = convertTo(ctx, liters, 'L', fuelFactor.factor.activityUnit);
  if ('error' in converted) return converted;
  const co2 = co2With(fuelFactor.factor, converted.value);
  if ('error' in co2) return co2;
  // 対数式に切り替えたときの原単位の比（照合の「算定方法」の差を説明するため。係数セットに lnA があるときだけ）
  let logRatio: number | null = null;
  if (measured && ctx.shape === 'kokuji') {
    const alt = fuelIntensity(
      {
        formula: params as unknown as TransportFormulaParams,
        policy: { ...ctx.inputs.policy.tonkm, shape: 'log' },
      },
      {
        fuelEconomyClass: line.fuelEconomyClass,
        maxPayloadKg: line.maxPayloadKg,
        loadFactorPct: line.loadFactorPct,
        vehicleUse: line.vehicleUse,
        overseas,
      },
    );
    if ('raw' in alt) logRatio = alt.value / intensity.value;
  }
  return [
    {
      ...baseDraft(line, ctx.unit.id),
      method: 'tonkm_improved',
      activityAmount: tkm,
      activityUnit: 'tkm',
      convertedAmount: converted.value,
      convertedUnit: fuelFactor.factor.activityUnit,
      conversionSteps: converted.steps,
      factorValue: co2.factorValue,
      factorUnit: co2.factorUnit,
      ...factorSnapshot(fuelFactor),
      methodDetail: {
        ...co2.detail,
        effectiveFactorT: co2.effectiveFactorT,
        tonKm: tkm,
        intensityRaw: intensity.raw,
        intensity: intensity.value,
        intensitySource: intensity.source,
        shape: intensity.shape,
        loadFactorUsed: intensity.loadFactorUsed,
        loadFactorSource: intensity.loadFactorSource,
        coefficients: intensity.coefficients,
        fuelLiters: liters,
        fuelCode,
        intensityFactorId: intensityFactor.factor.id,
        intensityResolutionPath: intensityFactor.description,
        overseas,
        logRatio,
      },
      emissionsUnrounded: co2.tco2,
      warnings: [...intensity.warnings],
    },
  ];
}

function computeLine(ctx: LineContext, line: GhgActivityLine): LineDraft[] | { error: string } {
  switch (line.activityKind) {
    case 'fuel':
      return computeFuelLike(ctx, line, 'fuel_combustion', 'fuel', line.activityCode);
    case 'gas':
      return computeFuelLike(ctx, line, 'fuel_combustion', 'gas', line.activityCode);
    case 'heat':
    case 'electricity':
      return computePurchasedEnergy(ctx, line);
    case 'transport':
      return computeTransport(ctx, line);
  }
}

// ----------------------------------------------------------------------
// 記録全体
// ----------------------------------------------------------------------

function viewSummary(
  lines: readonly GhgCalculationLine[],
  view: 'reported' | 'protocol',
  rules: readonly RoundingRule[],
): GhgViewSummary {
  const stages = applyRoundingStages(
    lines.map((l) => ({
      unitId: l.unitId,
      month: l.month,
      activityKind: l.activityKind,
      scope: view === 'reported' ? l.reportedScope : l.protocolScope,
      value: l.emissionsUnrounded,
    })),
    rules,
  );
  return {
    sites: stages.siteScopes.map((s) => ({
      unitId: s.unitId,
      scope: s.scope,
      unrounded: s.unrounded,
      rounded: s.rounded,
    })),
    siteActivities: stages.siteActivities.map((s) => ({
      unitId: s.unitId,
      scope: s.scope,
      activityKind: s.activityKind,
      unrounded: s.unrounded,
      rounded: s.rounded,
    })),
    totals: stages.totals.map((t) => ({
      scope: t.scope,
      unrounded: t.unrounded,
      rounded: t.rounded,
    })),
  };
}

/** 記録の要約（報告区分・既定区分の 2 つの見方・再分類分・警告件数） */
export function summarizeLines(
  lines: readonly GhgCalculationLine[],
  rules: readonly RoundingRule[],
): GhgRunSummary {
  const reclassified = new Map<string, GhgRunSummary['reclassified'][number]>();
  const warningCounts: Record<string, number> = {};
  for (const line of lines) {
    if (line.warnings.length > 0)
      warningCounts[line.unitId] = (warningCounts[line.unitId] ?? 0) + 1;
    if (line.classificationRuleId && line.reportedScope !== line.protocolScope) {
      const key = `${line.unitId}|${line.classificationRuleId}|${line.protocolScope}|${line.reportedScope}`;
      const entry = reclassified.get(key) ?? {
        unitId: line.unitId,
        ruleId: line.classificationRuleId,
        from: line.protocolScope,
        to: line.reportedScope,
        unrounded: 0,
      };
      entry.unrounded = cleanFloat(entry.unrounded + line.emissionsUnrounded);
      reclassified.set(key, entry);
    }
  }
  return {
    reported: viewSummary(lines, 'reported', rules),
    protocol: viewSummary(lines, 'protocol', rules),
    reclassified: [...reclassified.values()],
    warningCounts,
  };
}

/**
 * 算定を実行する（保存しない）。runId は記録の ID（行の ID の元）。エラーがあれば errors に入れ、その行は作らない
 */
export function calculateRun(
  inputs: GhgCalculationInputs,
  options: { runId: string; createdAt: string; substitutions?: GhgSubstitutions },
): GhgCalculationOutput {
  const substitutions = options.substitutions ?? {};
  const conversions = substitutions.noConversions
    ? inputs.policy.conversions.map((c) => ({
        ...c,
        multiplier: 1,
        source: `${c.source}（換算なし）`,
      }))
    : inputs.policy.conversions;
  const rounding = substitutions.rounding ?? inputs.policy.rounding;
  const shape = substitutions.shape ?? inputs.policy.tonkm.shape;
  const rules = substitutions.noClassificationRules
    ? []
    : effectiveRules(inputs.rules, inputs.period, inputs.periods);
  const batchById = new Map(inputs.batches.map((b) => [b.id, b]));
  const targetBatchIds = new Set(targetBatches(inputs).map((b) => b.id));
  const unitById = new Map(inputs.units.map((u) => [u.id, u]));

  const activityLines = inputs.lines
    .filter((l) => targetBatchIds.has(l.batchId))
    .sort((a, b) => {
      const ua = batchById.get(a.batchId)!.unitId;
      const ub = batchById.get(b.batchId)!.unitId;
      const ia = inputs.unitIds.indexOf(ua);
      const ib = inputs.unitIds.indexOf(ub);
      if (ia !== ib) return ia - ib;
      if (a.batchId !== b.batchId) return a.batchId < b.batchId ? -1 : 1;
      return a.lineNo - b.lineNo;
    });

  const lineRule = ruleFor(rounding, 'line');
  const out: GhgCalculationLine[] = [];
  const errors: GhgCalcError[] = [];
  const usedSetIds = new Set<string>();
  for (const line of activityLines) {
    const batch = batchById.get(line.batchId)!;
    const unit = unitById.get(batch.unitId);
    if (!unit) {
      errors.push({
        activityLineId: line.id,
        unitId: batch.unitId,
        code: 'unknown_unit',
        message: '拠点が見つかりません',
      });
      continue;
    }
    const ctx: LineContext = { inputs, unit, conversions, shape, substitutions };
    const drafts = computeLine(ctx, line);
    if ('error' in drafts) {
      errors.push({
        activityLineId: line.id,
        unitId: unit.id,
        code: 'line_error',
        message: `${unit.name}・${line.month.slice(0, 7)}・${activityLabel(line.activityKind, line.activityCode)}（${line.lineNo} 行目）: ${drafts.error}`,
      });
      continue;
    }
    for (const draft of drafts) {
      const cls = classify(
        {
          unitId: unit.id,
          activityKind: draft.activityKind,
          method: draft.method,
          carrierKind: line.carrierKind,
          cargoKind: line.cargoKind,
        },
        rules,
        inputs.period,
        inputs.periods,
      );
      if (cls.conflict) {
        errors.push({
          activityLineId: line.id,
          unitId: unit.id,
          code: 'classification_conflict',
          message: `${unit.name}・${line.month.slice(0, 7)}: 当てはまる区分規則が 2 つ以上あります`,
        });
        continue;
      }
      const factor = inputs.factors.find((f) => f.id === draft.factorId);
      if (factor?.factorSetId) usedSetIds.add(factor.factorSetId);
      const intensityFactorId = draft.methodDetail.intensityFactorId;
      if (typeof intensityFactorId === 'string') {
        const f = inputs.factors.find((x) => x.id === intensityFactorId);
        if (f?.factorSetId) usedSetIds.add(f.factorSetId);
      }
      const unrounded = draft.emissionsUnrounded;
      out.push({
        ...draft,
        id: fid('ghg_line', `${options.runId}/${out.length + 1}`),
        organizationId: inputs.organizationId,
        runId: options.runId,
        emissionsRounded: lineRule ? roundEmission(cleanFloat(unrounded), lineRule) : unrounded,
        roundingApplied: lineRule
          ? { stage: 'line', digits: lineRule.digits, unit: lineRule.unit, method: lineRule.method }
          : null,
        protocolScope: cls.protocolScope,
        reportedScope: cls.reportedScope,
        classificationRuleId: cls.ruleId,
        createdAt: options.createdAt,
      });
    }
  }

  const usedBatchIds = [...targetBatchIds].sort();
  return {
    lines: out,
    summary: summarizeLines(out, rounding),
    inputHash: computeInputHash(inputs),
    engineVersion: GHG_ENGINE_VERSION,
    errors,
    factorSetIds: [...usedSetIds].sort(),
    ruleIds: rules.map((r) => r.id),
    activityBatchIds: usedBatchIds,
  };
}

/** 仮説の再計算（保存しない）。照合の「仮説の再計算」と原因の絞り込みに使う */
export function recalculate(
  inputs: GhgCalculationInputs,
  substitutions: GhgSubstitutions,
  options: { runId: string; createdAt: string },
): GhgCalculationOutput {
  return calculateRun(inputs, { ...options, substitutions });
}

/** 区分（scope）の表示の語 */
export const GHG_SCOPE_LABELS: Readonly<Record<GhgScope, string>> = {
  scope1: 'Scope1',
  scope2: 'Scope2（マーケット基準）',
  scope2_location: 'Scope2（ロケーション基準）',
  scope3_cat4: 'Scope3 カテゴリ4',
};

/** 算定方法の表示の語 */
export const GHG_METHOD_LABELS: Readonly<Record<GhgMethod, string>> = {
  fuel_combustion: '燃料の燃焼',
  electricity_location: '電力（ロケーション基準）',
  electricity_market: '電力（マーケット基準）',
  heat_location: '購入した熱（ロケーション基準）',
  heat_market: '購入した熱（マーケット基準）',
  tonkm_improved: '改良トンキロ法',
  fuel_method: '燃料法',
};

/** 換算後の単位が読めるか（取込の検査にも使う） */
export function isKnownUnit(raw: string | null | undefined): boolean {
  return parseUnit(raw) !== null;
}
