import { describe, expect, it } from 'vitest';
import {
  bodyFromEditable,
  displayText,
  editableFromBody,
  insertRef,
  newParagraphId,
  refsInParagraph,
} from '@/app/enterprise/disclosure-projects/[projectId]/blocks/[blockId]/editor-model';
import { changedSinceRun, paragraphHashes } from '@/lib/ai/draft-conflict';
import { extractClaims, overlapScore, polishText } from '@/lib/ai/mock-disclosure-draft';
import type { BlockBody } from '@/types/domain';

/**
 * 原稿編集の段落モデル（参照を記号にしたテキスト ⇔ 本文 AST）と、
 * AI 下書きの競合判定・Mock の抽出規則の単体テスト。
 */

const body: BlockBody = {
  paragraphs: [
    { id: 'h', kind: 'heading', children: [{ t: 'text', text: '指標及び目標' }] },
    {
      id: 'p1',
      kind: 'paragraph',
      children: [
        { t: 'text', text: 'Scope1 は ' },
        { t: 'metric', dataPointId: 'dp', dataPointVersionId: 'v1', display: '1,190.9 t-CO2e' },
        { t: 'text', text: ' です。' },
        { t: 'cite', sourceAnchorId: 'a1' },
      ],
    },
    {
      id: 'p2',
      kind: 'paragraph',
      aiRunId: 'run-1',
      children: [{ t: 'narrative', narrativeVersionId: 'n1', quote: '取締役会が監督する。' }],
    },
  ],
};

describe('参照の記号化', () => {
  it('本文 AST と編集用テキストを往復しても同じ本文に戻る', () => {
    const editable = editableFromBody(body);
    expect(editable.paragraphs[1]?.text).toBe('Scope1 は ⟦数値1⟧ です。⟦出典1⟧');
    expect(editable.paragraphs[2]?.text).toBe('⟦引用1⟧');
    expect(bodyFromEditable(editable)).toEqual(body);
  });

  it('記号を消すと参照も外れ、手で打った記号はただの文字になる', () => {
    const editable = editableFromBody(body);
    const edited = {
      ...editable,
      paragraphs: editable.paragraphs.map((p) =>
        p.id === 'p1' ? { ...p, text: 'Scope1 は ⟦数値9⟧ です。' } : p,
      ),
    };
    const p1 = bodyFromEditable(edited).paragraphs[1];
    expect(p1?.children).toEqual([{ t: 'text', text: 'Scope1 は ⟦数値9⟧ です。' }]);
  });

  it('記号を別の段落へ移しても同じ参照（版）を保つ', () => {
    const editable = editableFromBody(body);
    const moved = {
      ...editable,
      paragraphs: editable.paragraphs.map((p) =>
        p.id === 'p2'
          ? { ...p, text: `${p.text}（⟦数値1⟧）` }
          : p.id === 'p1'
            ? { ...p, text: 'Scope1。' }
            : p,
      ),
    };
    const p2 = bodyFromEditable(moved).paragraphs[2];
    expect(p2?.children.some((c) => c.t === 'metric' && c.dataPointVersionId === 'v1')).toBe(true);
    expect(p2?.aiRunId).toBe('run-1');
  });

  it('参照を caret の位置へ差し込み、本文全体で一意の番号を振る', () => {
    const editable = editableFromBody(body);
    const result = insertRef(
      editable,
      'p1',
      { t: 'metric', dataPointId: 'dp2', dataPointVersionId: 'v2', display: '10 MWh' },
      'Scope1 は '.length,
    );
    expect(result?.token).toBe('⟦数値2⟧');
    expect(result?.body.paragraphs[1]?.text.startsWith('Scope1 は ⟦数値2⟧⟦数値1⟧')).toBe(true);
    expect(result?.caret).toBe('Scope1 は ⟦数値2⟧'.length);
    const refs = refsInParagraph(result!.body.paragraphs[1]!, result!.body.refs);
    expect(refs.map((r) => r.token)).toEqual(['⟦数値2⟧', '⟦数値1⟧', '⟦出典1⟧']);
    expect(displayText(result!.body.paragraphs[1]!, result!.body.refs)).toBe(
      'Scope1 は 10 MWh1,190.9 t-CO2e です。',
    );
  });

  it('新しい段落 ID は既存と重ならない', () => {
    expect(newParagraphId(['p-x', 'p-x-2'], 'x')).toBe('p-x-3');
  });
});

describe('AI 下書きの競合判定（A18）', () => {
  it('同じ実行の候補を採用した変化は数えず、利用者の編集・削除・追加は数える', () => {
    const base = paragraphHashes(body);
    expect(changedSinceRun(base, body, 'run-x')).toBe(false);

    const adopted: BlockBody = {
      paragraphs: [
        ...body.paragraphs,
        {
          id: 'ai-1',
          kind: 'paragraph',
          aiRunId: 'run-x',
          children: [{ t: 'text', text: '候補' }],
        },
      ],
    };
    expect(changedSinceRun(base, adopted, 'run-x')).toBe(false);

    const edited: BlockBody = {
      paragraphs: body.paragraphs.map((p) =>
        p.id === 'h' ? { ...p, children: [{ t: 'text', text: '指標' }] } : p,
      ),
    };
    expect(changedSinceRun(base, edited, 'run-x')).toBe(true);
    expect(changedSinceRun(base, { paragraphs: body.paragraphs.slice(1) }, 'run-x')).toBe(true);
    const added: BlockBody = {
      paragraphs: [...body.paragraphs, { id: 'u', kind: 'paragraph', children: [] }],
    };
    expect(changedSinceRun(base, added, 'run-x')).toBe(true);
  });
});

describe('Mock の抽出規則', () => {
  it('事項・動詞・単位で主張を分け、開催と報告の頻度を混同しない', () => {
    const claims = extractClaims(
      'サステナビリティ委員会は代表取締役社長を委員長とし、年4回開催する。委員会は審議の結果を年2回、取締役会に報告する。',
    );
    expect(claims.map((c) => [c.subject, c.verb, c.unit, c.value])).toEqual([
      ['サステナビリティ委員会', '開催', '年回', 4],
      ['委員会', '報告', '年回', 2],
    ]);
    const prior = extractClaims(
      '代表取締役社長を委員長とするサステナビリティ委員会を年2回開催し、',
    );
    expect(prior[0]?.key).toBe(claims[0]?.key);
  });

  it('前年の段落と当年度の資料の近さを測る', () => {
    expect(
      overlapScore(
        '取締役会は、サステナビリティ推進部から年1回報告を受け、気候関連の課題への対応状況を監督しています。',
        '取締役会は、気候関連の課題を含むサステナビリティ関連のリスク及び機会への対応を監督する。',
      ),
    ).toBeGreaterThan(0.35);
    expect(overlapScore('全く関係のない文。', '取締役会は監督する。')).toBeLessThan(0.35);
  });

  it('文章を整えるのは表記だけで、数値と語を変えない', () => {
    expect(polishText('当社は 、 年4回 開催します 。。')).toBe('当社は、年4回開催します。');
    expect(polishText('Scope1 は 1,190.9 t-CO2e です')).toBe('Scope1 は 1,190.9 t-CO2e です。');
  });
});
