import * as React from 'react';
import { Collapsible } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

/**
 * 図の枠（docs/disclosure-first.md §10.4）。`<figure>`＋`<figcaption>` に、role="img" の SVG・凡例・
 * 「数値を表で見る」（既定で閉じた表）をまとめる。新しい npm 依存なしの素の SVG で、Server Component で動く。
 *
 * - SVG は viewBox＋w-full（横にはみ出さない）。role="img"＋aria-label（summary）で要点を伝える
 * - 図だけで意味を伝えない: 12 個を超える数値は summary に全部書かず、表に全数値を置く
 * - 凡例は HTML（正確なラベル）。色だけで系列を区別しない
 */

export interface ChartTableColumn {
  label: string;
  align?: 'left' | 'right';
}

export interface ChartTableRow {
  key: string;
  /** 先頭のセルは行見出し（th scope="row"）。columns と同じ数 */
  cells: React.ReactNode[];
}

export interface ChartTable {
  caption: string;
  columns: ChartTableColumn[];
  rows: ChartTableRow[];
}

export interface ChartFrameProps {
  /** figcaption に出す題 */
  title: React.ReactNode;
  /** SVG の aria-label（要点。12 個までなら全数値） */
  summary: string;
  /**
   * viewBox の幅・高さ。表示の幅（親の幅）に近い値にする: 表示が狭いと文字が縮み、広いと 1.25 倍で止まる
   * （例: 本文の全幅 ≈ 960、2 列の片方 ≈ 480）
   */
  width: number;
  height: number;
  /** 題の下の補足（単位・「定量化できた経路のみ（n / N）」など） */
  note?: React.ReactNode;
  legend?: React.ReactNode;
  table?: ChartTable;
  /** SVG の中身 */
  children: React.ReactNode;
  className?: string;
  /** SVG の最大幅などを変えるとき（既定は親の幅いっぱい） */
  svgClassName?: string;
}

export function ChartFrame({
  title,
  summary,
  width,
  height,
  note,
  legend,
  table,
  children,
  className,
  svgClassName,
}: ChartFrameProps) {
  return (
    <figure className={cn('min-w-0 space-y-1.5', className)}>
      <figcaption className="space-y-0.5">
        <span className="block text-[12px] font-semibold text-ink">{title}</span>
        {note && <span className="block text-[11px] text-ink-muted">{note}</span>}
      </figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={summary}
        focusable="false"
        className={cn('block h-auto w-full', svgClassName)}
        // 広い枠で拡大されすぎない（11px の文字が 14px を超えない）よう、viewBox の 1.25 倍で止める。
        // 狭い枠では縮む（文字を 11px 以上に保つには、表示幅に合わせた width を渡す）
        style={{ maxWidth: `${Math.round(width * 1.25)}px` }}
      >
        {children}
      </svg>
      {legend}
      {table && <ChartDataTable table={table} />}
    </figure>
  );
}

/** 図と同じ内容の数値表（既定で閉じる「数値を表で見る」） */
export function ChartDataTable({ table, open }: { table: ChartTable; open?: boolean }) {
  return (
    <Collapsible variant="plain" summary="数値を表で見る" open={open}>
      <div className="t4d-scroll-x">
        <table className="w-full text-[12px]">
          <caption className="pb-1 text-left text-[11px] text-ink-muted">{table.caption}</caption>
          <thead>
            <tr>
              {table.columns.map((column, index) => (
                <th
                  key={`${column.label}-${index}`}
                  scope="col"
                  className={cn(
                    'whitespace-nowrap border-b border-line px-2 py-1 text-[11px] font-semibold text-ink-muted',
                    (column.align ?? (index === 0 ? 'left' : 'right')) === 'right'
                      ? 'text-right'
                      : 'text-left',
                  )}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row) => (
              <tr key={row.key} className="border-b border-line last:border-b-0">
                {row.cells.map((cell, index) => {
                  const align = table.columns[index]?.align ?? (index === 0 ? 'left' : 'right');
                  const cellClass = cn(
                    'whitespace-nowrap border-b border-line px-2 py-1',
                    align === 'right' ? 'text-right tnum' : 'text-left',
                  );
                  return index === 0 ? (
                    <th key={index} scope="row" className={cn(cellClass, 'font-normal text-ink')}>
                      {cell}
                    </th>
                  ) : (
                    <td key={index} className={cn(cellClass, 'text-ink')}>
                      {cell}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Collapsible>
  );
}
