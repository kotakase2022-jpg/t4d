import { describe, expect, it } from 'vitest';
import {
  axisProposalLabel,
  axisProposalText,
  formatScore,
  iroInputSummary,
  layoutDmaMatrix,
  type DmaMatrixInput,
} from '@/app/enterprise/disclosures/csrd/settings/dma-view';
import type { DmaAxisResult, IroScoreInput } from '@/lib/domain/dma';

/**
 * CSRD 設定の DMA 表示（docs/disclosure-first.md §9.2・§9.4）。
 *  - 算定結果は小数 1 桁で示し、閾値ちょうどは「重要」を提案（判定と画面の数字が一致）
 *  - IRO が無い側は「評価材料なし」（0 点にしない）
 *  - マトリクスはインパクト（縦）× 財務（横）。位置は算定結果、閾値の線は判定と同じ位置
 *  - ラベルどうし・点とラベルが重ならない（Fixture の 10 事項で確かめる）
 */

const axis = (iroCount: number, maxScore: number | null, threshold = 3): DmaAxisResult => ({
  iroCount,
  maxScore,
  threshold,
  proposedMaterial: maxScore === null ? null : maxScore >= threshold,
});

describe('算定結果（提案）の表示', () => {
  it('小数 1 桁・閾値ちょうどは重要・評価材料なし', () => {
    expect(formatScore(4)).toBe('4.0');
    expect(formatScore(2.25)).toBe('2.3');
    expect(formatScore(null)).toBe('—');
    expect(axisProposalText(axis(1, 4))).toBe('4.0 ≥ 閾値 3.0');
    expect(axisProposalLabel(axis(1, 4))).toBe('重要');
    expect(axisProposalText(axis(2, 3))).toBe('3.0 ≥ 閾値 3.0');
    expect(axisProposalLabel(axis(2, 3))).toBe('重要');
    expect(axisProposalText(axis(1, 2.4, 2.5))).toBe('2.4 < 閾値 2.5');
    expect(axisProposalLabel(axis(1, 2.4, 2.5))).toBe('重要でない');
    expect(axisProposalText(axis(0, null))).toBe('評価材料なし');
    expect(axisProposalLabel(axis(0, null))).toBe('評価材料なし');
  });
});

describe('IRO の入力の要約', () => {
  const none: IroScoreInput = {
    iroType: 'impact',
    impactOccurrence: null,
    impactDirection: null,
    impactScale: null,
    impactScope: null,
    impactIrremediability: null,
    impactLikelihood: null,
    financialLikelihood: null,
    financialMagnitude: null,
    humanRights: false,
  };

  it('インパクト（負・実在／負・潜在・人権／正）', () => {
    expect(
      iroInputSummary({
        ...none,
        impactOccurrence: 'actual',
        impactDirection: 'negative',
        impactScale: 4,
        impactScope: 4,
        impactIrremediability: 4,
      }),
    ).toBe('実在・負 ／ 規模 4・範囲 4・回復困難性 4');
    expect(
      iroInputSummary({
        ...none,
        impactOccurrence: 'potential',
        impactDirection: 'negative',
        impactScale: 4,
        impactScope: 3,
        impactIrremediability: 3,
        impactLikelihood: 3,
        humanRights: true,
      }),
    ).toBe('潜在・負・人権 ／ 規模 4・範囲 3・回復困難性 3・可能性 3');
    expect(
      iroInputSummary({
        ...none,
        impactOccurrence: 'actual',
        impactDirection: 'positive',
        impactScale: 2,
        impactScope: 3,
      }),
    ).toBe('実在・正 ／ 規模 2・範囲 3');
  });

  it('リスク・機会は 可能性 × 大きさ', () => {
    expect(
      iroInputSummary({ ...none, iroType: 'risk', financialLikelihood: 2, financialMagnitude: 5 }),
    ).toBe('可能性 2 × 大きさ 5');
  });
});

/** Fixture の 10 事項（§9.3。財務 x・インパクト y） */
const FIXTURE_POINTS: DmaMatrixInput[] = [
  { topic: 'E1', impactScore: 4.0, financialScore: 4.0, outcome: 'both' },
  { topic: 'E2', impactScore: 2.3, financialScore: 2.0, outcome: 'not_material' },
  { topic: 'E3', impactScore: 3.3, financialScore: 2.4, outcome: 'impact_only' },
  { topic: 'E4', impactScore: 2.2, financialScore: 1.7, outcome: 'not_material' },
  { topic: 'E5', impactScore: 2.0, financialScore: 2.0, outcome: 'not_material' },
  { topic: 'S1', impactScore: 3.3, financialScore: 3.5, outcome: 'both' },
  { topic: 'S2', impactScore: 4.3, financialScore: 2.0, outcome: 'impact_only' },
  { topic: 'S3', impactScore: 1.6, financialScore: 1.4, outcome: 'not_material' },
  { topic: 'S4', impactScore: 1.7, financialScore: 3.2, outcome: 'financial_only' },
  { topic: 'G1', impactScore: 2.2, financialScore: 3.2, outcome: 'not_assessed' },
];

interface Box {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}
const overlaps = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;

describe('マトリクスの配置', () => {
  const thresholds = { impactThreshold: 3.0, financialThreshold: 3.0 };
  const layout = layoutDmaMatrix(FIXTURE_POINTS, thresholds);

  it('1〜5 の 5×5 の枠。目盛は 1〜5', () => {
    expect(layout.ticks.map((t) => t.score)).toEqual([1, 2, 3, 4, 5]);
    expect(layout.gridLines).toHaveLength(6);
  });

  it('財務が大きいほど右、インパクトが大きいほど上。閾値の線は同じ尺度の位置', () => {
    const at = (topic: string) => layout.points.find((p) => p.topic === topic)!;
    expect(at('E1').cx).toBeGreaterThan(at('E5').cx);
    expect(at('S2').cy).toBeLessThan(at('E5').cy);
    // 閾値ちょうどの点は線の上に乗る（画面の位置と判定が一致する）
    const onLine = layoutDmaMatrix(
      [{ topic: 'E1', impactScore: 3.0, financialScore: 3.0, outcome: 'both' }],
      thresholds,
    ).points[0]!;
    expect(onLine.cx).toBeCloseTo(layout.thresholdX, 5);
    expect(onLine.cy).toBeCloseTo(layout.thresholdY, 5);
    for (const p of layout.points) {
      expect(p.cx).toBeGreaterThanOrEqual(layout.plot.left);
      expect(p.cx).toBeLessThanOrEqual(layout.plot.right);
      expect(p.cy).toBeGreaterThanOrEqual(layout.plot.top);
      expect(p.cy).toBeLessThanOrEqual(layout.plot.bottom);
    }
  });

  it('人の判断が未評価の事項は印を分ける（decided=false）', () => {
    expect(layout.points.find((p) => p.topic === 'G1')!.decided).toBe(false);
    expect(layout.points.filter((p) => p.decided)).toHaveLength(9);
  });

  it('ラベルどうし、ラベルと点が重ならず、枠の中に収まる', () => {
    const labels = layout.points.map((p) => p.labelBox);
    for (let i = 0; i < labels.length; i += 1) {
      for (let j = i + 1; j < labels.length; j += 1) {
        expect(overlaps(labels[i]!, labels[j]!), `${i}-${j}`).toBe(false);
      }
      for (const p of layout.points) {
        const dot = { x1: p.cx - 4, x2: p.cx + 4, y1: p.cy - 4, y2: p.cy + 4 };
        expect(overlaps(labels[i]!, dot), `${layout.points[i]!.topic} と ${p.topic}`).toBe(false);
      }
      expect(labels[i]!.x1).toBeGreaterThanOrEqual(layout.plot.left);
      expect(labels[i]!.x2).toBeLessThanOrEqual(layout.plot.right);
      expect(labels[i]!.y1).toBeGreaterThanOrEqual(layout.plot.top);
      expect(labels[i]!.y2).toBeLessThanOrEqual(layout.plot.bottom);
    }
  });

  it('どちらかの軸に評価材料が無い事項は配置せず、別に列挙する', () => {
    const partial = layoutDmaMatrix(
      [
        { topic: 'E1', impactScore: 4, financialScore: null, outcome: 'not_assessed' },
        { topic: 'E2', impactScore: 2, financialScore: 2, outcome: 'not_material' },
      ],
      thresholds,
    );
    expect(partial.points.map((p) => p.topic)).toEqual(['E2']);
    expect(partial.unplaced.map((p) => p.topic)).toEqual(['E1']);
  });
});
