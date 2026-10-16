import { roundSignificant } from './rounding';
import type { FuelEconomyClass, TonKmPolicy, VehicleUse } from '@/types/domain';

/**
 * 改良トンキロ法（plan §2.2 tonkm.ts・CR-06）。純関数。
 *
 * 式の形だけがコード: 告示の形 x = A ÷ (y/100)^S ÷ z^B（x: L/(t·km)、y: 積載率 %、z: 最大積載量 kg）、
 * 対数式 x = e^lnA ÷ (y/100)^S ÷ z^B（比較用）。A・B・S・lnA・燃費区分ごとの係数・見なし積載率の原単位表は
 * すべて引数（係数セットの transport_formula・transport_default の行の params）。積載率の下限・100% 超の扱い・
 * 最大積載量の範囲・海外拠点の扱い・原単位の丸めは組織の方針（TonKmPolicy）。
 *
 * 公的資料で扱いを確認できなかったもの（100% 超・式の範囲外・海外）は、方針が「止める」か「警告して算定」を
 * 決める。黙って計算しない（plan K5・K6）。
 */

/** 燃費区分ごとの式の係数（transport_formula の行の params） */
export interface TransportFormulaClass {
  A: number;
  B: number;
  /** 対数式の定数（任意。対数式で算定するときだけ要る） */
  lnA?: number;
  /** この区分の式を当てる最大積載量の範囲（kg。任意） */
  payloadMinKg?: number | null;
  payloadMaxKg?: number | null;
}

export interface TransportFormulaParams {
  /** 積載率の指数（軽油 0.812・揮発油 0.927 は告示の値。係数セットに持つ） */
  S: number;
  classes: Partial<Record<FuelEconomyClass, TransportFormulaClass>>;
}

/** 見なし積載率の原単位表の 1 行（事業用・自家用 × 最大積載量の区分。値は燃費区分ごと） */
export interface TransportDefaultRow {
  vehicleUse: VehicleUse;
  /** 最大積載量の区分（minKg 以上 maxKg 未満。null は下限・上限なし） */
  minKg: number | null;
  maxKg: number | null;
  /** 見なし積載率（%） */
  loadPct: number;
  /** L/(t·km)。区分が無い（表の「—」）燃費区分は持たない */
  values: Partial<Record<FuelEconomyClass, number>>;
}

export interface TransportDefaultParams {
  table: TransportDefaultRow[];
}

export interface IntensityRow {
  fuelEconomyClass: FuelEconomyClass | null;
  maxPayloadKg: number | null;
  loadFactorPct: number | null;
  vehicleUse: VehicleUse | null;
  /** 組織の国と違う国の拠点の輸送か（改良トンキロ法は国内のトラック輸送の方法） */
  overseas: boolean;
}

export type IntensityWarning =
  | 'default_load_factor'
  | 'load_floored'
  | 'load_capped'
  | 'payload_out_of_range'
  | 'overseas_transport';

export type IntensityError =
  | 'no_formula'
  | 'no_default_table'
  | 'no_formula_for_class'
  | 'no_log_coefficient'
  | 'no_default_value'
  | 'no_payload'
  | 'no_economy_class'
  | 'load_over_100'
  | 'invalid_load_factor'
  | 'payload_out_of_range'
  | 'overseas_blocked';

export interface IntensityResult {
  /** 未丸めの原単位（L/(t·km)） */
  raw: number;
  /** 算定に使う原単位（方針の有効数字で丸めた値。丸めなければ raw） */
  value: number;
  source: 'formula' | 'default_table';
  shape: 'kokuji' | 'log' | null;
  /** 算定に使った積載率（%） */
  loadFactorUsed: number;
  loadFactorSource: 'measured' | 'default' | 'floored';
  coefficients: { A: number | null; B: number | null; S: number | null; lnA: number | null };
  warnings: IntensityWarning[];
}

function inRange(value: number, min: number | null | undefined, max: number | null | undefined) {
  return (
    (min === null || min === undefined || value >= min) &&
    (max === null || max === undefined || value < max)
  );
}

function roundIntensity(raw: number, policy: TonKmPolicy): number {
  return policy.intensityRounding
    ? roundSignificant(raw, policy.intensityRounding.significant, policy.intensityRounding.method)
    : raw;
}

/**
 * 燃料使用原単位（L/(t·km)）。積載率が分かれば式、分からなければ見なし積載率の原単位表
 */
export function fuelIntensity(
  params: {
    formula?: TransportFormulaParams;
    defaults?: TransportDefaultParams;
    policy: TonKmPolicy;
  },
  row: IntensityRow,
): IntensityResult | { error: IntensityError } {
  const { policy } = params;
  const warnings: IntensityWarning[] = [];
  if (row.overseas) {
    if (policy.overseas === 'block') return { error: 'overseas_blocked' };
    warnings.push('overseas_transport');
  }
  const economyClass = row.fuelEconomyClass;
  if (!economyClass) return { error: 'no_economy_class' };

  if (row.loadFactorPct === null) {
    if (!params.defaults) return { error: 'no_default_table' };
    if (row.maxPayloadKg === null) return { error: 'no_payload' };
    const payload = row.maxPayloadKg;
    const use = row.vehicleUse ?? 'commercial';
    const entry = params.defaults.table.find(
      (r) => r.vehicleUse === use && inRange(payload, r.minKg, r.maxKg),
    );
    const tableValue = entry?.values[economyClass];
    if (!entry || tableValue === undefined) return { error: 'no_default_value' };
    warnings.push('default_load_factor');
    return {
      raw: tableValue,
      value: roundIntensity(tableValue, policy),
      source: 'default_table',
      shape: null,
      loadFactorUsed: entry.loadPct,
      loadFactorSource: 'default',
      coefficients: { A: null, B: null, S: null, lnA: null },
      warnings,
    };
  }

  if (!params.formula) return { error: 'no_formula' };
  const coefficients = params.formula.classes[economyClass];
  if (!coefficients) return { error: 'no_formula_for_class' };
  if (row.maxPayloadKg === null || !(row.maxPayloadKg > 0)) return { error: 'no_payload' };
  const payload = row.maxPayloadKg;
  if (!(row.loadFactorPct > 0)) return { error: 'invalid_load_factor' };

  const outOfClassRange = !inRange(payload, coefficients.payloadMinKg, coefficients.payloadMaxKg);
  const outOfPolicyRange =
    (policy.payloadRangeKg.min !== null && payload < policy.payloadRangeKg.min) ||
    (policy.payloadRangeKg.max !== null && payload > policy.payloadRangeKg.max);
  if (outOfClassRange || outOfPolicyRange) {
    if (policy.payloadOutOfRange === 'error') return { error: 'payload_out_of_range' };
    warnings.push('payload_out_of_range');
  }

  let load = row.loadFactorPct;
  let loadSource: IntensityResult['loadFactorSource'] = 'measured';
  if (load > 100) {
    if (policy.over100 === 'error') return { error: 'load_over_100' };
    load = 100;
    warnings.push('load_capped');
  }
  if (load < policy.minLoadPct) {
    load = policy.minLoadPct;
    loadSource = 'floored';
    warnings.push('load_floored');
  }

  let A = coefficients.A;
  if (policy.shape === 'log') {
    if (coefficients.lnA === undefined) return { error: 'no_log_coefficient' };
    A = Math.exp(coefficients.lnA);
  }
  const S = params.formula.S;
  const raw = A / (load / 100) ** S / payload ** coefficients.B;
  return {
    raw,
    value: roundIntensity(raw, policy),
    source: 'formula',
    shape: policy.shape,
    loadFactorUsed: load,
    loadFactorSource: loadSource,
    coefficients: { A: coefficients.A, B: coefficients.B, S, lnA: coefficients.lnA ?? null },
    warnings,
  };
}

/** 輸送トンキロ（重量 t × 距離 km。入力の t·km があればそれを使う） */
export function tonKm(row: {
  cargoWeightT: number | null;
  distanceKm: number | null;
  tonKm: number | null;
}): number | { error: 'no_ton_km' } {
  if (row.tonKm !== null && Number.isFinite(row.tonKm)) return row.tonKm;
  if (
    row.cargoWeightT !== null &&
    row.distanceKm !== null &&
    Number.isFinite(row.cargoWeightT) &&
    Number.isFinite(row.distanceKm)
  ) {
    return row.cargoWeightT * row.distanceKm;
  }
  return { error: 'no_ton_km' };
}

/** 燃料使用量（L） = t·km × 原単位（L/(t·km)） */
export function transportFuelLiters(tonKmValue: number, intensity: number): number {
  return tonKmValue * intensity;
}
