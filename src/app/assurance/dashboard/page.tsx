import Link from 'next/link';
import { BadgeCheck } from 'lucide-react';
import { KpiCard, PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { FIXTURE_TODAY } from '@/lib/config';
import { daysUntilJst, formatJstDate } from '@/lib/format/datetime';
import { loadAssuranceDashboard } from '@/lib/services/assurance';
import { loadAssuranceShell } from '@/lib/services/shell';

export const metadata = { title: '案件ホーム' };

export default async function AssuranceDashboardPage() {
  const shell = await loadAssuranceShell();
  const rows = await loadAssuranceDashboard(shell.db, shell.ctx, shell.engagements);

  const totals = rows.reduce(
    (acc, row) => ({
      pbc: acc.pbc + row.pbcOutstanding,
      tests: acc.tests + row.testsPending,
      review: acc.review + row.reviewPending,
      issues: acc.issues + row.openHighIssues,
      changes: acc.changes + row.changesSinceSnapshot,
    }),
    { pbc: 0, tests: 0, review: 0, issues: 0, changes: 0 },
  );

  const upcoming = rows.filter((r) => {
    const remaining = daysUntilJst(r.engagement.deadlineDate, FIXTURE_TODAY);
    return remaining !== null && remaining <= 60;
  }).length;

  return (
    <>
      <PageHeader
        title="案件ホーム"
        description={`${shell.ctx.workspace.organizationName} ／ アサインされている案件のみ表示しています`}
        breadcrumbs={[{ label: '監査法人ワークスペース' }, { label: '案件ホーム' }]}
      />

      <div className="space-y-3 p-4">
        {rows.length === 0 ? (
          <Card>
            <EmptyState
              title="アサインされている案件がありません"
              description="監査法人管理者であっても、Engagement Member でない案件のクライアントデータは閲覧できません。契約責任者へアサインを依頼してください。"
              icon={<BadgeCheck className="size-5" aria-hidden="true" />}
            />
          </Card>
        ) : (
          <>
            <ul className="grid grid-cols-7 gap-2">
              <li>
                <KpiCard
                  label="Active Engagements"
                  value={rows.filter((r) => r.engagement.status !== 'completed').length}
                  suffix="件"
                  tone="brand"
                  href="/assurance/engagements"
                />
              </li>
              <li>
                <KpiCard
                  label="PBC 未受領"
                  value={totals.pbc}
                  suffix="件"
                  tone={totals.pbc > 0 ? 'warning' : 'success'}
                  href="/assurance/engagements"
                />
              </li>
              <li>
                <KpiCard
                  label="Testing 未完了"
                  value={totals.tests}
                  suffix="件"
                  tone={totals.tests > 0 ? 'warning' : 'success'}
                  href="/assurance/engagements"
                />
              </li>
              <li>
                <KpiCard
                  label="Review 待ち"
                  value={totals.review}
                  suffix="件"
                  tone="brand"
                  href="/assurance/engagements"
                />
              </li>
              <li>
                <KpiCard
                  label="未解決 High Issue"
                  value={totals.issues}
                  suffix="件"
                  tone={totals.issues > 0 ? 'danger' : 'success'}
                  href="/assurance/engagements"
                />
              </li>
              <li>
                <KpiCard
                  label="Snapshot 後変更"
                  value={totals.changes}
                  suffix="件"
                  tone={totals.changes > 0 ? 'danger' : 'success'}
                  href="/assurance/engagements"
                />
              </li>
              <li>
                <KpiCard
                  label="期限接近（60日以内）"
                  value={upcoming}
                  suffix="件"
                  tone={upcoming > 0 ? 'warning' : 'neutral'}
                  href="/assurance/engagements"
                />
              </li>
            </ul>

            <Card className="overflow-hidden">
              <SectionTitle title={`案件一覧（${rows.length}）`} />
              <div className="t4d-scroll-x">
                <Table>
                  <THead>
                    <TR>
                      <TH>Client</TH>
                      <TH>Period</TH>
                      <TH>保証水準</TH>
                      <TH className="w-[140px]">Progress</TH>
                      <TH align="right">PBC</TH>
                      <TH align="right">Testing</TH>
                      <TH align="right">Issues</TH>
                      <TH align="right">Review</TH>
                      <TH align="right">Snapshot後変更</TH>
                      <TH>Deadline</TH>
                      <TH>Sign-off</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {rows.map((row) => {
                      const remaining = daysUntilJst(row.engagement.deadlineDate, FIXTURE_TODAY);
                      return (
                        <TR key={row.engagement.id}>
                          <TD>
                            <Link
                              href={`/assurance/engagements/${row.engagement.id}/overview`}
                              className="font-medium text-brand-800 hover:underline"
                            >
                              {row.clientName}
                            </Link>
                            <div className="text-[11px] text-ink-muted">{row.engagement.code}</div>
                          </TD>
                          <TD>{row.periodCode}</TD>
                          <TD>
                            <Badge tone="neutral">
                              {row.engagement.assuranceLevel === 'limited' ? '限定的' : '合理的'}
                            </Badge>
                          </TD>
                          <TD>
                            <div className="flex items-center gap-1.5">
                              <Progress
                                value={row.progressPercent}
                                label={`${row.clientName} の進捗`}
                              />
                              <span className="tnum w-8 text-right text-[11px] text-ink-muted">
                                {row.progressPercent}%
                              </span>
                            </div>
                          </TD>
                          <TD align="right">
                            {row.pbcOutstanding > 0 ? (
                              <span className="font-medium text-[#8a5d00]">
                                {row.pbcOutstanding}
                              </span>
                            ) : (
                              0
                            )}
                          </TD>
                          <TD align="right">{row.testsPending}</TD>
                          <TD align="right">
                            {row.openHighIssues > 0 ? (
                              <span className="font-medium text-danger">{row.openHighIssues}</span>
                            ) : (
                              0
                            )}
                          </TD>
                          <TD align="right">{row.reviewPending}</TD>
                          <TD align="right">
                            {row.changesSinceSnapshot > 0 ? (
                              <span className="font-medium text-danger">
                                {row.changesSinceSnapshot}
                              </span>
                            ) : (
                              0
                            )}
                          </TD>
                          <TD className="whitespace-nowrap">
                            {formatJstDate(row.engagement.deadlineDate)}
                            {remaining !== null && (
                              <span className="ml-1 text-[11px] text-ink-muted">
                                （あと {remaining} 日）
                              </span>
                            )}
                          </TD>
                          <TD>
                            {row.signoffStages.length === 0 ? (
                              <span className="text-[11px] text-ink-muted">未着手</span>
                            ) : (
                              <span className="flex flex-wrap gap-0.5">
                                {row.signoffStages.map((stage) => (
                                  <Badge key={stage} tone="success">
                                    {stage}
                                  </Badge>
                                ))}
                              </span>
                            )}
                          </TD>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
              </div>
            </Card>
          </>
        )}
      </div>
    </>
  );
}
