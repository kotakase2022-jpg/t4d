import { estimateTextWidth } from './scale';

/**
 * 財務影響分析の経路図（docs/disclosure-first.md §10.3）の配置。純関数で、描画
 * （src/app/enterprise/analysis/financial-impact/_components/pathway-flow.tsx）から切り離す。
 *
 * 4 列: 起点（指標・定性・IRO）→ 仕組み → 財務項目 → 時間帯。
 *  - 起点・仕組みは経路ごとに 1 つ。財務項目・時間帯は同じキーの経路を 1 つの節点にまとめる
 *    （使われない財務項目・時間帯は出さない）
 *  - 帯の太さは |参照年の影響| に比例（0 は最小の太さ）。未定量は細い破線（太さで「0」と読ませない）
 *  - 帯に「開始 FY2028・減益」「未定量」などの文字を書く（色だけで意味を伝えない）
 *  - 節点は同じ列で重ならない。まとめた節点の高さは入ってくる帯の太さの合計以上
 *  - 財務項目は通る経路の中心の高さの順に並べる（売上高だけが下の経路に使われるとき、売上高を先頭に
 *    置くと他の財務項目がすべて図の下へ押し出されるため）。時間帯は短期→中期→長期の順を保ち、
 *    財務項目から出る帯の高さに寄せる
 */

export const FLOW_MIN_THICKNESS = 2;
export const FLOW_MAX_THICKNESS = 22;
/** 未定量の帯（破線の中心線）の太さ。最小の帯より細くし、定量化できた 0 と見分ける */
export const FLOW_UNQUANTIFIED_THICKNESS = 1.5;

const DEFAULT_WIDTH = 960;
const MARGIN_X = 8;
/**
 * 列の幅。仕組み（「発電事業者の負担金の電気料金転嫁」16 字）と帯の文字（「開始 FY2026・変化なし」）が
 * 11px で切れずに収まるよう、起点・財務項目・時間帯を詰めて仕組みと列の間を広げている
 */
const COLUMN_WIDTHS = [152, 188, 96, 108] as const;
const TOP = 34;
const NODE_MIN_HEIGHT = 36;
/** 3 行目（note）のある節点の最小の高さ */
const NODE_MIN_HEIGHT_WITH_NOTE = 48;
/** 帯の文字と次の列の間の余白 */
const LABEL_PAD = 4;
const NODE_PAD = 6;
const ROW_GAP = 10;
const GROUP_GAP = 12;
const SLOT_GAP = 2;
const BOTTOM_PAD = 10;
const FONT = 11;

export interface FlowNodeText {
  label: string;
  sub?: string | null;
  /** 3 行目（関連する定性情報・IRO など）。あれば節点を高くする */
  note?: string | null;
}

export interface FlowRowInput {
  id: string;
  origin: FlowNodeText;
  mechanism: FlowNodeText;
  /** 財務項目のキー（lines の key） */
  lineKey: string;
  /** 時間帯のキー（bands の key） */
  bandKey: string;
  /** 帯の太さの元（|参照年の影響|）。null は未定量（細い破線） */
  magnitude: number | null;
  /** 帯に書く文字 */
  text: string;
}

export interface FlowGroupSpec {
  key: string;
  label: string;
  sub?: string | null;
  note?: string | null;
  dashed?: boolean;
}

export interface FlowLayoutInput {
  rows: readonly FlowRowInput[];
  /** 財務項目の並び（使われるものだけ出す） */
  lines: readonly FlowGroupSpec[];
  /** 時間帯の並び（使われるものだけ出す） */
  bands: readonly FlowGroupSpec[];
  /** 帯の無い財務項目の節点（資本コストなど「図にだけ出す」もの）。財務項目の列の最後に置く */
  extraLineNodes?: readonly FlowGroupSpec[];
  columnTitles: readonly [string, string, string, string];
  width?: number;
}

export type FlowColumn = 0 | 1 | 2 | 3;

export interface FlowNode {
  key: string;
  column: FlowColumn;
  label: string;
  sub: string | null;
  note: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  dashed: boolean;
  /** この節点を通る経路（並びは図の上から） */
  rowIds: string[];
}

export interface FlowLink {
  rowId: string;
  /** 0: 起点→仕組み、1: 仕組み→財務項目、2: 財務項目→時間帯 */
  column: 0 | 1 | 2;
  thickness: number;
  dashed: boolean;
  /** 塗りの帯（定量化）か中心線（未定量・破線）の SVG path */
  d: string;
}

export interface FlowLabel {
  rowId: string;
  text: string;
  x: number;
  y: number;
}

export interface FlowLayout {
  width: number;
  height: number;
  columns: Array<{ title: string; x: number; width: number }>;
  nodes: FlowNode[];
  links: FlowLink[];
  labels: FlowLabel[];
}

/** 帯の太さ（|影響| に比例。未定量は破線用の細さ）。最大が 0 なら最小の太さ */
export function flowThickness(magnitude: number | null, maxMagnitude: number): number {
  if (magnitude === null || !Number.isFinite(magnitude)) return FLOW_UNQUANTIFIED_THICKNESS;
  if (!(maxMagnitude > 0)) return FLOW_MIN_THICKNESS;
  const share = Math.min(1, Math.abs(magnitude) / maxMagnitude);
  return FLOW_MIN_THICKNESS + (FLOW_MAX_THICKNESS - FLOW_MIN_THICKNESS) * share;
}

/** 幅に収まらない文字の末尾を「…」にする（全文は表・aria-label に置く前提） */
export function fitText(text: string, maxWidth: number, fontSize: number = FONT): string {
  if (estimateTextWidth(text, fontSize) <= maxWidth) return text;
  const chars = [...text];
  while (chars.length > 0 && estimateTextWidth(`${chars.join('')}…`, fontSize) > maxWidth) {
    chars.pop();
  }
  return `${chars.join('')}…`;
}

const round = (value: number) => Math.round(value * 10) / 10;

/** 塗りの帯（上端 y0 → y1、太さ t）。横向きの 3 次ベジェで結ぶ */
export function ribbonPath(x0: number, y0: number, x1: number, y1: number, t: number): string {
  const mid = (x0 + x1) / 2;
  return [
    `M${round(x0)},${round(y0)}`,
    `C${round(mid)},${round(y0)} ${round(mid)},${round(y1)} ${round(x1)},${round(y1)}`,
    `L${round(x1)},${round(y1 + t)}`,
    `C${round(mid)},${round(y1 + t)} ${round(mid)},${round(y0 + t)} ${round(x0)},${round(y0 + t)}`,
    'Z',
  ].join(' ');
}

/** 中心線（未定量の破線） */
export function centerPath(x0: number, y0: number, x1: number, y1: number): string {
  const mid = (x0 + x1) / 2;
  return `M${round(x0)},${round(y0)} C${round(mid)},${round(y0)} ${round(mid)},${round(y1)} ${round(x1)},${round(y1)}`;
}

interface GroupPlacement {
  spec: FlowGroupSpec;
  rows: Array<{ id: string; thickness: number; center: number }>;
}

/** 財務項目・時間帯の節点を、通る経路の中心に寄せつつ上から重ならないように置く */
function placeGroups(
  groups: GroupPlacement[],
  column: 2 | 3,
  x: number,
  width: number,
  startY: number,
): { nodes: FlowNode[]; slots: Map<string, number>; bottom: number } {
  const nodes: FlowNode[] = [];
  const slots = new Map<string, number>();
  let cursor = startY;
  for (const group of groups) {
    const inner =
      group.rows.reduce((acc, r) => acc + r.thickness, 0) +
      Math.max(0, group.rows.length - 1) * SLOT_GAP;
    const height = Math.max(
      group.spec.note ? NODE_MIN_HEIGHT_WITH_NOTE : NODE_MIN_HEIGHT,
      inner + NODE_PAD * 2,
    );
    const desired =
      group.rows.length === 0
        ? cursor
        : group.rows.reduce((acc, r) => acc + r.center, 0) / group.rows.length - height / 2;
    const y = Math.max(cursor, desired);
    let slotY = y + (height - inner) / 2;
    for (const r of group.rows) {
      slots.set(r.id, slotY);
      slotY += r.thickness + SLOT_GAP;
    }
    nodes.push({
      key: `${column === 2 ? 'line' : 'band'}:${group.spec.key}`,
      column,
      label: group.spec.label,
      sub: group.spec.sub ?? null,
      note: group.spec.note ?? null,
      x,
      y,
      width,
      height,
      dashed: group.spec.dashed ?? false,
      rowIds: group.rows.map((r) => r.id),
    });
    cursor = y + height + GROUP_GAP;
  }
  return { nodes, slots, bottom: cursor - GROUP_GAP };
}

export function layoutPathwayFlow(input: FlowLayoutInput): FlowLayout {
  const width = input.width ?? DEFAULT_WIDTH;
  const totalNodeWidth = COLUMN_WIDTHS.reduce((acc, w) => acc + w, 0);
  const gap = Math.max(24, (width - MARGIN_X * 2 - totalNodeWidth) / 3);
  const columnX: number[] = [];
  let x = MARGIN_X;
  for (const w of COLUMN_WIDTHS) {
    columnX.push(x);
    x += w + gap;
  }
  const columns = input.columnTitles.map((title, index) => ({
    title,
    x: columnX[index] ?? 0,
    width: COLUMN_WIDTHS[index] ?? 0,
  }));

  const maxMagnitude = Math.max(
    0,
    ...input.rows
      .map((r) => r.magnitude)
      .filter((m): m is number => m !== null && Number.isFinite(m))
      .map(Math.abs),
  );

  // 起点・仕組み（経路ごと）
  const nodes: FlowNode[] = [];
  const rowGeometry: Array<{ row: FlowRowInput; center: number; thickness: number }> = [];
  let cursor = TOP;
  for (const row of input.rows) {
    const thickness = flowThickness(row.magnitude, maxMagnitude);
    const hasNote = Boolean(row.origin.note || row.mechanism.note);
    const height = Math.max(
      hasNote ? NODE_MIN_HEIGHT_WITH_NOTE : NODE_MIN_HEIGHT,
      thickness + NODE_PAD * 2,
    );
    rowGeometry.push({ row, center: cursor + height / 2, thickness });
    const dashed = row.magnitude === null;
    nodes.push(
      {
        key: `origin:${row.id}`,
        column: 0,
        label: row.origin.label,
        sub: row.origin.sub ?? null,
        note: row.origin.note ?? null,
        x: columnX[0]!,
        y: cursor,
        width: COLUMN_WIDTHS[0],
        height,
        dashed,
        rowIds: [row.id],
      },
      {
        key: `mechanism:${row.id}`,
        column: 1,
        label: row.mechanism.label,
        sub: row.mechanism.sub ?? null,
        note: row.mechanism.note ?? null,
        x: columnX[1]!,
        y: cursor,
        width: COLUMN_WIDTHS[1],
        height,
        dashed,
        rowIds: [row.id],
      },
    );
    cursor += height + ROW_GAP;
  }
  const rowsBottom = input.rows.length === 0 ? TOP : cursor - ROW_GAP;

  const groupsFor = (
    specs: readonly FlowGroupSpec[],
    keyOf: (row: FlowRowInput) => string,
    centerOf: (g: (typeof rowGeometry)[number]) => number,
  ): GroupPlacement[] =>
    specs
      .map((spec) => ({
        spec,
        rows: rowGeometry
          .filter((g) => keyOf(g.row) === spec.key)
          .map((g) => ({ id: g.row.id, thickness: g.thickness, center: centerOf(g) }))
          // 節点の中の帯の並びは入ってくる高さの順（帯どうしが交差しないように）
          .sort((a, b) => a.center - b.center),
      }))
      .filter((group) => group.rows.length > 0);
  const meanCenter = (group: GroupPlacement) =>
    group.rows.reduce((acc, r) => acc + r.center, 0) / group.rows.length;

  // 財務項目は通る経路の中心の高さの順（同じ高さなら lines の順。sort は安定）
  const lineGroups: GroupPlacement[] = [
    ...groupsFor(
      input.lines,
      (row) => row.lineKey,
      (g) => g.center,
    ).sort((a, b) => meanCenter(a) - meanCenter(b)),
    ...(input.extraLineNodes ?? []).map((spec) => ({ spec, rows: [] })),
  ];
  const lines = placeGroups(lineGroups, 2, columnX[2]!, COLUMN_WIDTHS[2], TOP);
  // 時間帯は bands の順のまま、財務項目から出る帯の高さに寄せる
  const bands = placeGroups(
    groupsFor(
      input.bands,
      (row) => row.bandKey,
      (g) => (lines.slots.get(g.row.id) ?? g.center - g.thickness / 2) + g.thickness / 2,
    ),
    3,
    columnX[3]!,
    COLUMN_WIDTHS[3],
    TOP,
  );
  nodes.push(...lines.nodes, ...bands.nodes);

  // 帯（経路ごとに 3 本）と帯の文字
  const links: FlowLink[] = [];
  const labels: FlowLabel[] = [];
  for (const { row, center, thickness } of rowGeometry) {
    const dashed = row.magnitude === null;
    const top = center - thickness / 2;
    const lineSlot = lines.slots.get(row.id) ?? top;
    const bandSlot = bands.slots.get(row.id) ?? lineSlot;
    const segments: Array<[0 | 1 | 2, number, number, number, number]> = [
      [0, columnX[0]! + COLUMN_WIDTHS[0], top, columnX[1]!, top],
      [1, columnX[1]! + COLUMN_WIDTHS[1], top, columnX[2]!, lineSlot],
      [2, columnX[2]! + COLUMN_WIDTHS[2], lineSlot, columnX[3]!, bandSlot],
    ];
    for (const [column, x0, y0, x1, y1] of segments) {
      links.push({
        rowId: row.id,
        column,
        thickness,
        dashed,
        d: dashed
          ? centerPath(x0, y0 + thickness / 2, x1, y1 + thickness / 2)
          : ribbonPath(x0, y0, x1, y1, thickness),
      });
    }
    labels.push({
      rowId: row.id,
      text: fitText(row.text, gap - 4 - LABEL_PAD),
      x: columnX[1]! + COLUMN_WIDTHS[1] + 4,
      y: top - 4,
    });
  }

  const height =
    Math.max(rowsBottom, lines.bottom, bands.bottom, TOP + NODE_MIN_HEIGHT) + BOTTOM_PAD;
  return { width, height, columns, nodes, links, labels };
}
