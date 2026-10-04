import {
  estimateTextWidth,
  formatChartNumber,
  isChartNumber,
  linearScale,
  niceTicks,
  valueExtent,
  type ChartValue,
} from './scale';

/**
 * 棒グラフの配置（docs/disclosure-first.md §10.4）。純関数で、components/charts/bar-chart.tsx と
 * mini-bars.tsx が描くだけにする。
 *
 * 規則:
 *  - 0 軸から伸ばす。負の値は 0 軸の下（横向きは左）。積み上げは正と負を別々に 0 から積む
 *  - null は棒を描かず「未入力」の位置だけを返す（0 の棒にしない）。0 は長さ 0（ラベルは「0」）
 *  - 0 でない値は最小 MIN_BAR_PX の長さを持たせる（小さな値が消えて「無い」と読まれないように）
 *  - 積み上げの隣り合う区分は STACK_GAP_PX の隙間で区切る（色の差だけに頼らない）
 */

export type BarOrientation = 'vertical' | 'horizontal';

export interface BarSeriesInput {
  label: string;
  /** categories と同じ順の値。null は未入力（0 ではない） */
  values: readonly ChartValue[];
}

export interface BarLayoutInput {
  categories: readonly string[];
  series: readonly BarSeriesInput[];
  orientation?: BarOrientation;
  stacked?: boolean;
  /** 棒の隣に数値を書くか（余白を確保する）。既定 true */
  showValues?: boolean;
  format?: (value: number) => string;
  /** viewBox の幅（既定 640。表示は w-full で縮む） */
  width?: number;
  /** 縦向きの viewBox の高さ（既定 240）。横向きは区分の数から決める */
  height?: number;
}

export interface ChartRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BarMark extends ChartRect {
  seriesIndex: number;
  categoryIndex: number;
  value: number;
}

export type TextAnchor = 'start' | 'middle' | 'end';

export interface ChartText {
  text: string;
  x: number;
  y: number;
  anchor: TextAnchor;
}

/** 「未入力」を書く位置。seriesIndex が null なら区分全体（積み上げで全系列が null） */
export interface BarMissing extends ChartText {
  categoryIndex: number;
  seriesIndex: number | null;
}

/** 棒の隣の数値。積み上げは区分ごとの合計（seriesIndex = null） */
export interface BarValueLabel extends ChartText {
  categoryIndex: number;
  seriesIndex: number | null;
  value: number;
}

export interface BarBand {
  categoryIndex: number;
  label: string;
  /** 区分の帯の始まりと幅（縦向きは x 方向、横向きは y 方向） */
  start: number;
  size: number;
  center: number;
}

export interface BarLayout {
  width: number;
  height: number;
  orientation: BarOrientation;
  stacked: boolean;
  plot: { left: number; right: number; top: number; bottom: number };
  /** 値の軸の目盛り。position は縦向きなら y、横向きなら x */
  ticks: Array<{ value: number; text: string; position: number }>;
  /** 0 軸の位置（縦向きは y、横向きは x） */
  zero: number;
  bands: BarBand[];
  categoryLabels: ChartText[];
  bars: BarMark[];
  missing: BarMissing[];
  valueLabels: BarValueLabel[];
}

export const MIN_BAR_PX = 2;
export const STACK_GAP_PX = 1;
export const MISSING_LABEL = '未入力';
const FONT = 11;

function valueAt(series: BarSeriesInput, index: number): number | null {
  const value = series.values[index];
  return isChartNumber(value) ? value : null;
}

/** 積み上げの区分ごとの正の合計・負の合計・合計（null を除く）。全系列 null なら total = null */
export function stackTotals(
  categories: readonly string[],
  series: readonly BarSeriesInput[],
): Array<{ positive: number; negative: number; total: number | null }> {
  return categories.map((_, index) => {
    let positive = 0;
    let negative = 0;
    let any = false;
    for (const s of series) {
      const value = valueAt(s, index);
      if (value === null) continue;
      any = true;
      if (value > 0) positive += value;
      else negative += value;
    }
    return { positive, negative, total: any ? positive + negative : null };
  });
}

/** 棒グラフの配置を計算する */
export function layoutBarChart(input: BarLayoutInput): BarLayout {
  const orientation = input.orientation ?? 'vertical';
  const stacked = input.stacked ?? false;
  const showValues = input.showValues ?? true;
  const format = input.format ?? formatChartNumber;
  const width = input.width ?? 640;
  const { categories, series } = input;

  // 値の範囲（積み上げは区分ごとの正・負の合計で決める）
  const totals = stackTotals(categories, series);
  const extentValues: number[] = stacked
    ? totals.flatMap((t) => [t.positive, t.negative])
    : series.flatMap((s) => categories.map((_, i) => valueAt(s, i))).filter(isChartNumber);
  const [minValue, maxValue] = valueExtent(extentValues);
  const tickValues = niceTicks(minValue, maxValue, 5);
  const domain: [number, number] = [
    tickValues[0] ?? minValue,
    tickValues[tickValues.length - 1] ?? maxValue,
  ];
  const hasPositive = extentValues.some((v) => v > 0);
  const hasNegative = extentValues.some((v) => v < 0);

  // 棒の隣に書く数値（余白の見積りにも使う）
  const labelTexts: string[] = stacked
    ? totals.map((t) => (t.total === null ? MISSING_LABEL : format(t.total)))
    : series.flatMap((s) =>
        categories.map((_, i) => {
          const value = valueAt(s, i);
          return value === null ? MISSING_LABEL : format(value);
        }),
      );
  const labelWidth = Math.max(
    estimateTextWidth(MISSING_LABEL, FONT),
    ...labelTexts.map((t) => estimateTextWidth(t, FONT)),
  );
  const tickTexts = tickValues.map(format);
  const grouped = !stacked && series.length > 1;

  if (orientation === 'vertical') {
    const height = input.height ?? 240;
    const tickLabelWidth = Math.max(0, ...tickTexts.map((t) => estimateTextWidth(t, FONT)));
    const plot = {
      left: Math.min(140, Math.max(32, tickLabelWidth + 12)),
      right: width - 8,
      top: 22,
      bottom: height - 26,
    };
    const padHigh = showValues && hasPositive ? 15 : 4;
    const padLow = showValues && hasNegative ? 15 : 4;
    const scale = linearScale(domain, [plot.bottom - padLow, plot.top + padHigh]);
    const zero = scale(0);
    const size = categories.length === 0 ? 0 : (plot.right - plot.left) / categories.length;
    const bands: BarBand[] = categories.map((label, categoryIndex) => ({
      categoryIndex,
      label,
      start: plot.left + categoryIndex * size,
      size,
      center: plot.left + categoryIndex * size + size / 2,
    }));
    const bars: BarMark[] = [];
    const missing: BarMissing[] = [];
    const valueLabels: BarValueLabel[] = [];

    if (stacked) {
      const thickness = Math.min(40, size * 0.6);
      for (const band of bands) {
        let positiveEdge = zero;
        let negativeEdge = zero;
        series.forEach((s, seriesIndex) => {
          const value = valueAt(s, band.categoryIndex);
          if (value === null || value === 0) return;
          const length = Math.max(MIN_BAR_PX + STACK_GAP_PX, Math.abs(scale(value) - zero));
          const drawn = length - STACK_GAP_PX;
          if (value > 0) {
            bars.push({
              seriesIndex,
              categoryIndex: band.categoryIndex,
              value,
              x: band.center - thickness / 2,
              y: positiveEdge - length,
              width: thickness,
              height: drawn,
            });
            positiveEdge -= length;
          } else {
            bars.push({
              seriesIndex,
              categoryIndex: band.categoryIndex,
              value,
              x: band.center - thickness / 2,
              y: negativeEdge + STACK_GAP_PX,
              width: thickness,
              height: drawn,
            });
            negativeEdge += length;
          }
        });
        const total = totals[band.categoryIndex]?.total ?? null;
        if (total === null) {
          missing.push({
            categoryIndex: band.categoryIndex,
            seriesIndex: null,
            text: MISSING_LABEL,
            x: band.center,
            y: zero - 4,
            anchor: 'middle',
          });
        } else if (showValues) {
          valueLabels.push({
            categoryIndex: band.categoryIndex,
            seriesIndex: null,
            value: total,
            text: format(total),
            x: band.center,
            y: total >= 0 ? positiveEdge - 4 : negativeEdge + FONT + 2,
            anchor: 'middle',
          });
        }
      }
    } else {
      const count = Math.max(1, series.length);
      const inner = grouped ? size * 0.8 : size * 0.6;
      const thickness = Math.min(grouped ? 28 : 40, (inner - (count - 1) * 2) / count);
      const groupWidth = count * thickness + (count - 1) * 2;
      for (const band of bands) {
        series.forEach((s, seriesIndex) => {
          const x = band.center - groupWidth / 2 + seriesIndex * (thickness + 2);
          const center = x + thickness / 2;
          const value = valueAt(s, band.categoryIndex);
          if (value === null) {
            missing.push({
              categoryIndex: band.categoryIndex,
              seriesIndex,
              text: MISSING_LABEL,
              x: center,
              y: zero - 4,
              anchor: 'middle',
            });
            return;
          }
          const length = value === 0 ? 0 : Math.max(MIN_BAR_PX, Math.abs(scale(value) - zero));
          const y = value >= 0 ? zero - length : zero;
          bars.push({
            seriesIndex,
            categoryIndex: band.categoryIndex,
            value,
            x,
            y,
            width: thickness,
            height: length,
          });
          if (showValues) {
            valueLabels.push({
              categoryIndex: band.categoryIndex,
              seriesIndex,
              value,
              text: format(value),
              x: center,
              y: value >= 0 ? y - 4 : y + length + FONT + 2,
              anchor: 'middle',
            });
          }
        });
      }
    }

    return {
      width,
      height,
      orientation,
      stacked,
      plot,
      ticks: tickValues.map((value, index) => ({
        value,
        text: tickTexts[index] ?? format(value),
        position: scale(value),
      })),
      zero,
      bands,
      categoryLabels: bands.map((band) => ({
        text: band.label,
        x: band.center,
        y: plot.bottom + 16,
        anchor: 'middle',
      })),
      bars,
      missing,
      valueLabels,
    };
  }

  // 横向き: 区分は上から下へ、値は左右へ
  const categoryLabelWidth = Math.max(0, ...categories.map((c) => estimateTextWidth(c, FONT)));
  const count = Math.max(1, series.length);
  const size = grouped ? count * 12 + (count - 1) * 2 + 10 : 26;
  const top = 22;
  const height = top + categories.length * size + 22;
  const plot = {
    left: Math.min(240, Math.max(48, categoryLabelWidth + 14)),
    right: width - 8,
    top,
    bottom: top + categories.length * size,
  };
  const padHigh = showValues && hasPositive ? labelWidth + 8 : 4;
  const padLow = showValues && hasNegative ? labelWidth + 8 : 4;
  const scale = linearScale(domain, [plot.left + padLow, plot.right - padHigh]);
  const zero = scale(0);
  const bands: BarBand[] = categories.map((label, categoryIndex) => ({
    categoryIndex,
    label,
    start: plot.top + categoryIndex * size,
    size,
    center: plot.top + categoryIndex * size + size / 2,
  }));
  const bars: BarMark[] = [];
  const missing: BarMissing[] = [];
  const valueLabels: BarValueLabel[] = [];
  const baseline = (center: number) => center + FONT / 2 - 1;

  if (stacked) {
    const thickness = Math.min(18, size * 0.65);
    for (const band of bands) {
      let positiveEdge = zero;
      let negativeEdge = zero;
      series.forEach((s, seriesIndex) => {
        const value = valueAt(s, band.categoryIndex);
        if (value === null || value === 0) return;
        const length = Math.max(MIN_BAR_PX + STACK_GAP_PX, Math.abs(scale(value) - zero));
        const drawn = length - STACK_GAP_PX;
        if (value > 0) {
          bars.push({
            seriesIndex,
            categoryIndex: band.categoryIndex,
            value,
            x: positiveEdge + STACK_GAP_PX,
            y: band.center - thickness / 2,
            width: drawn,
            height: thickness,
          });
          positiveEdge += length;
        } else {
          bars.push({
            seriesIndex,
            categoryIndex: band.categoryIndex,
            value,
            x: negativeEdge - length,
            y: band.center - thickness / 2,
            width: drawn,
            height: thickness,
          });
          negativeEdge -= length;
        }
      });
      const total = totals[band.categoryIndex]?.total ?? null;
      if (total === null) {
        missing.push({
          categoryIndex: band.categoryIndex,
          seriesIndex: null,
          text: MISSING_LABEL,
          x: zero + 4,
          y: baseline(band.center),
          anchor: 'start',
        });
      } else if (showValues) {
        valueLabels.push({
          categoryIndex: band.categoryIndex,
          seriesIndex: null,
          value: total,
          text: format(total),
          x: total >= 0 ? positiveEdge + 4 : negativeEdge - 4,
          y: baseline(band.center),
          anchor: total >= 0 ? 'start' : 'end',
        });
      }
    }
  } else {
    const thickness = grouped ? 12 : Math.min(18, size * 0.65);
    const groupHeight = count * thickness + (count - 1) * 2;
    for (const band of bands) {
      series.forEach((s, seriesIndex) => {
        const y = band.center - groupHeight / 2 + seriesIndex * (thickness + 2);
        const center = y + thickness / 2;
        const value = valueAt(s, band.categoryIndex);
        if (value === null) {
          missing.push({
            categoryIndex: band.categoryIndex,
            seriesIndex,
            text: MISSING_LABEL,
            x: zero + 4,
            y: baseline(center),
            anchor: 'start',
          });
          return;
        }
        const length = value === 0 ? 0 : Math.max(MIN_BAR_PX, Math.abs(scale(value) - zero));
        const x = value >= 0 ? zero : zero - length;
        bars.push({
          seriesIndex,
          categoryIndex: band.categoryIndex,
          value,
          x,
          y,
          width: length,
          height: thickness,
        });
        if (showValues) {
          valueLabels.push({
            categoryIndex: band.categoryIndex,
            seriesIndex,
            value,
            text: format(value),
            x: value >= 0 ? x + length + 4 : x - 4,
            y: baseline(center),
            anchor: value >= 0 ? 'start' : 'end',
          });
        }
      });
    }
  }

  return {
    width,
    height,
    orientation,
    stacked,
    plot,
    ticks: tickValues.map((value, index) => ({
      value,
      text: tickTexts[index] ?? format(value),
      position: scale(value),
    })),
    zero,
    bands,
    categoryLabels: bands.map((band) => ({
      text: band.label,
      x: plot.left - 8,
      y: baseline(band.center),
      anchor: 'end',
    })),
    bars,
    missing,
    valueLabels,
  };
}

// ----------------------------------------------------------------------
// 表の中の小さな年次バー（MiniBars）
// ----------------------------------------------------------------------

export interface MiniBar extends ChartRect {
  index: number;
  /** null は未入力（破線の空枠として描く。0 の棒にしない） */
  value: number | null;
}

export interface MiniBarsLayout {
  width: number;
  height: number;
  /** 0 軸の y */
  zero: number;
  bars: MiniBar[];
}

/**
 * 小さな年次バー（0 起点）。値は棒の高さだけで示し、数値は隣のセルに書く前提。
 * null は全高の空枠、0 は 0 軸上の 1px の線（null と 0 を見分けられるように）
 */
export function layoutMiniBars(
  values: readonly ChartValue[],
  { barWidth = 6, gap = 3, height = 20 }: { barWidth?: number; gap?: number; height?: number } = {},
): MiniBarsLayout {
  const width = Math.max(barWidth, values.length * barWidth + (values.length - 1) * gap) + 2;
  const [min, max] = valueExtent(values);
  const top = 1;
  const bottom = height - 1;
  const scale = linearScale([min, max], [bottom, top]);
  const zero = scale(0);
  const bars: MiniBar[] = values.map((raw, index) => {
    const x = 1 + index * (barWidth + gap);
    if (!isChartNumber(raw)) {
      return { index, value: null, x, y: top, width: barWidth, height: bottom - top };
    }
    if (raw === 0) return { index, value: 0, x, y: zero - 0.5, width: barWidth, height: 1 };
    const length = Math.max(MIN_BAR_PX, Math.abs(scale(raw) - zero));
    return {
      index,
      value: raw,
      x,
      y: raw > 0 ? zero - length : zero,
      width: barWidth,
      height: length,
    };
  });
  return { width, height, zero, bars };
}
