/**
 * disclosureBlockDraft の決定論的 Mock（docs/disclosure-first.md §2-3、指示書 §9）。
 *
 * 守ること:
 *  - 文は入力の source の本文（引用・定性情報・数値）だけから作る。入力に無い体制・頻度・実績を足さない
 *    （既存の ssbjDisclosureDraft の Mock は入力に無いガバナンスの事実を書いていた。W0 棚卸しの指摘）
 *  - 過年度の記載（prior_year_text / style_reference / prior_block）だけでは当年度の事実を書かず、
 *    不足情報を返す（A15）
 *  - 当年度の根拠同士で同じ事項の数値・頻度が食い違えば、どちらも本文にせず両方の出典を conflicts に挙げる（A16）
 *
 * `server-only` を付けない純粋モジュール（Mock Provider・テストが同じ実装を使う）。
 */

import type {
  DisclosureBlockDraftOutput,
  DisclosureDraftOperation,
  DisclosureDraftSourceKind,
  DisclosureDraftSourceRef,
} from './schemas';

/** 入力 source の時点・用途の区分。current_fact と current_body だけが当年度の本文の根拠になる */
export const DRAFT_SOURCE_USAGES = [
  'current_fact',
  'current_body',
  'prior_year_text',
  'style_reference',
  'unclassified',
  'unapproved',
  'requirement',
] as const;
export type DraftSourceUsage = (typeof DRAFT_SOURCE_USAGES)[number];

/** 当年度の本文の根拠にしてよい区分 */
export function isGroundingUsage(usage: DraftSourceUsage): boolean {
  return usage === 'current_fact' || usage === 'current_body';
}

/** AI へ渡す source（disclosure-ai-draft.ts が組み立てる。ID は許可リストと同じ値） */
export interface DraftSourceInput {
  kind: DisclosureDraftSourceKind;
  id: string;
  label: string;
  usage: DraftSourceUsage;
  periodLabel: string | null;
  locator: string | null;
  /** 引用・定性情報の本文・前年の段落・要求事項の本文・整える段落の本文 */
  text: string;
  /** 前年の節・整える段落の段落 ID */
  paragraphId?: string | null;
  /** 数値（metric_version）の表示用文字列（例: 1,190.9 t-CO2e）と名前 */
  metric?: { name: string; display: string; boundary: string; approved: boolean } | null;
  /** 定性情報の未記入のテンプレート項目（ラベル） */
  missingFields?: string[];
  /** 定性情報の版が根拠にした引用位置のうち、入力にも含まれているもの */
  anchorIds?: string[];
  /** 要求事項（requirement）の基準の版とコード */
  requirement?: { code: string; frameworkVersionId: string } | null;
}

export interface DraftInvocationInput {
  operation: DisclosureDraftOperation;
  blockTitle: string;
  periodLabel: string;
  sources: DraftSourceInput[];
  /** 現在の本文にある段落 ID（置き換え候補の対象にできるもの） */
  currentParagraphIds: string[];
}

function ref(source: DraftSourceInput): DisclosureDraftSourceRef {
  return { kind: source.kind, id: source.id, locator: source.locator };
}

function snippet(text: string, max = 40): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 文を句点（。！？）で分ける。句点は文に残し、前後の空白は落とす */
export function splitSentences(text: string): string[] {
  return (text.match(/[^。！？]+[。！？]?/g) ?? []).map((s) => s.trim()).filter(Boolean);
}

/** 下書きの 1 段落に使う根拠の文の数（長い根拠をそのまま貼り付けず、短い段落にする） */
export const MAX_DRAFT_SENTENCES = 2;

/** 出典の注記。資料のファイル名は書かない（対外の原稿へ社内資料の名前を出さない。出典は出典印で示す） */
function attributionOf(source: DraftSourceInput): string {
  if (source.kind === 'narrative_version') return `定性情報「${source.label}」`;
  if (source.locator) return `引用位置 ${source.locator}`;
  return '選択した根拠';
}

/**
 * 根拠 1 件から、根拠にある事実だけを言い直した短い段落を作る（決定論的）。
 *  - 事実の文は根拠の文をそのまま使う（数値・固有名詞・頻度を作り替えない。入力に無い事実を足さない）
 *  - 前置きは節の主題（入力の節名）だけ、末尾に出典の注記を付ける
 *  - 根拠の本文を丸ごと貼らない（同じ定性情報を引用した段落と本文が重複しないように）
 */
export function composeGroundedParagraph(
  source: DraftSourceInput,
  input: Pick<DraftInvocationInput, 'blockTitle'>,
): string {
  const facts = splitSentences(source.text).slice(0, MAX_DRAFT_SENTENCES).join('');
  return `${input.blockTitle}について、${facts}（出典: ${attributionOf(source)}）`;
}

// ----------------------------------------------------------------------
// 主張（事項・単位・値）の抽出。食い違いと前年からの変更の検出に使う
// ----------------------------------------------------------------------

export interface ExtractedClaim {
  /** 事項（例: サステナビリティ委員会／開催） */
  key: string;
  subject: string;
  verb: string;
  unit: string;
  value: number;
  /** 本文に書かれたままの表記（例: 年4回） */
  written: string;
}

const CLAIM_RE =
  /(年|月|週|四半期に)?\s*([0-9０-９][0-9０-９,，.．]*)\s*(回|名|人|件|%|％|t-CO2e|百万円|億円|円|MWh|拠点|社)/g;
const NOUN_RUN_RE = /[ァ-ヶー一-龠々A-Za-z0-9０-９]+$/;
const VERB_RE = /([一-龠々]{2,})(する|し|した|して|します|しています|しており|され)/;

function toHalfWidthNumber(text: string): number {
  const normalized = text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，,]/g, '')
    .replace(/．/g, '.');
  return Number(normalized);
}

/**
 * 文から「事項＋単位＋値」を拾う。
 * 事項は、数値より前にある文の主題（「X は」「X が」）を優先し、無ければ数値の直前の名詞にする。
 * 動詞（開催・報告など）も鍵に含め、「年4回開催」と「年2回報告」を同じ事項と誤認しない。
 */
export function extractClaims(text: string): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];
  for (const sentence of text.split(/[。．\n]/)) {
    for (const match of sentence.matchAll(CLAIM_RE)) {
      const [written, prefix = '', numberPart = '', unit = ''] = match;
      const value = toHalfWidthNumber(numberPart);
      if (!Number.isFinite(value)) continue;
      const before = sentence.slice(0, match.index ?? 0);
      const topic = /([ァ-ヶー一-龠々A-Za-z0-9]+)(?:は|が)/.exec(before)?.[1];
      const nearest = before.replace(/[ぁ-ん、，\s]+$/, '').match(NOUN_RUN_RE)?.[0];
      const subject = topic ?? nearest ?? '';
      if (subject.length < 2) continue;
      const after = sentence.slice((match.index ?? 0) + written.length);
      const verb = VERB_RE.exec(after)?.[1] ?? '';
      const unitKey = `${prefix}${unit === '％' ? '%' : unit}`;
      claims.push({
        key: `${subject}|${verb}|${unitKey}`,
        subject,
        verb,
        unit: unitKey,
        value,
        written: written.trim(),
      });
    }
  }
  return claims;
}

function claimLabel(claim: ExtractedClaim): string {
  return claim.verb ? `${claim.subject}の${claim.verb}` : claim.subject;
}

// ----------------------------------------------------------------------
// 類似度（前年の段落と当年度の根拠の対応付け）
// ----------------------------------------------------------------------

function bigrams(text: string): Set<string> {
  const flat = text.replace(/[\s、。，．（）()「」]/g, '');
  const grams = new Set<string>();
  for (let i = 0; i < flat.length - 1; i += 1) grams.add(flat.slice(i, i + 2));
  return grams;
}

/** 重なり係数（|A∩B| / min(|A|,|B|)）。短い段落が長い資料に含まれる場合も拾う */
export function overlapScore(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const gram of x) if (y.has(gram)) shared += 1;
  return shared / Math.min(x.size, y.size);
}

const MATCH_THRESHOLD = 0.35;

// ----------------------------------------------------------------------
// 本体
// ----------------------------------------------------------------------

type DraftBlock = DisclosureBlockDraftOutput['draftBlocks'][number];
type Missing = DisclosureBlockDraftOutput['missingInformation'][number];
type Conflict = DisclosureBlockDraftOutput['conflicts'][number];

/** 当年度の根拠同士の食い違い。関わった source の ID を返す（本文に使わない） */
function detectConflicts(sources: DraftSourceInput[]): {
  conflicts: Conflict[];
  conflicted: Set<string>;
} {
  const byKey = new Map<string, Array<{ claim: ExtractedClaim; source: DraftSourceInput }>>();
  for (const source of sources) {
    for (const claim of extractClaims(source.text)) {
      const list = byKey.get(claim.key) ?? [];
      list.push({ claim, source });
      byKey.set(claim.key, list);
    }
  }
  const conflicts: Conflict[] = [];
  const conflicted = new Set<string>();
  for (const entries of byKey.values()) {
    const distinctSources = new Set(entries.map((e) => `${e.source.kind}:${e.source.id}`));
    const distinctValues = new Set(entries.map((e) => e.claim.value));
    if (distinctSources.size < 2 || distinctValues.size < 2) continue;
    const first = entries[0];
    if (!first) continue;
    const seen = new Set<string>();
    const refs: DisclosureDraftSourceRef[] = [];
    const parts: string[] = [];
    for (const { claim, source } of entries) {
      const key = `${source.kind}:${source.id}`;
      conflicted.add(key);
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref(source));
      parts.push(`${claim.written}（${source.label}）`);
    }
    conflicts.push({
      subject: claimLabel(first.claim),
      detail: `根拠によって記載が異なります: ${parts.join(' ／ ')}。どちらが正しいかを確認するまで本文には書きません。`,
      sourceRefs: refs,
    });
  }
  return { conflicts, conflicted };
}

function priorOnlyMissing(prior: DraftSourceInput[]): Missing[] {
  return prior
    .filter((s) => s.kind !== 'requirement')
    .map((s) => ({
      item: `前年の記載「${snippet(s.text)}」`,
      reason:
        '過年度の記載・文体の参考は当年度の事実の根拠にしません。当年度の体制・頻度・実績を示す根拠がありません。',
      nextCheck: '当年度の資料（委員会資料・社内規程など）の該当箇所を根拠として選択してください。',
    }));
}

function narrativeMissing(sources: DraftSourceInput[]): Missing[] {
  return sources.flatMap((s) =>
    (s.missingFields ?? []).map((label) => ({
      item: `「${s.label}」の${label}`,
      reason: '定性情報のテンプレート項目が未記入です。',
      nextCheck: `定性情報「${s.label}」の担当部署に確認してください。`,
    })),
  );
}

function usedRequirements(sources: DraftSourceInput[]) {
  return sources
    .filter((s) => s.kind === 'requirement' && s.requirement)
    .map((s) => ({
      requirementId: s.id,
      code: s.requirement?.code ?? '',
      frameworkVersionId: s.requirement?.frameworkVersionId ?? '',
    }));
}

function sourceMeta(sources: DraftSourceInput[]) {
  return sources
    .filter((s) => s.kind !== 'block_paragraph')
    .map((s) => ({
      kind: s.kind as Exclude<DisclosureDraftSourceKind, 'block_paragraph'>,
      id: s.id,
      label: s.label,
      locator: s.locator,
      periodLabel: s.periodLabel,
    }));
}

/** 選択した根拠から下書き */
function draftFromSources(input: DraftInvocationInput): DisclosureBlockDraftOutput {
  const current = input.sources.filter(
    (s) => isGroundingUsage(s.usage) && s.kind !== 'requirement',
  );
  const nonGrounding = input.sources.filter(
    (s) => !isGroundingUsage(s.usage) && s.kind !== 'requirement',
  );
  const warnings: string[] = [];
  const missing: Missing[] = [...narrativeMissing(input.sources)];

  const unapproved = input.sources.filter((s) => s.usage === 'unapproved');
  for (const s of unapproved) {
    warnings.push(`未承認の数値は下書きに使いません: ${s.label}`);
    missing.push({
      item: s.label,
      reason: '数値が承認されていません。',
      nextCheck: '数値の承認を依頼してください。',
    });
  }
  const priorLike = nonGrounding.filter((s) => s.usage !== 'unapproved');
  if (priorLike.length > 0) {
    warnings.push(
      `過年度の記載・文体の参考（${priorLike.length} 件）は当年度の事実の根拠にしていません。`,
    );
  }

  if (current.length === 0) {
    return {
      operation: 'draft_from_sources',
      draftBlocks: [],
      missingInformation: [
        {
          item: `「${input.blockTitle}」の当年度の記載`,
          reason:
            '当年度の事実の根拠（当年度の資料・定性情報・承認済みの数値）が選択されていません。',
          nextCheck: '当年度の根拠を選択してから、もう一度実行してください。',
        },
        ...priorOnlyMissing(priorLike),
        ...missing,
      ],
      conflicts: [],
      usedRequirementVersions: usedRequirements(input.sources),
      confidence: 0.1,
      warnings,
      sources: sourceMeta(input.sources),
    };
  }

  const { conflicts, conflicted } = detectConflicts(
    current.filter((s) => s.kind !== 'metric_version'),
  );
  for (const conflict of conflicts) warnings.push(`相反する根拠: ${conflict.subject}`);

  const inputAnchorIds = new Set(
    input.sources.filter((s) => s.kind === 'source_anchor').map((s) => s.id),
  );
  const blocks: DraftBlock[] = [];
  for (const source of current) {
    if (conflicted.has(`${source.kind}:${source.id}`)) {
      missing.push({
        item: `「${snippet(source.text)}」`,
        reason: '他の根拠と記載が食い違うため、本文にしていません。',
        nextCheck: '食い違いを確認し、正しい根拠だけを選択してください。',
      });
      continue;
    }
    if (source.kind === 'metric_version' && source.metric) {
      blocks.push({
        paragraphId: null,
        kind: 'paragraph',
        text: `${input.periodLabel}の${source.metric.name}（${source.metric.boundary}）は ${source.metric.display} です。`,
        sourceRefs: [ref(source)],
      });
      continue;
    }
    const citeRefs = (source.anchorIds ?? [])
      .filter((id) => inputAnchorIds.has(id))
      .map((id) => ({ kind: 'source_anchor' as const, id, locator: null }));
    blocks.push({
      paragraphId: null,
      kind: 'paragraph',
      text: composeGroundedParagraph(source, input),
      sourceRefs: [ref(source), ...citeRefs],
    });
  }

  return {
    operation: 'draft_from_sources',
    draftBlocks: blocks,
    missingInformation: missing,
    conflicts,
    usedRequirementVersions: usedRequirements(input.sources),
    // 根拠の数で素直に上げる（過度に高く見せない）
    confidence: Math.min(0.8, 0.3 + 0.1 * blocks.length),
    warnings,
    sources: sourceMeta(input.sources),
  };
}

/** 前年からの変更案 */
function updateFromPriorYear(input: DraftInvocationInput): DisclosureBlockDraftOutput {
  const prior = input.sources.filter((s) => s.kind === 'prior_block');
  const current = input.sources.filter(
    (s) => isGroundingUsage(s.usage) && s.kind !== 'requirement' && s.kind !== 'metric_version',
  );
  const warnings: string[] = [];
  const missing: Missing[] = [...narrativeMissing(input.sources)];

  if (prior.length === 0) {
    missing.push({
      item: '前年の記載',
      reason: '前年の節が選択されていません。',
      nextCheck: '前年のプロジェクトに同じ節があるか確認してください。',
    });
  }

  const { conflicts, conflicted } = detectConflicts(current);
  for (const conflict of conflicts) warnings.push(`相反する根拠: ${conflict.subject}`);
  const usable = current.filter((s) => !conflicted.has(`${s.kind}:${s.id}`));

  // 前年の段落ごとに、当年度の根拠で最も近いものを 1 つ対応付ける（同じ根拠を 2 度使わない）
  const pairs: Array<{ prior: DraftSourceInput; source: DraftSourceInput; score: number }> = [];
  for (const p of prior) {
    for (const s of usable) {
      const score = overlapScore(p.text, s.text);
      if (score >= MATCH_THRESHOLD) pairs.push({ prior: p, source: s, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.prior.text.localeCompare(b.prior.text));
  const matched = new Map<DraftSourceInput, DraftSourceInput>();
  const used = new Set<DraftSourceInput>();
  for (const pair of pairs) {
    if (matched.has(pair.prior) || used.has(pair.source)) continue;
    matched.set(pair.prior, pair.source);
    used.add(pair.source);
  }

  const currentIds = new Set(input.currentParagraphIds);
  const blocks: DraftBlock[] = [];
  for (const p of prior) {
    const source = matched.get(p);
    if (!source) {
      missing.push(...priorOnlyMissing([p]));
      continue;
    }
    // 前年から変わった数値・頻度を知らせる（変更点を本文の差分だけで見落とさない）
    const before = extractClaims(p.text);
    for (const claim of extractClaims(source.text)) {
      const old = before.find((c) => c.key === claim.key);
      if (old && old.value !== claim.value) {
        warnings.push(
          `前年から変更: ${claimLabel(claim)} ${old.written} → ${claim.written}（${source.label}）`,
        );
      }
    }
    blocks.push({
      paragraphId: p.paragraphId && currentIds.has(p.paragraphId) ? p.paragraphId : null,
      kind: 'paragraph',
      text: composeGroundedParagraph(source, input),
      sourceRefs: [ref(source), ref(p)],
    });
  }

  return {
    operation: 'update_from_prior_year',
    draftBlocks: blocks,
    missingInformation: missing,
    conflicts,
    usedRequirementVersions: usedRequirements(input.sources),
    confidence: blocks.length === 0 ? 0.1 : Math.min(0.75, 0.3 + 0.1 * blocks.length),
    warnings,
    sources: sourceMeta(input.sources),
  };
}

/** 表記の揺れだけを整える（意味・数値は変えない） */
export function polishText(text: string): string {
  let out = text
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\s*([、。，．])\s*/g, '$1')
    .replace(/。{2,}/g, '。')
    .replace(/、{2,}/g, '、')
    // 全角文字どうしの間の半角スペース（全角の文中に紛れた空白）を詰める
    .replace(/([^ -~]) ([^ -~])/g, '$1$2')
    .trim();
  if (out.length > 0 && !/[。．！？」）)]$/.test(out)) out = `${out}。`;
  return out;
}

/** 文章を整える */
function polish(input: DraftInvocationInput): DisclosureBlockDraftOutput {
  const paragraphs = input.sources.filter((s) => s.kind === 'block_paragraph');
  const blocks: DraftBlock[] = [];
  for (const p of paragraphs) {
    const next = polishText(p.text);
    if (next === p.text || next.length === 0) continue;
    blocks.push({
      paragraphId: p.paragraphId ?? null,
      kind: 'paragraph',
      text: next,
      sourceRefs: [ref(p)],
    });
  }
  return {
    operation: 'polish',
    draftBlocks: blocks,
    missingInformation: [],
    conflicts: [],
    usedRequirementVersions: usedRequirements(input.sources),
    confidence: blocks.length === 0 ? 0.5 : 0.6,
    warnings: blocks.length === 0 ? ['整える箇所は見つかりませんでした。'] : [],
    sources: sourceMeta(input.sources),
  };
}

export function buildMockDisclosureDraft(input: DraftInvocationInput): DisclosureBlockDraftOutput {
  switch (input.operation) {
    case 'draft_from_sources':
      return draftFromSources(input);
    case 'update_from_prior_year':
      return updateFromPriorYear(input);
    case 'polish':
      return polish(input);
  }
}
