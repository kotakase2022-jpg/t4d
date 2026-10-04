'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Hint } from '@/components/ui/tooltip';
import { DemoTour } from './demo-tour';
import { cn } from '@/lib/utils';
import { rememberNavBranch, useNavBranch } from './nav-branch';
import {
  branchToRemember,
  hasDeepNavCurrent,
  isNavAncestorOfCurrent,
  isNavPathActive,
  isNavSubtreeActive,
  joinNavBranch,
  navItemKey,
  navTreeFor,
  resolveNavCurrent,
  type NavCurrentMode,
  type NavItem,
  type NavVariant,
} from './nav-config';

const STORAGE_KEY = 't4d.sidebar.collapsed';

/**
 * enterprise = 従来メニュー、enterprise-disclosure = 開示優先モードのメニュー
 * （組織の機能設定で切り替える。docs/disclosure-first.md §2-1）。
 */
export type SidebarVariant = NavVariant;

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
    const items = navTreeFor(variant, engagementIdFromPath(pathname));
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
  // 開示優先モードは最上位も含めて 1 つ、従来メニューは「最上位＋葉」の既存仕様を保つ（A39）
  const mode: NavCurrentMode = variant === 'enterprise-disclosure' ? 'single' : 'top-and-leaf';
  // 同じ href が SSBJ と CSRD に出る画面（定性情報）で、どちらを現在地にするか（§10.1）。
  // SSR と初回描画は null（SSBJ 側）で、マウント後に保存値を当てる
  const preferredBranch = useNavBranch();
  // 現在地は描画するツリー全体で 1 か所で決める（リストごとに判定すると、同じ href が
  // 別の枝に出たときに aria-current が 2 つ並ぶ。docs/disclosure-first.md §9.1）
  const currentKeys = React.useMemo(
    () => resolveNavCurrent(items, pathname, { mode, collapsed, preferredBranch }),
    [items, pathname, mode, collapsed, preferredBranch],
  );

  // 遷移後の優先枝の書き換え（§10.1 の (b)）。開いた画面だけで決まる値にする（優先枝・折りたたみに
  // 依存させない）: サイドバーのリンクを押して枝を書いた直後、遷移前の画面で上書きしないため
  const branchAfterNavigation = React.useMemo(
    () =>
      branchToRemember(
        items,
        resolveNavCurrent(items, pathname, { mode, collapsed: false, preferredBranch: null }),
      ),
    [items, pathname, mode],
  );
  React.useEffect(() => {
    if (branchAfterNavigation !== undefined) rememberNavBranch(branchAfterNavigation);
  }, [branchAfterNavigation, pathname]);

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
        {items.map((item, index) => (
          <SidebarEntry
            key={`${item.href}-${item.label}`}
            item={item}
            itemKey={navItemKey(null, index)}
            currentKeys={currentKeys}
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

/**
 * 強調表示の種類（data-nav-emphasis。テストと支援の目印）。current = 現在地、ancestor = 現在地の祖先
 * （2 階層目以下に現在地が無い画面では、従来どおり配下の画面かどうか）
 */
type NavEmphasis = 'current' | 'ancestor' | undefined;

function SidebarEntry({
  item,
  itemKey,
  currentKeys,
  pathname,
  collapsed,
}: {
  item: NavItem;
  /** ツリー内の位置（navItemKey）。現在地は位置で判定する */
  itemKey: string;
  currentKeys: Set<string>;
  pathname: string;
  collapsed: boolean;
}) {
  const current = currentKeys.has(itemKey);
  // 2 階層目以下に現在地があれば、その祖先だけを強調する（同じ href が SSBJ と CSRD に出ても片方だけ。§10.1）。
  // 無い画面（設定・折りたたみ中）は従来の判定（自分か配下の画面か）に戻す
  const emphasized = hasDeepNavCurrent(currentKeys)
    ? current || isNavAncestorOfCurrent(itemKey, currentKeys)
    : isNavPathActive(pathname, item.href) ||
      (item.children?.some((c) => isNavSubtreeActive(pathname, c)) ?? false);
  const emphasis: NavEmphasis = current ? 'current' : emphasized ? 'ancestor' : undefined;
  const Icon = item.icon;

  const link = (
    <Link
      href={item.href}
      aria-current={current ? 'page' : undefined}
      aria-label={collapsed ? item.label : undefined}
      data-nav-emphasis={emphasis}
      // 最上位のリンクを押したら優先枝を忘れる（§10.1 の (a)。定性情報は既定の SSBJ 側に戻る）
      onClick={() => rememberNavBranch(null)}
      className={cn(
        'flex items-center gap-2 rounded-t4d px-2 py-1.5 text-[13px] transition-colors',
        collapsed && 'justify-center px-0',
        emphasized ? 'bg-brand-100 font-medium text-brand-900' : 'text-ink hover:bg-brand-50',
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
        <SidebarChildList
          items={item.children}
          parentKey={itemKey}
          parentTrail={[item.label]}
          currentKeys={currentKeys}
          pathname={pathname}
          depth={1}
        />
      )}
    </li>
  );
}

/**
 * 2 階層目以降の入れ子リスト。
 * 「開示対応 > SSBJ > 対応状況」のような 3 階層目は、さらに一段インデントして
 * 左罫線を重ねることで、どこまでがどのグループかを線で追えるようにする。
 * リストには親のラベルで名前を付ける（SSBJ と CSRD に同名のリンクが並ぶため、
 * 支援技術でも E2E でもどのグループのリンクか区別できるように）。
 */
function SidebarChildList({
  items,
  parentKey,
  parentTrail,
  currentKeys,
  pathname,
  depth,
}: {
  items: NavItem[];
  parentKey: string;
  /** 親までのラベルの経路（最後が親）。押したリンクの枝として覚える */
  parentTrail: string[];
  currentKeys: Set<string>;
  pathname: string;
  depth: number;
}) {
  const parentLabel = parentTrail[parentTrail.length - 1] ?? '';
  const branch = joinNavBranch(parentTrail);
  const deepCurrent = hasDeepNavCurrent(currentKeys);
  return (
    <ul
      aria-label={parentLabel}
      className={cn('border-l border-line pl-1.5', depth === 1 ? 'ml-6' : 'ml-2.5')}
    >
      {items.map((child, index) => {
        const key = navItemKey(parentKey, index);
        const hasChildren = (child.children?.length ?? 0) > 0;
        // 現在地の判定規則（グループ行・兄弟と重なる入口行は完全一致のみ、親子が同じ href なら子、
        // 別導線は付けない、同じ href が別の枝に出たら優先枝）は resolveNavCurrent にまとめてある
        const selfActive = currentKeys.has(key);
        // グループ行の太字は現在地の祖先だけ（SSBJ と CSRD が同時に太字にならない）。
        // 2 階層目以下に現在地が無い画面（設定など）は従来どおり配下の画面かで決める
        const childActive =
          !selfActive &&
          hasChildren &&
          (deepCurrent
            ? isNavAncestorOfCurrent(key, currentKeys)
            : isNavSubtreeActive(pathname, child));
        const emphasis: NavEmphasis = selfActive ? 'current' : childActive ? 'ancestor' : undefined;
        return (
          <li key={`${child.href}-${child.label}`}>
            <Link
              href={child.href}
              aria-current={selfActive ? 'page' : undefined}
              data-nav-emphasis={emphasis}
              // 押したリンクの枝を覚える（§10.1 の (a)。定性情報を CSRD 側から開いたら CSRD を現在地にする）
              onClick={() => rememberNavBranch(branch)}
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
              <SidebarChildList
                items={child.children}
                parentKey={key}
                parentTrail={[...parentTrail, child.label]}
                currentKeys={currentKeys}
                pathname={pathname}
                depth={depth + 1}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
