import Link from 'next/link';
import { ClipboardCheck, Inbox, ListTodo, Undo2 } from 'lucide-react';
import { PbcStatusBadge, PriorityBadge } from '@/components/shared/badges';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { describeReferenceDate } from '@/lib/clock';
import { daysUntilJst, formatJst, formatJstDate, isOverdue } from '@/lib/format/datetime';
import { listMyReviewTasks } from '@/lib/services/disclosure-review';
import { isDisclosureFirstEnabled } from '@/lib/services/feature-settings';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { respondPbcAction } from '../actions';
import { ReviewRequestStatusBadge } from '../disclosure-projects/[projectId]/blocks/status-badges';

export const metadata = { title: 'ワークフロー' };

export default async function WorkflowsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const organizationId = ctx.workspace.organizationId;
  const overdueOnly = params.flag === 'overdue';

  // 期限の判定の基準日（デモは固定の基準日、Supabase Mode は実時計。src/lib/clock.ts）
  const reference = describeReferenceDate();
  const today = reference.date;

  const [tasks, pbcRequests, myReviews, disclosureFirst] = await Promise.all([
    db.select('tasks', {
      where: { organizationId, status: { notIn: ['done', 'cancelled'] } },
      orderBy: { column: 'dueDate' },
    }),
    // 企業側からは draft の依頼は見えない（RLS と同じ条件をアプリ層でも適用）
    db.select('pbcRequests', {
      where: { clientOrganizationId: organizationId, status: { neq: 'draft' } },
      orderBy: { column: 'dueDate' },
    }),
    listMyReviewTasks(db, ctx),
    isDisclosureFirstEnabled(db, ctx),
  ]);
  // 開示優先モードが OFF の組織は従来の画面のまま。ただし自分の番のレビュー・差戻しがあれば
  // （URL から開示の画面を使っている場合など）見落とさないよう出す（A39）
  const showReviews =
    disclosureFirst || myReviews.awaitingMe.length > 0 || myReviews.returnedToMe.length > 0;

  const responses =
    pbcRequests.length > 0
      ? await db.select('pbcResponses', {
          where: { requestId: { in: pbcRequests.map((r) => r.id) } },
          orderBy: { column: 'submittedAt', dir: 'desc' },
        })
      : [];

  const visibleTasks = overdueOnly ? tasks.filter((t) => isOverdue(t.dueDate, today)) : tasks;
  const canRespond = can(ctx, 'enterprise.pbc.respond');

  return (
    <>
      <PageHeader
        title="ワークフロー"
        description={
          reference.label
            ? `タスク・承認・監査法人からの資料依頼（PBC）を一元管理します。期限は${reference.label}で判定しています。`
            : 'タスク・承認・監査法人からの資料依頼（PBC）を一元管理します。'
        }
        breadcrumbs={[{ label: '企業ワークスペース' }, { label: 'ワークフロー' }]}
        actions={
          overdueOnly ? (
            <Button variant="outline" size="sm" asChild>
              <Link href="/enterprise/workflows">すべて表示</Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" asChild>
              <Link href="/enterprise/workflows?flag=overdue">期限超過のみ</Link>
            </Button>
          )
        }
      />

      <div className="space-y-3 p-4">
        {/* 自分のレビュー: 自分の段階にある開示本文のレビュー・最終承認（§4.1 タスク・承認） */}
        {showReviews && (
          <Card className="overflow-hidden">
            <SectionTitle title={`自分のレビュー（${myReviews.awaitingMe.length}）`} />
            {myReviews.awaitingMe.length === 0 ? (
              <EmptyState
                title="あなたの番のレビュー・承認はありません"
                description="開示本文のレビュー担当・最終承認者に指定された依頼が、あなたの段階になるとここに並びます。"
                icon={<ClipboardCheck className="size-5" aria-hidden="true" />}
              />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>節</TH>
                    <TH>プロジェクト</TH>
                    <TH>あなたの段階</TH>
                    <TH>審査する版</TH>
                    <TH>依頼者</TH>
                    <TH>依頼日時</TH>
                  </TR>
                </THead>
                <TBody>
                  {myReviews.awaitingMe.map((item) => (
                    <TR key={item.id}>
                      <TD>
                        <Link
                          href={`/enterprise/disclosure-projects/${item.projectId}/blocks/${item.blockId}`}
                          className="font-medium text-brand-700 underline-offset-2 hover:underline"
                        >
                          {item.blockTitle}
                        </Link>
                      </TD>
                      <TD className="text-[12px] text-ink-muted">{item.projectName}</TD>
                      <TD>
                        <Badge tone={item.myStage === 'final' ? 'warning' : 'brand'}>
                          <ClipboardCheck className="size-3" aria-hidden="true" />
                          {item.myStage === 'final' ? '最終承認（社内）' : 'レビュー（第 1 段）'}
                        </Badge>
                      </TD>
                      <TD className="tnum">版 {item.targetVersionNo ?? '—'}</TD>
                      <TD>{item.requestedByName}</TD>
                      <TD className="text-[12px]">{formatJst(item.createdAt)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
            {myReviews.returnedToMe.length > 0 && (
              <div className="border-t border-line px-3 py-2">
                <h3 className="flex items-center gap-1 text-[12px] font-semibold text-ink">
                  <Undo2 className="size-3.5" aria-hidden="true" />
                  差し戻された依頼（{myReviews.returnedToMe.length}）
                </h3>
                <ul className="mt-1 space-y-1 text-[12px]">
                  {myReviews.returnedToMe.map((item) => {
                    const returned = [...item.events].reverse().find((e) => e.label === '差戻し');
                    return (
                      <li key={item.id} className="flex flex-wrap items-center gap-1.5">
                        <Link
                          href={`/enterprise/disclosure-projects/${item.projectId}/blocks/${item.blockId}`}
                          className="text-brand-700 underline-offset-2 hover:underline"
                        >
                          {item.blockTitle}（版 {item.targetVersionNo ?? '—'}）
                        </Link>
                        <ReviewRequestStatusBadge status={item.status} />
                        {returned && (
                          <span className="text-ink-muted">
                            {returned.actorName}: {returned.reason}
                            {returned.paragraphId ? `（段落 ${returned.paragraphId}）` : ''}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </Card>
        )}

        <Card className="overflow-hidden">
          <SectionTitle title={`タスク（${visibleTasks.length}）`} />
          {visibleTasks.length === 0 ? (
            <EmptyState
              title="対応中のタスクはありません"
              icon={<ListTodo className="size-5" aria-hidden="true" />}
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>タスク</TH>
                  <TH>対象</TH>
                  <TH>優先度</TH>
                  <TH>期限</TH>
                  <TH>状態</TH>
                </TR>
              </THead>
              <TBody>
                {visibleTasks.map((task) => {
                  const remaining = daysUntilJst(task.dueDate, today);
                  const overdue = isOverdue(task.dueDate, today);
                  return (
                    <TR key={task.id}>
                      <TD>{task.title}</TD>
                      <TD className="text-[11px] text-ink-muted">{task.targetType}</TD>
                      <TD>
                        <PriorityBadge priority={task.priority} />
                      </TD>
                      <TD>
                        <span className={overdue ? 'font-medium text-danger' : ''}>
                          {formatJstDate(task.dueDate)}
                        </span>
                        {remaining !== null && (
                          <span className="ml-1 text-[11px] text-ink-muted">
                            {overdue
                              ? `（${Math.abs(remaining)} 日超過）`
                              : `（あと ${remaining} 日）`}
                          </span>
                        )}
                      </TD>
                      <TD>
                        <Badge tone={task.status === 'in_progress' ? 'brand' : 'neutral'}>
                          {task.status}
                        </Badge>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </Card>

        <Card>
          <SectionTitle title={`監査法人からの資料依頼（PBC）（${pbcRequests.length}）`} />
          {pbcRequests.length === 0 ? (
            <EmptyState
              title="資料依頼はありません"
              icon={<Inbox className="size-5" aria-hidden="true" />}
            />
          ) : (
            <ul className="divide-y divide-line">
              {pbcRequests.map((request) => {
                const latest = responses.find((r) => r.requestId === request.id);
                const overdue = isOverdue(request.dueDate, today);
                return (
                  <li key={request.id} className="p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[12px] text-ink-muted">{request.code}</span>
                      <span className="text-[13px] font-medium text-ink">{request.title}</span>
                      <PbcStatusBadge
                        status={overdue && request.status === 'sent' ? 'overdue' : request.status}
                      />
                      <PriorityBadge priority={request.priority} />
                      <span
                        className={`ml-auto text-[11px] ${overdue ? 'font-medium text-danger' : 'text-ink-muted'}`}
                      >
                        期限 {formatJstDate(request.dueDate)}
                      </span>
                    </div>
                    <p className="mt-1 text-[12px] text-ink-muted">{request.description}</p>

                    {latest && (
                      <div className="mt-2 rounded-t4d border border-line bg-surface-muted p-2">
                        <div className="text-[11px] font-medium text-ink">提出済みの回答</div>
                        <p className="text-[12px] text-ink">{latest.body}</p>
                        <div className="text-[11px] text-ink-muted">
                          {formatJst(latest.submittedAt)}
                          {latest.decision === 'accepted' && ' ／ 監査法人が受理'}
                          {latest.decision === 'rejected' &&
                            ` ／ 差戻し: ${latest.rejectReason ?? ''}`}
                        </div>
                      </div>
                    )}

                    {canRespond && request.status !== 'accepted' && request.status !== 'closed' && (
                      <form action={respondPbcAction} className="mt-2 space-y-1.5">
                        <input type="hidden" name="requestId" value={request.id} />
                        <Textarea
                          name="body"
                          rows={2}
                          required
                          placeholder="回答内容を入力してください"
                          aria-label={`${request.code} への回答`}
                        />
                        <div className="flex items-center gap-2">
                          <input
                            type="file"
                            name="file"
                            className="text-[12px] file:mr-2 file:rounded-t4d file:border file:border-line file:bg-surface file:px-2 file:py-1 file:text-[12px]"
                            aria-label={`${request.code} への添付ファイル`}
                          />
                          <Button type="submit" size="sm">
                            回答を提出
                          </Button>
                        </div>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
