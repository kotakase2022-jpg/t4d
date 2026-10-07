import * as React from 'react';
import Link from 'next/link';
import { statusStyle, type StatusSemantic } from '@/lib/ui/status/registry';
import { cn } from '@/lib/utils';
import { StatusIcon } from './status-badge';

/**
 * 主要な数値の帯（plan §1.14 Status・§3.1 MetricStrip／MetricTile）。KPI の 7 実装を寄せる先。
 *
 * - 分母を併記する（「12 / 40」。率だけを出して母数を隠さない）
 * - 状態（要注意など）は色だけで示さない: アイコンと語（status.label）を併記する
 * - href があれば押すと絞り込んだ一覧へ（docs/ux-spec.md の Filter 付き遷移）
 * - data-metric-tile を付ける（テストの目印）
 */
export interface MetricTileProps {
  label: string;
  value: React.ReactNode;
  unit?: string;
  /** 分母（「/ 40」） */
  denominator?: React.ReactNode;
  /** 前年比など（文字で。例「前年比 +3.2%」） */
  delta?: React.ReactNode;
  status?: { semantic: StatusSemantic; label: string };
  href?: string;
  /** 1 行の補足 */
  hint?: React.ReactNode;
  className?: string;
}

const VALUE_TONE: Partial<Record<StatusSemantic, string>> = {
  error: 'text-danger',
  pending: 'text-warning-ink',
  blocked: 'text-warning-ink',
  returned: 'text-warning-ink',
  done: 'text-success',
};

export function MetricTile({
  label,
  value,
  unit,
  denominator,
  delta,
  status,
  href,
  hint,
  className,
}: MetricTileProps) {
  const tone = status ? (VALUE_TONE[status.semantic] ?? 'text-ink') : 'text-ink';
  const content = (
    <>
      <span className="truncate text-caption font-medium text-ink-muted">{label}</span>
      <span className={cn('mt-0.5 flex items-baseline gap-1', tone)}>
        <span className="tnum text-figure font-semibold leading-7">{value}</span>
        {denominator !== undefined && (
          <span className="tnum text-small text-ink-muted">/ {denominator}</span>
        )}
        {unit && <span className="text-small text-ink-muted">{unit}</span>}
      </span>
      {status && (
        <span
          className={cn(
            'mt-0.5 inline-flex items-center gap-1 text-caption',
            statusStyle(status.semantic).tone === 'danger' ? 'text-danger' : 'text-ink',
          )}
        >
          <StatusIcon semantic={status.semantic} className="size-3" />
          {status.label}
        </span>
      )}
      {delta && <span className="mt-0.5 text-caption text-ink-muted">{delta}</span>}
      {/* 補足は折り返して全文を出す（何を数えたかの定義のことがある。省略記号で切ると読めない） */}
      {hint && <span className="mt-0.5 text-caption text-ink-muted">{hint}</span>}
    </>
  );
  const base = cn(
    'flex min-w-0 flex-col justify-between rounded-t4d-lg border border-line bg-surface px-3 py-2',
    className,
  );
  if (href) {
    return (
      <Link
        href={href}
        data-metric-tile=""
        className={cn(base, 'transition-colors hover:border-brand-300 hover:bg-brand-50')}
      >
        {content}
      </Link>
    );
  }
  return (
    <div data-metric-tile="" className={base}>
      {content}
    </div>
  );
}

/** 数値の帯（横に並べる。列数は数に合わせ、狭い画面では折り返す） */
export function MetricStrip({
  label,
  children,
  className,
}: {
  /** 帯の名前（読み上げの領域名。例「進み具合」） */
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={label}
      data-metric-strip=""
      className={cn('grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2', className)}
    >
      {children}
    </section>
  );
}
