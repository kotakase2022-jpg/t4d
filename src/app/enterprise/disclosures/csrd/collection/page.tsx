import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  CircleAlert,
  CircleCheck,
  ClipboardList,
  Clock,
  Database,
  FileText,
  Plus,
  RotateCcw,
  Upload,
} from 'lucide-react';
import { StatusBreakdown } from '@/components/charts/status-breakdown';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { FlashMessage } from '@/components/shared/flash';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { PreservingForm } from '@/components/shared/preserving-form';
import { Section } from '@/components/shared/section';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { MoreInfo } from '@/components/ui/more-info';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { AuthorizationError } from '@/lib/authorization/can';
import {
  CSRD_DATA_STATES,
  CSRD_DATA_STATE_LABEL,
  CSRD_SECTION_LABEL,
  type CsrdDataState,
} from '@/lib/domain/csrd';
import { GAP_KIND_LABEL } from '@/lib/domain/ssbj';
import { formatJstDate, formatNumber } from '@/lib/format/datetime';
import { loadApprovalProgressMap, type ApprovalProgress } from '@/lib/services/approval-route';
import { listMentionCandidates } from '@/lib/services/comments';
import {
  csrdPlanPermissions,
  loadCsrdActionPlans,
  loadCsrdDataCollection,
  type CsrdActionPlanView,
  type CsrdDataCollection,
  type CsrdCollectionRow,
  type CsrdRequirementDataRow,
} from '@/lib/services/csrd/plans';
import { loadEnterpriseShell } from '@/lib/services/shell';
import type { MetricDefinition, Uuid } from '@/types/domain';
import {
  CSRD_DATA_STATE_ICON,
  CsrdDataStateBadge,
  EstimateValueBadge,
  SampleMasterBadge,
} from '../_components/csrd-badges';
import { createCsrdCollectionItemAction } from './actions';

export const metadata = { title: 'CSRD データ収集' };

const BASE = '/enterprise/disclosures/csrd/collection';
const CREATE_PANEL_ID = 'csrd-collection-create';

function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/** 収集項目を作れる計画: 指標を結び付けていない・完了していない・評価対象の要求事項の計画（データの観点を先頭に） */
function eligiblePlans(plans: readonly CsrdActionPlanView[]): CsrdActionPlanView[] {
  return plans
    .filter((p) => p.plan.linkedMetricCode === null && p.plan.status !== 'done' && !p.outOfScope)
    .sort((a, b) => Number(b.plan.gapKind === 'data') - Number(a.plan.gapKind === 'data'));
}

function DaysLeft({ daysLeft, done }: { daysLeft: number | null; done: boolean }) {
  if (daysLeft === null || done) return null;
  return daysLeft < 0 ? (
    <span className="ml-1 font-medium text-danger">{Math.abs(daysLeft)} 日超過</span>
  ) : (
    <span className="ml-1 text-ink-muted">残り {daysLeft} 日</span>
  );
}

/** 承認の進み具合（既存の承認の道筋）。色だけで状態を表さない: 段数を数字で書く */
function ApprovalProgressCell({
  dataPointId,
  progress,
}: {
  dataPointId: Uuid | null;
  progress: ApprovalProgress | undefined;
}) {
  if (!dataPointId || !progress || progress.totalCount === 0) {
    return <span className="text-caption text-ink-muted">—</span>;
  }
  return (
    <Link
      href={`/enterprise/data/${dataPointId}#承認履歴`}
      className="block space-y-0.5 rounded-t4d px-1 py-0.5 hover:bg-surface-muted"
    >
      <span className="flex items-center gap-1.5">
        <span className="text-small tabular-nums text-ink">
          {progress.approvedCount} / {progress.totalCount} 段階
        </span>
        {progress.returnedStep ? (
          <Badge tone="danger">
            <RotateCcw className="size-3" aria-hidden="true" />
            差し戻し
          </Badge>
        ) : progress.complete ? (
          <Badge tone="success">
            <CircleCheck className="size-3" aria-hidden="true" />
            承認完了
          </Badge>
        ) : (
          <Badge tone="warning">
            <Clock className="size-3" aria-hidden="true" />
            承認待ち
          </Badge>
        )}
      </span>
      <span className="block text-caption text-ink-muted">
        {progress.returnedStep
          ? `${progress.returnedStep.stageName} で差し戻し`
          : progress.currentStep
            ? `次: ${progress.currentStep.stageName}（${progress.currentStep.department || '担当部署未設定'}）`
            : 'すべての段階で承認済み'}
      </span>
    </Link>
  );
}

/** 承認済みの値だけを出す（承認前の値・未入力を 0 や値として見せない） */
function ApprovedValue({
  state,
  value,
  unit,
  valueKind,
}: {
  state: CsrdDataState;
  value: number | null;
  unit: string;
  /** 推計は推計と示す（承認済みでも実績と見誤らせない） */
  valueKind: 'actual' | 'estimate' | null;
}) {
  if (state !== 'approved') return <span className="text-ink-muted">—</span>;
  if (value === null) return <span className="text-caption text-ink-muted">数値なし</span>;
  return (
    <span className="inline-flex items-center gap-1">
      {formatNumber(value)}
      <span className="text-caption text-ink-muted">{unit}</span>
      {valueKind === 'estimate' && <EstimateValueBadge />}
    </span>
  );
}

/** 状況の表の 1 行（同じ要求事項の続きの行は、要求事項の欄を空けてまとまりを示す） */
interface StatusRow {
  row: CsrdRequirementDataRow;
  firstOfItem: boolean;
  /** 次の操作（状態で変わる。§1.15） */
  next: ReactNode;
}

const STATUS_COLUMNS: DataTableColumn<StatusRow>[] = [
  {
    key: 'requirement',
    header: '要求事項',
    importance: 'primary',
    lockVisible: true,
    pinned: 'left',
    cell: ({ row, firstOfItem }) =>
      firstOfItem ? (
        <span className="block max-w-[220px]">
          <Link
            href={`/enterprise/disclosures/csrd/requirements/${row.item.id}`}
            className="font-mono text-small font-medium text-brand-800 hover:underline"
          >
            {row.item.code}
          </Link>
          <span className="block text-caption text-ink-muted">
            {row.section ? CSRD_SECTION_LABEL[row.section] : '節を判定できません'}
          </span>
        </span>
      ) : null,
  },
  {
    key: 'metric',
    header: '指標',
    importance: 'primary',
    cell: ({ row }) => (
      <span className="text-small">
        {row.metric.name}
        <span className="ml-1 font-mono text-caption text-ink-muted">{row.metric.code}</span>
      </span>
    ),
  },
  {
    key: 'unit',
    header: '拠点',
    importance: 'primary',
    cell: ({ row }) => (
      <span className="text-small">
        {row.unit?.name ?? <span className="text-ink-muted">全拠点（データ・割当なし）</span>}
      </span>
    ),
  },
  {
    key: 'state',
    header: '当期の状況',
    importance: 'primary',
    cell: ({ row }) => <CsrdDataStateBadge state={row.state} />,
  },
  {
    key: 'value',
    header: '承認済みの値',
    importance: 'secondary',
    align: 'right',
    cell: ({ row }) => (
      <ApprovedValue
        state={row.state}
        value={row.value}
        unit={row.unitOfMeasure}
        valueKind={row.valueKind}
      />
    ),
  },
  {
    key: 'next',
    header: '次の操作',
    importance: 'primary',
    cell: ({ next }) => <span className="text-caption">{next}</span>,
  },
];

function planColumns(
  progressByDataPoint: Map<Uuid, ApprovalProgress>,
): DataTableColumn<CsrdCollectionRow>[] {
  return [
    {
      key: 'metric',
      header: 'データ項目',
      importance: 'primary',
      lockVisible: true,
      pinned: 'left',
      cell: (row) => (
        <span className="font-medium text-ink">
          {row.metricName}
          <span className="ml-1 font-mono text-caption text-ink-muted">{row.metricCode}</span>
        </span>
      ),
    },
    {
      key: 'unit',
      header: '集計対象範囲',
      importance: 'primary',
      cell: (row) => <span className="text-small">{row.unitName}</span>,
    },
    {
      key: 'owner',
      header: '入力担当者',
      importance: 'secondary',
      cell: (row) => <span className="text-caption">{row.ownerName ?? '未設定'}</span>,
    },
    {
      key: 'due',
      header: '提出期限',
      importance: 'primary',
      cell: (row) => (
        <span className="whitespace-nowrap text-caption">
          {row.dueDate ? formatJstDate(row.dueDate) : '未設定'}
          <DaysLeft daysLeft={row.daysLeft} done={row.state === 'approved'} />
        </span>
      ),
    },
    {
      key: 'state',
      header: '当期の状況',
      importance: 'primary',
      cell: (row) => <CsrdDataStateBadge state={row.state} />,
    },
    {
      key: 'value',
      header: '承認済みの値',
      importance: 'secondary',
      align: 'right',
      cell: (row) => (
        <ApprovedValue
          state={row.state}
          value={row.collectedValue}
          unit={row.unit}
          valueKind={row.valueKind}
        />
      ),
    },
    {
      key: 'progress',
      header: '承認の進み具合',
      importance: 'detail',
      cell: (row) => (
        <ApprovalProgressCell
          dataPointId={row.dataPointId}
          progress={row.dataPointId ? progressByDataPoint.get(row.dataPointId) : undefined}
        />
      ),
    },
    {
      key: 'plan',
      header: '元の対応計画',
      importance: 'secondary',
      cell: (row) => (
        <span className="block max-w-[240px] text-caption text-ink-muted">
          {row.plan.title}
          {row.item && (
            <Link
              href={`/enterprise/disclosures/csrd/requirements/${row.item.id}`}
              className="ml-1 font-mono text-brand-700 hover:underline"
            >
              {row.item.code}
            </Link>
          )}
        </span>
      ),
    },
  ];
}

/**
 * CSRD データ収集（docs/disclosure-first.md §9.4・plan E29）。
 *  - 評価対象（常に適用・重要と判断した事項）の要求事項 × 対応指標 × 拠点の当期の状況。値は承認済みだけ
 *  - CSRD の計画から作った収集項目（既存の承認の道筋の進み具合）
 *  - 計画から収集項目を作る（新しい指標の出所は CSRD。既存の指標は作り直さず割当だけを作る）
 * 読込は書かない。SSBJ の計画・収集項目は出さない。
 *
 * 主操作は「収集項目を作成」1 つ（作成の枠は ?new=1 で開く CreatePanel。一覧の上に常設しない）。
 * 次の工程（開示ドラフト）へのリンクは secondary（plan §1.6）。2 つの表は DataTable。
 *
 * 文字量を減らす（§10.4）: 状況の件数はリンク付きの内訳の図、画面の説明は「この画面について」、
 * 既存の指標・割当の扱いは閉じた説明。両方の表・権限が無いことの説明・空状態は常に見せる。
 */
export default async function CsrdCollectionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();

  let collection: CsrdDataCollection;
  let plans: CsrdActionPlanView[];
  try {
    [collection, plans] = await Promise.all([
      loadCsrdDataCollection(shell.db, shell.ctx, shell.currentPeriod),
      loadCsrdActionPlans(shell.db, shell.ctx, shell.currentPeriod),
    ]);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return (
        <>
          <PageHeader title="CSRD データ収集" autoBreadcrumbs />
          <PermissionDeniedState
            description="CSRD のデータ収集を見るには、開示の閲覧権限が必要です。"
            permission="enterprise.disclosure.read"
          />
        </>
      );
    }
    throw error;
  }
  const { canWrite, canCreateCollection } = csrdPlanPermissions(shell.ctx);
  const members = canCreateCollection ? await listMentionCandidates(shell.db, shell.ctx) : [];
  const progressByDataPoint = await loadApprovalProgressMap(
    shell.db,
    shell.ctx,
    collection.planRows.map((r) => r.dataPointId).filter((id): id is Uuid => id !== null),
  );

  const { requirementRows, planRows } = collection;
  const stateFilterParam = single(query.state);
  const stateFilter = (CSRD_DATA_STATES as readonly string[]).includes(stateFilterParam ?? '')
    ? (stateFilterParam as CsrdDataState)
    : null;
  const visibleRows = stateFilter
    ? requirementRows.filter((r) => r.state === stateFilter)
    : requirementRows;
  const stateCounts = Object.fromEntries(
    CSRD_DATA_STATES.map((s) => [s, requirementRows.filter((r) => r.state === s).length]),
  ) as Record<CsrdDataState, number>;
  const requirementCount = new Set(requirementRows.map((r) => r.item.id)).size;

  const eligible = eligiblePlans(plans);
  const eligibleByItem = new Map<Uuid, CsrdActionPlanView>();
  for (const view of eligible) {
    if (view.item && !eligibleByItem.has(view.item.id)) eligibleByItem.set(view.item.id, view);
  }
  const canOpenCreate = canCreateCollection && eligible.length > 0;
  const panelOpen = canOpenCreate && isCreatePanelOpen(query);
  const openCreateHref = `${createPanelHref(BASE, query, { open: true })}#${CREATE_PANEL_ID}`;

  // 収集項目の候補: 評価対象の要求事項に対応付いた指標（コードの重複を除く）
  const metricOptions: MetricDefinition[] = [];
  for (const row of requirementRows) {
    if (!metricOptions.some((m) => m.code === row.metric.code)) metricOptions.push(row.metric);
  }
  // 状況の表から「収集項目を作成」で来たときの初期値（URL の値はここで照合し、知らない値は使わない）
  const prefillMetric = metricOptions.find((m) => m.code === single(query.metric)) ?? null;
  const prefillUnitId = shell.units.some((u) => u.id === single(query.unit))
    ? single(query.unit)
    : null;
  const defaultPlan = eligible.find((p) => p.plan.id === single(query.plan)) ?? eligible[0] ?? null;
  const formKey = `${defaultPlan?.plan.id ?? ''}/${prefillMetric?.code ?? ''}/${prefillUnitId ?? ''}`;

  const overdueItems = planRows.filter(
    (r) => r.daysLeft !== null && r.daysLeft < 0 && r.state !== 'approved',
  ).length;

  const statusRows: StatusRow[] = visibleRows.map((row, index) => {
    const plan = eligibleByItem.get(row.item.id);
    // 拠点が分かる・データの行が無い＝割当（収集依頼）だけがある
    const requested = row.unit !== null && row.dataPointId === null;
    const next = row.dataPointId ? (
      <Link
        href={`/enterprise/data/${row.dataPointId}`}
        className="text-brand-700 underline-offset-2 hover:underline"
      >
        データを開く
      </Link>
    ) : requested ? (
      <span className="text-ink-muted">収集依頼済み（未入力）</span>
    ) : canCreateCollection && plan ? (
      <Link
        href={`${BASE}?${new URLSearchParams({
          plan: plan.plan.id,
          metric: row.metric.code,
          new: '1',
        }).toString()}#${CREATE_PANEL_ID}`}
        className="text-brand-700 underline-offset-2 hover:underline"
      >
        収集項目を作成
      </Link>
    ) : canWrite ? (
      <Link
        href={`/enterprise/disclosures/csrd/requirements/${row.item.id}`}
        className="text-brand-700 underline-offset-2 hover:underline"
      >
        対応計画を立てる
      </Link>
    ) : (
      <span className="text-ink-muted">—</span>
    );
    return { row, firstOfItem: visibleRows[index - 1]?.item.id !== row.item.id, next };
  });

  return (
    <>
      <PageHeader
        title="CSRD データ収集"
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>{shell.currentPeriod.label} ／ 評価対象の要求事項のデータと収集項目</span>
            <SampleMasterBadge />
          </span>
        }
        help={
          <>
            <p>
              評価対象（常に適用・重要と判断した事項）の要求事項に対応付いた指標を、拠点ごとの当期の状況で並べます。
            </p>
            <p>
              2 つ目の表は CSRD の対応計画から作った収集項目だけです（SSBJ
              の計画・収集項目は出しません）。不足しているデータは「収集項目を作成」で、担当部署へ収集依頼できる形（指標
              × 拠点 × 期限）にします。
            </p>
          </>
        }
        autoBreadcrumbs
        actions={
          <PageActions
            primary={{
              kind: 'link',
              id: 'create-collection',
              shortcut: 'new',
              label: '収集項目を作成',
              href: openCreateHref,
              icon: <Plus aria-hidden="true" />,
              // 作成の枠を開いている間は、枠の中の確定ボタンが主操作
              hidden: !canOpenCreate || panelOpen,
            }}
            secondary={[
              {
                kind: 'link',
                id: 'draft',
                label: 'CSRD 開示ドラフト',
                href: '/enterprise/disclosures/csrd/draft',
                icon: <FileText aria-hidden="true" />,
              },
              {
                kind: 'link',
                id: 'imports',
                label: 'ファイルを取り込む',
                href: '/enterprise/imports',
                icon: <Upload aria-hidden="true" />,
              },
            ]}
            more={[
              {
                kind: 'link',
                id: 'plans',
                label: '対応計画へ戻る',
                href: '/enterprise/disclosures/csrd/plans',
                icon: <ArrowLeft aria-hidden="true" />,
              },
            ]}
          />
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        {/* 作成（?new=1 のときだけ開く。入力の誤りで戻っても入力と場所を失わない） */}
        {!canCreateCollection ? (
          <p className="flex items-start gap-2 text-small text-ink-muted">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            収集項目の作成には、開示の編集権限と指標の管理権限の両方が必要です。
          </p>
        ) : eligible.length === 0 ? (
          <div className="flex items-start gap-2">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
            <p className="text-small text-ink-muted">
              収集項目を作れる対応計画がありません（指標を結び付けていない・完了していない・評価対象の要求事項の計画が対象です）。
              <Link
                href="/enterprise/disclosures/csrd/requirements"
                className="ml-1 text-brand-700 underline"
              >
                要求事項の詳細で対応計画を追加する
              </Link>
            </p>
          </div>
        ) : (
          <CreatePanel
            id={CREATE_PANEL_ID}
            title="計画から収集項目を作成"
            searchParams={query}
            closeHref={createPanelHref(BASE, query, { open: false })}
            description="対応計画に、指標・拠点・担当・期限を結び付けます。期限は期間の提出期限、担当部署は計画の担当部署を初期値にしています。"
          >
            <PreservingForm
              key={formKey}
              action={createCsrdCollectionItemAction}
              className="space-y-2.5"
            >
              <div className="grid grid-cols-4 gap-2">
                <label className="col-span-2 space-y-1">
                  <span className="block text-caption text-ink-muted">対象の対応計画</span>
                  <NativeSelect name="planId" defaultValue={defaultPlan?.plan.id}>
                    {eligible.map(({ plan, item }) => (
                      <option key={plan.id} value={plan.id}>
                        【{GAP_KIND_LABEL[plan.gapKind]}】{item ? `${item.code} ` : ''}
                        {plan.title}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <label className="space-y-1">
                  <span className="block text-caption text-ink-muted">データ項目コード</span>
                  <Input
                    type="text"
                    name="metricCode"
                    required
                    maxLength={100}
                    list="csrd-collection-metric-codes"
                    defaultValue={prefillMetric?.code ?? ''}
                    placeholder="scope2_location"
                    className="font-mono"
                  />
                  <datalist id="csrd-collection-metric-codes">
                    {metricOptions.map((m) => (
                      <option key={m.id} value={m.code}>
                        {m.name}（{m.unit}）
                      </option>
                    ))}
                  </datalist>
                </label>
                <label className="space-y-1">
                  <span className="block text-caption text-ink-muted">データ項目名</span>
                  <Input
                    type="text"
                    name="metricName"
                    required
                    maxLength={200}
                    defaultValue={prefillMetric?.name ?? ''}
                    placeholder="Scope2 排出量（ロケーション基準）"
                  />
                </label>
              </div>
              <div className="grid grid-cols-5 gap-2">
                <label className="space-y-1">
                  <span className="block text-caption text-ink-muted">単位</span>
                  <Input
                    type="text"
                    name="unit"
                    maxLength={40}
                    defaultValue={prefillMetric?.unit ?? ''}
                    placeholder="t-CO2e"
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-caption text-ink-muted">集計対象範囲（拠点）</span>
                  <NativeSelect name="unitId" defaultValue={prefillUnitId ?? shell.units[0]?.id}>
                    {shell.units.map((unit) => (
                      <option key={unit.id} value={unit.id}>
                        {unit.name}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <label className="space-y-1">
                  <span className="block text-caption text-ink-muted">入力担当者</span>
                  <NativeSelect name="ownerUserId" defaultValue="">
                    <option value="">未設定</option>
                    {members.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.displayName}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <label className="space-y-1">
                  <span className="block text-caption text-ink-muted">提出期限</span>
                  <Input
                    type="date"
                    name="dueDate"
                    required
                    defaultValue={shell.currentPeriod.submissionDueDate ?? ''}
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-caption text-ink-muted">担当部署</span>
                  <Input
                    type="text"
                    name="department"
                    maxLength={100}
                    defaultValue={defaultPlan?.plan.department ?? ''}
                  />
                </label>
              </div>
              <NativeCheckbox
                name="requiresEvidence"
                defaultChecked
                label="証跡資料の添付を必須にする（第三者保証に備える）"
              />
              <MoreInfo label="既にある指標・割当を選んだときの扱い">
                <p>
                  既にある指標のコードを選ぶと、指標は作り直さず、この拠点・期間の担当と期限だけを作ります。
                </p>
                <p>
                  同じ指標・拠点・期間の割当が既にあれば、割当は作り直さず（担当・期限は変えず）計画に結び付けます。新しいコードは
                  CSRD を出所とする指標として作ります。
                </p>
              </MoreInfo>
              <SubmitButton
                variant="primary"
                size="sm"
                icon={<Database aria-hidden="true" />}
                pendingLabel="作成しています…"
              >
                収集項目を作成
              </SubmitButton>
            </PreservingForm>
          </CreatePanel>
        )}

        {/* 当期の状況の件数（分母付き）。各状況はその行だけに絞った表へのリンク */}
        <Card className="flex flex-wrap items-start gap-x-6 gap-y-2 p-3">
          <StatusBreakdown
            label="当期の状況の件数"
            unit="行"
            className="min-w-[320px] flex-1"
            denominator={requirementRows.length}
            items={CSRD_DATA_STATES.map((state) => ({
              key: state,
              label: CSRD_DATA_STATE_LABEL[state],
              count: stateCounts[state],
              icon: CSRD_DATA_STATE_ICON[state],
              href: `${BASE}?state=${state}#csrd-collection-requirement-rows`,
            }))}
          />
          <p className="flex items-center gap-1 text-small">
            <ClipboardList className="size-3.5 text-ink-muted" aria-hidden="true" />
            <Link
              href={`${BASE}#csrd-collection-plan-rows`}
              className="text-brand-700 hover:underline"
            >
              計画から作った収集項目
            </Link>
            <span className="tabular-nums text-ink">{planRows.length} 件</span>
            {overdueItems > 0 && (
              <span className="font-semibold text-danger">（期限超過 {overdueItems} 件）</span>
            )}
          </p>
        </Card>

        <Section
          id="csrd-collection-requirement-rows"
          title={`評価対象の要求事項 × 指標 × 拠点（${requirementCount} 要求事項 ／ ${requirementRows.length} 行）`}
          actions={
            <span className="flex items-center gap-2 text-caption text-ink-muted">
              {stateFilter ? (
                <>
                  <span>
                    絞込: {CSRD_DATA_STATE_LABEL[stateFilter]}（{visibleRows.length} 行）
                  </span>
                  <Link href={BASE} className="text-brand-700 underline">
                    絞込を解除
                  </Link>
                </>
              ) : (
                '値は承認済みのものだけを表示します（未入力を 0 として扱いません）'
              )}
            </span>
          }
        >
          {requirementRows.length === 0 ? (
            <EmptyState
              kind="no-data"
              size="compact"
              title="評価対象の要求事項に対応付いた指標がありません"
              description="ダブル・マテリアリティ評価で重要と判断した事項と ESRS 2 の要求事項のうち、指標が対応付いたものがここに並びます。"
              action={
                <Link
                  href="/enterprise/disclosures/csrd/requirements"
                  className="text-small text-brand-700 underline"
                >
                  要求事項の評価へ
                </Link>
              }
            />
          ) : visibleRows.length === 0 ? (
            <p className="px-3 pb-3 text-small text-ink-muted">
              この状況の行はありません。
              <Link href={BASE} className="ml-1 text-brand-700 underline">
                絞込を解除
              </Link>
            </p>
          ) : (
            <DataTable<StatusRow>
              id="csrd-collection-status"
              caption="評価対象の要求事項 × 指標 × 拠点の当期の状況"
              columns={STATUS_COLUMNS}
              rows={statusRows}
              getRowId={({ row }) => `${row.item.id}/${row.metric.id}/${row.unit?.id ?? 'none'}`}
              getRowLabel={({ row }) =>
                `${row.item.code} ${row.metric.name}${row.unit ? `（${row.unit.name}）` : ''}`
              }
              searchParams={query}
              basePath={BASE}
              search={false}
              empty={{
                noData: {
                  title: '評価対象の要求事項に対応付いた指標がありません',
                  action: (
                    <Link
                      href="/enterprise/disclosures/csrd/requirements"
                      className="text-small text-brand-700 underline"
                    >
                      要求事項の評価へ
                    </Link>
                  ),
                },
              }}
            />
          )}
        </Section>

        <Section
          id="csrd-collection-plan-rows"
          title={`計画から作成した収集項目（${planRows.length}）`}
        >
          <DataTable<CsrdCollectionRow>
            id="csrd-collection-plans"
            caption="計画から作成した収集項目"
            columns={planColumns(progressByDataPoint)}
            rows={planRows}
            getRowId={(row) => `${row.plan.id}/${row.metricCode}/${row.unitName}`}
            getRowLabel={(row) => `${row.metricName}（${row.unitName}）`}
            searchParams={query}
            basePath={BASE}
            search={false}
            empty={{
              noData: {
                title: '計画から作成した収集項目はまだありません',
                description: '対応計画に指標・拠点・担当・期限を結び付けると、ここに並びます。',
                action: canOpenCreate ? (
                  <Link href={openCreateHref} className="text-small text-brand-700 underline">
                    計画から収集項目を作成する
                  </Link>
                ) : (
                  <Link
                    href="/enterprise/disclosures/csrd/requirements"
                    className="text-small text-brand-700 underline"
                  >
                    要求事項の詳細で対応計画を立てる
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
