/**
 * ESG経営の KPI 詳細の「年次の推移」の図の点（docs/disclosure-first.md §10.4 の LineChart の規則）。
 *
 * 横軸はデータのある最初の年度から最後の年度までのすべての年度にする。値を描かない年度
 * （データが無い・承認済みの値が無い）を横軸から落とすと、前後の年度が隣り合って 1 本の線で
 * つながり、補間した推移に見えるため、その年度は null（線を切る）にして理由の文字を置く。
 * 全拠点が承認済みの確定値と、集計中の承認済み分のみ（途中集計）は別の系列にする（つながない）。
 */

export interface KpiTrendPointRow {
  period: { id: string; code: string };
  state: { approvedValue: number | null; complete: boolean };
}

/** 値を描かない理由: データの行が無い／行はあるが承認済みの値が無い */
export type KpiTrendGap = 'no_data' | 'no_approved';

export const KPI_TREND_GAP_LABEL: Record<KpiTrendGap, string> = {
  no_data: '未入力',
  no_approved: '承認済みの値なし',
};

export interface KpiTrendPoints {
  xLabels: string[];
  /** 確定値（全拠点承認済み）。それ以外の年度は null */
  confirmed: Array<number | null>;
  /** 集計中の承認済み分のみ。それ以外の年度は null */
  partial: Array<number | null>;
  /** 値を描かない年度の文字（図の「未入力」の位置に書く）。値のある年度は null */
  missingLabels: Array<string | null>;
  gaps: Array<{ code: string; kind: KpiTrendGap }>;
}

/**
 * @param periods 図の横軸の年度（古い順。データのある最初〜最後の年度。空なら rows の年度だけ）
 * @param rows データのある年度の状態（periods の部分集合）
 */
export function kpiTrendPoints(
  periods: ReadonlyArray<{ id: string; code: string }>,
  rows: readonly KpiTrendPointRow[],
): KpiTrendPoints {
  const axis = periods.length > 0 ? periods : rows.map((row) => row.period);
  const byId = new Map(rows.map((row) => [row.period.id, row]));
  const result: KpiTrendPoints = {
    xLabels: [],
    confirmed: [],
    partial: [],
    missingLabels: [],
    gaps: [],
  };
  for (const period of axis) {
    const row = byId.get(period.id);
    const value = row?.state.approvedValue ?? null;
    result.xLabels.push(period.code);
    if (!row || value === null) {
      const kind: KpiTrendGap = row ? 'no_approved' : 'no_data';
      result.confirmed.push(null);
      result.partial.push(null);
      result.missingLabels.push(KPI_TREND_GAP_LABEL[kind]);
      result.gaps.push({ code: period.code, kind });
      continue;
    }
    result.confirmed.push(row.state.complete ? value : null);
    result.partial.push(row.state.complete ? null : value);
    result.missingLabels.push(null);
  }
  return result;
}
