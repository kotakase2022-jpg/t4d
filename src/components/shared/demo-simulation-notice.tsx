import { FlaskConical } from 'lucide-react';

/**
 * デモ環境の表示スコア注記（村田デモ要件）。
 *
 * 信頼度のシミュレーション表示を行う画面に置く。
 * 「実測の認識精度」や「算定の正確性を保証する割合」と誤読されないよう、
 * シミュレーションであることを明示する（色だけに頼らずアイコン＋文言）。
 * 表示可否の判断（demo モードかどうか）は呼び出し側のサーバー側で行う。
 */
export function DemoSimulationNotice() {
  return (
    <p className="flex items-center gap-1.5 rounded-t4d border border-brand-200 bg-brand-50 px-3 py-1.5 text-[11px] text-brand-900">
      <FlaskConical className="size-3.5 shrink-0 text-brand-600" aria-hidden="true" />
      デモ環境｜サンプルデータ・表示スコアはシミュレーションです（実測の認識精度や算定の正確性を示す値ではありません）
    </p>
  );
}
