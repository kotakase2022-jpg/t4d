import { describe, expect, it } from 'vitest';
import {
  estimateRoi,
  missingRoiFields,
  monthlyHoursFromSavedMinutes,
  parseRoiParams,
  ROI_MAX_MONTHS,
} from '@/lib/domain/roi-estimate';

/**
 * 費用対効果の試算（NF-36）。削減時間 × 部門数 × 月数 × 社内換算単価。保存しない・価格を埋め込まない。
 */

describe('estimateRoi', () => {
  it('8 時間 × 3 部門 × 12 か月 = 288 時間、× 6,000 円 = 1,728,000 円', () => {
    const result = estimateRoi({
      unitPriceYen: 6000,
      departments: 3,
      monthlyHours: 8,
      months: 12,
      costs: [],
    });
    expect(result.hours).toBe(288);
    expect(result.yen).toBe(1_728_000);
    // 比較する費用を入れていなければ比べない
    expect(result.totalCost).toBeNull();
    expect(result.difference).toBeNull();
    expect(result.ratio).toBeNull();
  });

  it('比較する費用は利用者が入れたものだけを合計し、差額と倍率を出す', () => {
    const result = estimateRoi({
      unitPriceYen: 6000,
      departments: 3,
      monthlyHours: 8,
      months: 12,
      costs: [500_000, 364_000],
    });
    expect(result.totalCost).toBe(864_000);
    expect(result.difference).toBe(864_000);
    expect(result.ratio).toBe(2);
  });

  it('0 は 0 として計算する。費用の合計が 0 なら倍率を出さない', () => {
    const zero = estimateRoi({
      unitPriceYen: 0,
      departments: 3,
      monthlyHours: 8,
      months: 12,
      costs: [0],
    });
    expect(zero.hours).toBe(288);
    expect(zero.yen).toBe(0);
    expect(zero.totalCost).toBe(0);
    expect(zero.ratio).toBeNull();
  });

  it('作業時間の記録から: 1 単位あたりの短縮分（分）× 月あたりの件数 ÷ 60', () => {
    expect(monthlyHoursFromSavedMinutes(35, 12)).toBe(7);
    // 増えた（負の短縮）はそのまま負で出す（0 に丸めない）
    expect(monthlyHoursFromSavedMinutes(-6, 10)).toBe(-1);
  });
});

describe('parseRoiParams（URL の入力。保存しない）', () => {
  it('未入力は誤りにしない（初期表示）', () => {
    const parsed = parseRoiParams({});
    expect(parsed.touched).toBe(false);
    expect(parsed.errors).toEqual([]);
    expect(missingRoiFields(parsed)).toEqual([
      '社内換算単価',
      '対象部門数',
      '月あたり削減時間',
      '月数',
    ]);
  });

  it('負の値・数値でない値・整数でない部門数は誤り（試算しない）', () => {
    const parsed = parseRoiParams({ price: '-1', depts: '2.5', hours: 'abc', months: '999' });
    expect(parsed.unitPriceYen).toBeNull();
    expect(parsed.departments).toBeNull();
    expect(parsed.monthlyHours).toBeNull();
    expect(parsed.months).toBeNull();
    expect(parsed.errors).toEqual([
      '社内換算単価は 0 以上で入力してください。',
      '対象部門数は整数で入力してください。',
      '月あたり削減時間は数値で入力してください。',
      `月数は ${ROI_MAX_MONTHS} 以下で入力してください。`,
    ]);
  });

  it('桁区切り・全角数字を読み、比較する費用は入れたものだけ', () => {
    const parsed = parseRoiParams({
      price: '６，０００',
      depts: '3',
      hours: '8',
      months: '12',
      cost_initial: '500,000',
      cost_annual: '',
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.unitPriceYen).toBe(6000);
    expect(parsed.costs).toEqual([{ key: 'initial', label: '導入費用', yen: 500_000 }]);
    expect(missingRoiFields(parsed)).toEqual([]);
  });

  it('作業時間の記録から換算するときは、手入力の削減時間の代わりに件数を求める', () => {
    const parsed = parseRoiParams({ src: 'timing', price: '1', depts: '1', months: '1' });
    expect(parsed.source).toBe('timing');
    expect(missingRoiFields(parsed)).toEqual(['月あたりの件数']);
  });
});
