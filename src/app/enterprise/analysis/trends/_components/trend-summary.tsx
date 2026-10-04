import Link from 'next/link';
import { cn } from '@/lib/utils';
import {
  trendFilterQuery,
  type TrendChangeFilter,
  type TrendFilters,
  type TrendSummary,
} from '@/lib/domain/metric-trend';

/**
 * 要約のチップ（docs/disclosure-first.md §10.2 画面 2）。件数は必ず分母（データのある指標）と並べ、
 * 単一の総合点・順位は作らない。絞込のあるチップはリンクを兼ね（押すとその絞込。もう一度押すと外す）、
 * ほかの絞込（群・検索・データの無い指標の表示）は保つ。
 */

const BASE_PATH = '/enterprise/analysis/trends';

function hrefFor(filters: TrendFilters, change: TrendChangeFilter): string {
  const query = trendFilterQuery({
    ...filters,
    change: filters.change === change ? null : change,
  });
  return query ? `${BASE_PATH}?${query}` : BASE_PATH;
}

function Chip({
  label,
  count,
  total,
  href,
  active = false,
}: {
  label: string;
  count: number;
  total: number;
  href?: string;
  active?: boolean;
}) {
  const body = (
    <>
      <span>{label}</span>
      <span className="tnum font-semibold text-ink">
        {count} / {total} 指標
      </span>
    </>
  );
  const className = cn(
    'inline-flex items-center gap-1.5 rounded-t4d border px-2 py-1 text-[12px]',
    active
      ? 'border-brand-500 bg-brand-100 text-brand-900'
      : 'border-line bg-surface text-ink-muted',
  );
  return (
    <li>
      {href ? (
        <Link
          href={href}
          aria-current={active ? 'true' : undefined}
          className={cn(className, !active && 'hover:border-brand-300 hover:text-ink')}
        >
          {body}
        </Link>
      ) : (
        <span className={className}>{body}</span>
      )}
    </li>
  );
}

export function TrendSummaryChips({
  summary,
  filters,
  latestPeriodCode,
}: {
  summary: TrendSummary;
  filters: TrendFilters;
  latestPeriodCode: string;
}) {
  const total = summary.dataMetricCount;
  return (
    <ul aria-label="経年比較の要約" className="flex flex-wrap items-center gap-1.5">
      <Chip
        label="比較できた指標"
        count={summary.comparedCount}
        total={total}
        href={hrefFor(filters, 'compared')}
        active={filters.change === 'compared'}
      />
      <Chip
        label="大きな変化"
        count={summary.largeCount}
        total={total}
        href={hrefFor(filters, 'large')}
        active={filters.change === 'large'}
      />
      <Chip
        label="比較条件の確認が必要"
        count={summary.needsCheckCount}
        total={total}
        href={hrefFor(filters, 'needs_check')}
        active={filters.change === 'needs_check'}
      />
      <Chip
        label={`最新年度（${latestPeriodCode}）が集計中`}
        count={summary.latestIncompleteCount}
        total={total}
      />
    </ul>
  );
}
