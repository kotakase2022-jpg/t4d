/**
 * サプライヤー一次データの単位正規化（純粋・決定論）。
 *
 * scope3-suppliers.ts（サーバー側の解析・確定）と取込フォーム（クライアントの
 * 再計算・単位手修正の検証）の両方が同じ規則を使うため、`server-only` を
 * 付けない純粋モジュールへ切り出した（2026-09-15 指示①-2: 単位の手修正対応）。
 */

export interface NormalizedUnit {
  kind: 'emissions' | 'monetary' | 'physical';
  /** 正規化後の単位（monetary は常に 千円） */
  unit: string;
  /** 正規化後の単位へ揃えるための倍率（例: 円 → 千円 は 0.001） */
  multiplier: number;
}

/** 単位表記のゆらぎを吸収する（NFKC + 小文字化した表記 → 正規形） */
export function normalizeUnit(raw: string): NormalizedUnit | null {
  const v = raw.normalize('NFKC').trim().toLowerCase();
  if (v === '') return null;
  // 排出量
  if (/^t-?co2e?$/.test(v)) return { kind: 'emissions', unit: 't-CO2e', multiplier: 1 };
  if (/^kg-?co2e?$/.test(v)) return { kind: 'emissions', unit: 't-CO2e', multiplier: 0.001 };
  // 金額（円建てのみ。外貨は換算根拠を持てないため受け付けない）
  if (v === '千円' || v === 'kjpy' || v === 'k jpy' || v === 'jpy k' || v === 'thousand jpy') {
    return { kind: 'monetary', unit: '千円', multiplier: 1 };
  }
  if (v === '円' || v === 'jpy') return { kind: 'monetary', unit: '千円', multiplier: 0.001 };
  if (v === '百万円') return { kind: 'monetary', unit: '千円', multiplier: 1000 };
  // 物理量
  if (v === 'kwh') return { kind: 'physical', unit: 'kWh', multiplier: 1 };
  if (v === 'mwh') return { kind: 'physical', unit: 'kWh', multiplier: 1000 };
  if (v === 'm3' || v === '㎥' || v === 'm³' || v === 'nm3') {
    return { kind: 'physical', unit: 'm3', multiplier: 1 };
  }
  if (v === 'l' || v === 'ℓ' || v === 'リットル')
    return { kind: 'physical', unit: 'L', multiplier: 1 };
  if (v === 'kl') return { kind: 'physical', unit: 'L', multiplier: 1000 };
  if (v === 'kg') return { kind: 'physical', unit: 'kg', multiplier: 1 };
  if (v === 'g' || v === 'グラム') return { kind: 'physical', unit: 'kg', multiplier: 0.001 };
  if (v === 't' || v === 'トン') return { kind: 'physical', unit: 't', multiplier: 1 };
  if (/^(個|pcs?|pieces?|ea)$/.test(v)) return { kind: 'physical', unit: '個', multiplier: 1 };
  if (/^(m2|㎡|m²|sqm)$/.test(v)) return { kind: 'physical', unit: 'm2', multiplier: 1 };
  return null;
}

export const SUPPORTED_UNITS_HINT =
  '対応単位: t-CO2e（排出量）／ 千円・円・百万円（金額）／ kWh・MWh・m3・L・kL・g・kg・t・個・m2（物理量）';
