import Link from 'next/link';
import { CalendarClock, Database, Plus } from 'lucide-react';
import { StatusBreakdown } from '@/components/charts/status-breakdown';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import type { FilterGroup } from '@/components/shared/filter-bar';
import { FlashMessage } from '@/components/shared/flash';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input } from '@/components/ui/input';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { can } from '@/lib/authorization/can';
import {
  ACTION_STATUS_LABEL,
  ACTION_TYPE_LABEL,
  GAP_KIND_LABEL,
  PRIORITY_LABEL,
} from '@/lib/domain/ssbj';
import { listMentionCandidates } from '@/lib/services/comments';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { loadActionPlans, type ActionPlanView } from '@/lib/services/ssbj-gap';
import { DEFAULT_PAGE_SIZES, parsePage, parsePageSize } from '@/lib/table/columns';
import type { SsbjActionStatus } from '@/types/domain';
import { createSsbjDataCollectionAction, updateSsbjActionPlanAction } from '../../../actions';
import { planStatusItems } from '../_components/breakdown-items';

export const metadata = { title: 'SSBJ 対応計画' };

const BASE_PATH = '/enterprise/disclosures/ssbj/plans';
const STATUS_ORDER: SsbjActionStatus[] = ['not_started', 'in_progress', 'in_review', 'done'];

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * SSBJ 対応計画（plan §2.26 E20）。
 *
 * - 計画の一覧は DataTable（対応状況・観点の絞り込み、検索、列の表示切替）。行の中の更新（担当者・対応状況）は従来どおり
 * - 主操作は「データ収集項目を作成」。作成欄は一覧の上に常設せず、?new=1 で開く CreatePanel にする
 *   （提出期限は報告期間の提出期限、データ項目コードは指標マスターの候補から選べる。plan D3・D6）
 */
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

  const overdue = plans.filter(
    (p) => p.daysLeft !== null && p.daysLeft < 0 && p.plan.status !== 'done',
  );
  const collectable = plans.filter(
    (p) => p.plan.gapKind === 'data' && p.plan.linkedMetricCode === null,
  );
  const panelOpen = canWrite && isCreatePanelOpen(query);

  // 絞り込み（URL）: 対応状況・観点・検索
  const status = first(query.status);
  const gap = first(query.gap);
  const search = (first(query.q) ?? '').trim();
  const filtered = plans.filter(({ plan, item }) => {
    if (status && plan.status !== status) return false;
    if (gap && plan.gapKind !== gap) return false;
    if (search !== '') {
      const haystack = `${plan.title} ${plan.detail} ${plan.department} ${item?.code ?? ''} ${item?.questionText ?? ''}`;
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
  const pageSize = parsePageSize(query.size);
  const lastPage = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageNo = Math.min(parsePage(query.page), lastPage);
  const pageRows = filtered.slice((pageNo - 1) * pageSize, pageNo * pageSize);

  const filters: FilterGroup[] = [
    {
      key: 'status',
      label: '対応状況',
      multiple: false,
      options: STATUS_ORDER.map((s) => ({ value: s, label: ACTION_STATUS_LABEL[s] })),
    },
    {
      key: 'gap',
      label: '観点',
      multiple: false,
      options: (['disclosure', 'data', 'process'] as const).map((k) => ({
        value: k,
        label: GAP_KIND_LABEL[k],
      })),
    },
  ];

  const columns: DataTableColumn<ActionPlanView>[] = [
    {
      key: 'title',
      header: '対応内容',
      importance: 'primary',
      lockVisible: true,
      cell: ({ plan }) => (
        <div className="max-w-col-lg">
          <p className="font-medium text-ink">{plan.title}</p>
          {plan.detail && <p className="mt-0.5 text-caption text-ink-muted">{plan.detail}</p>}
          {plan.linkedMetricCode && (
            <p className="mt-0.5 flex items-center gap-1 text-caption text-ink-muted">
              <Database className="size-3" aria-hidden="true" />
              データ項目 {plan.linkedMetricCode} を作成済み
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'requirement',
      header: '関連する要求事項',
      importance: 'primary',
      cell: ({ item }) =>
        item ? (
          <Link
            href={`/enterprise/disclosures/ssbj/requirements/${item.id}`}
            className="block max-w-col-md text-caption text-brand-700 underline-offset-2 hover:underline"
          >
            <span className="font-mono">{item.code}</span> {item.questionText}
          </Link>
        ) : (
          '—'
        ),
    },
    {
      key: 'gap',
      header: '観点',
      importance: 'secondary',
      cell: ({ plan }) => GAP_KIND_LABEL[plan.gapKind],
    },
    {
      key: 'type',
      header: '対応区分',
      importance: 'secondary',
      cell: ({ plan }) => (
        <span className="text-caption">{ACTION_TYPE_LABEL[plan.actionType]}</span>
      ),
    },
    {
      key: 'owner',
      header: '担当部署・担当者',
      importance: 'detail',
      cell: ({ plan, assigneeName }) => (
        <span className="text-caption">
          {plan.department || '未設定'}
          <br />
          <span className="text-ink-muted">{assigneeName ?? '担当者未設定'}</span>
        </span>
      ),
    },
    {
      key: 'due',
      header: '期限',
      importance: 'primary',
      cell: ({ plan, daysLeft }) => (
        <span className="text-caption">
          {plan.dueDate ?? '未設定'}
          {daysLeft !== null && plan.status !== 'done' && (
            <span className={daysLeft < 0 ? 'ml-1 font-medium text-danger' : 'ml-1 text-ink-muted'}>
              {daysLeft < 0 ? `${Math.abs(daysLeft)} 日超過` : `残り ${daysLeft} 日`}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'priority',
      header: '優先順位',
      importance: 'detail',
      cell: ({ plan }) => (
        <Badge
          tone={
            plan.priority === 'high' ? 'danger' : plan.priority === 'medium' ? 'warning' : 'neutral'
          }
        >
          {PRIORITY_LABEL[plan.priority]}
        </Badge>
      ),
    },
    {
      key: 'status',
      header: '対応状況',
      importance: 'primary',
      cell: ({ plan }) =>
        canWrite ? (
          // 行の中で担当者と対応状況を更新する（行内編集。期限・部署・優先順位は今の値を送り直す）
          <form action={updateSsbjActionPlanAction} className="flex flex-wrap items-center gap-1">
            <input type="hidden" name="planId" value={plan.id} />
            <input type="hidden" name="department" value={plan.department} />
            <input type="hidden" name="priority" value={plan.priority} />
            <input type="hidden" name="dueDate" value={plan.dueDate ?? ''} />
            <NativeSelect
              name="assigneeUserId"
              defaultValue={plan.assigneeUserId ?? ''}
              aria-label={`${plan.title} の担当者`}
              className="w-24 px-1 text-small"
            >
              <option value="">未設定</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.displayName}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              name="status"
              defaultValue={plan.status}
              aria-label={`${plan.title} の対応状況`}
              className="w-auto px-1 text-small"
            >
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {ACTION_STATUS_LABEL[s]}
                </option>
              ))}
            </NativeSelect>
            <SubmitButton size="xs" variant="secondary" pendingLabel="更新中">
              更新
            </SubmitButton>
          </form>
        ) : (
          <StatusBadge domain="ssbjAction" value={plan.status} />
        ),
    },
  ];

  const createHref = `${createPanelHref(BASE_PATH, query, { open: true })}#collection-create`;

  return (
    <>
      <PageHeader
        title="SSBJ 対応計画"
        description={`${shell.currentPeriod.label} ／ ${plans.length} 件の対応計画`}
        autoBreadcrumbs
        actions={
          <PageActions
            primary={{
              kind: 'link',
              id: 'create-collection',
              shortcut: 'new',
              label: 'データ収集項目を作成',
              icon: <Plus aria-hidden="true" />,
              href: createHref,
              // 作成欄を開いている間は、作成欄の「作成」ボタンが主操作（同時に 2 つ出さない）
              hidden: !canWrite || panelOpen,
              ...(collectable.length === 0
                ? {
                    disabledReason:
                      'データ収集項目を作れる対応計画がありません。要求事項の詳細で、観点を「データ」にした対応計画を追加してください。',
                  }
                : {}),
            }}
            secondary={[
              {
                kind: 'link',
                id: 'collection',
                label: 'データ収集',
                icon: <Database aria-hidden="true" />,
                href: '/enterprise/disclosures/ssbj/collection',
              },
            ]}
          />
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        {canWrite && collectable.length > 0 && (
          <CreatePanel
            id="collection-create"
            title="データ収集項目を作成"
            searchParams={query}
            closeHref={createPanelHref(BASE_PATH, query, { open: false })}
            description="不足しているデータを、担当部署へ収集依頼できる形にします。提出期限は報告期間の提出期限を入れてあります。"
          >
            <form action={createSsbjDataCollectionAction} className="space-y-2.5">
              <FormSection title="収集するデータ" kind="required">
                <div className="grid grid-cols-4 gap-2">
                  <Field label="対象の対応計画" name="planId" required>
                    {(p) => (
                      <NativeSelect {...p} name="planId" aria-label="対象の対応計画">
                        {collectable.map(({ plan }) => (
                          <option key={plan.id} value={plan.id}>
                            {plan.title}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </Field>
                  <Field
                    label="データ項目コード"
                    name="metricCode"
                    required
                    hint="指標マスターの候補から選べます（新しいコードも入力できます）"
                  >
                    {(p) => (
                      <Input
                        {...p}
                        type="text"
                        name="metricCode"
                        list="ssbj-metric-codes"
                        placeholder="scope3_cat1"
                        aria-label="データ項目コード"
                        className="h-7 text-small"
                      />
                    )}
                  </Field>
                  <Field label="データ項目名" name="metricName" required>
                    {(p) => (
                      <Input
                        {...p}
                        type="text"
                        name="metricName"
                        placeholder="スコープ3 カテゴリー1 排出量"
                        aria-label="データ項目名"
                        className="h-7 text-small"
                      />
                    )}
                  </Field>
                  <Field label="提出期限" name="dueDate" required>
                    {(p) => (
                      <Input
                        {...p}
                        type="date"
                        name="dueDate"
                        defaultValue={shell.currentPeriod.submissionDueDate ?? ''}
                        aria-label="提出期限"
                        className="h-7 text-small"
                      />
                    )}
                  </Field>
                </div>
                {/* 指標を候補から選ぶ（コードを覚えさせない。plan D6） */}
                <datalist id="ssbj-metric-codes">
                  {shell.metrics.map((metric) => (
                    <option key={metric.id} value={metric.code}>
                      {metric.name}（{metric.unit}）
                    </option>
                  ))}
                </datalist>
              </FormSection>
              <FormSection title="単位・範囲・担当" kind="optional" open>
                <div className="grid grid-cols-4 gap-2">
                  <Field label="単位" name="unit">
                    {(p) => (
                      <Input
                        {...p}
                        type="text"
                        name="unit"
                        defaultValue="t-CO2e"
                        aria-label="単位"
                        className="h-7 text-small"
                      />
                    )}
                  </Field>
                  <Field label="集計対象範囲" name="unitId">
                    {(p) => (
                      <NativeSelect {...p} name="unitId" aria-label="集計対象範囲">
                        {shell.units.map((unit) => (
                          <option key={unit.id} value={unit.id}>
                            {unit.name}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </Field>
                  <Field label="入力担当者" name="ownerUserId">
                    {(p) => (
                      <NativeSelect
                        {...p}
                        name="ownerUserId"
                        defaultValue=""
                        aria-label="入力担当者"
                      >
                        <option value="">未設定</option>
                        {members.map((m) => (
                          <option key={m.userId} value={m.userId}>
                            {m.displayName}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </Field>
                  <Field label="担当部署" name="department">
                    {(p) => (
                      <Input
                        {...p}
                        type="text"
                        name="department"
                        aria-label="データ収集の担当部署"
                        className="h-7 text-small"
                      />
                    )}
                  </Field>
                </div>
                <NativeCheckbox
                  name="requiresEvidence"
                  defaultChecked
                  label="証跡資料の添付を必須にする（第三者保証に備える）"
                />
              </FormSection>
              <SubmitButton
                variant="primary"
                size="sm"
                icon={<Database aria-hidden="true" />}
                pendingLabel="作成しています…"
              >
                データ収集項目を作成
              </SubmitButton>
            </form>
          </CreatePanel>
        )}

        {/* 対応状況の内訳（4 区分の合計 = 計画の件数）。期限超過は状態と重なるため帯の外に書く */}
        <Card className="space-y-2 p-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-small">
            <p className="flex items-baseline gap-1">
              <span className="text-ink-muted">対応計画</span>
              <span className="text-figure font-semibold leading-none tabular-nums text-ink">
                {plans.length}
              </span>
              <span className="text-ink-muted">件</span>
            </p>
            <p className="flex items-center gap-1">
              <CalendarClock className="size-3.5 text-ink-muted" aria-hidden="true" />
              <span className="text-ink-muted">期限超過</span>
              <span
                className={`font-semibold tabular-nums ${overdue.length > 0 ? 'text-danger' : 'text-ink'}`}
              >
                {overdue.length}
              </span>
              <span className="text-ink-muted">件（完了以外）</span>
            </p>
          </div>
          <StatusBreakdown
            label="対応状況の内訳"
            items={planStatusItems(plans)}
            denominator={plans.length}
          />
        </Card>

        <Section
          title="対応計画の一覧"
          summary={
            <span className="text-caption text-ink-muted">
              担当者・対応状況はこの一覧の中で更新します
            </span>
          }
        >
          <DataTable
            id="ssbj-plans"
            caption="SSBJ 対応計画"
            columns={columns}
            rows={pageRows}
            getRowId={({ plan }) => plan.id}
            getRowLabel={({ plan }) => plan.title}
            getRowStatus={({ plan }) => plan.status}
            searchParams={query}
            basePath={BASE_PATH}
            filters={filters}
            search={{ placeholder: '対応内容・要求事項番号・担当部署で検索' }}
            userViews
            page={{ page: pageNo, pageSize, total: filtered.length, sizes: DEFAULT_PAGE_SIZES }}
            empty={{
              noData: {
                title: '対応計画がまだありません',
                description:
                  '要求事項の詳細画面で最終判定を確定し、「対応計画に追加」で作成します。',
                action: (
                  <Link
                    href="/enterprise/disclosures/ssbj/requirements"
                    className="text-small text-brand-700 hover:underline"
                  >
                    要求事項の評価へ
                  </Link>
                ),
              },
            }}
          />
        </Section>
      </div>
    </>
  );
}
