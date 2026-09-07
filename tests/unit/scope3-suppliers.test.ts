import { describe, expect, it } from 'vitest';
import { extractSupplierCsvRows } from '@/lib/services/scope3-suppliers';

/**
 * サプライヤーデータ取込の CSV 解釈（決定論・AI 不使用）。
 *
 * 確かめたいこと:
 *  - ヘッダー行から 4 列（サプライヤーコード / 品目 / 購買金額 / 排出係数コード）を特定できる
 *  - 全角数字・桁区切り・引用符を許容する（parseFlexibleNumber と同じ寛容さ）
 *  - 合計行・注記行は取込対象から外れ、その理由が行に残る
 *  - 必須列が無いファイルはファイル単位のエラーになる（行は返さない）
 */

const HEADER = 'サプライヤーコード,品目,購買金額(千円),排出係数コード';

describe('サプライヤー購買 CSV の解釈', () => {
  it('標準ヘッダーの CSV を行に分解する', () => {
    const text = [
      HEADER,
      'SUP-06,金属筐体,12400,EF-PUR-METAL',
      'SUP-07,国内輸送,3200,EF-LOGI',
    ].join('\n');
    const parsed = extractSupplierCsvRows(text);

    expect(parsed.fileErrors).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      rowIndex: 1,
      supplierCode: 'SUP-06',
      item: '金属筐体',
      amountThousandJpy: 12400,
      factorCode: 'EF-PUR-METAL',
      skippedReason: null,
    });
    expect(parsed.rows[1]?.amountThousandJpy).toBe(3200);
  });

  it('桁区切り・全角数字・引用符を読み取れる', () => {
    const text = [
      HEADER,
      '"SUP-06","金属筐体","12,400",EF-PUR-METAL',
      'SUP-07,輸送,３２００,EF-LOGI',
    ].join('\n');
    const parsed = extractSupplierCsvRows(text);

    expect(parsed.rows[0]?.amountThousandJpy).toBe(12400);
    expect(parsed.rows[1]?.amountThousandJpy).toBe(3200);
  });

  it('読み取れない金額は null になり、行エラーとして残る', () => {
    const text = [HEADER, 'SUP-06,金属筐体,不明,EF-PUR-METAL'].join('\n');
    const parsed = extractSupplierCsvRows(text);

    expect(parsed.rows[0]?.amountThousandJpy).toBeNull();
    expect(parsed.rows[0]?.errors.join('')).toContain('購買金額');
  });

  it('合計行・注記行は取込対象から外れる', () => {
    const text = [
      HEADER,
      'SUP-06,金属筐体,12400,EF-PUR-METAL',
      '合計,,12400,',
      '※ 金額は税抜です,,,',
    ].join('\n');
    const parsed = extractSupplierCsvRows(text);

    const skipped = parsed.rows.filter((row) => row.skippedReason !== null);
    expect(skipped).toHaveLength(2);
    expect(parsed.rows.filter((row) => row.skippedReason === null)).toHaveLength(1);
  });

  it('必須列が欠けているとファイル単位のエラーになる', () => {
    const text = ['サプライヤーコード,品目', 'SUP-06,金属筐体'].join('\n');
    const parsed = extractSupplierCsvRows(text);

    expect(parsed.rows).toEqual([]);
    expect(parsed.fileErrors.join('')).toContain('購買金額');
    expect(parsed.fileErrors.join('')).toContain('排出係数');
  });

  it('空行だけのファイルはエラーになる', () => {
    const parsed = extractSupplierCsvRows('\n\n');
    expect(parsed.rows).toEqual([]);
    expect(parsed.fileErrors.length).toBeGreaterThan(0);
  });
});
