import { CircleCheck, CircleDashed, Hourglass, Undo2 } from 'lucide-react';
import type { StatusBreakdownItem } from '@/components/charts/status-breakdown';

/**
 * 従来のホームの「拠点別進捗」を状態の内訳（StatusBreakdown）で描くための組み立て（表示だけ。
 * docs/disclosure-first.md §10.4）。
 *
 * 集計（loadEnterpriseDashboard）は 承認済み・レビュー中（提出済み＋レビュー中）・未提出（未着手＋入力中）
 * だけを数える。帯は重ならない区分の合計が「対象」と一致しないと幅が嘘になるため、残り（差戻し）は
 * 対象との差で補う（差が 0 なら出さない）。
 * 検証エラーはどの状態の値にも付く（状態と重なる）ので、内訳には入れず別に示す。
 */

export interface UnitProgressCounts {
  unitId: string;
  /** 対象（その拠点の当期の Data Point 数） */
  total: number;
  approved: number;
  /** 提出済み＋レビュー中 */
  submitted: number;
  /** 未着手＋入力中 */
  notStarted: number;
}

const DATA_LIST = '/enterprise/data';

/** その拠点・状態で絞り込んだ台帳（同じ絞り込みはホームの KPI カードでも使っている） */
function dataListHref(unitId: string, statuses: readonly string[]): string {
  const params = new URLSearchParams({ unit: unitId });
  for (const status of statuses) params.append('status', status);
  return `${DATA_LIST}?${params.toString()}`;
}

/** 差戻し（対象から 3 区分を引いた残り）。負にはしない */
export function returnedCount(row: UnitProgressCounts): number {
  return Math.max(0, row.total - row.approved - row.submitted - row.notStarted);
}

export function unitStatusItems(row: UnitProgressCounts): StatusBreakdownItem[] {
  const items: StatusBreakdownItem[] = [
    {
      key: 'approved',
      label: '承認済み',
      count: row.approved,
      icon: CircleCheck,
      href: dataListHref(row.unitId, ['approved']),
    },
    {
      key: 'submitted',
      label: 'レビュー中',
      count: row.submitted,
      icon: Hourglass,
      href: dataListHref(row.unitId, ['submitted', 'in_review']),
    },
    {
      key: 'not_started',
      label: '未提出',
      count: row.notStarted,
      icon: CircleDashed,
      href: dataListHref(row.unitId, ['not_started', 'draft']),
    },
  ];
  const returned = returnedCount(row);
  if (returned > 0) {
    items.push({
      key: 'returned',
      label: '差戻し',
      count: returned,
      icon: Undo2,
      href: dataListHref(row.unitId, ['returned']),
    });
  }
  return items;
}
