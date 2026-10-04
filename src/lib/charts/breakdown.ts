/**
 * 件数の内訳・分数・絞り込みの流れの配置（docs/disclosure-first.md §10.4）。純関数で、
 * components/charts の FractionBar・StatusBreakdown・FunnelSteps が描くだけにする。
 *
 * 規則:
 *  - 件数は必ず文字（「n / N 件」）で示し、帯は補助。帯の幅は割合（%）だが、% の文字は既定で出さない
 *    （分析系では割合だけを見せず、分母付きの件数で示す）
 *  - 0 でない件数の区分は最小幅を持たせる（1 件が見えずに「無い」と読まれないように）
 *  - 分母 0 は「対象なし」（0% ではない）
 */

export interface BreakdownItemInput {
  key: string;
  label: string;
  count: number;
}

export interface BreakdownSegment {
  key: string;
  label: string;
  count: number;
  /** 入力の並びでの位置（色の順。件数 0 の項目を飛ばしても色がずれない） */
  index: number;
  /** 帯の中の始まりと幅（%） */
  start: number;
  width: number;
}

export interface BreakdownLayout {
  total: number;
  /** 件数が 0 より大きい項目だけ（入力の順） */
  segments: BreakdownSegment[];
}

export const MIN_SEGMENT_PERCENT = 2;

/** 帯の幅に使う件数。負・NaN は件数として成り立たないため、0 件と同じく帯に描かない */
function countOf(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 内訳の帯の配置。件数 0 の項目は帯に出さない（凡例には出す）。最小幅を足した分は、
 * 最小幅より大きい区分から比例で差し引き、合計を 100% に保つ
 */
export function layoutBreakdown(
  items: readonly BreakdownItemInput[],
  { minPercent = MIN_SEGMENT_PERCENT }: { minPercent?: number } = {},
): BreakdownLayout {
  const total = items.reduce((sum, item) => sum + countOf(item.count), 0);
  if (total === 0) return { total: 0, segments: [] };
  const present = items
    .map((item, index) => ({ ...item, count: countOf(item.count), index }))
    .filter((item) => item.count > 0);
  const raw = present.map((item) => (item.count / total) * 100);
  const small = raw.map((w) => w < minPercent);
  const smallTotal = small.filter(Boolean).length * minPercent;
  const largeRaw = raw.reduce((sum, w, i) => (small[i] ? sum : sum + w), 0);
  // 最小幅だけで 100% を超える（区分がとても多い）ときは均等に割る
  const widths =
    smallTotal >= 100 || largeRaw === 0
      ? raw.map(() => 100 / raw.length)
      : raw.map((w, i) => (small[i] ? minPercent : (w / largeRaw) * (100 - smallTotal)));
  let start = 0;
  const segments = present.map((item, i) => {
    const width = widths[i] ?? 0;
    const segment = {
      key: item.key,
      label: item.label,
      count: item.count,
      index: item.index,
      start,
      width,
    };
    start += width;
    return segment;
  });
  return { total, segments };
}

/** 「n / N 件」。単位の前に半角スペース（既存の画面と同じ書き方） */
export function fractionText(
  numerator: number,
  denominator: number,
  unit = '件',
  // 件数は素の整数で足りるが、t-CO2e などの量は桁区切りが無いと読み違えるため、書式を呼び出し側から渡せる
  format: (n: number) => string = String,
): string {
  return `${format(numerator)} / ${format(denominator)} ${unit}`;
}

/** 件数の文字（「n 件」） */
export function countText(count: number, unit = '件'): string {
  return `${count} ${unit}`;
}

/** 整数に丸めた割合（%）。分母 0 は null（0% と書かない） */
export function wholePercent(numerator: number, denominator: number): number | null {
  if (!(denominator > 0)) return null;
  return Math.round((numerator / denominator) * 100);
}

/**
 * 分数の帯の幅（%）。分母 0 は 0、分子が分母を超えても 100 まで。
 * 0 でない分子は最小幅を持たせる
 */
export function fractionWidthPercent(
  numerator: number,
  denominator: number,
  { minPercent = MIN_SEGMENT_PERCENT }: { minPercent?: number } = {},
): number {
  if (!(denominator > 0)) return 0;
  const n = countOf(numerator);
  if (n === 0) return 0;
  return Math.min(100, Math.max(minPercent, (n / denominator) * 100));
}

/** 件数の流れ（ファネル）の帯の幅（%）。最も多い段を 100 とした相対幅。0 件は 0 */
export function funnelWidths(
  counts: readonly number[],
  { minPercent = MIN_SEGMENT_PERCENT }: { minPercent?: number } = {},
): number[] {
  const max = Math.max(0, ...counts.map(countOf));
  return counts.map((count) => {
    const n = countOf(count);
    if (max === 0 || n === 0) return 0;
    return Math.max(minPercent, (n / max) * 100);
  });
}
