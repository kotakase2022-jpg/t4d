'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { Notice } from './notice';

/** 本文（この通知の外）に同じエラーの文が既に出ているか */
function pageShowsErrorText(main: Element, error: string): boolean {
  const own = main.querySelector('[data-global-error]')?.textContent ?? '';
  const text = main.textContent ?? '';
  return (own ? text.replace(own, '') : text).includes(error);
}

/** 本文の描画が落ち着くまで見張る時間（ストリーミングで遅れて届く本文にも追従する） */
const WATCH_MS = 5_000;

/**
 * 業務エラー（`?error=`）を、画面がまだ自分で出していないときだけ本文の先頭に出す（plan §1.18・§4 B3）。
 *
 * Server Action は業務エラーを withUserFacingError で `?error=` に載せて元の画面へ戻す。結果の通知
 * （FlashMessage）を置いていない画面へ戻ると理由が見えないため、AppShell がここで補う。
 * 同じ文を 2 回出さない:
 *  - FlashMessage が出しているとき（data-flash-error）は CSS（globals.css の :has）で隠す。
 *    描画の順に左右されず、一瞬だけ 2 つ並ぶこともない
 *  - 画面が自前で同じ文を出しているときは、本文の変化を見張って出さない
 * 本文に同じ文が無ければ必ず出す（エラーを隠さない）。
 */
export function GlobalErrorNotice() {
  const searchParams = useSearchParams();
  const error = searchParams?.get('error') ?? null;
  const [shownByPage, setShownByPage] = React.useState(false);

  React.useEffect(() => {
    setShownByPage(false);
    if (!error) return;
    const main = document.querySelector('#t4d-main');
    if (!main) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      setShownByPage(pageShowsErrorText(main, error));
    };
    check();
    const observer = new MutationObserver(() => {
      if (frame === 0) frame = window.requestAnimationFrame(check);
    });
    observer.observe(main, { childList: true, subtree: true, characterData: true });
    const stop = window.setTimeout(() => observer.disconnect(), WATCH_MS);
    return () => {
      observer.disconnect();
      window.clearTimeout(stop);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [error]);

  if (!error || shownByPage) return null;
  return (
    <div className="px-4 pt-3" data-global-error="">
      <Notice tone="danger" role="alert">
        {error}
      </Notice>
    </div>
  );
}
