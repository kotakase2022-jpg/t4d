import 'server-only';

import { getReferenceDate } from '@/lib/clock';
import { daysUntilJst } from '@/lib/format/datetime';
import type { DbClient } from '@/lib/repositories/types';
import {
  evaluateSignoffBlockers,
  loadAssuranceDashboard,
  type AssuranceDashboardRow,
} from '@/lib/services/assurance';
import type { AuthorizationContext, Engagement, PbcStatus } from '@/types/domain';
import type { EngagementWorkCounts } from '@/lib/ui/assurance-work';

/** 企業の回答を待っている資料依頼（資料依頼の画面の「送付済み・未提出」と同じ） */
const AWAITING_CLIENT: readonly PbcStatus[] = ['sent', 'acknowledged', 'overdue'];
/** 企業が回答済みで、監査法人の判断待ち */
const ANSWERED: readonly PbcStatus[] = ['submitted', 'under_review'];

export type EngagementWorkRow = EngagementWorkCounts & {
  completed: boolean;
  dashboard: AssuranceDashboardRow;
};

/**
 * 案件ごとの作業の数（読み取りだけ）。案件ホームと案件の概要が同じ数え方を使う。
 * 既存の読み取り（loadAssuranceDashboard・evaluateSignoffBlockers）に、資料依頼とレビューNote の
 * 内訳を足す。書き込みはしない。
 */
export async function loadEngagementWorkRows(
  db: DbClient,
  ctx: AuthorizationContext,
  engagements: Engagement[],
): Promise<EngagementWorkRow[]> {
  if (engagements.length === 0) return [];
  const ids = engagements.map((e) => e.id);
  const [dashboard, pbcRequests, reviewNotes] = await Promise.all([
    loadAssuranceDashboard(db, ctx, engagements),
    db.select('pbcRequests', { where: { engagementId: { in: ids } } }),
    db.select('reviewNotes', { where: { engagementId: { in: ids } } }),
  ]);
  // 期限の基準日は 1 か所（デモは FIXTURE_TODAY、Supabase Mode は実時計）
  const today = getReferenceDate();

  return Promise.all(
    dashboard.map(async (row) => {
      const engagementId = row.engagement.id;
      const requests = pbcRequests.filter((r) => r.engagementId === engagementId);
      const blockers = await evaluateSignoffBlockers(db, ctx, engagementId, 'partner_approved');
      return {
        engagementId,
        code: row.engagement.code,
        clientName: row.clientName,
        deadlineDate: row.engagement.deadlineDate,
        daysUntilDeadline: daysUntilJst(row.engagement.deadlineDate, today),
        pbcOpen: row.pbcOutstanding,
        pbcOutstanding: requests.filter((r) => AWAITING_CLIENT.includes(r.status)).length,
        pbcAnswered: requests.filter((r) => ANSWERED.includes(r.status)).length,
        testsPending: row.testsPending,
        reviewPending: row.reviewPending,
        openHighIssues: row.openHighIssues,
        changesSinceSnapshot: row.changesSinceSnapshot,
        openReviewNotes: reviewNotes.filter(
          (n) => n.engagementId === engagementId && n.status !== 'cleared',
        ).length,
        signoffStages: row.signoffStages,
        signoffBlockers: blockers.length,
        completed: row.engagement.status === 'completed',
        dashboard: row,
      };
    }),
  );
}
