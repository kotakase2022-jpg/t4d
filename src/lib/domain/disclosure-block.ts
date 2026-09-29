/**
 * 開示本文 AST（BlockBody）の純粋関数（docs/disclosure-first.md §4）。
 *
 * DB にも画面にも依存しない。Service・画面・テストが同じ関数を使い、
 * 「版の内容ハッシュ」「引用している版」「手書き数値の警告」「版の差分」を
 * どこで計算しても同じ結果になるようにする。
 */

import { contentHash } from '@/lib/fixtures/ids';
import type { BlockBody, BlockInline, BlockParagraph, Uuid } from '@/types/domain';

export type { BlockBody, BlockInline, BlockParagraph } from '@/types/domain';

/** 空の本文。段落を 1 つも持たない（空段落を置くと「本文あり」に見えてしまうため） */
export function emptyBody(): BlockBody {
  return { paragraphs: [] };
}

function inlineText(inline: BlockInline): string {
  switch (inline.t) {
    case 'text':
      return inline.text;
    case 'metric':
      return inline.display;
    case 'narrative':
      return inline.quote;
    case 'cite':
      // 出典印は本文の文字ではない（検索・差分・文字数に混ぜない）
      return '';
  }
}

/** 段落の表示テキスト（数値は挿入時の表示文字列、定性情報は採用時の本文） */
export function paragraphText(paragraph: BlockParagraph): string {
  return paragraph.children.map(inlineText).join('');
}

/** 本文全体のプレーンテキスト。段落は改行で区切る（disclosure_block_versions.plain_text） */
export function plainTextOf(body: BlockBody): string {
  return body.paragraphs.map(paragraphText).join('\n');
}

/**
 * 本文があるか。空白だけの段落や出典印だけの段落は「本文なし」とみなす
 * （見出しだけ置いた節をレビューへ回させない）。
 */
export function hasBodyContent(body: BlockBody | null | undefined): boolean {
  if (!body) return false;
  return body.paragraphs.some((p) => p.kind === 'paragraph' && paragraphText(p).trim().length > 0);
}

export interface BlockRefs {
  /** 引用した data_point_versions.id（出現順・重複なし） */
  metricVersionIds: Uuid[];
  /** 引用した narrative_versions.id（出現順・重複なし） */
  narrativeVersionIds: Uuid[];
  /** 出典印の source_anchors.id（出現順・重複なし） */
  anchorIds: Uuid[];
}

/** 本文が参照している版と引用位置を集める（版の metric_refs / narrative_refs / anchor_refs） */
export function collectRefs(body: BlockBody): BlockRefs {
  const metric = new Set<Uuid>();
  const narrative = new Set<Uuid>();
  const anchor = new Set<Uuid>();
  for (const paragraph of body.paragraphs) {
    for (const inline of paragraph.children) {
      if (inline.t === 'metric') metric.add(inline.dataPointVersionId);
      else if (inline.t === 'narrative') narrative.add(inline.narrativeVersionId);
      else if (inline.t === 'cite') anchor.add(inline.sourceAnchorId);
    }
  }
  return {
    metricVersionIds: [...metric],
    narrativeVersionIds: [...narrative],
    anchorIds: [...anchor],
  };
}

/**
 * キー順を固定した JSON。オブジェクトのキーを辞書順に並べ、undefined のキーは落とす。
 * 同じ内容なら生成元（画面・Service・Seed）や組み立て順が違っても同じ文字列になる。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // 数値・文字列・真偽値・null。undefined は配列内だけに現れうるので null に揃える
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** 本文の内容ハッシュ（disclosure_block_versions.content_hash）。キー順に依存しない */
export function contentHashOf(body: BlockBody): string {
  return contentHash(canonicalJson(body));
}

// ----------------------------------------------------------------------
// 手書き数値の検出
//
// 本文に直接書いた「数値＋単位」は許すが、同じ単位の参照可能な指標値があれば
// 参照化（または参照しない理由の説明）を求める（§4）。ここでは候補を拾うだけで、
// 指標値との突合は呼び出し側（Service）が行う。
// ----------------------------------------------------------------------

/** 長い表記から順に並べる（「百万円」を「円」、「千t-CO2e」を「t-CO2e」と誤認しない） */
const UNIT_ALIASES: ReadonlyArray<readonly [written: string, normalized: string]> = [
  ['千t-CO2e', '千t-CO2e'],
  ['千t-CO₂e', '千t-CO2e'],
  ['千tCO2e', '千t-CO2e'],
  ['千tCO₂e', '千t-CO2e'],
  ['t-CO2e', 't-CO2e'],
  ['t-CO₂e', 't-CO2e'],
  ['tCO2e', 't-CO2e'],
  ['tCO₂e', 't-CO2e'],
  ['百万円', '百万円'],
  ['千円', '千円'],
  ['億円', '億円'],
  ['円', '円'],
  ['MWh', 'MWh'],
  ['kWh', 'kWh'],
  ['GJ', 'GJ'],
  ['%', '%'],
  ['％', '%'],
  ['件', '件'],
  ['人', '人'],
  ['名', '人'],
];

const NORMALIZED_UNIT = new Map(UNIT_ALIASES);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 数値＋単位。直前が数字・英字・小数点・区切りの場合は拾わない
 * （「Scope3」の 3、「気候-47」の 47、型番の一部などを数値と誤認しない）。
 */
const HANDWRITTEN_NUMBER_RE = new RegExp(
  '(?<![0-9０-９A-Za-z.．,，_\\-])' +
    '([0-9０-９]{1,3}(?:[,，][0-9０-９]{3})+(?:[.．][0-9０-９]+)?|[0-9０-９]+(?:[.．][0-9０-９]+)?)' +
    '[ \\u3000]?' +
    `(${UNIT_ALIASES.map(([written]) => escapeRegExp(written)).join('|')})`,
  'g',
);

function toHalfWidth(text: string): string {
  return text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/，/g, ',')
    .replace(/．/g, '.');
}

export interface HandwrittenNumber {
  paragraphId: string;
  /** 本文に書かれたままの文字列（例: 「1,234 t-CO2e」） */
  text: string;
  value: number;
  /** 正規化した単位（例: tCO₂e → t-CO2e、％ → %、名 → 人） */
  unit: string;
}

/** 本文の text 部分から「数値＋単位」を拾う。参照（metric）の表示文字列は対象外 */
export function detectHandwrittenNumbers(body: BlockBody): HandwrittenNumber[] {
  const found: HandwrittenNumber[] = [];
  for (const paragraph of body.paragraphs) {
    for (const inline of paragraph.children) {
      if (inline.t !== 'text') continue;
      for (const match of inline.text.matchAll(HANDWRITTEN_NUMBER_RE)) {
        const [text, numberPart, unitPart] = match;
        if (!numberPart || !unitPart) continue;
        const value = Number(toHalfWidth(numberPart).replace(/,/g, ''));
        if (!Number.isFinite(value)) continue;
        found.push({
          paragraphId: paragraph.id,
          text,
          value,
          unit: NORMALIZED_UNIT.get(unitPart) ?? unitPart,
        });
      }
    }
  }
  return found;
}

// ----------------------------------------------------------------------
// 版の差分（段落単位 ＋ 変更段落の文字単位）
//
// 段落 ID は安定なので、段落の対応付けは ID で行う（内容の類似度で推測しない）。
// 新しい npm 依存を増やさないよう、文字単位の差分は LCS で自前実装する。
// ----------------------------------------------------------------------

export type DiffOp = 'equal' | 'insert' | 'delete';

export interface DiffSegment {
  op: DiffOp;
  text: string;
}

export type ParagraphDiff =
  | { kind: 'unchanged'; paragraphId: string; text: string }
  | { kind: 'added'; paragraphId: string; text: string }
  | { kind: 'removed'; paragraphId: string; text: string }
  | {
      kind: 'changed';
      paragraphId: string;
      oldText: string;
      newText: string;
      /** 文字単位の差分。参照先の版だけが変わった段落では equal のみになる */
      segments: DiffSegment[];
    };

/**
 * LCS の表の上限（セル数）。これを超える段落は「全削除＋全挿入」として扱う
 * （1 段落が極端に長い場合にメモリと時間を使い切らないため）。
 */
const MAX_LCS_CELLS = 4_000_000;

function pushSegment(segments: DiffSegment[], op: DiffOp, text: string): void {
  if (text.length === 0) return;
  const last = segments[segments.length - 1];
  if (last && last.op === op) last.text += text;
  else segments.push({ op, text });
}

/** 文字単位の差分（サロゲートペアを 1 文字として扱う） */
export function diffChars(before: string, after: string): DiffSegment[] {
  const a = Array.from(before);
  const b = Array.from(after);

  // 共通の先頭・末尾を先に外し、LCS の表を小さくする
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const segments: DiffSegment[] = [];
  pushSegment(segments, 'equal', a.slice(0, start).join(''));

  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  const n = x.length;
  const m = y.length;

  if (n > 0 && m > 0 && (n + 1) * (m + 1) <= MAX_LCS_CELLS) {
    // lcs[i][j] = x[i..] と y[j..] の最長共通部分列の長さ
    const width = m + 1;
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i * width + j] =
          x[i] === y[j]
            ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) {
        pushSegment(segments, 'equal', x[i] ?? '');
        i += 1;
        j += 1;
      } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
        pushSegment(segments, 'delete', x[i] ?? '');
        i += 1;
      } else {
        pushSegment(segments, 'insert', y[j] ?? '');
        j += 1;
      }
    }
    pushSegment(segments, 'delete', x.slice(i).join(''));
    pushSegment(segments, 'insert', y.slice(j).join(''));
  } else {
    pushSegment(segments, 'delete', x.join(''));
    pushSegment(segments, 'insert', y.join(''));
  }

  pushSegment(segments, 'equal', a.slice(endA).join(''));
  return segments;
}

/** 段落 ID 以外の内容（種別・子要素・AI 由来）が同じか */
function sameParagraph(a: BlockParagraph, b: BlockParagraph): boolean {
  return canonicalJson({ ...a, id: null }) === canonicalJson({ ...b, id: null });
}

/**
 * 2 つの版の差分を段落単位で返す。並びは新しい版の順で、削除された段落は
 * 古い版で直前にあった段落の後ろに置く（削除位置が分かるように）。
 * 古い版が無い（初版）場合はすべて added になる。
 */
export function diffParagraphs(oldBody: BlockBody | null, newBody: BlockBody): ParagraphDiff[] {
  const oldParagraphs = oldBody?.paragraphs ?? [];
  const oldById = new Map(oldParagraphs.map((p) => [p.id, p]));
  const newIds = new Set(newBody.paragraphs.map((p) => p.id));

  // 削除された段落を、古い版で直前にあった「残っている段落」ごとにまとめる（先頭は null）
  const removedAfter = new Map<string | null, BlockParagraph[]>();
  let anchor: string | null = null;
  for (const paragraph of oldParagraphs) {
    if (newIds.has(paragraph.id)) {
      anchor = paragraph.id;
    } else {
      removedAfter.set(anchor, [...(removedAfter.get(anchor) ?? []), paragraph]);
    }
  }

  const result: ParagraphDiff[] = [];
  const emitRemoved = (key: string | null) => {
    for (const paragraph of removedAfter.get(key) ?? []) {
      result.push({ kind: 'removed', paragraphId: paragraph.id, text: paragraphText(paragraph) });
    }
  };

  emitRemoved(null);
  for (const paragraph of newBody.paragraphs) {
    const before = oldById.get(paragraph.id);
    const text = paragraphText(paragraph);
    if (!before) {
      result.push({ kind: 'added', paragraphId: paragraph.id, text });
    } else if (sameParagraph(before, paragraph)) {
      result.push({ kind: 'unchanged', paragraphId: paragraph.id, text });
    } else {
      const oldText = paragraphText(before);
      result.push({
        kind: 'changed',
        paragraphId: paragraph.id,
        oldText,
        newText: text,
        segments: diffChars(oldText, text),
      });
    }
    if (before) emitRemoved(paragraph.id);
  }
  return result;
}
