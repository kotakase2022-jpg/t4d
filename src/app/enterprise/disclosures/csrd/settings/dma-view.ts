import {
  IMPACT_DIRECTION_LABEL,
  IMPACT_OCCURRENCE_LABEL,
  type DmaAxisResult,
  type DmaThresholds,
  type IroScoreInput,
} from '@/lib/domain/dma';
import type { DmaOutcome, EsrsTopic } from '@/types/domain';

/**
 * CSRD 設定画面の DMA の表示（docs/disclosure-first.md §9.2・§9.4）。純関数（画面とテストが同じ規則を使う）。
 *
 * 算定結果（自社の方法・閾値による提案）と人の判断を取り違えないよう、表示の文言をここに集める。
 * 判定は丸めた値（小数 1 桁）で行う（domain/dma.ts）ため、画面の数字も同じ桁で出す。
 */

/** スコアの表示（小数 1 桁）。評価材料が無ければ「—」 */
export function formatScore(value: number | null): string {
  if (value === null) return '—';
  return (Math.round((value + Number.EPSILON) * 10) / 10).toFixed(1);
}

/** 1 つの側の算定結果と閾値の比較（例:「4.0 ≥ 閾値 3.0」）。IRO が無ければ「評価材料なし」 */
export function axisProposalText(axis: DmaAxisResult): string {
  if (axis.maxScore === null || axis.proposedMaterial === null) return '評価材料なし';
  const relation = axis.proposedMaterial ? '≥' : '<';
  return `${formatScore(axis.maxScore)} ${relation} 閾値 ${formatScore(axis.threshold)}`;
}

/** 算定結果が提案する判断（人の判断と同じ言葉。ただし画面では必ず「提案」と併記する） */
export function axisProposalLabel(axis: DmaAxisResult): '重要' | '重要でない' | '評価材料なし' {
  if (axis.proposedMaterial === null) return '評価材料なし';
  return axis.proposedMaterial ? '重要' : '重要でない';
}

/** IRO の入力の要約（表の 1 セル） */
export function iroInputSummary(iro: IroScoreInput): string {
  if (iro.iroType !== 'impact') {
    return `可能性 ${iro.financialLikelihood ?? '—'} × 大きさ ${iro.financialMagnitude ?? '—'}`;
  }
  const kind = [
    iro.impactOccurrence ? IMPACT_OCCURRENCE_LABEL[iro.impactOccurrence] : '—',
    iro.impactDirection ? IMPACT_DIRECTION_LABEL[iro.impactDirection] : '—',
    ...(iro.humanRights ? ['人権'] : []),
  ].join('・');
  const inputs = [`規模 ${iro.impactScale ?? '—'}`, `範囲 ${iro.impactScope ?? '—'}`];
  if (iro.impactDirection !== 'positive') {
    inputs.push(`回復困難性 ${iro.impactIrremediability ?? '—'}`);
  }
  if (iro.impactOccurrence === 'potential') inputs.push(`可能性 ${iro.impactLikelihood ?? '—'}`);
  return `${kind} ／ ${inputs.join('・')}`;
}

// ----------------------------------------------------------------------
// マトリクス（インパクト重要性 × 財務的重要性）
// ----------------------------------------------------------------------

/** マトリクスに置く 1 事項。スコアは算定結果（提案）、outcome は人の判断から導いた結果 */
export interface DmaMatrixInput {
  topic: EsrsTopic;
  impactScore: number | null;
  financialScore: number | null;
  outcome: DmaOutcome;
}

/** 画面が渡す事項の状態から、マトリクスの入力を作る */
export function matrixInputsOf(
  matters: ReadonlyArray<{
    topic: EsrsTopic;
    axes: { impact: DmaAxisResult; financial: DmaAxisResult };
    outcome: DmaOutcome;
  }>,
): DmaMatrixInput[] {
  return matters.map((m) => ({
    topic: m.topic,
    impactScore: m.axes.impact.maxScore,
    financialScore: m.axes.financial.maxScore,
    outcome: m.outcome,
  }));
}

export interface LabelBox {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

export interface DmaMatrixPoint extends DmaMatrixInput {
  impactScore: number;
  financialScore: number;
  cx: number;
  cy: number;
  /** 人が両軸を判断済みか（未評価は印の形を変える。色だけに頼らない） */
  decided: boolean;
  labelX: number;
  labelY: number;
  anchor: 'start' | 'middle' | 'end';
  labelBox: LabelBox;
}

export interface DmaMatrixLayout {
  width: number;
  height: number;
  plot: { left: number; right: number; top: number; bottom: number };
  /** 目盛（1〜5）。x は財務、y はインパクトの位置 */
  ticks: Array<{ score: number; x: number; y: number }>;
  /** 5×5 の枠の線（0.5〜5.5 の 6 本。縦横同じ値） */
  gridLines: number[];
  thresholdX: number;
  thresholdY: number;
  /** 閾値の線の名前の位置（文字の左端・ベースライン） */
  thresholdLabels: {
    financial: { x: number; y: number };
    impact: { x: number; y: number };
  };
  points: DmaMatrixPoint[];
  /** どちらかの軸に評価材料が無く、置けない事項 */
  unplaced: DmaMatrixInput[];
  /**
   * 象限の名前（提案）。閾値で区切った各象限の隅に置く。象限が狭い・点やラベルと重なるときは置かない
   * （凡例に同じ説明があるため、図から省いても意味は失われない）
   */
  quadrants: Array<{
    outcome: Exclude<DmaOutcome, 'not_assessed'>;
    x: number;
    y: number;
    anchor: 'start' | 'end';
  }>;
}

/** 象限の名前（提案）。人の判断ではないことを必ず併記する */
export const QUADRANT_LABEL: Record<Exclude<DmaOutcome, 'not_assessed'>, string> = {
  both: '両面で重要（提案）',
  impact_only: 'インパクトのみ（提案）',
  financial_only: '財務のみ（提案）',
  not_material: '重要でない（提案）',
};

const WIDTH = 440;
const HEIGHT = 360;
const PLOT = { left: 64, right: 424, top: 16, bottom: 304 };
/** 1〜5 の各段階を 1 マスにする（0.5〜5.5） */
const MIN = 0.5;
const MAX = 5.5;
const DOT_RADIUS = 4;
/** ラベルの大きさの見積り（11px の英数字。事項コードは 2 文字） */
const CHAR_WIDTH = 7.5;
const LABEL_HEIGHT = 12;

function xOf(score: number): number {
  return PLOT.left + ((score - MIN) / (MAX - MIN)) * (PLOT.right - PLOT.left);
}

function yOf(score: number): number {
  return PLOT.bottom - ((score - MIN) / (MAX - MIN)) * (PLOT.bottom - PLOT.top);
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
}

function inside(box: LabelBox): boolean {
  return box.x1 >= PLOT.left && box.x2 <= PLOT.right && box.y1 >= PLOT.top && box.y2 <= PLOT.bottom;
}

/**
 * ラベルの位置の候補（右・左・上・下・斜め）。y は文字のベースライン。
 * 点が近い事項（Fixture の E2・E4・E5 など）でラベルが重ならないよう、空いている最初の候補を使う
 */
function labelCandidates(
  cx: number,
  cy: number,
  width: number,
): Array<{ labelX: number; labelY: number; anchor: DmaMatrixPoint['anchor']; box: LabelBox }> {
  const gap = DOT_RADIUS + 3;
  const half = LABEL_HEIGHT / 2;
  const mk = (x1: number, y1: number, anchor: DmaMatrixPoint['anchor']) => ({
    labelX: anchor === 'start' ? x1 : anchor === 'end' ? x1 + width : x1 + width / 2,
    labelY: y1 + LABEL_HEIGHT - 2,
    anchor,
    box: { x1, x2: x1 + width, y1, y2: y1 + LABEL_HEIGHT },
  });
  return [
    mk(cx + gap, cy - half, 'start'),
    mk(cx - gap - width, cy - half, 'end'),
    mk(cx - width / 2, cy - gap - LABEL_HEIGHT, 'middle'),
    mk(cx - width / 2, cy + gap, 'middle'),
    mk(cx + gap, cy - gap - LABEL_HEIGHT, 'start'),
    mk(cx + gap, cy + gap, 'start'),
    mk(cx - gap - width, cy - gap - LABEL_HEIGHT, 'end'),
    mk(cx - gap - width, cy + gap, 'end'),
  ];
}

/**
 * マトリクスの配置。横＝財務（リスク・機会のスコア）、縦＝インパクト（インパクトのスコア）。
 * 位置は算定結果そのもの（丸めた値）で、閾値の線も同じ尺度に引く（閾値ちょうどの点は線の上）
 */
export function layoutDmaMatrix(
  inputs: readonly DmaMatrixInput[],
  thresholds: DmaThresholds,
): DmaMatrixLayout {
  const placeable = inputs.filter(
    (p): p is DmaMatrixInput & { impactScore: number; financialScore: number } =>
      p.impactScore !== null && p.financialScore !== null,
  );
  const dots: LabelBox[] = placeable.map((p) => {
    const cx = xOf(p.financialScore);
    const cy = yOf(p.impactScore);
    return { x1: cx - DOT_RADIUS, x2: cx + DOT_RADIUS, y1: cy - DOT_RADIUS, y2: cy + DOT_RADIUS };
  });
  const thresholdX = xOf(thresholds.financialThreshold);
  const thresholdY = yOf(thresholds.impactThreshold);
  const thresholdLabels = thresholdLabelsOf(thresholdX, thresholdY);
  // 閾値の名前の場所は先に押さえる（点のラベルがその上に重ならないように）
  const placedLabels: LabelBox[] = [thresholdLabels.financial.box, thresholdLabels.impact.box];
  const points: DmaMatrixPoint[] = placeable.map((p) => {
    const cx = xOf(p.financialScore);
    const cy = yOf(p.impactScore);
    const width = p.topic.length * CHAR_WIDTH;
    const candidates = labelCandidates(cx, cy, width);
    const chosen =
      candidates.find(
        (c) =>
          inside(c.box) &&
          !placedLabels.some((box) => overlaps(box, c.box)) &&
          !dots.some((dot) => overlaps(dot, c.box)),
      ) ??
      candidates.find((c) => inside(c.box)) ??
      candidates[0]!;
    placedLabels.push(chosen.box);
    return {
      ...p,
      cx,
      cy,
      decided: p.outcome !== 'not_assessed',
      labelX: chosen.labelX,
      labelY: chosen.labelY,
      anchor: chosen.anchor,
      labelBox: chosen.box,
    };
  });
  const scores = [1, 2, 3, 4, 5];
  return {
    width: WIDTH,
    height: HEIGHT,
    plot: PLOT,
    ticks: scores.map((score) => ({ score, x: xOf(score), y: yOf(score) })),
    gridLines: [0.5, 1.5, 2.5, 3.5, 4.5, 5.5],
    thresholdX,
    thresholdY,
    thresholdLabels: {
      financial: { x: thresholdLabels.financial.x, y: thresholdLabels.financial.y },
      impact: { x: thresholdLabels.impact.x, y: thresholdLabels.impact.y },
    },
    points,
    unplaced: inputs.filter((p) => p.impactScore === null || p.financialScore === null),
    quadrants: quadrantLabels(thresholdX, thresholdY, [...dots, ...placedLabels]),
  };
}

/** 閾値の名前（9px）の大きさの見積り。財務は線の右下、インパクトは線の左上に置く */
const THRESHOLD_LABEL_HEIGHT = 11;
const FINANCIAL_THRESHOLD_LABEL_WIDTH = 60;
const IMPACT_THRESHOLD_LABEL_WIDTH = 86;

function thresholdLabelsOf(
  thresholdX: number,
  thresholdY: number,
): Record<'financial' | 'impact', { x: number; y: number; box: LabelBox }> {
  const fx = thresholdX + 3;
  const fy = PLOT.bottom - 4;
  const ix = PLOT.left + 3;
  const iy = thresholdY - 3;
  return {
    financial: {
      x: fx,
      y: fy,
      box: {
        x1: fx,
        x2: fx + FINANCIAL_THRESHOLD_LABEL_WIDTH,
        y1: fy - THRESHOLD_LABEL_HEIGHT + 2,
        y2: fy + 2,
      },
    },
    impact: {
      x: ix,
      y: iy,
      box: {
        x1: ix,
        x2: ix + IMPACT_THRESHOLD_LABEL_WIDTH,
        y1: iy - THRESHOLD_LABEL_HEIGHT + 2,
        y2: iy + 2,
      },
    },
  };
}

/** 象限の名前の大きさの見積り（10px の和文） */
const QUADRANT_CHAR_WIDTH = 10;
const QUADRANT_HEIGHT = 12;

function quadrantLabels(
  thresholdX: number,
  thresholdY: number,
  occupied: readonly LabelBox[],
): DmaMatrixLayout['quadrants'] {
  const pad = 4;
  const specs: Array<{
    outcome: Exclude<DmaOutcome, 'not_assessed'>;
    right: boolean;
    top: boolean;
  }> = [
    { outcome: 'impact_only', right: false, top: true },
    { outcome: 'both', right: true, top: true },
    { outcome: 'not_material', right: false, top: false },
    { outcome: 'financial_only', right: true, top: false },
  ];
  const result: DmaMatrixLayout['quadrants'] = [];
  for (const spec of specs) {
    const width = QUADRANT_LABEL[spec.outcome].length * QUADRANT_CHAR_WIDTH;
    const x1 = spec.right ? PLOT.right - pad - width : PLOT.left + pad;
    const y1 = spec.top ? PLOT.top + pad : PLOT.bottom - pad - QUADRANT_HEIGHT;
    const box = { x1, x2: x1 + width, y1, y2: y1 + QUADRANT_HEIGHT };
    // 自分の象限の中に収まるときだけ（閾値の線をまたいで別の象限に見えないように）
    const withinQuadrant =
      (spec.right ? box.x1 >= thresholdX + 2 : box.x2 <= thresholdX - 2) &&
      (spec.top ? box.y2 <= thresholdY - 2 : box.y1 >= thresholdY + 2);
    if (!withinQuadrant || occupied.some((o) => overlaps(o, box))) continue;
    result.push({
      outcome: spec.outcome,
      x: spec.right ? box.x2 : box.x1,
      y: box.y2 - 2,
      anchor: spec.right ? 'end' : 'start',
    });
  }
  return result;
}

/** 枠線の位置（gridLines の値を画面の座標へ） */
export function gridX(score: number): number {
  return xOf(score);
}

export function gridY(score: number): number {
  return yOf(score);
}
