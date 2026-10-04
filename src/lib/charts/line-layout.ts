import type { ChartText } from './bar-layout';
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
 * 折れ線の配置（docs/disclosure-first.md §10.4）。純関数で、components/charts/line-chart.tsx が描くだけにする。
 *
 * 規則:
 *  - null で線を切る（前後を補間しない）。前後とも null の 1 点は点だけ描く
 *  - 2 系列以上は色だけでなく線種（実線・破線…）と点の形（丸・四角・三角・菱形）も変える
 *  - 縦軸は 1 本だけ（二軸にしない）。既定で 0 を範囲に含める
 */

export interface LineSeriesInput {
  label: string;
  /** xLabels と同じ順の値。null は未入力（線を切る） */
  values: readonly ChartValue[];
  /** 破線にするか。指定が無ければ系列の順で線種を変える（1 本目は実線） */
  dashed?: boolean;
}

export type MarkerShape = 'circle' | 'square' | 'triangle' | 'diamond';

export const MARKER_SHAPES: readonly MarkerShape[] = ['circle', 'square', 'triangle', 'diamond'];

/** 系列の順の線種（strokeDasharray。null は実線） */
const DASH_PATTERNS: ReadonlyArray<string | null> = [null, '6 4', '2 3', '8 3 2 3'];
const DASHED = '6 4';

export interface LinePoint {
  index: number;
  value: number;
  x: number;
  y: number;
}

export interface LineSeriesLayout {
  seriesIndex: number;
  label: string;
  /** 連続した点の列（null で区切った線分ごと）。1 点だけの列は点だけ描く */
  segments: LinePoint[][];
  points: LinePoint[];
  dash: string | null;
  marker: MarkerShape;
}

export type LineValueLabels = 'all' | 'last' | 'none';

export interface LineLayoutInput {
  xLabels: readonly string[];
  series: readonly LineSeriesInput[];
  format?: (value: number) => string;
  /** 点の隣に数値を書くか（all: すべて、last: 系列ごとに最後の点、none）。既定は 6 点以下なら all、それ以上は last */
  valueLabels?: LineValueLabels;
  includeZero?: boolean;
  width?: number;
  height?: number;
}

export interface LineValueLabel extends ChartText {
  seriesIndex: number;
  index: number;
  value: number;
}

export interface LineLayout {
  width: number;
  height: number;
  plot: { left: number; right: number; top: number; bottom: number };
  ticks: Array<{ value: number; text: string; position: number }>;
  /** 0 が範囲内なら 0 軸の y、範囲外なら null */
  zero: number | null;
  xPositions: number[];
  xLabels: ChartText[];
  series: LineSeriesLayout[];
  valueLabels: LineValueLabel[];
  /** すべての系列が null の x（「未入力」を書く位置） */
  missing: Array<ChartText & { index: number }>;
}

const FONT = 11;

export function dashFor(series: LineSeriesInput, seriesIndex: number): string | null {
  if (series.dashed === true) return DASHED;
  if (series.dashed === false) return null;
  return DASH_PATTERNS[seriesIndex % DASH_PATTERNS.length] ?? null;
}

export function markerFor(seriesIndex: number): MarkerShape {
  return MARKER_SHAPES[seriesIndex % MARKER_SHAPES.length] ?? 'circle';
}

/** 値の列を、null で切った連続区間に分ける（補間しない） */
export function splitSegments(
  values: readonly ChartValue[],
): Array<Array<{ index: number; value: number }>> {
  const segments: Array<Array<{ index: number; value: number }>> = [];
  let current: Array<{ index: number; value: number }> = [];
  values.forEach((value, index) => {
    if (isChartNumber(value)) {
      current.push({ index, value });
    } else if (current.length > 0) {
      segments.push(current);
      current = [];
    }
  });
  if (current.length > 0) segments.push(current);
  return segments;
}

export function layoutLineChart(input: LineLayoutInput): LineLayout {
  const format = input.format ?? formatChartNumber;
  const width = input.width ?? 640;
  const height = input.height ?? 220;
  const { xLabels, series } = input;
  const valueLabelsMode: LineValueLabels =
    input.valueLabels ?? (xLabels.length <= 6 ? 'all' : 'last');

  const all = series.flatMap((s) => s.values);
  const [minValue, maxValue] = valueExtent(all, { includeZero: input.includeZero ?? true });
  const tickValues = niceTicks(minValue, maxValue, 5);
  const domain: [number, number] = [
    tickValues[0] ?? minValue,
    tickValues[tickValues.length - 1] ?? maxValue,
  ];
  const tickTexts = tickValues.map(format);
  const tickLabelWidth = Math.max(0, ...tickTexts.map((t) => estimateTextWidth(t, FONT)));
  const labelWidth = Math.max(
    0,
    ...all.filter(isChartNumber).map((v) => estimateTextWidth(format(v), FONT)),
  );
  const plot = {
    left: Math.min(140, Math.max(32, tickLabelWidth + 12)),
    // 最後の点の右に数値を書くため、右に余白を取る
    right: width - Math.max(12, valueLabelsMode === 'none' ? 12 : labelWidth / 2 + 8),
    top: 22,
    bottom: height - 26,
  };
  const scale = linearScale(domain, [plot.bottom - 6, plot.top + 14]);
  const step = xLabels.length <= 1 ? 0 : (plot.right - plot.left - 24) / (xLabels.length - 1);
  const xPositions = xLabels.map((_, index) =>
    xLabels.length <= 1 ? (plot.left + plot.right) / 2 : plot.left + 12 + index * step,
  );

  const layouts: LineSeriesLayout[] = series.map((s, seriesIndex) => {
    const segments = splitSegments(s.values).map((segment) =>
      segment.map(({ index, value }) => ({
        index,
        value,
        x: xPositions[index] ?? plot.left,
        y: scale(value),
      })),
    );
    return {
      seriesIndex,
      label: s.label,
      segments,
      points: segments.flat(),
      dash: dashFor(s, seriesIndex),
      marker: markerFor(seriesIndex),
    };
  });

  const valueLabels: LineValueLabel[] = [];
  if (valueLabelsMode !== 'none') {
    const targets = layouts.flatMap((layout) =>
      (valueLabelsMode === 'all'
        ? layout.points
        : layout.points.slice(layout.points.length - 1)
      ).map((point) => ({ seriesIndex: layout.seriesIndex, point })),
    );
    // 同じ年に複数の系列の数値を書くときは、画面で一番上の点だけ上に、ほかは下に書く
    // （系列の順で上下を決めると、線が交差したときに 2 つの数値がぶつかる）
    const topmostByIndex = new Map<number, number>();
    for (const { point } of targets) {
      const top = topmostByIndex.get(point.index);
      if (top === undefined || point.y < top) topmostByIndex.set(point.index, point.y);
    }
    const claimed = new Set<number>();
    for (const { seriesIndex, point } of targets) {
      // 同じ高さの点が複数あれば、先の系列だけを上にする
      const above = point.y === topmostByIndex.get(point.index) && !claimed.has(point.index);
      if (above) claimed.add(point.index);
      valueLabels.push({
        seriesIndex,
        index: point.index,
        value: point.value,
        text: format(point.value),
        x: point.x,
        y: above ? point.y - 8 : point.y + FONT + 6,
        anchor: 'middle',
      });
    }
  }

  const missing = xLabels
    .map((_, index) => index)
    .filter((index) => series.length > 0 && series.every((s) => !isChartNumber(s.values[index])))
    .map((index) => ({
      index,
      text: '未入力',
      x: xPositions[index] ?? plot.left,
      y: plot.bottom - 10,
      anchor: 'middle' as const,
    }));

  const zero = domain[0] <= 0 && domain[1] >= 0 ? scale(0) : null;
  return {
    width,
    height,
    plot,
    ticks: tickValues.map((value, index) => ({
      value,
      text: tickTexts[index] ?? format(value),
      position: scale(value),
    })),
    zero,
    xPositions,
    xLabels: xLabels.map((text, index) => ({
      text,
      x: xPositions[index] ?? plot.left,
      y: plot.bottom + 16,
      anchor: 'middle',
    })),
    series: layouts,
    valueLabels,
    missing,
  };
}
