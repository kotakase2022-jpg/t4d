import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  collectRefs,
  contentHashOf,
  detectHandwrittenNumbers,
  diffChars,
  diffParagraphs,
  emptyBody,
  hasBodyContent,
  plainTextOf,
  type BlockBody,
  type DiffSegment,
} from '../../src/lib/domain/disclosure-block';

/**
 * 開示本文 AST（docs/disclosure-first.md §4）の純粋関数。
 * 版の内容ハッシュ・参照の収集・手書き数値・差分を、どこで計算しても同じ結果にするための土台。
 */

const DP = 'dp-00000000-0000-4000-8000-000000000001';
const DPV1 = 'dpv-0000000-0000-4000-8000-000000000001';
const DPV2 = 'dpv-0000000-0000-4000-8000-000000000002';
const NV1 = 'nv-00000000-0000-4000-8000-000000000001';
const SA1 = 'sa-00000000-0000-4000-8000-000000000001';
const SA2 = 'sa-00000000-0000-4000-8000-000000000002';
const RUN = 'run-0000000-0000-4000-8000-000000000001';

function sampleBody(): BlockBody {
  return {
    paragraphs: [
      { id: 'h1', kind: 'heading', children: [{ t: 'text', text: 'ガバナンス' }] },
      {
        id: 'p1',
        kind: 'paragraph',
        children: [
          { t: 'text', text: '当社の Scope1 排出量は ' },
          { t: 'metric', dataPointId: DP, dataPointVersionId: DPV1, display: '12,345 t-CO2e' },
          { t: 'text', text: 'でした。' },
          { t: 'cite', sourceAnchorId: SA1 },
        ],
      },
      {
        id: 'p2',
        kind: 'paragraph',
        aiRunId: RUN,
        children: [
          { t: 'narrative', narrativeVersionId: NV1, quote: '取締役会が気候関連課題を監督する。' },
          { t: 'cite', sourceAnchorId: SA2 },
          { t: 'cite', sourceAnchorId: SA1 },
        ],
      },
    ],
  };
}

/** 差分の区間を連結すると元・先の文字列に戻ることを確かめる */
function rebuild(segments: DiffSegment[]): { before: string; after: string } {
  return {
    before: segments
      .filter((s) => s.op !== 'insert')
      .map((s) => s.text)
      .join(''),
    after: segments
      .filter((s) => s.op !== 'delete')
      .map((s) => s.text)
      .join(''),
  };
}

describe('本文の基本操作', () => {
  it('空の本文は段落を持たず、本文なしと判定される', () => {
    expect(emptyBody()).toEqual({ paragraphs: [] });
    expect(hasBodyContent(emptyBody())).toBe(false);
    expect(hasBodyContent(null)).toBe(false);
  });

  it('見出しだけ・空白だけ・出典印だけの本文は「本文なし」', () => {
    expect(
      hasBodyContent({
        paragraphs: [
          { id: 'h', kind: 'heading', children: [{ t: 'text', text: '指標及び目標' }] },
          { id: 'p', kind: 'paragraph', children: [{ t: 'text', text: '  　' }] },
          { id: 'q', kind: 'paragraph', children: [{ t: 'cite', sourceAnchorId: SA1 }] },
        ],
      }),
    ).toBe(false);
    expect(hasBodyContent(sampleBody())).toBe(true);
  });

  it('プレーンテキストは数値の表示文字列・定性情報の引用文を含め、出典印は含めない', () => {
    expect(plainTextOf(sampleBody())).toBe(
      'ガバナンス\n当社の Scope1 排出量は 12,345 t-CO2eでした。\n取締役会が気候関連課題を監督する。',
    );
  });

  it('参照している版と引用位置を、出現順・重複なしで集める', () => {
    expect(collectRefs(sampleBody())).toEqual({
      metricVersionIds: [DPV1],
      narrativeVersionIds: [NV1],
      anchorIds: [SA1, SA2],
    });
    expect(collectRefs(emptyBody())).toEqual({
      metricVersionIds: [],
      narrativeVersionIds: [],
      anchorIds: [],
    });
  });
});

describe('内容ハッシュ', () => {
  it('キーの並び順が違っても同じ内容なら同じハッシュ', () => {
    const body = sampleBody();
    // 同じ内容をキー順を変えて組み立て直す
    const reordered = JSON.parse(
      JSON.stringify(body, (_key, value: unknown) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return Object.fromEntries(Object.entries(value).reverse());
        }
        return value;
      }),
    ) as BlockBody;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(body));
    expect(contentHashOf(reordered)).toBe(contentHashOf(body));
  });

  it('参照先の版が変わればハッシュも変わる（表示文字列が同じでも）', () => {
    const next = sampleBody();
    const metric = next.paragraphs[1]!.children[1]!;
    if (metric.t !== 'metric') throw new Error('fixture mismatch');
    metric.dataPointVersionId = DPV2;
    expect(plainTextOf(next)).toBe(plainTextOf(sampleBody()));
    expect(contentHashOf(next)).not.toBe(contentHashOf(sampleBody()));
  });

  it('決定論的で 32 文字の 16 進', () => {
    expect(contentHashOf(sampleBody())).toBe(contentHashOf(sampleBody()));
    expect(contentHashOf(sampleBody())).toMatch(/^[0-9a-f]{32}$/);
  });

  it('canonicalJson は undefined のキーを落とし、キーを辞書順に並べる', () => {
    expect(canonicalJson({ b: 1, a: [1, { d: undefined, c: 'x' }], e: null })).toBe(
      '{"a":[1,{"c":"x"}],"b":1,"e":null}',
    );
  });
});

describe('手書き数値の検出', () => {
  function textBody(...texts: string[]): BlockBody {
    return {
      paragraphs: texts.map((text, i) => ({
        id: `p${i + 1}`,
        kind: 'paragraph' as const,
        children: [{ t: 'text' as const, text }],
      })),
    };
  }

  it('数値＋単位を拾い、単位を正規化する', () => {
    const found = detectHandwrittenNumbers(
      textBody(
        '2025 年度の Scope1 は 1,234.5 t-CO2e、Scope2 は 890tCO₂e でした。',
        '女性管理職比率は 12.5％、労働災害は 3件、従業員は 1,024 名です。',
        '電力使用量 45,000 kWh、投資額 1,200 百万円、手当 35,000円。',
      ),
    );
    expect(
      found.map(({ paragraphId, text, value, unit }) => [paragraphId, text, value, unit]),
    ).toEqual([
      ['p1', '1,234.5 t-CO2e', 1234.5, 't-CO2e'],
      ['p1', '890tCO₂e', 890, 't-CO2e'],
      ['p2', '12.5％', 12.5, '%'],
      ['p2', '3件', 3, '件'],
      ['p2', '1,024 名', 1024, '人'],
      ['p3', '45,000 kWh', 45000, 'kWh'],
      ['p3', '1,200 百万円', 1200, '百万円'],
      ['p3', '35,000円', 35000, '円'],
    ]);
  });

  it('全角数字も読む', () => {
    const [found] = detectHandwrittenNumbers(textBody('削減率は３０％です。'));
    expect(found).toMatchObject({ value: 30, unit: '%' });
  });

  it('単位の無い数値・識別子の一部・年号は拾わない', () => {
    expect(
      detectHandwrittenNumbers(
        textBody(
          '2026 年 3 月 13 日改正の SSBJ 気候-47(3) に対応します。',
          'Scope3 の 15 カテゴリのうち Cat1 を算定。',
          'ISO14001 を取得。',
        ),
      ),
    ).toEqual([]);
  });

  it('参照（metric）の表示文字列は手書き数値として扱わない', () => {
    expect(detectHandwrittenNumbers(sampleBody())).toEqual([]);
  });
});

describe('文字単位の差分（LCS）', () => {
  it('同じ文字列は equal 1 区間', () => {
    expect(diffChars('同じ文章', '同じ文章')).toEqual([{ op: 'equal', text: '同じ文章' }]);
  });

  it('途中の置き換えを削除と挿入で表し、元・先を復元できる', () => {
    const segments = diffChars('排出量は 100 t-CO2e でした', '排出量は 120 t-CO2e でした');
    expect(rebuild(segments)).toEqual({
      before: '排出量は 100 t-CO2e でした',
      after: '排出量は 120 t-CO2e でした',
    });
    expect(segments).toContainEqual({ op: 'delete', text: '0' });
    expect(segments).toContainEqual({ op: 'insert', text: '2' });
  });

  it('空文字との差分は全挿入・全削除', () => {
    expect(diffChars('', '追加')).toEqual([{ op: 'insert', text: '追加' }]);
    expect(diffChars('削除', '')).toEqual([{ op: 'delete', text: '削除' }]);
  });

  it('サロゲートペアを分割しない', () => {
    const segments = diffChars('𠮷野家', '𠮷田家');
    expect(rebuild(segments)).toEqual({ before: '𠮷野家', after: '𠮷田家' });
    for (const s of segments) expect(s.text).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('LCS として最小の編集になる（共通部分を最大限残す）', () => {
    const segments = diffChars('ABCBDAB', 'BDCABA');
    const equalLength = segments
      .filter((s) => s.op === 'equal')
      .reduce((n, s) => n + Array.from(s.text).length, 0);
    expect(equalLength).toBe(4); // LCS("ABCBDAB","BDCABA") = 4
    expect(rebuild(segments)).toEqual({ before: 'ABCBDAB', after: 'BDCABA' });
  });
});

describe('段落単位の差分', () => {
  it('段落 ID で対応付け、追加・削除・変更・変更なしを返す', () => {
    const before: BlockBody = {
      paragraphs: [
        { id: 'a', kind: 'paragraph', children: [{ t: 'text', text: '残る段落' }] },
        { id: 'b', kind: 'paragraph', children: [{ t: 'text', text: '消える段落' }] },
        { id: 'c', kind: 'paragraph', children: [{ t: 'text', text: '直す前' }] },
      ],
    };
    const after: BlockBody = {
      paragraphs: [
        { id: 'a', kind: 'paragraph', children: [{ t: 'text', text: '残る段落' }] },
        { id: 'c', kind: 'paragraph', children: [{ t: 'text', text: '直した後' }] },
        { id: 'd', kind: 'paragraph', children: [{ t: 'text', text: '足した段落' }] },
      ],
    };
    const diff = diffParagraphs(before, after);
    expect(diff.map((d) => [d.kind, d.paragraphId])).toEqual([
      ['unchanged', 'a'],
      // 削除は古い版で直前にあった段落（a）の後ろに置く
      ['removed', 'b'],
      ['changed', 'c'],
      ['added', 'd'],
    ]);
    const changed = diff.find((d) => d.kind === 'changed');
    expect(changed).toMatchObject({ oldText: '直す前', newText: '直した後' });
    if (changed?.kind !== 'changed') throw new Error('changed が無い');
    expect(rebuild(changed.segments)).toEqual({ before: '直す前', after: '直した後' });
  });

  it('先頭の段落が消えたら先頭に置く', () => {
    const before: BlockBody = {
      paragraphs: [
        { id: 'x', kind: 'paragraph', children: [{ t: 'text', text: '先頭' }] },
        { id: 'y', kind: 'paragraph', children: [{ t: 'text', text: '二番目' }] },
      ],
    };
    const after: BlockBody = { paragraphs: [before.paragraphs[1]!] };
    expect(diffParagraphs(before, after).map((d) => [d.kind, d.paragraphId])).toEqual([
      ['removed', 'x'],
      ['unchanged', 'y'],
    ]);
  });

  it('参照先の版だけが変わった段落も「変更」として出す（文字は equal のみ）', () => {
    const next = sampleBody();
    const metric = next.paragraphs[1]!.children[1]!;
    if (metric.t !== 'metric') throw new Error('fixture mismatch');
    metric.dataPointVersionId = DPV2;
    const changed = diffParagraphs(sampleBody(), next).find((d) => d.paragraphId === 'p1');
    expect(changed?.kind).toBe('changed');
    if (changed?.kind !== 'changed') throw new Error('changed が無い');
    expect(changed.segments.every((s) => s.op === 'equal')).toBe(true);
  });

  it('初版（比較対象なし）はすべて追加', () => {
    expect(diffParagraphs(null, sampleBody()).every((d) => d.kind === 'added')).toBe(true);
  });
});
