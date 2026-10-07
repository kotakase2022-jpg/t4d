import * as React from 'react';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Hint } from '@/components/ui/tooltip';

/**
 * 補足の説明を持つバッジ（plan §3.1・§1.17。StatusBadge の detail と同じ規則）。
 *
 * 補足を title= に入れると、マウスでしか読めず読み上げにも届かない。sr-only の文（読み上げ）と
 * Hint（ツールチップ）の両方で出す。バッジの見える文字（ラベル）だけで意味が通じるようにし、
 * 補足は「なぜ・どういうことか」を足すだけにする。
 */
export function DetailBadge({
  detail,
  children,
  ...props
}: BadgeProps & { detail?: string | null }) {
  const badge = (
    <Badge {...props}>
      {children}
      {detail && <span className="sr-only">（{detail}）</span>}
    </Badge>
  );
  return detail ? <Hint label={detail}>{badge}</Hint> : badge;
}
