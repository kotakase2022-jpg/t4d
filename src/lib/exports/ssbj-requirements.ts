import 'server-only';

import type { ExportColumn } from '@/lib/exports';
import {
  APPLICABILITY_LABEL,
  AREA_LABEL,
  COVERAGE_LABEL,
  MATERIALITY_LABEL,
  PRIORITY_LABEL,
} from '@/lib/domain/ssbj';
import type { SsbjRequirementView } from '@/lib/services/ssbj-gap';

/**
 * 「SSBJ 要求事項の評価」一覧の CSV 列。
 *
 * 発注者会議の「ギャップ分析の結果を CSV 出力できれば十分」を受けた定義。
 * 画面の列（判定・紐づけ・優先度・担当）に加え、画面では詳細を開かないと
 * 見えない判定理由・AI の評価コメント・不足情報まで含める——CSV の用途は
 * 部門への展開や経営報告であり、そこでは「なぜその判定か」まで要るため。
 * 値はすべて画面と同じラベルに変換する（内部コードを社外資料に出さない）。
 */
export const SSBJ_REQUIREMENT_EXPORT_COLUMNS: ExportColumn<SsbjRequirementView>[] = [
  { key: 'code', header: '要求事項番号', value: (v) => v.item.code },
  { key: 'section', header: '節', value: (v) => v.item.section },
  { key: 'question', header: '要求事項', value: (v) => v.item.questionText },
  { key: 'area', header: '領域', value: (v) => AREA_LABEL[v.area] },
  { key: 'required', header: '必須・任意', value: (v) => (v.item.required ? '必須' : '任意') },
  {
    key: 'applicability',
    header: '適用区分',
    value: (v) => APPLICABILITY_LABEL[v.assessment.applicability],
  },
  {
    key: 'applicabilityReason',
    header: '適用区分の理由',
    value: (v) => v.assessment.applicabilityReason,
  },
  {
    key: 'materiality',
    header: '重要性',
    value: (v) => MATERIALITY_LABEL[v.assessment.materiality],
  },
  {
    key: 'materialityReason',
    header: '重要性の理由',
    value: (v) => v.assessment.materialityReason,
  },
  {
    key: 'aiStatus',
    header: '人工知能による判定',
    value: (v) => (v.assessment.aiStatus ? COVERAGE_LABEL[v.assessment.aiStatus] : '未実施'),
  },
  { key: 'aiComment', header: '人工知能の評価コメント', value: (v) => v.assessment.aiComment },
  {
    key: 'aiMissingInfo',
    header: '不足している情報',
    value: (v) => v.assessment.aiMissingInfo.join(' ／ '),
  },
  {
    key: 'aiRecommendation',
    header: '推奨される対応',
    value: (v) => v.assessment.aiRecommendation,
  },
  {
    key: 'finalStatus',
    header: '最終判定',
    value: (v) =>
      v.assessment.finalStatus ? COVERAGE_LABEL[v.assessment.finalStatus] : '確認待ち',
  },
  {
    key: 'disclosureStatus',
    header: '開示の状況',
    value: (v) => COVERAGE_LABEL[v.assessment.disclosureStatus],
  },
  {
    key: 'dataStatus',
    header: 'データの状況',
    value: (v) => COVERAGE_LABEL[v.assessment.dataStatus],
  },
  {
    key: 'processStatus',
    header: '業務プロセスの状況',
    value: (v) => COVERAGE_LABEL[v.assessment.processStatus],
  },
  {
    key: 'documentLink',
    header: '取込資料との紐づけ',
    value: (v) => (v.analyzed ? (v.hasDocumentLink ? 'あり' : 'なし') : '未分析'),
  },
  {
    key: 'dataLink',
    header: 'データとの紐づけ',
    value: (v) => (v.hasDataLink ? 'あり' : 'なし'),
  },
  { key: 'sourceDocument', header: '出典資料', value: (v) => v.assessment.sourceDocument ?? '' },
  { key: 'priority', header: '優先度', value: (v) => PRIORITY_LABEL[v.priority.priority] },
  { key: 'priorityScore', header: '優先度スコア', value: (v) => v.priority.score, numeric: true },
  { key: 'ownerDepartment', header: '担当部署', value: (v) => v.assessment.ownerDepartment },
  { key: 'planCount', header: '対応計画数', value: (v) => v.plans.length, numeric: true },
];
