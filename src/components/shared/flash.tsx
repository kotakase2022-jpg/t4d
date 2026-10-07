import * as React from 'react';
import { FLASH_MESSAGES } from './flash-messages';
import { Notice } from './notice';

/**
 * 操作の結果を伝える一行（plan §1.18）。
 *
 * 完了後は `?flash=...` を付けてリダイレクトしているが、読み取る側が無いと
 * 「取込を確定した」「前年度から複製した」といった結果が画面に一切出ず、
 * 成功したのかどうか分からないまま一覧へ戻ることになる。
 * 文言はドメインごとの登録簿（./flash-messages）から作る。色だけで状態を表さない（Notice がアイコンを併記する）。
 *
 * 利用者向けのエラー（権限・入力の誤り）は ?error= に載って戻ってくる。
 * 本番ビルドでは例外メッセージが伏せられるため、この経路が唯一の伝達手段になる。
 *
 * `undo` は結果の通知の右に置く操作（例: 許諾の取消のあとの「元に戻す」。plan §1.16 区分 3）。
 * キーは flash の値。そのときの通知にだけ出す
 */
export function FlashMessage({
  searchParams,
  undo,
}: {
  searchParams: Record<string, string | string[] | undefined>;
  undo?: Partial<Record<string, React.ReactNode>>;
}) {
  const error = typeof searchParams.error === 'string' ? searchParams.error : null;
  if (error) {
    // data-flash-error: AppShell の GlobalErrorNotice が同じエラーを重ねて出さないための目印
    return (
      <div data-flash-error="">
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      </div>
    );
  }

  const flash = typeof searchParams.flash === 'string' ? searchParams.flash : null;
  if (!flash) return null;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === 'string') params.set(key, value);
  }
  const build = Object.prototype.hasOwnProperty.call(FLASH_MESSAGES, flash)
    ? FLASH_MESSAGES[flash]
    : undefined;
  if (!build) return null;

  return (
    <Notice tone="success" role="status" action={undo?.[flash]}>
      {build(params)}
    </Notice>
  );
}
