import * as React from 'react';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import { TableScrollRegion } from './scroll-region';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { DEFAULT_PAGE_SIZES, visibleColumnKeys, type ColumnImportance } from '@/lib/table/columns';
import type { ServerAction } from '@/lib/ui/actions';
import { cn } from '@/lib/utils';
import { BulkActionBar, type BulkActionSpec } from '../bulk-action-bar';
import { FilterBar, type FilterGroup } from '../filter-bar';
import { Pagination } from '../pagination';
import { RowActions } from '../row-actions';
import { EmptyState } from '../states';
import { SortLink } from '../table-controls';
import { ColumnMenu } from './column-menu';
import { ExpandToggle, PageSizeMenu, SelectAllCheckbox } from './row-controls';
import type { ViewPreset } from './view-menu';

/**
 * 一覧の表（plan §1.12・§3.2 DataTable）。Server Component。選択・列メニュー・保存ビュー・展開の島だけが
 * クライアント。
 *
 * - 列の表示は URL の cols が正（サーバー描画。外した列は DOM に出さない）。cols が無いときは
 *   importance が detail 以外。lockVisible の列は外せない
 * - 並べ替え（sort・dir）・絞り込み・ページ送り（page・size）はすべて URL。サーバー側で行う
 * - 一括操作のバーは行を選んだときだけ（選択 0 件では描かない）
 * - 全行に data-t4d-record（j/k で移動）、選択のチェックに data-t4d-select（x で切替）
 * - 行は「名前のセルを主リンク」にし、行の操作は RowActions（主な 1 操作＋操作 ▾）
 * - カードの格子に置き換えない（指示書 §11）。見出しは固定（Table の既定）
 */
export interface DataTableColumn<Row> {
  key: string;
  header: string;
  cell: (row: Row) => React.ReactNode;
  /** 既定の表示: primary・secondary は表示、detail は「列 ▾」から出す */
  importance: ColumnImportance;
  /** 外せない列（例: 指標名） */
  lockVisible?: boolean;
  /** URL の sort の値（並べ替えはサーバー） */
  sortKey?: string;
  align?: 'left' | 'right' | 'center';
  /** 先頭の列を横スクロールでも残す */
  pinned?: 'left';
  width?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
}

export type SearchParamsRecord = Record<string, string | string[] | undefined>;

export interface DataTableEmpty {
  /** まだ何も無いとき（次の操作は必須。指示書 §20） */
  noData: { title: string; description?: string; action: React.ReactNode };
  /** 絞り込みの結果が 0 件のとき（「絞り込みを解除」は自動） */
  filtered?: { title?: string; description?: string };
}

export interface DataTableProps<Row> {
  /** 表の識別子（保存ビューの鍵・要素の id の接頭辞） */
  id: string;
  /** 表の名前（caption。読み上げとテストが表を特定する） */
  caption: string;
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  getRowId: (row: Row) => string;
  getRowLabel: (row: Row) => string;
  /** 行の状態のラベル（一括バーの内訳と data-row-status） */
  getRowStatus?: (row: Row) => string | undefined;
  searchParams: SearchParamsRecord;
  basePath: string;
  /** よく使う絞り込み（チップ。2 群まで） */
  filters?: FilterGroup[];
  /** 残りの絞り込み（「絞り込み ▾」） */
  overflowFilters?: FilterGroup[];
  /** 一覧の検索（false で出さない） */
  search?: { placeholder: string } | false;
  /** 画面が用意する条件（保存ビューのプリセット） */
  savedViews?: ViewPreset[];
  /** 利用者の保存ビュー・既定ビュー（端末ごと） */
  userViews?: boolean;
  /** サーバー側のページ送り。sizes を渡すと「表示件数 ▾」を出す */
  page?: { page: number; pageSize: number; total: number; sizes?: readonly number[] };
  /** 行の選択（一括操作）。formId は一括バーのフォームの id */
  selection?: { formId: string; name?: string; isSelectable?: (row: Row) => boolean };
  /** 一括操作（サーバーの Server Action を直接送るもの） */
  bulkActions?: BulkActionSpec[];
  /** 一括バーのフォームの既定の送信先 */
  bulkAction?: ServerAction;
  /** 一括バーを画面側で描くとき（useActionState で結果を出すクライアントの部品など）。bulkActions より優先 */
  bulkBar?: React.ReactNode;
  rowActions?: (row: Row) => React.ComponentProps<typeof RowActions> | null;
  /** 展開行（理由・阻害条件など）。null の行は展開しない */
  expand?: (row: Row) => React.ReactNode | null;
  empty: DataTableEmpty;
  /** 件数の右に置く追加の操作 */
  toolbarExtra?: React.ReactNode;
  className?: string;
}

const WIDTH: Record<NonNullable<DataTableColumn<unknown>['width']>, string> = {
  xs: 'w-col-xs',
  sm: 'w-col-sm',
  md: 'w-col-md',
  lg: 'w-col-lg',
  xl: 'w-col-xl',
};

/** 絞り込み・検索の引数が付いているか（並べ替え・列・件数・ページは絞り込みではない） */
export function isFilteredView(
  searchParams: SearchParamsRecord,
  filterKeys: readonly string[],
): boolean {
  if (typeof searchParams.q === 'string' && searchParams.q.trim() !== '') return true;
  return filterKeys.some((key) => {
    const value = searchParams[key];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  });
}

/** 絞り込みを外した URL（列・並べ替え・表示件数は保つ） */
export function resetFiltersHref(
  basePath: string,
  searchParams: SearchParamsRecord,
  filterKeys: readonly string[],
): string {
  const params = new URLSearchParams();
  const drop = new Set(['q', 'page', 'flash', 'error', ...filterKeys]);
  for (const [key, value] of Object.entries(searchParams)) {
    if (drop.has(key) || value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) params.append(key, v);
    else params.set(key, value);
  }
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

export function DataTable<Row>({
  id,
  caption,
  columns,
  rows,
  getRowId,
  getRowLabel,
  getRowStatus,
  searchParams,
  basePath,
  filters = [],
  overflowFilters = [],
  search = { placeholder: '一覧を検索' },
  savedViews,
  userViews = false,
  page,
  selection,
  bulkActions,
  bulkAction,
  bulkBar,
  rowActions,
  expand,
  empty,
  toolbarExtra,
  className,
}: DataTableProps<Row>) {
  const visibleKeys = new Set(visibleColumnKeys(columns, searchParams.cols));
  const shown = columns.filter((column) => visibleKeys.has(column.key));
  const filterKeys = [...filters, ...overflowFilters].map((group) => group.key);
  const filtered = isFilteredView(searchParams, filterKeys);
  const total = page?.total ?? rows.length;
  const selectionName = selection?.name ?? 'selected';
  const hasExpand = Boolean(expand);
  const hasRowActions = Boolean(rowActions);
  const firstPinned = shown.findIndex((column) => column.pinned === 'left');
  const columnCount =
    shown.length + (selection ? 1 : 0) + (hasExpand ? 1 : 0) + (hasRowActions ? 1 : 0);

  const columnMenu = (
    <ColumnMenu
      columns={columns.map(({ key, header, importance, lockVisible }) => ({
        key,
        header,
        importance,
        lockVisible,
      }))}
      visible={[...visibleKeys]}
    />
  );

  const toolbarExtras = (
    <>
      {toolbarExtra}
      {columnMenu}
    </>
  );

  return (
    <div className={cn('min-w-0', className)} data-data-table={id}>
      {search !== false || filters.length > 0 || overflowFilters.length > 0 ? (
        <FilterBar
          groups={filters}
          overflowGroups={overflowFilters}
          searchPlaceholder={search === false ? undefined : search.placeholder}
          total={total}
          savedViews={savedViews}
          userViews={userViews ? { tableId: id, basePath } : undefined}
          extra={toolbarExtras}
        />
      ) : (
        <div className="flex items-center justify-end gap-2 border-b border-line bg-surface px-3 py-1.5">
          <span className="text-small text-ink-muted">{total.toLocaleString('ja-JP')} 件</span>
          {toolbarExtras}
        </div>
      )}

      {rows.length === 0 ? (
        filtered ? (
          <EmptyState
            kind="filtered"
            size="compact"
            title={empty.filtered?.title ?? '条件に一致するものがありません'}
            description={empty.filtered?.description}
            resetHref={resetFiltersHref(basePath, searchParams, filterKeys)}
          />
        ) : (
          <EmptyState
            kind="no-data"
            size="compact"
            title={empty.noData.title}
            description={empty.noData.description}
            action={empty.noData.action}
          />
        )
      ) : (
        <TableScrollRegion
          label={caption}
          data-t4d-bulk-scope={selection ? selection.formId : undefined}
        >
          <Table>
            <caption className="sr-only">{caption}</caption>
            <THead>
              <tr>
                {selection && (
                  <TH
                    className={cn('w-8', firstPinned >= 0 && 'left-0 z-(--z-sticky)')}
                    data-select-column=""
                  >
                    <SelectAllCheckbox formId={selection.formId} name={selectionName} />
                  </TH>
                )}
                {hasExpand && (
                  <TH className="w-8">
                    <span className="sr-only">詳細</span>
                  </TH>
                )}
                {shown.map((column, index) => (
                  <TH
                    key={column.key}
                    align={column.align}
                    className={cn(
                      column.width && WIDTH[column.width],
                      index === firstPinned && (selection ? 'left-8' : 'left-0'),
                    )}
                    data-column-key={column.key}
                  >
                    {column.sortKey ? (
                      <SortLink column={column.sortKey} label={column.header} />
                    ) : (
                      column.header
                    )}
                  </TH>
                ))}
                {hasRowActions && (
                  <TH align="right">
                    <span className="sr-only">操作</span>
                  </TH>
                )}
              </tr>
            </THead>
            <TBody>
              {rows.map((row) => {
                const rowId = getRowId(row);
                const label = getRowLabel(row);
                const status = getRowStatus?.(row);
                const detail = expand?.(row) ?? null;
                const detailId = `${id}-detail-${rowId}`;
                const actions = rowActions?.(row) ?? null;
                const selectable = selection?.isSelectable?.(row) ?? true;
                return (
                  <React.Fragment key={rowId}>
                    <TR data-t4d-record="" data-row-id={rowId} data-row-status={status}>
                      {selection && (
                        <TD
                          className={cn(
                            'w-8',
                            firstPinned >= 0 && 'sticky left-0 z-(--z-sticky-col) bg-surface',
                          )}
                        >
                          <NativeCheckbox
                            form={selection.formId}
                            name={selectionName}
                            value={rowId}
                            disabled={!selectable}
                            data-t4d-select=""
                            data-row-status={status}
                            aria-label={`${label} を選択`}
                          />
                        </TD>
                      )}
                      {hasExpand && (
                        <TD className="w-8">
                          {detail !== null && <ExpandToggle controls={detailId} rowLabel={label} />}
                        </TD>
                      )}
                      {shown.map((column, index) => (
                        <TD
                          key={column.key}
                          align={column.align}
                          className={cn(
                            'h-row',
                            column.width && WIDTH[column.width],
                            index === firstPinned &&
                              cn(
                                'sticky z-(--z-sticky-col) bg-surface',
                                selection ? 'left-8' : 'left-0',
                              ),
                          )}
                        >
                          {column.cell(row)}
                        </TD>
                      ))}
                      {hasRowActions && (
                        <TD align="right">{actions && <RowActions {...actions} />}</TD>
                      )}
                    </TR>
                    {detail !== null && (
                      <tr id={detailId} hidden data-row-detail={rowId}>
                        <td
                          colSpan={columnCount}
                          className="border-b border-line bg-surface-muted px-3 py-2 text-small"
                        >
                          {detail}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </TBody>
          </Table>
        </TableScrollRegion>
      )}

      {page && page.total > 0 && (
        <div className="flex items-center justify-end gap-2 border-t border-line bg-surface">
          <div className="min-w-0 flex-1">
            <Pagination
              page={page.page}
              pageSize={page.pageSize}
              total={page.total}
              basePath={basePath}
              searchParams={searchParams}
            />
          </div>
          {page.sizes && page.sizes.length > 1 && (
            <div className="pr-2">
              <PageSizeMenu sizes={page.sizes ?? DEFAULT_PAGE_SIZES} current={page.pageSize} />
            </div>
          )}
        </div>
      )}

      {selection &&
        (bulkBar ??
          (bulkActions && bulkActions.length > 0 ? (
            <BulkActionBar
              formId={selection.formId}
              name={selectionName}
              action={bulkAction}
              actions={bulkActions}
            />
          ) : null))}
    </div>
  );
}
