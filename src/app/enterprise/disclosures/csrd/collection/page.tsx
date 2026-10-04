import Link from 'next/link';
import {
  ArrowLeft,
  CircleAlert,
  CircleCheck,
  ClipboardList,
  Clock,
  Database,
  FileText,
  RotateCcw,
  Upload,
} from 'lucide-react';
import { StatusBreakdown } from '@/components/charts/status-breakdown';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { PreservingForm } from '@/components/shared/preserving-form';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { MoreInfo } from '@/components/ui/more-info';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
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
const BREADCRUMBS = [
  { label: '企業ワークスペース' },
  { label: '開示対応' },
  { label: 'CSRD', href: '/enterprise/disclosures/csrd' },
  { label: 'データ収集' },
];

function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/** 収集項目を作れる計画: 指標を結び付けていない・完了していない・評価対象の要求事項の計画（データの観点を先頭に） */
function eligiblePlans(plans: readonly CsrdActionPlanView[]): CsrdActionPlanView[] {
  return plans
    .filter((p) => p.plan.linkedMetricCode === null && p.plan.status !== 'done' && !p.outOfScope)
    .sort((a, b) => Number(b.plan.gapKind === 'data') - Number(a.plan.gapKind === 'data'));
}

/** 要求事項ごとにまとめる（表の 1 列目を行結合するため。並びは Service の順のまま） */
function groupByItem(rows: readonly CsrdRequirementDataRow[]): CsrdRequirementDataRow[][] {
  const groups: CsrdRequirementDataRow[][] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last[0]?.item.id === row.item.id) last.push(row);
    else groups.push([row]);
  }
  return groups;
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
    return <span className="text-[11px] text-ink-muted">—</span>;
  }
  return (
    <Link
      href={`/enterprise/data/${dataPointId}#承認履歴`}
      className="block space-y-0.5 rounded-t4d px-1 py-0.5 hover:bg-surface-muted"
    >
      <span className="flex items-center gap-1.5">
        <span className="text-[12px] tabular-nums text-ink">
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
      <span className="block text-[11px] text-ink-muted">
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
  if (value === null) return <span className="text-[11px] text-ink-muted">数値なし</span>;
  return (
    <span className="inline-flex items-center gap-1">
      {formatNumber(value)}
      <span className="text-[11px] text-ink-muted">{unit}</span>
      {valueKind === 'estimate' && <EstimateValueBadge />}
    </span>
  );
}

/**
 * CSRD データ収集（docs/disclosure-first.md §9.4）。
 *  - 評価対象（常に適用・重要と判断した事項）の要求事項 × 対応指標 × 拠点の当期の状況。値は承認済みだけ
 *  - CSRD の計画から作った収集項目（既存の承認の道筋の進み具合）
 *  - 計画から収集項目を作る（新しい指標の出所は CSRD。既存の指標は作り直さず割当だけを作る）
 * 読込は書かない。SSBJ の計画・収集項目は出さない。
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
          <PageHeader title="CSRD データ収集" breadcrumbs={BREADCRUMBS} />
          <PermissionDeniedState description="CSRD のデータ収集を見るには、開示の閲覧権限が必要です。" />
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
              の計画・収集項目は出しません）。不足しているデータは「計画から収集項目を作成」で、担当部署へ収集依頼できる形（指標
              × 拠点 × 期限）にします。
            </p>
          </>
        }
        breadcrumbs={BREADCRUMBS}
        actions={
          <div className="flex items-center gap-1.5">
            {/* データが集まったら開示ドラフトへ——次の工程を主導線として置く */}
            <Button size="sm" asChild>
              <Link href="/enterprise/disclosures/csrd/draft">
                <FileText aria-hidden="true" />
                CSRD 開示ドラフト
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/enterprise/imports">
                <Upload aria-hidden="true" />
                ファイルを取り込む
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/enterprise/disclosures/csrd/plans">
                <ArrowLeft aria-hidden="true" />
                対応計画へ戻る
              </Link>
            </Button>
          </div>
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

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
          <p className="flex items-center gap-1 text-[12px]">
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

        <Card className="overflow-hidden" id="csrd-collection-requirement-rows">
          <SectionTitle
            title={`評価対象の要求事項 × 指標 × 拠点（${requirementCount} 要求事項 ／ ${requirementRows.length} 行）`}
            action={
              <span className="flex items-center gap-2 text-[11px] text-ink-muted">
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
          />
          {requirementRows.length === 0 ? (
            <EmptyState
              title="評価対象の要求事項に対応付いた指標がありません"
              description="ダブル・マテリアリティ評価で重要と判断した事項と ESRS 2 の要求事項のうち、指標が対応付いたものがここに並びます。"
              action={
                <Button size="sm" asChild>
                  <Link href="/enterprise/disclosures/csrd/requirements">要求事項の評価へ</Link>
                </Button>
              }
            />
          ) : visibleRows.length === 0 ? (
            <p className="px-3 pb-3 text-[12px] text-ink-muted">
              この状況の行はありません。
              <Link href={BASE} className="ml-1 text-brand-700 underline">
                絞込を解除
              </Link>
            </p>
          ) : (
            <div className="t4d-scroll-x">
              <Table aria-label="評価対象の要求事項 × 指標 × 拠点の当期の状況">
                <THead>
                  <TR>
                    <TH>要求事項</TH>
                    <TH>指標</TH>
                    <TH>拠点</TH>
                    <TH>当期の状況</TH>
                    <TH align="right">承認済みの値</TH>
                    <TH>次の操作</TH>
                  </TR>
                </THead>
                <TBody>
                  {groupByItem(visibleRows).map((group) =>
                    group.map((row, index) => {
                      const plan = eligibleByItem.get(row.item.id);
                      // 拠点が分かる・データの行が無い＝割当（収集依頼）だけがある
                      const requested = row.unit !== null && row.dataPointId === null;
                      return (
                        <TR key={`${row.item.id}/${row.metric.id}/${row.unit?.id ?? 'none'}`}>
                          {index === 0 && (
                            <TD rowSpan={group.length} className="max-w-[220px] py-1.5 align-top">
                              <Link
                                href={`/enterprise/disclosures/csrd/requirements/${row.item.id}`}
                                className="font-mono text-[12px] font-medium text-brand-800 hover:underline"
                              >
                                {row.item.code}
                              </Link>
                              <span className="block text-[11px] text-ink-muted">
                                {row.section
                                  ? CSRD_SECTION_LABEL[row.section]
                                  : '節を判定できません'}
                              </span>
                            </TD>
                          )}
                          <TD className="text-[12px]">
                            {row.metric.name}
                            <span className="ml-1 font-mono text-[11px] text-ink-muted">
                              {row.metric.code}
                            </span>
                          </TD>
                          <TD className="text-[12px]">
                            {row.unit?.name ?? (
                              <span className="text-ink-muted">全拠点（データ・割当なし）</span>
                            )}
                          </TD>
                          <TD>
                            <CsrdDataStateBadge state={row.state} />
                          </TD>
                          <TD align="right">
                            <ApprovedValue
                              state={row.state}
                              value={row.value}
                              unit={row.unitOfMeasure}
                              valueKind={row.valueKind}
                            />
                          </TD>
                          <TD className="text-[11px]">
                            {row.dataPointId ? (
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
                                }).toString()}#csrd-collection-create`}
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
                            )}
                          </TD>
                        </TR>
                      );
                    }),
                  )}
                </TBody>
              </Table>
            </div>
          )}
        </Card>

        <Card className="overflow-hidden" id="csrd-collection-plan-rows">
          <SectionTitle title={`計画から作成した収集項目（${planRows.length}）`} />
          {planRows.length === 0 ? (
            <EmptyState
              icon={<ClipboardList className="size-5" aria-hidden="true" />}
              title="計画から作成した収集項目はまだありません"
              description="下の「計画から収集項目を作成」で、対応計画に指標・拠点・担当・期限を結び付けてください。"
            />
          ) : (
            <div className="t4d-scroll-x">
              <Table aria-label="計画から作成した収集項目">
                <THead>
                  <TR>
                    <TH>データ項目</TH>
                    <TH>集計対象範囲</TH>
                    <TH>入力担当者</TH>
                    <TH>提出期限</TH>
                    <TH>当期の状況</TH>
                    <TH align="right">承認済みの値</TH>
                    <TH>承認の進み具合</TH>
                    <TH>元の対応計画</TH>
                  </TR>
                </THead>
                <TBody>
                  {planRows.map((row) => (
                    <TR key={`${row.plan.id}/${row.metricCode}/${row.unitName}`}>
                      <TD className="font-medium text-ink">
                        {row.metricName}
                        <span className="ml-1 font-mono text-[11px] text-ink-muted">
                          {row.metricCode}
                        </span>
                      </TD>
                      <TD className="text-[12px]">{row.unitName}</TD>
                      <TD className="text-[11px]">{row.ownerName ?? '未設定'}</TD>
                      <TD className="whitespace-nowrap text-[11px]">
                        {row.dueDate ? formatJstDate(row.dueDate) : '未設定'}
                        <DaysLeft daysLeft={row.daysLeft} done={row.state === 'approved'} />
                      </TD>
                      <TD>
                        <CsrdDataStateBadge state={row.state} />
                      </TD>
                      <TD align="right">
                        <ApprovedValue
                          state={row.state}
                          value={row.collectedValue}
                          unit={row.unit}
                          valueKind={row.valueKind}
                        />
                      </TD>
                      <TD>
                        <ApprovalProgressCell
                          dataPointId={row.dataPointId}
                          progress={
                            row.dataPointId ? progressByDataPoint.get(row.dataPointId) : undefined
                          }
                        />
                      </TD>
                      <TD className="max-w-[240px] text-[11px] text-ink-muted">
                        {row.plan.title}
                        {row.item && (
                          <Link
                            href={`/enterprise/disclosures/csrd/requirements/${row.item.id}`}
                            className="ml-1 font-mono text-brand-700 hover:underline"
                          >
                            {row.item.code}
                          </Link>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </Card>

        <Card className="overflow-hidden" id="csrd-collection-create">
          <SectionTitle title="計画から収集項目を作成" />
          {!canCreateCollection ? (
            <p className="flex items-start gap-2 px-3 pb-3 text-[12px] text-ink-muted">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              収集項目の作成には、開示の編集権限と指標の管理権限の両方が必要です。
            </p>
          ) : eligible.length === 0 ? (
            <div className="flex items-start gap-2 px-3 pb-3">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
              <p className="text-[12px] text-ink-muted">
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
            <PreservingForm
              key={formKey}
              action={createCsrdCollectionItemAction}
              className="space-y-2.5 p-3"
            >
              <div className="grid grid-cols-4 gap-2">
                <label className="col-span-2 space-y-1">
                  <span className="block text-[11px] text-ink-muted">対象の対応計画</span>
                  <select
                    name="planId"
                    defaultValue={defaultPlan?.plan.id}
                    className="h-7 w-full rounded-t4d border border-line bg-surface px-1.5 text-[12px]"
                  >
                    {eligible.map(({ plan, item }) => (
                      <option key={plan.id} value={plan.id}>
                        【{GAP_KIND_LABEL[plan.gapKind]}】{item ? `${item.code} ` : ''}
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
                    maxLength={100}
                    list="csrd-collection-metric-codes"
                    defaultValue={prefillMetric?.code ?? ''}
                    placeholder="scope2_location"
                    className="h-7 w-full rounded-t4d border border-line px-2 font-mono text-[12px]"
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
                  <span className="block text-[11px] text-ink-muted">データ項目名</span>
                  <input
                    type="text"
                    name="metricName"
                    required
                    maxLength={200}
                    defaultValue={prefillMetric?.name ?? ''}
                    placeholder="Scope2 排出量（ロケーション基準）"
                    className="h-7 w-full rounded-t4d border border-line px-2 text-[12px]"
                  />
                </label>
              </div>
              <div className="grid grid-cols-5 gap-2">
                <label className="space-y-1">
                  <span className="block text-[11px] text-ink-muted">単位</span>
                  <input
                    type="text"
                    name="unit"
                    maxLength={40}
                    defaultValue={prefillMetric?.unit ?? ''}
                    placeholder="t-CO2e"
                    className="h-7 w-full rounded-t4d border border-line px-2 text-[12px]"
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-[11px] text-ink-muted">集計対象範囲（拠点）</span>
                  <select
                    name="unitId"
                    defaultValue={prefillUnitId ?? shell.units[0]?.id}
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
                    className="h-7 w-full rounded-t4d border border-line px-2 text-[12px]"
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-[11px] text-ink-muted">担当部署</span>
                  <input
                    type="text"
                    name="department"
                    maxLength={100}
                    defaultValue={defaultPlan?.plan.department ?? ''}
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
                size="sm"
                icon={<Database aria-hidden="true" />}
                pendingLabel="作成しています…"
              >
                収集項目を作成
              </SubmitButton>
            </PreservingForm>
          )}
        </Card>
      </div>
    </>
  );
}
