import Link from 'next/link';
import { Send } from 'lucide-react';
import { ActionButton } from '@/components/shared/action-button';
import { PriorityBadge } from '@/components/shared/badges';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { FlashMessage } from '@/components/shared/flash';
import { SegmentedFilter } from '@/components/shared/nav-tabs';
import { PageActions } from '@/components/shared/page-actions';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { SemanticBadge, StatusBadge } from '@/components/shared/status-badge';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { requireAssuranceContext } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { getReferenceDate } from '@/lib/clock';
import { formatJst, formatJstDate, isOverdue } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import { loadEngagementOr404, loadDataRoom } from '@/lib/services/assurance';
import type { PbcRequest, PbcStatus } from '@/types/domain';
import { createPbcAction, decidePbcAction } from '../../../actions';
import { EngagementHeader } from '../engagement-header';

export const metadata = { title: 'PBC／資料依頼' };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * 状態の盤面（全 9 状態をどれかの列に必ず入れる）。
 * 以前は rejected / overdue がどの列にも入らず、差戻し中の依頼が盤面から消えていた。
 * 概要・案件ホームの「未完了」（受理・クローズ以外）からも絞り込みで来る
 */
const BOARD: ReadonlyArray<{ key: string; label: string; statuses: readonly PbcStatus[] }> = [
  { key: 'draft', label: '下書き', statuses: ['draft'] },
  { key: 'sent', label: '送付済み・未提出', statuses: ['sent', 'acknowledged', 'overdue'] },
  { key: 'submitted', label: '提出済み・確認中', statuses: ['submitted', 'under_review'] },
  { key: 'rejected', label: '差戻し・再提出待ち', statuses: ['rejected'] },
  { key: 'closed', label: '受理・クローズ', statuses: ['accepted', 'closed'] },
];
const OPEN_EXCLUDES: readonly PbcStatus[] = ['accepted', 'closed'];

export default async function RequestsPage({
  params,
  searchParams,
}: {
  params: Promise<{ engagementId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { engagementId } = await params;
  const query = await searchParams;
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const context = await loadEngagementOr404(db, ctx, engagementId);
  const basePath = `/assurance/engagements/${engagementId}/requests`;

  const requests = await db.select('pbcRequests', {
    where: { engagementId },
    orderBy: { column: 'code' },
  });
  const responses =
    requests.length > 0
      ? await db.select('pbcResponses', {
          where: { requestId: { in: requests.map((r) => r.id) } },
          orderBy: { column: 'submittedAt', dir: 'desc' },
        })
      : [];

  const canManage = can(ctx, 'assurance.pbc.manage');
  const panelOpen = canManage && isCreatePanelOpen(query);
  // 期限の基準日は 1 か所（デモは FIXTURE_TODAY、Supabase Mode は実時計）
  const today = getReferenceDate();

  // 依頼の対象に選べるのは Data Room に共有済みの Data Point だけ
  const { rows: dataRoomRows } = await loadDataRoom(db, ctx, engagementId);
  const targetOptions = dataRoomRows.map((row) => ({
    id: row.dataPointId,
    label: `${row.metric?.name ?? '指標'} ／ ${row.unit?.name ?? '組織'}`,
  }));
  const targetLabel = (id: string): string =>
    targetOptions.find((option) => option.id === id)?.label ?? id.slice(0, 8);

  // 絞り込み（URL の filter。盤面の列と同じ区分）
  const filter = typeof query.filter === 'string' ? query.filter : 'all';
  const inFilter = (request: PbcRequest): boolean => {
    if (filter === 'open') return !OPEN_EXCLUDES.includes(request.status);
    const column = BOARD.find((b) => b.key === filter);
    return column ? column.statuses.includes(request.status) : true;
  };
  const shown = requests.filter(inFilter);
  const filterHref = (key: string) => {
    const next = new URLSearchParams();
    if (key !== 'all') next.set('filter', key);
    const qs = next.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };
  const openCount = requests.filter((r) => !OPEN_EXCLUDES.includes(r.status)).length;

  return (
    <>
      <EngagementHeader
        context={context}
        page="PBC／資料依頼"
        actions={
          <PageActions
            primary={{
              kind: 'link',
              id: 'create-pbc',
              shortcut: 'new',
              label: '資料依頼を作成',
              icon: <Send aria-hidden="true" />,
              href: createPanelHref(basePath, query, { open: true }),
              // 作成欄を開いているときは、欄の中の「送付」が主操作
              hidden: !canManage || panelOpen,
            }}
          />
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        {canManage && (
          <CreatePanel
            id="create-pbc"
            title="資料依頼を作成"
            searchParams={query}
            closeHref={createPanelHref(basePath, query, { open: false })}
            description="送付すると企業側の「自分の作業・回答」に表示されます。内部メモは企業側に表示されません。"
          >
            <form action={createPbcAction} className="space-y-2">
              <input type="hidden" name="engagementId" value={engagementId} />
              <div className="grid grid-cols-6 gap-2">
                <Field label="件名" name="title" required className="col-span-2">
                  {(p) => <Input {...p} name="title" />}
                </Field>
                <Field label="期限" name="dueDate" required hint="既定は案件の期限">
                  {(p) => (
                    <Input
                      {...p}
                      name="dueDate"
                      type="date"
                      defaultValue={context.engagement.deadlineDate}
                    />
                  )}
                </Field>
                <Field label="優先度" name="priority" required>
                  {(p) => (
                    <NativeSelect {...p} name="priority" defaultValue="medium">
                      <option value="critical">最優先</option>
                      <option value="high">高</option>
                      <option value="medium">中</option>
                      <option value="low">低</option>
                    </NativeSelect>
                  )}
                </Field>
                <Field
                  label="対象"
                  name="targetId"
                  hint="Data Room に共有済みのデータから選びます"
                  className="col-span-2"
                >
                  {(p) => (
                    <NativeSelect {...p} name="targetId" defaultValue="">
                      <option value="">指定しない</option>
                      {targetOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
                <Field
                  label="依頼内容（企業側に表示されます）"
                  name="description"
                  className="col-span-3"
                >
                  {(p) => <Textarea {...p} name="description" rows={2} />}
                </Field>
                <Field
                  label="内部メモ（監査法人内部限定・企業側からは見えません）"
                  name="internalNote"
                  className="col-span-3"
                >
                  {(p) => <Textarea {...p} name="internalNote" rows={2} />}
                </Field>
              </div>
              <SubmitButton
                variant="primary"
                size="sm"
                icon={<Send aria-hidden="true" />}
                pendingLabel="送付中…"
              >
                送付
              </SubmitButton>
            </form>
          </CreatePanel>
        )}

        <Section
          title={`資料依頼（${requests.length}）`}
          summary={filter === 'all' ? undefined : `表示 ${shown.length} 件`}
        >
          {/* 状態の盤面。押すとその状態に絞り込む（列の合計＝依頼の総数） */}
          <SegmentedFilter
            ariaLabel="資料依頼の状態で絞り込む"
            current={BOARD.some((b) => b.key === filter) || filter === 'open' ? filter : 'all'}
            className="mb-2"
            items={[
              { key: 'all', label: 'すべて', href: filterHref('all'), count: requests.length },
              { key: 'open', label: '未完了', href: filterHref('open'), count: openCount },
              ...BOARD.map((column) => ({
                key: column.key,
                label: column.label,
                href: filterHref(column.key),
                count: requests.filter((r) => column.statuses.includes(r.status)).length,
                attention:
                  (column.key === 'submitted' || column.key === 'rejected') &&
                  requests.some((r) => column.statuses.includes(r.status)),
              })),
            ]}
          />

          {requests.length === 0 ? (
            canManage ? (
              <EmptyState
                kind="no-data"
                size="compact"
                title="資料依頼はまだありません"
                description="企業へ追加の資料を依頼すると、回答と添付をここで確認できます。"
                action={
                  <Link
                    href={createPanelHref(basePath, query, { open: true })}
                    className="text-small text-brand-700 hover:underline"
                  >
                    最初の資料依頼を作成
                  </Link>
                }
              />
            ) : (
              <EmptyState
                kind="not-applicable"
                size="compact"
                title="資料依頼はまだありません"
                description="資料依頼は、マネージャー・担当者が作成します。"
              />
            )
          ) : shown.length === 0 ? (
            <EmptyState kind="filtered" size="compact" resetHref={filterHref('all')} />
          ) : (
            <ul className="divide-y divide-line rounded-t4d border border-line">
              {shown.map((request) => {
                const response = responses.find((r) => r.requestId === request.id);
                const overdue = isOverdue(request.dueDate, today);
                return (
                  <li key={request.id} className="p-3" data-t4d-record="">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-small text-ink-muted">{request.code}</span>
                      <span className="text-body font-medium text-ink">{request.title}</span>
                      <StatusBadge
                        domain="pbc"
                        value={overdue && request.status === 'sent' ? 'overdue' : request.status}
                      />
                      <PriorityBadge priority={request.priority} />
                      <span
                        className={`ml-auto text-caption ${overdue ? 'font-medium text-danger' : 'text-ink-muted'}`}
                      >
                        期限 {formatJstDate(request.dueDate)}
                      </span>
                    </div>
                    {request.targetType === 'data_point' && request.targetId && (
                      <p className="mt-1 text-caption text-ink-muted">
                        対象: {targetLabel(request.targetId)}
                      </p>
                    )}
                    <p className="mt-1 text-small text-ink-muted">{request.description}</p>

                    {request.internalNote && (
                      <p className="mt-1 flex items-start gap-1.5 rounded-t4d bg-surface-muted p-2 text-caption text-ink-muted">
                        <SemanticBadge semantic="info" label="内部メモ" />
                        <span>{request.internalNote}</span>
                      </p>
                    )}

                    {response ? (
                      <div className="mt-2 rounded-t4d border border-line p-2">
                        <div className="text-caption font-medium text-ink">
                          企業側の回答（{formatJst(response.submittedAt)}）
                        </div>
                        <p className="text-small text-ink">{response.body}</p>
                        {response.fileVersionIds.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {response.fileVersionIds.map((id) => (
                              <a
                                key={id}
                                href={`/api/files/signed-url?fileVersionId=${id}&engagementId=${engagementId}`}
                                className="text-caption text-brand-700 hover:underline"
                              >
                                添付を開く
                              </a>
                            ))}
                          </div>
                        )}
                        {response.decision ? (
                          <SemanticBadge
                            semantic={response.decision === 'accepted' ? 'done' : 'returned'}
                            label={response.decision === 'accepted' ? '受理済み' : '差戻し済み'}
                            className="mt-1"
                          />
                        ) : (
                          canManage && (
                            // 行の主操作は「受理」（secondary）、差戻しは理由必須の確認（plan §1.15・§1.16 区分 2）
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                              <ActionButton
                                size="xs"
                                action={{
                                  kind: 'submit',
                                  id: `accept-${response.id}`,
                                  label: '受理',
                                  action: decidePbcAction,
                                  fields: {
                                    engagementId,
                                    responseId: response.id,
                                    decision: 'accepted',
                                  },
                                }}
                              />
                              <ActionButton
                                size="xs"
                                action={{
                                  kind: 'confirm',
                                  id: `reject-${response.id}`,
                                  label: '差戻し…',
                                  action: decidePbcAction,
                                  fields: {
                                    engagementId,
                                    responseId: response.id,
                                    decision: 'rejected',
                                  },
                                  confirm: {
                                    tier: 'bulk',
                                    title: 'この回答を差し戻しますか',
                                    scope: `${request.code} ${request.title}`,
                                    consequences: [
                                      '企業側に差戻しの理由が表示され、再提出を待つ状態になります。',
                                    ],
                                    reason: {
                                      name: 'rejectReason',
                                      label: '差戻し理由',
                                      required: true,
                                    },
                                    confirmLabel: '差し戻す',
                                  },
                                }}
                              />
                            </div>
                          )
                        )}
                      </div>
                    ) : (
                      <p className="mt-1 text-caption text-ink-muted">
                        企業側からの回答は未提出です。
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}
