'use client';

import * as React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

/**
 * 画面遷移中の上端のプログレス（plan §1.18 読み込み）。
 *
 * Loading 境界（loading.tsx・Layout の Suspense）は置けない（Next.js 15.5 の不具合で Client 遷移が
 * 固まる。docs/known-limitations.md S-11）。代わりに、内部リンクのクリックと GET フォームの送信で
 * 開始し、pathname・search が確定したら終える。10 秒で打ち切る（戻らない遷移で出しっぱなしにしない）。
 * 高さ 2px の固定配置で、レイアウトをずらさない。
 */
const TIMEOUT_MS = 10_000;

function isInternalNavigation(anchor: HTMLAnchorElement, event: MouseEvent): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if (anchor.target && anchor.target !== '_self') return false;
  if (anchor.hasAttribute('download')) return false;
  const href = anchor.getAttribute('href');
  if (!href || href.startsWith('#')) return false;
  try {
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin) return false;
    // 同じ画面の別の位置（ハッシュだけ違う）は遷移しない
    return url.pathname !== window.location.pathname || url.search !== window.location.search;
  } catch {
    return false;
  }
}

export function NavigationProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? '';
  const [active, setActive] = React.useState(false);

  // 遷移が確定したら終える
  React.useEffect(() => {
    setActive(false);
  }, [pathname, search]);

  React.useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => setActive(false), TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [active]);

  React.useEffect(() => {
    function onClick(event: MouseEvent) {
      const anchor = (event.target as Element | null)?.closest?.('a');
      if (anchor instanceof HTMLAnchorElement && isInternalNavigation(anchor, event)) {
        setActive(true);
      }
    }
    function onSubmit(event: Event) {
      const form = event.target as HTMLFormElement | null;
      // Server Action のフォーム（POST）は SubmitButton が送信中を示すため、ここでは GET だけ
      if (form && (form.method || 'get').toLowerCase() === 'get' && !event.defaultPrevented) {
        setActive(true);
      }
    }
    document.addEventListener('click', onClick);
    document.addEventListener('submit', onSubmit);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('submit', onSubmit);
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      data-t4d-navigation-progress={active ? 'active' : 'idle'}
      className="pointer-events-none fixed inset-x-0 top-0 z-(--z-progress) h-0.5 overflow-hidden"
    >
      <div
        className={
          active
            ? 'h-full w-1/3 animate-[t4d-progress_1.2s_ease-in-out_infinite] bg-brand-600'
            : 'hidden'
        }
      />
    </div>
  );
}
