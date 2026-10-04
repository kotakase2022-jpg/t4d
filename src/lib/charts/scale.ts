/**
 * 図の尺度（docs/disclosure-first.md §10.4）。描画から切り離した純関数で、目盛り・0 軸・null の扱いを
 * 画面とテストが同じ規則で使う（csrd/settings/dma-view.ts と同じ作り）。
 *
 * 規則:
 *  - null は「値が無い」。0 として数えない（範囲にも目盛りにも入れない）
 *  - 量の図は 0 を必ず範囲に入れる（棒の長さが値に比例しないと大小を読み違える）
 *  - 目盛りは 1・2・2.5・5 × 10^n の刻み。0 をまたぐ範囲なら 0 が必ず目盛りに乗る
 */

/** 図に渡す 1 つの値。null は未入力・未定量（0 ではない） */
export type ChartValue = number | null;

/** 数値として使える値か（null・NaN・Infinity を除く） */
export function isChartNumber(value: ChartValue | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 値の範囲 [最小, 最大]。null は除く。includeZero（既定 true）なら 0 を含める。
 * 値が 1 つも無い・幅が 0 のときは描けるよう幅を持たせる（全部 0 なら [0, 1]）
 */
export function valueExtent(
  values: readonly ChartValue[],
  { includeZero = true }: { includeZero?: boolean } = {},
): [number, number] {
  const numbers = values.filter(isChartNumber);
  if (numbers.length === 0) return [0, 1];
  let min = Math.min(...numbers);
  let max = Math.max(...numbers);
  if (includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (min === max) {
    // 全部 0 の量の図は 0 を底にする
    if (min === 0) return [0, 1];
    // 1 点だけ（0 を含めない線など）。上下に同じ幅を足して中央に置く
    const pad = Math.abs(min) * 0.1;
    return [min - pad, max + pad];
  }
  return [min, max];
}

/** 1・2・2.5・5 × 10^n のうち、raw 以上で最小の刻み */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const exponent = Math.floor(Math.log10(raw));
  const base = 10 ** exponent;
  const fraction = raw / base;
  const nice =
    fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * base;
}

/** 浮動小数の誤差（0.30000000000000004 など）を刻みの桁で落とす */
function roundToStep(value: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 2);
  const rounded = Number(value.toFixed(Math.min(decimals, 12)));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * 範囲 [min, max] を覆う目盛り（昇順）。刻みは targetCount 個前後になるよう選ぶ。
 * 目盛りは刻みの倍数なので、min ≤ 0 ≤ max なら 0 が必ず含まれる
 */
export function niceTicks(min: number, max: number, targetCount = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min > max) [min, max] = [max, min];
  if (min === max) return [min];
  const step = niceStep((max - min) / Math.max(1, targetCount - 1));
  const start = Math.floor(min / step + 1e-9) * step;
  const end = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let i = 0; start + i * step <= end + step * 1e-9; i += 1) {
    ticks.push(roundToStep(start + i * step, step));
  }
  return ticks;
}

/** 線形の尺度。domain の値を range の座標へ写す（domain の幅が 0 なら range の中央） */
export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): (value: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  if (span === 0) return () => (r0 + r1) / 2;
  return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}

const DEFAULT_FORMAT = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });

/**
 * 図の数値の既定の書式（桁区切り・小数 1 桁まで。丸めは表示だけ）。
 * 負の値は「−」（全角に近いマイナス記号）で示し、ハイフンと紛れないようにする
 */
export function formatChartNumber(value: number): string {
  const text = DEFAULT_FORMAT.format(value);
  return text.startsWith('-') ? `−${text.slice(1)}` : text;
}

/** 文字の幅の見積り（px）。和文は全角、英数字・記号は半角として数える */
export function estimateTextWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const char of text) {
    units += /[ -~−]/.test(char) ? 0.6 : 1;
  }
  return units * fontSize;
}
