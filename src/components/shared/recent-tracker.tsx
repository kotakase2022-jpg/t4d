'use client';

import * as React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { LOCAL_KEYS, readLocal, writeLocal } from '@/lib/ui/local-store';
import { addRecentItem, parseRecentItems, sanitizeRecentHref } from '@/lib/ui/recent';
import { useViewerKey } from './viewer-context';

/**
 * 最近使った画面を端末に記録する（plan §1.9）。描画には何も出さない。
 *
 * 画面の名前は描画後の main の h1（メニュー・タブ名と同じ画面名。plan §1.9 名称の統一）。
 * h1 が無い画面（エラー・リダイレクト中）は記録しない。保存できない環境では何もしない。
 */
export function RecentTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const viewerKey = useViewerKey();
  const search = searchParams?.toString() ?? '';

  React.useEffect(() => {
    // 見出しは描画の直後に確定する（Server Component の差し替えを待つため 1 フレーム遅らせる）
    const frame = window.requestAnimationFrame(() => {
      const heading = document.querySelector('#t4d-main h1')?.textContent?.trim();
      if (!heading) return;
      const key = LOCAL_KEYS.recent(viewerKey);
      const current = readLocal(key, parseRecentItems) ?? [];
      writeLocal(
        key,
        addRecentItem(current, {
          href: sanitizeRecentHref(pathname, search),
          label: heading,
          at: new Date().toISOString(),
        }),
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pathname, search, viewerKey]);

  return null;
}
