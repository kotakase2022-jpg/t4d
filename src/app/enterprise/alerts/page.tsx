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

  return (
    <>
      <PageHeader
        title="統合アラートセンター"
        description="未提出・期限超過・異常値・Evidence 不足・承認後変更を重要度別に集約します。行をクリックすると対象へ直接遷移します。"
        breadcrumbs={[{ label: '企業ワークスペース' }, { label: 'アラート' }]}
      />

      <div className="space-y-3 p-4">
        <div className="grid grid-cols-3 gap-2">
          <SummaryCard label="検証エラー" value={errors.length} tone="danger" />
          <SummaryCard label="検証警告" value={warnings.length} tone="warning" />
          <SummaryCard label="期限超過タスク" value={overdueTasks.length} tone="danger" />
        </div>

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
                  <span className="text-[12px] text-ink">{task.title}</span>
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
