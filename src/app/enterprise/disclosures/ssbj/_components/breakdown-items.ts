import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleMinus,
  CircleSlash,
  CircleX,
  ClipboardCheck,
  Hourglass,
  PenLine,
  Send,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import type { StatusBreakdownItem } from '@/components/charts/status-breakdown';
import type { FunnelStep } from '@/components/charts/funnel-steps';
import { ACTION_STATUS_LABEL } from '@/lib/domain/ssbj';
import type { DataPointStatus, SsbjActionStatus } from '@/types/domain';

/**
 * SSBJ 画面の件数を図（StatusBreakdown・FunnelSteps）へ渡す形に組み立てる（表示だけ。
 * docs/disclosure-first.md §10.4）。集計はサービスのまま使い、ここでは数え直さない。
 *
 * 帯は「重ならない区分」だけで作る（合計が分母と一致しないと幅が嘘になる）。重なる件数
 * （確認待ち・期限超過など）は呼び出し側が帯の外に別に書く。
 * ラベルは既存の画面の文言そのまま（E2E が厳密一致で確かめている）。
 */

const REQUIREMENTS = '/enterprise/disclosures/ssbj/requirements';

/** 対応状況画面の件数（loadSsbjOverview の counts のうち、重ならない 6 区分と全要求事項） */
export interface SsbjRequirementCounts {
  total: number;
  covered: number;
  mostlyCovered: number;
  partial: number;
  /** 未対応＋未確認（評価対象のうち、対応済み〜一部対応以外） */
  notCovered: number;
  notMaterial: number;
  notApplicable: number;
}

/**
 * 全要求事項の内訳（6 区分の合計 = 全要求事項）。
 * 対応済み〜未対応は評価対象（対象外・重要性なしを除く）で数えているので、一覧への絞り込みにも
 * scope=in_scope を付ける（filterRequirements が同じ母集団になり、数字とリンク先がずれない）。
 * 重要性なし・対象外は一覧の絞り込みで同じ母集団を作れないため、リンクを付けない
 */
export function ssbjRequirementItems(counts: SsbjRequirementCounts): StatusBreakdownItem[] {
  return [
    {
      key: 'covered',
      label: '対応済み',
      count: counts.covered,
      icon: CircleCheck,
      href: `${REQUIREMENTS}?scope=in_scope&coverage=covered`,
    },
    {
      key: 'mostly_covered',
      label: 'おおむね対応',
      count: counts.mostlyCovered,
      icon: CircleDot,
      href: `${REQUIREMENTS}?scope=in_scope&coverage=mostly_covered`,
    },
    {
      key: 'partial',
      label: '一部対応',
      count: counts.partial,
      icon: TriangleAlert,
      href: `${REQUIREMENTS}?scope=in_scope&coverage=partial`,
    },
    {
      key: 'not_covered',
      label: '未対応',
      count: counts.notCovered,
      icon: CircleX,
      href: `${REQUIREMENTS}?scope=in_scope&coverage=not_covered&coverage=unconfirmed`,
    },
    { key: 'not_material', label: '重要性なし', count: counts.notMaterial, icon: CircleMinus },
    { key: 'not_applicable', label: '対象外', count: counts.notApplicable, icon: CircleSlash },
  ];
}

const PLAN_STATUS_ORDER: readonly SsbjActionStatus[] = [
  'not_started',
  'in_progress',
  'in_review',
  'done',
];

const PLAN_STATUS_ICON: Record<SsbjActionStatus, StatusBreakdownItem['icon']> = {
  not_started: CircleDashed,
  in_progress: CircleDot,
  in_review: ClipboardCheck,
  done: CircleCheck,
};

/** 対応計画の対応状況の内訳（4 区分の合計 = 計画の件数。0 件の区分も凡例に出す） */
export function planStatusItems(
  plans: readonly { plan: { status: SsbjActionStatus } }[],
): StatusBreakdownItem[] {
  return PLAN_STATUS_ORDER.map((status) => ({
    key: status,
    label: ACTION_STATUS_LABEL[status],
    count: plans.filter((p) => p.plan.status === status).length,
    icon: PLAN_STATUS_ICON[status],
  }));
}

/** 収集状況の区分（Data Point の状態。行が無いものは「未入力」）。表の収集状況のバッジと同じ文言 */
const COLLECTION_STATUS: ReadonlyArray<{
  key: DataPointStatus | 'not_entered';
  label: string;
  icon: StatusBreakdownItem['icon'];
}> = [
  { key: 'approved', label: '承認済み', icon: CircleCheck },
  { key: 'in_review', label: 'レビュー中', icon: Hourglass },
  { key: 'submitted', label: '提出済み', icon: Send },
  { key: 'returned', label: '差戻し', icon: Undo2 },
  { key: 'draft', label: '入力中', icon: PenLine },
  { key: 'not_started', label: '未着手', icon: CircleDashed },
  { key: 'not_entered', label: '未入力', icon: Circle },
];

/**
 * 収集対象（データ項目 × 拠点）の収集状況の内訳（合計 = 収集対象）。
 * 7 区分のうち 0 件のものは凡例を短くするため出さない（承認済みは 0 件でも出す: 進み具合の基準）
 */
export function collectionStatusItems(
  rows: readonly { collectedStatus: string | null }[],
): StatusBreakdownItem[] {
  return COLLECTION_STATUS.map((status) => ({
    key: status.key,
    label: status.label,
    icon: status.icon,
    count: rows.filter((row) =>
      status.key === 'not_entered'
        ? row.collectedStatus === null
        : row.collectedStatus === status.key,
    ).length,
  })).filter((item) => item.key === 'approved' || item.count > 0);
}

/** 要求事項とのマッピングの件数（loadSsbjScopeMapping の counts） */
export interface SsbjMappingCounts {
  masterTotal: number;
  afterStandards: number;
  notApplicable: number;
  notMaterial: number;
  inScope: number;
}

/**
 * 件数の流れ（正式基準マスター → 適用基準 → 対象外を除く → 評価対象）。
 * 「なぜこの件数なのか」を検算できるよう、各段の件数を文字で書く（帯は相対幅の補助）
 */
export function mappingFunnelSteps(counts: SsbjMappingCounts): FunnelStep[] {
  return [
    { label: '正式基準マスター', count: counts.masterTotal, unit: '項目' },
    { label: '適用基準で', count: counts.afterStandards, unit: '項目' },
    {
      label: '対象外を除く',
      count: Math.max(0, counts.afterStandards - counts.notApplicable),
      unit: '項目',
    },
    { label: '評価対象（重要性なしも除く）', count: counts.inScope, unit: '項目' },
  ];
}
