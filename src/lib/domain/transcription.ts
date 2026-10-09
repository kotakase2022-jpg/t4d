import { detectHandwrittenNumbers } from '@/lib/domain/disclosure-block';
import type { BlockBody, BlockParagraph, Uuid } from '@/types/domain';

/**
 * 転記・二重確認の点検（トライアル対応 NF-18。スライド 3「転記と二重確認の発生箇所を検証」）。
 *
 * プロジェクトの原稿（現在の版）を数えるだけの純関数。保存しない・総合点を作らない（分母付きの件数だけ）。
 *  - 参照でない手書き数値（数値＋単位の文字列。detectHandwrittenNumbers と同じ規則）= 転記の発生箇所
 *  - 参照で埋め込んだ数値（版を参照する数値。転記していない）
 *  - 複数の節で再利用した定性情報（1 回の確定を n 節で再利用。二重確認をしていない）
 *  - 定性情報を経由せず、同じ文が複数の節に書かれている箇所（＝二重管理。どちらかを直し忘れうる）
 *
 * 翻訳版の節は数えない（同じ内容を別の言語で持つのは転記ではないため。原文の節だけを数える）。
 * 見出しの段落も数えない（本文ではないため）。
 */

export interface TranscriptionBlockInput {
  blockId: Uuid;
  title: string;
  /** 節の基準の版（再利用が基準をまたぐかの判定に使う） */
  frameworkVersionId: Uuid;
  /** 現在の版の本文（版が無ければ null。数えない） */
  body: BlockBody | null;
  translation: boolean;
}

export interface TranscriptionNarrativeInput {
  versionId: Uuid;
  title: string;
}

export interface HandwrittenItem {
  blockId: Uuid;
  blockTitle: string;
  paragraphId: string;
  /** 本文に書かれたままの数値（例: 1,234 t-CO2e） */
  text: string;
}

export interface ReusedNarrative {
  versionId: Uuid;
  title: string;
  /** 引用している節（原文の節だけ） */
  blocks: Array<{ blockId: Uuid; title: string }>;
  /** 節の基準の版の数（2 以上なら基準をまたいで再利用） */
  frameworkCount: number;
}

export interface DuplicateSentence {
  /** 重複した文（比べるときは空白を除く） */
  text: string;
  blocks: Array<{ blockId: Uuid; title: string }>;
}

export interface TranscriptionCheck {
  /** 数えた節（翻訳版・版の無い節を除く） */
  blocksCounted: number;
  /** 数えた本文の段落（見出しを除く） */
  paragraphsCounted: number;
  /** 参照でない手書き数値 */
  handwritten: HandwrittenItem[];
  /** 参照で埋め込んだ数値の件数（同じ版を 2 回引用すれば 2 件） */
  referencedNumbers: number;
  /** 複数の節で再利用した定性情報（2 節以上） */
  reusedNarratives: ReusedNarrative[];
  /** 引用した定性情報の版の数（分母） */
  narrativesCited: number;
  /** 定性情報を経由せず、同じ文が 2 つ以上の節にある箇所 */
  duplicateSentences: DuplicateSentence[];
}

/** 重複を数える文の最短の長さ（「以下のとおりです。」のような定型の短文を拾わない） */
export const DUPLICATE_SENTENCE_MIN_CHARS = 20;

/** 文を比べるための正規化（空白を除く。JS の \s は全角の空白も含む。全角・半角の違いは見ない） */
function normalizeSentence(text: string): string {
  return text.replace(/\s+/g, '');
}

/** 段落の、利用者が直接書いた文字（定性情報の引用・数値参照・出典印を除く）を文に分ける */
function ownSentences(paragraph: BlockParagraph): string[] {
  // 引用・参照の位置で文を切る（引用した本文と地の文をつなげて 1 文にしない）
  const chunks: string[] = [];
  let current = '';
  for (const inline of paragraph.children) {
    if (inline.t === 'text') {
      current += inline.text;
    } else {
      chunks.push(current);
      current = '';
    }
  }
  chunks.push(current);
  return chunks
    .flatMap((chunk) => chunk.split(/(?<=[。．！？!?])/))
    .map((s) => s.trim())
    .filter((s) => normalizeSentence(s).length >= DUPLICATE_SENTENCE_MIN_CHARS);
}

export function checkTranscription(
  blocks: readonly TranscriptionBlockInput[],
  narratives: readonly TranscriptionNarrativeInput[],
): TranscriptionCheck {
  const counted = blocks.filter((b) => !b.translation && b.body !== null);
  const handwritten: HandwrittenItem[] = [];
  let referencedNumbers = 0;
  let paragraphsCounted = 0;
  const narrativeUse = new Map<Uuid, Map<Uuid, TranscriptionBlockInput>>();
  const sentenceUse = new Map<string, { text: string; blocks: Map<Uuid, string> }>();

  for (const block of counted) {
    const body = block.body!;
    const paragraphs = body.paragraphs.filter((p) => p.kind === 'paragraph');
    paragraphsCounted += paragraphs.length;
    for (const found of detectHandwrittenNumbers({ paragraphs })) {
      handwritten.push({
        blockId: block.blockId,
        blockTitle: block.title,
        paragraphId: found.paragraphId,
        text: found.text,
      });
    }
    for (const paragraph of paragraphs) {
      for (const inline of paragraph.children) {
        if (inline.t === 'metric') referencedNumbers += 1;
        if (inline.t === 'narrative') {
          const users = narrativeUse.get(inline.narrativeVersionId) ?? new Map();
          users.set(block.blockId, block);
          narrativeUse.set(inline.narrativeVersionId, users);
        }
      }
      for (const sentence of ownSentences(paragraph)) {
        const key = normalizeSentence(sentence);
        const entry = sentenceUse.get(key) ?? { text: sentence, blocks: new Map<Uuid, string>() };
        entry.blocks.set(block.blockId, block.title);
        sentenceUse.set(key, entry);
      }
    }
  }

  const titleOf = new Map(narratives.map((n) => [n.versionId, n.title]));
  const reusedNarratives: ReusedNarrative[] = [...narrativeUse.entries()]
    .filter(([, users]) => users.size >= 2)
    .map(([versionId, users]) => ({
      versionId,
      title: titleOf.get(versionId) ?? '（定性情報）',
      blocks: [...users.values()].map((b) => ({ blockId: b.blockId, title: b.title })),
      frameworkCount: new Set([...users.values()].map((b) => b.frameworkVersionId)).size,
    }))
    .sort((a, b) => b.blocks.length - a.blocks.length || a.title.localeCompare(b.title, 'ja'));

  const duplicateSentences: DuplicateSentence[] = [...sentenceUse.values()]
    .filter((entry) => entry.blocks.size >= 2)
    .map((entry) => ({
      text: entry.text,
      blocks: [...entry.blocks.entries()].map(([blockId, title]) => ({ blockId, title })),
    }))
    .sort((a, b) => b.blocks.length - a.blocks.length || a.text.localeCompare(b.text, 'ja'));

  return {
    blocksCounted: counted.length,
    paragraphsCounted,
    handwritten,
    referencedNumbers,
    reusedNarratives,
    narrativesCited: narrativeUse.size,
    duplicateSentences,
  };
}
