import { describe, expect, it } from 'vitest';
import { kpiTrendPoints, type KpiTrendPointRow } from '@/lib/charts/kpi-trend-points';
import { layoutLineChart } from '@/lib/charts/line-layout';

/**
 * ESG経営の KPI 詳細の年次の推移（docs/disclosure-first.md §10.4 の LineChart の規則「null で線を切る・補間しない」）。
 * 値を描かない年度を横軸から落とすと、前後の年度が隣り合って 1 本の線でつながるため、横軸に残して null にする。
 */

const periods = [
  { id: 'p23', code: 'FY2023' },
  { id: 'p24', code: 'FY2024' },
  { id: 'p25', code: 'FY2025' },
];

function row(id: string, code: string, approvedValue: number | null, complete: boolean) {
  return { period: { id, code }, state: { approvedValue, complete } } satisfies KpiTrendPointRow;
}

describe('kpiTrendPoints', () => {
  it('間の年度にデータが無くても横軸に残し、null で線を切る（FY2023 と FY2025 をつながない）', () => {
    const points = kpiTrendPoints(periods, [
      row('p23', 'FY2023', 100, true),
      row('p25', 'FY2025', 80, true),
    ]);
    expect(points.xLabels).toEqual(['FY2023', 'FY2024', 'FY2025']);
    expect(points.confirmed).toEqual([100, null, 80]);
    expect(points.missingLabels).toEqual([null, '未入力', null]);
    expect(points.gaps).toEqual([{ code: 'FY2024', kind: 'no_data' }]);

    const layout = layoutLineChart({
      xLabels: points.xLabels,
      series: [{ label: '確定値', values: points.confirmed }],
      missingLabels: points.missingLabels,
    });
    // 線分は 2 つ（どちらも 1 点だけ）。前後をつなぐ線を引かない
    expect(layout.series[0]!.segments.map((s) => s.length)).toEqual([1, 1]);
    expect(layout.missing.map((m) => [m.index, m.text])).toEqual([[1, '未入力']]);
  });

  it('データはあるが承認済みの値が無い年度は「承認済みの値なし」（未入力と書かない）', () => {
    const points = kpiTrendPoints(periods, [
      row('p23', 'FY2023', 100, true),
      row('p24', 'FY2024', null, false),
      row('p25', 'FY2025', 80, true),
    ]);
    expect(points.confirmed).toEqual([100, null, 80]);
    expect(points.missingLabels).toEqual([null, '承認済みの値なし', null]);
    expect(points.gaps).toEqual([{ code: 'FY2024', kind: 'no_approved' }]);
    const layout = layoutLineChart({
      xLabels: points.xLabels,
      series: [{ label: '確定値', values: points.confirmed }],
      missingLabels: points.missingLabels,
    });
    expect(layout.missing.map((m) => m.text)).toEqual(['承認済みの値なし']);
  });

  it('集計中の承認済み分のみは別の系列（確定値の線につながない）', () => {
    const points = kpiTrendPoints(periods, [
      row('p23', 'FY2023', 100, true),
      row('p24', 'FY2024', 90, true),
      row('p25', 'FY2025', 40, false),
    ]);
    expect(points.confirmed).toEqual([100, 90, null]);
    expect(points.partial).toEqual([null, null, 40]);
    expect(points.missingLabels).toEqual([null, null, null]);
    expect(points.gaps).toEqual([]);
  });

  it('横軸の年度が渡されなければ、データのある年度だけで描く', () => {
    const points = kpiTrendPoints([], [row('p24', 'FY2024', 90, true)]);
    expect(points.xLabels).toEqual(['FY2024']);
    expect(points.confirmed).toEqual([90]);
  });
});
