import type { ConversionStep, UnitConversionRule } from '@/types/domain';

/**
 * 次元つきの単位と換算（plan §2.2・CR-03）。純関数。
 *
 *  - 同じ次元の中だけ内蔵の換算を使う（L・kL・m3・gal〔US〕／Nm3・千Nm3／kg・t／kWh・MWh／MJ・GJ／km／t·km／
 *    kg-CO2・t-CO2・kg-CO2e・t-CO2e）。gal→L は定義値 3.785411784
 *  - **次元をまたぐ換算（m3→Nm3・L→kg・MWh→GJ など）は組織の方針（conversions）だけ**。無ければエラー
 *    （Nm3 を m3 と同一視するなど、黙って同一視しない。既存の Cat.1 の取込の同一視とは別の規則）
 *  - 換算の段を残す（builtin か policy:出典）。照合で「単位換算」の差の原因を示すのに使う
 */

export type UnitDimension =
  'volume' | 'std_volume' | 'mass' | 'electricity' | 'heat' | 'distance' | 'transport' | 'emission';

export interface UnitDef {
  code: string;
  dimension: UnitDimension;
  /** 次元の基準単位への倍率（L・Nm3・kg・kWh・MJ・km・t·km・kg-CO2e） */
  toBase: number;
}

const UNITS: readonly UnitDef[] = [
  { code: 'L', dimension: 'volume', toBase: 1 },
  { code: 'kL', dimension: 'volume', toBase: 1000 },
  { code: 'm3', dimension: 'volume', toBase: 1000 },
  { code: 'gal', dimension: 'volume', toBase: 3.785411784 },
  { code: 'Nm3', dimension: 'std_volume', toBase: 1 },
  { code: 'kNm3', dimension: 'std_volume', toBase: 1000 },
  { code: 'kg', dimension: 'mass', toBase: 1 },
  { code: 't', dimension: 'mass', toBase: 1000 },
  { code: 'kWh', dimension: 'electricity', toBase: 1 },
  { code: 'MWh', dimension: 'electricity', toBase: 1000 },
  { code: 'MJ', dimension: 'heat', toBase: 1 },
  { code: 'GJ', dimension: 'heat', toBase: 1000 },
  { code: 'km', dimension: 'distance', toBase: 1 },
  { code: 'tkm', dimension: 'transport', toBase: 1 },
  // CO2 だけの係数（GWP 1）と CO2e の係数は同じ次元として扱う（ガス別の係数は未対応）
  { code: 'kg-CO2', dimension: 'emission', toBase: 1 },
  { code: 't-CO2', dimension: 'emission', toBase: 1000 },
  { code: 'kg-CO2e', dimension: 'emission', toBase: 1 },
  { code: 't-CO2e', dimension: 'emission', toBase: 1000 },
];

const BY_CODE = new Map(UNITS.map((u) => [u.code.toLowerCase(), u]));

/** 表記ゆれの読み替え（正規化した文字列 → 単位コード） */
const ALIASES: Readonly<Record<string, string>> = {
  l: 'L',
  ℓ: 'L',
  リットル: 'L',
  kl: 'kL',
  キロリットル: 'kL',
  m3: 'm3',
  立方メートル: 'm3',
  gal: 'gal',
  usgal: 'gal',
  ガロン: 'gal',
  nm3: 'Nm3',
  千nm3: 'kNm3',
  knm3: 'kNm3',
  kg: 'kg',
  キログラム: 'kg',
  t: 't',
  トン: 't',
  kwh: 'kWh',
  mwh: 'MWh',
  mj: 'MJ',
  gj: 'GJ',
  km: 'km',
  tkm: 'tkm',
  トンキロ: 'tkm',
  kgco2: 'kg-CO2',
  tco2: 't-CO2',
  kgco2e: 'kg-CO2e',
  tco2e: 't-CO2e',
};

function normalizeToken(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[₂²]/g, '2')
    .replace(/[³]/g, '3')
    .replace(/㎥/g, 'm3')
    .replace(/[\s·・\-‐−_/]/g, '')
    .replace(/^us/i, 'us')
    .toLowerCase();
}

/** 単位の文字列を読む（読めなければ null） */
export function parseUnit(raw: string | null | undefined): UnitDef | null {
  if (!raw) return null;
  const token = normalizeToken(raw);
  if (token === '') return null;
  const code = ALIASES[token] ?? BY_CODE.get(token)?.code;
  if (!code) return null;
  return BY_CODE.get(code.toLowerCase()) ?? null;
}

/** 同じ単位か（表記ゆれを吸収して比べる） */
export function sameUnit(a: string | null | undefined, b: string | null | undefined): boolean {
  const ua = parseUnit(a);
  const ub = parseUnit(b);
  return !!ua && !!ub && ua.code === ub.code;
}

export type ConvertResult =
  | { value: number; steps: ConversionStep[] }
  | { error: 'unknown_unit' | 'dimension_mismatch' | 'ambiguous_conversion' };

function builtinStep(
  value: number,
  from: UnitDef,
  to: UnitDef,
): { value: number; step: ConversionStep | null } {
  if (from.code === to.code) return { value, step: null };
  // 掛けてから割る（0.001 を掛けるより 1000 で割るほうが 10 進の値に近い）
  const converted = (value * from.toBase) / to.toBase;
  return {
    value: converted,
    step: { from: from.code, to: to.code, factor: from.toBase / to.toBase, source: 'builtin' },
  };
}

/**
 * 換算する。同じ次元は内蔵の換算、次元をまたぐときは組織の方針の換算（前後に内蔵の換算をつなげる）。
 * 方針の換算が無い・2 つ以上当てはまるときはエラー
 */
export function convert(
  amount: number,
  fromRaw: string,
  toRaw: string,
  rules: readonly UnitConversionRule[],
): ConvertResult {
  const from = parseUnit(fromRaw);
  const to = parseUnit(toRaw);
  if (!from || !to) return { error: 'unknown_unit' };
  if (from.dimension === to.dimension) {
    const { value, step } = builtinStep(amount, from, to);
    return { value, steps: step ? [step] : [] };
  }
  const candidates = rules.filter((rule) => {
    const rf = parseUnit(rule.from);
    const rt = parseUnit(rule.to);
    return !!rf && !!rt && rf.dimension === from.dimension && rt.dimension === to.dimension;
  });
  if (candidates.length === 0) return { error: 'dimension_mismatch' };
  if (candidates.length > 1) return { error: 'ambiguous_conversion' };
  const rule = candidates[0]!;
  const ruleFrom = parseUnit(rule.from)!;
  const ruleTo = parseUnit(rule.to)!;
  const steps: ConversionStep[] = [];
  const first = builtinStep(amount, from, ruleFrom);
  if (first.step) steps.push(first.step);
  const middle = first.value * rule.multiplier;
  steps.push({
    from: ruleFrom.code,
    to: ruleTo.code,
    factor: rule.multiplier,
    source: `policy:${rule.source}`,
  });
  const last = builtinStep(middle, ruleTo, to);
  if (last.step) steps.push(last.step);
  return { value: last.value, steps };
}

/**
 * 係数の単位（例 't-CO2/kL'・'kg-CO2e/kWh'）を、排出量の単位と活動量の単位に分ける
 */
export function splitFactorUnit(raw: string): { emission: UnitDef; activity: UnitDef } | null {
  const index = raw.lastIndexOf('/');
  if (index <= 0) return null;
  const emission = parseUnit(raw.slice(0, index));
  const activity = parseUnit(raw.slice(index + 1));
  if (!emission || emission.dimension !== 'emission' || !activity) return null;
  return { emission, activity };
}

/** 排出量の値を t-CO2e に揃える倍率（kg なら 0.001） */
export function emissionToTonnes(unit: UnitDef): number {
  return unit.toBase / 1000;
}
