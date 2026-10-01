import type { SsbjFlowStep } from '@/components/shared/ssbj-flow';
import type { DisclosureQuestionRow } from '@/lib/services/disclosure';
import type { CsrdOverview } from '@/lib/services/csrd/requirements';

/**
 * CSRD 対応状況の画面の組み立て（docs/disclosure-first.md §9.4）。純関数。
 *
 * 工程は SSBJ と同じ並び（①設定 ②要求事項の評価 ③対応計画 ④データ収集 ⑤開示ドラフト）。
 * 「完了」は確かめられるときだけ書く（決まっていない前提を完了と見せない）。
 * 件数は必ず分母と並べる（単一の総合点・重み付きの対応度は出さない）。
 */

const BASE = '/enterprise/disclosures/csrd';

export function csrdFlowSteps(overview: CsrdOverview): SsbjFlowStep[] {
  const { dma, applicabilityCounts, coverageCounts, planCounts, draftCounts } = overview;
  const decided = dma.matterTotal - dma.outcomeCounts.not_assessed;
  const material =
    dma.outcomeCounts.both + dma.outcomeCounts.impact_only + dma.outcomeCounts.financial_only;
  const openPlans = planCounts.not_started + planCounts.in_progress + planCounts.in_review;
  return [
    {
      // ここで決める報告範囲と DMA が、要求事項の適用（評価対象）の前提になる
      title: '設定（報告範囲・ダブル・マテリアリティ評価）',
      description:
        '報告範囲・評価方法と閾値を決め、10 事項をインパクトと財務の 2 つの観点で判断します。',
      state: dma.confirmed ? 'done' : 'current',
      detail: dma.confirmed
        ? `DMA 確定済み ／ 重要 ${material} / ${dma.matterTotal} 事項`
        : `DMA 未確定 ／ 判断済み ${decided} / ${dma.matterTotal} 事項`,
      href: `${BASE}/settings`,
    },
    {
      title: '要求事項の評価',
      description:
        '適用になった要求事項を、開示・データ・業務プロセスの 3 観点で評価し、AI の候補を担当者が確定します。',
      state:
        overview.awaitingReview > 0 || coverageCounts.combined.unconfirmed > 0 ? 'current' : 'done',
      detail: `評価対象 ${applicabilityCounts.inScope} / ${applicabilityCounts.total} 件 ／ 確認待ち ${overview.awaitingReview} 件 ／ 優先度「高」${overview.highPriority} 件`,
      href: `${BASE}/requirements`,
    },
    {
      title: '対応計画',
      description: 'ギャップごとに担当部署・担当者・期限を決めます。',
      state: openPlans > 0 ? 'current' : planCounts.done > 0 ? 'done' : 'todo',
      detail: `対応中 ${planCounts.in_progress} 件 ／ 未着手 ${planCounts.not_started} 件`,
      href: `${BASE}/plans`,
    },
    {
      title: 'データ収集',
      description: '評価対象の要求事項に対応する指標を、拠点ごとに集めて承認します。',
      state: overview.collectionPlanCount > 0 ? 'current' : 'todo',
      detail: `計画から作成した収集項目 ${overview.collectionPlanCount} 件`,
      href: `${BASE}/collection`,
    },
    {
      title: '開示ドラフト',
      // 草案の出所（デモ生成・AI 生成）は開示ドラフトの画面で節ごとに示す。ここでは決め打ちしない
      description: '節ごとに AI 草案（候補）を本文に採用し、人が編集して確定します。',
      state: draftCounts.confirmed + draftCounts.generated > 0 ? 'current' : 'todo',
      detail: `確定 ${draftCounts.confirmed} 節 ／ AI 草案 ${draftCounts.generated} 節`,
      href: `${BASE}/draft`,
    },
  ];
}

export interface WorkspaceSummary {
  total: number;
  /** 回答本文があり、未着手以外の回答 */
  answered: number;
  requiredTotal: number;
  /** 必須項目のうち、データが揃っているか回答本文があるもの */
  requiredReady: number;
  /** 対応付いた指標のすべてに承認済みの値がある項目（1 指標の値で複数指標の項目を充足済みにしない） */
  withData: number;
  partialData: number;
  /** 指標が対応付いた項目 */
  mapped: number;
}

/** 既存のギャップ分析表（回答・データ）の要約。分母と並べて表示する */
export function workspaceSummary(rows: readonly DisclosureQuestionRow[]): WorkspaceSummary {
  return {
    total: rows.length,
    answered: rows.filter(
      (r) => r.response && r.response.status !== 'not_started' && r.response.answerText,
    ).length,
    requiredTotal: rows.filter((r) => r.item.required).length,
    requiredReady: rows.filter(
      (r) => r.item.required && (r.dataCoverage === 'full' || Boolean(r.response?.answerText)),
    ).length,
    withData: rows.filter((r) => r.dataCoverage === 'full').length,
    partialData: rows.filter((r) => r.dataCoverage === 'partial').length,
    mapped: rows.filter((r) => r.mappedMetrics.length > 0).length,
  };
}
