/**
 * Scope3 Cat.1 の算定内訳（CalculationInput.label）とサプライヤー Unit を結ぶラベル規約。
 *
 * 形式: 「<コード> <サプライヤー名> / <品目>」（例: SUP-01 常盤精密工業 / 精密加工部品）
 *
 * 識別キーは**不変・組織内一意のコード**（organization_units の unique 制約はコードのみ）。
 * 名前で結ぶと、同名サプライヤーの衝突や改名で置き換え判定が壊れ、
 * 追記専用の算定根拠に二重計上・欠落を作ってしまう。
 * 名前は読み手（監査法人の再計算を含む）のためにラベルへ併記するだけで、
 * 突き合わせには使わない。
 *
 * `server-only` を付けない純粋モジュールにしてあるのは、書き手が
 * サービス（scope3-suppliers.ts）と Fixture（fixtures/store.ts、seed 生成にも使う）の
 * 2 か所にあり、両方から同じ実装を使うため。
 */

export const SCOPE3_LABEL_SEPARATOR = ' / ';

export interface Scope3LabelSupplier {
  code: string;
  name: string;
}

export function supplierInputLabel(supplier: Scope3LabelSupplier, item: string): string {
  return `${supplier.code} ${supplier.name}${SCOPE3_LABEL_SEPARATOR}${item}`;
}

export interface Scope3LabelMatch<T extends Scope3LabelSupplier> {
  supplier: T;
  /** ラベルから取り出した品目（改名後の旧ラベルでも取り出せる） */
  item: string;
}

/**
 * ラベルからサプライヤーを引き当てる。
 *
 * 1. 「<コード> <現在の名前> / 」への完全前方一致（品目に「 / 」が入っていても正しく切れる）
 * 2. 改名後の旧ラベル用に「<コード> 」への前方一致（品目は最初の「 / 」以降）
 * コードが互いに前方一致しうる場合（例: SUP-1 と SUP-10）に備え、最長一致を採る。
 */
export function matchSupplierByLabel<T extends Scope3LabelSupplier>(
  suppliers: readonly T[],
  label: string,
): Scope3LabelMatch<T> | null {
  let best: { supplier: T; prefixLength: number; item: string } | null = null;
  for (const supplier of suppliers) {
    const exactPrefix = `${supplier.code} ${supplier.name}${SCOPE3_LABEL_SEPARATOR}`;
    if (label.startsWith(exactPrefix)) {
      if (!best || exactPrefix.length > best.prefixLength) {
        best = {
          supplier,
          prefixLength: exactPrefix.length,
          item: label.slice(exactPrefix.length),
        };
      }
      continue;
    }
    const codePrefix = `${supplier.code} `;
    if (label.startsWith(codePrefix)) {
      if (!best || codePrefix.length > best.prefixLength) {
        const separatorIndex = label.indexOf(SCOPE3_LABEL_SEPARATOR);
        best = {
          supplier,
          prefixLength: codePrefix.length,
          item:
            separatorIndex >= 0
              ? label.slice(separatorIndex + SCOPE3_LABEL_SEPARATOR.length)
              : label,
        };
      }
    }
  }
  return best ? { supplier: best.supplier, item: best.item } : null;
}
