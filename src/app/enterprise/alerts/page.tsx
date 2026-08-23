import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { SeverityBadge } from '@/components/shared/badges';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { FIXTURE_TODAY } from '@/lib/config';
import { isOverdue } from '@/lib/format/datetime';
import { loadPeriodDataset } from '@/lib/services/enterprise-data';
import { loadEnterpriseShell } from '@/lib/services/shell';

export const metadata = { title: 'アラート' };

export default async function AlertsPage() {
  const shell = await loadEnterpriseShell();
  const dataset = await loadPeriodDataset(
    shell.db,
    shell.ctx,
    shell.currentPeriod,
    shell.metrics,
    shell.units,
    shell.periods,
  );

  const tasks = await shell.db.select('tasks', {
    where: {
      organizationId: shell.ctx.workspace.organizationId,
      status: { notIn: ['done', 'cancelled'] },
    },
  });
  const overdueTasks = tasks.filter((t) => isOverdue(t.dueDate, FIXTURE_TODAY));

  const errors = dataset.validations.filter((v) => v.severity === 'error');
  const warnings = dataset.validations.filter((v) => v.severity === 'warning');

  const metricById = dataset.metricById;
  const unitById = dataset.unitById;
  const dataPointById = new Map(dataset.dataPoints.map((dp) => [dp.id, dp]));

  // 画面の説明文が挙げる 7 種のうち、未提出・資料依頼・質問更新が抜けていた。
  const unsubmitted = dataset.dataPoints.filter(
    (dp) => dp.status === 'not_started' || dp.status === 'draft',
  );
  // draft の PBC は企業側へ届いていない（監査法人の下書き）ので除く
  const pbcRequests = await shell.db.select('pbcRequests', {
    where: { clientOrganizationId: shell.ctx.workspace.organizationId },
  });
  const openPbc = pbcRequests.filter((r) => r.status !== 'draft' && r.status !== 'accepted');
  // 開示質問は組織ではなく「フレームワークの版」に属する（マスターは共通）
  const disclosureResponses = await shell.db.select('disclosureResponses', {
    where: { organizationId: shell.ctx.workspace.organizationId },
  });
  const respondedItemIds = new Set(disclosureResponses.map((r) => r.itemId));
  const allItems = await shell.db.select('disclosureItems', {});
  const changedItems = allItems.filter(
    (item) =>
      (item.changeType === 'new' || item.changeType === 'changed') &&
      !respondedItemIds.has(item.id),
  ).length;

  return (
    <>
      <PageHeader
        title="統合アラートセンター"
        description="未提出・期限超過・異常値・資料依頼・開示質問の更新を集約します。行をクリックすると対象へ直接遷移します。"
        breadcrumbs={[{ label: '企業ワークスペース' }, { label: 'アラート' }]}
      />

      <div className="space-y-3 p-4">
        <div className="grid grid-cols-3 gap-2">
          <SummaryCard label="検証エラー" value={errors.length} tone="danger" />
          <SummaryCard label="検証警告" value={warnings.length} tone="warning" />
          <SummaryCard label="期限超過タスク" value={overdueTasks.length} tone="danger" />
          <SummaryCard label="未提出データ" value={unsubmitted.length} tone="warning" />
          <SummaryCard label="未回答の資料依頼" value={openPbc.length} tone="warning" />
          <SummaryCard label="新規・変更の開示質問" value={changedItems} tone="warning" />
        </div>

        <Card className="overflow-hidden">
          <SectionTitle
            title={`未提出のデータ（${unsubmitted.length}）`}
            action={
              <Link
                href="/enterprise/data?status=not_started&status=draft"
                className="text-[12px] text-brand-700 hover:underline"
              >
                一覧で開く
              </Link>
            }
          />
          {unsubmitted.length === 0 ? (
            <EmptyState title="未提出のデータはありません" />
          ) : (
            <ul className="divide-y divide-line">
              {unsubmitted.slice(0, 10).map((dp) => (
                <li key={dp.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <Link
                    href={`/enterprise/data/${dp.id}`}
                    className="truncate text-[12px] text-brand-700 hover:underline"
                  >
                    {metricById.get(dp.metricId)?.name ?? '指標'} ／{' '}
                    {unitById.get(dp.unitId)?.name ?? '組織'}
                  </Link>
                  <Badge tone="warning">{dp.status === 'draft' ? '作成中' : '未着手'}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle
            title={`監査法人からの資料依頼（${openPbc.length}）`}
            action={
              <Link
                href="/enterprise/workflows"
                className="text-[12px] text-brand-700 hover:underline"
              >
                ワークフローで開く
              </Link>
            }
          />
          {openPbc.length === 0 ? (
            <EmptyState title="未回答の資料依頼はありません" />
          ) : (
            <ul className="divide-y divide-line">
              {openPbc.map((request) => (
                <li key={request.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <Link
                    href="/enterprise/workflows"
                    className="truncate text-[12px] text-brand-700 hover:underline"
                  >
                    {request.code} {request.title}
                  </Link>
                  <Badge tone={isOverdue(request.dueDate, FIXTURE_TODAY) ? 'danger' : 'neutral'}>
                    期限 {request.dueDate}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle title={`データ品質アラート（${dataset.validations.length}）`} />
          {dataset.validations.length === 0 ? (
            <EmptyState
              title="アラートはありません"
              icon={<AlertTriangle className="size-5" aria-hidden="true" />}
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>重要度</TH>
                  <TH>ルール</TH>
                  <TH>対象</TH>
                  <TH>内容</TH>
                </TR>
              </THead>
              <TBody>
                {[...errors, ...warnings].map((v) => {
                  const dp = dataPointById.get(v.dataPointId);
                  const metric = dp ? metricById.get(dp.metricId) : undefined;
                  const unit = dp ? unitById.get(dp.unitId) : undefined;
                  return (
                    <TR key={v.id}>
                      <TD>
                        <SeverityBadge severity={v.severity} />
                      </TD>
                      <TD className="font-mono text-[11px]">{v.ruleKey}</TD>
                      <TD>
                        <Link
                          href={`/enterprise/data/${v.dataPointId}`}
                          className="text-brand-700 hover:underline"
                        >
                          {unit?.name} / {metric?.name}
                        </Link>
                      </TD>
                      <TD className="text-[12px]">{v.message}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle title={`期限超過（${overdueTasks.length}）`} />
          {overdueTasks.length === 0 ? (
            <EmptyState title="期限超過はありません" />
          ) : (
            <ul className="divide-y divide-line">
              {overdueTasks.map((task) => (
                <li key={task.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  {/* 「行をクリックすると対象へ直接遷移します」と案内している以上、遷移先を必ず持たせる */}
                  <Link
                    href={taskHref(task.targetType, task.targetId)}
                    className="truncate text-[12px] text-brand-700 hover:underline"
                  >
                    {task.title}
                  </Link>
                  <Badge tone="danger">期限 {task.dueDate}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

/** タスクの対象から遷移先を決める。分からないときは一覧へ送る。 */
function taskHref(targetType: string, targetId: string | null): string {
  if (targetType === 'data_point' && targetId) return `/enterprise/data/${targetId}`;
  if (targetType === 'pbc_request') return '/enterprise/workflows';
  if (targetType === 'disclosure_response') return '/enterprise/disclosures/cdp';
  return '/enterprise/workflows';
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'danger' | 'warning';
}) {
  return (
    <Card>
      <div className="px-3 py-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
          {label}
        </div>
        <div
          className={`tnum text-[22px] font-semibold ${tone === 'danger' ? 'text-danger' : 'text-[#8a5d00]'}`}
        >
          {value}
        </div>
      </div>
    </Card>
  );
}
