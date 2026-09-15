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

/**
 * シミュレーション表示の対象になる行状態。
 *
 * 2026-09-15 指示④で needs_review / duplicate も対象に加えた。
 * 表に残る行が 80〜97% 帯に収まるのは demoDisplayConfidence のクランプによる保証で、
 * 指標特定済みの低確信行（定義ズレ等・実測 0.42〜0.52）も帯へ写る。
 * 状態バッジ（要確認・重複）と警告はそのまま出す
 * （変えるのは % の見た目と置き場所だけ。保存された行・状態・実測値は変えない）。
 */
const SIMULATED_STATUSES = new Set(['mapped', 'confirmed', 'needs_review', 'duplicate']);

/**
 * デモ表示要件（2026-09-15 指示④）: **指標を特定できず**かつ実測確信度がこの値を
 * 下回る行は、プレビュー表に出さず「指標マスターと関係が無いため、取り込み対象外に
 * しました」の折りたたみへ回す（Demo Mode 限定・**表示だけ**。保存された行の
 * status・confidence は変更しないので、実運用モードやデモ解除後は従来どおり出る）。
 *
 * 「指標が特定できた行」（定義ズレ・単位違い等の要確認・重複を含む）は隠さない——
 * 折りたたみの見出し（指標マスターと関係が無い）と意味が食い違ううえ、
 * 数百行の帳票が数十行に見える事故になる。それらは SIMULATED_STATUSES 側で
 * 80〜97% のデモ表示になるため、表に低い % が並ぶことはない。
 * また **AI が評価していない行（confidence 0 = 行数上限の超過等）も畳まない**。
 * 「マスターと無関係」ではなく未評価なだけで、表に残さないと手動で指標を
 * 選んで確定する経路ごと消えてしまう。
 * しきい値は指標不明行（MockAI で 0.2〜0.46）を確実に含む余裕を持たせた値。
 */
export const DEMO_MIN_VISIBLE_CONFIDENCE = 0.55;

export interface DisplayConfidenceFields {
  displayConfidence: number | null;
  confidenceSource: ConfidenceSource;
  /** デモ表示で「取り込み対象外」の折りたたみへ畳む行（低確信）。表示専用の印 */
  demoHiddenLowConfidence?: boolean;
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
    metricId: string | null;
    sourceLocator: string | null;
    raw: Record<string, string>;
  },
>(rows: T[]): Array<T & DisplayConfidenceFields> {
  const appMode = getAppMode();
  return rows.map((row) => {
    // デモでは「指標を特定できず・低確信」の行を表へ出さず、
    // 「取り込み対象外」の折りたたみへ（表示専用の印）。
    // 確定済みの行は既に人が判断した行なので畳まない
    if (
      appMode === 'demo' &&
      row.status !== 'confirmed' &&
      row.status !== 'ignored' &&
      row.metricId === null &&
      row.confidence > 0 && // 0 = AI 未評価（行数上限の超過等）。低確信とは別物なので畳まない
      row.confidence < DEMO_MIN_VISIBLE_CONFIDENCE
    ) {
      return {
        ...row,
        displayConfidence: row.confidence,
        confidenceSource: 'measured' as const,
        demoHiddenLowConfidence: true,
      };
    }
    // AI 未評価（confidence 0）の行は実測のまま出す。帯へ写すと
    // 「評価していないのに 80%」という嘘の表示になる
    if (!SIMULATED_STATUSES.has(row.status) || row.confidence === 0) {
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
