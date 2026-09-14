/**
 * デモ表示用の信頼度（村田製作所向けデモ要件: 表示 80〜97%）。
 *
 * 取込処理が返した実測スコア（raw）は一切書き換えず、**画面表示の直前**で
 * デモ専用の表示値へ変換する。変換値はどこにも保存しない
 * （保存しないので、デモモードを解除しても実測値として復活しようがない）。
 *
 * 決定論: 値は「raw × 行内容のハッシュ × 固定 seed」から決まる。
 * 乱数を引かないため、同じファイル・同じ行なら 再読み込み・再取込・並べ替え・
 * 別セッションでも同じ表示になる。
 *
 * 対象はあくまで「信頼度」の表示のみ。承認判定・行の取込可否・品質判定は
 * raw と状態（status / errors）だけを見る既存ロジックのまま。
 *
 * `server-only` を付けない純粋モジュール（表示部品とテストから共用するため）。
 */

export const DEMO_CONFIDENCE_MIN = 0.8;
export const DEMO_CONFIDENCE_MAX = 0.97;

/** FNV-1a（32bit）。行内容から再現可能なゆらぎを作るためだけの軽量ハッシュ */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const DEMO_SEED = 't4d-murata-demo-2026';

/**
 * raw（0〜1）をデモ表示値（0.80〜0.97）へ写す。
 *
 * - 基本形: raw 0.35 以下 → 下限側、raw 0.90 以上 → 上限側 へ線形に伸ばす
 * - ゆらぎ: 行内容ハッシュから ±0.02（90〜96% 中心の自然な分布を作る）
 * - 欠損・NaN・0〜1 範囲外は変換しない（null を返す。数値化で正常扱いしない）
 */
export function demoDisplayConfidence(
  raw: number | null | undefined,
  stableKey: string,
): number | null {
  if (raw === null || raw === undefined || Number.isNaN(raw) || raw < 0 || raw > 1) return null;
  const normalized = Math.min(Math.max((raw - 0.35) / 0.55, 0), 1);
  // 3 区間の折れ線で 90〜96% へ質量を寄せる（下位 15% → 80〜88、中位 → 88〜96.2、上位 8% → 96.2〜97）
  const base =
    normalized <= 0.15
      ? 0.8 + (normalized / 0.15) * 0.08
      : normalized <= 0.92
        ? 0.88 + ((normalized - 0.15) / 0.77) * 0.082
        : 0.962 + ((normalized - 0.92) / 0.08) * 0.008;
  const jitter = ((fnv1a(`${DEMO_SEED}|${stableKey}`) % 401) / 400 - 0.5) * 0.04; // ±0.02
  const value = Math.min(Math.max(base + jitter, DEMO_CONFIDENCE_MIN), DEMO_CONFIDENCE_MAX);
  return Math.round(value * 1000) / 1000;
}

export type ConfidenceSource = 'measured' | 'demo_simulated';

export interface ResolvedConfidence {
  /** 画面に表示する値（0〜1）。raw が無ければ null */
  display: number | null;
  /** 取込処理が返した元のスコア。欠損は欠損のまま */
  raw: number | null;
  source: ConfidenceSource;
}

/**
 * アプリモードに応じて表示値を決める共通セレクター。
 * demo モード（Fixture データのみが存在する環境）でだけシミュレーション値を使い、
 * 通常モード（supabase）では実測値をそのまま表示する。
 * ファイル名等でのデモ判定は行わない。
 */
export function resolveDisplayConfidence(
  appMode: string,
  raw: number | null | undefined,
  stableKey: string,
): ResolvedConfidence {
  const safeRaw = raw === null || raw === undefined || Number.isNaN(raw) ? null : raw;
  if (appMode !== 'demo' || safeRaw === null) {
    return { display: safeRaw, raw: safeRaw, source: 'measured' };
  }
  const display = demoDisplayConfidence(safeRaw, stableKey);
  if (display === null) {
    return { display: safeRaw, raw: safeRaw, source: 'measured' };
  }
  return { display, raw: safeRaw, source: 'demo_simulated' };
}
