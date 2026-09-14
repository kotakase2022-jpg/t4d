import 'server-only';

import { getAppMode } from '@/lib/config';
import { resolveDisplayConfidence } from '@/lib/domain/demo-confidence';
import type { ConfidenceSource } from '@/lib/domain/demo-confidence';

/**
 * 一般取込（データ取込）のプレビュー行へ、デモ表示用の信頼度を付ける共通処理。
 *
 * - raw（row.confidence）はそのまま保持し、displayConfidence を別フィールドで持つ
 * - シミュレーション対象は「正常に解析（マッピング）できた行」だけ。
 *   要確認・重複・除外・未処理の行は実測のまま出す（実際の問題を隠さない）
 * - キーは行の内容（元データ＋位置）なので、再読み込み・並べ替え・
 *   別セッションでも同じ表示になる
 *
 * uploadFilesAction（同一リクエストのプレビュー）と取込ジョブ詳細ページの
 * 両方がこの 1 か所を通ることで、画面ごとに別の数値が出ないようにする。
 */

/** シミュレーション表示の対象になる行状態（=正常解析済み） */
const SIMULATED_STATUSES = new Set(['mapped', 'confirmed']);

export interface DisplayConfidenceFields {
  displayConfidence: number | null;
  confidenceSource: ConfidenceSource;
}

export function importRowConfidenceKey(row: {
  sourceLocator: string | null;
  raw: Record<string, string>;
}): string {
  return `import|${row.sourceLocator ?? ''}|${JSON.stringify(row.raw)}`;
}

export function withDisplayConfidence<
  T extends {
    confidence: number;
    status: string;
    sourceLocator: string | null;
    raw: Record<string, string>;
  },
>(rows: T[]): Array<T & DisplayConfidenceFields> {
  const appMode = getAppMode();
  return rows.map((row) => {
    if (!SIMULATED_STATUSES.has(row.status)) {
      return { ...row, displayConfidence: row.confidence, confidenceSource: 'measured' as const };
    }
    const resolved = resolveDisplayConfidence(appMode, row.confidence, importRowConfidenceKey(row));
    return { ...row, displayConfidence: resolved.display, confidenceSource: resolved.source };
  });
}

/** AI 実行記録（Provenance）など、行以外の確信度表示にも同じ変換を使う */
export function displayRunConfidence(runId: string, raw: number): DisplayConfidenceFields {
  // 行側の「正常解析済みだけ変換」ゲートに相当する下限。
  // 実行が実質失敗している（極端に低い raw の）記録まで 80% 台で見せない
  if (Number.isNaN(raw) || raw < 0.5) {
    return { displayConfidence: Number.isNaN(raw) ? null : raw, confidenceSource: 'measured' };
  }
  const resolved = resolveDisplayConfidence(getAppMode(), raw, `ai-run|${runId}`);
  return { displayConfidence: resolved.display, confidenceSource: resolved.source };
}

/**
 * サプライヤーデータ取込のプレビュー行にも同じデモ変換を適用する。
 * rawConfidence が null の行（エラー・除外・種別不明）は実測のまま＝表示も null で、
 * 「低信頼の行を高く見せる」ことはしない。キーは行の内容ベースなので
 * 同じファイルを再投入しても同じ表示になる。
 */
export function withSupplierDisplayConfidence<
  T extends {
    rawConfidence: number | null;
    supplierCode: string;
    item: string;
    dataType: string | null;
    amountRaw: string;
    unit: string | null;
  },
>(fileName: string, rows: T[]): Array<T & DisplayConfidenceFields> {
  const appMode = getAppMode();
  return rows.map((row) => {
    const key = `supplier|${fileName}|${row.supplierCode}|${row.item}|${row.dataType ?? ''}|${row.amountRaw}|${row.unit ?? ''}`;
    const resolved = resolveDisplayConfidence(appMode, row.rawConfidence, key);
    return { ...row, displayConfidence: resolved.display, confidenceSource: resolved.source };
  });
}
