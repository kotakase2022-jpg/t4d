import { describe, expect, it } from 'vitest';
import { matchSupplierByLabel, supplierInputLabel } from '@/lib/domain/scope3-labels';

/**
 * Scope3 算定内訳のラベル規約。
 *
 * 突き合わせのキーは不変・一意なコード。名前の改名・重複・「 / 」入りの名前でも
 * 引き当てが壊れないこと（壊れると追記専用の算定根拠に二重計上・欠落が生じる）。
 */

const SUPPLIERS = [
  { code: 'SUP-1', name: '青海商事' },
  { code: 'SUP-10', name: '青海商事 東日本' },
  { code: 'SUP-02', name: '商社A / 東日本' },
];

describe('Scope3 ラベル規約', () => {
  it('書いたラベルをそのまま引き当てられる（round-trip）', () => {
    for (const supplier of SUPPLIERS) {
      const label = supplierInputLabel(supplier, '金属部品');
      const matched = matchSupplierByLabel(SUPPLIERS, label);
      expect(matched?.supplier.code).toBe(supplier.code);
      expect(matched?.item).toBe('金属部品');
    }
  });

  it('名前に「 / 」が入っていても品目を正しく切り出す', () => {
    const label = supplierInputLabel(SUPPLIERS[2]!, '梱包資材');
    expect(label).toBe('SUP-02 商社A / 東日本 / 梱包資材');
    const matched = matchSupplierByLabel(SUPPLIERS, label);
    expect(matched?.supplier.code).toBe('SUP-02');
    expect(matched?.item).toBe('梱包資材');
  });

  it('前方一致しうるコード（SUP-1 と SUP-10）は最長一致で区別する', () => {
    const label10 = supplierInputLabel(SUPPLIERS[1]!, '部品');
    expect(matchSupplierByLabel(SUPPLIERS, label10)?.supplier.code).toBe('SUP-10');
    const label1 = supplierInputLabel(SUPPLIERS[0]!, '部品');
    expect(matchSupplierByLabel(SUPPLIERS, label1)?.supplier.code).toBe('SUP-1');
  });

  it('改名後（ラベル内の名前が古い）でもコードで引き当てる', () => {
    // 旧名「常盤精密工業」で書かれたラベルを、改名後のマスターで読む
    const renamed = [{ code: 'SUP-01', name: '常盤精密ホールディングス' }];
    const matched = matchSupplierByLabel(renamed, 'SUP-01 常盤精密工業 / 精密加工部品');
    expect(matched?.supplier.code).toBe('SUP-01');
    expect(matched?.item).toBe('精密加工部品');
  });

  it('規約外のラベルは引き当てない（その他として扱わせる）', () => {
    expect(matchSupplierByLabel(SUPPLIERS, '常盤精密工業 / 精密加工部品')).toBeNull();
  });
});
