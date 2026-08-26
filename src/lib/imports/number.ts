/**
 * ロケール混在の数値表記の解釈。
 *
 * `server-only` を付けない純粋モジュールにしてあるのは、
 * 列の役割判定（column-roles.ts）やテストからも同じ実装を使うため。
 * 解析本体（parsers.ts）はここを再輸出する。
 */

/**
 * 対応: "1,234.5"（日英）/ "1.234,5"・"1 234,5"（独仏）/ 全角数字 / % や単位の付随。
 * 解釈できなければ null（勝手に 0 にしない）。
 */
export function parseFlexibleNumber(raw: string): number | null {
  let v = raw.normalize('NFKC').trim();
  if (v === '') return null;
  v = v.replace(/[%％]/g, '').replace(/[△▲]/g, '-').trim();
  // 数値以外の後置語（単位など）を落とす: "1,234.5 t-CO2e" → "1,234.5"
  const m = v.match(/^[-+]?[\d.,\s]+/);
  if (!m) return null;
  v = m[0].replace(/\s/g, '');

  const lastComma = v.lastIndexOf(',');
  const lastDot = v.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      // 1.234,5 → ドイツ・フランス式（. = 桁区切り, , = 小数点）
      v = v.replace(/\./g, '').replace(',', '.');
    } else {
      // 1,234.5 → 日英式
      v = v.replace(/,/g, '');
    }
  } else if (lastDot >= 0 && /^\d{1,3}(\.\d{3})+$/.test(v)) {
    // "2.845" はドイツ式なら 2845、日英式なら 2.845 で判別不能。
    // 契約どおり「解釈できなければ null」を返し、要確認として人へ委ねる
    // （誤って 1/1000 の値を高確信度で書き込む事故を防ぐ）。
    return null;
  } else if (lastComma >= 0) {
    const frac = v.length - lastComma - 1;
    // "1,5" のようにカンマ後が 1〜2 桁だけなら小数点、それ以外（"1,234"）は桁区切り
    v =
      frac > 0 && frac < 3 && v.indexOf(',') === lastComma
        ? v.replace(',', '.')
        : v.replace(/,/g, '');
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
