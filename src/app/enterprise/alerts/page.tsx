import Link from 'next/link';
import type { ReactNode } from 'react';
import { SeverityBadge } from '@/components/shared/badges';
import { MetricStrip, MetricTile } from '@/components/shared/metric-strip';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { SemanticBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/states';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { describeReferenceDate } from '@/lib/clock';
import { formatJstDate, isOverdue } from '@/lib/format/datetime';
import { loadPeriodDataset } from '@/lib/services/enterprise-data';
import { loadEnterpriseShell } from '@/lib/services/shell';
import type { StatusSemantic } from '@/lib/ui/status/registry';
import { statusLabel } from '@/lib/ui/status/registry';
import { validationRuleLabel } from '../data/_components/validation-rule-labels';
import { taskTargetHref } from '../workflows/task-target';

export const metadata = { title: 'アラート' };

/** 件数の帯の状態（色だけで示さない: アイコンと語を MetricTile が併記する） */
function tileStatus(
  count: number,
  semantic: StatusSemantic,
): { semantic: StatusSemantic; label: string } {
  return count > 0 ? { semantic, label: '要対応' } : { semantic: 'done', label: 'なし' };
}

/** 一覧のリンク（見出しの右の 1 行。見出しと同じ親に置き、どの一覧かが分かるようにする） */
function ListLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-small text-brand-700 hover:underline">
      {children}
    </Link>
  );
}

/**
 * アラート（plan S21）。組織の「放置すると問題になる事実」を重要度の順に並べる
 * （検証エラー → 期限超過 → 資料依頼 → 未提出 → 開示質問の更新）。
 * 件数の帯は押すと絞り込んだ一覧へ移る。表は先頭 10 件までにし、残りは一覧で開く（同じ事実を
 * ホーム・ワークフローと別の条件で数えない。行き先はそれぞれの一覧の絞り込み）。
 */
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
  // 期限の基準日は 1 か所（デモは FIXTURE_TODAY、Supabase Mode は実時計）
  const referenceDate = describeReferenceDate();
  const today = referenceDate.date;
  const overdueTasks = tasks.filter((t) => isOverdue(t.dueDate, today));

  const errors = dataset.validations.filter((v) => v.severity === 'error');
  const warnings = dataset.validations.filter((v) => v.severity === 'warning');

  const metricById = dataset.metricById;
  const unitById = dataset.unitById;
  const dataPointById = new Map(dataset.dataPoints.map((dp) => [dp.id, dp]));

  const unsubmitted = dataset.dataPoints.filter(
    (dp) => dp.status === 'not_started' || dp.status === 'draft',
  );
  const changedAfterApproval = dataset.dataPoints.filter((dp) => dp.changedAfterApproval).length;
  // draft の PBC は企業側へ届いていない（監査法人の下書き）ので除く
  const pbcRequests = await shell.db.select('pbcRequests', {
    where: { clientOrganizationId: shell.ctx.workspace.organizationId },
  });
  const openPbc = pbcRequests
    .filter((r) => r.status !== 'draft' && r.status !== 'accepted')
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
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
        title="アラート"
        description="未提出・期限超過・異常値・資料依頼・開示質問の更新を、重要度の順に"
        help={
          <p>
            未提出・期限超過・異常値・資料依頼・開示質問の更新を集約します。件数を押すと絞り込んだ一覧へ、行を押すと対象へ直接移ります。
          </p>
        }
        autoBreadcrumbs
      />

      <div className="space-y-3 px-4 pb-4 pt-3">
        <MetricStrip label="アラートの件数（重要度の順）">
          <MetricTile
            label="検証エラー"
            value={errors.length}
            unit="件"
            status={tileStatus(errors.length, 'error')}
            href="/enterprise/data?flag=validation_error"
          />
          <MetricTile
            label="期限超過タスク"
            value={overdueTasks.length}
            unit="件"
            status={tileStatus(overdueTasks.length, 'error')}
            href="/enterprise/workflows?flag=overdue"
          />
          <MetricTile
            label="未回答の資料依頼"
            value={openPbc.length}
            unit="件"
            status={tileStatus(openPbc.length, 'pending')}
            href="/enterprise/workflows#pbc"
          />
          <MetricTile
            label="承認後に変更されたデータ"
            value={changedAfterApproval}
            unit="件"
            status={tileStatus(changedAfterApproval, 'blocked')}
            href="/enterprise/data?flag=changed_after_approval"
          />
          <MetricTile
            label="検証警告"
            value={warnings.length}
            unit="件"
            status={tileStatus(warnings.length, 'blocked')}
            href="#data-quality"
          />
          <MetricTile
            label="未提出データ"
            value={unsubmitted.length}
            unit="件"
            status={tileStatus(unsubmitted.length, 'pending')}
            href="/enterprise/data?status=not_started&status=draft"
          />
          <MetricTile
            label="新規・変更の開示質問"
            value={changedItems}
            unit="件"
            status={tileStatus(changedItems, 'info')}
            href="/enterprise/disclosures/cdp"
          />
        </MetricStrip>

        <Section id="data-quality" title={`データ品質アラート（${dataset.validations.length}）`}>
          {dataset.validations.length === 0 ? (
            <EmptyState kind="done" size="compact" title="検証エラー・警告はありません" />
          ) : (
            <Table aria-label="データ品質アラート">
              <THead>
                <TR>
                  <TH>重要度</TH>
                  <TH>検証の種類</TH>
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
                    <TR key={v.id} data-t4d-record="">
                      <TD>
                        <SeverityBadge severity={v.severity} />
                      </TD>
                      <TD className="text-small">{validationRuleLabel(v.ruleKey)}</TD>
                      <TD>
                        <Link
                          href={`/enterprise/data/${v.dataPointId}`}
                          className="text-brand-700 hover:underline"
                        >
                          {unit?.name} / {metric?.name}
                        </Link>
                      </TD>
                      <TD className="text-small">{v.message}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </Section>

        <Section
          id="overdue"
          title={`期限超過（${overdueTasks.length}）`}
          // デモでは期限の判定が固定の基準日によることを示す（実時計では出さない）
          summary={referenceDate.label ? `${referenceDate.label} で判定` : undefined}
        >
          {overdueTasks.length === 0 ? (
            <EmptyState kind="done" size="compact" title="期限超過はありません" />
          ) : (
            <ul className="divide-y divide-line">
              {overdueTasks.map((task) => (
                <li key={task.id} className="flex items-center justify-between gap-2 py-1.5">
                  {/* 「行を押すと対象へ直接移ります」と案内している以上、遷移先を必ず持たせる */}
                  <Link
                    href={taskTargetHref(task.targetType, task.targetId)}
                    className="truncate text-small text-brand-700 hover:underline"
                  >
                    {task.title}
                  </Link>
                  <SemanticBadge semantic="error" label={`期限 ${formatJstDate(task.dueDate)}`} />
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          id="pbc"
          title={`監査法人からの資料依頼（${openPbc.length}）`}
          summary={<ListLink href="/enterprise/workflows#pbc">ワークフローで開く</ListLink>}
        >
          {openPbc.length === 0 ? (
            <EmptyState kind="done" size="compact" title="未回答の資料依頼はありません" />
          ) : (
            <ul className="divide-y divide-line">
              {openPbc.map((request) => {
                const overdue = isOverdue(request.dueDate, today);
                return (
                  <li key={request.id} className="flex items-center justify-between gap-2 py-1.5">
                    <Link
                      href="/enterprise/workflows#pbc"
                      className="truncate text-small text-brand-700 hover:underline"
                    >
                      {request.code} {request.title}
                    </Link>
                    <SemanticBadge
                      semantic={overdue ? 'error' : 'pending'}
                      label={`期限 ${formatJstDate(request.dueDate)}${overdue ? '（超過）' : ''}`}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section
          id="unsubmitted"
          title={`未提出のデータ（${unsubmitted.length}）`}
          summary={
            <ListLink href="/enterprise/data?status=not_started&status=draft">一覧で開く</ListLink>
          }
        >
          {unsubmitted.length === 0 ? (
            <EmptyState kind="done" size="compact" title="未提出のデータはありません" />
          ) : (
            <ul className="divide-y divide-line">
              {unsubmitted.slice(0, 10).map((dp) => (
                <li key={dp.id} className="flex items-center justify-between gap-2 py-1.5">
                  <Link
                    href={`/enterprise/data/${dp.id}`}
                    className="truncate text-small text-brand-700 hover:underline"
                  >
                    {metricById.get(dp.metricId)?.name ?? '指標'} ／{' '}
                    {unitById.get(dp.unitId)?.name ?? '組織'}
                  </Link>
                  <SemanticBadge
                    semantic={dp.status === 'draft' ? 'draft' : 'todo'}
                    label={statusLabel('dataPoint', dp.status)}
                  />
                </li>
              ))}
            </ul>
          )}
          {unsubmitted.length > 10 && (
            <p className="pt-1 text-caption text-ink-muted">
              先頭 10 件を表示しています（全 {unsubmitted.length} 件は一覧で開く）。
            </p>
          )}
        </Section>
      </div>
    </>
  );
}
