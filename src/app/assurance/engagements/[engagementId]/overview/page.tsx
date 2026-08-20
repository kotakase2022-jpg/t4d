import Link from 'next/link';
import { IssueSeverityBadge, PbcStatusBadge, TestStatusBadge } from '@/components/shared/badges';
import { KpiCard, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { formatJst, formatJstDate, formatNumber } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import { requireAssuranceContext } from '@/lib/auth/session';
import {
  detectSnapshotChanges,
  evaluateSignoffBlockers,
  loadEngagementOr404,
  loadLatestSnapshot,
  loadTestingWorkspace,
} from '@/lib/services/assurance';
import { EngagementHeader } from '../engagement-header';

export const metadata = { title: '案件概要' };

export default async function EngagementOverviewPage({
  params,
}: {
  params: Promise<{ engagementId: string }>;
}) {
  const { engagementId } = await params;
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const context = await loadEngagementOr404(db, ctx, engagementId);
  const base = `/assurance/engagements/${engagementId}`;

  const [snapshot, testing, pbcRequests, issues, reviewNotes, signoffs, members, activity] =
    await Promise.all([
      loadLatestSnapshot(db, engagementId),
      loadTestingWorkspace(db, ctx, engagementId),
      db.select('pbcRequests', { where: { engagementId } }),
      db.select('issues', { where: { engagementId } }),
      db.select('reviewNotes', { where: { engagementId } }),
      db.select('signoffs', { where: { engagementId } }),
      db.select('engagementMembers', { where: { engagementId } }),
      db.select('auditEvents', {
        where: { engagementId },
        orderBy: { column: 'createdAt', dir: 'desc' },
        limit: 10,
      }),
    ]);

  const changes = snapshot ? await detectSnapshotChanges(db, ctx, snapshot.id) : [];
  const blockers = await evaluateSignoffBlockers(db, ctx, engagementId, 'partner_approved');

  const profileIds = [...new Set(members.map((m) => m.userId))];
  const profiles =
    profileIds.length > 0 ? await db.select('profiles', { where: { id: { in: profileIds } } }) : [];

  const reviewed = testing.rows.filter((r) => r.status === 'reviewed').length;
  const progress =
    testing.rows.length === 0 ? 0 : Math.round((reviewed / testing.rows.length) * 100);
  const openPbc = pbcRequests.filter(
    (r) => r.status !== 'accepted' && r.status !== 'closed',
  ).length;
  const openIssues = issues.filter((i) => i.status !== 'resolved' && i.status !== 'closed').length;

  return (
    <>
      <EngagementHeader context={context} page="案件概要" />

      <div className="space-y-3 p-4">
        <ul className="grid grid-cols-6 gap-2">
          <li>
            <KpiCard
              label="Testing 進捗"
              value={progress}
              suffix="%"
              tone="brand"
              href={`${base}/testing`}
            />
          </li>
          <li>
            <KpiCard
              label="Open PBC"
              value={openPbc}
              suffix="件"
              tone={openPbc > 0 ? 'warning' : 'success'}
              href={`${base}/requests`}
            />
          </li>
          <li>
            <KpiCard
              label="Open Issues"
              value={openIssues}
              suffix="件"
              tone={openIssues > 0 ? 'danger' : 'success'}
              href={`${base}/issues`}
            />
          </li>
          <li>
            <KpiCard
              label="Review Notes"
              value={reviewNotes.filter((n) => n.status !== 'cleared').length}
              suffix="件"
              tone="brand"
              href={`${base}/review-notes`}
            />
          </li>
          <li>
            <KpiCard
              label="Snapshot 後変更"
              value={changes.length}
              suffix="件"
              tone={changes.length > 0 ? 'danger' : 'success'}
              href={`${base}/data-room`}
            />
          </li>
          <li>
            <KpiCard
              label="Sign-off"
              value={signoffs.length}
              suffix="/ 3"
              tone={signoffs.length >= 3 ? 'success' : 'neutral'}
              href={`${base}/signoffs`}
            />
          </li>
        </ul>

        <div className="grid grid-cols-3 gap-3">
          <Card className="col-span-2">
            <SectionTitle title="案件情報" />
            <dl className="grid grid-cols-2 gap-x-6 px-3 pb-3 text-[13px]">
              <Row label="クライアント" value={context.clientName} />
              <Row label="対象期間" value={context.periodLabel} />
              <Row label="基準" value={context.engagement.frameworkKey.toUpperCase()} />
              <Row
                label="保証水準"
                value={
                  context.engagement.assuranceLevel === 'limited' ? '限定的保証' : '合理的保証'
                }
              />
              <Row label="開始予定" value={formatJstDate(context.engagement.plannedStartDate)} />
              <Row label="期限" value={formatJstDate(context.engagement.deadlineDate)} />
              <Row
                label="重要性の基準"
                value={
                  context.engagement.materialityValue === null
                    ? '未設定'
                    : `${formatNumber(context.engagement.materialityValue)} ${context.engagement.materialityUnit ?? ''}（${context.engagement.materialityBasis ?? ''}）`
                }
              />
              <Row label="ステータス" value={context.engagement.status} />
            </dl>
            <div className="border-t border-line px-3 py-2">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                チーム
              </div>
              <ul className="flex flex-wrap gap-2">
                {members.map((member) => (
                  <li key={member.id}>
                    <Badge tone="neutral">
                      {profiles.find((p) => p.id === member.userId)?.displayName ?? '—'}（
                      {member.roleKey}）
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          </Card>

          <Card>
            <SectionTitle title="Snapshot" />
            <div className="space-y-2 p-3">
              {snapshot ? (
                <>
                  <div className="text-[13px] font-medium text-ink">{snapshot.label}</div>
                  <dl className="space-y-1 text-[12px]">
                    <Row label="固定日時" value={formatJst(snapshot.frozenAt)} />
                    <Row label="対象件数" value={`${snapshot.itemCount} 件`} />
                    <Row label="Hash" value={snapshot.hash.slice(0, 20)} />
                  </dl>
                  {changes.length > 0 && (
                    <div className="rounded-t4d bg-danger-soft p-2 text-[12px] text-danger">
                      固定後にクライアント側で {changes.length} 件の変更があります。
                      <Link href={`${base}/data-room`} className="ml-1 underline">
                        差分を確認
                      </Link>
                    </div>
                  )}
                </>
              ) : (
                <EmptyState
                  title="Snapshot 未作成"
                  description="Data Room から保証対象を固定してください。"
                  action={
                    <Link
                      href={`${base}/data-room`}
                      className="text-[12px] text-brand-700 underline"
                    >
                      Data Room へ
                    </Link>
                  }
                />
              )}
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Card>
            <SectionTitle title="Sign-off 抑止条件" />
            {blockers.length === 0 ? (
              <div className="p-3 text-[12px] text-success">
                すべての抑止条件を満たしています。Sign-off を実行できます。
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {blockers.map((blocker) => (
                  <li
                    key={blocker.code}
                    className="flex items-start justify-between gap-2 px-3 py-2"
                  >
                    <span className="text-[12px] text-ink">{blocker.message}</span>
                    {blocker.href && (
                      <Link
                        href={blocker.href}
                        className="shrink-0 text-[11px] text-brand-700 hover:underline"
                      >
                        対応する
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <SectionTitle title="直近のアクティビティ" />
            {activity.length === 0 ? (
              <EmptyState title="記録がありません" />
            ) : (
              <ul className="divide-y divide-line">
                {activity.map((event) => (
                  <li key={event.id} className="px-3 py-1.5">
                    <div className="text-[12px] text-ink">{event.eventType}</div>
                    {event.afterSummary && (
                      <div className="text-[11px] text-ink-muted">{event.afterSummary}</div>
                    )}
                    <div className="text-[11px] text-ink-muted">{formatJst(event.createdAt)}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Card>
            <SectionTitle title="Testing" />
            <div className="p-3">
              <Progress value={progress} label="Testing 進捗" />
              <ul className="mt-2 space-y-1">
                {testing.rows.slice(0, 6).map((row) => (
                  <li key={row.testId} className="flex items-center justify-between gap-2">
                    <span className="truncate text-[12px] text-ink">
                      {row.unitName} / {row.metricName}
                    </span>
                    <TestStatusBadge status={row.status as never} />
                  </li>
                ))}
              </ul>
            </div>
          </Card>

          <Card>
            <SectionTitle title="PBC" />
            <ul className="divide-y divide-line">
              {pbcRequests.slice(0, 6).map((request) => (
                <li
                  key={request.id}
                  className="flex items-center justify-between gap-2 px-3 py-1.5"
                >
                  <span className="truncate text-[12px] text-ink">
                    {request.code} {request.title}
                  </span>
                  <PbcStatusBadge status={request.status} />
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <SectionTitle title="Issue" />
            <ul className="divide-y divide-line">
              {issues.slice(0, 6).map((issue) => (
                <li key={issue.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <span className="truncate text-[12px] text-ink">
                    {issue.code} {issue.title}
                  </span>
                  <IssueSeverityBadge severity={issue.severity} />
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line py-1.5 last:border-b-0">
      <dt className="shrink-0 text-ink-muted">{label}</dt>
      <dd className="truncate text-right text-ink">{value}</dd>
    </div>
  );
}
