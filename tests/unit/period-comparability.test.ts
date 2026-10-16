import { describe, expect, it } from 'vitest';
import { previousComparablePeriod, sameFiscalYearEnd } from '@/lib/domain/period-comparability';
import { trendWindowOf } from '@/lib/services/analysis/trends';
import type { ReportingPeriod } from '@/types/domain';

/**
 * 期間の比べ方（plan K10・自己監査 F3）。決算日は文字列ではなく 1 年の中の近さで比べる:
 *  - 2 月末決算はうるう年に 02-29 になる（前年が 2 年前・前年なしにならない）
 *  - 52/53 週の年度は決算日が年ごとに数日ずれる
 *  - 年度（3 月末）と暦年（12 月末）は混ぜない
 */

const ORG = 'org-retail';

function period(code: string, startDate: string, endDate: string): ReportingPeriod {
  return {
    id: `p-${code}`,
    organizationId: ORG,
    code,
    label: code,
    startDate,
    endDate,
    status: 'collecting',
    submissionDueDate: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: null,
    updatedBy: null,
  };
}

describe('2 月末決算（うるう年をまたぐ）', () => {
  const fy2022 = period('FY2022', '2022-03-01', '2023-02-28');
  const fy2023 = period('FY2023', '2023-03-01', '2024-02-29');
  const fy2024 = period('FY2024', '2024-03-01', '2025-02-28');
  const periods = [fy2022, fy2023, fy2024];

  it('02-28 と 02-29 は同じ決算日', () => {
    expect(sameFiscalYearEnd(fy2023, fy2024)).toBe(true);
    expect(sameFiscalYearEnd(fy2022, fy2023)).toBe(true);
  });

  it('前年は 1 年前（2 年前に飛ばない・前年なしにならない）', () => {
    for (const by of ['end', 'start'] as const) {
      expect(previousComparablePeriod(fy2024, periods, by)?.code).toBe('FY2023');
      expect(previousComparablePeriod(fy2023, periods, by)?.code).toBe('FY2022');
      expect(previousComparablePeriod(fy2022, periods, by)).toBeNull();
    }
  });

  it('推移の窓はうるう年の年度を落とさない', () => {
    expect(trendWindowOf(fy2024, periods, ORG).map((p) => p.code)).toEqual([
      'FY2022',
      'FY2023',
      'FY2024',
    ]);
  });
});

describe('52/53 週の年度（決算日が年ごとにずれる）', () => {
  const fy2022 = period('FY2022', '2022-01-30', '2023-01-28');
  const fy2023 = period('FY2023', '2023-01-29', '2024-02-03');
  const fy2024 = period('FY2024', '2024-02-04', '2025-02-01');
  const periods = [fy2022, fy2023, fy2024];

  it('前年は 1 年前・推移の窓に 3 年がそろう', () => {
    expect(previousComparablePeriod(fy2024, periods, 'end')?.code).toBe('FY2023');
    expect(previousComparablePeriod(fy2023, periods, 'start')?.code).toBe('FY2022');
    expect(trendWindowOf(fy2024, periods, ORG).map((p) => p.code)).toEqual([
      'FY2022',
      'FY2023',
      'FY2024',
    ]);
  });

  it('年をまたぐ近さも同じ決算日（12-31 と 01-03）', () => {
    expect(
      sameFiscalYearEnd(
        period('A', '2024-01-01', '2024-12-31'),
        period('B', '2025-01-01', '2026-01-03'),
      ),
    ).toBe(true);
  });
});

describe('決算月の違う期間は混ぜない（plan K10）', () => {
  const fy2024 = period('FY2024', '2024-04-01', '2025-03-31');
  const cy2025 = period('CY2025', '2025-01-01', '2025-12-31');
  const fy2025 = period('FY2025', '2025-04-01', '2026-03-31');
  const periods = [fy2024, cy2025, fy2025];

  it('3 月末と 12 月末・2 月末と 3 月末は別の決算日', () => {
    expect(sameFiscalYearEnd(fy2024, cy2025)).toBe(false);
    expect(sameFiscalYearEnd(fy2024, period('X', '2024-03-01', '2025-02-28'))).toBe(false);
  });

  it('FY2025 の前年は FY2024（開始日が後の CY2025 ではない）', () => {
    expect(previousComparablePeriod(fy2025, periods, 'start')?.code).toBe('FY2024');
    expect(previousComparablePeriod(fy2025, periods, 'end')?.code).toBe('FY2024');
    expect(previousComparablePeriod(cy2025, periods, 'start')).toBeNull();
  });
});
