import Link from 'next/link';
import { CopyPlus, Database, Download } from 'lucide-react';
import { DataPointStatusBadge, EvidenceBadge, ValidationBadge } from '@/components/shared/badges';
import { FilterBar } from '@/components/shared/filter-bar';
import {
  CONSOLIDATED_UNIT_TAG,
  isConsolidatedUnit,
  NO_MATCH_UNIT_ID,
} from '@/lib/domain/boundaries';
import { PageHeader } from '@/components/shared/page-header';
import { Pagination } from '@/components/shared/pagination';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ColumnSelector, SortLink } from '@/components/shared/table-controls';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { DEFAULT_PAGE_SIZE, type DataPointStatus } from '@/types/domain';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import {
  loadDataPointPage,
  parseSortKey,
  type DataPointFilters,
} from '@/lib/services/enterprise-data';
import { FlashMessage } from '@/components/shared/flash';
import { can } from '@/lib/authorization/can';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { isColumnVisible } from '@/lib/table/columns';
import { carryForwardAction } from '../actions';
import { BulkActionBar } from './bulk-actions';

export const metadata = { title: '非財務データ' };

type SearchParams = Record<string, string | string[] | undefined>;

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export default async function DataListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const shell = await loadEnterpriseShell();

  // 組織タグ「連結対象のみ」は仮想のタグ。選択されたら連結対象の組織 ID へ展開する
  // （持分法適用・対象外の組織を落とす）。実在の組織 ID と併用もできる。
  const rawUnitIds = toArray(params.unit);
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

  // 列表示切替（UX-P0-004）。未指定なら全列表示。
  const cols = typeof params.cols === 'string' ? params.cols : undefined;
  const show = (key: string) => isColumnVisible(cols, key, ['metric', 'actions']);

  // 絞り込み・件数・ページングはすべて DB 側で行う（全件を読み込まない）
  const pageData = await loadDataPointPage(
    shell.db,
    shell.ctx,
    shell.currentPeriod,
    shell.metrics,
    shell.units,
    filters,
    Number(params.page ?? 1) || 1,
    DEFAULT_PAGE_SIZE,
    sort,
  );

  const reportableUnits = shell.units.filter((u) => u.unitType !== 'supplier');

  return (
    <>
      <PageHeader
        title="非財務データ"
        description={`${shell.currentPeriod.label} ／ 組織 × 期間 × 指標 × 値 × 単位 × 境界 × 版で一意に管理`}
        breadcrumbs={[{ label: '企業ワークスペース' }, { label: '非財務データ' }]}
        actions={
          <>
            {can(shell.ctx, 'enterprise.data.write') && (
              <form action={carryForwardAction}>
                <Button type="submit" variant="outline" size="sm">
                  <CopyPlus aria-hidden="true" />
                  前年度から複製
                </Button>
              </form>
            )}
            <ColumnSelector
              columns={[
                { key: 'metric', label: '指標' },
                { key: 'unit', label: '組織' },
                { key: 'period', label: '期間' },
                { key: 'value', label: '値' },
                { key: 'unitOfMeasure', label: '単位' },
                { key: 'status', label: '状態' },
                { key: 'validation', label: 'Validation' },
                { key: 'evidence', label: 'Evidence' },
                { key: 'updated', label: '更新日時' },
              ]}
              alwaysVisible={['metric']}
            />
            <Button variant="outline" size="sm" asChild>
              <a
                href={`/api/exports/data-points?period=${shell.currentPeriod.id}&format=csv`}
                download
              >
                <Download aria-hidden="true" />
                CSV
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a
                href={`/api/exports/data-points?period=${shell.currentPeriod.id}&format=xlsx`}
                download
              >
                <Download aria-hidden="true" />
                XLSX
              </a>
            </Button>
          </>
        }
      />

      <div className="px-4 pt-3">
        <FlashMessage searchParams={params} />
      </div>
      <div className="p-4">
        <Card className="overflow-hidden">
          <FilterBar
            total={pageData.total}
            groups={[
              {
                key: 'status',
                label: '状態',
                options: [
                  { value: 'not_started', label: '未着手' },
                  { value: 'draft', label: '入力中' },
                  { value: 'submitted', label: '提出済み' },
                  { value: 'in_review', label: 'レビュー中' },
                  { value: 'returned', label: '差戻し' },
                  { value: 'approved', label: '承認済み' },
                ],
              },
              {
                key: 'unit',
                label: '組織',
                options: [
                  { value: CONSOLIDATED_UNIT_TAG, label: '連結対象のみ' },
                  ...reportableUnits.map((u) => ({ value: u.id, label: u.name })),
                ],
              },
              {
                key: 'flag',
                label: '要対応',
                options: [
                  { value: 'validation_error', label: '検証エラー' },
                  { value: 'missing_evidence', label: 'Evidence不足' },
                  { value: 'changed_after_approval', label: '承認後変更' },
                  { value: 'review_pending', label: 'レビュー待ち' },
                ],
                multiple: false,
              },
            ]}
            savedViews={[
              { label: '自分の担当', query: `unit=${shell.ctx.workspace.unitScopeIds[0] ?? ''}` },
              { label: '連結対象のみ', query: `unit=${CONSOLIDATED_UNIT_TAG}` },
              { label: '要対応のみ', query: 'flag=validation_error' },
              { label: '承認待ち', query: 'flag=review_pending' },
              { label: '承認済み', query: 'status=approved' },
            ]}
          />

          {pageData.rows.length === 0 ? (
            <EmptyState
              title="該当するデータがありません"
              description="絞り込み条件を変更するか、データ収集からファイルを取り込んでください。"
              icon={<Database className="size-5" aria-hidden="true" />}
              action={
                <Button asChild size="sm">
                  <Link href="/enterprise/imports">データ収集へ</Link>
                </Button>
              }
            />
          ) : (
            <form action="#" id="data-list-form">
              <div className="t4d-scroll-x">
                <Table className="t4d-sticky-head">
                  <THead>
                    <TR>
                      <TH className="w-8" aria-label="選択" />
                      <TH>指標</TH>
                      {show('unit') && (
                        <TH>
                          <SortLink column="unit" label="組織" />
                        </TH>
                      )}
                      {show('period') && <TH>期間</TH>}
                      {show('value') && (
                        <TH align="right">
                          <SortLink column="value" label="値" />
                        </TH>
                      )}
                      {show('unitOfMeasure') && <TH>単位</TH>}
                      {show('status') && (
                        <TH>
                          <SortLink column="status" label="状態" />
                        </TH>
                      )}
                      {show('validation') && <TH>Validation</TH>}
                      {show('evidence') && <TH>Evidence</TH>}
                      {show('updated') && (
                        <TH>
                          <SortLink column="updated" label="更新日時" />
                        </TH>
                      )}
                      <TH className="w-16" aria-label="操作" />
                    </TR>
                  </THead>
                  <TBody>
                    {pageData.rows.map((row) => (
                      <TR key={row.dataPoint.id} data-t4d-record>
                        <TD>
                          <input
                            type="checkbox"
                            name="selected"
                            value={row.dataPoint.id}
                            form="bulk-form"
                            aria-label={`${row.unit.name} の ${row.metric.name} を選択`}
                            className="size-3.5 accent-[#0b57a4]"
                          />
                        </TD>
                        <TD>
                          <Link
                            href={`/enterprise/data/${row.dataPoint.id}`}
                            className="font-medium text-brand-800 hover:underline"
                          >
                            {row.metric.name}
                          </Link>
                          <div className="text-[11px] text-ink-muted">{row.metric.code}</div>
                        </TD>
                        {show('unit') && (
                          <TD>
                            {row.unit.name}
                            {row.dataPoint.boundary === '連結' && (
                              <Badge tone="neutral" className="ml-1">
                                連結
                              </Badge>
                            )}
                          </TD>
                        )}
                        {show('period') && <TD>{row.period.code}</TD>}
                        {show('value') && (
                          <TD align="right">{formatNumber(row.dataPoint.value)}</TD>
                        )}
                        {show('unitOfMeasure') && (
                          <TD>
                            <span
                              className={
                                row.dataPoint.unitOfMeasure !== row.metric.unit
                                  ? 'font-medium text-danger'
                                  : ''
                              }
                            >
                              {row.dataPoint.unitOfMeasure}
                            </span>
                          </TD>
                        )}
                        {show('status') && (
                          <TD>
                            <DataPointStatusBadge status={row.dataPoint.status} />
                          </TD>
                        )}
                        {show('validation') && (
                          <TD>
                            <ValidationBadge
                              errorCount={row.errorCount}
                              warningCount={row.warningCount}
                            />
                          </TD>
                        )}
                        {show('evidence') && (
                          <TD>
                            <EvidenceBadge
                              count={row.evidenceCount}
                              required={row.metric.requiresEvidence}
                            />
                          </TD>
                        )}
                        {show('updated') && (
                          <TD className="whitespace-nowrap text-[11px] text-ink-muted">
                            {formatJst(row.dataPoint.updatedAt)}
                          </TD>
                        )}
                        <TD>
                          <Button variant="ghost" size="xs" asChild>
                            <Link href={`/enterprise/data/${row.dataPoint.id}`}>詳細</Link>
                          </Button>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            </form>
          )}

          <Pagination
            page={pageData.page}
            pageSize={pageData.pageSize}
            total={pageData.total}
            basePath="/enterprise/data"
            searchParams={params}
          />
        </Card>

        <BulkActionBar
          canWrite={can(shell.ctx, 'enterprise.data.write')}
          canApprove={
            can(shell.ctx, 'enterprise.data.review') || can(shell.ctx, 'enterprise.data.approve')
          }
        />
      </div>
    </>
  );
}
