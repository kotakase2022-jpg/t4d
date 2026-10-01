/**
 * ダブル・マテリアリティ評価（DMA）の採点（docs/disclosure-first.md §9.2、方式 dma-demo-v1）。
 *
 * ESRS は数値の閾値も採点式も定めていない。ここにあるのは「自社の評価方法（デモ既定）」で、
 * 画面にもそう明示する。算定結果は人の判断の材料（提案）にすぎず、事項の重要性は
 * csrd_dma_matters に人が根拠付きで入れる（AI も算定式も確定しない）。
 *
 * `server-only` を付けない純粋モジュール。サービス・画面・テストが同じ式を使う。
 */

import {
  IMPACT_DIRECTIONS,
  IMPACT_OCCURRENCES,
  IRO_TYPES,
  TIME_HORIZONS,
  VALUE_CHAIN_STAGES,
  type CsrdDmaIro,
  type DmaAxisAssessment,
  type DmaScoringMethod,
  type ImpactDirection,
  type ImpactOccurrence,
  type IroType,
  type TimeHorizon,
  type ValueChainStage,
} from '@/types/domain';

// ----------------------------------------------------------------------
// 表示ラベル
// ----------------------------------------------------------------------

export const IRO_TYPE_LABEL: Record<IroType, string> = {
  impact: 'インパクト',
  risk: 'リスク',
  opportunity: '機会',
};

export const IMPACT_OCCURRENCE_LABEL: Record<ImpactOccurrence, string> = {
  actual: '実在',
  potential: '潜在',
};

export const IMPACT_DIRECTION_LABEL: Record<ImpactDirection, string> = {
  negative: '負',
  positive: '正',
};

export const VALUE_CHAIN_STAGE_LABEL: Record<ValueChainStage, string> = {
  own_operations: '自社',
  upstream: '上流',
  downstream: '下流',
};

export const TIME_HORIZON_LABEL: Record<TimeHorizon, string> = {
  short: '短期',
  medium: '中期',
  long: '長期',
};

/** 期間の定義（画面の凡例） */
export const TIME_HORIZON_MEANING: Record<TimeHorizon, string> = {
  short: '報告期間',
  medium: '〜5 年',
  long: '5 年超',
};

export const DMA_SCORING_METHOD_LABEL: Record<DmaScoringMethod, string> = {
  'dma-demo-v1': '自社の評価方法（デモ既定 dma-demo-v1）',
};

/** 入力の段階（1〜5）の範囲。すべて整数 */
export const DMA_SCORE_MIN = 1;
export const DMA_SCORE_MAX = 5;
/** 閾値の既定値と範囲（numeric(2,1)、0044 の CHECK と同じ） */
export const DEFAULT_DMA_THRESHOLD = 3.0;
export const DMA_THRESHOLD_MIN = 1.0;
export const DMA_THRESHOLD_MAX = 5.0;

// ----------------------------------------------------------------------
// 採点
// ----------------------------------------------------------------------

/** 採点に使う IRO の列 */
export type IroScoreInput = Pick<
  CsrdDmaIro,
  | 'iroType'
  | 'impactOccurrence'
  | 'impactDirection'
  | 'impactScale'
  | 'impactScope'
  | 'impactIrremediability'
  | 'impactLikelihood'
  | 'financialLikelihood'
  | 'financialMagnitude'
  | 'humanRights'
>;

/**
 * 小数 1 桁へ丸める（四捨五入）。閾値との比較もこの値で行い、画面の数字と判定を一致させる
 * （丸める前の値で比べると「2.9 と表示されているのに閾値 2.9 未満」が起きる）。
 * 浮動小数の誤差で 2.25 が 2.2 にならないよう、わずかに足してから丸める。
 */
export function roundScore(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * 深刻度（丸めない）。負: 平均(規模, 範囲, 回復困難性)、正: 平均(規模, 範囲)。
 * インパクト以外・必要な入力が欠けたものは null
 */
export function iroSeverity(iro: IroScoreInput): number | null {
  if (iro.iroType !== 'impact') return null;
  if (iro.impactScale === null || iro.impactScope === null) return null;
  if (iro.impactDirection === 'negative') {
    if (iro.impactIrremediability === null) return null;
    return mean([iro.impactScale, iro.impactScope, iro.impactIrremediability]);
  }
  if (iro.impactDirection === 'positive') return mean([iro.impactScale, iro.impactScope]);
  return null;
}

/**
 * インパクトのスコア（小数 1 桁）。実在: 深刻度、潜在: √(深刻度 × 可能性)。
 * 潜在でも人権に関わるものは深刻度（深刻度を可能性より優先する）。
 * 深刻度は丸めずに掛ける（先に丸めると E4 の例で 2.2 が 2.1 になる）
 */
export function iroImpactScore(iro: IroScoreInput): number | null {
  const severity = iroSeverity(iro);
  if (severity === null) return null;
  if (iro.impactOccurrence === 'actual') return roundScore(severity);
  if (iro.impactOccurrence !== 'potential') return null;
  if (iro.humanRights) return roundScore(severity);
  if (iro.impactLikelihood === null) return null;
  return roundScore(Math.sqrt(severity * iro.impactLikelihood));
}

/** リスク・機会のスコア（小数 1 桁）。√(発生可能性 × 財務影響の大きさ) */
export function iroFinancialScore(iro: IroScoreInput): number | null {
  if (iro.iroType !== 'risk' && iro.iroType !== 'opportunity') return null;
  if (iro.financialLikelihood === null || iro.financialMagnitude === null) return null;
  return roundScore(Math.sqrt(iro.financialLikelihood * iro.financialMagnitude));
}

export interface DmaThresholds {
  impactThreshold: number;
  financialThreshold: number;
}

/** 1 つの側（インパクト／財務）の算定結果 */
export interface DmaAxisResult {
  /** その側の IRO（論理削除を除く）の数。0 は「評価材料なし」 */
  iroCount: number;
  /** 最大スコア（小数 1 桁）。評価材料が無ければ null */
  maxScore: number | null;
  threshold: number;
  /** 提案: 最大スコアが閾値以上なら true（閾値ちょうどは重要）、未満は false、評価材料なしは null */
  proposedMaterial: boolean | null;
}

export interface MatterAxes {
  impact: DmaAxisResult;
  financial: DmaAxisResult;
}

function axisResult(scores: Array<number | null>, threshold: number): DmaAxisResult {
  const valid = scores.filter((s): s is number => s !== null);
  if (valid.length === 0) {
    return { iroCount: 0, maxScore: null, threshold, proposedMaterial: null };
  }
  const maxScore = Math.max(...valid);
  return { iroCount: valid.length, maxScore, threshold, proposedMaterial: maxScore >= threshold };
}

/**
 * 事項ごとの算定結果（提案）。インパクト側 = いずれかのインパクト IRO のスコア ≥ インパクト閾値、
 * 財務側 = いずれかのリスク・機会のスコア ≥ 財務閾値。IRO が無い側は「評価材料なし」。
 * 論理削除した IRO（deletedAt あり）は数えない
 */
export function calcMatterAxes(
  iros: ReadonlyArray<IroScoreInput & { deletedAt?: string | null }>,
  thresholds: DmaThresholds,
): MatterAxes {
  const live = iros.filter((iro) => !iro.deletedAt);
  return {
    impact: axisResult(
      live.filter((iro) => iro.iroType === 'impact').map(iroImpactScore),
      thresholds.impactThreshold,
    ),
    financial: axisResult(
      live.filter((iro) => iro.iroType !== 'impact').map(iroFinancialScore),
      thresholds.financialThreshold,
    ),
  };
}

/** 算定結果を、人の判断と同じ 3 値に写す（評価材料なしは「未評価」） */
export function proposedAxisAssessment(axis: DmaAxisResult): DmaAxisAssessment {
  if (axis.proposedMaterial === null) return 'not_assessed';
  return axis.proposedMaterial ? 'material' : 'not_material';
}

// ----------------------------------------------------------------------
// 入力の形の検査（0044 の CHECK と同じ規則。画面・Cookie から戻す行にも使う）
// ----------------------------------------------------------------------

/** 形の検査に使う IRO の列 */
export type IroShapeInput = Pick<
  CsrdDmaIro,
  | 'iroType'
  | 'subTopic'
  | 'description'
  | 'valueChainStage'
  | 'timeHorizon'
  | 'impactOccurrence'
  | 'impactDirection'
  | 'impactScale'
  | 'impactScope'
  | 'impactIrremediability'
  | 'impactLikelihood'
  | 'financialLikelihood'
  | 'financialMagnitude'
  | 'humanRights'
  | 'affectedStakeholders'
  | 'relatedImpactIroId'
>;

const SCORE_FIELDS: Array<[keyof IroShapeInput, string]> = [
  ['impactScale', '規模'],
  ['impactScope', '範囲'],
  ['impactIrremediability', '回復困難性'],
  ['impactLikelihood', '発生可能性（インパクト）'],
  ['financialLikelihood', '発生可能性（財務）'],
  ['financialMagnitude', '財務影響の大きさ'],
];

const IMPACT_ONLY_FIELDS: Array<keyof IroShapeInput> = [
  'impactOccurrence',
  'impactDirection',
  'impactScale',
  'impactScope',
  'impactIrremediability',
  'impactLikelihood',
];

function isScore(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= DMA_SCORE_MIN &&
    value <= DMA_SCORE_MAX
  );
}

/**
 * IRO の入力の形を検査する。問題が無ければ空配列、あれば利用者に見せる理由を返す。
 *  - impact … 発生・方向・規模・範囲あり、財務 2 列なし。負 ⇔ 回復困難性あり、潜在 ⇔ 可能性あり
 *  - risk / opportunity … インパクト系 6 列なし・人権フラグなし、財務 2 列と期間あり
 *  - 関連するインパクト IRO はリスク・機会だけが持つ
 */
export function validateIroShape(input: IroShapeInput): string[] {
  const errors: string[] = [];
  if (!IRO_TYPES.includes(input.iroType)) errors.push('IRO の種類が正しくありません。');
  if (typeof input.description !== 'string' || input.description.trim() === '') {
    errors.push('IRO の内容（説明）を入力してください。');
  }
  if (!VALUE_CHAIN_STAGES.includes(input.valueChainStage)) {
    errors.push('段階（自社・上流・下流）を選んでください。');
  }
  if (input.timeHorizon !== null && !TIME_HORIZONS.includes(input.timeHorizon)) {
    errors.push('期間の値が正しくありません。');
  }
  for (const [field, label] of SCORE_FIELDS) {
    const value = input[field];
    if (value !== null && !isScore(value)) {
      errors.push(`${label}は ${DMA_SCORE_MIN}〜${DMA_SCORE_MAX} の整数で入力してください。`);
    }
  }

  if (input.iroType === 'impact') {
    if (input.impactOccurrence === null || !IMPACT_OCCURRENCES.includes(input.impactOccurrence)) {
      errors.push('インパクトは実在か潜在かを選んでください。');
    }
    if (input.impactDirection === null || !IMPACT_DIRECTIONS.includes(input.impactDirection)) {
      errors.push('インパクトは負か正かを選んでください。');
    }
    if (input.impactScale === null) errors.push('規模を入力してください。');
    if (input.impactScope === null) errors.push('範囲を入力してください。');
    if (input.impactDirection === 'negative' && input.impactIrremediability === null) {
      errors.push('負のインパクトは回復困難性を入力してください。');
    }
    if (input.impactDirection === 'positive' && input.impactIrremediability !== null) {
      errors.push('正のインパクトに回復困難性は入力しません。');
    }
    if (input.impactOccurrence === 'potential' && input.impactLikelihood === null) {
      errors.push('潜在のインパクトは発生可能性を入力してください。');
    }
    if (input.impactOccurrence === 'actual' && input.impactLikelihood !== null) {
      errors.push('実在のインパクトに発生可能性は入力しません。');
    }
    if (input.financialLikelihood !== null || input.financialMagnitude !== null) {
      errors.push('インパクトに財務の発生可能性・影響の大きさは入力しません。');
    }
    if (input.relatedImpactIroId !== null) {
      errors.push('関連するインパクト IRO は、リスク・機会にだけ設定できます。');
    }
  } else if (input.iroType === 'risk' || input.iroType === 'opportunity') {
    if (IMPACT_ONLY_FIELDS.some((field) => input[field] !== null)) {
      errors.push('リスク・機会にインパクトの項目（実在／潜在・負／正・規模など）は入力しません。');
    }
    if (input.humanRights) errors.push('人権フラグはインパクトにだけ付けます。');
    if (input.financialLikelihood === null) errors.push('発生可能性を入力してください。');
    if (input.financialMagnitude === null) errors.push('財務影響の大きさを入力してください。');
    if (input.timeHorizon === null) {
      errors.push('リスク・機会は期間（短期・中期・長期）を選んでください。');
    }
  }
  return errors;
}
