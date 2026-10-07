'use client';

import * as React from 'react';

/** 押した要素が消えて、フォーカスが本文の外（body）へ落ちているか */
function focusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body;
}

/**
 * 作成パネル（CreatePanel）のフォーカスの受け渡し（plan §1.13・WCAG 2.4.3）。
 *
 * 開くリンク（見出しの「… を登録」）は開いている間は描かないため、キーボードで押すとリンクが消えて
 * フォーカスが body に落ち、ヘッダーとサイドバーを Tab で辿り直すことになっていた。
 * - 開いたとき: フォーカスが落ちていれば、パネルの見出しへ移す
 * - 閉じたとき: フォーカスが落ちていれば、画面の作成の入口（n キーの飛び先）へ戻す
 * 利用者が別の場所にフォーカスを置いているときは動かさない。
 */
export function CreatePanelFocus({ headingId }: { headingId: string }) {
  React.useEffect(() => {
    if (focusLost()) document.getElementById(headingId)?.focus();
    return () => {
      window.requestAnimationFrame(() => {
        if (!focusLost()) return;
        document.querySelector<HTMLElement>('#t4d-main [data-t4d-shortcut="new"]')?.focus();
      });
    };
  }, [headingId]);
  return null;
}
