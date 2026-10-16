import * as React from 'react';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { SegmentedFilter } from '@/components/shared/nav-tabs';
import { formatJstDate } from '@/lib/format/datetime';
import type { ReportingPeriod } from '@/types/domain';

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * 排出係数・算定ルールの画面（P91〜P93）の共通の部品。結果の通知（?flash=・?error=）は共通の FlashMessage
 * （文言は flash-messages/ghg-factors-rules.ts）。
 *  - 見出しの 1 行: 期間とデモの注記（デモデータ・架空。折りたたまない）
 *  - 期間の切り替え: 割当・算定方針は期間ごと（?period=。トライアルの検証期間が既定）
 */
export function PeriodContext({
  period,
  demo,
  children,
}: {
  period: ReportingPeriod;
  demo: boolean;
  children?: React.ReactNode;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span>
        期間 {period.label}（{formatJstDate(period.startDate)}〜{formatJstDate(period.endDate)}）
      </span>
      {demo && <HonestyBadge kind="demo-data" />}
      {demo && <HonestyBadge kind="fictional" />}
      {children}
    </span>
  );
}

/** 期間の切り替え（開始日の新しい順。今の引数〔表示の切替など〕は保つ） */
export function PeriodSwitch({
  basePath,
  periods,
  current,
  searchParams,
}: {
  basePath: string;
  periods: readonly ReportingPeriod[];
  current: ReportingPeriod;
  searchParams: SearchParams;
}) {
  if (periods.length <= 1) return null;
  const href = (periodId: string) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams)) {
      if (['period', 'flash', 'error', 'et', 'new', 'assign', 'need'].includes(key)) continue;
      if (typeof value === 'string') params.set(key, value);
    }
    params.set('period', periodId);
    return `${basePath}?${params.toString()}`;
  };
  const sorted = [...periods].sort((a, b) => b.startDate.localeCompare(a.startDate));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-small text-ink-muted">期間</span>
      <SegmentedFilter
        ariaLabel="期間の切り替え"
        current={current.id}
        items={sorted.map((p) => ({ key: p.id, label: p.code, href: href(p.id) }))}
      />
    </div>
  );
}
