import { Inbox, Send } from 'lucide-react';
import { PbcStatusBadge, PriorityBadge } from '@/components/shared/badges';
import { SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { requireAssuranceContext } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { FIXTURE_TODAY } from '@/lib/config';
import { formatJst, formatJstDate, isOverdue } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import { loadEngagementOr404, loadDataRoom } from '@/lib/services/assurance';
import { createPbcAction, decidePbcAction } from '../../../actions';
import { EngagementHeader } from '../engagement-header';

export const metadata = { title: 'PBC／資料依頼' };

export default async function RequestsPage({
  params,
}: {
  params: Promise<{ engagementId: string }>;
}) {
  const { engagementId } = await params;
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const context = await loadEngagementOr404(db, ctx, engagementId);

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

  // 依頼の対象に選べるのは Data Room に共有済みの Data Point だけ
  const { rows: dataRoomRows } = await loadDataRoom(db, ctx, engagementId);
  const targetOptions = dataRoomRows.map((row) => ({
    id: row.dataPointId,
    label: `${row.metric?.name ?? '指標'} ／ ${row.unit?.name ?? '組織'}`,
  }));
  const targetLabel = (id: string): string =>
    targetOptions.find((option) => option.id === id)?.label ?? id.slice(0, 8);

  // 全 9 状態をどれかの列に必ず入れる。
  // 以前は rejected / overdue がどの列にも入らず、差戻し中の依頼が盤面から消えていた。
  const board = {
    draft: requests.filter((r) => r.status === 'draft'),
    sent: requests.filter((r) => ['sent', 'acknowledged', 'overdue'].includes(r.status)),
    submitted: requests.filter((r) => ['submitted', 'under_review'].includes(r.status)),
    rejected: requests.filter((r) => r.status === 'rejected'),
    closed: requests.filter((r) => ['accepted', 'closed'].includes(r.status)),
  };

  return (
    <>
      <EngagementHeader context={context} page="PBC／資料依頼" />

      <div className="space-y-3 p-4">
        <div className="grid grid-cols-5 gap-2">
          <StatusColumn label="下書き" count={board.draft.length} />
          <StatusColumn label="送付済み・未提出" count={board.sent.length} tone="warning" />
          <StatusColumn label="提出済み・確認中" count={board.submitted.length} tone="brand" />
          <StatusColumn label="差戻し・再提出待ち" count={board.rejected.length} tone="danger" />
          <StatusColumn label="受理・クローズ" count={board.closed.length} tone="success" />
        </div>

        {canManage && (
          <Card>
            <SectionTitle title="資料依頼を作成" />
            <form action={createPbcAction} className="grid grid-cols-6 gap-2 p-3">
              <input type="hidden" name="engagementId" value={engagementId} />
              <label className="col-span-2 text-[12px] text-ink-muted">
                件名
                <Input name="title" required className="mt-0.5" />
              </label>
              <label className="col-span-1 text-[12px] text-ink-muted">
                期限
                <Input name="dueDate" type="date" required className="mt-0.5" />
              </label>
              <label className="col-span-1 text-[12px] text-ink-muted">
                優先度
                <select
                  name="priority"
                  defaultValue="medium"
                  className="mt-0.5 block h-7 w-full rounded-t4d border border-line bg-surface px-2 text-[13px]"
                >
                  <option value="critical">最優先</option>
                  <option value="high">高</option>
                  <option value="medium">中</option>
                  <option value="low">低</option>
                </select>
              </label>
              <label className="col-span-2 text-[12px] text-ink-muted">
                対象（任意）
                <select
                  name="targetId"
                  defaultValue=""
                  className="mt-0.5 block h-7 w-full rounded-t4d border border-line bg-surface px-2 text-[13px]"
                >
                  <option value="">指定しない</option>
                  {targetOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="col-span-3 text-[12px] text-ink-muted">
                依頼内容（企業側に表示されます）
                <Textarea name="description" rows={2} className="mt-0.5" />
              </label>
              <label className="col-span-3 text-[12px] text-ink-muted">
                内部メモ（監査法人内部限定・企業側からは見えません）
                <Textarea name="internalNote" rows={2} className="mt-0.5" />
              </label>
              <div className="col-span-6">
                <Button type="submit" size="sm">
                  <Send aria-hidden="true" />
                  送付
                </Button>
              </div>
            </form>
          </Card>
        )}

        <Card>
          <SectionTitle title={`資料依頼（${requests.length}）`} />
          {requests.length === 0 ? (
            <EmptyState
              title="資料依頼はありません"
              icon={<Inbox className="size-5" aria-hidden="true" />}
            />
          ) : (
            <ul className="divide-y divide-line">
              {requests.map((request) => {
                const response = responses.find((r) => r.requestId === request.id);
                const overdue = isOverdue(request.dueDate, FIXTURE_TODAY);
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
                    {request.targetType === 'data_point' && request.targetId && (
                      <p className="mt-1 text-[11px] text-ink-muted">
                        対象: {targetLabel(request.targetId)}
                      </p>
                    )}
                    <p className="mt-1 text-[12px] text-ink-muted">{request.description}</p>

                    {request.internalNote && (
                      <p className="mt-1 rounded-t4d bg-surface-muted p-2 text-[11px] text-ink-muted">
                        <Badge tone="neutral">内部メモ</Badge> {request.internalNote}
                      </p>
                    )}

                    {response ? (
                      <div className="mt-2 rounded-t4d border border-line p-2">
                        <div className="text-[11px] font-medium text-ink">
                          企業側の回答（{formatJst(response.submittedAt)}）
                        </div>
                        <p className="text-[12px] text-ink">{response.body}</p>
                        {response.fileVersionIds.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {response.fileVersionIds.map((id) => (
                              <a
                                key={id}
                                href={`/api/files/signed-url?fileVersionId=${id}&engagementId=${engagementId}`}
                                className="text-[11px] text-brand-700 hover:underline"
                              >
                                添付を開く
                              </a>
                            ))}
                          </div>
                        )}
                        {response.decision ? (
                          <Badge tone={response.decision === 'accepted' ? 'success' : 'warning'}>
                            {response.decision === 'accepted' ? '受理済み' : '差戻し済み'}
                          </Badge>
                        ) : (
                          canManage && (
                            <div className="mt-1.5 flex flex-wrap items-end gap-2">
                              <form action={decidePbcAction} className="flex items-center gap-1">
                                <input type="hidden" name="engagementId" value={engagementId} />
                                <input type="hidden" name="responseId" value={response.id} />
                                <input type="hidden" name="decision" value="accepted" />
                                <Button type="submit" size="xs">
                                  受理
                                </Button>
                              </form>
                              <form action={decidePbcAction} className="flex items-end gap-1">
                                <input type="hidden" name="engagementId" value={engagementId} />
                                <input type="hidden" name="responseId" value={response.id} />
                                <input type="hidden" name="decision" value="rejected" />
                                <Input
                                  name="rejectReason"
                                  placeholder="差戻し理由"
                                  aria-label="差戻し理由"
                                  className="w-56"
                                />
                                <Button type="submit" size="xs" variant="outline">
                                  差戻し
                                </Button>
                              </form>
                            </div>
                          )
                        )}
                      </div>
                    ) : (
                      <p className="mt-1 text-[11px] text-ink-muted">
                        企業側からの回答は未提出です。
                      </p>
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

function StatusColumn({
  label,
  count,
  tone = 'neutral',
}: {
  label: string;
  count: number;
  tone?: 'neutral' | 'brand' | 'warning' | 'success' | 'danger';
}) {
  const color =
    tone === 'warning'
      ? 'text-[#8a5d00]'
      : tone === 'success'
        ? 'text-success'
        : tone === 'brand'
          ? 'text-brand-800'
          : tone === 'danger'
            ? 'text-danger'
            : 'text-ink';
  return (
    <Card>
      <div className="px-3 py-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
          {label}
        </div>
        <div className={`tnum text-[20px] font-semibold ${color}`}>{count}</div>
      </div>
    </Card>
  );
}
