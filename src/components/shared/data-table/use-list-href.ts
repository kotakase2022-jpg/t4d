'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { applyListDefault, readListDefaults } from '@/lib/table/views';
import { useViewerKey } from '../viewer-context';

/**
 * 既定ビューを付けて一覧へ移る（plan §3.2 DataTable の既定ビュー）。
 *
 * サイドバー・パレット・ホームのリンクを押した時点で、その一覧に利用者の既定ビューがあれば条件を付けて
 * 遷移する。描画の時点では href を書き換えない（サーバー描画との食い違い・レイアウトのずれを出さない）。
 * 修飾キー付きのクリック（新しいタブで開く）は既定の動作のまま。
 */
export function useListNavigation(): {
  /** リンクの onClick から呼ぶ。既定ビューを付けて遷移したら true（既定の遷移は止めた） */
  onLinkClick: (event: React.MouseEvent<HTMLAnchorElement>, href: string) => boolean;
  /** プログラムからの遷移（パレットの候補の選択） */
  navigate: (href: string) => void;
  /** 既定ビューを付けた行き先（遷移の直前に計算する） */
  resolve: (href: string) => string;
} {
  const router = useRouter();
  const viewerKey = useViewerKey();
  const resolve = React.useCallback(
    (href: string) => applyListDefault(href, readListDefaults(viewerKey)),
    [viewerKey],
  );
  const navigate = React.useCallback(
    (href: string) => router.push(resolve(href)),
    [resolve, router],
  );
  const onLinkClick = React.useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>, href: string) => {
      if (event.defaultPrevented || event.button !== 0) return false;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
      const next = resolve(href);
      if (next === href) return false;
      event.preventDefault();
      router.push(next);
      return true;
    },
    [resolve, router],
  );
  return { onLinkClick, navigate, resolve };
}

/** 既定ビューを付けた行き先（plan の名前。tableId は保存の鍵の説明用で、索引はパスで引く） */
export function useListHref(_tableId: string, href: string): string {
  const { resolve } = useListNavigation();
  const [resolved, setResolved] = React.useState(href);
  React.useEffect(() => {
    setResolved(resolve(href));
  }, [href, resolve]);
  return resolved;
}
