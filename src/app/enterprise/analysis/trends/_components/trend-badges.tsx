import {
  Activity,
  ArrowDown,
  ArrowUp,
  Ban,
  CircleDashed,
  CircleMinus,
  CircleOff,
  Clock,
  FlaskConical,
  Minus,
  TriangleAlert,
} from 'lucide-react';
import { NeedsCheckBadge } from '@/app/enterprise/esg/kpi-card';
import { Badge } from '@/components/ui/badge';
import {
  formatTrendValue,
  type ChangeDirection,
  type TrendCell,
  type TrendCellKind,
  type TrendChangeView,
} from '@/lib/domain/metric-trend';

/**
 * 自社経年比較のセルとバッジ（docs/disclosure-first.md §10.2）。
 * 状態は色だけで示さない（ラベル＋アイコン。アイコンは aria-hidden で、ラベルが状態そのもの）。
 * 増減は良し悪しが指標で逆になるため、中立色の矢印＋符号＋数値で示す（赤緑にしない）。
 */

type Tone = 'neutral' | 'brand' | 'warning';

const CELL_BADGE: Record<
  Exclude<TrendCellKind, 'confirmed'>,
  { tone: Tone; Icon: typeof Clock }
> = {
  incomplete: { tone: 'brand', Icon: Clock },
  estimate_included: { tone: 'warning', Icon: FlaskConical },
  not_entered: { tone: 'neutral', Icon: CircleDashed },
  not_computable: { tone: 'neutral', Icon: CircleMinus },
  not_applicable: { tone: 'neutral', Icon: Ban },
  no_actual: { tone: 'neutral', Icon: CircleOff },
  unit_mismatch: { tone: 'warning', Icon: TriangleAlert },
};

/** 年度のセル。確定値だけを数値で出し、それ以外は状態のバッジ（未入力を 0 と書かない） */
export function TrendCellView({ cell, unit }: { cell: TrendCell; unit: string }) {
  if (cell.kind === 'confirmed' && cell.value !== null) {
    return (
      <span className="tnum whitespace-nowrap text-body font-semibold text-ink">
        {formatTrendValue(cell.value, unit)}
        <span className="ml-0.5 text-caption font-normal text-ink-muted">{unit}</span>
        <span className="sr-only">（確定）</span>
      </span>
    );
  }
  const kind = cell.kind === 'confirmed' ? 'no_actual' : cell.kind;
  const { tone, Icon } = CELL_BADGE[kind];
  return (
    <Badge tone={tone} className="whitespace-normal text-left">
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      {cell.label}
    </Badge>
  );
}

const DIRECTION_ICON: Record<ChangeDirection, typeof ArrowUp> = {
  up: ArrowUp,
  down: ArrowDown,
  flat: Minus,
};

/** 大きな変化（前年比の許容幅を超えた）。良し悪しではないので中立色 */
export function LargeChangeBadge() {
  return (
    <Badge tone="outline">
      <Activity className="size-3" aria-hidden="true" />
      大きな変化
    </Badge>
  );
}

/** 前年比のセル（数値・比較条件の確認・出さない理由） */
export function TrendChangeCell({ change }: { change: TrendChangeView }) {
  if (change.kind === 'value') {
    const Icon = DIRECTION_ICON[change.direction];
    return (
      <div className="flex flex-col items-end gap-0.5">
        <span className="tnum inline-flex items-center gap-0.5 whitespace-nowrap text-small text-ink">
          <Icon className="size-3 shrink-0 text-ink-muted" aria-hidden="true" />
          {change.text}
        </span>
        {change.large && <LargeChangeBadge />}
        {change.notes.length > 0 && (
          <span className="text-caption text-ink-muted">前年の値に遡及修正あり（内訳）</span>
        )}
      </div>
    );
  }
  if (change.kind === 'needs_check') {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <NeedsCheckBadge />
        <span className="text-caption text-ink-muted">理由は内訳</span>
      </div>
    );
  }
  return (
    <span className="text-small text-ink-muted">
      <span aria-hidden="true">—</span>
      <span className="sr-only">前年比なし: {change.reason}</span>
    </span>
  );
}
