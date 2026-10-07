import Link from 'next/link';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import {
  colsParamFor,
  defaultColumnKeys,
  parsePage,
  parsePageSize,
  visibleColumnKeys,
} from '@/lib/table/columns';
import { applyListDefault, sanitizeViewQuery, parseTableViewStore } from '@/lib/table/views';

let search = new URLSearchParams();
vi.mock('next/navigation', () => ({
  usePathname: () => '/enterprise/data',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => search,
}));

const { DataTable, resetFiltersHref } = await import('@/components/shared/data-table');
const { BulkActionBar, selectionBreakdown } = await import('@/components/shared/bulk-action-bar');

/**
 * 一覧の表（plan §1.12・§3.5 data-table）。
 * cols の解釈（不正値で壊れない・外せない列は外れない）、既定は importance≠detail、
 * 選択 0 件で一括バーを出さない、絞り込みの結果 0 件には「絞り込みを解除」。
 */

interface Row {
  id: string;
  name: string;
  status: string;
  unit: string;
  updated: string;
}

const COLUMNS = [
  {
    key: 'metric',
    header: '指標',
    importance: 'primary' as const,
    lockVisible: true,
    pinned: 'left' as const,
    cell: (r: Row) => <a href={`/enterprise/data/${r.id}`}>{r.name}</a>,
  },
  { key: 'status', header: '状態', importance: 'primary' as const, cell: (r: Row) => r.status },
  { key: 'unit', header: '単位', importance: 'secondary' as const, cell: (r: Row) => r.unit },
  {
    key: 'updated',
    header: '更新日時',
    importance: 'detail' as const,
    sortKey: 'updated',
    cell: (r: Row) => r.updated,
  },
];

const ROWS: Row[] = [
  { id: 'a', name: '電力使用量', status: '入力中', unit: 'kWh', updated: '2026-10-01' },
  { id: 'b', name: '水使用量', status: '提出済み', unit: 'm3', updated: '2026-10-02' },
];

const EMPTY = {
  noData: {
    title: 'まだデータがありません',
    action: <Link href="/enterprise/imports">データを取り込む</Link>,
  },
};

beforeEach(() => {
  search = new URLSearchParams();
});

describe('列の表示（URL の cols）', () => {
  it('cols が無いときは importance が detail 以外（外せない列は常に）', () => {
    expect(defaultColumnKeys(COLUMNS)).toEqual(['metric', 'status', 'unit']);
    expect(visibleColumnKeys(COLUMNS, undefined)).toEqual(['metric', 'status', 'unit']);
  });

  it('不正な値・知らない列だけなら既定に戻り、外せない列は外れない', () => {
    expect(visibleColumnKeys(COLUMNS, 'zzz,,')).toEqual(['metric', 'status', 'unit']);
    expect(visibleColumnKeys(COLUMNS, 'updated')).toEqual(['metric', 'updated']);
    expect(visibleColumnKeys(COLUMNS, ['status', 'updated'])).toEqual([
      'metric',
      'status',
      'updated',
    ]);
  });

  it('既定と同じ集合なら cols を付けない（URL を短く保つ）', () => {
    expect(colsParamFor(COLUMNS, new Set(['metric', 'status', 'unit']))).toBeNull();
    expect(colsParamFor(COLUMNS, new Set(['status', 'updated']))).toBe('metric,status,updated');
  });

  it('外した列は DOM に出さない（サーバー描画）', () => {
    render(
      <DataTable
        id="data-points"
        caption="非財務データ"
        columns={COLUMNS}
        rows={ROWS}
        getRowId={(r) => r.id}
        getRowLabel={(r) => r.name}
        searchParams={{ cols: 'status' }}
        basePath="/enterprise/data"
        empty={EMPTY}
      />,
    );
    const table = screen.getByRole('table', { name: '非財務データ' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['指標', '状態']);
    expect(within(table).queryByText('kWh')).toBeNull();
  });
});

describe('表示件数・ページ', () => {
  it('候補に無い件数・不正なページは既定に戻す', () => {
    expect(parsePageSize('50')).toBe(50);
    expect(parsePageSize('999')).toBe(25);
    expect(parsePageSize(undefined, [25, 50], 50)).toBe(50);
    expect(parsePage('3')).toBe(3);
    expect(parsePage('-1')).toBe(1);
    expect(parsePage('abc')).toBe(1);
  });
});

describe('DataTable の描画', () => {
  it('全行に data-t4d-record、行の状態を data-row-status に出す', () => {
    const { container } = render(
      <DataTable
        id="data-points"
        caption="非財務データ"
        columns={COLUMNS}
        rows={ROWS}
        getRowId={(r) => r.id}
        getRowLabel={(r) => r.name}
        getRowStatus={(r) => r.status}
        searchParams={{}}
        basePath="/enterprise/data"
        empty={EMPTY}
      />,
    );
    const records = container.querySelectorAll('[data-t4d-record]');
    expect(records).toHaveLength(2);
    expect(records[1]).toHaveAttribute('data-row-status', '提出済み');
  });

  it('まだ何も無いときは次の操作を出す', () => {
    render(
      <DataTable
        id="data-points"
        caption="非財務データ"
        columns={COLUMNS}
        rows={[]}
        getRowId={(r) => r.id}
        getRowLabel={(r) => r.name}
        searchParams={{}}
        basePath="/enterprise/data"
        empty={EMPTY}
      />,
    );
    expect(screen.getByText('まだデータがありません')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'データを取り込む' })).toBeInTheDocument();
  });

  it('絞り込みの結果 0 件には「絞り込みを解除」（列・並べ替えは保つ）', () => {
    const params = { status: 'returned', q: '電力', cols: 'status', sort: 'updated' };
    render(
      <DataTable
        id="data-points"
        caption="非財務データ"
        columns={COLUMNS}
        rows={[]}
        getRowId={(r) => r.id}
        getRowLabel={(r) => r.name}
        searchParams={params}
        basePath="/enterprise/data"
        filters={[
          { key: 'status', label: '状態', options: [{ value: 'returned', label: '差戻し' }] },
        ]}
        empty={EMPTY}
      />,
    );
    const reset = screen.getByRole('link', { name: '絞り込みを解除' });
    expect(reset).toHaveAttribute('href', '/enterprise/data?cols=status&sort=updated');
    expect(resetFiltersHref('/x', { page: '2', status: 'a' }, ['status'])).toBe('/x');
  });

  it('選択 0 件では一括バーを描かず、選ぶと件数と状態の内訳を出す', () => {
    render(
      <DataTable
        id="data-points"
        caption="非財務データ"
        columns={COLUMNS}
        rows={ROWS}
        getRowId={(r) => r.id}
        getRowLabel={(r) => r.name}
        getRowStatus={(r) => r.status}
        searchParams={{}}
        basePath="/enterprise/data"
        selection={{ formId: 'bulk-form' }}
        bulkActions={[
          { id: 'submit', label: '一括提出', submitter: { name: 'to', value: 'submitted' } },
        ]}
        empty={EMPTY}
      />,
    );
    expect(screen.queryByRole('region', { name: '一括操作' })).toBeNull();
    expect(screen.queryByRole('button', { name: '一括提出' })).toBeNull();

    const box = screen.getByRole('checkbox', { name: '電力使用量 を選択' });
    expect(box).toHaveAttribute('form', 'bulk-form');
    expect(box).toHaveAttribute('data-t4d-select');
    act(() => {
      fireEvent.click(box);
    });
    const bar = screen.getByRole('region', { name: '一括操作' });
    expect(bar).toHaveTextContent('1 件を選択中（入力中 1）');
    expect(within(bar).getByRole('button', { name: '一括提出' })).toHaveAttribute(
      'value',
      'submitted',
    );
  });

  it('すべて選択で同じ表の行をまとめて選ぶ', () => {
    render(
      <DataTable
        id="data-points"
        caption="非財務データ"
        columns={COLUMNS}
        rows={ROWS}
        getRowId={(r) => r.id}
        getRowLabel={(r) => r.name}
        getRowStatus={(r) => r.status}
        searchParams={{}}
        basePath="/enterprise/data"
        selection={{ formId: 'bulk-form' }}
        bulkActions={[{ id: 'submit', label: '一括提出' }]}
        empty={EMPTY}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByRole('checkbox', { name: 'このページの行をすべて選択' }));
    });
    expect(screen.getByRole('region', { name: '一括操作' })).toHaveTextContent(
      '2 件を選択中（入力中 1・提出済み 1）',
    );
  });

  it('一括バーの内訳は状態ごとの件数', () => {
    expect(selectionBreakdown(['入力中', '提出済み', '入力中'])).toBe('入力中 2・提出済み 1');
    // BulkActionBar 単体でも、選択 0 件ではバーを出さない
    render(<BulkActionBar formId="f" actions={[{ id: 'x', label: '一括承認' }]} />);
    expect(screen.queryByRole('region', { name: '一括操作' })).toBeNull();
  });
});

describe('保存ビュー・既定ビュー（端末ごと）', () => {
  it('保存する条件からページ・通知・作成パネルを外す', () => {
    expect(sanitizeViewQuery('?status=draft&page=3&flash=x&new=1')).toBe('status=draft');
  });

  it('壊れた保存値は捨てる', () => {
    expect(parseTableViewStore('x')).toBeNull();
    expect(
      parseTableViewStore({
        views: [
          { name: '', query: 'a' },
          { name: '差戻し', query: 'status=returned' },
        ],
      }),
    ).toEqual({
      views: [{ name: '差戻し', query: 'status=returned' }],
    });
  });

  it('既定ビューは条件の無いリンクにだけ付ける（タスク動詞の絞り込みを上書きしない）', () => {
    const index = { '/enterprise/data': 'status=returned&cols=metric,status' };
    expect(applyListDefault('/enterprise/data', index)).toBe(
      '/enterprise/data?status=returned&cols=metric,status',
    );
    expect(applyListDefault('/enterprise/data?status=draft', index)).toBe(
      '/enterprise/data?status=draft',
    );
    expect(applyListDefault('/enterprise/imports', index)).toBe('/enterprise/imports');
  });
});
