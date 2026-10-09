import type {
  RequirementMappingSuggestionOutput,
  RequirementMappingTargetKind,
  XbrlTagSuggestionOutput,
} from './schemas';

/**
 * トライアル対応（2026-10）の 2 つの Use Case の決定論的な Mock（MockAIProvider から呼ぶ）。
 *
 * どちらも入力にある候補（要求事項・概念）の中から、題名・ラベルの文字の重なりで選ぶ。乱数は使わない
 * （同じ入力からは常に同じ候補）。入力に無い ID・概念は作らない。候補であり、採用・確定は人が行う。
 */

export const MOCK_SUGGESTION_WARNING =
  'デモ生成（Mock）の候補です。採用する前に本文と要求事項を確認してください。';
export const SAMPLE_TAXONOMY_WARNING =
  '概念の一覧はデモ用の架空のサンプルで、公式のタクソノミではありません（提出用ではありません）。';

/** 2 文字ずつの塊（日本語の題名どうしの重なりを数える） */
function bigrams(text: string): Set<string> {
  const normalized = text.replace(/[\s（）()「」・、。,.:：\-_/]/g, '').toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i += 1) out.add(normalized.slice(i, i + 2));
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

interface MappingCandidateInput {
  itemId: string;
  itemCode: string;
  title: string;
  /** 架空のサンプルの要求事項か */
  sample?: boolean;
}

export function mockRequirementMapping(
  input: Record<string, unknown>,
): RequirementMappingSuggestionOutput {
  const targetKind = (
    ['narrative_version', 'disclosure_block', 'requirement_item'].includes(String(input.targetKind))
      ? input.targetKind
      : 'narrative_version'
  ) as RequirementMappingTargetKind;
  const text = String(input.targetText ?? '');
  const candidates = (
    Array.isArray(input.candidates) ? input.candidates : []
  ) as MappingCandidateInput[];
  const textGrams = bigrams(text);
  const scored = candidates
    .filter((c) => typeof c.itemId === 'string' && typeof c.itemCode === 'string')
    .map((c) => ({ c, score: overlap(bigrams(String(c.title ?? '')), textGrams) }))
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score || (a.c.itemCode < b.c.itemCode ? -1 : 1))
    .slice(0, 5);
  const warnings = [MOCK_SUGGESTION_WARNING];
  if (candidates.some((c) => c.sample)) {
    warnings.push('候補の要求事項に架空のサンプル（条文ではない）が含まれます。');
  }
  if (scored.length === 0) warnings.push('本文から対応しうる要求事項を見つけられませんでした。');
  return {
    targetKind,
    candidates: scored.map(({ c, score }) => ({
      itemId: c.itemId,
      itemCode: c.itemCode,
      relation:
        targetKind === 'requirement_item'
          ? score >= 6
            ? 'equivalent'
            : score >= 3
              ? 'partial'
              : 'related'
          : null,
      rationale: `本文と要求事項「${c.title}」の語句が ${score} か所重なっています（デモ生成の推定）。`,
      confidence: round2(Math.min(0.85, 0.3 + score * 0.05)),
    })),
    confidence: scored.length > 0 ? 0.5 : 0.2,
    warnings,
    sources: scored.map(({ c }) => ({
      kind: 'requirement' as const,
      id: c.itemId,
      label: c.itemCode,
      locator: null,
      periodLabel: null,
    })),
  };
}

interface XbrlTargetInput {
  targetKind: 'metric' | 'block';
  targetRef: string;
  label: string;
}

interface XbrlConceptInput {
  localName: string;
  kind: string;
  labelJa: string;
}

export function mockXbrlTagSuggestion(input: Record<string, unknown>): XbrlTagSuggestionOutput {
  const targets = (Array.isArray(input.targets) ? input.targets : []) as XbrlTargetInput[];
  const concepts = (Array.isArray(input.concepts) ? input.concepts : []) as XbrlConceptInput[];
  const out: XbrlTagSuggestionOutput['candidates'] = [];
  const used: XbrlConceptInput[] = [];
  const warnings = [SAMPLE_TAXONOMY_WARNING, MOCK_SUGGESTION_WARNING];
  for (const target of targets) {
    if (target.targetKind !== 'metric' && target.targetKind !== 'block') continue;
    const wantedKind = target.targetKind === 'metric' ? 'item' : 'text_block';
    const labelGrams = bigrams(String(target.label ?? ''));
    const best = concepts
      .filter((c) => c.kind === wantedKind && typeof c.localName === 'string')
      .map((c) => ({ c, score: overlap(bigrams(String(c.labelJa ?? '')), labelGrams) }))
      .filter((x) => x.score >= 2)
      .sort((a, b) => b.score - a.score || (a.c.localName < b.c.localName ? -1 : 1))[0];
    if (!best) {
      warnings.push(`「${target.label}」に対応しうる概念を見つけられませんでした。`);
      continue;
    }
    used.push(best.c);
    out.push({
      targetKind: target.targetKind,
      targetRef: String(target.targetRef),
      conceptLocalName: best.c.localName,
      periodRole: 'current',
      rationale: `「${target.label}」と概念「${best.c.labelJa}」の語句が ${best.score} か所重なっています（デモ生成の推定）。`,
      confidence: round2(Math.min(0.8, 0.3 + best.score * 0.05)),
    });
  }
  return {
    candidates: out,
    confidence: out.length > 0 ? 0.45 : 0.15,
    warnings,
    sources: used.map((c) => ({
      kind: 'xbrl_concept' as const,
      id: null,
      label: c.localName,
      locator: null,
      periodLabel: null,
    })),
  };
}
