/**
 * T4D の単位（指標マスター・数値の版の文字列）→ XBRL の measure と桁（plan §3.4・gap D-03）。
 *
 * - 換算は 10 の累乗だけ（千 t-CO2e → tCO2e ×10^3、百万円 → JPY ×10^6、% → pure ×10^-2）。表に無い単位は
 *   換算しない（推測しない）。検査 V03 が「XBRL の単位に換算できない」として止める
 * - 値の桁の移動は文字列で行う（2 進の浮動小数点で 12.3×0.01 が 0.12300000000000001 にならないように）
 * - GHG は utr:tCO2e に正規化する（EDINET の「GHG は tCO2e に限る」規則を SAMPLE でも先取り）
 */

export const MEASURE_NAMESPACES = {
  xbrli: 'http://www.xbrl.org/2003/instance',
  iso4217: 'http://www.xbrl.org/2003/iso4217',
  utr: 'http://www.xbrl.org/2009/utr',
} as const;

export interface UnitMapping {
  /** 接頭辞付きの measure（例: utr:tCO2e） */
  measure: string;
  /** T4D の値に掛ける 10 の累乗（iXBRL の scale と同じ値） */
  exponent: number;
}

/** 表（キーは正規化した単位の文字列） */
const UNIT_TABLE: Readonly<Record<string, UnitMapping>> = {
  'kg-co2e': { measure: 'utr:tCO2e', exponent: -3 },
  't-co2e': { measure: 'utr:tCO2e', exponent: 0 },
  '千t-co2e': { measure: 'utr:tCO2e', exponent: 3 },
  円: { measure: 'iso4217:JPY', exponent: 0 },
  千円: { measure: 'iso4217:JPY', exponent: 3 },
  百万円: { measure: 'iso4217:JPY', exponent: 6 },
  億円: { measure: 'iso4217:JPY', exponent: 8 },
  '%': { measure: 'xbrli:pure', exponent: -2 },
  人: { measure: 'xbrli:pure', exponent: 0 },
  件: { measure: 'xbrli:pure', exponent: 0 },
  mwh: { measure: 'utr:MWh', exponent: 0 },
  m3: { measure: 'utr:m3', exponent: 0 },
  t: { measure: 'utr:t', exponent: 0 },
};

/** 単位の文字列を表のキーにする（全角・空白・CO₂ の書き方の揺れをそろえる） */
export function normalizeUnit(unit: string): string {
  return unit
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/₂/g, '2')
    .replace(/^(千|k)?t-?co2e?q?$/i, (_m, prefix: string | undefined) =>
      prefix ? '千t-co2e' : 't-co2e',
    )
    .replace(/^kg-?co2e?q?$/i, 'kg-co2e')
    .toLowerCase();
}

export function mapUnit(unit: string | null | undefined): UnitMapping | null {
  if (!unit) return null;
  return UNIT_TABLE[normalizeUnit(unit)] ?? null;
}

/** 換算できる T4D の単位の一覧（画面の説明用。正規化前の代表の書き方） */
export const MAPPED_UNIT_EXAMPLES = [
  't-CO2e',
  '千t-CO2e',
  'kg-CO2e',
  '円',
  '千円',
  '百万円',
  '億円',
  '%',
  '人',
  '件',
  'MWh',
  'm3',
  't',
] as const;

export type MeasureClass = 'currency' | 'pure' | 'ghg' | 'other';

export function measureClass(measure: string): MeasureClass {
  if (measure.startsWith('iso4217:')) return 'currency';
  if (measure === 'xbrli:pure') return 'pure';
  if (measure === 'utr:tCO2e') return 'ghg';
  return 'other';
}

/** 出力の単位の ID（XML の ID。決定的） */
export function unitIdOf(measure: string): string {
  return `u-${measure
    .split(':')
    .pop()!
    .replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

// ----------------------------------------------------------------------
// 10 進の文字列での桁の移動・丸めの検査
// ----------------------------------------------------------------------

/** 数を指数表記なしの 10 進の文字列にする（1e-7 → "0.0000001"） */
export function decimalString(value: number): string {
  if (!Number.isFinite(value)) throw new Error('数値ではない値は XBRL の事実にできません。');
  const text = String(value);
  if (!/e/i.test(text)) return text;
  const [mantissa = '0', exp = '0'] = text.toLowerCase().split('e');
  return shiftDecimal(mantissa, Number(exp));
}

/** 10 進の文字列の小数点を exponent 桁動かす（右が正）。余分な 0 は落とす */
export function shiftDecimal(text: string, exponent: number): string {
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [intPart = '0', fracPart = ''] = unsigned.split('.');
  const digits = `${intPart}${fracPart}`;
  let point = intPart.length + exponent;
  let padded = digits;
  if (point < 0) {
    padded = `${'0'.repeat(-point)}${padded}`;
    point = 0;
  }
  if (point > padded.length) padded = `${padded}${'0'.repeat(point - padded.length)}`;
  const integer = padded.slice(0, point).replace(/^0+(?=\d)/, '') || '0';
  const fraction = padded.slice(point).replace(/0+$/, '');
  const body = fraction ? `${integer}.${fraction}` : integer;
  const isZero = /^0(\.0*)?$/.test(body);
  return negative && !isZero ? `-${body}` : body;
}

/** T4D の値を XBRL の事実の値（10 進の文字列）にする */
export function scaleValue(value: number, exponent: number): string {
  return shiftDecimal(decimalString(value), exponent);
}

/** 小数点以下の桁数 */
export function fractionDigits(text: string): number {
  const fraction = text.split('.')[1] ?? '';
  return fraction.length;
}

/**
 * decimals の精度で値を失わずに表せるか（例: 1240.5 は decimals=0 では表せない）。
 * decimals が負なら、整数の末尾の -decimals 桁が 0 であること
 */
export function representableAt(text: string, decimals: number): boolean {
  const unsigned = text.replace(/^-/, '');
  if (decimals >= 0) return fractionDigits(unsigned) <= decimals;
  if (fractionDigits(unsigned) > 0) return false;
  const integer = unsigned.split('.')[0] ?? '';
  if (/^0+$/.test(integer)) return true;
  return integer.endsWith('0'.repeat(-decimals));
}

/** 3 桁区切りの表示（丸めない。iXBRL の表示値は事実の値と同じ数でなければならない） */
export function groupedDecimal(text: string): string {
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [integer = '0', fraction] = unsigned.split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`;
}

/**
 * 表示の文字列の先頭の数を 10 進の文字列で読む（「1,240.5 t-CO2e（推計）」→ "1240.5"）。
 * 数が無ければ null
 */
export function leadingNumber(display: string): string | null {
  const match = display.normalize('NFKC').match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!match) return null;
  return shiftDecimal(match[0].replace(/,/g, ''), 0);
}
