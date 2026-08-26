/**
 * SSBJ ギャップ分析のドメイン規則（画面表示の日本語ラベルと優先度の計算）。
 *
 * `server-only` を付けない純粋モジュールにしてあるのは、サーバー側のサービスと
 * テストの両方から同じ判定を使うため。優先度は保存せずここで毎回計算する
 * （保存すると、対応状況を更新したときに古い優先度が残って根拠と食い違う）。
 *
 * 画面に出す文言はすべて日本語にする。SSBJ のような一般に定着した略称だけを残す。
 */

import type {
  SsbjActionStatus,
  SsbjActionType,
  SsbjApplicability,
  SsbjCoverageStatus,
  SsbjGapKind,
  SsbjMateriality,
  SsbjPriority,
} from '@/types/domain';

// ----------------------------------------------------------------------
// 表示ラベル
// ----------------------------------------------------------------------

export const COVERAGE_LABEL: Record<SsbjCoverageStatus, string> = {
  covered: '対応済み',
  mostly_covered: 'おおむね対応',
  partial: '一部対応',
  not_covered: '未対応',
  unconfirmed: '未確認',
};

export const COVERAGE_TONE: Record<
  SsbjCoverageStatus,
  'success' | 'brand' | 'warning' | 'danger' | 'neutral'
> = {
  covered: 'success',
  mostly_covered: 'brand',
  partial: 'warning',
  not_covered: 'danger',
  unconfirmed: 'neutral',
};

export const GAP_KIND_LABEL: Record<SsbjGapKind, string> = {
  disclosure: '開示',
  data: 'データ',
  process: '業務プロセス・内部統制',
};

/** ギャップの種類が問いかけている内容（画面で説明として出す） */
export const GAP_KIND_QUESTION: Record<SsbjGapKind, string> = {
  disclosure: 'SSBJ が求める情報が、現在の開示資料に記載されているか',
  data: '開示に必要な情報・数値を、社内で取得できているか',
  process: 'その情報を継続的かつ正確に収集・確認・承認できる仕組みがあるか',
};

export const APPLICABILITY_LABEL: Record<SsbjApplicability, string> = {
  applicable: '対象',
  not_applicable: '対象外',
};

export const MATERIALITY_LABEL: Record<SsbjMateriality, string> = {
  material: '重要性あり',
  not_material: '重要性なし',
  not_assessed: '未判定',
};

export const PRIORITY_LABEL: Record<SsbjPriority, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

/** 優先度が何を意味するか（画面の凡例に出す） */
export const PRIORITY_MEANING: Record<SsbjPriority, string> = {
  high: '初年度対応を優先する項目',
  medium: '重要だが段階的な対応が可能な項目',
  low: '中長期的な高度化項目',
};

export const ACTION_TYPE_LABEL: Record<SsbjActionType, string> = {
  data_collection: 'データ収集',
  disclosure_addition: '開示内容追加',
  governance: 'ガバナンス整備',
  policy: '方針・規程整備',
  internal_control: '内部統制整備',
  system: 'システム整備',
  calculation_method: '算定方法整備',
};

export const ACTION_STATUS_LABEL: Record<SsbjActionStatus, string> = {
  not_started: '未着手',
  in_progress: '対応中',
  in_review: '確認中',
  done: '完了',
};

export const ACTION_STATUS_TONE: Record<
  SsbjActionStatus,
  'neutral' | 'brand' | 'warning' | 'success'
> = {
  not_started: 'neutral',
  in_progress: 'brand',
  in_review: 'warning',
  done: 'success',
};

// ----------------------------------------------------------------------
// 4 領域（ガバナンス／戦略／リスク管理／指標及び目標）
// ----------------------------------------------------------------------

export const SSBJ_AREAS = ['governance', 'strategy', 'risk', 'metrics', 'other'] as const;
export type SsbjArea = (typeof SSBJ_AREAS)[number];

export const AREA_LABEL: Record<SsbjArea, string> = {
  governance: 'ガバナンス',
  strategy: '戦略',
  risk: 'リスク管理',
  metrics: '指標及び目標',
  other: 'その他',
};

/**
 * 要求事項の区分（「一般：ガバナンス」「気候：指標及び目標」）から 4 領域へ寄せる。
 * SSBJ のコア・コンテンツは一般開示基準と気候関連開示基準で同じ 4 構成要素を持つため、
 * 基準をまたいで同じ領域として集計できる。
 */
export function areaOfSection(section: string): SsbjArea {
  if (section.includes('ガバナンス')) return 'governance';
  if (section.includes('戦略')) return 'strategy';
  if (section.includes('リスク管理')) return 'risk';
  if (section.includes('指標') || section.includes('目標')) return 'metrics';
  return 'other';
}

// ----------------------------------------------------------------------
// 優先順位の評価
// ----------------------------------------------------------------------

/** 対応状況を「ギャップの深さ」の点数へ寄せる（対応済みほど小さい） */
function gapDepth(status: SsbjCoverageStatus): number {
  switch (status) {
    case 'covered':
      return 0;
    case 'mostly_covered':
      return 1;
    case 'partial':
      return 2;
    case 'not_covered':
      return 3;
    case 'unconfirmed':
      // 未確認は「対応できていない」とも「できている」とも言えない。
      // 放置されると最後まで残るため、一部対応と同じ重さで扱う
      return 2;
  }
}

export interface PriorityFactor {
  /** 評価項目名 */
  label: string;
  /** 判定結果（画面に出す短い日本語） */
  judgement: string;
  /** 加点 */
  score: number;
  /** なぜそう判定したか */
  note: string;
}

export interface PriorityInput {
  /** SSBJ 上「開示しなければならない」と定められている項目か */
  required: boolean;
  materiality: SsbjMateriality;
  disclosureStatus: SsbjCoverageStatus;
  dataStatus: SsbjCoverageStatus;
  processStatus: SsbjCoverageStatus;
  /** 第三者保証の対象指標に関係するか */
  assuranceRelevant: boolean;
  /** 報告期限までの残り日数（null = 期限未設定） */
  daysToDeadline: number | null;
}

export interface PriorityResult {
  priority: SsbjPriority;
  score: number;
  factors: PriorityFactor[];
}

/** 優先度の境界。点数がこれ以上なら該当の優先度になる */
const HIGH_THRESHOLD = 7;
const MEDIUM_THRESHOLD = 4;

/**
 * 優先順位を評価する。
 *
 * 「重要性が高く、ギャップが深く、保証に響き、期限が近い」ものほど先に着手する。
 * 何をどう評価したかを factors で返すので、画面でそのまま根拠として示せる
 * （AI に順位を決めさせない。監査法人へ説明できる必要があるため）。
 */
export function evaluatePriority(input: PriorityInput): PriorityResult {
  const factors: PriorityFactor[] = [];

  // 制度上の重要性
  const regulatory = input.required ? 2 : 1;
  factors.push({
    label: '制度上の重要性',
    judgement: input.required ? '開示が求められる項目' : '状況により開示する項目',
    score: regulatory,
    note: input.required
      ? 'SSBJ が「開示しなければならない」と定めている項目です。'
      : '条件に該当する場合に開示する項目です。',
  });

  // 企業にとっての重要性
  const companyScore =
    input.materiality === 'material' ? 2 : input.materiality === 'not_material' ? 0 : 1;
  factors.push({
    label: '企業にとっての重要性',
    judgement: MATERIALITY_LABEL[input.materiality],
    score: companyScore,
    note:
      input.materiality === 'material'
        ? '自社にとって重要と判断された項目です。'
        : input.materiality === 'not_material'
          ? '重要性なしと判断されているため、優先度を下げています。'
          : '重要性が未判定です。判定後に優先度が変わります。',
  });

  // 現在のギャップの深さ（3 観点のうち最も深いものを採る）
  const depths = [
    { kind: '開示', value: gapDepth(input.disclosureStatus), status: input.disclosureStatus },
    { kind: 'データ', value: gapDepth(input.dataStatus), status: input.dataStatus },
    {
      kind: '業務プロセス・内部統制',
      value: gapDepth(input.processStatus),
      status: input.processStatus,
    },
  ];
  const deepest = depths.reduce((a, b) => (b.value > a.value ? b : a));
  factors.push({
    label: 'ギャップの深さ',
    judgement: `${deepest.kind}が${COVERAGE_LABEL[deepest.status]}`,
    score: deepest.value,
    note: '開示・データ・業務プロセスのうち、最も対応が遅れている観点で評価しています。',
  });

  // データの有無（対応に必要な工数の代理指標）
  const dataMissing = input.dataStatus === 'not_covered';
  factors.push({
    label: 'データの有無と対応工数',
    judgement: dataMissing ? 'データが未取得（工数：大）' : 'データは取得済みまたは一部取得',
    score: dataMissing ? 1 : 0,
    note: dataMissing
      ? '数値そのものが社内に無いため、収集の仕組みづくりから必要です。着手を早める必要があります。'
      : '既存のデータを活用できるため、対応の負荷は相対的に軽くなります。',
  });

  // 第三者保証への影響
  factors.push({
    label: '第三者保証への影響',
    judgement: input.assuranceRelevant ? '保証対象に関係する' : '直接の関係は小さい',
    score: input.assuranceRelevant ? 1 : 0,
    note: input.assuranceRelevant
      ? '保証手続の対象となる指標に関係するため、証跡と承認履歴の整備が必要です。'
      : '現時点で保証手続の直接の対象ではありません。',
  });

  // 対応期限
  const urgent = input.daysToDeadline !== null && input.daysToDeadline <= 90;
  factors.push({
    label: '対応期限',
    judgement:
      input.daysToDeadline === null
        ? '期限未設定'
        : urgent
          ? `残り ${input.daysToDeadline} 日`
          : `残り ${input.daysToDeadline} 日（余裕あり）`,
    score: urgent ? 1 : 0,
    note: urgent ? '報告期限まで 90 日を切っています。' : '報告期限までに一定の余裕があります。',
  });

  const score = factors.reduce((sum, f) => sum + f.score, 0);
  const priority: SsbjPriority =
    score >= HIGH_THRESHOLD ? 'high' : score >= MEDIUM_THRESHOLD ? 'medium' : 'low';

  return { priority, score, factors };
}

/**
 * 3 観点をまとめた「その要求事項の対応状況」。
 * 最も遅れている観点に合わせる（開示だけできていても、データが無ければ継続できない）。
 */
export function combineCoverage(
  disclosure: SsbjCoverageStatus,
  data: SsbjCoverageStatus,
  process: SsbjCoverageStatus,
): SsbjCoverageStatus {
  const all = [disclosure, data, process];
  if (all.includes('not_covered')) return 'not_covered';
  if (all.includes('unconfirmed')) return 'unconfirmed';
  if (all.includes('partial')) return 'partial';
  if (all.includes('mostly_covered')) return 'mostly_covered';
  return 'covered';
}

/**
 * 対応度（%）。対応済みを 100、おおむね対応を 75、一部対応を 40、未対応・未確認を 0 として平均する。
 * 単純な「対応済み件数 ÷ 件数」だと、一部対応が積み上がっている状態が見えないため。
 */
const COVERAGE_WEIGHT: Record<SsbjCoverageStatus, number> = {
  covered: 100,
  mostly_covered: 75,
  partial: 40,
  not_covered: 0,
  unconfirmed: 0,
};

export function coverageRate(statuses: SsbjCoverageStatus[]): number {
  if (statuses.length === 0) return 0;
  const total = statuses.reduce((sum, s) => sum + COVERAGE_WEIGHT[s], 0);
  return Math.round(total / statuses.length);
}
