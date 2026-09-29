/**
 * AI 下書きの「生成を始めた後に本文が変わったか」の判定（A18）。
 *
 * 生成開始時の本文の段落ごとのハッシュを実行記録に残し、採用の時点の本文と比べる。
 * 同じ実行の候補を採用して変わった段落（aiRunId がその実行）は「利用者の編集」に数えない。
 * そうしないと、1 段落採用しただけで残りの候補がすべて競合扱いになる。
 *
 * サーバー（採用の可否）と画面（事前の注意表示）が同じ判定を使うよう、純粋関数として置く。
 */

import { canonicalJson } from '@/lib/domain/disclosure-block';
import { contentHash } from '@/lib/fixtures/ids';
import type { BlockBody, BlockParagraph } from '@/types/domain';

export function paragraphHash(paragraph: BlockParagraph): string {
  return contentHash(canonicalJson(paragraph)).slice(0, 16);
}

export function paragraphHashes(body: BlockBody): Record<string, string> {
  return Object.fromEntries(body.paragraphs.map((p) => [p.id, paragraphHash(p)]));
}

/**
 * 生成開始時（base）から本文が利用者の操作で変わったか。
 * 変わった段落・消えた段落・足された段落のいずれかがあれば true。
 */
export function changedSinceRun(
  base: Readonly<Record<string, string>>,
  body: BlockBody,
  runId: string,
): boolean {
  const seen = new Set<string>();
  for (const paragraph of body.paragraphs) {
    seen.add(paragraph.id);
    if (paragraph.aiRunId === runId) continue;
    const before = base[paragraph.id];
    if (before === undefined || before !== paragraphHash(paragraph)) return true;
  }
  return Object.keys(base).some((id) => !seen.has(id));
}
