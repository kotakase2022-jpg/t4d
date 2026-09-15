'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Hint } from '@/components/ui/tooltip';
import { DemoTour } from './demo-tour';
import { cn } from '@/lib/utils';
import { ENTERPRISE_NAV, assuranceNav, type NavItem } from './nav-config';

const STORAGE_KEY = 't4d.sidebar.collapsed';

export type SidebarVariant = 'enterprise' | 'assurance';

/** URL から現在の案件 ID を取り出す（監査法人ワークスペース用）。 */
export function engagementIdFromPath(pathname: string): string | null {
  return pathname.match(/^\/assurance\/engagements\/([^/]+)/)?.[1] ?? null;
}

/**
 * Sidebar は Client Component。
 * NavItem は LucideIcon（React コンポーネント）を含むため RSC 境界を越えられない。
 * したがって nav 定義はここで解決し、Server からは「非表示にする href」だけを受け取る。
 */
export function useNavItems(variant: SidebarVariant, hiddenHrefs: string[]): NavItem[] {
  const pathname = usePathname();
  return React.useMemo(() => {
    const items =
      variant === 'enterprise' ? ENTERPRISE_NAV : assuranceNav(engagementIdFromPath(pathname));
    // 権限による非表示は全階層に効かせる（例: 管理 > 設定。3 階層目も同じ）
    const filterTree = (nodes: NavItem[]): NavItem[] =>
      nodes
        .filter((node) => !hiddenHrefs.includes(node.href))
        .map((node) => (node.children ? { ...node, children: filterTree(node.children) } : node));
    return filterTree(items);
  }, [variant, hiddenHrefs, pathname]);
}

export function Sidebar({
  variant,
  hiddenHrefs,
}: {
  variant: SidebarVariant;
  hiddenHrefs: string[];
}) {
  const pathname = usePathname();
  const items = useNavItems(variant, hiddenHrefs);
  const [collapsed, setCollapsed] = React.useState(false);
  const [hydrated, setHydrated] = React.useState(false);

  React.useEffect(() => {
    setHydrated(true);
    try {
      setCollapsed(window.localStorage.getItem(STORAGE_KEY) === '1');
    } catch {
      /* localStorage 不可の環境は既定値のまま */
    }
  }, []);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        /* noop */
      }
      return next;
    });
  };

  return (
    <nav
      aria-label="メインナビゲーション"
      data-collapsed={collapsed ? 'true' : 'false'}
      className={cn(
        't4d-no-print flex shrink-0 flex-col border-r border-line bg-surface',
        collapsed ? 'w-[64px]' : 'w-[224px]',
      )}
    >
      <ul className="flex-1 overflow-y-auto p-1.5">
        {items.map((item) => (
          <SidebarEntry
            key={`${item.href}-${item.label}`}
            item={item}
            pathname={pathname}
            collapsed={collapsed}
          />
        ))}
      </ul>
      <div className="border-t border-line p-1.5">
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? 'サイドバーを展開' : 'サイドバーを折りたたむ'}
          aria-expanded={hydrated ? !collapsed : undefined}
          className="flex w-full items-center gap-2 rounded-t4d px-2 py-1.5 text-[12px] text-ink-muted hover:bg-brand-50 hover:text-ink"
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            <PanelLeftClose className="size-4 shrink-0" aria-hidden="true" />
          )}
          {!collapsed && <span>折りたたむ</span>}
        </button>
        {/* 要望 ③「左サイドメニューの一番下」— 折りたたみボタンよりさらに下に置く */}
        {variant === 'enterprise' && <DemoTour collapsed={collapsed} />}
      </div>
    </nav>
  );
}

function isActive(pathname: string, href: string): boolean {
  if (pathname === href) return true;
  return pathname.startsWith(`${href}/`);
}

/** 自分または子孫のどこかが現在地か（3 階層対応） */
function isSubtreeActive(pathname: string, item: NavItem): boolean {
  if (isActive(pathname, item.href)) return true;
  return item.children?.some((child) => isSubtreeActive(pathname, child)) ?? false;
}

function SidebarEntry({
  item,
  pathname,
  collapsed,
}: {
  item: NavItem;
  pathname: string;
  collapsed: boolean;
}) {
  const active = isActive(pathname, item.href);
  const hasActiveChild = item.children?.some((c) => isSubtreeActive(pathname, c)) ?? false;
  const Icon = item.icon;

  const link = (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? item.label : undefined}
      className={cn(
        'flex items-center gap-2 rounded-t4d px-2 py-1.5 text-[13px] transition-colors',
        collapsed && 'justify-center px-0',
        active || hasActiveChild
          ? 'bg-brand-100 font-medium text-brand-900'
          : 'text-ink hover:bg-brand-50',
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );

  return (
    <li>
      {collapsed ? <Hint label={item.label}>{link}</Hint> : link}
      {!collapsed && item.children && (
        <SidebarChildList items={item.children} pathname={pathname} depth={1} />
      )}
    </li>
  );
}

/**
 * 2 階層目以降の入れ子リスト。
 * 「開示対応 > SSBJ > 対応状況」のような 3 階層目は、さらに一段インデントして
 * 左罫線を重ねることで、どこまでがどのグループかを線で追えるようにする。
 */
function SidebarChildList({
  items,
  pathname,
  depth,
}: {
  items: NavItem[];
  pathname: string;
  depth: number;
}) {
  return (
    <ul className={cn('border-l border-line pl-1.5', depth === 1 ? 'ml-6' : 'ml-2.5')}>
      {items.map((child) => {
        const hasChildren = (child.children?.length ?? 0) > 0;
        // グループ行（例: SSBJ）と、兄弟の親パスを持つ入口行（例: 算定サマリー = /enterprise/ghg）は
        // 配下・兄弟すべてに前方一致してしまうため、完全一致のときだけ「現在地」にする。
        // そうしないと兄弟ページで aria-current="page" が複数並ぶ
        const overlapsSibling = items.some(
          (other) => other !== child && other.href.startsWith(`${child.href}/`),
        );
        // 親子が同一 href（SSBJ→対応状況、Scope3データ取込→Cat.1）のとき、
        // 「現在地」は葉側だけに付ける（同一画面で aria-current が 2 つ並ばない）
        const childClaimsSameHref =
          hasChildren && (child.children?.some((c) => c.href === child.href) ?? false);
        const selfActive =
          !childClaimsSameHref &&
          (hasChildren || overlapsSibling
            ? pathname === child.href
            : isActive(pathname, child.href));
        const childActive = !selfActive && hasChildren && isSubtreeActive(pathname, child);
        return (
          <li key={`${child.href}-${child.label}`}>
            <Link
              href={child.href}
              aria-current={selfActive ? 'page' : undefined}
              className={cn(
                'block rounded-t4d px-2 py-1 text-[12px]',
                selfActive
                  ? 'bg-brand-50 font-medium text-brand-800'
                  : childActive
                    ? 'font-medium text-ink hover:bg-brand-50'
                    : 'text-ink-muted hover:bg-brand-50 hover:text-ink',
              )}
            >
              {child.label}
            </Link>
            {hasChildren && child.children && (
              <SidebarChildList items={child.children} pathname={pathname} depth={depth + 1} />
            )}
          </li>
        );
      })}
    </ul>
  );
}
