import * as React from 'react';
import { visibleActions, type ActionSpec, type MenuActionSpec } from '@/lib/ui/actions';
import { ActionButton } from './action-button';
import { MoreMenu } from './more-menu';

/**
 * 行の操作（plan §1.7・§3.1 RowActions）。「主な 1 操作（文字）＋操作 ▾」。
 *
 * - 行ごとに primary を繰り返さない（主な操作は xs の secondary か文字のリンク）
 * - メニューの起動ボタンは文字「操作」＋読み上げ名「{行の名前} の操作」（同じボタンが行の数だけ並ぶため）
 * - 状態で主な操作の文言を変える（例: 差戻し → 「直す」、要確認 → 「確認して確定」。§1.15）
 */
export function RowActions({
  rowLabel,
  primary,
  items,
}: {
  /** 行の名前（指標名・ファイル名など。メニューの読み上げ名に使う） */
  rowLabel: string;
  primary?: ActionSpec;
  items?: MenuActionSpec[];
}) {
  const menu = visibleActions(items);
  const showPrimary = primary && !primary.hidden;
  if (!showPrimary && menu.length === 0) return null;
  return (
    <div className="flex items-center justify-end gap-1" data-row-actions="">
      {showPrimary && <ActionButton action={primary} variant="secondary" size="xs" />}
      {menu.length > 0 && (
        <MoreMenu
          label="操作"
          items={menu}
          triggerVariant="ghost"
          triggerSize="xs"
          triggerAriaLabel={`${rowLabel} の操作`}
        />
      )}
    </div>
  );
}
