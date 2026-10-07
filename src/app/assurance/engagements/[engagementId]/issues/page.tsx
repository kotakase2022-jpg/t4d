import Link from 'next/link';
import { MessageSquareWarning } from 'lucide-react';
import { IssueSeverityBadge } from '@/components/shared/badges';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { FlashMessage } from '@/components/shared/flash';
import { SegmentedFilter } from '@/components/shared/nav-tabs';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input, Textarea } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { requireAssuranceContext } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import { loadEngagementOr404, loadTestingWorkspace } from '@/lib/services/assurance';
import type { AssuranceIssue } from '@/types/domain';
import { createIssueAction, resolveIssueAction } from '../../../actions';
import { EngagementHeader } from '../engagement-header';

export const metadata = { title: '指摘・例外' };

type SearchParams = Record<string, string | string[] | undefined>;

const isOpen = (issue: Pick<AssuranceIssue, 'status'>) =>
  issue.status !== 'resolved' && issue.status !== 'closed';

export default async function IssuesPage({
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
  const basePath = `/assurance/engagements/${engagementId}/issues`;

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
  const panelOpen = canManage && isCreatePanelOpen(query);

  const open = issues.filter(isOpen);
  const highOpen = open.filter((i) => i.severity === 'high');

  // 絞り込み（概要・案件ホームの「未解決の指摘」「重要度「高」」から来る）
  const filter = typeof query.filter === 'string' ? query.filter : 'all';
  const shown = issues.filter((issue) =>
    filter === 'open'
      ? isOpen(issue)
      : filter === 'high'
        ? isOpen(issue) && issue.severity === 'high'
        : filter === 'resolved'
          ? !isOpen(issue)
          : true,
  );
  const filterHref = (key: string) => (key === 'all' ? basePath : `${basePath}?filter=${key}`);

  return (
    <>
      <EngagementHeader
        context={context}
        page="指摘・例外"
        actions={
          <PageActions
            primary={{
              kind: 'link',
              id: 'create-issue',
              shortcut: 'new',
              label: '指摘を起票',
              icon: <MessageSquareWarning aria-hidden="true" />,
              href: createPanelHref(basePath, query, { open: true }),
              // 起票欄を開いているときは、欄の中の「起票」が主操作
              hidden: !canManage || panelOpen,
            }}
          />
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        {highOpen.length > 0 && (
          <Notice tone="danger">
            未解決の重要度「高」の指摘が {highOpen.length} 件あります。解消するまで最終 Sign-off
            は実行できません。
          </Notice>
        )}

        {canManage && (
          <CreatePanel
            id="create-issue"
            title="指摘を起票"
            searchParams={query}
            closeHref={createPanelHref(basePath, query, { open: false })}
          >
            <form action={createIssueAction} className="space-y-2">
              <input type="hidden" name="engagementId" value={engagementId} />
              <div className="grid grid-cols-6 gap-2">
                <Field label="タイトル" name="title" required className="col-span-4">
                  {(p) => <Input {...p} name="title" />}
                </Field>
                <Field label="重要度" name="severity" required className="col-span-2">
                  {(p) => (
                    <NativeSelect {...p} name="severity" defaultValue="medium">
                      <option value="high">高</option>
                      <option value="medium">中</option>
                      <option value="low">低</option>
                    </NativeSelect>
                  )}
                </Field>
                <Field label="内容" name="description" className="col-span-6">
                  {(p) => <Textarea {...p} name="description" rows={2} />}
                </Field>
              </div>
              <FormSection title="影響と原因" kind="optional">
                <div className="grid grid-cols-6 gap-2">
                  <Field label="影響指標" name="affectedMetricId" className="col-span-2">
                    {(p) => (
                      <NativeSelect {...p} name="affectedMetricId" defaultValue="">
                        <option value="">（未選択）</option>
                        {metrics.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </Field>
                  <Field label="影響サンプル" name="affectedSampleItemId" className="col-span-2">
                    {(p) => (
                      <NativeSelect {...p} name="affectedSampleItemId" defaultValue="">
                        <option value="">（未選択）</option>
                        {sampleRows.map((r) => (
                          <option key={r.sampleItemId} value={r.sampleItemId}>
                            {r.unitName} / {r.metricName}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </Field>
                  <Field label="定量的影響" name="quantitativeImpact">
                    {(p) => <Input {...p} name="quantitativeImpact" inputMode="decimal" />}
                  </Field>
                  <Field label="単位" name="quantitativeImpactUnit">
                    {(p) => <Input {...p} name="quantitativeImpactUnit" placeholder="t-CO2e" />}
                  </Field>
                  <Field label="原因" name="rootCause" className="col-span-6">
                    {(p) => <Input {...p} name="rootCause" />}
                  </Field>
                </div>
              </FormSection>
              <SubmitButton variant="primary" size="sm" pendingLabel="起票中…">
                起票
              </SubmitButton>
            </form>
          </CreatePanel>
        )}

        <Section
          title={`指摘（${issues.length}）`}
          summary={filter === 'all' ? undefined : `表示 ${shown.length} 件`}
        >
          <SegmentedFilter
            ariaLabel="指摘の状態で絞り込む"
            current={['open', 'high', 'resolved'].includes(filter) ? filter : 'all'}
            className="mb-2"
            items={[
              { key: 'all', label: 'すべて', href: filterHref('all'), count: issues.length },
              { key: 'open', label: '未解決', href: filterHref('open'), count: open.length },
              {
                key: 'high',
                label: '重要度「高」（未解決）',
                href: filterHref('high'),
                count: highOpen.length,
                attention: highOpen.length > 0,
              },
              {
                key: 'resolved',
                label: '解消・クローズ',
                href: filterHref('resolved'),
                count: issues.length - open.length,
              },
            ]}
          />

          {issues.length === 0 ? (
            canManage ? (
              <EmptyState
                kind="no-data"
                size="compact"
                title="指摘はありません"
                description="手続で例外を見つけたら、ここで起票すると Sign-off の抑止条件として追跡されます。"
                icon={<MessageSquareWarning className="size-5" aria-hidden="true" />}
                action={
                  <Link
                    href={createPanelHref(basePath, query, { open: true })}
                    className="text-small text-brand-700 hover:underline"
                  >
                    指摘を起票
                  </Link>
                }
              />
            ) : (
              <EmptyState
                kind="not-applicable"
                size="compact"
                title="指摘はありません"
                icon={<MessageSquareWarning className="size-5" aria-hidden="true" />}
              />
            )
          ) : shown.length === 0 ? (
            <EmptyState kind="filtered" size="compact" resetHref={filterHref('all')} />
          ) : (
            <ul className="divide-y divide-line rounded-t4d border border-line">
              {shown.map((issue) => {
                const response = responses.find((r) => r.issueId === issue.id);
                return (
                  <li key={issue.id} className="p-3" data-t4d-record="">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-small text-ink-muted">{issue.code}</span>
                      <span className="text-body font-medium text-ink">{issue.title}</span>
                      <IssueSeverityBadge severity={issue.severity} />
                      <StatusBadge domain="issue" value={issue.status} />
                      {issue.quantitativeImpact !== null && (
                        <span className="ml-auto text-caption text-ink-muted">
                          影響 {formatNumber(issue.quantitativeImpact)}{' '}
                          {issue.quantitativeImpactUnit ?? ''}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-small text-ink">{issue.description}</p>
                    <dl className="mt-1 grid grid-cols-3 gap-2 text-caption text-ink-muted">
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
                        <div className="text-caption font-medium text-ink">経営者の回答</div>
                        <p className="text-small text-ink">{response.body}</p>
                        {response.proposedCorrection && (
                          <p className="text-caption text-ink-muted">
                            修正案: {response.proposedCorrection}
                          </p>
                        )}
                        <span className="text-caption text-ink-muted">
                          {formatJst(response.respondedAt)}
                        </span>
                      </div>
                    )}

                    {issue.resolution && (
                      <p className="mt-1 text-small text-success">解消: {issue.resolution}</p>
                    )}

                    {/* 行の主操作は「解消として記録」（secondary。解消内容の入力が要る。plan §1.15） */}
                    {canManage && isOpen(issue) && (
                      <form action={resolveIssueAction} className="mt-2 flex items-end gap-2">
                        <input type="hidden" name="engagementId" value={engagementId} />
                        <input type="hidden" name="issueId" value={issue.id} />
                        <label className="flex-1 text-caption text-ink-muted">
                          解消内容
                          <Input name="resolution" required className="mt-0.5" />
                        </label>
                        <SubmitButton size="xs" variant="secondary">
                          解消として記録
                        </SubmitButton>
                      </form>
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
