import Link from 'next/link';
import { AlertTriangle, ArrowRight, CalendarClock, History, ListTodo } from 'lucide-react';
import { PriorityBadge, SeverityBadge } from '@/components/shared/badges';
import { KpiCard, PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { FIXTURE_TODAY } from '@/lib/config';
import { daysUntilJst, formatJst, formatJstDate } from '@/lib/format/datetime';
import { loadEnterpriseDashboard } from '@/lib/services/enterprise-data';
import { loadEnterpriseShell } from '@/lib/services/shell';

export const metadata = { title: 'ホーム' };

export default async function EnterpriseDashboardPage() {
  const shell = await loadEnterpriseShell();
  // KPI はすべて DB 側の count で求める（全件をアプリへ読み込まない）
  const data = await loadEnterpriseDashboard(
    shell.db,
    shell.ctx,
    shell.currentPeriod,
    shell.units,
    shell.metrics,
  );

  const base = '/enterprise/data';

  return (
    <>
      <PageHeader
        title="ホーム"
        description={
          <>
            {shell.ctx.workspace.organizationName} ／ {shell.currentPeriod.label} ／ 提出期限{' '}
            {formatJstDate(shell.currentPeriod.submissionDueDate)}
          </>
        }
        breadcrumbs={[{ label: '企業ワークスペース' }, { label: 'ホーム' }]}
      />

      <div className="space-y-3 p-4">
        {/* KPI: クリックで必ず対象一覧へ Filter 付き遷移する（指示書 15.1） */}
        <section aria-label="主要指標">
          <ul className="grid grid-cols-7 gap-2">
            <li>
              <KpiCard
                label="期限超過"
                value={data.overdueCount}
                suffix="件"
                tone={data.overdueCount > 0 ? 'danger' : 'success'}
                href="/enterprise/workflows?flag=overdue"
                hint="タスク・PBC 依頼"
              />
            </li>
            <li>
              <KpiCard
                label="未提出"
                value={data.notSubmittedCount}
                suffix="件"
                tone={data.notSubmittedCount > 0 ? 'warning' : 'success'}
                href={`${base}?status=not_started&status=draft`}
              />
            </li>
            <li>
              <KpiCard
                label="Validation Error"
                value={data.validationErrorCount}
                suffix="件"
                tone={data.validationErrorCount > 0 ? 'danger' : 'success'}
                href={`${base}?flag=validation_error`}
              />
            </li>
            <li>
              <KpiCard
                label="Evidence 不足"
                value={data.missingEvidenceCount}
                suffix="件"
                tone={data.missingEvidenceCount > 0 ? 'warning' : 'success'}
                href={`${base}?flag=missing_evidence`}
              />
            </li>
            <li>
              <KpiCard
                label="Review 待ち"
                value={data.reviewPendingCount}
                suffix="件"
                tone="brand"
                href={`${base}?flag=review_pending`}
              />
            </li>
            <li>
              <KpiCard
                label="承認率"
                value={data.approvalRate}
                suffix="%"
                tone={data.approvalRate >= 80 ? 'success' : 'brand'}
                href={`${base}?status=approved`}
              />
            </li>
            <li>
              <KpiCard
                label="CDP 準備度"
                value={data.cdpReadiness}
                suffix="%"
                tone={data.cdpReadiness >= 60 ? 'success' : 'warning'}
                href="/enterprise/disclosures/cdp"
              />
            </li>
          </ul>
        </section>

        <div className="grid grid-cols-3 gap-3">
          {/* 拠点別進捗 */}
          <Card className="col-span-2">
            <SectionTitle
              title="拠点別進捗"
              action={
                <Link
                  href="/enterprise/organizations"
                  className="inline-flex items-center gap-1 text-[12px] text-brand-700 hover:underline"
                >
                  組織・拠点 <ArrowRight className="size-3" aria-hidden="true" />
                </Link>
              }
            />
            <div className="t4d-scroll-x">
              <Table>
                <THead>
                  <TR>
                    <TH>組織・拠点</TH>
                    <TH align="right">対象</TH>
                    <TH align="right">承認済み</TH>
                    <TH align="right">レビュー中</TH>
                    <TH align="right">未提出</TH>
                    <TH align="right">エラー</TH>
                    <TH className="w-[160px]">進捗</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.unitProgress.map((row) => (
                    <TR key={row.unit.id}>
                      <TD>
                        <Link
                          href={`${base}?unit=${row.unit.id}`}
                          className="text-brand-700 hover:underline"
                        >
                          {row.unit.name}
                        </Link>
                        <span className="ml-1 text-[11px] text-ink-muted">{row.unit.code}</span>
                      </TD>
                      <TD align="right">{row.total}</TD>
                      <TD align="right">{row.approved}</TD>
                      <TD align="right">{row.submitted}</TD>
                      <TD align="right">{row.notStarted}</TD>
                      <TD align="right">
                        {row.errors > 0 ? (
                          <Link
                            href={`${base}?unit=${row.unit.id}&flag=validation_error`}
                            className="font-medium text-danger hover:underline"
                          >
                            {row.errors}
                          </Link>
                        ) : (
                          <span className="text-ink-muted">0</span>
                        )}
                      </TD>
                      <TD>
                        <div className="flex items-center gap-2">
                          <Progress
                            value={row.progressPercent}
                            label={`${row.unit.name} の承認進捗`}
                            tone={row.progressPercent >= 80 ? 'success' : 'brand'}
                          />
                          <span className="tnum w-9 shrink-0 text-right text-[11px] text-ink-muted">
                            {row.progressPercent}%
                          </span>
                        </div>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </Card>

          {/* 今日のタスク */}
          <Card>
            <SectionTitle
              title="今日のタスク（7 日以内）"
              action={
                <Link
                  href="/enterprise/workflows"
                  className="inline-flex items-center gap-1 text-[12px] text-brand-700 hover:underline"
                >
                  すべて <ArrowRight className="size-3" aria-hidden="true" />
                </Link>
              }
            />
            {data.todaysTasks.length === 0 ? (
              <EmptyState
                title="期限が近いタスクはありません"
                icon={<ListTodo className="size-5" aria-hidden="true" />}
              />
            ) : (
              <ul className="divide-y divide-line">
                {data.todaysTasks.map((task) => {
                  const remaining = daysUntilJst(task.dueDate, FIXTURE_TODAY);
                  return (
                    <li key={task.id} className="px-3 py-2">
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-[12px] text-ink">{task.title}</span>
                        <PriorityBadge priority={task.priority} />
                      </div>
                      <div className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-muted">
                        <CalendarClock className="size-3" aria-hidden="true" />
                        期限 {formatJstDate(task.dueDate)}
                        {remaining !== null && <span>（あと {remaining} 日）</span>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {/* 重要アラート */}
          <Card>
            <SectionTitle
              title="重要アラート（検証エラー）"
              action={
                <Link
                  href="/enterprise/alerts"
                  className="inline-flex items-center gap-1 text-[12px] text-brand-700 hover:underline"
                >
                  アラートセンター <ArrowRight className="size-3" aria-hidden="true" />
                </Link>
              }
            />
            {data.topAlerts.length === 0 ? (
              <EmptyState
                title="検証エラーはありません"
                icon={<AlertTriangle className="size-5" aria-hidden="true" />}
              />
            ) : (
              <ul className="divide-y divide-line">
                {data.topAlerts.map((alert) => (
                  <li key={alert.id} className="flex items-start gap-2 px-3 py-2">
                    <SeverityBadge severity={alert.severity} />
                    <Link
                      href={`/enterprise/data/${alert.dataPointId}`}
                      className="text-[12px] text-ink hover:text-brand-700 hover:underline"
                    >
                      {alert.message}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* 期限超過タスク + 直近アクティビティ */}
          <div className="space-y-3">
            <Card>
              <SectionTitle title="期限超過" />
              {data.overdueTasks.length === 0 ? (
                <EmptyState title="期限超過はありません" />
              ) : (
                <ul className="divide-y divide-line">
                  {data.overdueTasks.map((task) => (
                    <li key={task.id} className="flex items-center justify-between gap-2 px-3 py-2">
                      <span className="text-[12px] text-ink">{task.title}</span>
                      <Badge tone="danger">
                        {Math.abs(daysUntilJst(task.dueDate, FIXTURE_TODAY) ?? 0)} 日超過
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <SectionTitle title="直近のアクティビティ" />
              {data.recentActivity.length === 0 ? (
                <EmptyState title="更新履歴がありません" icon={<History className="size-5" />} />
              ) : (
                <ul className="divide-y divide-line">
                  {data.recentActivity.map((item) => (
                    <li key={item.id} className="px-3 py-1.5">
                      <div className="text-[12px] text-ink">{item.label}</div>
                      <div className="text-[11px] text-ink-muted">{formatJst(item.at)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>

        {data.changedAfterApprovalCount > 0 && (
          <Card className="border-warning/40 bg-warning-soft">
            <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-[#8a5d00]">
              <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              承認後に変更された Data Point が {data.changedAfterApprovalCount} 件あります。
              保証対象の場合、監査法人側へ変更として通知されます。
              <Link
                href={`${base}?flag=changed_after_approval`}
                className="ml-auto font-medium underline"
              >
                対象を確認
              </Link>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
