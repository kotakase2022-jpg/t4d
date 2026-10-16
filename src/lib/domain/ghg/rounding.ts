import type {
  GhgActivityKind,
  GhgScope,
  RoundingMethod,
  RoundingRule,
  RoundingStage,
} from '@/types/domain';

/**
 * 丸め（plan §2.2・CR-04）。純関数（DB・画面に依存しない）。
 *
 * 10 進で丸める: 値を最短の 10 進表記（String(v)。JS の数値を一意に表す最短の桁）として扱い、
 * 桁をずらした整数（BigInt）で端数を判定する。`Math.round(v * 100) / 100` は 1.005 を 1.00 にする
 * （1.005 の 2 進表現が 1.00499… のため）。既存の算定（表計算）は 10 進の表記で丸めるため、
 * 同じ規則で丸めないと照合で丸めの差が作り出されてしまう。
 *
 * 方式: half_up（0 から遠い側）・half_even（偶数側）・floor（小さい側）・ceil（大きい側）・truncate（0 の側）
 */

const TEN = 10n;

function pow10(n: number): bigint {
  return TEN ** BigInt(n);
}

/** 10 進表記の分解（|v| = digits × 10^exponent。digits は先頭の 0 を持たない整数） */
function decompose(value: number): { negative: boolean; digits: bigint; exponent: number } {
  const text = String(Math.abs(value));
  const [mantissa = '0', expText] = text.split(/e/i);
  const exponent = expText ? Number(expText) : 0;
  const [intPart = '0', fracPart = ''] = mantissa.split('.');
  const digitText = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, '');
  return {
    negative: value < 0,
    digits: BigInt(digitText === '' ? '0' : digitText),
    exponent: exponent - fracPart.length,
  };
}

/** 整数 n（符号付き）× 10^(-scale) を数値へ（最も近い倍精度。文字列から作る） */
function toNumber(n: bigint, scale: number): number {
  if (n === 0n) return 0;
  return Number(`${n.toString()}e${-scale}`);
}

function roundQuotient(
  quotient: bigint,
  remainder: bigint,
  divisor: bigint,
  negative: boolean,
  method: RoundingMethod,
): bigint {
  if (remainder === 0n) return quotient;
  const twice = remainder * 2n;
  switch (method) {
    case 'half_up':
      return twice >= divisor ? quotient + 1n : quotient;
    case 'half_even':
      if (twice > divisor) return quotient + 1n;
      if (twice < divisor) return quotient;
      return quotient % 2n === 0n ? quotient : quotient + 1n;
    case 'truncate':
      return quotient;
    case 'floor':
      // 絶対値で計算しているため、負数は 0 から遠い側（絶対値を 1 増やす）が小さい側
      return negative ? quotient + 1n : quotient;
    case 'ceil':
      return negative ? quotient : quotient + 1n;
  }
}

/**
 * 小数 digits 桁に丸める（digits が負なら 10・100 の位）。数でない値は例外（黙って 0 にしない）
 */
export function roundDecimal(value: number, digits: number, method: RoundingMethod): number {
  if (!Number.isFinite(value)) throw new Error('丸める値が数ではありません。');
  if (!Number.isInteger(digits)) throw new Error('丸めの桁は整数で指定してください。');
  if (value === 0) return 0;
  const { negative, digits: mantissa, exponent } = decompose(value);
  // |v| × 10^digits = mantissa × 10^(exponent + digits)
  const shift = exponent + digits;
  let scaled: bigint;
  if (shift >= 0) {
    scaled = mantissa * pow10(shift);
  } else {
    const divisor = pow10(-shift);
    scaled = roundQuotient(mantissa / divisor, mantissa % divisor, divisor, negative, method);
  }
  const result = toNumber(scaled, digits);
  return negative && result !== 0 ? -result : result;
}

/** 有効数字 significant 桁に丸める（例: 0.1074408711 → 有効 3 桁 0.107） */
export function roundSignificant(
  value: number,
  significant: number,
  method: RoundingMethod,
): number {
  if (!Number.isFinite(value)) throw new Error('丸める値が数ではありません。');
  if (!Number.isInteger(significant) || significant < 1) {
    throw new Error('有効数字は 1 以上の整数で指定してください。');
  }
  if (value === 0) return 0;
  const { digits, exponent } = decompose(value);
  // 先頭の桁の位（10 の何乗か）
  const leading = digits.toString().length - 1 + exponent;
  return roundDecimal(value, significant - 1 - leading, method);
}

/**
 * 排出量（t-CO2e）を規則の単位・桁で丸める。kg の d 桁は t の d+3 桁と同じ（掛け算・割り算の誤差を作らない）
 */
export function roundEmission(
  valueT: number,
  rule: Pick<RoundingRule, 'digits' | 'unit' | 'method'>,
): number {
  return roundDecimal(valueT, rule.unit === 'kg' ? rule.digits + 3 : rule.digits, rule.method);
}

/**
 * 足し算でできた 2 進の誤差（0.1 + 0.2 = 0.30000000000000004）を有効 15 桁で落とす。
 * 丸めの前の合計に使う（誤差のせいで .x5 が .x4999… になり、丸めの結果が変わるのを防ぐ）
 */
export function cleanFloat(value: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  return Number(value.toPrecision(15));
}

// ----------------------------------------------------------------------
// 段の丸め
// ----------------------------------------------------------------------

export interface RoundingItem {
  unitId: string;
  month: string;
  activityKind: GhgActivityKind;
  scope: GhgScope;
  /** t-CO2e（未丸め） */
  value: number;
}

export interface StageValue {
  unrounded: number;
  rounded: number;
}

export interface RoundingStagesResult {
  lines: Array<StageValue>;
  months: Array<
    { unitId: string; month: string; activityKind: GhgActivityKind; scope: GhgScope } & StageValue
  >;
  siteActivities: Array<
    { unitId: string; activityKind: GhgActivityKind; scope: GhgScope } & StageValue
  >;
  siteScopes: Array<{ unitId: string; scope: GhgScope } & StageValue>;
  totals: Array<{ scope: GhgScope } & StageValue>;
}

export function ruleFor(
  rules: readonly RoundingRule[],
  stage: RoundingStage,
): RoundingRule | undefined {
  return rules.find((r) => r.stage === stage);
}

function applyRule(value: number, rule: RoundingRule | undefined): number {
  const clean = cleanFloat(value);
  return rule ? roundEmission(clean, rule) : clean;
}

/** 順序を保つ集計（最初に現れた順） */
class Groups<K, V extends { unrounded: number; parts: number[] }> {
  private readonly map = new Map<string, { key: K; value: V }>();
  constructor(private readonly create: () => V) {}
  add(id: string, key: K, unrounded: number, part: number): void {
    let entry = this.map.get(id);
    if (!entry) {
      entry = { key, value: this.create() };
      this.map.set(id, entry);
    }
    entry.value.unrounded += unrounded;
    entry.value.parts.push(part);
  }
  entries(): Array<{ key: K; value: V }> {
    return [...this.map.values()];
  }
}

const newAcc = () => ({ unrounded: 0, parts: [] as number[] });

/**
 * 段ごとに丸める（行 → 月 → 拠点×活動 → 拠点×区分 → 合計）。**段に規則があれば、その段の丸め後の値を
 * 次の段で足す**（既存の算定の「月ごとに切り捨ててから合計」を再現する）。未丸めの合計も並べて返す。
 * 区分（scope）は鍵に含み、別の区分どうしを足さない（Scope2 の 2 基準を足さない）
 */
export function applyRoundingStages(
  items: readonly RoundingItem[],
  rules: readonly RoundingRule[],
): RoundingStagesResult {
  const lineRule = ruleFor(rules, 'line');
  const lines = items.map((item) => ({
    unrounded: cleanFloat(item.value),
    rounded: applyRule(item.value, lineRule),
  }));

  type MonthKey = { unitId: string; month: string; activityKind: GhgActivityKind; scope: GhgScope };
  const monthGroups = new Groups<MonthKey, ReturnType<typeof newAcc>>(newAcc);
  items.forEach((item, i) => {
    monthGroups.add(
      `${item.unitId}|${item.activityKind}|${item.scope}|${item.month}`,
      {
        unitId: item.unitId,
        month: item.month,
        activityKind: item.activityKind,
        scope: item.scope,
      },
      item.value,
      lines[i]!.rounded,
    );
  });
  const monthRule = ruleFor(rules, 'month');
  const months = monthGroups.entries().map(({ key, value }) => ({
    ...key,
    unrounded: cleanFloat(value.unrounded),
    rounded: applyRule(
      value.parts.reduce((a, b) => a + b, 0),
      monthRule,
    ),
  }));

  type SiteActivityKey = { unitId: string; activityKind: GhgActivityKind; scope: GhgScope };
  const saGroups = new Groups<SiteActivityKey, ReturnType<typeof newAcc>>(newAcc);
  for (const m of months) {
    saGroups.add(
      `${m.unitId}|${m.activityKind}|${m.scope}`,
      { unitId: m.unitId, activityKind: m.activityKind, scope: m.scope },
      m.unrounded,
      m.rounded,
    );
  }
  const saRule = ruleFor(rules, 'site_activity');
  const siteActivities = saGroups.entries().map(({ key, value }) => ({
    ...key,
    unrounded: cleanFloat(value.unrounded),
    rounded: applyRule(
      value.parts.reduce((a, b) => a + b, 0),
      saRule,
    ),
  }));

  type SiteScopeKey = { unitId: string; scope: GhgScope };
  const ssGroups = new Groups<SiteScopeKey, ReturnType<typeof newAcc>>(newAcc);
  for (const s of siteActivities) {
    ssGroups.add(
      `${s.unitId}|${s.scope}`,
      { unitId: s.unitId, scope: s.scope },
      s.unrounded,
      s.rounded,
    );
  }
  const ssRule = ruleFor(rules, 'site_scope');
  const siteScopes = ssGroups.entries().map(({ key, value }) => ({
    ...key,
    unrounded: cleanFloat(value.unrounded),
    rounded: applyRule(
      value.parts.reduce((a, b) => a + b, 0),
      ssRule,
    ),
  }));

  const totalGroups = new Groups<{ scope: GhgScope }, ReturnType<typeof newAcc>>(newAcc);
  for (const s of siteScopes) totalGroups.add(s.scope, { scope: s.scope }, s.unrounded, s.rounded);
  const totalRule = ruleFor(rules, 'total');
  const totals = totalGroups.entries().map(({ key, value }) => ({
    ...key,
    unrounded: cleanFloat(value.unrounded),
    rounded: applyRule(
      value.parts.reduce((a, b) => a + b, 0),
      totalRule,
    ),
  }));

  return { lines, months, siteActivities, siteScopes, totals };
}
