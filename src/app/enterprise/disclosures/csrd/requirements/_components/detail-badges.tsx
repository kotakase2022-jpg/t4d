import { Bot } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/**
 * 要求事項の詳細で使う状態バッジ（ラベル＋アイコン。色だけで状態を表さない）。
 * データの状況のバッジは収集画面と共通のため `../../_components/csrd-badges` にある。
 */

/**
 * AI の候補の出所。Mock（API 未接続）は「デモ生成（Mock）」と明示する。
 * Fixture の候補は ai_runs の行を持たないが、架空のデモ生成なので Mock と同じ表示にする
 */
export function AiCandidateBadge({ provider }: { provider: 'openai' | 'mock' }) {
  return provider === 'mock' ? (
    <Badge tone="warning" title="OpenAI API 未接続。決定論的な Mock の出力（架空）です。">
      <Bot className="size-3" aria-hidden="true" />
      デモ生成（Mock）
    </Badge>
  ) : (
    <Badge tone="brand" title="AI が作成した候補です。担当者の確認が必要です。">
      <Bot className="size-3" aria-hidden="true" />
      AI 生成（候補）
    </Badge>
  );
}
