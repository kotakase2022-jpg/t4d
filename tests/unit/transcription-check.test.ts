import { describe, expect, it } from 'vitest';
import {
  DUPLICATE_SENTENCE_MIN_CHARS,
  checkTranscription,
  type TranscriptionBlockInput,
} from '@/lib/domain/transcription';
import type { BlockBody, BlockInline } from '@/types/domain';

/**
 * 転記・二重確認の点検（トライアル対応 NF-18。unit:transcription-check）。
 * 分母付きの件数だけを返し、総合点を作らない。翻訳版・見出し・版の無い節は数えない。
 */

const text = (t: string): BlockInline => ({ t: 'text', text: t });
const metric = (id: string): BlockInline => ({
  t: 'metric',
  dataPointId: `dp-${id}`,
  dataPointVersionId: `dpv-${id}`,
  display: '1,000 t-CO2e',
});
const narrative = (versionId: string): BlockInline => ({
  t: 'narrative',
  narrativeVersionId: versionId,
  quote: '取締役会はサステナビリティに関するリスク及び機会を監督している。',
});

function body(...paragraphs: Array<{ kind?: 'paragraph' | 'heading'; children: BlockInline[] }>) {
  return {
    paragraphs: paragraphs.map((p, i) => ({
      id: `p${i + 1}`,
      kind: p.kind ?? 'paragraph',
      children: p.children,
    })),
  } satisfies BlockBody;
}

function block(
  id: string,
  b: BlockBody | null,
  options: { framework?: string; translation?: boolean } = {},
): TranscriptionBlockInput {
  return {
    blockId: id,
    title: `節 ${id}`,
    frameworkVersionId: options.framework ?? 'fv-ssbj',
    body: b,
    translation: options.translation ?? false,
  };
}

const SHARED_SENTENCE = '当社は気候関連のリスク及び機会を年に二回、経営会議で審議しています。';

describe('転記・二重確認の点検', () => {
  it('参照でない手書き数値と、参照で埋め込んだ数値を分けて数える', () => {
    const result = checkTranscription(
      [
        block(
          'a',
          body(
            { children: [text('Scope1 排出量は 1,234 t-CO2e でした。'), metric('1')] },
            { children: [metric('2'), text('（前年比 3 % 減）')] },
          ),
        ),
      ],
      [],
    );
    expect(result.handwritten.map((h) => h.text)).toEqual(['1,234 t-CO2e', '3 %']);
    expect(result.handwritten.every((h) => h.blockId === 'a')).toBe(true);
    expect(result.referencedNumbers).toBe(2);
    expect(result.blocksCounted).toBe(1);
    expect(result.paragraphsCounted).toBe(2);
  });

  it('見出し・翻訳版・版の無い節は数えない（分母にも入れない）', () => {
    const result = checkTranscription(
      [
        block('a', body({ kind: 'heading', children: [text('第 1 章 100 t-CO2e')] })),
        block('b', body({ children: [text('翻訳の 500 t-CO2e')] }), { translation: true }),
        block('c', null),
      ],
      [],
    );
    expect(result.handwritten).toEqual([]);
    expect(result.blocksCounted).toBe(1);
    expect(result.paragraphsCounted).toBe(0);
  });

  it('同じ定性情報の版を 2 節以上で引用したら再利用として数え、基準をまたぐかを示す', () => {
    const result = checkTranscription(
      [
        block('ssbj', body({ children: [narrative('nv-gov')] }), { framework: 'fv-ssbj' }),
        block('esrs', body({ children: [narrative('nv-gov'), narrative('nv-other')] }), {
          framework: 'fv-40a',
        }),
      ],
      [
        { versionId: 'nv-gov', title: 'ガバナンス' },
        { versionId: 'nv-other', title: 'その他' },
      ],
    );
    expect(result.narrativesCited).toBe(2);
    expect(result.reusedNarratives).toHaveLength(1);
    expect(result.reusedNarratives[0]).toMatchObject({
      versionId: 'nv-gov',
      title: 'ガバナンス',
      frameworkCount: 2,
    });
    expect(result.reusedNarratives[0]!.blocks.map((b) => b.blockId).sort()).toEqual([
      'esrs',
      'ssbj',
    ]);
  });

  it('定性情報を経由せず同じ文を 2 節に書いたら二重管理として拾う（空白の違いは同じ文）', () => {
    const result = checkTranscription(
      [
        block('a', body({ children: [text(`${SHARED_SENTENCE}以下に示します。`)] })),
        block('b', body({ children: [text(SHARED_SENTENCE.replace('、', '、 '))] })),
      ],
      [],
    );
    expect(result.duplicateSentences).toHaveLength(1);
    expect(result.duplicateSentences[0]!.blocks.map((b) => b.blockId).sort()).toEqual(['a', 'b']);
  });

  it('引用した定性情報の本文や短い定型文は、重複として数えない', () => {
    const short = '以下のとおりです。';
    expect(short.length).toBeLessThan(DUPLICATE_SENTENCE_MIN_CHARS);
    const result = checkTranscription(
      [
        block('a', body({ children: [text(short), narrative('nv-gov')] })),
        block('b', body({ children: [text(short), narrative('nv-gov')] })),
      ],
      [{ versionId: 'nv-gov', title: 'ガバナンス' }],
    );
    expect(result.duplicateSentences).toEqual([]);
    // 引用は再利用として数える（二重管理ではない）
    expect(result.reusedNarratives).toHaveLength(1);
  });

  it('同じ節の中で繰り返した文は、節をまたいだ重複にしない', () => {
    const result = checkTranscription(
      [
        block(
          'a',
          body({ children: [text(SHARED_SENTENCE)] }, { children: [text(SHARED_SENTENCE)] }),
        ),
      ],
      [],
    );
    expect(result.duplicateSentences).toEqual([]);
  });
});
