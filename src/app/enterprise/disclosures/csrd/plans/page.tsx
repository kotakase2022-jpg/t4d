import Link from 'next/link';
import { ArrowLeft, Ban, CalendarClock, ClipboardList, Database, ListChecks } from 'lucide-react';
import { StatusBreakdown } from '@/components/charts/status-breakdown';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { AuthorizationError } from '@/lib/authorization/can';
import { CSRD_SECTION_LABEL } from '@/lib/domain/csrd';
import { ACTION_STATUS_LABEL, ACTION_TYPE_LABEL, GAP_KIND_LABEL } from '@/lib/domain/ssbj';
import { formatJstDate } from '@/lib/format/datetime';
import { listMentionCandidates } from '@/lib/services/comments';
import {
  csrdPlanPermissions,
  loadCsrdActionPlans,
  type CsrdActionPlanView,
} from '@/lib/services/csrd/plans';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { SSBJ_ACTION_STATUSES } from '@/types/domain';
import { ApplicabilityBadge, SampleMasterBadge } from '../_components/csrd-badges';
import {
  ACTION_STATUS_ICON,
  ActionStatusBadge,
  OutOfScopeRequirementBadge,
  PlanPriorityBadge,
} from './_components/plan-badges';
import { updateCsrdActionPlanAction } from './actions';

export const metadata = { title: 'CSRD 対応計画' };

const BREADCRUMBS = [
  { label: '企業ワークスペース' },
  { label: '開示対応' },
  { label: 'CSRD', href: '/enterprise/disclosures/csrd' },
  { label: '対応計画' },
];

/** 期限までの残り日数の表示（完了した計画には出さない） */
function DaysLeft({ view }: { view: CsrdActionPlanView }) {
  if (view.daysLeft === null || view.plan.status === 'done') return null;
  return view.daysLeft < 0 ? (
    <span className="ml-1 font-medium text-danger">{Math.abs(view.daysLeft)} 日超過</span>
  ) : (
    <span className="ml-1 text-ink-muted">残り {view.daysLeft} 日</span>
  );
}

/**
 * CSRD 対応計画（docs/disclosure-first.md §9.4）。CSRD の計画（csrd_action_plans）だけを並べ、
 * SSBJ の計画は出さない。計画の追加は要求事項の詳細（評価対象の要求事項）から行う。
 * 計画を立てた後に DMA の判断が変わって評価対象から外れた要求事項の計画は、消さずに
 * 「対象外の要求事項」と示す（判断の取り違えで作業を失わせない）。
 *
 * 文字量を減らす（§10.4）: 状態の件数は積み上げの帯（分母付き）、操作の説明は「この画面について」。
 */
export default async function CsrdPlansPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();

  let plans: CsrdActionPlanView[];
  try {
    plans = await loadCsrdActionPlans(shell.db, shell.ctx, shell.currentPeriod);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return (
        <>
          <PageHeader title="CSRD 対応計画" breadcrumbs={BREADCRUMBS} />
          <PermissionDeniedState description="CSRD の対応計画を見るには、開示の閲覧権限が必要です。" />
        </>
      );
    }
    throw error;
  }
  const { canWrite } = csrdPlanPermissions(shell.ctx);
  const members = canWrite ? await listMentionCandidates(shell.db, shell.ctx) : [];

  const counts = SSBJ_ACTION_STATUSES.map((status) => ({
    status,
    value: plans.filter((p) => p.plan.status === status).length,
  }));
  const overdue = plans.filter(
    (p) => p.daysLeft !== null && p.daysLeft < 0 && p.plan.status !== 'done',
  ).length;
  const outOfScope = plans.filter((p) => p.outOfScope).length;

  return (
    <>
      <PageHeader
        title="CSRD 対応計画"
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {shell.currentPeriod.label} ／ {plans.length} 件の対応計画（CSRD の計画のみ）
            </span>
            <SampleMasterBadge />
          </span>
        }
        help={
          <>
            <p>
              担当者・対応状況は一覧の表で更新します。計画の追加は要求事項の詳細画面（評価対象の要求事項）から行います。
            </p>
            <p>
              DMA
              の判断が変わって評価対象から外れた要求事項の計画は、消さずに「対象外の要求事項」と示します。
            </p>
            <p>
              データの不足に対する計画は、「CSRD
              データ収集」で収集項目（指標・拠点・担当・期限）にします。
            </p>
          </>
        }
        breadcrumbs={BREADCRUMBS}
        actions={
          <div className="flex items-center gap-1.5">
            <Button size="sm" asChild>
              <Link href="/enterprise/disclosures/csrd/collection">
                <Database aria-hidden="true" />
                CSRD データ収集
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/enterprise/disclosures/csrd/requirements">
                <ListChecks aria-hidden="true" />
                要求事項の評価
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/enterprise/disclosures/csrd">
                <ArrowLeft aria-hidden="true" />
                対応状況へ戻る
              </Link>
            </Button>
          </div>
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        {/* 状態の件数は積み上げの帯＋凡例（分母付き）。期限超過・対象外は別の事実として並べる */}
        <Card className="flex flex-wrap items-start gap-x-6 gap-y-2 p-3">
          <StatusBreakdown
            label="対応計画の件数"
            className="min-w-[280px] flex-1"
            denominator={plans.length}
            items={counts.map((c) => ({
              key: c.status,
              label: ACTION_STATUS_LABEL[c.status],
              count: c.value,
              icon: ACTION_STATUS_ICON[c.status],
            }))}
          />
          <dl className="space-y-1 text-[12px]">
            <div className="flex items-center gap-1.5">
              <dt className="flex items-center gap-1 text-ink-muted">
                <CalendarClock className="size-3.5" aria-hidden="true" />
                期限超過（完了を除く）
              </dt>
              <dd
                className={`tabular-nums ${overdue > 0 ? 'font-semibold text-danger' : 'text-ink'}`}
              >
                {overdue} 件
              </dd>
            </div>
            <div className="flex items-center gap-1.5">
              <dt className="flex items-center gap-1 text-ink-muted">
                <Ban className="size-3.5" aria-hidden="true" />
                対象外の要求事項の計画
              </dt>
              <dd
                className={`tabular-nums ${outOfScope > 0 ? 'font-semibold text-[#8a5d00]' : 'text-ink'}`}
              >
                {outOfScope} 件
              </dd>
            </div>
          </dl>
        </Card>

        <Card className="overflow-hidden">
          {/* 操作の説明は「この画面について」へ。権限が無いことは閉じずに見せる */}
          <SectionTitle
            title="対応計画の一覧"
            action={
              canWrite ? undefined : (
                <span className="text-[11px] text-ink-muted">
                  閲覧のみ（更新には開示の編集権限が必要です）
                </span>
              )
            }
          />
          {plans.length === 0 ? (
            <EmptyState
              icon={<ClipboardList className="size-5" aria-hidden="true" />}
              title="CSRD の対応計画がまだありません"
              description="要求事項の詳細画面（評価対象の要求事項）で、ギャップに対する対応計画を追加してください。"
              action={
                <Button size="sm" asChild>
                  <Link href="/enterprise/disclosures/csrd/requirements">要求事項の評価へ</Link>
                </Button>
              }
            />
          ) : (
            <div className="t4d-scroll-x">
              <Table aria-label="CSRD 対応計画の一覧">
                <THead>
                  <TR>
                    <TH>対応内容</TH>
                    <TH>関連する要求事項</TH>
                    <TH>適用</TH>
                    <TH>ギャップの観点</TH>
                    <TH>対応区分</TH>
                    <TH>担当部署・担当者</TH>
                    <TH>期限</TH>
                    <TH>優先度</TH>
                    <TH>対応状況</TH>
                  </TR>
                </THead>
                <TBody>
                  {plans.map((view) => {
                    const { plan, item, section, applicability, assigneeName } = view;
                    return (
                      <TR key={plan.id} id={`csrd-plan-${plan.id}`}>
                        <TD className="max-w-[260px] py-1.5 align-top">
                          <p className="font-medium text-ink">{plan.title}</p>
                          {plan.detail && (
                            <p className="mt-0.5 text-[11px] text-ink-muted">{plan.detail}</p>
                          )}
                          {plan.linkedMetricCode && (
                            <p className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-muted">
                              <Database className="size-3" aria-hidden="true" />
                              収集項目 <span className="font-mono">
                                {plan.linkedMetricCode}
                              </span>{' '}
                              を作成済み
                            </p>
                          )}
                        </TD>
                        <TD className="max-w-[220px] py-1.5 align-top text-[11px]">
                          {item ? (
                            <>
                              <Link
                                href={`/enterprise/disclosures/csrd/requirements/${item.id}`}
                                className="text-brand-700 underline-offset-2 hover:underline"
                              >
                                <span className="font-mono">{item.code}</span> {item.questionText}
                              </Link>
                              {section && (
                                <span className="mt-0.5 block text-ink-muted">
                                  {CSRD_SECTION_LABEL[section]}
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="text-ink-muted">要求事項が見つかりません</span>
                          )}
                        </TD>
                        <TD className="py-1.5 align-top">
                          <span className="flex flex-col items-start gap-1">
                            {applicability && <ApplicabilityBadge applicability={applicability} />}
                            {view.outOfScope && <OutOfScopeRequirementBadge />}
                          </span>
                        </TD>
                        <TD className="py-1.5 align-top text-[12px]">
                          {GAP_KIND_LABEL[plan.gapKind]}
                        </TD>
                        <TD className="py-1.5 align-top text-[11px]">
                          {ACTION_TYPE_LABEL[plan.actionType]}
                        </TD>
                        <TD className="py-1.5 align-top text-[11px]">
                          {plan.department || '担当部署未設定'}
                          <br />
                          <span className="text-ink-muted">{assigneeName ?? '担当者未設定'}</span>
                        </TD>
                        <TD className="whitespace-nowrap py-1.5 align-top text-[11px]">
                          {plan.dueDate ? formatJstDate(plan.dueDate) : '未設定'}
                          <DaysLeft view={view} />
                        </TD>
                        <TD className="py-1.5 align-top">
                          <PlanPriorityBadge priority={plan.priority} />
                        </TD>
                        <TD className="py-1.5 align-top">
                          <div className="space-y-1">
                            <ActionStatusBadge status={plan.status} />
                            {canWrite && (
                              <form
                                action={updateCsrdActionPlanAction}
                                className="flex flex-wrap items-center gap-1"
                              >
                                <input type="hidden" name="planId" value={plan.id} />
                                <input type="hidden" name="department" value={plan.department} />
                                <input type="hidden" name="priority" value={plan.priority} />
                                <input type="hidden" name="dueDate" value={plan.dueDate ?? ''} />
                                {/* 表示したときの版。別の操作（収集項目の作成・別のタブ）で変わっていれば断る */}
                                <input type="hidden" name="baseUpdatedAt" value={plan.updatedAt} />
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
                                  {SSBJ_ACTION_STATUSES.map((s) => (
                                    <option key={s} value={s}>
                                      {ACTION_STATUS_LABEL[s]}
                                    </option>
                                  ))}
                                </select>
                                <SubmitButton
                                  size="xs"
                                  variant="outline"
                                  pendingLabel="更新中"
                                  aria-label={`${plan.title} を更新`}
                                >
                                  更新
                                </SubmitButton>
                              </form>
                            )}
                          </div>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
