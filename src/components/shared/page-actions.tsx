import * as React from 'react';
import { splitPageActions, type ActionSpec, type MenuActionSpec } from '@/lib/ui/actions';
import { ActionButton } from './action-button';
import { MoreMenu } from './more-menu';

/**
 * 見出しの操作（plan §1.6・§3.2 PageActions）。PageHeader の actions に渡す。
 *
 * - primary はその画面（タブ・状態）の仕事 1 つだけ。primary を付ける操作が無い画面は省略してよい
 * - secondary は 2 つまで。3 つ目以降は自動で「その他」の先頭へ送る
 * - hidden の項目は描かない（権限の無い操作は出さない。サーバー側の検査はそのまま）
 * - 並びは左から「その他」→ secondary → primary（主操作は右端の決まった位置）
 *
 * Server Component から使える（メニュー・ダイアログ・送信ボタンの部分だけがクライアント）。
 */
export function PageActions({
  primary,
  secondary,
  more,
  moreLabel,
  openConfirmId,
}: {
  primary?: ActionSpec;
  secondary?: ActionSpec[];
  more?: MenuActionSpec[];
  /** 「その他」の文言（既定「その他」） */
  moreLabel?: string;
  /** その他の確認ダイアログを最初から開く項目の id（例: ?confirm=reset-demo） */
  openConfirmId?: string;
}) {
  const split = splitPageActions({ primary, secondary, more });
  if (!split.primary && split.secondary.length === 0 && split.more.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5" data-page-actions="">
      {split.more.length > 0 && (
        <MoreMenu label={moreLabel} items={split.more} openConfirmId={openConfirmId} />
      )}
      {split.secondary.map((action) => (
        <ActionButton key={action.id} action={action} variant="secondary" />
      ))}
      {split.primary && <ActionButton action={split.primary} variant="primary" />}
    </div>
  );
}
