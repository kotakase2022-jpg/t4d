/**
 * 原稿編集の段落モデル（クライアントとテストが同じ実装を使う純粋関数）。
 *
 * 本文 AST（BlockBody）の数値・定性情報・出典印は、段落のテキスト欄の中では
 * 「⟦数値1⟧」「⟦引用1⟧」「⟦出典1⟧」という記号で表す。キーボードだけで前後の文を編集でき、
 * 記号を消せば参照も外れる。記号の番号は本文全体で一意にし、別の段落へ切り取り・貼り付けても
 * 同じ参照（版）を保つ。登録されていない記号（手で打った ⟦…⟧）はただの文字として扱う。
 */

import type { BlockBody, BlockInline, BlockParagraph } from '@/types/domain';

export type RefInline = Exclude<BlockInline, { t: 'text' }>;

export interface EditableParagraph {
  id: string;
  kind: 'paragraph' | 'heading';
  aiRunId?: string;
  /** 参照を記号にしたテキスト */
  text: string;
}

export interface EditableBody {
  paragraphs: EditableParagraph[];
  /** 記号 → 参照 */
  refs: Record<string, RefInline>;
}

const KIND_LABEL: Record<RefInline['t'], string> = {
  metric: '数値',
  narrative: '引用',
  cite: '出典',
};

export const TOKEN_RE = /⟦(数値|引用|出典)(\d+)⟧/g;

export function tokenFor(kind: RefInline['t'], n: number): string {
  return `⟦${KIND_LABEL[kind]}${n}⟧`;
}

function nextNumber(refs: Record<string, RefInline>, kind: RefInline['t']): number {
  let max = 0;
  for (const token of Object.keys(refs)) {
    for (const match of token.matchAll(TOKEN_RE)) {
      if (match[1] === KIND_LABEL[kind]) max = Math.max(max, Number(match[2]));
    }
  }
  return max + 1;
}

/** 本文 AST → 編集用のテキスト（参照は記号） */
export function editableFromBody(body: BlockBody): EditableBody {
  const refs: Record<string, RefInline> = {};
  const counters: Record<RefInline['t'], number> = { metric: 0, narrative: 0, cite: 0 };
  const paragraphs = body.paragraphs.map((p) => {
    const text = p.children
      .map((child) => {
        if (child.t === 'text') return child.text;
        counters[child.t] += 1;
        const token = tokenFor(child.t, counters[child.t]);
        refs[token] = child;
        return token;
      })
      .join('');
    const paragraph: EditableParagraph = { id: p.id, kind: p.kind, text };
    if (p.aiRunId) paragraph.aiRunId = p.aiRunId;
    return paragraph;
  });
  return { paragraphs, refs };
}

/** 1 段落のテキスト → 本文 AST の子要素（記号は登録済みのものだけ参照に戻す） */
export function childrenFromText(text: string, refs: Record<string, RefInline>): BlockInline[] {
  const children: BlockInline[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const last = children[children.length - 1];
    if (last && last.t === 'text') last.text += value;
    else children.push({ t: 'text', text: value });
  };
  let cursor = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    const at = match.index ?? 0;
    pushText(text.slice(cursor, at));
    const ref = refs[match[0]];
    if (ref) children.push({ ...ref });
    else pushText(match[0]);
    cursor = at + match[0].length;
  }
  pushText(text.slice(cursor));
  return children;
}

export function paragraphFromEditable(
  p: EditableParagraph,
  refs: Record<string, RefInline>,
): BlockParagraph {
  const paragraph: BlockParagraph = {
    id: p.id,
    kind: p.kind,
    children: childrenFromText(p.text, refs),
  };
  if (p.aiRunId) paragraph.aiRunId = p.aiRunId;
  return paragraph;
}

/** 編集用のテキスト → 本文 AST（保存・自動保存に送る形） */
export function bodyFromEditable(editable: EditableBody): BlockBody {
  return { paragraphs: editable.paragraphs.map((p) => paragraphFromEditable(p, editable.refs)) };
}

/** 段落の中にある参照（記号の出現順） */
export function refsInParagraph(
  p: EditableParagraph,
  refs: Record<string, RefInline>,
): Array<{ token: string; ref: RefInline }> {
  const found: Array<{ token: string; ref: RefInline }> = [];
  for (const match of p.text.matchAll(TOKEN_RE)) {
    const ref = refs[match[0]];
    if (ref) found.push({ token: match[0], ref });
  }
  return found;
}

/**
 * 参照を段落の caret の位置へ差し込む。新しい記号を登録し、差し込んだ後の caret を返す。
 * caret が範囲外なら段落の末尾へ足す。
 */
export function insertRef(
  editable: EditableBody,
  paragraphId: string,
  ref: RefInline,
  caret: number | null,
): { body: EditableBody; caret: number; token: string } | null {
  const index = editable.paragraphs.findIndex((p) => p.id === paragraphId);
  const target = editable.paragraphs[index];
  if (!target) return null;
  const token = tokenFor(ref.t, nextNumber(editable.refs, ref.t));
  const at = caret === null || caret < 0 || caret > target.text.length ? target.text.length : caret;
  const text = `${target.text.slice(0, at)}${token}${target.text.slice(at)}`;
  const paragraphs = [...editable.paragraphs];
  paragraphs[index] = { ...target, text };
  return {
    body: { paragraphs, refs: { ...editable.refs, [token]: ref } },
    caret: at + token.length,
    token,
  };
}

/**
 * 段落の表示名（本文の中の位置で「段落 3」「見出し 1（段落 1）」と呼ぶ）。
 * 段落 ID（p-mg3k1x2a のような内部の識別子）は画面・読み上げに出さない（§4.2）。
 * 本文に無い段落（削除した段落・別の版の段落）は、位置が無いことをそのまま示す
 */
export function paragraphLabelOf(
  paragraphs: ReadonlyArray<{ id: string; kind: 'paragraph' | 'heading' }>,
  id: string | null | undefined,
): string {
  if (!id) return '段落（指定なし）';
  const index = paragraphs.findIndex((p) => p.id === id);
  if (index === -1) return '（この版に無い段落）';
  const kind = paragraphs[index]?.kind;
  return kind === 'heading' ? `見出し（段落 ${index + 1}）` : `段落 ${index + 1}`;
}

/** 本文内で一意の新しい段落 ID */
export function newParagraphId(existing: readonly string[], seed: string): string {
  const used = new Set(existing);
  let n = 1;
  let id = `p-${seed}`;
  while (used.has(id)) {
    n += 1;
    id = `p-${seed}-${n}`;
  }
  return id;
}

/** 表示用: 記号を参照の表示文字列（数値・引用文）に置き換えたテキスト */
export function displayText(p: EditableParagraph, refs: Record<string, RefInline>): string {
  return p.text.replace(TOKEN_RE, (token) => {
    const ref = refs[token];
    if (!ref) return token;
    if (ref.t === 'metric') return ref.display;
    if (ref.t === 'narrative') return ref.quote;
    return '';
  });
}
