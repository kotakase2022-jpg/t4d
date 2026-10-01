import { describe, expect, it } from 'vitest';
import {
  calcMatterAxes,
  iroFinancialScore,
  iroImpactScore,
  iroSeverity,
  proposedAxisAssessment,
  roundScore,
  validateIroShape,
  type IroShapeInput,
} from '@/lib/domain/dma';

/**
 * DMA の採点（docs/disclosure-first.md §9.2、方式 dma-demo-v1）。
 *
 * - 深刻度 = 負: 平均(規模, 範囲, 回復困難性)、正: 平均(規模, 範囲)
 * - スコア = 実在: 深刻度、潜在: √(深刻度 × 可能性)、潜在でも人権なら深刻度
 * - リスク・機会 = √(可能性 × 大きさ)
 * - 小数 1 桁に丸めた値で閾値と比べる（画面の数字と判定が一致する）。閾値ちょうどは重要
 */

function impact(overrides: Partial<IroShapeInput> = {}): IroShapeInput {
  return {
    iroType: 'impact',
    description: '製造拠点の GHG 排出（架空）',
    subTopic: '',
    valueChainStage: 'own_operations',
    timeHorizon: null,
    impactOccurrence: 'actual',
    impactDirection: 'negative',
    impactScale: 4,
    impactScope: 4,
    impactIrremediability: 4,
    impactLikelihood: null,
    financialLikelihood: null,
    financialMagnitude: null,
    humanRights: false,
    affectedStakeholders: '',
    relatedImpactIroId: null,
    ...overrides,
  };
}

function risk(likelihood: number, magnitude: number, overrides: Partial<IroShapeInput> = {}) {
  return impact({
    iroType: 'risk',
    description: '炭素価格（架空）',
    timeHorizon: 'medium',
    impactOccurrence: null,
    impactDirection: null,
    impactScale: null,
    impactScope: null,
    impactIrremediability: null,
    impactLikelihood: null,
    financialLikelihood: likelihood,
    financialMagnitude: magnitude,
    ...overrides,
  });
}

function potential(
  scale: number,
  scope: number,
  irr: number,
  likelihood: number,
  humanRights = false,
) {
  return impact({
    impactOccurrence: 'potential',
    impactScale: scale,
    impactScope: scope,
    impactIrremediability: irr,
    impactLikelihood: likelihood,
    humanRights,
  });
}

describe('深刻度とスコア', () => {
  it('負の深刻度は規模・範囲・回復困難性の平均、正は規模・範囲の平均', () => {
    expect(iroSeverity(impact({ impactScale: 3, impactScope: 3, impactIrremediability: 4 }))).toBe(
      10 / 3,
    );
    expect(
      iroSeverity(
        impact({
          impactDirection: 'positive',
          impactScale: 4,
          impactScope: 2,
          impactIrremediability: null,
        }),
      ),
    ).toBe(3);
    // リスク・機会には深刻度が無い
    expect(iroSeverity(risk(2, 2))).toBeNull();
  });

  it('実在のインパクトは深刻度そのもの（小数 1 桁）', () => {
    expect(iroImpactScore(impact())).toBe(4.0); // E1 4/4/4
    expect(
      iroImpactScore(impact({ impactScale: 3, impactScope: 3, impactIrremediability: 4 })),
    ).toBe(3.3); // E3
    expect(
      iroImpactScore(impact({ impactScale: 2, impactScope: 2, impactIrremediability: 2 })),
    ).toBe(2.0); // E5
  });

  it('潜在のインパクトは √(深刻度 × 可能性)。深刻度は丸めずに掛ける', () => {
    expect(iroImpactScore(potential(3, 2, 3, 2))).toBe(2.3); // E2: √(2.667×2)=2.31
    // E4: 深刻度 2.333 を先に 2.3 へ丸めると √4.6=2.14→2.1 になる。丸めずに √4.667=2.16→2.2
    expect(iroImpactScore(potential(2, 2, 3, 2))).toBe(2.2);
    expect(iroImpactScore(potential(2, 1, 1, 2))).toBe(1.6); // S3
    expect(iroImpactScore(potential(4, 2, 3, 1))).toBe(1.7); // S4
    expect(iroImpactScore(potential(3, 2, 2, 2))).toBe(2.2); // G1
  });

  it('潜在でも人権に関わるインパクトは深刻度を可能性より優先する', () => {
    expect(iroImpactScore(potential(4, 3, 3, 3, true))).toBe(3.3); // S1（人権）
    expect(iroImpactScore(potential(5, 3, 5, 2, true))).toBe(4.3); // S2（人権）
    // 人権でなければ可能性で割り引かれる（同じ入力で √(4.333×2)=2.94→2.9）
    expect(iroImpactScore(potential(5, 3, 5, 2, false))).toBe(2.9);
  });

  it('リスク・機会は √(可能性 × 大きさ)', () => {
    expect(iroFinancialScore(risk(4, 4))).toBe(4.0); // E1
    expect(iroFinancialScore(risk(2, 3))).toBe(2.4); // E3
    expect(iroFinancialScore(risk(1, 3))).toBe(1.7); // E4
    expect(iroFinancialScore(risk(4, 3))).toBe(3.5); // S1
    expect(iroFinancialScore(risk(1, 2))).toBe(1.4); // S3
    expect(iroFinancialScore(risk(2, 5))).toBe(3.2); // S4・G1
    expect(iroFinancialScore(risk(2, 2, { iroType: 'opportunity' }))).toBe(2.0); // E5（機会）
    // インパクトには財務のスコアが無い
    expect(iroFinancialScore(impact())).toBeNull();
    expect(iroImpactScore(risk(2, 2))).toBeNull();
  });

  it('丸めは小数 1 桁の四捨五入（浮動小数の誤差で切り捨てない）', () => {
    expect(roundScore(2.25)).toBe(2.3);
    expect(roundScore(2.249)).toBe(2.2);
    expect(roundScore(Math.sqrt(9))).toBe(3);
  });
});

describe('事項ごとの算定（提案）', () => {
  const thresholds = { impactThreshold: 3.0, financialThreshold: 3.0 };

  it('各側の最大スコアと閾値を比べる。閾値ちょうどは重要', () => {
    const axes = calcMatterAxes(
      [
        impact({ impactScale: 3, impactScope: 3, impactIrremediability: 3 }),
        risk(2, 3),
        risk(3, 3),
      ],
      thresholds,
    );
    expect(axes.impact).toMatchObject({ iroCount: 1, maxScore: 3.0, proposedMaterial: true });
    expect(axes.financial).toMatchObject({ iroCount: 2, maxScore: 3.0, proposedMaterial: true });
  });

  it('丸めた値で閾値と比べる（2.887 は 2.9 と表示され、閾値 2.9 で重要と提案される）', () => {
    // 潜在 2/2/1・可能性 5: √(5/3×5)=2.887。丸める前の値で比べると、画面の「2.9」と判定が食い違う
    const axes = calcMatterAxes([potential(2, 2, 1, 5)], {
      impactThreshold: 2.9,
      financialThreshold: 3.0,
    });
    expect(axes.impact).toMatchObject({ maxScore: 2.9, proposedMaterial: true });
    const below = calcMatterAxes([risk(2, 4)], { impactThreshold: 3.0, financialThreshold: 2.9 });
    // √8=2.83→2.8 < 2.9
    expect(below.financial).toMatchObject({ maxScore: 2.8, proposedMaterial: false });
  });

  it('その側の IRO が無ければ「評価材料なし」（null）。論理削除した IRO は数えない', () => {
    const axes = calcMatterAxes(
      [impact(), { ...risk(4, 4), deletedAt: '2026-10-01T00:00:00.000Z' }],
      thresholds,
    );
    expect(axes.impact.proposedMaterial).toBe(true);
    expect(axes.financial).toMatchObject({ iroCount: 0, maxScore: null, proposedMaterial: null });
    expect(proposedAxisAssessment(axes.financial)).toBe('not_assessed');
    expect(proposedAxisAssessment(axes.impact)).toBe('material');
  });

  it('閾値を上げると提案が変わる（閾値は会社が決める）', () => {
    const axes = calcMatterAxes([impact()], { impactThreshold: 4.1, financialThreshold: 3.0 });
    expect(axes.impact).toMatchObject({ maxScore: 4.0, threshold: 4.1, proposedMaterial: false });
    expect(proposedAxisAssessment(axes.impact)).toBe('not_material');
  });
});

describe('IRO の形の検査（不正な形を拒否する）', () => {
  it('正しい形のインパクト・リスク・機会は受け付ける', () => {
    expect(validateIroShape(impact())).toEqual([]);
    expect(validateIroShape(potential(3, 2, 3, 2))).toEqual([]);
    expect(validateIroShape(risk(2, 2))).toEqual([]);
    expect(validateIroShape(risk(2, 2, { iroType: 'opportunity' }))).toEqual([]);
    expect(
      validateIroShape(impact({ impactDirection: 'positive', impactIrremediability: null })),
    ).toEqual([]);
  });

  it('説明が空・範囲外・小数の入力は拒否する', () => {
    expect(validateIroShape(impact({ description: '  ' })).length).toBeGreaterThan(0);
    expect(validateIroShape(impact({ impactScale: 6 })).length).toBeGreaterThan(0);
    expect(validateIroShape(impact({ impactScale: 0 })).length).toBeGreaterThan(0);
    expect(validateIroShape(impact({ impactScale: 2.5 })).length).toBeGreaterThan(0);
  });

  it('負のインパクトは回復困難性が必須、正のインパクトは回復困難性を持たない', () => {
    expect(validateIroShape(impact({ impactIrremediability: null })).length).toBeGreaterThan(0);
    expect(
      validateIroShape(impact({ impactDirection: 'positive', impactIrremediability: 3 })).length,
    ).toBeGreaterThan(0);
  });

  it('潜在のインパクトは可能性が必須、実在は可能性を持たない', () => {
    expect(
      validateIroShape(impact({ impactOccurrence: 'potential', impactLikelihood: null })).length,
    ).toBeGreaterThan(0);
    expect(validateIroShape(impact({ impactLikelihood: 3 })).length).toBeGreaterThan(0);
  });

  it('インパクトに財務の値、リスクにインパクトの値・人権フラグを混ぜられない', () => {
    expect(validateIroShape(impact({ financialLikelihood: 2 })).length).toBeGreaterThan(0);
    expect(validateIroShape(risk(2, 2, { impactScale: 3 })).length).toBeGreaterThan(0);
    expect(validateIroShape(risk(2, 2, { humanRights: true })).length).toBeGreaterThan(0);
  });

  it('リスク・機会は可能性・大きさ・期間が必須。関連インパクトはリスク・機会だけが持つ', () => {
    expect(validateIroShape(risk(2, 2, { timeHorizon: null })).length).toBeGreaterThan(0);
    expect(validateIroShape(risk(2, 2, { financialMagnitude: null })).length).toBeGreaterThan(0);
    expect(
      validateIroShape(impact({ relatedImpactIroId: '00000000-0000-4000-8000-000000000001' }))
        .length,
    ).toBeGreaterThan(0);
  });

  it('値の種類が既知のものに限られる', () => {
    expect(
      validateIroShape(impact({ valueChainStage: 'elsewhere' as never })).length,
    ).toBeGreaterThan(0);
    expect(validateIroShape(impact({ iroType: 'threat' as never })).length).toBeGreaterThan(0);
  });
});
