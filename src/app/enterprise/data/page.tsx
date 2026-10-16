import Link from 'next/link';
import {
  CircleCheck,
  CircleDashed,
  CopyPlus,
  Download,
  Eye,
  FilePen,
  FileText,
  Undo2,
  Upload,
  X,
  type LucideIcon,
} from 'lucide-react';
import { StatusBreakdown } from '@/components/charts/status-breakdown';
import {
  AvailabilityBadge,
  DataPointStatusBadge,
  ValueKindBadge,
} from '@/components/shared/badges';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { FlashMessage } from '@/components/shared/flash';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import {
  CONSOLIDATED_UNIT_TAG,
  isConsolidatedUnit,
  isFyReportingUnit,
  NO_MATCH_UNIT_ID,
} from '@/lib/domain/boundaries';
import { can } from '@/lib/authorization/can';
import { previousComparablePeriod } from '@/lib/domain/period-comparability';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import {
  loadDataPointPage,
  parseSortKey,
  type DataPointFilters,
  type DataPointRow,
} from '@/lib/services/enterprise-data';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { DEFAULT_PAGE_SIZES, parsePage, parsePageSize } from '@/lib/table/columns';
import type { MenuActionSpec } from '@/lib/ui/actions';
import { statusLabel, statusOptions } from '@/lib/ui/status/registry';
import type { DataPointStatus } from '@/types/domain';
import { carryForwardAction } from '../actions';
import { AttentionCell, UnitOfMeasureCell } from './_components/data-badges';
import { DataBulkBar } from './_components/data-bulk-bar';

export const metadata = { title: '非財務データ' };

type SearchParams = Record<string, string | string[] | undefined>;

const BASE_PATH = '/enterprise/data';
const BULK_FORM_ID = 'bulk-form';

/**
 * 状態の内訳の帯（docs/disclosure-first.md §10.4 B6）。ラベルは状態登録簿（絞り込みの選択肢と同じ文言）。
 * アイコンは状態のバッジと同じもの（登録簿の意味ごとのアイコン。回転を連想させる Loader2 は使わない）。
 * リンクにはしない（絞り込みは表の上に 1 か所だけ置き、同じ名前のリンクを重ねない）
 */
const STATUS_BREAKDOWN: ReadonlyArray<{ status: DataPointStatus; icon: LucideIcon }> = [
  { status: 'not_started', icon: CircleDashed },
  { status: 'draft', icon: FilePen },
  { status: 'submitted', icon: Eye },
  { status: 'in_review', icon: Eye },
  { status: 'returned', icon: Undo2 },
  { status: 'approved', icon: CircleCheck },
];

/** 要対応の絞り込み（plan §1.17 の語。「レビュー待ち」と「承認待ち」は同じ条件なので 1 つの名前にする） */
const FLAG_OPTIONS = [
  { value: 'validation_error', label: '検証エラー' },
  { value: 'missing_evidence', label: '根拠資料の不足' },
  { value: 'changed_after_approval', label: '承認後に変更' },
  { value: 'review_pending', label: 'レビュー・承認待ち' },
] as const;

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** 今の条件を保ったまま、担当拠点の既定の絞り込みを外す（unit= は「全組織」の既存の規則） */
function allUnitsHref(params: SearchParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === 'unit' || key === 'page' || key === 'flash' || key === 'error') continue;
    for (const v of toArray(value)) query.append(key, v);
  }
  query.set('unit', '');
  return `${BASE_PATH}?${query.toString()}`;
}

/**
 * 非財務データの一覧（plan S16。DataTable の基準実装）。
 *
 * 一覧の仕事は「探して状態を進める」。新規作成は無いので primary は置かない。
 * 毎日使う「取り込む」だけを見出しに出し、前年度からの複製・出力は「その他」へ（L2）。
 * 状態を進める操作は、行を選んだときだけ下端に出る一括操作（F019）。
 */
export default async function DataListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const shell = await loadEnterpriseShell();
  const { ctx } = shell;
  const scope = ctx.workspace.unitScopeIds;

  // 担当拠点を持つ利用者は、担当拠点で絞った状態を既定にする（plan D2）。URL に unit が無いときだけ。
  // unit= （空）は「全組織」の既存の規則のまま（チップの × がこれを指す）。描画後に URL は書き換えない
  const scopeDefaulted = params.unit === undefined && scope.length > 0;

  // 組織タグ「連結対象のみ」は仮想のタグ。選択されたら連結対象の組織 ID へ展開する
  // （持分法適用・対象外の組織を落とす）。実在の組織 ID と併用もできる。
  // 空文字の unit=（過去のブックマーク等）が来ても全件が消えないようにする
  const rawUnitIds = scopeDefaulted ? [...scope] : toArray(params.unit).filter(Boolean);
  const consolidatedOnly = rawUnitIds.includes(CONSOLIDATED_UNIT_TAG);
  const consolidatedUnitIds = shell.units.filter(isConsolidatedUnit).map((u) => u.id);
  const explicitUnitIds = rawUnitIds.filter((id) => id !== CONSOLIDATED_UNIT_TAG);
  const narrowed = consolidatedOnly
    ? explicitUnitIds.length > 0
      ? explicitUnitIds.filter((id) => consolidatedUnitIds.includes(id))
      : consolidatedUnitIds
    : explicitUnitIds;
  // 「連結対象のみ」と特定組織を併用して交差が空になった場合は 0 件を返す。
  // 空配列のまま渡すと「未指定」と区別できず、絞り込みが外れて全件表示になってしまう。
  const unitIds =
    consolidatedOnly && explicitUnitIds.length > 0 && narrowed.length === 0
      ? [NO_MATCH_UNIT_ID]
      : narrowed;

  const filters: DataPointFilters = {
    status: toArray(params.status) as DataPointStatus[],
    metricIds: toArray(params.metric),
    unitIds,
    search: typeof params.q === 'string' ? params.q : undefined,
    flag: typeof params.flag === 'string' ? (params.flag as DataPointFilters['flag']) : undefined,
  };

  // 並べ替えは DB 側で行う（ページ内だけを並べ替えると全体の並び順と食い違うため）
  const sortKey = parseSortKey(typeof params.sort === 'string' ? params.sort : undefined);
  const sortDir = params.dir === 'desc' ? 'desc' : 'asc';
  const sort = sortKey ? ({ key: sortKey, dir: sortDir } as const) : undefined;

  // 絞り込み・件数・ページングはすべて DB 側で行う（全件を読み込まない）。表示件数は ?size=（plan D9）
  const pageSize = parsePageSize(params.size);
  const pageData = await loadDataPointPage(
    shell.db,
    ctx,
    shell.currentPeriod,
    shell.metrics,
    shell.units,
    filters,
    parsePage(params.page),
    pageSize,
    sort,
  );

  // 絞り込みの拠点は年度のデータを集める拠点（連結対象外の検証拠点などを並べない。plan §2.6）
  const reportableUnits = shell.units.filter(isFyReportingUnit);
  const scopeNames = shell.units.filter((u) => scope.includes(u.id)).map((u) => u.name);

  // 当期の状態の内訳（絞り込みに関係なく、当期の全件）。一覧と同じ条件（組織・期間・削除済み除く）で数える
  const statusCounts = await Promise.all(
    STATUS_BREAKDOWN.map(({ status }) =>
      shell.db.count('dataPoints', {
        where: {
          organizationId: ctx.workspace.organizationId,
          reportingPeriodId: shell.currentPeriod.id,
          deletedAt: { isNull: true },
          status,
        },
      }),
    ),
  );
  const statusTotal = statusCounts.reduce((sum, count) => sum + count, 0);

  const canWrite = can(ctx, 'enterprise.data.write');
  const canReview = can(ctx, 'enterprise.data.review');
  // 一括承認はデータの承認の権限があるときだけ（レビューの権限では出さない。R4）
  const canApprove = can(ctx, 'enterprise.data.approve');
  // 出力はサーバーの出力 API と同じ権限のときだけ出す（押すと 403 になるリンクを置かない。R3）
  const canExport = can(ctx, 'enterprise.export.run');
  const canImport = can(ctx, 'enterprise.import.run');
  const canBulk = canWrite || canReview || canApprove;

  // 複製元は前年度複製（carryForwardFromPreviousPeriod）と同じ選び方（決算日が同じ期間。plan K10）
  const previousPeriod =
    previousComparablePeriod(shell.currentPeriod, shell.periods, 'end') ?? undefined;

  const exportHref = (format: 'csv' | 'xlsx') =>
    `/api/exports/data-points?period=${shell.currentPeriod.id}&format=${format}`;
  const more: MenuActionSpec[] = [
    {
      kind: 'confirm',
      id: 'carry-forward',
      label: '前年度から複製',
      icon: <CopyPlus className="size-3.5" aria-hidden="true" />,
      action: carryForwardAction,
      hidden: !canWrite,
      confirm: {
        tier: 'bulk',
        title: '前年度の値から複製しますか',
        scope: `${shell.currentPeriod.label} で未入力の組み合わせ（指標 × 組織）に、${
          previousPeriod?.label ?? '前年度'
        } の値を「入力中」として作ります。`,
        consequences: [
          '既に値のある組み合わせは変更しません（何度実行しても重複しません）。',
          '作った件数は実行後に表示します。提出・承認は通常どおり 1 件ずつ、または一括操作で行います。',
        ],
        confirmLabel: '複製する',
      },
    },
    {
      kind: 'link',
      id: 'export-csv',
      label: 'CSV 出力',
      icon: <Download className="size-3.5" aria-hidden="true" />,
      href: exportHref('csv'),
      download: true,
      group: 'export',
      hidden: !canExport,
    },
    {
      kind: 'link',
      id: 'export-xlsx',
      label: 'XLSX 出力',
      icon: <Download className="size-3.5" aria-hidden="true" />,
      href: exportHref('xlsx'),
      download: true,
      group: 'export',
      hidden: !canExport,
    },
  ];

  const columns: DataTableColumn<DataPointRow>[] = [
    {
      key: 'metric',
      header: '指標',
      importance: 'primary',
      lockVisible: true,
      pinned: 'left',
      cell: (row) => (
        <>
          <Link
            href={`${BASE_PATH}/${row.dataPoint.id}`}
            className="font-medium text-brand-800 hover:underline"
          >
            {row.metric.name}
          </Link>
          <div className="text-caption text-ink-muted">{row.metric.code}</div>
        </>
      ),
    },
    {
      key: 'unit',
      header: '組織',
      importance: 'primary',
      sortKey: 'unit',
      cell: (row) => (
        <>
          {row.unit.name}
          {row.dataPoint.boundary === '連結' && (
            <Badge tone="neutral" className="ml-1">
              連結
            </Badge>
          )}
        </>
      ),
    },
    {
      key: 'value',
      header: '値',
      importance: 'primary',
      sortKey: 'value',
      align: 'right',
      // 値の無い行は「—」や 0 ではなく状態（未入力・対象外など）を出す。
      // 推計・目標は実績と取り違えないよう区分を併記する（§7.1）
      cell: (row) =>
        row.dataPoint.availabilityStatus !== 'value_present' ? (
          <AvailabilityBadge
            status={row.dataPoint.availabilityStatus}
            reason={row.dataPoint.absenceReason}
          />
        ) : row.dataPoint.value === null ? (
          <span className="text-small">{row.dataPoint.textValue ?? '—'}</span>
        ) : (
          <span className="inline-flex items-center gap-1">
            {formatNumber(row.dataPoint.value)}
            {row.dataPoint.valueKind !== 'actual' && (
              <ValueKindBadge kind={row.dataPoint.valueKind} />
            )}
          </span>
        ),
    },
    {
      // 既定で表示する（値の単位の取り違えに気づく列。列の切替の対象でもある）
      key: 'unitOfMeasure',
      header: '単位',
      importance: 'secondary',
      cell: (row) => (
        <UnitOfMeasureCell
          unitOfMeasure={row.dataPoint.unitOfMeasure}
          metricUnit={row.metric.unit}
        />
      ),
    },
    {
      key: 'status',
      header: '状態',
      importance: 'primary',
      sortKey: 'status',
      cell: (row) => (
        <DataPointStatusBadge status={row.dataPoint.status} needsRecheck={row.needsRecheck} />
      ),
    },
    {
      // 検証と根拠資料を 1 列に（対応が要るものだけを出す）
      key: 'attention',
      header: '要対応',
      importance: 'secondary',
      cell: (row) => (
        <AttentionCell
          errorCount={row.errorCount}
          warningCount={row.warningCount}
          evidenceCount={row.evidenceCount}
          requiresEvidence={row.metric.requiresEvidence}
        />
      ),
    },
    {
      // ヘッダーで選んでいる期間と同じ値なので、既定では出さない
      key: 'period',
      header: '期間',
      importance: 'detail',
      cell: (row) => row.period.code,
    },
    {
      key: 'updated',
      header: '更新日時',
      importance: 'detail',
      sortKey: 'updated',
      cell: (row) => (
        <span className="whitespace-nowrap text-caption text-ink-muted">
          {formatJst(row.dataPoint.updatedAt)}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="非財務データ"
        description={`${shell.currentPeriod.label} ／ 組織 × 期間 × 指標 × 値 × 単位 × 境界 × 版で一意に管理`}
        autoBreadcrumbs
        actions={
          <PageActions
            secondary={[
              {
                kind: 'link',
                id: 'import',
                label: 'データを取り込む',
                icon: <Upload aria-hidden="true" />,
                href: '/enterprise/imports',
                hidden: !canImport,
              },
            ]}
            more={more}
          />
        }
      />

      <div className="px-4 pt-3">
        <FlashMessage
          searchParams={params}
          // 取込の確定のあとは、この一覧が「次に確認する場所」。開示ドラフトへの道は横に残す（plan S15）
          undo={{
            imported: (
              <Link
                href="/enterprise/disclosures/ssbj/draft"
                className="inline-flex items-center gap-1 text-small text-brand-800 underline"
              >
                <FileText className="size-3.5" aria-hidden="true" />
                SSBJ 開示ドラフトへ
              </Link>
            ),
          }}
        />
      </div>
      <div className="space-y-3 px-4 pb-4">
        {statusTotal > 0 && (
          <StatusBreakdown
            label={`${shell.currentPeriod.code} の状態の内訳（全 ${statusTotal} 件）`}
            items={STATUS_BREAKDOWN.map(({ status, icon }, index) => ({
              key: status,
              label: statusLabel('dataPoint', status),
              count: statusCounts[index] ?? 0,
              icon,
            }))}
          />
        )}

        <div className="rounded-t4d-lg border border-line bg-surface">
          {scopeDefaulted && (
            <div
              className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5 text-small"
              data-t4d-scope-default=""
            >
              <span className="text-ink-muted">担当拠点で絞り込んでいます</span>
              <Link
                href={allUnitsHref(params)}
                aria-label={`担当: ${scopeNames.join('・')} の絞り込みを解除（すべての組織を表示）`}
                className="inline-flex items-center gap-1 rounded-t4d border border-brand-500 bg-brand-100 px-1.5 py-0.5 text-caption font-medium text-brand-900 hover:bg-brand-50"
              >
                担当: {scopeNames.join('・')}
                <X className="size-3" aria-hidden="true" />
              </Link>
            </div>
          )}
          <DataTable<DataPointRow>
            id="data-points"
            caption="非財務データ"
            columns={columns}
            rows={pageData.rows}
            getRowId={(row) => row.dataPoint.id}
            getRowLabel={(row) => `${row.unit.name} の ${row.metric.name}`}
            getRowStatus={(row) => statusLabel('dataPoint', row.dataPoint.status)}
            searchParams={params}
            basePath={BASE_PATH}
            search={{ placeholder: '指標名・組織名で検索' }}
            // チップは 2 群（状態・組織。組織のタグは 2026-08-19 の要望で一覧の上に並べている）。
            // 要対応は「絞り込み ▾」へ（保存ビューの「要対応のみ」「レビュー・承認待ち」からも入れる）
            filters={[
              { key: 'status', label: '状態', options: statusOptions('dataPoint') },
              {
                key: 'unit',
                label: '組織',
                options: [
                  { value: CONSOLIDATED_UNIT_TAG, label: '連結対象のみ' },
                  ...reportableUnits.map((u) => ({ value: u.id, label: u.name })),
                ],
              },
            ]}
            overflowFilters={[
              { key: 'flag', label: '要対応', options: [...FLAG_OPTIONS], multiple: false },
            ]}
            savedViews={[
              // 「自分の担当」は担当拠点が設定されている人にだけ意味がある。
              // 全社スコープ（unitScopeIds が空）の人に出すと、空クエリで常に 0 件になる。
              ...(scope.length > 0
                ? [{ label: '自分の担当', query: scope.map((id) => `unit=${id}`).join('&') }]
                : []),
              { label: '連結対象のみ', query: `unit=${CONSOLIDATED_UNIT_TAG}` },
              { label: '要対応のみ', query: 'flag=validation_error' },
              { label: 'レビュー・承認待ち', query: 'flag=review_pending' },
              { label: '承認済み', query: 'status=approved' },
            ]}
            userViews
            page={{
              page: pageData.page,
              pageSize: pageData.pageSize,
              total: pageData.total,
              sizes: DEFAULT_PAGE_SIZES,
            }}
            selection={
              canBulk
                ? {
                    formId: BULK_FORM_ID,
                    // 担当範囲の外の行は一括で動かせない（サービスが 1 件ずつ拒否する）
                    isSelectable: (row) => scope.length === 0 || scope.includes(row.unit.id),
                  }
                : undefined
            }
            bulkBar={
              canBulk ? (
                <DataBulkBar
                  formId={BULK_FORM_ID}
                  canWrite={canWrite}
                  canReview={canReview}
                  canApprove={canApprove}
                />
              ) : undefined
            }
            empty={{
              noData: {
                title: 'この報告期間のデータはまだありません',
                description: canImport
                  ? 'Excel・CSV を取り込むと、AI が仕分けた候補を確認してから登録できます。'
                  : 'データは拠点担当・作成担当が取り込み・入力すると、ここに並びます。',
                action: canImport ? (
                  <Link
                    href="/enterprise/imports"
                    className="text-small font-medium text-brand-700 hover:underline"
                  >
                    データを取り込む
                  </Link>
                ) : (
                  <Link
                    href="/enterprise/dashboard"
                    className="text-small font-medium text-brand-700 hover:underline"
                  >
                    ホームへ戻る
                  </Link>
                ),
              },
              filtered: {
                title: '該当するデータがありません',
                description: '絞り込み・検索の条件を変えてください。',
              },
            }}
          />
        </div>
      </div>
    </>
  );
}
