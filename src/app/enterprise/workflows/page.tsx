import Link from 'next/link';
import { ArrowRight, ClipboardCheck, MessagesSquare, Paperclip, Undo2 } from 'lucide-react';
import { PbcStatusBadge, PriorityBadge, TaskStatusBadge } from '@/components/shared/badges';
import { FlashMessage } from '@/components/shared/flash';
import { SegmentedFilter } from '@/components/shared/nav-tabs';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Collapsible } from '@/components/ui/collapsible';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { getSession } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { describeReferenceDate } from '@/lib/clock';
import { taskTargetTypeLabel } from '@/lib/domain/disclosure-status';
import { daysUntilJst, formatJst, formatJstDate, isOverdue } from '@/lib/format/datetime';
import { loadClientAssuranceComments } from '@/lib/services/assurance';
import { listMyReviewTasks } from '@/lib/services/disclosure-review';
import { getDb } from '@/lib/repositories';
import { isDisclosureFirstEnabled } from '@/lib/services/feature-settings';
import { loadMyWork } from '@/lib/services/my-work';
import { loadEnterpriseShell } from '@/lib/services/shell';
import type { MyWorkItem, MyWorkKind } from '@/lib/ui/my-work';
import { cn } from '@/lib/utils';
import { respondPbcAction } from '../actions';
import { ReviewRequestStatusBadge } from '../disclosure-projects/[projectId]/blocks/status-badges';
import { taskTargetHref } from './task-target';

/**
 * タブの題名もメニュー・見出しと同じ語にする（plan §1.9 名称の統一。開示優先モードは「自分の作業・レビュー」）。
 * 題名の決定で画面を落とさない（ログイン前・権限外は従来の名前）
 */
export async function generateMetadata(): Promise<{ title: string }> {
  try {
    const session = await getSession();
    if (!session?.context || session.context.workspace.organizationType !== 'enterprise') {
      return { title: 'ワークフロー' };
    }
    const enabled = await isDisclosureFirstEnabled(await getDb(), session.context);
    return { title: enabled ? '自分の作業・レビュー' : 'ワークフロー' };
  } catch {
    return { title: 'ワークフロー' };
  }
}

/** 「直す・入力する」の節に並べる自分の作業（ホームの MyWork と同じ定義・同じ行き先） */
const FIX_KINDS: readonly MyWorkKind[] = ['data-returned', 'data-enter'];
/** 「確認する・承認する」の節に並べる自分の作業 */
const CHECK_KINDS: readonly MyWorkKind[] = ['data-review', 'data-approve', 'import-check'];

/** 企業が回答する番の資料依頼（受理・終了したものには回答欄を出さない） */
function awaitsClientResponse(status: string): boolean {
  return status !== 'accepted' && status !== 'closed';
}

/**
 * ワークフロー（開示優先モードでは「自分の作業・レビュー」）。plan S21。
 *
 * 中身を業務の動詞の節に並べる: 直す・入力する → 確認する・承認する → 回答する（資料依頼）→ タスク。
 * 件数・行き先はホームの「自分の作業」（loadMyWork）と同じ定義を使う（同じ事実を画面ごとに別の条件で数えない）。
 * 資料依頼の回答は行ごとの「回答を書く」を開いてから（行ごとに primary と入力欄を並べない）。
 * タスクの行は対象の画面へのリンクにする（行き止まりにしない）。
 */
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

  const [tasks, pbcRequests, myReviews, disclosureFirst, work] = await Promise.all([
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
    loadMyWork(db, ctx, { period: shell.currentPeriod, today }),
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
  // 保証側のコメント（クライアントへ共有されたもの。NF-21）。回答する番のもの（未回答）を先に並べる
  const assuranceComments = can(ctx, 'enterprise.disclosure.read')
    ? await loadClientAssuranceComments(db, ctx)
    : null;
  const unansweredComments = (assuranceComments ?? []).filter((r) => r.state === 'unanswered');
  const canRespondComments = can(ctx, 'enterprise.disclosure.write');

  // 期限超過のみ（ホームの KPI「期限超過」の行き先。タスクと資料依頼の両方を数えている）
  const visibleTasks = overdueOnly ? tasks.filter((t) => isOverdue(t.dueDate, today)) : tasks;
  const visiblePbc = overdueOnly
    ? pbcRequests.filter((r) => awaitsClientResponse(r.status) && isOverdue(r.dueDate, today))
    : pbcRequests;
  const canRespond = can(ctx, 'enterprise.pbc.respond');

  const fixItems = work.items.filter((item) => FIX_KINDS.includes(item.kind));
  const checkItems = work.items.filter((item) => CHECK_KINDS.includes(item.kind));
  const overdueCount =
    tasks.filter((t) => isOverdue(t.dueDate, today)).length +
    pbcRequests.filter((r) => awaitsClientResponse(r.status) && isOverdue(r.dueDate, today)).length;

  // 見出しはメニューの固定ラベルと同じ語（従来「ワークフロー」・開示優先「自分の作業・レビュー」）
  const title = disclosureFirst ? '自分の作業・レビュー' : 'ワークフロー';

  return (
    <>
      {/* デモの基準日で期限を判定していることは隠さない（説明の 1 行に残し、help に入れない） */}
      <PageHeader
        title={title}
        description={
          reference.label
            ? `直す・確認する・回答する作業とタスク。期限は${reference.label}で判定しています`
            : '直す・確認する・回答する作業とタスク'
        }
        help={
          <p>
            自分が次に行う作業を、業務の順（直す・入力する → 確認する・承認する → 資料依頼に回答する
            → 保証側のコメントに回答する →
            タスク）に並べます。開示本文のレビュー・最終承認があなたの段階になると「確認する・承認する」に並びます。
          </p>
        }
        autoBreadcrumbs
      />

      <div className="space-y-3 px-4 pb-4 pt-3">
        <FlashMessage searchParams={params} />
        <SegmentedFilter
          ariaLabel="表示する作業"
          current={overdueOnly ? 'overdue' : 'all'}
          items={[
            { key: 'all', label: 'すべて', href: '/enterprise/workflows' },
            {
              key: 'overdue',
              label: '期限超過のみ',
              href: '/enterprise/workflows?flag=overdue',
              count: overdueCount,
              attention: overdueCount > 0,
            },
          ]}
        />

        {!overdueOnly && (
          <Section
            id="fix"
            title={`直す・入力する（${fixItems.length + myReviews.returnedToMe.length}）`}
          >
            {fixItems.length === 0 && myReviews.returnedToMe.length === 0 ? (
              <EmptyState kind="done" size="compact" title="直すもの・入力するものはありません" />
            ) : (
              <ul className="divide-y divide-line">
                {fixItems.map((item) => (
                  <WorkRow key={item.key} item={item} />
                ))}
                {myReviews.returnedToMe.map((item) => {
                  const returned = [...item.events].reverse().find((e) => e.label === '差戻し');
                  return (
                    <li key={item.id} className="flex flex-wrap items-center gap-1.5 py-1.5">
                      <Badge tone="warning">
                        <Undo2 className="size-3" aria-hidden="true" />
                        直す
                      </Badge>
                      <Link
                        href={`/enterprise/disclosure-projects/${item.projectId}/blocks/${item.blockId}`}
                        className="text-small font-medium text-brand-700 underline-offset-2 hover:underline"
                      >
                        {item.blockTitle}（版 {item.targetVersionNo ?? '—'}）
                      </Link>
                      <ReviewRequestStatusBadge status={item.status} />
                      {returned && (
                        <span className="text-small text-ink-muted">
                          {returned.actorName}: {returned.reason}
                          {returned.paragraphId ? `（段落 ${returned.paragraphId}）` : ''}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
        )}

        {!overdueOnly && (
          <Section
            id="reviews"
            title={`確認する・承認する（${checkItems.length + myReviews.awaitingMe.length}）`}
          >
            {checkItems.length > 0 && (
              <ul className="divide-y divide-line">
                {checkItems.map((item) => (
                  <WorkRow key={item.key} item={item} />
                ))}
              </ul>
            )}
            {/* 自分のレビュー: 自分の段階にある開示本文のレビュー・最終承認（§4.1 タスク・承認） */}
            {showReviews &&
              (myReviews.awaitingMe.length === 0 ? (
                checkItems.length === 0 && (
                  <EmptyState
                    kind="done"
                    size="compact"
                    title="あなたの番のレビュー・承認はありません"
                    description="開示本文のレビュー担当・最終承認者に指定された依頼が、あなたの段階になるとここに並びます。"
                  />
                )
              ) : (
                <Table aria-label="自分のレビュー">
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
                      <TR key={item.id} data-t4d-record="">
                        <TD>
                          <Link
                            href={`/enterprise/disclosure-projects/${item.projectId}/blocks/${item.blockId}`}
                            className="font-medium text-brand-700 underline-offset-2 hover:underline"
                          >
                            {item.blockTitle}
                          </Link>
                        </TD>
                        <TD className="text-small text-ink-muted">{item.projectName}</TD>
                        <TD>
                          <Badge tone={item.myStage === 'final' ? 'warning' : 'brand'}>
                            <ClipboardCheck className="size-3" aria-hidden="true" />
                            {item.myStage === 'final' ? '最終承認（社内）' : 'レビュー（第 1 段）'}
                          </Badge>
                        </TD>
                        <TD className="tnum">版 {item.targetVersionNo ?? '—'}</TD>
                        <TD>{item.requestedByName}</TD>
                        <TD className="text-small">{formatJst(item.createdAt)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              ))}
            {!showReviews && checkItems.length === 0 && (
              <EmptyState kind="done" size="compact" title="確認・承認の待ちはありません" />
            )}
          </Section>
        )}

        <Section id="pbc" title={`監査法人からの資料依頼（PBC）（${visiblePbc.length}）`}>
          {visiblePbc.length === 0 ? (
            overdueOnly ? (
              <EmptyState
                kind="filtered"
                size="compact"
                title="期限を過ぎた資料依頼はありません"
                resetHref="/enterprise/workflows"
              />
            ) : (
              <EmptyState
                kind="not-applicable"
                size="compact"
                title="資料依頼はありません"
                description="監査法人が資料依頼（PBC）を送ると、ここに並びます。"
              />
            )
          ) : (
            <ul className="divide-y divide-line">
              {visiblePbc.map((request) => {
                const latest = responses.find((r) => r.requestId === request.id);
                const overdue = isOverdue(request.dueDate, today);
                const respondable = canRespond && awaitsClientResponse(request.status);
                return (
                  <li key={request.id} className="py-2" data-t4d-record="">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-small text-ink-muted">{request.code}</span>
                      <span className="text-body font-medium text-ink">{request.title}</span>
                      <PbcStatusBadge
                        status={overdue && request.status === 'sent' ? 'overdue' : request.status}
                      />
                      <PriorityBadge priority={request.priority} />
                      <span
                        className={cn(
                          'ml-auto text-caption',
                          overdue ? 'font-medium text-danger' : 'text-ink-muted',
                        )}
                      >
                        期限 {formatJstDate(request.dueDate)}
                        {overdue && awaitsClientResponse(request.status) && '（超過）'}
                      </span>
                    </div>
                    <p className="mt-1 text-small text-ink-muted">{request.description}</p>

                    {latest && (
                      <div className="mt-1.5 border-l-2 border-line pl-2">
                        <div className="text-caption font-medium text-ink">提出済みの回答</div>
                        <p className="text-small text-ink">{latest.body}</p>
                        <div className="text-caption text-ink-muted">
                          {formatJst(latest.submittedAt)}
                          {latest.decision === 'accepted' && ' ／ 監査法人が受理'}
                          {latest.decision === 'rejected' &&
                            ` ／ 差戻し: ${latest.rejectReason ?? ''}`}
                        </div>
                      </div>
                    )}

                    {respondable && (
                      <Collapsible
                        variant="plain"
                        summary={
                          request.status === 'rejected'
                            ? '回答を書き直す（差し戻されました）'
                            : '回答を書く'
                        }
                        className="mt-1"
                      >
                        <form action={respondPbcAction} className="space-y-1.5">
                          <input type="hidden" name="requestId" value={request.id} />
                          <Field
                            label={`${request.code} への回答`}
                            name="body"
                            id={`pbc-body-${request.id}`}
                            required
                          >
                            {(p) => (
                              <Textarea
                                {...p}
                                name="body"
                                rows={2}
                                placeholder="回答内容を入力してください"
                              />
                            )}
                          </Field>
                          <div className="flex flex-wrap items-center gap-2">
                            <label className="inline-flex items-center gap-1 text-small text-ink-muted">
                              <Paperclip className="size-3.5" aria-hidden="true" />
                              <span className="sr-only">{request.code} への</span>
                              添付ファイル（任意）
                              <input
                                type="file"
                                name="file"
                                className="text-small file:mr-2 file:rounded-t4d file:border file:border-line file:bg-surface file:px-2 file:py-1 file:text-small"
                              />
                            </label>
                            <SubmitButton size="sm" variant="secondary" pendingLabel="提出中…">
                              回答を提出
                            </SubmitButton>
                          </div>
                        </form>
                      </Collapsible>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        {!overdueOnly && assuranceComments !== null && (
          <Section
            id="assurance-comments"
            title={`保証側のコメント（未回答 ${unansweredComments.length}）`}
            actions={
              <Link
                href="/enterprise/assurance-comments"
                className="text-small text-brand-700 hover:underline"
              >
                すべて見る（{assuranceComments.length}）
              </Link>
            }
          >
            {unansweredComments.length === 0 ? (
              <EmptyState
                kind="done"
                size="compact"
                title="未回答の保証側のコメントはありません"
                description="監査法人が開示レポートの段落・数値にコメントしてクライアントへ共有すると、ここに並びます。"
              />
            ) : (
              <ul className="divide-y divide-line">
                {unansweredComments.slice(0, 5).map((row) => (
                  <li
                    key={row.note.id}
                    className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1.5"
                    data-t4d-record=""
                  >
                    <Badge tone="brand">
                      <MessagesSquare className="size-3" aria-hidden="true" />
                      回答する
                    </Badge>
                    {canRespondComments ? (
                      <Link
                        href={`/enterprise/assurance-comments?new=1&note=${encodeURIComponent(row.note.id)}#respond-note`}
                        className="text-small font-medium text-brand-700 hover:underline"
                      >
                        {row.target
                          ? `${row.target.kind === 'report_paragraph' ? '段落' : '数値'}「${row.target.place}」`
                          : '案件全体へのコメント'}
                      </Link>
                    ) : (
                      <span className="text-small font-medium text-ink">
                        {row.target ? row.target.place : '案件全体へのコメント'}
                      </span>
                    )}
                    <span className="text-caption text-ink-muted">
                      {row.engagement.code} ／ {formatJst(row.note.createdAt)}
                    </span>
                    <span className="w-full truncate text-caption text-ink-muted">
                      {row.note.body}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}

        <Section id="tasks" title={`タスク（${visibleTasks.length}）`}>
          {visibleTasks.length === 0 ? (
            overdueOnly ? (
              <EmptyState
                kind="filtered"
                size="compact"
                title="期限超過のタスクはありません"
                resetHref="/enterprise/workflows"
              />
            ) : (
              <EmptyState kind="done" size="compact" title="対応中のタスクはありません" />
            )
          ) : (
            <Table aria-label="タスク">
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
                    <TR key={task.id} data-t4d-record="">
                      <TD>
                        {/* 対象の画面へ（行き止まりにしない） */}
                        <Link
                          href={taskTargetHref(task.targetType, task.targetId)}
                          className="font-medium text-brand-700 hover:underline"
                        >
                          {task.title}
                        </Link>
                      </TD>
                      <TD className="text-caption text-ink-muted">
                        {taskTargetTypeLabel(task.targetType)}
                      </TD>
                      <TD>
                        <PriorityBadge priority={task.priority} />
                      </TD>
                      <TD>
                        <span className={overdue ? 'font-medium text-danger' : ''}>
                          {formatJstDate(task.dueDate)}
                        </span>
                        {remaining !== null && (
                          <span className="ml-1 text-caption text-ink-muted">
                            {overdue
                              ? `（${Math.abs(remaining)} 日超過）`
                              : `（あと ${remaining} 日）`}
                          </span>
                        )}
                      </TD>
                      <TD>
                        <TaskStatusBadge status={task.status} />
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </Section>
      </div>
    </>
  );
}

/** 自分の作業の 1 行（動詞・対象・期限・理由。行き先は件数を絞った一覧） */
function WorkRow({ item }: { item: MyWorkItem }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1.5">
      <Badge tone="brand">
        <ArrowRight className="size-3" aria-hidden="true" />
        {item.verb}
      </Badge>
      <Link href={item.cta.href} className="text-small font-medium text-brand-700 hover:underline">
        {item.target}
      </Link>
      {item.context && <span className="text-caption text-ink-muted">{item.context}</span>}
      {item.dueDate && (
        <span className="text-caption text-ink-muted">期限 {formatJstDate(item.dueDate)}</span>
      )}
      {item.reason && <span className="w-full text-caption text-ink-muted">{item.reason}</span>}
    </li>
  );
}
