'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { useNavBranch } from './nav-branch';
import { resolveNavCurrent, type NavItem } from './nav-config';
import { routeForPath } from './route-catalog';
import { useNavItems } from './sidebar';
import { useShell } from './viewer-context';

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * 描画中のメニューのツリーから、画面の経路（パンくず）を作る（plan §1.4・N-15）。
 *
 * - 先頭はワークスペースのホームへのリンク
 * - メニューにある画面は、メニューの経路（祖先のラベル）で示す。現在の画面だけリンクにしない
 * - メニューに無い画面（詳細・設定など）は、いちばん近いメニューの項目までをリンクにし、末尾に画面名
 *   （tail があれば tail。詳細画面の対象名など）を足す
 * - aria-current は末尾の 1 つだけ（呼び出し側の描画で付ける）
 */
export function navBreadcrumbsFor(
  items: NavItem[],
  pathname: string,
  {
    homeHref,
    preferredBranch = null,
    tail,
  }: { homeHref: string; preferredBranch?: string | null; tail?: readonly Crumb[] },
): Crumb[] {
  const homeLabel = items[0]?.href === homeHref ? items[0].label : 'ホーム';
  const keys = resolveNavCurrent(items, pathname, {
    mode: 'single',
    collapsed: false,
    preferredBranch,
  });
  const key = [...keys][0];

  const trail: Array<{ item: NavItem }> = [];
  if (key !== undefined) {
    let nodes = items;
    for (const index of key.split('.').map(Number)) {
      const item = nodes[index];
      if (!item) break;
      trail.push({ item });
      nodes = item.children ?? [];
    }
  }

  const crumbs: Crumb[] = [];
  const isHome = pathname === homeHref;
  if (!isHome || (tail && tail.length > 0)) crumbs.push({ label: homeLabel, href: homeHref });
  for (const { item } of trail) {
    if (item.href === homeHref && crumbs.length > 0) continue;
    // 現在の画面へのリンクは置かない（同じ画面を指すグループ行も含めて）
    crumbs.push(
      item.href === pathname ? { label: item.label } : { label: item.label, href: item.href },
    );
  }

  const leaf = trail[trail.length - 1]?.item;
  const atMenuItem = leaf !== undefined && leaf.href === pathname;
  if (tail && tail.length > 0) {
    crumbs.push(...tail);
  } else if (!atMenuItem) {
    const route = routeForPath(pathname);
    if (route) crumbs.push({ label: route.label });
    else if (isHome && crumbs.length === 0) crumbs.push({ label: homeLabel });
  }
  if (crumbs.length === 0) crumbs.push({ label: homeLabel });

  // 末尾は現在の画面（リンクにしない）
  const last = crumbs[crumbs.length - 1]!;
  crumbs[crumbs.length - 1] = { label: last.label };
  return crumbs;
}

/** パンくずの描画（手書きのパンくずと同じ見た目。aria-current は末尾だけ） */
export function BreadcrumbList({ crumbs }: { crumbs: readonly Crumb[] }) {
  return (
    <nav aria-label="パンくず" className="mb-1">
      <ol className="flex flex-wrap items-center gap-1 text-caption text-ink-muted">
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          return (
            <li key={`${crumb.label}-${index}`} className="flex items-center gap-1">
              {index > 0 && <ChevronRight className="size-3" aria-hidden="true" />}
              {crumb.href && !isLast ? (
                <Link href={crumb.href} className="hover:text-brand-700 hover:underline">
                  {crumb.label}
                </Link>
              ) : (
                <span aria-current={isLast ? 'page' : undefined}>{crumb.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * AppShell の文脈（描画中のメニュー）からパンくずを描く。AppShell の外では何も出さない
 * （メニューが無い画面で、経路の分からないパンくずを出さないため）
 */
export function NavBreadcrumbs({ tail }: { tail?: Crumb[] }) {
  const shell = useShell();
  const pathname = usePathname();
  const preferredBranch = useNavBranch();
  const items = useNavItems(
    shell?.variant ?? 'enterprise',
    shell?.hiddenHrefs ?? EMPTY,
    shell?.hiddenPermissions,
    shell?.hiddenOptions,
  );
  // App Router の外（単体テスト）では pathname が null。経路が分からないので描かない
  if (!shell || !pathname) return null;
  const crumbs = navBreadcrumbsFor(items, pathname, {
    homeHref: shell.homeHref,
    preferredBranch,
    tail,
  });
  return <BreadcrumbList crumbs={crumbs} />;
}

const EMPTY: string[] = [];
