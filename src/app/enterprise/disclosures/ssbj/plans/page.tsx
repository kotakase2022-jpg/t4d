import Link from 'next/link';
import { ArrowLeft, CircleAlert, Database } from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import {
  ACTION_STATUS_LABEL,
  ACTION_STATUS_TONE,
  ACTION_TYPE_LABEL,
  GAP_KIND_LABEL,
  PRIORITY_LABEL,
} from '@/lib/domain/ssbj';
import { listMentionCandidates } from '@/lib/services/comments';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { loadActionPlans } from '@/lib/services/ssbj-gap';
import type { SsbjActionStatus } from '@/types/domain';
import { createSsbjDataCollectionAction, updateSsbjActionPlanAction } from '../../../actions';

export const metadata = { title: 'SSBJ 対応計画' };

const STATUS_ORDER: SsbjActionStatus[] = ['not_started', 'in_progress', 'in_review', 'done'];

export default async function SsbjPlansPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const canWrite = can(shell.ctx, 'enterprise.disclosure.write');

  const [plans, members] = await Promise.all([
    loadActionPlans(shell.db, shell.ctx, shell.currentPeriod),
    listMentionCandidates(shell.db, shell.ctx),
  ]);

  const counts = STATUS_ORDER.map((status) => ({
    status,
    value: plans.filter((p) => p.plan.status === status).length,
  }));
  const overdue = plans.filter(
    (p) => p.daysLeft !== null && p.daysLeft < 0 && p.plan.status !== 'done',
  );

  return (
    <>
      <PageHeader
        title="SSBJ 対応計画"
        description={`${shell.currentPeriod.label} ／ ${plans.length} 件の対応計画`}
        breadcrumbs={[
          { label: '企業ワークスペース' },
          { label: '開示対応' },
          { label: 'SSBJ', href: '/enterprise/disclosures/ssbj' },
          { label: '対応計画' },
        ]}
        actions={
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" asChild>
              <Link href="/enterprise/disclosures/ssbj/collection">
                <Database aria-hidden="true" />
                データ収集管理
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/enterprise/disclosures/ssbj">
                <ArrowLeft aria-hidden="true" />
                対応状況へ戻る
              </Link>
            </Button>
          </div>
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        <ul className="grid grid-cols-5 gap-2">
          {counts.map((c) => (
            <li key={c.status}>
              <Card className="space-y-1 p-2.5">
                <p className="text-[11px] text-ink-muted">{ACTION_STATUS_LABEL[c.status]}</p>
                <p className="text-[20px] font-semibold leading-none tabular-nums text-ink">
                  {c.value}
                </p>
              </Card>
            </li>
          ))}
          <li>
            <Card className="space-y-1 p-2.5">
              <p className="text-[11px] text-ink-muted">期限超過</p>
              <p
                className={`text-[20px] font-semibold leading-none tabular-nums ${
                  overdue.length > 0 ? 'text-danger' : 'text-ink'
                }`}
              >
                {overdue.length}
              </p>
            </Card>
          </li>
        </ul>

        <Card className="overflow-hidden">
          <SectionTitle
            title="対応計画の一覧"
            action={
              <span className="text-[11px] text-ink-muted">
                担当部署・担当者・期限・対応状況をここで更新します
              </span>
            }
          />
          {plans.length === 0 ? (
            <EmptyState
              title="対応計画がまだありません"
              description="要求事項の詳細画面から「対応計画に追加」で作成してください。"
              action={
                <Button size="sm" asChild>
                  <Link href="/enterprise/disclosures/ssbj/requirements">要求事項の評価へ</Link>
                </Button>
              }
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>対応内容</TH>
                  <TH>関連する要求事項</TH>
                  <TH>観点</TH>
                  <TH>対応区分</TH>
                  <TH>担当部署・担当者</TH>
                  <TH>期限</TH>
                  <TH>優先順位</TH>
                  <TH>対応状況</TH>
                </TR>
              </THead>
              <TBody>
                {plans.map(({ plan, item, assigneeName, daysLeft }) => (
                  <TR key={plan.id}>
                    <TD className="max-w-[300px]">
                      <p className="font-medium text-ink">{plan.title}</p>
                      {plan.detail && (
                        <p className="mt-0.5 text-[11px] text-ink-muted">{plan.detail}</p>
                      )}
                      {plan.linkedMetricCode && (
                        <p className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-muted">
                          <Database className="size-3" aria-hidden="true" />
                          データ項目 {plan.linkedMetricCode} を作成済み
                        </p>
                      )}
                    </TD>
                    <TD className="max-w-[200px] text-[11px]">
                      {item ? (
                        <Link
                          href={`/enterprise/disclosures/ssbj/requirements/${item.id}`}
                          className="text-brand-700 underline-offset-2 hover:underline"
                        >
                          <span className="font-mono">{item.code}</span> {item.questionText}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </TD>
                    <TD>{GAP_KIND_LABEL[plan.gapKind]}</TD>
                    <TD className="text-[11px]">{ACTION_TYPE_LABEL[plan.actionType]}</TD>
                    <TD className="text-[11px]">
                      {plan.department || '未設定'}
                      <br />
                      <span className="text-ink-muted">{assigneeName ?? '担当者未設定'}</span>
                    </TD>
                    <TD className="text-[11px]">
                      {plan.dueDate ?? '未設定'}
                      {daysLeft !== null && plan.status !== 'done' && (
                        <span
                          className={
                            daysLeft < 0 ? 'ml-1 font-medium text-danger' : 'ml-1 text-ink-muted'
                          }
                        >
                          {daysLeft < 0 ? `${Math.abs(daysLeft)} 日超過` : `残り ${daysLeft} 日`}
                        </span>
                      )}
                    </TD>
                    <TD>
                      <Badge
                        tone={
                          plan.priority === 'high'
                            ? 'danger'
                            : plan.priority === 'medium'
                              ? 'warning'
                              : 'neutral'
                        }
                      >
                        {PRIORITY_LABEL[plan.priority]}
                      </Badge>
                    </TD>
                    <TD>
                      {canWrite ? (
                        <form
                          action={updateSsbjActionPlanAction}
                          className="flex flex-wrap items-center gap-1"
                        >
                          <input type="hidden" name="planId" value={plan.id} />
                          <input type="hidden" name="department" value={plan.department} />
                          <input type="hidden" name="priority" value={plan.priority} />
                          <input type="hidden" name="dueDate" value={plan.dueDate ?? ''} />
                          <select
                            name="assigneeUserId"
                            defaultValue={plan.assigneeUserId ?? ''}
                            aria-label={`${plan.title} の担当者`}
                            className="h-7 w-24 rounded-t4d border border-line bg-surface px-1 text-[12px]"
                          >
                            <option value="">未設定</option>
                            {members.map((m) => (
                              <option key={m.userId} value={m.userId}>
                                {m.displayName}
                              </option>
                            ))}
                          </select>
                          <select
                            name="status"
                            defaultValue={plan.status}
                            aria-label={`${plan.title} の対応状況`}
                            className="h-7 rounded-t4d border border-line bg-surface px-1 text-[12px]"
                          >
                            {STATUS_ORDER.map((s) => (
                              <option key={s} value={s}>
                                {ACTION_STATUS_LABEL[s]}
                              </option>
                            ))}
                          </select>
                          <SubmitButton size="xs" variant="outline" pendingLabel="更新中">
                            更新
                          </SubmitButton>
                        </form>
                      ) : (
                        <Badge tone={ACTION_STATUS_TONE[plan.status]}>
                          {ACTION_STATUS_LABEL[plan.status]}
                        </Badge>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        {/* データ収集項目の作成（データギャップの対応計画から） */}
        {canWrite && (
          <Card className="overflow-hidden">
            <SectionTitle
              title="データ収集項目を作成"
              action={
                <span className="text-[11px] text-ink-muted">
                  不足しているデータを、担当部署へ収集依頼できる形にします
                </span>
              }
            />
            {plans.filter((p) => p.plan.gapKind === 'data' && p.plan.linkedMetricCode === null)
              .length === 0 ? (
              <div className="flex items-start gap-2 p-3">
                <CircleAlert className="mt-0.5 size-4 text-ink-muted" aria-hidden="true" />
                <p className="text-[12px] text-ink-muted">
                  データ収集項目を作成できる対応計画がありません。要求事項の詳細画面で、観点を
                  「データ」にした対応計画を追加してください。
                </p>
              </div>
            ) : (
              <form action={createSsbjDataCollectionAction} className="space-y-2.5 p-3">
                <div className="grid grid-cols-4 gap-2">
                  <label className="space-y-1">
                    <span className="block text-[11px] text-ink-muted">対象の対応計画</span>
                    <select
                      name="planId"
                      aria-label="対象の対応計画"
                      className="h-7 w-full rounded-t4d border border-line bg-surface px-1.5 text-[12px]"
                    >
                      {plans
                        .filter(
                          (p) => p.plan.gapKind === 'data' && p.plan.linkedMetricCode === null,
                        )
                        .map(({ plan }) => (
                          <option key={plan.id} value={plan.id}>
                            {plan.title}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="block text-[11px] text-ink-muted">データ項目コード</span>
                    <input
                      type="text"
                      name="metricCode"
                      required
                      placeholder="scope3_cat1"
                      aria-label="データ項目コード"
                      className="h-7 w-full rounded-t4d border border-line px-2 text-[12px]"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="block text-[11px] text-ink-muted">データ項目名</span>
                    <input
                      type="text"
                      name="metricName"
                      required
                      placeholder="スコープ3 カテゴリー1 排出量"
                      aria-label="データ項目名"
                      className="h-7 w-full rounded-t4d border border-line px-2 text-[12px]"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="block text-[11px] text-ink-muted">単位</span>
                    <input
                      type="text"
                      name="unit"
                      defaultValue="t-CO2e"
                      aria-label="単位"
                      className="h-7 w-full rounded-t4d border border-line px-2 text-[12px]"
                    />
                  </label>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  <label className="space-y-1">
                    <span className="block text-[11px] text-ink-muted">集計対象範囲</span>
                    <select
                      name="unitId"
                      aria-label="集計対象範囲"
                      className="h-7 w-full rounded-t4d border border-line bg-surface px-1.5 text-[12px]"
                    >
                      {shell.units.map((unit) => (
                        <option key={unit.id} value={unit.id}>
                          {unit.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="block text-[11px] text-ink-muted">入力担当者</span>
                    <select
                      name="ownerUserId"
                      defaultValue=""
                      aria-label="入力担当者"
                      className="h-7 w-full rounded-t4d border border-line bg-surface px-1.5 text-[12px]"
                    >
                      <option value="">未設定</option>
                      {members.map((m) => (
                        <option key={m.userId} value={m.userId}>
                          {m.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="block text-[11px] text-ink-muted">提出期限</span>
                    <input
                      type="date"
                      name="dueDate"
                      required
                      defaultValue={shell.currentPeriod.submissionDueDate ?? ''}
                      aria-label="提出期限"
                      className="h-7 w-full rounded-t4d border border-line px-2 text-[12px]"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="block text-[11px] text-ink-muted">担当部署</span>
                    <input
                      type="text"
                      name="department"
                      aria-label="データ収集の担当部署"
                      className="h-7 w-full rounded-t4d border border-line px-2 text-[12px]"
                    />
                  </label>
                </div>
                <label className="flex items-center gap-1.5 text-[12px] text-ink">
                  <input
                    type="checkbox"
                    name="requiresEvidence"
                    defaultChecked
                    className="size-3.5 accent-[#0b57a4]"
                  />
                  証跡資料の添付を必須にする（第三者保証に備える）
                </label>
                <SubmitButton size="sm" pendingLabel="作成しています…">
                  <Database aria-hidden="true" />
                  データ収集項目を作成
                </SubmitButton>
              </form>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
