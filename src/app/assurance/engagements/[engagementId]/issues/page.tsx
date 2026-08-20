import { MessageSquareWarning } from 'lucide-react';
import { IssueSeverityBadge } from '@/components/shared/badges';
import { SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { requireAssuranceContext } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import { loadEngagementOr404, loadTestingWorkspace } from '@/lib/services/assurance';
import { createIssueAction, resolveIssueAction } from '../../../actions';
import { EngagementHeader } from '../engagement-header';

export const metadata = { title: '指摘・例外' };

export default async function IssuesPage({
  params,
}: {
  params: Promise<{ engagementId: string }>;
}) {
  const { engagementId } = await params;
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const context = await loadEngagementOr404(db, ctx, engagementId);

  const issues = await db.select('issues', {
    where: { engagementId },
    orderBy: { column: 'code' },
  });
  const responses =
    issues.length > 0
      ? await db.select('managementResponses', {
          where: { issueId: { in: issues.map((i) => i.id) } },
        })
      : [];

  const scopes = await db.select('engagementScopes', { where: { engagementId } });
  const metricIds = [...new Set(scopes.map((s) => s.metricId))];
  const metrics =
    metricIds.length > 0 ? await db.select('metrics', { where: { id: { in: metricIds } } }) : [];
  const metricById = new Map(metrics.map((m) => [m.id, m]));

  const { rows: sampleRows } = await loadTestingWorkspace(db, ctx, engagementId);
  const canManage = can(ctx, 'assurance.issue.manage');

  const open = issues.filter((i) => i.status !== 'resolved' && i.status !== 'closed');
  const highOpen = open.filter((i) => i.severity === 'high');

  return (
    <>
      <EngagementHeader context={context} page="指摘・例外" />

      <div className="space-y-3 p-4">
        {highOpen.length > 0 && (
          <Card className="border-danger/40 bg-danger-soft">
            <p className="px-3 py-2 text-[12px] text-danger">
              未解決の重要度「高」の指摘が {highOpen.length} 件あります。解消するまで最終 Sign-off
              は実行できません。
            </p>
          </Card>
        )}

        {canManage && (
          <Card>
            <SectionTitle title="指摘を起票" />
            <form action={createIssueAction} className="grid grid-cols-6 gap-2 p-3">
              <input type="hidden" name="engagementId" value={engagementId} />
              <label className="col-span-2 text-[12px] text-ink-muted">
                タイトル
                <Input name="title" required className="mt-0.5" />
              </label>
              <label className="col-span-1 text-[12px] text-ink-muted">
                重要度
                <select
                  name="severity"
                  defaultValue="medium"
                  className="mt-0.5 block h-7 w-full rounded-t4d border border-line bg-surface px-2 text-[13px]"
                >
                  <option value="high">高</option>
                  <option value="medium">中</option>
                  <option value="low">低</option>
                </select>
              </label>
              <label className="col-span-1 text-[12px] text-ink-muted">
                影響指標
                <select
                  name="affectedMetricId"
                  className="mt-0.5 block h-7 w-full rounded-t4d border border-line bg-surface px-2 text-[13px]"
                >
                  <option value="">（未選択）</option>
                  {metrics.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="col-span-1 text-[12px] text-ink-muted">
                影響サンプル
                <select
                  name="affectedSampleItemId"
                  className="mt-0.5 block h-7 w-full rounded-t4d border border-line bg-surface px-2 text-[13px]"
                >
                  <option value="">（未選択）</option>
                  {sampleRows.map((r) => (
                    <option key={r.sampleItemId} value={r.sampleItemId}>
                      {r.unitName} / {r.metricName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="col-span-1 text-[12px] text-ink-muted">
                定量的影響
                <Input name="quantitativeImpact" inputMode="decimal" className="mt-0.5" />
              </label>
              <label className="col-span-1 text-[12px] text-ink-muted">
                単位
                <Input name="quantitativeImpactUnit" placeholder="t-CO2e" className="mt-0.5" />
              </label>
              <label className="col-span-2 text-[12px] text-ink-muted">
                原因（Root Cause）
                <Input name="rootCause" className="mt-0.5" />
              </label>
              <label className="col-span-6 text-[12px] text-ink-muted">
                内容
                <Textarea name="description" rows={2} className="mt-0.5" />
              </label>
              <div className="col-span-6">
                <Button type="submit" size="sm">
                  起票
                </Button>
              </div>
            </form>
          </Card>
        )}

        <Card>
          <SectionTitle title={`指摘（${issues.length}）`} />
          {issues.length === 0 ? (
            <EmptyState
              title="指摘はありません"
              icon={<MessageSquareWarning className="size-5" aria-hidden="true" />}
            />
          ) : (
            <ul className="divide-y divide-line">
              {issues.map((issue) => {
                const response = responses.find((r) => r.issueId === issue.id);
                return (
                  <li key={issue.id} className="p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[12px] text-ink-muted">{issue.code}</span>
                      <span className="text-[13px] font-medium text-ink">{issue.title}</span>
                      <IssueSeverityBadge severity={issue.severity} />
                      <Badge
                        tone={
                          issue.status === 'resolved' || issue.status === 'closed'
                            ? 'success'
                            : issue.status === 'management_response'
                              ? 'brand'
                              : 'warning'
                        }
                      >
                        {issue.status}
                      </Badge>
                      {issue.quantitativeImpact !== null && (
                        <span className="ml-auto text-[11px] text-ink-muted">
                          影響 {formatNumber(issue.quantitativeImpact)}{' '}
                          {issue.quantitativeImpactUnit ?? ''}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[12px] text-ink">{issue.description}</p>
                    <dl className="mt-1 grid grid-cols-3 gap-2 text-[11px] text-ink-muted">
                      <div>
                        影響指標:{' '}
                        {issue.affectedMetricId
                          ? (metricById.get(issue.affectedMetricId)?.name ?? '—')
                          : '—'}
                      </div>
                      <div>原因: {issue.rootCause ?? '—'}</div>
                      <div>起票: {formatJst(issue.createdAt)}</div>
                    </dl>

                    {response && (
                      <div className="mt-2 rounded-t4d border border-line bg-surface-muted p-2">
                        <div className="text-[11px] font-medium text-ink">経営者回答</div>
                        <p className="text-[12px] text-ink">{response.body}</p>
                        {response.proposedCorrection && (
                          <p className="text-[11px] text-ink-muted">
                            修正案: {response.proposedCorrection}
                          </p>
                        )}
                        <span className="text-[11px] text-ink-muted">
                          {formatJst(response.respondedAt)}
                        </span>
                      </div>
                    )}

                    {issue.resolution && (
                      <p className="mt-1 text-[12px] text-success">解消: {issue.resolution}</p>
                    )}

                    {canManage && issue.status !== 'resolved' && issue.status !== 'closed' && (
                      <form action={resolveIssueAction} className="mt-2 flex items-end gap-2">
                        <input type="hidden" name="engagementId" value={engagementId} />
                        <input type="hidden" name="issueId" value={issue.id} />
                        <label className="flex-1 text-[11px] text-ink-muted">
                          解消内容
                          <Input name="resolution" required className="mt-0.5" />
                        </label>
                        <Button type="submit" size="xs">
                          解消として記録
                        </Button>
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
