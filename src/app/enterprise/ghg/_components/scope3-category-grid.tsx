import {
  Ban,
  Calculator,
  CircleCheck,
  CircleDashed,
  Hourglass,
  type LucideIcon,
} from 'lucide-react';
import { CategoryGrid, type CategoryGridItem } from '@/components/charts/category-grid';
import { AVAILABILITY_STATUS_LABELS } from '@/lib/domain/disclosure-status';
import { formatNumber } from '@/lib/format/datetime';
import type { Scope3CategoryStatus } from '@/lib/services/aggregation';
import type { AvailabilityStatus } from '@/types/domain';

/**
 * Scope3 のカテゴリー 1〜15 の格子（docs/disclosure-first.md §10.4）。
 * 状態は文字＋アイコン（AvailabilityBadge と同じ文言・形）。値のあるカテゴリーだけ塗り、値を書く。
 * 値の無いカテゴリーに「0」を書かない。Cat.1 だけの登録を Scope3 全体として見せない（A09）。
 */

const STATE_ICON: Record<AvailabilityStatus, LucideIcon> = {
  value_present: CircleCheck,
  not_entered: CircleDashed,
  not_obtained: Hourglass,
  not_applicable: Ban,
  not_calculated: Calculator,
};

/** 「Scope3 Category 2（資本財）」→「Cat.2 資本財」。指標が無ければ「Cat.2」 */
export function scope3CategoryLabel(category: Pick<Scope3CategoryStatus, 'category' | 'metric'>) {
  const inner = category.metric?.name.match(/（(.+)）$/)?.[1];
  return inner ? `Cat.${category.category} ${inner}` : `Cat.${category.category}`;
}

function valueText(category: Scope3CategoryStatus): string | undefined {
  const parts: string[] = [];
  if (category.total !== null) parts.push(`${formatNumber(category.total)} t-CO2e`);
  if (category.estimateTotal !== null) parts.push(`推計 ${formatNumber(category.estimateTotal)}`);
  return parts.length > 0 ? parts.join('・') : undefined;
}

export function scope3GridItems(categories: readonly Scope3CategoryStatus[]): CategoryGridItem[] {
  return categories.map((category) => {
    // 0039 より前の行は状態を持たないことがある（AvailabilityBadge と同じく「値あり」として読む）
    const state: AvailabilityStatus =
      category.state && category.state in STATE_ICON ? category.state : 'value_present';
    return {
      key: category.code,
      label: scope3CategoryLabel(category),
      stateLabel: AVAILABILITY_STATUS_LABELS[state],
      icon: STATE_ICON[state],
      filled: state === 'value_present',
      value: valueText(category),
      href: category.metric
        ? `/enterprise/data?q=${encodeURIComponent(category.metric.name)}`
        : undefined,
    };
  });
}

export function Scope3CategoryGrid({
  categories,
}: {
  categories: readonly Scope3CategoryStatus[];
}) {
  return (
    <CategoryGrid
      label="Scope3 カテゴリー別の状況"
      items={scope3GridItems(categories)}
      columns={5}
    />
  );
}
