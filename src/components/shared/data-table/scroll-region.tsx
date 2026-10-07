'use client';

import * as React from 'react';

/**
 * 一覧の表を包むスクロールの箱（plan §1.12-1 見出し固定）。
 *
 * 見出しの固定（position: sticky）は、いちばん近いスクロールの箱に対して効く。横に溢れる表のために
 * overflow-x を付けると、その箱が縦のスクロールの箱にもなり（CSS の仕様で overflow-y も auto になる）、
 * 箱そのものは縦に伸びるだけなので、ページを縦にスクロールしても見出しが固定されなかった。
 * 箱の高さを画面の高さまでに抑え、長い一覧は箱の中で縦にスクロールさせて見出しを固定する。
 *
 * 実際に溢れているときだけ、キーボードでスクロールできるよう箱にフォーカスを置ける（tabIndex=0・
 * 名前付きの group）。溢れていない表に余分な Tab の止まり先を増やさない。
 */
export function TableScrollRegion({
  label,
  children,
  ...rest
}: {
  /** 表の名前（スクロールの箱の読み上げ名に使う） */
  label: string;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'children'>) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = React.useState(false);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () =>
      setScrollable(el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(check);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      {...rest}
      className="t4d-table-scroll"
      data-t4d-table-scroll=""
      tabIndex={scrollable ? 0 : undefined}
      role={scrollable ? 'group' : undefined}
      aria-label={scrollable ? `${label}（スクロールできます）` : undefined}
    >
      {children}
    </div>
  );
}
