import { itemVerdict } from './attribution';
import type { GhgCalculationRun, GhgReconciliation, GhgReconciliationNote } from '@/types/domain';

/**
 * 拠点ごとの検証の進み具合（plan §2.2 verification-status.ts・CR-20）。純関数。
 * トライアル概要・算定の概要・ホームの Attention が同じ関数を使う（同じ状態を画面ごとに別の語で出さない）。
 *
 *  - 活動量: 確定済みの行がある月の数（12 か月で揃う）
 *  - 係数: 必要な割当が解決できない行の数（0 なら揃っている）
 *  - 算定: 最新の記録が拠点を含み、入力ハッシュが現在と同じ（current）／違う（stale）／記録なし
 *  - 既存結果: その期間の既存の算定結果に拠点の行があるか
 *  - 照合: 最新の記録の照合で、拠点の項目がすべて許容差内か原因を確認済み（done）／要確認あり
 * 総合（6 状態）: 未着手・入力不足・算定済み・再算定が必要・照合（要確認）・照合済み
 */

export const GHG_SITE_STATUSES = [
  'not_started',
  'input_missing',
  'calculated',
  'recalc_needed',
  'reconciliation_review',
  'reconciled',
] as const;
export type GhgSiteStatus = (typeof GHG_SITE_STATUSES)[number];

export interface SiteInput {
  unitId: string;
  /** 確定済みの活動量の行がある月（YYYY-MM-01） */
  monthsWithActivity: readonly string[];
  /** 期間の月の数（暦年なら 12） */
  monthsInPeriod: number;
  /** 係数が解決できない行の数 */
  unresolvedLines: number;
  /** 既存の算定結果に拠点の行があるか */
  hasBaseline: boolean;
}

export interface SiteStatus {
  unitId: string;
  activity: { months: number; of: number; state: 'none' | 'partial' | 'complete' };
  factors: { unresolved: number; state: 'ok' | 'missing' };
  calculation: 'none' | 'current' | 'stale';
  baseline: 'none' | 'present';
  reconciliation: 'none' | 'needs_review' | 'done';
  overall: GhgSiteStatus;
}

/**
 * @param currentInputHash 最新の記録の拠点・期間で今の入力から作った入力ハッシュ（記録が無ければ null）
 */
export function siteStatuses(
  sites: readonly SiteInput[],
  latestRun: Pick<GhgCalculationRun, 'id' | 'unitIds' | 'inputHash'> | null,
  currentInputHash: string | null,
  latestRecon: Pick<GhgReconciliation, 'id' | 'runId' | 'result'> | null,
  notes: readonly Pick<
    GhgReconciliationNote,
    'id' | 'itemKey' | 'supersedesId' | 'reconciliationId'
  >[],
): SiteStatus[] {
  return sites.map((site) => {
    const months = new Set(site.monthsWithActivity).size;
    const activityState: SiteStatus['activity']['state'] =
      months === 0 ? 'none' : months >= site.monthsInPeriod ? 'complete' : 'partial';
    const factorsState = site.unresolvedLines > 0 ? 'missing' : 'ok';
    const inRun = !!latestRun && latestRun.unitIds.includes(site.unitId);
    const calculation: SiteStatus['calculation'] = !inRun
      ? 'none'
      : currentInputHash !== null && latestRun!.inputHash === currentInputHash
        ? 'current'
        : 'stale';
    let reconciliation: SiteStatus['reconciliation'] = 'none';
    if (latestRecon && latestRun && latestRecon.runId === latestRun.id && latestRecon.result) {
      const items = latestRecon.result.items.filter((i) => i.unitId === site.unitId);
      const reconNotes = notes.filter((n) => n.reconciliationId === latestRecon.id);
      if (items.length > 0) {
        const open = items.some((i) => {
          const v = itemVerdict(i, reconNotes);
          return v !== 'within_tolerance' && v !== 'cause_confirmed';
        });
        reconciliation = open ? 'needs_review' : 'done';
      }
    }
    let overall: GhgSiteStatus;
    if (activityState === 'none') overall = 'not_started';
    else if (activityState === 'partial' || factorsState === 'missing') overall = 'input_missing';
    else if (calculation === 'none') overall = 'not_started';
    else if (calculation === 'stale') overall = 'recalc_needed';
    else if (reconciliation === 'needs_review') overall = 'reconciliation_review';
    else if (reconciliation === 'done') overall = 'reconciled';
    else overall = 'calculated';
    return {
      unitId: site.unitId,
      activity: { months, of: site.monthsInPeriod, state: activityState },
      factors: { unresolved: site.unresolvedLines, state: factorsState },
      calculation,
      baseline: site.hasBaseline ? 'present' : 'none',
      reconciliation,
      overall,
    };
  });
}

/** 期間の月の数（開始日と終了日の月を含む） */
export function monthsBetween(startDate: string, endDate: string): number {
  const [sy, sm] = startDate.split('-').map(Number) as [number, number];
  const [ey, em] = endDate.split('-').map(Number) as [number, number];
  return Math.max(0, (ey - sy) * 12 + (em - sm) + 1);
}
