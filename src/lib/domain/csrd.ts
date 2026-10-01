/**
 * CSRD（ESRS サンプル）のダブル・マテリアリティと要求事項の適用（docs/disclosure-first.md §9.2）。
 *
 * 適用は保存しない。要求事項コード → 節 → 事項の人の判断（csrd_dma_matters）から毎回導出する
 * （保存すると、DMA を直したときに古い適用が残り、根拠と食い違う）。
 *
 * SSBJ（財務的重要性・シングル）の文言（「SSBJ」「一般／気候」）は使わない。
 * `server-only` を付けない純粋モジュール。サービス・画面・テストが同じ規則を使う。
 */

import type {
  CsrdApplicabilityKind,
  CsrdDmaMatter,
  CsrdSection,
  DataPoint,
  DisclosureItem,
  DmaAxisAssessment,
  DmaOutcome,
  DmaPerspective,
  EsrsTopic,
  SsbjGapKind,
} from '@/types/domain';

// ----------------------------------------------------------------------
// 表示ラベル
// ----------------------------------------------------------------------

export const ESRS_TOPIC_LABEL: Record<EsrsTopic, string> = {
  E1: '気候変動',
  E2: '汚染',
  E3: '水・海洋資源',
  E4: '生物多様性と生態系',
  E5: '資源利用と循環経済',
  S1: '自社の労働力',
  S2: 'バリューチェーンの労働者',
  S3: '影響を受けるコミュニティ',
  S4: '消費者・エンドユーザー',
  G1: '企業行動',
};

export const CSRD_SECTION_LABEL: Record<CsrdSection, string> = {
  ESRS2: 'ESRS 2 全般開示',
  E1: 'E1 気候変動',
  E2: 'E2 汚染',
  E3: 'E3 水・海洋資源',
  E4: 'E4 生物多様性と生態系',
  E5: 'E5 資源利用と循環経済',
  S1: 'S1 自社の労働力',
  S2: 'S2 バリューチェーンの労働者',
  S3: 'S3 影響を受けるコミュニティ',
  S4: 'S4 消費者・エンドユーザー',
  G1: 'G1 企業行動',
};

/** 1 つの軸の人の判断 */
export const DMA_AXIS_ASSESSMENT_LABEL: Record<DmaAxisAssessment, string> = {
  material: '重要',
  not_material: '重要でない',
  not_assessed: '未評価',
};

/** 事項の結果（2 軸から導出） */
export const DMA_OUTCOME_LABEL: Record<DmaOutcome, string> = {
  both: '両面で重要',
  impact_only: 'インパクトのみ',
  financial_only: '財務のみ',
  not_material: '重要でない',
  not_assessed: '未評価',
};

export const DMA_PERSPECTIVE_LABEL: Record<DmaPerspective, string> = {
  impact: 'インパクト',
  financial: '財務',
};

export const CSRD_APPLICABILITY_KIND_LABEL: Record<CsrdApplicabilityKind, string> = {
  always: 'ESRS 2（常に適用）',
  material: '適用',
  not_material: '対象外（重要でない）',
  undetermined: '未判定',
};

/** DMA が未確定（または確定後に変更あり）の間、テーマ別の適用に併記する */
export const CSRD_PROVISIONAL_LABEL = '暫定（DMA 確定前）';

/**
 * 開示ドラフトの本文の上限（字）。Demo Mode では本文の保存を Cookie（3 × 3,800B）で持ち回すため、
 * 1 件で Cookie 1 つ分を超えない大きさにする（docs/known-limitations.md D-3）
 */
export const CSRD_DRAFT_BODY_MAX = 3000;

/** 架空のサンプル・マスターであることの表示（正式な ESRS と見誤らせない） */
export const CSRD_SAMPLE_MASTER_LABEL = 'サンプル（架空）';

/** ギャップの観点が問いかけている内容（CSRD の文言。SSBJ の GAP_KIND_QUESTION は使わない） */
export const CSRD_GAP_KIND_QUESTION: Record<SsbjGapKind, string> = {
  disclosure: 'ESRS（サンプル）が求める情報が、現在の開示資料に記載されているか',
  data: '開示に必要な情報・数値を、社内で取得できているか',
  process: 'その情報を継続的かつ正確に収集・確認・承認できる仕組みがあるか',
};

/**
 * 画面の注記（CSRD 設定・要求事項）。条文番号は本フェーズで再確認していないため書かない。
 * 正式条文・正式らしい新 ID は作らない（マスターは既存の架空 12 項目のまま）
 */
export const CSRD_DOUBLE_MATERIALITY_NOTE =
  'ダブル・マテリアリティの考え方は 2023 年採択の ESRS（委任規則 (EU) 2023/2772）に基づく。' +
  '2026-07-03 採択の改正（簡素化）ESRS は官報掲載まで未発効で、本サンプルには反映していない。' +
  'ESRS-40a 公開草案はインパクト重要性のみ。';

/** ESRS は数値の閾値を定めていない。閾値・採点方法は会社が決めて開示する */
export const DMA_METHOD_NOTE =
  'ESRS は重要性の数値の閾値を定めていません。閾値と採点方法は会社が決めて開示するもので、' +
  'ここでは自社の評価方法（デモ既定）を使っています。算定結果は提案で、重要性は人が判断します。';

/** SSBJ（単一・財務）との違いの注記 */
export const SSBJ_VS_CSRD_MATERIALITY_NOTE =
  'SSBJ は財務的重要性（投資家の意思決定に影響する情報）だけで重要性を判断します（シングル）。' +
  'CSRD はインパクト（人・環境への影響）と財務（企業への影響）の 2 つの観点で判断し、' +
  'どちらかで重要なら要求事項が適用になります（ダブル・マテリアリティ）。';

// ----------------------------------------------------------------------
// 節・結果・適用
// ----------------------------------------------------------------------

const TOPIC_CODE = /^ESRS-(E[1-5]|S[1-4]|G1)-/;

/**
 * 要求事項コードから節を決める。`ESRS2-` → ESRS2、`ESRS-(E[1-5]|S[1-4]|G1)-` → その事項。
 * それ以外（存在しないテーマ・他基準のコード）は推測せず null（未判定）
 */
export function csrdSectionOfItem(item: Pick<DisclosureItem, 'code'>): CsrdSection | null {
  if (item.code.startsWith('ESRS2-')) return 'ESRS2';
  const match = TOPIC_CODE.exec(item.code);
  return match?.[1] ? (match[1] as EsrsTopic) : null;
}

/** 2 軸の人の判断から結果を導く。どちらかが未評価なら未評価 */
export function dmaOutcome(impact: DmaAxisAssessment, financial: DmaAxisAssessment): DmaOutcome {
  if (impact === 'not_assessed' || financial === 'not_assessed') return 'not_assessed';
  if (impact === 'material' && financial === 'material') return 'both';
  if (impact === 'material') return 'impact_only';
  if (financial === 'material') return 'financial_only';
  return 'not_material';
}

/** 結果から、適用になった観点 */
export function perspectivesOf(outcome: DmaOutcome): DmaPerspective[] {
  switch (outcome) {
    case 'both':
      return ['impact', 'financial'];
    case 'impact_only':
      return ['impact'];
    case 'financial_only':
      return ['financial'];
    default:
      return [];
  }
}

/** 草案・理由の文に使う「どの観点で重要と判断したか」 */
export function perspectiveSentence(perspectives: readonly DmaPerspective[]): string {
  const impact = perspectives.includes('impact');
  const financial = perspectives.includes('financial');
  if (impact && financial) return 'インパクトと財務の両面で重要と判断';
  if (impact) return 'インパクトの観点で重要と判断';
  if (financial) return '財務の観点で重要と判断';
  return '重要と判断した観点はありません';
}

export interface CsrdApplicability {
  kind: CsrdApplicabilityKind;
  /** 適用になった観点（material のときだけ。行ごとにバッジで示す） */
  perspectives: DmaPerspective[];
  /** DMA が未確定の間のテーマ別の適用（確定すると外れる）。ESRS 2 は常に false */
  provisional: boolean;
  /** 画面に出す理由 */
  reason: string;
}

/**
 * 要求事項の適用を導く（保存しない）。
 *  - ESRS2 → 常に適用（重要性に関わらず。DMA に左右されないため暫定にしない）
 *  - テーマ別 → 事項の結果から 適用（観点付き）／対象外（重要でない）／未判定
 *  - 節を判定できない → 未判定
 * DMA 全体が未確定の間は、テーマ別の適用を暫定とする
 */
export function deriveCsrdApplicability(
  section: CsrdSection | null,
  matter: Pick<CsrdDmaMatter, 'esrsTopic' | 'impactAssessment' | 'financialAssessment'> | null,
  dmaConfirmed: boolean,
): CsrdApplicability {
  if (section === null) {
    return {
      kind: 'undetermined',
      perspectives: [],
      provisional: false,
      reason: '要求事項コードから ESRS の節を判定できないため、適用を決められません。',
    };
  }
  if (section === 'ESRS2') {
    return {
      kind: 'always',
      perspectives: [],
      provisional: false,
      reason: '重要性に関わらず適用（ESRS 2 全般開示）',
    };
  }
  const topicName = `${section} ${ESRS_TOPIC_LABEL[section]}`;
  // 別のテーマの行を渡されても使わない（取り違えで適用にしない）
  const usable = matter && matter.esrsTopic === section ? matter : null;
  const outcome = usable
    ? dmaOutcome(usable.impactAssessment, usable.financialAssessment)
    : 'not_assessed';
  const provisional = !dmaConfirmed;
  if (outcome === 'not_assessed') {
    return {
      kind: 'undetermined',
      perspectives: [],
      provisional,
      reason: `${topicName}の重要性が未評価です（ダブル・マテリアリティ評価で判断してください）。`,
    };
  }
  if (outcome === 'not_material') {
    return {
      kind: 'not_material',
      perspectives: [],
      provisional,
      reason: `${topicName}: インパクト・財務のどちらでも重要でないと判断（対象外）`,
    };
  }
  const perspectives = perspectivesOf(outcome);
  return {
    kind: 'material',
    perspectives,
    provisional,
    reason: `${topicName}: ${perspectiveSentence(perspectives)}`,
  };
}

/** 評価対象か（常に適用・重要）。対象外・未判定は対応状況の集計に入れない */
export function isCsrdInScope(applicability: Pick<CsrdApplicability, 'kind'>): boolean {
  return applicability.kind === 'always' || applicability.kind === 'material';
}

/** 適用の表示（例: 「適用（インパクト・財務）」「ESRS 2（常に適用）」） */
export function applicabilityLabel(
  applicability: Pick<CsrdApplicability, 'kind' | 'perspectives'>,
): string {
  if (applicability.kind !== 'material') {
    return CSRD_APPLICABILITY_KIND_LABEL[applicability.kind];
  }
  const names = applicability.perspectives.map((p) => DMA_PERSPECTIVE_LABEL[p]).join('・');
  return names === '' ? '適用' : `適用（${names}）`;
}

// ----------------------------------------------------------------------
// データ収集の状況（承認済み／レビュー中／提出待ち／未入力）
// ----------------------------------------------------------------------

export const CSRD_DATA_STATES = [
  'approved',
  'in_review',
  'awaiting_submission',
  'not_entered',
] as const;
export type CsrdDataState = (typeof CSRD_DATA_STATES)[number];

export const CSRD_DATA_STATE_LABEL: Record<CsrdDataState, string> = {
  approved: '承認済み',
  in_review: 'レビュー中',
  awaiting_submission: '提出待ち',
  not_entered: '未入力',
};

/**
 * 当期の Data Point の状況。行が無い・値も文字も無い下書きは「未入力」（0 として扱わない）。
 * 値を表示してよいのは承認済みだけ（呼び出し側が value を承認済みのときだけ使う）
 */
export function csrdDataStateOf(
  dp: Pick<DataPoint, 'status' | 'value' | 'textValue'> | null | undefined,
): CsrdDataState {
  if (!dp) return 'not_entered';
  if (dp.status === 'approved') return 'approved';
  if (dp.status === 'submitted' || dp.status === 'in_review') return 'in_review';
  if (dp.value === null && (dp.textValue ?? '') === '') return 'not_entered';
  return 'awaiting_submission';
}
