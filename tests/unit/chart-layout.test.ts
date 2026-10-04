import { describe, expect, it } from 'vitest';
import {
  MIN_BAR_PX,
  STACK_GAP_PX,
  layoutBarChart,
  layoutMiniBars,
  stackTotals,
} from '@/lib/charts/bar-layout';
import {
  fractionText,
  fractionWidthPercent,
  funnelWidths,
  layoutBreakdown,
  wholePercent,
} from '@/lib/charts/breakdown';
import { dashFor, layoutLineChart, markerFor, splitSegments } from '@/lib/charts/line-layout';
import {
  formatChartNumber,
  linearScale,
  niceStep,
  niceTicks,
  valueExtent,
} from '@/lib/charts/scale';
import { chartSummary } from '@/lib/charts/summary';

/**
 * 図の配置の純関数（docs/disclosure-first.md §10.4）。描画（components/charts）はこの結果を描くだけなので、
 * 目盛り・0 軸・負値の積み上げ・null・最小幅の規則をここで固定する。
 */

describe('尺度（scale）', () => {
  it('値の範囲は null を除き、0 を含める（全部 null・全部 0 でも幅を持つ）', () => {
    expect(valueExtent([3, null, 7])).toEqual([0, 7]);
    expect(valueExtent([-4, null, 2])).toEqual([-4, 2]);
    expect(valueExtent([-4, -1])).toEqual([-4, 0]);
    expect(valueExtent([null, null])).toEqual([0, 1]);
    expect(valueExtent([0, 0])).toEqual([0, 1]);
    // 0 を含めない（折れ線）ときは値の範囲そのもの
    expect(valueExtent([8, 10], { includeZero: false })).toEqual([8, 10]);
  });

  it('刻みは 1・2・2.5・5 × 10^n', () => {
    expect(niceStep(0.7)).toBe(1);
    expect(niceStep(1.3)).toBe(2);
    expect(niceStep(2.2)).toBe(2.5);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(2300)).toBe(2500);
  });

  it('目盛りは範囲を覆い、0 をまたぐ範囲なら 0 が必ず乗る（浮動小数の誤差を残さない）', () => {
    const ticks = niceTicks(0, 9735.4);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(9735.4);
    expect(ticks).toEqual([0, 2500, 5000, 7500, 10000]);

    const signed = niceTicks(-17.9, 4.2);
    expect(signed).toContain(0);
    expect(signed[0]).toBeLessThanOrEqual(-17.9);
    expect(signed[signed.length - 1]).toBeGreaterThanOrEqual(4.2);

    for (const t of niceTicks(0, 0.3)) expect(String(t)).not.toMatch(/0000001|9999999/);
  });

  it('線形の尺度（縦軸は上下が反転する）', () => {
    const y = linearScale([0, 100], [200, 0]);
    expect(y(0)).toBe(200);
    expect(y(50)).toBe(100);
    expect(y(100)).toBe(0);
    expect(linearScale([5, 5], [0, 10])(5)).toBe(5);
  });

  it('既定の書式は桁区切り・小数 1 桁まで、負は「−」', () => {
    expect(formatChartNumber(9735.44)).toBe('9,735.4');
    expect(formatChartNumber(-17.86)).toBe('−17.9');
    expect(formatChartNumber(0)).toBe('0');
  });
});

describe('棒グラフの配置（bar-layout）', () => {
  it('縦向き: 正は 0 軸の上、負は 0 軸の下。0 軸は目盛り 0 と同じ位置', () => {
    const layout = layoutBarChart({
      categories: ['FY2026', 'FY2027'],
      series: [{ label: '影響', values: [5, -3] }],
    });
    const zeroTick = layout.ticks.find((t) => t.value === 0);
    expect(zeroTick?.position).toBeCloseTo(layout.zero, 6);
    const [up, down] = layout.bars;
    expect(up!.y + up!.height).toBeCloseTo(layout.zero, 6);
    expect(up!.y).toBeLessThan(layout.zero);
    expect(down!.y).toBeCloseTo(layout.zero, 6);
    expect(down!.y + down!.height).toBeGreaterThan(layout.zero);
    // 棒の長さは値に比例する（5 と −3）
    expect(up!.height / down!.height).toBeCloseTo(5 / 3, 6);
  });

  it('null は棒を描かず「未入力」の位置を返す。0 は長さ 0（ラベルは「0」）', () => {
    const layout = layoutBarChart({
      categories: ['FY2024', 'FY2025', 'FY2026'],
      series: [{ label: 'Scope1', values: [9735.4, 0, null] }],
    });
    expect(layout.bars.map((b) => b.categoryIndex)).toEqual([0, 1]);
    expect(layout.bars[1]?.height).toBe(0);
    expect(layout.missing).toHaveLength(1);
    expect(layout.missing[0]).toMatchObject({ categoryIndex: 2, seriesIndex: 0, text: '未入力' });
    expect(layout.valueLabels.map((l) => l.text)).toEqual(['9,735.4', '0']);
  });

  it('0 でない小さな値も最小の長さを持つ（消えて「無い」と読まれない）', () => {
    const layout = layoutBarChart({
      categories: ['A', 'B'],
      series: [{ label: 's', values: [100000, 1] }],
    });
    expect(layout.bars[1]?.height).toBe(MIN_BAR_PX);
  });

  it('積み上げ: 正は 0 から上へ、負は 0 から下へ別々に積み、隣り合う区分は隙間で区切る', () => {
    const layout = layoutBarChart({
      categories: ['FY2030'],
      series: [
        { label: 'P1', values: [-10] },
        { label: 'P2', values: [-6] },
        { label: 'P9', values: [4] },
      ],
      stacked: true,
    });
    const [p1, p2, p9] = layout.bars;
    // 負の区分は 0 軸の下に順に積む（P1 の下に P2）
    expect(p1!.y).toBeCloseTo(layout.zero + STACK_GAP_PX, 6);
    expect(p2!.y).toBeGreaterThan(p1!.y + p1!.height);
    expect(p2!.y - (p1!.y + p1!.height)).toBeCloseTo(STACK_GAP_PX, 6);
    // 正の区分は 0 軸の上
    expect(p9!.y + p9!.height).toBeLessThan(layout.zero);
    // 合計（−12）は負の端の下に書く
    expect(layout.valueLabels).toHaveLength(1);
    expect(layout.valueLabels[0]).toMatchObject({ seriesIndex: null, value: -12, text: '−12' });
    expect(layout.valueLabels[0]!.y).toBeGreaterThan(p2!.y + p2!.height);
    // 目盛りは負の合計（−16）まで覆う
    expect(layout.ticks[0]!.value).toBeLessThanOrEqual(-16);
  });

  it('積み上げで全系列が null の区分は「未入力」（合計 0 にしない）', () => {
    const layout = layoutBarChart({
      categories: ['FY2026', 'FY2027'],
      series: [
        { label: 'P1', values: [null, -3] },
        { label: 'P2', values: [null, null] },
      ],
      stacked: true,
    });
    expect(
      stackTotals(
        ['FY2026', 'FY2027'],
        [
          { label: 'P1', values: [null, -3] },
          { label: 'P2', values: [null, null] },
        ],
      ),
    ).toEqual([
      { positive: 0, negative: 0, total: null },
      { positive: 0, negative: -3, total: -3 },
    ]);
    expect(layout.missing).toEqual([
      expect.objectContaining({ categoryIndex: 0, seriesIndex: null, text: '未入力' }),
    ]);
    expect(layout.valueLabels.map((l) => l.text)).toEqual(['−3']);
  });

  it('横向き: 負は 0 軸の左、区分の名前は左に右寄せ', () => {
    const layout = layoutBarChart({
      categories: ['炭素価格', '人材確保'],
      series: [{ label: '感度', values: [-8, 3] }],
      orientation: 'horizontal',
    });
    const [negative, positive] = layout.bars;
    expect(negative!.x + negative!.width).toBeCloseTo(layout.zero, 6);
    expect(positive!.x).toBeCloseTo(layout.zero, 6);
    expect(layout.categoryLabels.every((l) => l.anchor === 'end')).toBe(true);
    expect(layout.categoryLabels[0]!.x).toBeLessThan(layout.plot.left);
    expect(layout.valueLabels[0]?.anchor).toBe('end');
    expect(layout.valueLabels[1]?.anchor).toBe('start');
  });

  it('すべての座標が viewBox の中に収まる（横にはみ出さない）', () => {
    for (const orientation of ['vertical', 'horizontal'] as const) {
      for (const stacked of [false, true]) {
        const layout = layoutBarChart({
          categories: Array.from({ length: 10 }, (_, i) => `FY${2026 + i}`),
          series: [
            { label: 'P1', values: Array.from({ length: 10 }, (_, i) => -i * 1.7) },
            { label: 'P2', values: Array.from({ length: 10 }, (_, i) => (i % 3 === 0 ? null : i)) },
          ],
          orientation,
          stacked,
        });
        for (const bar of layout.bars) {
          expect(bar.x, `${orientation} ${stacked}`).toBeGreaterThanOrEqual(0);
          expect(bar.x + bar.width).toBeLessThanOrEqual(layout.width);
          expect(bar.y).toBeGreaterThanOrEqual(0);
          expect(bar.y + bar.height).toBeLessThanOrEqual(layout.height);
        }
      }
    }
  });
});

describe('表の中の小さな年次バー（layoutMiniBars）', () => {
  it('0 起点。null は全高の空枠、0 は 0 軸上の 1px の線', () => {
    const layout = layoutMiniBars([9735.4, 8931.6, null, 0]);
    const [a, b, missing, zero] = layout.bars;
    expect(a!.y + a!.height).toBeCloseTo(layout.zero, 6);
    expect(b!.height).toBeLessThan(a!.height);
    expect(b!.height / a!.height).toBeCloseTo(8931.6 / 9735.4, 6);
    expect(missing).toMatchObject({ value: null, y: 1, height: layout.height - 2 });
    expect(zero).toMatchObject({ value: 0, height: 1 });
  });
});

describe('折れ線の配置（line-layout）', () => {
  it('null で線を切る（補間しない）', () => {
    expect(splitSegments([1, 2, null, 4, null, null, 7, 8])).toEqual([
      [
        { index: 0, value: 1 },
        { index: 1, value: 2 },
      ],
      [{ index: 3, value: 4 }],
      [
        { index: 6, value: 7 },
        { index: 7, value: 8 },
      ],
    ]);
    const layout = layoutLineChart({
      xLabels: ['FY2024', 'FY2025', 'FY2026'],
      series: [{ label: 'Scope1', values: [9735.4, 8931.6, null] }],
    });
    expect(layout.series[0]?.segments).toHaveLength(1);
    expect(layout.series[0]?.points.map((p) => p.index)).toEqual([0, 1]);
    // どの系列にも値が無い年は「未入力」
    expect(layout.missing.map((m) => [m.index, m.text])).toEqual([[2, '未入力']]);
  });

  it('2 系列以上は線種と点の形を変える（明示した dashed を優先）', () => {
    expect(dashFor({ label: 'a', values: [] }, 0)).toBeNull();
    expect(dashFor({ label: 'b', values: [] }, 1)).not.toBeNull();
    expect(dashFor({ label: 'c', values: [], dashed: false }, 1)).toBeNull();
    expect(dashFor({ label: 'd', values: [], dashed: true }, 0)).not.toBeNull();
    expect(markerFor(0)).not.toBe(markerFor(1));
    const layout = layoutLineChart({
      xLabels: ['FY2026', 'FY2027'],
      series: [
        { label: '現状維持', values: [-1, -2] },
        { label: '目標達成', values: [-1, -1.5], dashed: true },
      ],
    });
    const [bau, target] = layout.series;
    expect(bau?.dash).toBeNull();
    expect(target?.dash).not.toBeNull();
    expect(bau?.marker).not.toBe(target?.marker);
  });

  it('数値の位置: 6 点以下はすべて、それより多いと系列ごとに最後の点', () => {
    const few = layoutLineChart({
      xLabels: ['a', 'b', 'c'],
      series: [{ label: 's', values: [1, 2, 3] }],
    });
    expect(few.valueLabels.map((l) => l.text)).toEqual(['1', '2', '3']);
    const many = layoutLineChart({
      xLabels: Array.from({ length: 10 }, (_, i) => `FY${2026 + i}`),
      series: [{ label: 's', values: Array.from({ length: 10 }, (_, i) => i - 4) }],
    });
    expect(many.valueLabels.map((l) => l.index)).toEqual([9]);
  });

  it('同じ年の 2 系列の数値は、上にある点の数値を上、下の点の数値を下に書く（ぶつからない）', () => {
    // 1 年目は系列 0 が上、2 年目は系列 1 が上（線が交差する）。同じ値の年は先の系列だけを上に
    const layout = layoutLineChart({
      xLabels: ['a', 'b', 'c'],
      series: [
        { label: '現状維持', values: [10, -111, 5] },
        { label: '目標達成', values: [-5, -84, 5] },
      ],
    });
    const labelOf = (seriesIndex: number, index: number) =>
      layout.valueLabels.find((l) => l.seriesIndex === seriesIndex && l.index === index)!;
    const pointOf = (seriesIndex: number, index: number) =>
      layout.series[seriesIndex]!.points.find((p) => p.index === index)!;
    for (const index of [0, 1, 2]) {
      const top = pointOf(0, index).y <= pointOf(1, index).y ? 0 : 1;
      const bottom = 1 - top;
      expect(labelOf(top, index).y, `${index}`).toBeLessThan(pointOf(top, index).y);
      expect(labelOf(bottom, index).y, `${index}`).toBeGreaterThan(pointOf(bottom, index).y);
    }
  });

  it('0 が範囲内なら 0 軸を返す。負の値も同じ 1 本の縦軸（二軸にしない）', () => {
    const layout = layoutLineChart({
      xLabels: ['a', 'b'],
      series: [
        { label: 'x', values: [-10, 5] },
        { label: 'y', values: [-200, -150] },
      ],
    });
    expect(layout.zero).not.toBeNull();
    expect(layout.ticks.map((t) => t.value)).toContain(0);
    const ys = layout.series.flatMap((s) => s.points.map((p) => p.y));
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(layout.plot.top);
      expect(y).toBeLessThanOrEqual(layout.plot.bottom);
    }
  });
});

describe('内訳・分数・流れ（breakdown）', () => {
  it('件数 0 の項目は帯に出さず、0 でない区分は最小幅を持ち、合計は 100%', () => {
    const layout = layoutBreakdown([
      { key: 'approved', label: '承認済み', count: 120 },
      { key: 'review', label: 'レビュー中', count: 1 },
      { key: 'none', label: '未提出', count: 0 },
      { key: 'error', label: 'エラー', count: 9 },
    ]);
    expect(layout.total).toBe(130);
    expect(layout.segments.map((s) => s.key)).toEqual(['approved', 'review', 'error']);
    // 色の順は入力の位置（0 件を飛ばしてもずれない）
    expect(layout.segments.map((s) => s.index)).toEqual([0, 1, 3]);
    expect(layout.segments[1]!.width).toBeGreaterThanOrEqual(2);
    const sum = layout.segments.reduce((total, s) => total + s.width, 0);
    expect(sum).toBeCloseTo(100, 6);
    // 区分は隙間なく並ぶ
    expect(layout.segments[1]!.start).toBeCloseTo(layout.segments[0]!.width, 6);
  });

  it('合計 0 は区分なし', () => {
    expect(layoutBreakdown([{ key: 'a', label: 'a', count: 0 }])).toEqual({
      total: 0,
      segments: [],
    });
  });

  it('分数の文字は「n / N 件」。分母 0 の割合は null（0% と書かない）、幅は 0', () => {
    expect(fractionText(3, 4, '拠点')).toBe('3 / 4 拠点');
    expect(fractionText(9, 12)).toBe('9 / 12 件');
    // 数値の書式は呼び出し側が渡せる（桁区切り。分子・分母の両方に効く）
    const grouped = (n: number) => n.toLocaleString('ja-JP');
    expect(fractionText(2268.4, 3360, 't-CO2e', grouped)).toBe('2,268.4 / 3,360 t-CO2e');
    expect(fractionText(-12.5, 1000, 't', grouped)).toBe('-12.5 / 1,000 t');
    expect(wholePercent(1, 3)).toBe(33);
    expect(wholePercent(0, 0)).toBeNull();
    expect(fractionWidthPercent(0, 0)).toBe(0);
    expect(fractionWidthPercent(5, 4)).toBe(100);
    expect(fractionWidthPercent(1, 1000)).toBe(2);
    expect(fractionWidthPercent(0, 10)).toBe(0);
  });

  it('流れの幅は最も多い段を 100 とした相対幅。0 件は 0、小さい段は最小幅', () => {
    expect(funnelWidths([133, 40, 1, 0])).toEqual([100, (40 / 133) * 100, 2, 0]);
    expect(funnelWidths([0, 0])).toEqual([0, 0]);
  });
});

describe('図の文字の代替（chartSummary）', () => {
  it('12 個までは全数値を書き、null は「未入力」', () => {
    const text = chartSummary({
      title: 'Scope1 の推移',
      unit: 't-CO2e',
      categories: ['FY2024', 'FY2025', 'FY2026'],
      series: [{ label: 'Scope1', values: [9735.4, 8931.6, null] }],
    });
    expect(text).toBe(
      'Scope1 の推移（単位: t-CO2e）。FY2024 9,735.4、FY2025 8,931.6、FY2026 未入力。',
    );
    expect(text).not.toContain(' 0');
  });

  it('2 系列は区分ごとに系列名と値を並べる', () => {
    const text = chartSummary({
      title: '累計',
      unit: '百万円',
      categories: ['FY2026', 'FY2027'],
      series: [
        { label: '現状維持', values: [-1, -2.5] },
        { label: '目標達成', values: [-1, null] },
      ],
    });
    expect(text).toBe(
      '累計（単位: 百万円）。FY2026: 現状維持 −1、目標達成 −1／FY2027: 現状維持 −2.5、目標達成 未入力。',
    );
  });

  it('12 個を超えると要点だけ（区分数・最大・最小・未入力の数）を書き、表を指す', () => {
    const categories = Array.from({ length: 10 }, (_, i) => `FY${2026 + i}`);
    const text = chartSummary({
      title: '年次の影響',
      unit: '百万円',
      categories,
      series: [
        { label: 'P1', values: categories.map((_, i) => -i) },
        { label: 'P2', values: categories.map((_, i) => (i === 0 ? null : i / 2)) },
      ],
    });
    expect(text).toContain('10 区分 × 2 系列');
    expect(text).toContain('最大 4.5（FY2035・P2）');
    expect(text).toContain('最小 −9（FY2035・P1）');
    expect(text).toContain('未入力 1 件');
    expect(text).toContain('「数値を表で見る」');
  });

  it('積み上げで 12 個を超えるときは区分ごとの合計を書く', () => {
    const categories = Array.from({ length: 10 }, (_, i) => `FY${2026 + i}`);
    const text = chartSummary({
      title: '年次の影響',
      unit: '百万円',
      categories,
      stacked: true,
      series: [
        { label: 'P1', values: categories.map(() => -2) },
        { label: 'P2', values: categories.map((_, i) => (i === 0 ? null : 1)) },
      ],
    });
    expect(text).toContain('合計: FY2026 −2、FY2027 −1');
  });
});
