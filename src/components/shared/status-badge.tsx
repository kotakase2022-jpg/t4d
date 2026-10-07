import * as React from 'react';
import {
  AlertTriangle,
  CircleCheck,
  CircleDashed,
  Eye,
  FilePen,
  Hourglass,
  Info,
  MinusCircle,
  Undo2,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Hint } from '@/components/ui/tooltip';
import {
  statusEntry,
  statusStyle,
  type StatusDomain,
  type StatusIconName,
  type StatusSemantic,
  type StatusValue,
} from '@/lib/ui/status/registry';
import { cn } from '@/lib/utils';

/**
 * 状態のバッジ（plan §3.1）。ラベル・色・アイコンは状態登録簿（src/lib/ui/status）から決める。
 *
 * - 色だけで状態を示さない: ラベルとアイコンを必ず併記する（CLAUDE.md §2）
 * - 補足（detail）は title= に入れない: マウスでしか読めず、読み上げにも届かないため、
 *   sr-only の文と Hint（ツールチップ）の両方で出す
 * - 回転を連想させる Loader2 は使わない（「処理中」に見えるため。登録簿の icon 名に含めていない）
 */

const ICONS: Record<StatusIconName, LucideIcon> = {
  'circle-dashed': CircleDashed,
  'file-pen': FilePen,
  hourglass: Hourglass,
  eye: Eye,
  'undo-2': Undo2,
  'circle-check': CircleCheck,
  'alert-triangle': AlertTriangle,
  'x-circle': XCircle,
  info: Info,
  'minus-circle': MinusCircle,
};

export type StatusBadgeSize = 'sm' | 'md';

interface SemanticBadgeProps {
  semantic: StatusSemantic;
  label: string;
  /** 状態の補足（sr-only＋Hint） */
  detail?: string;
  size?: StatusBadgeSize;
  className?: string;
  /** テスト・支援用の目印（data-status-domain・data-status-value） */
  dataAttributes?: Record<`data-${string}`, string>;
}

/**
 * 登録簿に無い、画面で計算した状態（例: 検証 OK／エラー n 件）を意味（semantic）で描く。
 * 同じ意味は StatusBadge と同じ色・アイコンになる
 */
export function SemanticBadge({
  semantic,
  label,
  detail,
  size = 'sm',
  className,
  dataAttributes,
}: SemanticBadgeProps) {
  const style = statusStyle(semantic);
  const Icon = ICONS[style.icon];
  const badge = (
    <Badge
      tone={style.tone}
      data-semantic={semantic}
      className={cn(size === 'md' && 'px-2 py-1 text-small', className)}
      {...dataAttributes}
    >
      <Icon className={size === 'md' ? 'size-3.5' : 'size-3'} aria-hidden="true" />
      <span>{label}</span>
      {detail && <span className="sr-only">（{detail}）</span>}
    </Badge>
  );
  return detail ? <Hint label={detail}>{badge}</Hint> : badge;
}

export interface StatusBadgeProps<D extends StatusDomain> {
  domain: D;
  value: StatusValue<D>;
  /** 状態の補足。省略時は登録簿の description */
  detail?: string;
  size?: StatusBadgeSize;
  className?: string;
}

export function StatusBadge<D extends StatusDomain>({
  domain,
  value,
  detail,
  size,
  className,
}: StatusBadgeProps<D>) {
  const entry = statusEntry(domain, value);
  return (
    <SemanticBadge
      semantic={entry.semantic}
      label={entry.label}
      detail={detail ?? entry.description}
      size={size}
      className={className}
      dataAttributes={{ 'data-status-domain': domain, 'data-status-value': value }}
    />
  );
}

/** 登録簿のアイコン（凡例・行の先頭など、バッジ以外で同じ印を使うとき） */
export function StatusIcon({
  semantic,
  className,
}: {
  semantic: StatusSemantic;
  className?: string;
}) {
  const Icon = ICONS[statusStyle(semantic).icon];
  return <Icon className={cn('size-3.5', className)} aria-hidden="true" />;
}

/** テスト用: アイコンの対応表（Loader2 を使っていないことの検査） */
export const STATUS_ICON_COMPONENTS: Readonly<Record<StatusIconName, LucideIcon>> = ICONS;
