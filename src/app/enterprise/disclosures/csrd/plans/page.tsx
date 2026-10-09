import Link from 'next/link';
import { ArrowLeft, Ban, CalendarClock, Database, ListChecks } from 'lucide-react';
import { StatusBreakdown } from '@/components/charts/status-breakdown';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import type { FilterGroup } from '@/components/shared/filter-bar';
import { FlashMessage } from '@/components/shared/flash';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { PermissionDeniedState } from '@/components/shared/states';
import { Card } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { AuthorizationError } from '@/lib/authorization/can';
import { CSRD_SECTION_LABEL } from '@/lib/domain/csrd';
import {
  ACTION_STATUS_LABEL,
  ACTION_TYPE_LABEL,
  GAP_KIND_LABEL,
  PRIORITY_LABEL,
} from '@/lib/domain/ssbj';
import { formatJstDate } from '@/lib/format/datetime';
import { listMentionCandidates } from '@/lib/services/comments';
import {
  csrdPlanPermissions,
  loadCsrdActionPlans,
  type CsrdActionPlanView,
} from '@/lib/services/csrd/plans';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { DEFAULT_PAGE_SIZES, parsePage, parsePageSize } from '@/lib/table/columns';
import { SSBJ_ACTION_STATUSES, SSBJ_GAP_KINDS, SSBJ_PRIORITIES } from '@/types/domain';
import { ApplicabilityBadge, SampleMasterBadge } from '../_components/csrd-badges';
import {
  ACTION_STATUS_ICON,
  ActionStatusBadge,
  OutOfScopeRequirementBadge,
  PlanPriorityBadge,
} from './_components/plan-badges';
import { updateCsrdActionPlanAction } from './actions';
import { CsrdScopeNote } from '../_components/csrd-scope-note';

export const metadata = { title: 'CSRD 対応計画' };

const BASE = '/enterprise/disclosures/csrd/plans';

/** 期限までの残り日数の表示（完了した計画には出さない） */
function DaysLeft({ view }: { view: CsrdActionPlanView }) {
  if (view.daysLeft === null || view.plan.status === 'done') return null;
  return view.daysLeft < 0 ? (
    <span className="ml-1 font-medium text-danger">{Math.abs(view.daysLeft)} 日超過</span>
  ) : (
    <span className="ml-1 text-ink-muted">残り {view.daysLeft} 日</span>
  );
}

type Member = Awaited<ReturnType<typeof listMentionCandidates>>[number];

/** 担当者・対応状況の行内更新（期限・担当部署・優先度は表示中の値をそのまま送る） */
function PlanUpdateForm({ view, members }: { view: CsrdActionPlanView; members: Member[] }) {
  const { plan } = view;
  return (
    <form action={updateCsrdActionPlanAction} className="flex flex-wrap items-center gap-1">
      <input type="hidden" name="planId" value={plan.id} />
      <input type="hidden" name="department" value={plan.department} />
      <input type="hidden" name="priority" value={plan.priority} />
      <input type="hidden" name="dueDate" value={plan.dueDate ?? ''} />
      {/* 表示したときの版。別の操作（収集項目の作成・別のタブ）で変わっていれば断る */}
      <input type="hidden" name="baseUpdatedAt" value={plan.updatedAt} />
      <NativeSelect
        size="xs"
        name="assigneeUserId"
        defaultValue={plan.assigneeUserId ?? ''}
        aria-label={`${plan.title} の担当者`}
        className="w-24"
      >
        <option value="">未設定</option>
        {members.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.displayName}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        size="xs"
        name="status"
        defaultValue={plan.status}
        aria-label={`${plan.title} の対応状況`}
        className="w-auto"
      >
        {SSBJ_ACTION_STATUSES.map((s) => (
          <option key={s} value={s}>
            {ACTION_STATUS_LABEL[s]}
          </option>
        ))}
      </NativeSelect>
      <SubmitButton
        size="xs"
        variant="secondary"
        pendingLabel="更新中"
        aria-label={`${plan.title} を更新`}
      >
        更新
      </SubmitButton>
    </form>
  );
}

function columnsFor(canWrite: boolean, members: Member[]): DataTableColumn<CsrdActionPlanView>[] {
  return [
    {
      key: 'title',
      header: '対応内容',
      importance: 'primary',
      lockVisible: true,
      pinned: 'left',
      width: 'lg',
      cell: ({ plan }) => (
        // 更新の後はこの行へ戻る（#csrd-plan-{id}）
        <div id={`csrd-plan-${plan.id}`} className="py-0.5">
          <p className="font-medium text-ink">{plan.title}</p>
          {plan.detail && <p className="mt-0.5 text-caption text-ink-muted">{plan.detail}</p>}
          {plan.linkedMetricCode && (
            <p className="mt-0.5 flex items-center gap-1 text-caption text-ink-muted">
              <Database className="size-3" aria-hidden="true" />
              収集項目 <span className="font-mono">{plan.linkedMetricCode}</span> を作成済み
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'requirement',
      header: '関連する要求事項',
      importance: 'primary',
      sortKey: 'code',
      cell: ({ item, section }) =>
        item ? (
          <span className="block max-w-[220px] text-caption">
            <Link
              href={`/enterprise/disclosures/csrd/requirements/${item.id}`}
              className="text-brand-700 underline-offset-2 hover:underline"
            >
              <span className="font-mono">{item.code}</span> {item.questionText}
            </Link>
            {section && (
              <span className="mt-0.5 block text-ink-muted">{CSRD_SECTION_LABEL[section]}</span>
            )}
          </span>
        ) : (
          <span className="text-caption text-ink-muted">要求事項が見つかりません</span>
        ),
    },
    {
      key: 'applicability',
      header: '適用',
      importance: 'secondary',
      cell: (view) => (
        <span className="flex flex-col items-start gap-1">
          {view.applicability && <ApplicabilityBadge applicability={view.applicability} />}
          {view.outOfScope && <OutOfScopeRequirementBadge />}
        </span>
      ),
    },
    {
      key: 'gapKind',
      header: 'ギャップの観点',
      importance: 'detail',
      cell: ({ plan }) => <span className="text-small">{GAP_KIND_LABEL[plan.gapKind]}</span>,
    },
    {
      key: 'actionType',
      header: '対応区分',
      importance: 'detail',
      cell: ({ plan }) => (
        <span className="text-caption">{ACTION_TYPE_LABEL[plan.actionType]}</span>
      ),
    },
    {
      key: 'owner',
      header: '担当部署・担当者',
      importance: 'secondary',
      cell: ({ plan, assigneeName }) => (
        <span className="text-caption">
          {plan.department || '担当部署未設定'}
          <br />
          <span className="text-ink-muted">{assigneeName ?? '担当者未設定'}</span>
        </span>
      ),
    },
    {
      key: 'due',
      header: '期限',
      importance: 'primary',
      sortKey: 'due',
      cell: (view) => (
        <span className="whitespace-nowrap text-caption">
          {view.plan.dueDate ? formatJstDate(view.plan.dueDate) : '未設定'}
          <DaysLeft view={view} />
        </span>
      ),
    },
    {
      key: 'priority',
      header: '優先度',
      importance: 'secondary',
      sortKey: 'priority',
      cell: ({ plan }) => <PlanPriorityBadge priority={plan.priority} />,
    },
    {
      key: 'status',
      header: '対応状況',
      importance: 'primary',
      cell: (view) => (
        <div className="space-y-1">
          <ActionStatusBadge status={view.plan.status} />
          {canWrite && <PlanUpdateForm view={view} members={members} />}
        </div>
      ),
    },
  ];
}

const FILTERS: FilterGroup[] = [
  {
    key: 'status',
    label: '対応状況',
    options: SSBJ_ACTION_STATUSES.map((s) => ({ value: s, label: ACTION_STATUS_LABEL[s] })),
  },
];

const OVERFLOW_FILTERS: FilterGroup[] = [
  {
    key: 'priority',
    label: '優先度',
    options: SSBJ_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] })),
  },
  {
    key: 'gap',
    label: 'ギャップの観点',
    options: SSBJ_GAP_KINDS.map((g) => ({ value: g, label: GAP_KIND_LABEL[g] })),
  },
];

function listOf(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** URL の絞り込み・検索・並べ替え（一覧は 1 期間の計画だけなので画面で行う） */
function arrange(
  plans: CsrdActionPlanView[],
  query: Record<string, string | string[] | undefined>,
): CsrdActionPlanView[] {
  const status = listOf(query.status);
  const priority = listOf(query.priority);
  const gap = listOf(query.gap);
  const q = (typeof query.q === 'string' ? query.q : '').trim().toLowerCase();
  const filtered = plans.filter((view) => {
    if (status.length > 0 && !status.includes(view.plan.status)) return false;
    if (priority.length > 0 && !priority.includes(view.plan.priority)) return false;
    if (gap.length > 0 && !gap.includes(view.plan.gapKind)) return false;
    if (q !== '') {
      const text = `${view.plan.title} ${view.plan.detail} ${view.item?.code ?? ''}`.toLowerCase();
      if (!text.includes(q)) return false;
    }
    return true;
  });
  const sign = query.dir === 'desc' ? -1 : 1;
  if (query.sort === 'due') {
    // 期限の無い計画は向きに関わらず最後
    return [...filtered].sort((a, b) => {
      if (!a.plan.dueDate || !b.plan.dueDate) {
        return a.plan.dueDate ? -1 : b.plan.dueDate ? 1 : 0;
      }
      return sign * a.plan.dueDate.localeCompare(b.plan.dueDate);
    });
  }
  if (query.sort === 'priority') {
    return [...filtered].sort(
      (a, b) =>
        sign * ((PRIORITY_ORDER[a.plan.priority] ?? 3) - (PRIORITY_ORDER[b.plan.priority] ?? 3)),
    );
  }
  if (query.sort === 'code') {
    return [...filtered].sort(
      (a, b) => sign * (a.item?.code ?? '').localeCompare(b.item?.code ?? ''),
    );
  }
  return filtered;
}

/**
 * CSRD 対応計画（docs/disclosure-first.md §9.4・plan E28）。CSRD の計画（csrd_action_plans）だけを並べ、
 * SSBJ の計画は出さない。計画の追加は要求事項の詳細（評価対象の要求事項）から行う。
 * 計画を立てた後に DMA の判断が変わって評価対象から外れた要求事項の計画は、消さずに
 * 「対象外の要求事項」と示す（判断の取り違えで作業を失わせない）。
 *
 * 一覧は DataTable（plan §1.12）。担当者・対応状況は行内で更新する（熟練者の行内編集）。
 * ギャップの観点・対応区分は「列 ▾」から出す。次の工程（データ収集）へのリンクは主操作にしない（plan §1.6）。
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
          <PageHeader title="CSRD 対応計画" autoBreadcrumbs />
          <PermissionDeniedState
            description="CSRD の対応計画を見るには、開示の閲覧権限が必要です。"
            permission="enterprise.disclosure.read"
          />
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

  const arranged = arrange(plans, query);
  const pageSize = parsePageSize(query.size);
  const totalPages = Math.max(1, Math.ceil(arranged.length / pageSize));
  const page = Math.min(parsePage(query.page), totalPages);
  const rows = arranged.slice((page - 1) * pageSize, page * pageSize);

  return (
    <>
      <PageHeader
        title="CSRD 対応計画"
        context={<CsrdScopeNote />}
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
        autoBreadcrumbs
        actions={
          <PageActions
            secondary={[
              {
                kind: 'link',
                id: 'collection',
                label: 'CSRD データ収集',
                href: '/enterprise/disclosures/csrd/collection',
                icon: <Database aria-hidden="true" />,
              },
              {
                kind: 'link',
                id: 'requirements',
                label: '要求事項の評価',
                href: '/enterprise/disclosures/csrd/requirements',
                icon: <ListChecks aria-hidden="true" />,
              },
            ]}
            more={[
              {
                kind: 'link',
                id: 'back',
                label: '対応状況へ戻る',
                href: '/enterprise/disclosures/csrd',
                icon: <ArrowLeft aria-hidden="true" />,
              },
            ]}
          />
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
          <dl className="space-y-1 text-small">
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
                className={`tabular-nums ${outOfScope > 0 ? 'font-semibold text-warning-ink' : 'text-ink'}`}
              >
                {outOfScope} 件
              </dd>
            </div>
          </dl>
        </Card>

        <Section
          id="csrd-plan-list"
          title="対応計画の一覧"
          // 操作の説明は「この画面について」へ。権限が無いことは閉じずに見せる
          summary={canWrite ? undefined : '閲覧のみ（更新には開示の編集権限が必要です）'}
        >
          <DataTable<CsrdActionPlanView>
            id="csrd-plans"
            caption="CSRD 対応計画の一覧"
            columns={columnsFor(canWrite, members)}
            rows={rows}
            getRowId={(view) => view.plan.id}
            getRowLabel={(view) => view.plan.title}
            getRowStatus={(view) => ACTION_STATUS_LABEL[view.plan.status]}
            searchParams={query}
            basePath={BASE}
            filters={FILTERS}
            overflowFilters={OVERFLOW_FILTERS}
            search={{ placeholder: '対応内容・要求事項コードで検索' }}
            userViews
            page={{ page, pageSize, total: arranged.length, sizes: DEFAULT_PAGE_SIZES }}
            empty={{
              noData: {
                title: 'CSRD の対応計画がまだありません',
                description:
                  '要求事項の詳細画面（評価対象の要求事項）で、ギャップに対する対応計画を追加してください。',
                action: (
                  <Link
                    href="/enterprise/disclosures/csrd/requirements"
                    className="text-small text-brand-700 underline"
                  >
                    要求事項の評価へ
                  </Link>
                ),
              },
              filtered: { title: '条件に合う対応計画がありません' },
            }}
          />
        </Section>
      </div>
    </>
  );
}
