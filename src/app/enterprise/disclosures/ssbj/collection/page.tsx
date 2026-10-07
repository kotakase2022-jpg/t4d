import Link from 'next/link';
import {
  CalendarClock,
  CircleCheck,
  ClipboardList,
  Clock,
  FileText,
  RotateCcw,
  Upload,
} from 'lucide-react';
import { StatusBreakdown } from '@/components/charts/status-breakdown';
import { DataPointStatusBadge } from '@/components/shared/badges';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { FlashMessage } from '@/components/shared/flash';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { formatNumber } from '@/lib/format/datetime';
import { loadApprovalProgressMap } from '@/lib/services/approval-route';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { loadDataCollection, type DataCollectionRow } from '@/lib/services/ssbj-gap';
import { DEFAULT_PAGE_SIZES, parsePage, parsePageSize } from '@/lib/table/columns';
import type { DataPointStatus } from '@/types/domain';
import { collectionStatusItems } from '../_components/breakdown-items';

export const metadata = { title: 'SSBJ データ収集' };

const BASE_PATH = '/enterprise/disclosures/ssbj/collection';

/**
 * SSBJ データ収集（plan §2.26 E21）。この画面の仕事は「収集の進み具合を見る」ことなので primary は置かない。
 * 次の工程（開示ドラフト）へのリンクは secondary（plan §1.6: 次工程へのリンクを primary にしない）。
 * 一覧は DataTable（検索・列の表示切替・ページ送り）。元の対応計画は「列」から出す。
 */
export default async function SsbjCollectionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const rows = await loadDataCollection(shell.db, shell.ctx, shell.currentPeriod);

  // 取り込んだデータが今どの承認段階にいるかを、1 件ずつ問い合わせずまとめて読む
  const progressByDataPoint = await loadApprovalProgressMap(
    shell.db,
    shell.ctx,
    rows.map((r) => r.dataPointId).filter((id): id is string => Boolean(id)),
  );

  const overdue = rows.filter(
    (r) => r.daysLeft !== null && r.daysLeft < 0 && r.collectedStatus !== 'approved',
  );

  const search = (typeof query.q === 'string' ? query.q : '').trim();
  const filtered =
    search === ''
      ? rows
      : rows.filter((r) =>
          `${r.metricName} ${r.metricCode} ${r.unitName} ${r.ownerName ?? ''} ${r.plan.title}`.includes(
            search,
          ),
        );
  const pageSize = parsePageSize(query.size);
  const lastPage = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageNo = Math.min(parsePage(query.page), lastPage);
  const pageRows = filtered.slice((pageNo - 1) * pageSize, pageNo * pageSize);

  const columns: DataTableColumn<DataCollectionRow>[] = [
    {
      key: 'metric',
      header: 'データ項目',
      importance: 'primary',
      lockVisible: true,
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
      cell: (row) => row.unitName,
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
        <span className="text-caption">
          {row.dueDate ?? '未設定'}
          {row.daysLeft !== null && row.collectedStatus !== 'approved' && (
            <span
              className={row.daysLeft < 0 ? 'ml-1 font-medium text-danger' : 'ml-1 text-ink-muted'}
            >
              {row.daysLeft < 0 ? `${Math.abs(row.daysLeft)} 日超過` : `残り ${row.daysLeft} 日`}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'value',
      header: '収集済みの値',
      importance: 'secondary',
      align: 'right',
      cell: (row) =>
        row.collectedValue === null ? (
          <span className="text-ink-muted">未入力</span>
        ) : (
          <>
            {formatNumber(row.collectedValue)}
            <span className="ml-1 text-caption text-ink-muted">{row.unit}</span>
          </>
        ),
    },
    {
      key: 'status',
      header: '収集状況',
      importance: 'primary',
      cell: (row) =>
        row.collectedStatus === null ? (
          <Badge tone="warning">
            <Clock className="size-3" aria-hidden="true" />
            未入力
          </Badge>
        ) : (
          <DataPointStatusBadge status={row.collectedStatus as DataPointStatus} />
        ),
    },
    {
      key: 'approval',
      header: '承認の進み具合',
      importance: 'secondary',
      cell: (row) => {
        const progress = row.dataPointId ? progressByDataPoint.get(row.dataPointId) : undefined;
        if (!row.dataPointId || !progress || progress.totalCount === 0) {
          return <span className="text-caption text-ink-muted">—</span>;
        }
        return (
          <Link
            href={`/enterprise/data/${row.dataPointId}#承認履歴`}
            className="block space-y-0.5 rounded-t4d px-1 py-0.5 hover:bg-surface-muted"
          >
            <span className="flex items-center gap-1.5">
              {/* 色だけで状態を表さない。段数を必ず数字で書く */}
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
      },
    },
    {
      key: 'plan',
      header: '元の対応計画',
      importance: 'detail',
      cell: (row) => (
        <span className="block max-w-col-md text-caption text-ink-muted">{row.plan.title}</span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="SSBJ データ収集"
        description={`${shell.currentPeriod.label} ／ 対応計画から作成したデータ項目の収集状況`}
        autoBreadcrumbs
        actions={
          <PageActions
            secondary={[
              {
                // データが集まったら開示ドラフトへ（次の工程。この画面の仕事ではないので secondary）
                kind: 'link',
                id: 'draft',
                label: 'SSBJ 開示ドラフト',
                icon: <FileText aria-hidden="true" />,
                href: '/enterprise/disclosures/ssbj/draft',
              },
              {
                kind: 'link',
                id: 'import',
                label: 'ファイルを取り込む',
                icon: <Upload aria-hidden="true" />,
                href: '/enterprise/imports',
              },
            ]}
            more={[
              {
                kind: 'link',
                id: 'plans',
                label: '対応計画を開く',
                icon: <ClipboardList aria-hidden="true" />,
                href: '/enterprise/disclosures/ssbj/plans',
              },
            ]}
          />
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        {/* 収集の進捗。状態の内訳を 1 本の帯（合計 = 収集対象）にし、各区分を「n / 収集対象 件」で書く。
            期限超過は状態と重なるため帯の外に書く */}
        <Card className="space-y-2 p-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-small">
            <h2 className="text-body font-semibold text-ink">収集の進捗</h2>
            <p className="flex items-baseline gap-1">
              <span className="text-ink-muted">収集対象</span>
              <span className="text-figure font-semibold leading-none tabular-nums text-ink">
                {rows.length}
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
              <span className="text-ink-muted">件（承認済み以外）</span>
            </p>
          </div>
          {rows.length > 0 && (
            <StatusBreakdown
              label="収集状況の内訳"
              items={collectionStatusItems(rows)}
              denominator={rows.length}
            />
          )}
        </Card>

        <Section
          title={`データ項目（${rows.length}）`}
          summary={
            <span className="text-caption text-ink-muted">
              対応計画で「データ収集項目を作成」したものが並びます
            </span>
          }
        >
          <DataTable
            id="ssbj-collection"
            caption="SSBJ データ収集の項目"
            columns={columns}
            rows={pageRows}
            getRowId={(row) => `${row.plan.id}-${row.metricCode}-${row.unitName}`}
            getRowLabel={(row) => `${row.metricName}（${row.unitName}）`}
            getRowStatus={(row) => row.collectedStatus ?? 'not_started'}
            searchParams={query}
            basePath={BASE_PATH}
            search={{ placeholder: 'データ項目・範囲・担当者で検索' }}
            userViews
            page={{ page: pageNo, pageSize, total: filtered.length, sizes: DEFAULT_PAGE_SIZES }}
            empty={{
              noData: {
                title: '収集対象のデータ項目がありません',
                description:
                  '対応計画の画面で、データギャップの対応計画から「データ収集項目を作成」してください。',
                action: (
                  <Link
                    href="/enterprise/disclosures/ssbj/plans?gap=data"
                    className="inline-flex items-center gap-1 text-small text-brand-700 hover:underline"
                  >
                    <ClipboardList className="size-3.5" aria-hidden="true" />
                    データの対応計画を開く
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
