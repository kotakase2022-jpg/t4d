import { describe, expect, it } from 'vitest';
import {
  FLOW_MAX_THICKNESS,
  FLOW_MIN_THICKNESS,
  FLOW_UNQUANTIFIED_THICKNESS,
  fitText,
  flowThickness,
  layoutPathwayFlow,
  type FlowLayoutInput,
  type FlowRowInput,
} from '@/lib/charts/flow-layout';
import { estimateTextWidth } from '@/lib/charts/scale';

/**
 * 財務影響分析の経路図のレイアウト（docs/disclosure-first.md §10.3）。
 * 4 列（起点 → 仕組み → 財務項目 → 時間帯）、帯の太さ ∝ |参照年の影響|、未定量は細い破線。
 */

function row(id: string, overrides: Partial<FlowRowInput> = {}): FlowRowInput {
  return {
    id,
    origin: { label: `${id} の起点`, sub: 't-CO2e' },
    mechanism: { label: `${id} の仕組み`, sub: null },
    lineKey: 'cogs',
    bandKey: 'medium',
    magnitude: 100,
    text: '開始 FY2028・減益',
    ...overrides,
  };
}

function input(rows: FlowRowInput[], overrides: Partial<FlowLayoutInput> = {}): FlowLayoutInput {
  return {
    rows,
    lines: [
      { key: 'revenue', label: '売上高' },
      { key: 'cogs', label: '売上原価' },
      { key: 'sga', label: '販管費' },
      { key: 'extraordinary_loss', label: '特別損失' },
    ],
    bands: [
      { key: 'short', label: '短期', sub: '報告期間' },
      { key: 'medium', label: '中期', sub: '〜5 年' },
      { key: 'long', label: '長期', sub: '5 年超' },
    ],
    columnTitles: ['起点（指標・定性・IRO）', '仕組み', '財務項目', '時間帯'],
    ...overrides,
  };
}

describe('帯の太さ', () => {
  it('|影響| に比例（最大で FLOW_MAX_THICKNESS、0 は最小の太さ）。未定量は細い破線用の太さ', () => {
    expect(flowThickness(100, 100)).toBe(FLOW_MAX_THICKNESS);
    expect(flowThickness(0, 100)).toBe(FLOW_MIN_THICKNESS);
    const half = flowThickness(50, 100);
    expect(half).toBeCloseTo((FLOW_MIN_THICKNESS + FLOW_MAX_THICKNESS) / 2, 6);
    // 全部 0 なら最小（0 で割らない）
    expect(flowThickness(0, 0)).toBe(FLOW_MIN_THICKNESS);
    expect(flowThickness(null, 100)).toBe(FLOW_UNQUANTIFIED_THICKNESS);
    expect(FLOW_UNQUANTIFIED_THICKNESS).toBeLessThan(FLOW_MIN_THICKNESS);
  });
});

describe('列と節点', () => {
  const layout = layoutPathwayFlow(
    input([
      row('P1', { magnitude: 17_863_200, bandKey: 'medium' }),
      row('P2', { magnitude: 0, bandKey: 'long', text: '開始 FY2034・減益' }),
      row('P6', { magnitude: 22_742_196, lineKey: 'sga' }),
      row('P7', { magnitude: null, bandKey: 'short', text: '未定量（入力待ち）' }),
    ]),
  );

  it('4 列は左から右へ並び、題を持つ', () => {
    expect(layout.columns.map((c) => c.title)).toEqual([
      '起点（指標・定性・IRO）',
      '仕組み',
      '財務項目',
      '時間帯',
    ]);
    for (let i = 1; i < layout.columns.length; i += 1) {
      const prev = layout.columns[i - 1]!;
      expect(layout.columns[i]!.x).toBeGreaterThan(prev.x + prev.width);
    }
  });

  it('起点・仕組みは経路ごと、財務項目・時間帯は使われるものだけ（同じキーは 1 つにまとめる）', () => {
    const keysOf = (column: number) =>
      layout.nodes.filter((n) => n.column === column).map((n) => n.key);
    expect(keysOf(0)).toEqual(['origin:P1', 'origin:P2', 'origin:P6', 'origin:P7']);
    expect(keysOf(1)).toEqual(['mechanism:P1', 'mechanism:P2', 'mechanism:P6', 'mechanism:P7']);
    // 売上高・特別損失は使われないので出さない
    expect(keysOf(2)).toEqual(['line:cogs', 'line:sga']);
    expect(keysOf(3)).toEqual(['band:short', 'band:medium', 'band:long']);
    const cogs = layout.nodes.find((n) => n.key === 'line:cogs')!;
    expect(cogs.rowIds).toEqual(['P1', 'P2', 'P7']);
  });

  it('同じ列の節点は重ならず、図の中に収まる', () => {
    for (const column of [0, 1, 2, 3]) {
      const nodes = layout.nodes.filter((n) => n.column === column).sort((a, b) => a.y - b.y);
      for (let i = 1; i < nodes.length; i += 1) {
        expect(nodes[i]!.y).toBeGreaterThanOrEqual(nodes[i - 1]!.y + nodes[i - 1]!.height);
      }
      for (const node of nodes) {
        expect(node.x).toBeGreaterThanOrEqual(0);
        expect(node.x + node.width).toBeLessThanOrEqual(layout.width);
        expect(node.y).toBeGreaterThanOrEqual(0);
        expect(node.y + node.height).toBeLessThanOrEqual(layout.height);
      }
    }
  });

  it('まとめた節点の高さは、入ってくる帯の太さの合計以上', () => {
    const cogs = layout.nodes.find((n) => n.key === 'line:cogs')!;
    const thicknesses = layout.links
      .filter((l) => l.column === 1 && cogs.rowIds.includes(l.rowId))
      .map((l) => l.thickness);
    expect(cogs.height).toBeGreaterThanOrEqual(thicknesses.reduce((a, b) => a + b, 0));
  });

  it('経路ごとに 3 本の帯（起点→仕組み→財務項目→時間帯）。太さは最大の経路で最大', () => {
    for (const id of ['P1', 'P2', 'P6', 'P7']) {
      expect(layout.links.filter((l) => l.rowId === id).map((l) => l.column)).toEqual([0, 1, 2]);
    }
    const thickness = (id: string) => layout.links.find((l) => l.rowId === id)!.thickness;
    expect(thickness('P6')).toBe(FLOW_MAX_THICKNESS);
    expect(thickness('P1')).toBeLessThan(thickness('P6'));
    expect(thickness('P2')).toBe(FLOW_MIN_THICKNESS);
  });

  it('未定量の経路は細い破線、定量化できた経路は塗りの帯', () => {
    const p7 = layout.links.filter((l) => l.rowId === 'P7');
    expect(p7.every((l) => l.dashed && l.thickness === FLOW_UNQUANTIFIED_THICKNESS)).toBe(true);
    const p2 = layout.links.filter((l) => l.rowId === 'P2');
    expect(p2.every((l) => !l.dashed)).toBe(true);
    // 帯の形は SVG の path（M で始まる）
    for (const link of layout.links) expect(link.d.startsWith('M')).toBe(true);
  });

  it('帯の文字（「開始 FY2028・減益」「未定量」）は経路ごとに 1 つ', () => {
    expect(layout.labels.map((l) => [l.rowId, l.text])).toEqual([
      ['P1', '開始 FY2028・減益'],
      ['P2', '開始 FY2034・減益'],
      ['P6', '開始 FY2028・減益'],
      ['P7', '未定量（入力待ち）'],
    ]);
  });
});

describe('付け足しの節点（資本コスト）', () => {
  it('帯の無い破線の節点として財務項目の列の最後に置く', () => {
    const layout = layoutPathwayFlow(
      input([row('P1')], {
        extraLineNodes: [
          {
            key: 'cost_of_capital',
            label: '資本コスト',
            sub: '未定量（根拠データなし）',
            dashed: true,
          },
        ],
      }),
    );
    const extra = layout.nodes.find((n) => n.key === 'line:cost_of_capital')!;
    expect(extra.column).toBe(2);
    expect(extra.dashed).toBe(true);
    expect(extra.rowIds).toEqual([]);
    expect(layout.links.some((l) => l.rowId === 'cost_of_capital')).toBe(false);
    const cogs = layout.nodes.find((n) => n.key === 'line:cogs')!;
    expect(extra.y).toBeGreaterThanOrEqual(cogs.y + cogs.height);
  });

  it('経路が 0 件でも描ける（高さが正）', () => {
    const layout = layoutPathwayFlow(input([]));
    expect(layout.nodes).toEqual([]);
    expect(layout.height).toBeGreaterThan(0);
  });
});

describe('文字の切り詰め', () => {
  it('幅に収まらない文字は末尾を「…」にする（収まる文字はそのまま）', () => {
    expect(fitText('売上原価', 200, 11)).toBe('売上原価');
    const long = '発電事業者の負担金の電気料金転嫁（長い説明つき）';
    const fitted = fitText(long, 120, 11);
    expect(fitted.endsWith('…')).toBe(true);
    expect(estimateTextWidth(fitted, 11)).toBeLessThanOrEqual(120);
  });
});

describe('3 行目（関連する定性情報・IRO）と文字の収まり', () => {
  it('note のある節点は 3 行分の高さ（48）にする。無い節点は 36 のまま', () => {
    const layout = layoutPathwayFlow(
      input([
        row('P1', { origin: { label: 'Scope1', sub: '8,931.6 t-CO2e', note: 'IRO E1・定性 1' } }),
        row('P3', { magnitude: 0 }),
      ]),
    );
    const p1 = layout.nodes.find((n) => n.key === 'origin:P1')!;
    const p3 = layout.nodes.find((n) => n.key === 'origin:P3')!;
    expect(p1.note).toBe('IRO E1・定性 1');
    expect(p1.height).toBe(48);
    expect(layout.nodes.find((n) => n.key === 'mechanism:P1')!.height).toBe(48);
    expect(p3.note).toBeNull();
    expect(p3.height).toBe(36);
    expect(p3.y).toBeGreaterThanOrEqual(p1.y + p1.height);
  });

  it('既定の幅で、最も長い仕組み・帯の文字は切らずに収まる', () => {
    const layout = layoutPathwayFlow(
      input([
        row('P2', {
          mechanism: { label: '発電事業者の負担金の電気料金転嫁', sub: 'P2・時間差 1 年' },
          text: '開始 FY2034・減益',
        }),
        row('P3', { magnitude: 0, text: '開始 FY2026・変化なし' }),
        row('P6', { magnitude: null, text: '未算定（確定値なし）' }),
      ]),
    );
    const mechanism = layout.nodes.find((n) => n.key === 'mechanism:P2')!;
    expect(estimateTextWidth(mechanism.label, 11)).toBeLessThanOrEqual(mechanism.width - 12);
    expect(layout.labels.map((l) => l.text)).toEqual([
      '開始 FY2034・減益',
      '開始 FY2026・変化なし',
      '未算定（確定値なし）',
    ]);
    // 帯の文字は次の列（財務項目）に重ならない
    const lineX = layout.columns[2]!.x;
    for (const label of layout.labels) {
      expect(label.x + estimateTextWidth(label.text, 11)).toBeLessThanOrEqual(lineX);
    }
  });
});

describe('財務項目・時間帯の並び', () => {
  it('財務項目は通る経路の高さの順（下の経路だけの売上高が他を押し下げない）。時間帯は短期→中期→長期', () => {
    const layout = layoutPathwayFlow(
      input([
        row('P1', { bandKey: 'medium' }),
        row('P2', { bandKey: 'long' }),
        row('P3', { bandKey: 'short' }),
        row('P6', { lineKey: 'sga', bandKey: 'medium' }),
        row('P9', { lineKey: 'revenue', bandKey: 'short', magnitude: null }),
      ]),
    );
    const keysOf = (column: number) =>
      layout.nodes
        .filter((n) => n.column === column)
        .sort((a, b) => a.y - b.y)
        .map((n) => n.key);
    expect(keysOf(2)).toEqual(['line:cogs', 'line:sga', 'line:revenue']);
    expect(keysOf(3)).toEqual(['band:short', 'band:medium', 'band:long']);
    // 売上原価は最初の経路の高さの近くに置く（図の下へ押し出さない）
    const cogs = layout.nodes.find((n) => n.key === 'line:cogs')!;
    const p3 = layout.nodes.find((n) => n.key === 'origin:P3')!;
    expect(cogs.y).toBeLessThanOrEqual(p3.y + p3.height);
  });
});
