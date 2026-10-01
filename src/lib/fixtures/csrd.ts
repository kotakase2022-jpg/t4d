/**
 * CSRD（ESRS サンプル）のダブル・マテリアリティと要求事項の評価の Fixture（すべて架空。
 * docs/disclosure-first.md §9.3）。
 *
 * 主役の架空企業（青海テクノロジー）の FY2026 に、次の状態を置く。FY2025 は行を置かない
 * （画面は既定値の仮想行＝未評価として表示し、最初の保存で行を作る）。
 *  - 分析条件: 連結＝財務と同じ、バリューチェーン＝上流・下流、閾値 3.0／3.0、DMA 未確定
 *  - DMA: 10 事項それぞれにインパクト IRO 1 件とリスク・機会 1 件（スコアは §9.2 の式で再計算できる値）。
 *    G1 だけ人の判断が未評価（E2E が「財務のみ」に判断する）
 *  - 要求事項の評価 12 行（表示時に行を作らない。SSBJ の一括作成の問題を持ち込まない）
 *  - 対応計画 2 件（E1-4 開示・対応中、S1-9 データ・未着手で女性管理職比率の収集項目あり）
 *  - 開示ドラフト: ESRS 2 は人が書いた本文を保存済み（未確定）、S1 は AI 草案のみ（本文未採用）。
 *    節の確定は DMA の確定後にしかできない（confirmCsrdDraft）ため、DMA 未確定の Fixture では
 *    どの節も確定済みにしない（画面の操作で作れない状態を置かない）
 *
 * 作成者・判断者は 海野 みどり（本社サステナビリティ担当）。監査ログの行は作らない
 * （既存の監査ログ一覧・件数の表示を変えないため。disclosure-first.ts と同じ方針）。
 *
 * 時系列（基準日 FIXTURE_TODAY から何日前か）
 *   分析条件 30 → IRO 登録 26 → 事項の判断 22 → AI ギャップ分析 16 → 人の確認 14
 *   → 対応計画 12 → S1 の AI 草案 10 → ESRS 2 の本文の保存 8
 */

import { csrdRowIds } from '@/lib/domain/csrd-ids';
import { CSRD_ITEM_SPECS, ORG_IDS, PERIOD_IDS, UNIT_IDS, at, metricId, userId } from './dataset';
import { fid } from './ids';
import type { FixtureDb } from './store';
import type {
  CsrdActionPlan,
  CsrdAssessment,
  CsrdDmaIro,
  CsrdDmaMatter,
  DmaAxisAssessment,
  EsrsTopic,
  ImpactOccurrence,
  IroType,
  SsbjCoverageStatus,
  TimeHorizon,
  Uuid,
  ValueChainStage,
} from '@/types/domain';

const ORG = ORG_IDS.aomi;
const PERIOD = PERIOD_IDS.fy2026;
/** 海野 みどり（本社サステナビリティ担当）: 分析条件・IRO・判断・評価・計画・本文の作成者 */
const AUTHOR = userId('sustainability@demo.local');

function audit(created: string, updated = created, by: Uuid | null = AUTHOR) {
  return { createdAt: created, updatedAt: updated, createdBy: by, updatedBy: by };
}

function itemId(code: string): Uuid {
  return fid('disclosure_item', `csrd/2026/${code}`);
}

// ----------------------------------------------------------------------
// DMA（§9.3 の表）
// ----------------------------------------------------------------------

interface ImpactSpec {
  occurrence: ImpactOccurrence;
  stage: ValueChainStage;
  description: string;
  subTopic: string;
  scale: number;
  scope: number;
  irremediability: number;
  /** 潜在のときだけ */
  likelihood: number | null;
  humanRights: boolean;
  stakeholders: string;
}

interface FinancialSpec {
  type: Extract<IroType, 'risk' | 'opportunity'>;
  horizon: TimeHorizon;
  stage: ValueChainStage;
  description: string;
  likelihood: number;
  magnitude: number;
}

interface MatterSpec {
  topic: EsrsTopic;
  impact: ImpactSpec;
  financial: FinancialSpec;
  impactAssessment: DmaAxisAssessment;
  financialAssessment: DmaAxisAssessment;
  impactRationale: string;
  financialRationale: string;
  stakeholderNote: string;
}

/**
 * 10 事項。スコアは §9.2 の式（深刻度は丸めずに掛け、結果を小数 1 桁に丸める）で再計算できる。
 * すべて負のインパクト（正のインパクトの例は単体テストで扱う）
 */
const MATTER_SPECS: MatterSpec[] = [
  {
    topic: 'E1',
    impact: {
      occurrence: 'actual',
      stage: 'own_operations',
      description: '製造拠点の GHG 排出（架空）',
      subTopic: '気候変動の緩和',
      scale: 4,
      scope: 4,
      irremediability: 4,
      likelihood: null,
      humanRights: false,
      stakeholders: '地域社会・将来世代',
    },
    financial: {
      type: 'risk',
      horizon: 'medium',
      stage: 'own_operations',
      description: '炭素価格の導入・上昇による操業コストの増加（架空）',
      likelihood: 4,
      magnitude: 4,
    },
    impactAssessment: 'material',
    financialAssessment: 'material',
    impactRationale:
      '製造拠点の排出は継続的に生じており、算定結果 4.0 が閾値 3.0 以上のため重要と判断（架空）',
    financialRationale:
      '炭素価格の算定結果 4.0 が閾値以上で、中期に操業コストへ影響するため重要と判断（架空）',
    stakeholderNote: '主要サプライヤー・顧客への聞き取りで、排出削減への期待が大きかった（架空）',
  },
  {
    topic: 'E2',
    impact: {
      occurrence: 'potential',
      stage: 'upstream',
      description: '部材の化学物質流出（架空）',
      subTopic: '水質・土壌の汚染',
      scale: 3,
      scope: 2,
      irremediability: 3,
      likelihood: 2,
      humanRights: false,
      stakeholders: '調達先の周辺住民',
    },
    financial: {
      type: 'risk',
      horizon: 'short',
      stage: 'upstream',
      description: '化学物質規制への対応コスト（架空）',
      likelihood: 2,
      magnitude: 2,
    },
    impactAssessment: 'not_material',
    financialAssessment: 'not_material',
    impactRationale:
      '算定結果 2.3 で閾値未満。調達先の管理体制から流出の可能性は低いと判断（架空）',
    financialRationale: '算定結果 2.0 で閾値未満。対応コストは軽微と判断（架空）',
    stakeholderNote: '',
  },
  {
    topic: 'E3',
    impact: {
      occurrence: 'actual',
      stage: 'own_operations',
      description: '水ストレス地域の取水（架空）',
      subTopic: '水',
      scale: 3,
      scope: 3,
      irremediability: 4,
      likelihood: null,
      humanRights: false,
      stakeholders: '流域の住民・農業者',
    },
    financial: {
      type: 'risk',
      horizon: 'medium',
      stage: 'own_operations',
      description: '渇水時の操業制限（架空）',
      likelihood: 2,
      magnitude: 3,
    },
    impactAssessment: 'material',
    financialAssessment: 'not_material',
    impactRationale:
      '水ストレス地域での取水が実在し、算定結果 3.3 が閾値以上のため重要と判断（架空）',
    financialRationale: '操業制限の算定結果 2.4 で閾値未満。代替の給水手段があると判断（架空）',
    stakeholderNote: '',
  },
  {
    topic: 'E4',
    impact: {
      occurrence: 'potential',
      stage: 'upstream',
      description: '原材料の調達地での土地利用の変化（架空）',
      subTopic: '生態系の状態',
      scale: 2,
      scope: 2,
      irremediability: 3,
      likelihood: 2,
      humanRights: false,
      stakeholders: '調達地の地域社会',
    },
    financial: {
      type: 'risk',
      horizon: 'long',
      stage: 'upstream',
      description: '生態系への配慮を求める調達要件の強化（架空）',
      likelihood: 1,
      magnitude: 3,
    },
    impactAssessment: 'not_material',
    financialAssessment: 'not_material',
    impactRationale: '算定結果 2.2 で閾値未満。該当する調達地は限られると判断（架空）',
    financialRationale: '算定結果 1.7 で閾値未満（架空）',
    stakeholderNote: '',
  },
  {
    topic: 'E5',
    impact: {
      occurrence: 'actual',
      stage: 'own_operations',
      description: '製造工程の廃棄物（架空）',
      subTopic: '廃棄物',
      scale: 2,
      scope: 2,
      irremediability: 2,
      likelihood: null,
      humanRights: false,
      stakeholders: '処理施設の周辺住民',
    },
    financial: {
      type: 'opportunity',
      horizon: 'medium',
      stage: 'upstream',
      description: '再生材の活用による調達コストの低減（架空）',
      likelihood: 2,
      magnitude: 2,
    },
    impactAssessment: 'not_material',
    financialAssessment: 'not_material',
    impactRationale: '算定結果 2.0 で閾値未満。廃棄物の大半は再資源化していると判断（架空）',
    financialRationale: '機会の算定結果 2.0 で閾値未満（架空）',
    stakeholderNote: '',
  },
  {
    topic: 'S1',
    impact: {
      occurrence: 'potential',
      stage: 'own_operations',
      description: '長時間労働による健康への影響（架空）',
      subTopic: '労働条件',
      scale: 4,
      scope: 3,
      irremediability: 3,
      likelihood: 3,
      humanRights: true,
      stakeholders: '従業員',
    },
    financial: {
      type: 'risk',
      horizon: 'medium',
      stage: 'own_operations',
      description: '人材確保難による操業への影響（架空）',
      likelihood: 4,
      magnitude: 3,
    },
    impactAssessment: 'material',
    financialAssessment: 'material',
    impactRationale:
      '人権に関わる潜在的なインパクトで、深刻度 3.3 を可能性より優先して重要と判断（架空）',
    financialRationale: '人材確保難の算定結果 3.5 が閾値以上のため重要と判断（架空）',
    stakeholderNote: '従業員への聞き取りで、労働時間への懸念が挙がった（架空）',
  },
  {
    topic: 'S2',
    impact: {
      occurrence: 'potential',
      stage: 'upstream',
      description: '調達先での強制労働（架空）',
      subTopic: '労働条件・人権',
      scale: 5,
      scope: 3,
      irremediability: 5,
      likelihood: 2,
      humanRights: true,
      stakeholders: '調達先の労働者',
    },
    financial: {
      type: 'risk',
      horizon: 'short',
      stage: 'upstream',
      description: '取引停止・調達先切替のコスト（架空）',
      likelihood: 2,
      magnitude: 2,
    },
    impactAssessment: 'material',
    financialAssessment: 'not_material',
    impactRationale: '人権に関わる潜在的なインパクトで、深刻度 4.3 のため重要と判断（架空）',
    financialRationale: '調達先切替のコストの算定結果 2.0 で閾値未満（架空）',
    stakeholderNote: '',
  },
  {
    topic: 'S3',
    impact: {
      occurrence: 'potential',
      stage: 'own_operations',
      description: '拠点周辺の騒音（架空）',
      subTopic: '地域社会への影響',
      scale: 2,
      scope: 1,
      irremediability: 1,
      likelihood: 2,
      humanRights: false,
      stakeholders: '拠点の近隣住民',
    },
    financial: {
      type: 'risk',
      horizon: 'short',
      stage: 'own_operations',
      description: '近隣対応のコスト（架空）',
      likelihood: 1,
      magnitude: 2,
    },
    impactAssessment: 'not_material',
    financialAssessment: 'not_material',
    impactRationale: '算定結果 1.6 で閾値未満（架空）',
    financialRationale: '算定結果 1.4 で閾値未満（架空）',
    stakeholderNote: '',
  },
  {
    topic: 'S4',
    impact: {
      occurrence: 'potential',
      stage: 'downstream',
      description: '製品不具合による利用者への影響（架空）',
      subTopic: '製品の安全性',
      scale: 4,
      scope: 2,
      irremediability: 3,
      likelihood: 1,
      humanRights: false,
      stakeholders: '製品の利用者',
    },
    financial: {
      type: 'risk',
      horizon: 'medium',
      stage: 'downstream',
      description: 'リコール費用（架空）',
      likelihood: 2,
      magnitude: 5,
    },
    impactAssessment: 'not_material',
    financialAssessment: 'material',
    impactRationale: '算定結果 1.7 で閾値未満。品質管理で発生の可能性は低いと判断（架空）',
    financialRationale: 'リコール費用の算定結果 3.2 が閾値以上のため重要と判断（架空）',
    stakeholderNote: '',
  },
  {
    topic: 'G1',
    impact: {
      occurrence: 'potential',
      stage: 'own_operations',
      description: '贈収賄への関与（架空）',
      subTopic: '腐敗・贈収賄',
      scale: 3,
      scope: 2,
      irremediability: 2,
      likelihood: 2,
      humanRights: false,
      stakeholders: '取引先・社会',
    },
    financial: {
      type: 'risk',
      horizon: 'medium',
      stage: 'own_operations',
      description: '制裁金（架空）',
      likelihood: 2,
      magnitude: 5,
    },
    // 未評価のまま置く（E2E が「インパクト=重要でない・財務=重要」に判断する）
    impactAssessment: 'not_assessed',
    financialAssessment: 'not_assessed',
    impactRationale: '',
    financialRationale: '',
    stakeholderNote: '',
  },
];

function iroIds(topic: EsrsTopic): { impact: Uuid; financial: Uuid } {
  return {
    impact: fid('csrd_dma_iro', `${ORG}/${PERIOD}/${topic}/impact`),
    financial: fid('csrd_dma_iro', `${ORG}/${PERIOD}/${topic}/financial`),
  };
}

// ----------------------------------------------------------------------
// 要求事項の評価（§9.3 の表）
// ----------------------------------------------------------------------

interface AssessmentSpec {
  code: string;
  department: string;
  /** 人が入れた 3 観点（開示・データ・業務プロセス）。null は未入力（未確認） */
  human: [SsbjCoverageStatus, SsbjCoverageStatus, SsbjCoverageStatus] | null;
  /** AI の候補の 3 観点 */
  ai: [SsbjCoverageStatus, SsbjCoverageStatus, SsbjCoverageStatus] | null;
  /** 人が確定したか（human が要る） */
  reviewed: boolean;
}

const ASSESSMENT_SPECS: AssessmentSpec[] = [
  {
    code: 'ESRS2-GOV-1',
    department: '経営企画部',
    human: ['mostly_covered', 'covered', 'mostly_covered'],
    ai: ['mostly_covered', 'covered', 'mostly_covered'],
    reviewed: true,
  },
  {
    code: 'ESRS2-SBM-3',
    department: 'サステナビリティ推進部',
    human: null,
    ai: ['partial', 'partial', 'partial'],
    reviewed: false,
  },
  {
    code: 'ESRS-E1-1',
    department: 'サステナビリティ推進部',
    human: ['partial', 'not_covered', 'partial'],
    ai: null,
    reviewed: true,
  },
  {
    code: 'ESRS-E1-4',
    department: 'サステナビリティ推進部',
    human: null,
    ai: ['not_covered', 'not_covered', 'partial'],
    reviewed: false,
  },
  {
    code: 'ESRS-E1-5',
    department: 'サステナビリティ推進部',
    human: ['mostly_covered', 'covered', 'mostly_covered'],
    ai: null,
    reviewed: true,
  },
  {
    code: 'ESRS-E1-6',
    department: 'サステナビリティ推進部',
    human: null,
    ai: null,
    reviewed: false,
  },
  { code: 'ESRS-E3-4', department: '生産本部', human: null, ai: null, reviewed: false },
  { code: 'ESRS-E5-5', department: '生産本部', human: null, ai: null, reviewed: false },
  {
    code: 'ESRS-S1-6',
    department: '人事部',
    human: ['covered', 'covered', 'mostly_covered'],
    ai: null,
    reviewed: true,
  },
  {
    code: 'ESRS-S1-9',
    department: '人事部',
    human: null,
    ai: ['partial', 'partial', 'partial'],
    reviewed: false,
  },
  { code: 'ESRS-G1-1', department: '法務部', human: null, ai: null, reviewed: false },
  { code: 'ESRS-G1-4', department: '法務部', human: null, ai: null, reviewed: false },
];

/** AI の候補の文面（デモ生成）。不足情報は要求事項ごとに架空の内容を置く */
const AI_TEXT: Record<string, { comment: string; missing: string[]; recommendation: string }> = {
  'ESRS2-GOV-1': {
    comment:
      '取締役会の監督体制と担当役員の記載があり、おおむね対応していると判断しました（デモ生成）。',
    missing: ['監督機関の構成員のサステナビリティに関する専門性の説明（架空）'],
    recommendation: '構成員の専門性と研修の状況を追記してください（デモ生成）。',
  },
  'ESRS2-SBM-3': {
    comment:
      '重要な IRO の一覧はあるものの、戦略・ビジネスモデルとの相互作用の説明が一部にとどまります（デモ生成）。',
    missing: [
      '重要な IRO が戦略・意思決定に与える影響の説明（架空）',
      'DMA の確定結果との整合（架空）',
    ],
    recommendation:
      'DMA を確定したうえで、重要な事項ごとに戦略への影響を記載してください（デモ生成）。',
  },
  'ESRS-E1-4': {
    comment: 'GHG 削減目標の基準年・目標年・対象範囲の記載が確認できません（デモ生成）。',
    missing: ['削減目標の基準年と目標年（架空）', '移行計画との整合（架空）'],
    recommendation: '移行計画と整合した削減目標を設定し、対象範囲を明記してください（デモ生成）。',
  },
  'ESRS-S1-9': {
    comment: '本社の女性管理職比率はあるものの、EU・JV 拠点の値が集まっていません（デモ生成）。',
    missing: ['EU 子会社・JV 拠点の女性管理職比率（架空）'],
    recommendation: 'EU・JV 拠点の値を収集する対応計画を立ててください（デモ生成）。',
  },
};

function combine(
  statuses: [SsbjCoverageStatus, SsbjCoverageStatus, SsbjCoverageStatus],
): SsbjCoverageStatus {
  if (statuses.includes('not_covered')) return 'not_covered';
  if (statuses.includes('unconfirmed')) return 'unconfirmed';
  if (statuses.includes('partial')) return 'partial';
  if (statuses.includes('mostly_covered')) return 'mostly_covered';
  return 'covered';
}

// ----------------------------------------------------------------------
// ID（E2E・テストからも同じ値で引けるように公開する）
// ----------------------------------------------------------------------

export const CSRD_IDS = {
  period: PERIOD,
  settings: csrdRowIds.settings(ORG, PERIOD),
  matters: Object.fromEntries(
    MATTER_SPECS.map((spec) => [spec.topic, csrdRowIds.matter(ORG, PERIOD, spec.topic)]),
  ) as Record<EsrsTopic, Uuid>,
  iros: Object.fromEntries(MATTER_SPECS.map((spec) => [spec.topic, iroIds(spec.topic)])) as Record<
    EsrsTopic,
    { impact: Uuid; financial: Uuid }
  >,
  items: Object.fromEntries(
    CSRD_ITEM_SPECS.map((spec) => [spec.code, itemId(spec.code)]),
  ) as Record<string, Uuid>,
  assessments: Object.fromEntries(
    CSRD_ITEM_SPECS.map((spec) => [spec.code, csrdRowIds.assessment(ORG, PERIOD, spec.code)]),
  ) as Record<string, Uuid>,
  plans: {
    e1Target: fid('csrd_action_plan', `${ORG}/${PERIOD}/ESRS-E1-4/disclosure`),
    s1FemaleManagers: fid('csrd_action_plan', `${ORG}/${PERIOD}/ESRS-S1-9/data`),
  },
  drafts: {
    esrs2: csrdRowIds.draft(ORG, PERIOD, 'ESRS2'),
    s1: csrdRowIds.draft(ORG, PERIOD, 'S1'),
  },
} as const;

/** S1-9 の対応計画から作った収集項目の拠点（EU 子会社・JV） */
export const CSRD_COLLECTION_UNIT_IDS = [UNIT_IDS.eu, UNIT_IDS.jv] as const;

// ----------------------------------------------------------------------
// 投入
// ----------------------------------------------------------------------

export function seedCsrd(db: FixtureDb): void {
  seedSettings(db);
  seedDma(db);
  seedAssessments(db);
  seedPlans(db);
  seedDrafts(db);
}

function seedSettings(db: FixtureDb): void {
  db.csrdAnalysisSettings.push({
    id: CSRD_IDS.settings,
    organizationId: ORG,
    reportingPeriodId: PERIOD,
    consolidationScope: 'same_as_financial',
    consolidationNote: '',
    includedUnitIds: [],
    valueChainScope: 'both',
    valueChainNote: '一次サプライヤーと主要な販売先までを報告の範囲に含める（架空）',
    scoringMethod: 'dma-demo-v1',
    impactThreshold: 3.0,
    financialThreshold: 3.0,
    methodNote:
      'IRO ごとに 1〜5 の段階で評価し、インパクトは深刻度と発生可能性、リスク・機会は発生可能性と財務影響の大きさから算定した。閾値は 3.0（自社の評価方法・デモ既定。架空）',
    stakeholderEngagementNote: '従業員・主要サプライヤー・顧客への聞き取り（架空）',
    // DMA は未確定のまま置く（E2E が G1 を判断してから確定する）
    dmaConfirmedAt: null,
    dmaConfirmedBy: null,
    ...audit(at(30)),
  });
}

function seedDma(db: FixtureDb): void {
  for (const spec of MATTER_SPECS) {
    const matterId = CSRD_IDS.matters[spec.topic];
    const decided =
      spec.impactAssessment !== 'not_assessed' || spec.financialAssessment !== 'not_assessed';
    const matter: CsrdDmaMatter = {
      id: matterId,
      organizationId: ORG,
      reportingPeriodId: PERIOD,
      esrsTopic: spec.topic,
      impactAssessment: spec.impactAssessment,
      financialAssessment: spec.financialAssessment,
      impactRationale: spec.impactRationale,
      financialRationale: spec.financialRationale,
      stakeholderNote: spec.stakeholderNote,
      decidedAt: decided ? at(22) : null,
      decidedBy: decided ? AUTHOR : null,
      ...audit(at(30), decided ? at(22) : at(30)),
    };
    db.csrdDmaMatters.push(matter);

    const ids = iroIds(spec.topic);
    const impact: CsrdDmaIro = {
      id: ids.impact,
      organizationId: ORG,
      reportingPeriodId: PERIOD,
      matterId,
      iroType: 'impact',
      subTopic: spec.impact.subTopic,
      description: spec.impact.description,
      valueChainStage: spec.impact.stage,
      timeHorizon: null,
      impactOccurrence: spec.impact.occurrence,
      impactDirection: 'negative',
      impactScale: spec.impact.scale,
      impactScope: spec.impact.scope,
      impactIrremediability: spec.impact.irremediability,
      impactLikelihood: spec.impact.occurrence === 'potential' ? spec.impact.likelihood : null,
      financialLikelihood: null,
      financialMagnitude: null,
      humanRights: spec.impact.humanRights,
      affectedStakeholders: spec.impact.stakeholders,
      relatedImpactIroId: null,
      deletedAt: null,
      ...audit(at(26)),
    };
    const financial: CsrdDmaIro = {
      id: ids.financial,
      organizationId: ORG,
      reportingPeriodId: PERIOD,
      matterId,
      iroType: spec.financial.type,
      subTopic: spec.impact.subTopic,
      description: spec.financial.description,
      valueChainStage: spec.financial.stage,
      timeHorizon: spec.financial.horizon,
      impactOccurrence: null,
      impactDirection: null,
      impactScale: null,
      impactScope: null,
      impactIrremediability: null,
      impactLikelihood: null,
      financialLikelihood: spec.financial.likelihood,
      financialMagnitude: spec.financial.magnitude,
      humanRights: false,
      affectedStakeholders: '',
      // 気候変動だけ、リスクの原因になったインパクトを関連付けておく（関連付けは任意）
      relatedImpactIroId: spec.topic === 'E1' ? ids.impact : null,
      deletedAt: null,
      ...audit(at(26)),
    };
    // 関連先（インパクト）を先に置く（seed の 1 文の中でも参照の順序をそろえる）
    db.csrdDmaIros.push(impact, financial);
  }
}

function seedAssessments(db: FixtureDb): void {
  for (const spec of ASSESSMENT_SPECS) {
    const text = AI_TEXT[spec.code];
    const ai = spec.ai;
    const human = spec.human;
    const reviewed = spec.reviewed && human !== null;
    const row: CsrdAssessment = {
      id: CSRD_IDS.assessments[spec.code]!,
      organizationId: ORG,
      reportingPeriodId: PERIOD,
      itemId: itemId(spec.code),
      disclosureStatus: human?.[0] ?? 'unconfirmed',
      dataStatus: human?.[1] ?? 'unconfirmed',
      processStatus: human?.[2] ?? 'unconfirmed',
      aiDisclosureStatus: ai?.[0] ?? null,
      aiDataStatus: ai?.[1] ?? null,
      aiProcessStatus: ai?.[2] ?? null,
      aiStatus: ai ? combine(ai) : null,
      aiComment: ai ? (text?.comment ?? '') : '',
      aiMissingInfo: ai ? (text?.missing ?? []) : [],
      aiRecommendation: ai ? (text?.recommendation ?? '') : '',
      // Fixture の AI 候補は ai_runs の行を持たない（SSBJ の Fixture と同じ）
      aiRunId: null,
      aiEvaluatedAt: ai ? at(16) : null,
      // AI 候補を採用したもの（GOV-1）は approved、AI なしで人が入れたものは null
      reviewDecision: reviewed && ai ? 'approved' : null,
      reviewedBy: reviewed ? AUTHOR : null,
      reviewedAt: reviewed ? at(14) : null,
      reviewComment: reviewed
        ? ai
          ? 'AI の候補を確認し、妥当と判断しました（架空）。'
          : '担当部署の資料を確認して入力しました（架空）。'
        : '',
      finalStatus: reviewed && human ? combine(human) : null,
      ownerDepartment: spec.department,
      ownerUserId: AUTHOR,
      ...audit(at(30), reviewed ? at(14) : ai ? at(16) : at(30)),
    };
    db.csrdAssessments.push(row);
  }
}

function seedPlans(db: FixtureDb): void {
  const plans: CsrdActionPlan[] = [
    {
      id: CSRD_IDS.plans.e1Target,
      organizationId: ORG,
      reportingPeriodId: PERIOD,
      assessmentId: CSRD_IDS.assessments['ESRS-E1-4']!,
      gapKind: 'disclosure',
      title: 'GHG 削減目標を移行計画と整合させる（架空）',
      detail:
        '基準年・目標年・対象範囲（Scope1/2/3）を移行計画（E1-1）と突き合わせ、開示する削減目標を決める（架空）。',
      actionType: 'disclosure_addition',
      department: '経営企画部',
      assigneeUserId: AUTHOR,
      dueDate: '2026-11-30',
      priority: 'high',
      status: 'in_progress',
      linkedMetricCode: null,
      ...audit(at(12)),
    },
    {
      id: CSRD_IDS.plans.s1FemaleManagers,
      organizationId: ORG,
      reportingPeriodId: PERIOD,
      assessmentId: CSRD_IDS.assessments['ESRS-S1-9']!,
      gapKind: 'data',
      title: 'EU・JV 拠点の女性管理職比率を収集する（架空）',
      detail: 'EU 子会社と JV 拠点の人事データから、管理職に占める女性の割合を集める（架空）。',
      actionType: 'data_collection',
      department: '人事部',
      assigneeUserId: AUTHOR,
      dueDate: '2026-12-18',
      priority: 'medium',
      status: 'not_started',
      linkedMetricCode: 'female_manager_ratio',
      ...audit(at(12)),
    },
  ];
  db.csrdActionPlans.push(...plans);

  // S1-9 の計画から作った収集項目（収集画面に初期行が出る）
  const metric = metricId('AOMI', 'female_manager_ratio');
  for (const unitId of CSRD_COLLECTION_UNIT_IDS) {
    db.metricAssignments.push({
      id: fid('metric_assignment', `${metric}/${unitId}/${PERIOD}`),
      organizationId: ORG,
      metricId: metric,
      unitId,
      reportingPeriodId: PERIOD,
      ownerUserId: AUTHOR,
      reviewerUserId: null,
      dueDate: '2026-12-18',
      ...audit(at(12)),
    });
  }
}

function seedDrafts(db: FixtureDb): void {
  db.csrdDisclosureDrafts.push(
    {
      id: CSRD_IDS.drafts.esrs2,
      organizationId: ORG,
      reportingPeriodId: PERIOD,
      section: 'ESRS2',
      // 人が書いて保存した本文（AI の草案は使っていない）。DMA が未確定のため、まだ確定していない
      body:
        '当社は、サステナビリティに関する事項を取締役会が監督し、サステナビリティ委員会（委員長: 代表取締役社長）が四半期ごとに重要な影響・リスク・機会の状況を審議して取締役会へ報告しています（架空）。' +
        'ダブル・マテリアリティ評価は、従業員・主要サプライヤー・顧客への聞き取りを踏まえてサステナビリティ推進部が行い、評価方法と閾値は自社で定めています（架空）。' +
        '重要と判断した事項と戦略・ビジネスモデルとの関係は、各テーマ別の節で説明します。本文はデモ用の架空の記載で、実在企業の開示ではありません。',
      aiBody: '',
      coveredItemCodes: ['ESRS2-GOV-1'],
      gaps: [],
      aiRunId: null,
      aiConfidence: null,
      aiWarnings: [],
      aiGeneratedAt: null,
      confirmedAt: null,
      confirmedBy: null,
      ...audit(at(9), at(8)),
    },
    {
      id: CSRD_IDS.drafts.s1,
      organizationId: ORG,
      reportingPeriodId: PERIOD,
      section: 'S1',
      // AI の草案だけ（本文には未採用）
      body: '',
      aiBody:
        '青海テクノロジー株式会社は、自社の労働力（S1）をインパクトと財務の両面で重要と判断しました（架空）。' +
        '主なインパクトは長時間労働による健康への影響（潜在・人権）、主なリスクは人材確保難による操業への影響です（架空）。' +
        '2026年度においては、従業員数の内訳（ESRS-S1-6）について開示しています。' +
        'なお、1 件の要求事項（ESRS-S1-9）は担当者の確認が済んでいないため記載を保留しています（デモ生成）。',
      coveredItemCodes: ['ESRS-S1-6'],
      gaps: [
        {
          itemCode: 'ESRS-S1-9',
          reason: '担当者の確認が済んでいないため、草案に含めていません。',
        },
      ],
      aiRunId: null,
      aiConfidence: 0.58,
      aiWarnings: [
        'これは草案です（デモ生成）。そのまま開示せず、担当者が本文に採用して内容を確認してから確定してください。',
      ],
      aiGeneratedAt: at(10),
      confirmedAt: null,
      confirmedBy: null,
      ...audit(at(10)),
    },
  );
}
