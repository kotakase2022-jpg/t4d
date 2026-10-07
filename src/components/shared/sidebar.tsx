'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Hint } from '@/components/ui/tooltip';
import { isRecord, LOCAL_KEYS, readLocal, writeLocal } from '@/lib/ui/local-store';
import type { PermissionKey } from '@/types/domain';
import { DemoTour } from './demo-tour';
import { cn } from '@/lib/utils';
import { rememberNavBranch, useNavBranch } from './nav-branch';
import {
  ASSURANCE_NO_ENGAGEMENT_HINT,
  branchToRemember,
  hasDeepNavCurrent,
  isNavAncestorOfCurrent,
  isNavPathActive,
  isNavSubtreeActive,
  joinNavBranch,
  navCurrentModeFor,
  navGroupId,
  navItemKey,
  navTreeFor,
  visibleNavTree,
  resolveNavCurrent,
  type NavItem,
  type NavVariant,
} from './nav-config';
import { useListNavigation } from './data-table/use-list-href';
import { useShell, useViewerKey } from './viewer-context';

const STORAGE_KEY = 't4d.sidebar.collapsed';

/**
 * enterprise = 従来メニュー、enterprise-disclosure = 開示優先モードのメニュー
 * （組織の機能設定で切り替える。docs/disclosure-first.md §2-1）。
 */
export type SidebarVariant = NavVariant;

/**
 * URL から現在の案件 ID を取り出す（監査法人ワークスペース用）。
 * App Router の外（単体テストで画面を描くとき）は usePathname() が null を返すので、null も受ける
 */
export function engagementIdFromPath(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  return pathname.match(/^\/assurance\/engagements\/([^/]+)/)?.[1] ?? null;
}

/**
 * Sidebar は Client Component。
 * NavItem は LucideIcon（React コンポーネント）を含むため RSC 境界を越えられない。
 * したがって nav 定義はここで解決し、Server からは「非表示にする href・権限キー」だけを受け取る。
 */
export function useNavItems(
  variant: SidebarVariant,
  hiddenHrefs: string[],
  hiddenPermissions: readonly PermissionKey[] = [],
): NavItem[] {
  const pathname = usePathname();
  return React.useMemo(
    // 権限による非表示は全階層に効かせる（例: 管理 > 設定。3 階層目も同じ）
    () =>
      visibleNavTree(
        navTreeFor(variant, engagementIdFromPath(pathname)),
        hiddenHrefs,
        hiddenPermissions,
      ),
    [variant, hiddenHrefs, hiddenPermissions, pathname],
  );
}

// ----------------------------------------------------------------------
// グループの開閉（plan §1.4）
// ----------------------------------------------------------------------

/** 保存する形: グループ ID → 開いているか（利用者が変えたものだけ） */
type NavOpenState = Record<string, boolean>;

function parseNavOpenState(raw: unknown): NavOpenState | null {
  if (!isRecord(raw)) return null;
  const out: NavOpenState = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

interface GroupOpenApi {
  isOpen: (groupId: string, itemKey: string) => boolean;
  toggle: (groupId: string, itemKey: string) => void;
}

/**
 * 開閉の規則: 既定は開（役割で閉じるグループだけ閉）。利用者が変えた状態は端末に覚える。
 * 現在地の祖先は開いて描く（開いている画面の項目が隠れないように）。ただし、その画面で利用者が
 * 自分で閉じたときは閉じる（押しても閉じないボタンにしない）。
 */
function useGroupOpenState(
  defaultCollapsed: readonly string[],
  currentKeys: ReadonlySet<string>,
  pathname: string,
): GroupOpenApi {
  const viewerKey = useViewerKey();
  const storageKey = LOCAL_KEYS.nav(viewerKey);
  // サーバー描画と最初の描画は既定の状態（保存値はマウント後に当てる。描画の食い違いを防ぐ）
  const [stored, setStored] = React.useState<NavOpenState>({});
  const [closedHere, setClosedHere] = React.useState<{ path: string; ids: string[] }>({
    path: pathname,
    ids: [],
  });

  React.useEffect(() => {
    setStored(readLocal(storageKey, parseNavOpenState) ?? {});
  }, [storageKey]);

  const isOpen = React.useCallback(
    (groupId: string, itemKey: string) => {
      if (isNavAncestorOfCurrent(itemKey, currentKeys)) {
        return !(closedHere.path === pathname && closedHere.ids.includes(groupId));
      }
      return stored[groupId] ?? !defaultCollapsed.includes(groupId);
    },
    [closedHere, currentKeys, defaultCollapsed, pathname, stored],
  );

  const toggle = React.useCallback(
    (groupId: string, itemKey: string) => {
      const next = !isOpen(groupId, itemKey);
      setStored((prev) => {
        const updated = { ...prev, [groupId]: next };
        writeLocal(storageKey, updated);
        return updated;
      });
      if (isNavAncestorOfCurrent(itemKey, currentKeys)) {
        setClosedHere((prev) => {
          const ids = prev.path === pathname ? prev.ids : [];
          return {
            path: pathname,
            ids: next ? ids.filter((id) => id !== groupId) : [...ids, groupId],
          };
        });
      }
    },
    [currentKeys, isOpen, pathname, storageKey],
  );

  return { isOpen, toggle };
}

/** 子を持つ行の開閉ボタン。文字は隠さない（ボタンの名前で「何を」開閉するかを伝える） */
function GroupToggle({
  label,
  open,
  controls,
  onToggle,
  className,
}: {
  label: string;
  open: boolean;
  controls: string;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={`${label} を${open ? '折りたたむ' : '展開する'}`}
      data-nav-group-toggle=""
      className={cn(
        'absolute right-0.5 flex size-6 items-center justify-center rounded-t4d text-ink-muted hover:bg-brand-50 hover:text-ink',
        className,
      )}
    >
      <ChevronRight
        aria-hidden="true"
        className={cn('size-3.5 transition-transform', open && 'rotate-90')}
      />
    </button>
  );
}

function groupListId(itemKey: string): string {
  return `t4d-nav-group-${itemKey.replace(/\./g, '-')}`;
}

export function Sidebar({
  variant,
  hiddenHrefs,
  hiddenPermissions,
  defaultCollapsedGroups,
}: {
  variant: SidebarVariant;
  hiddenHrefs: string[];
  /** 省略時は ShellProvider の値（無ければ権限による非表示なし） */
  hiddenPermissions?: PermissionKey[];
  /** 役割で既定を閉じるグループ。省略時は ShellProvider の値（無ければすべて開く） */
  defaultCollapsedGroups?: string[];
}) {
  const shell = useShell();
  const pathname = usePathname();
  const items = useNavItems(
    variant,
    hiddenHrefs,
    hiddenPermissions ?? shell?.hiddenPermissions ?? EMPTY,
  );
  const [collapsed, setCollapsed] = React.useState(false);
  const [hydrated, setHydrated] = React.useState(false);
  // 開示優先モード・監査法人は最上位も含めて 1 つ、従来メニューは「最上位＋葉」の既存仕様を保つ（A39）
  const mode = navCurrentModeFor(variant);
  // 同じ href が SSBJ と CSRD に出る画面（定性情報）で、どちらを現在地にするか（§10.1）。
  // SSR と初回描画は null（SSBJ 側）で、マウント後に保存値を当てる
  const preferredBranch = useNavBranch();
  // 現在地は描画するツリー全体で 1 か所で決める（リストごとに判定すると、同じ href が
  // 別の枝に出たときに aria-current が 2 つ並ぶ。docs/disclosure-first.md §9.1）
  const currentKeys = React.useMemo(
    () => resolveNavCurrent(items, pathname, { mode, collapsed, preferredBranch }),
    [items, pathname, mode, collapsed, preferredBranch],
  );
  // 開閉の判定は折りたたみに関わらない現在地で行う（折りたたみ中は最上位にしか現在地が無いため）
  const expandedCurrentKeys = React.useMemo(
    () => resolveNavCurrent(items, pathname, { mode, collapsed: false, preferredBranch }),
    [items, pathname, mode, preferredBranch],
  );
  const groups = useGroupOpenState(
    defaultCollapsedGroups ?? shell?.defaultCollapsedGroups ?? EMPTY,
    expandedCurrentKeys,
    pathname,
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

  const showNoEngagementHint = variant === 'assurance' && engagementIdFromPath(pathname) === null;

  return (
    <nav
      aria-label="メインナビゲーション"
      data-collapsed={collapsed ? 'true' : 'false'}
      className={cn(
        't4d-no-print flex shrink-0 flex-col border-r border-line bg-surface',
        collapsed ? 'w-sidebar-collapsed' : 'w-sidebar',
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
            groups={groups}
          />
        ))}
      </ul>
      {showNoEngagementHint && !collapsed && (
        <p className="border-t border-line px-3 py-2 text-caption text-ink-muted">
          {ASSURANCE_NO_ENGAGEMENT_HINT}
        </p>
      )}
      <div className="border-t border-line p-1.5">
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? 'サイドバーを展開' : 'サイドバーを折りたたむ'}
          aria-expanded={hydrated ? !collapsed : undefined}
          className="flex w-full items-center gap-2 rounded-t4d px-2 py-1.5 text-small text-ink-muted hover:bg-brand-50 hover:text-ink"
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

const EMPTY: never[] = [];

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
  groups,
}: {
  item: NavItem;
  /** ツリー内の位置（navItemKey）。現在地は位置で判定する */
  itemKey: string;
  currentKeys: Set<string>;
  pathname: string;
  collapsed: boolean;
  groups: GroupOpenApi;
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
  const listNavigation = useListNavigation();
  const hasChildren = !collapsed && (item.children?.length ?? 0) > 0;
  const groupId = navGroupId([item.label]);
  const open = hasChildren ? groups.isOpen(groupId, itemKey) : false;
  const listId = groupListId(itemKey);

  const link = (
    <Link
      href={item.href}
      aria-current={current ? 'page' : undefined}
      aria-label={collapsed ? item.label : undefined}
      data-nav-emphasis={emphasis}
      // 最上位のリンクを押したら優先枝を忘れる（§10.1 の (a)。定性情報は既定の SSBJ 側に戻る）。
      // 一覧に利用者の既定ビューがあれば、押した時点で条件を付けて移る（描画時には href を変えない）
      onClick={(event) => {
        rememberNavBranch(null);
        listNavigation.onLinkClick(event, item.href);
      }}
      className={cn(
        'flex items-center gap-2 rounded-t4d px-2 py-1.5 text-body transition-colors',
        collapsed && 'justify-center px-0',
        hasChildren && 'pr-8',
        emphasized ? 'bg-brand-100 font-medium text-brand-900' : 'text-ink hover:bg-brand-50',
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );

  return (
    // 最上位のリンクは li の直下に置く（`nav > ul > li > a` で並びを確かめる E2E のため）
    <li className="relative">
      {collapsed ? <Hint label={item.label}>{link}</Hint> : link}
      {hasChildren && item.children && (
        <>
          <GroupToggle
            label={item.label}
            open={open}
            controls={listId}
            onToggle={() => groups.toggle(groupId, itemKey)}
            className="top-1"
          />
          <SidebarChildList
            id={listId}
            hidden={!open}
            items={item.children}
            parentKey={itemKey}
            parentTrail={[item.label]}
            currentKeys={currentKeys}
            pathname={pathname}
            depth={1}
            groups={groups}
          />
        </>
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
  id,
  hidden,
  items,
  parentKey,
  parentTrail,
  currentKeys,
  pathname,
  depth,
  groups,
}: {
  id: string;
  /** 閉じたグループ（中の項目を支援技術にも出さない） */
  hidden: boolean;
  items: NavItem[];
  parentKey: string;
  /** 親までのラベルの経路（最後が親）。押したリンクの枝として覚える */
  parentTrail: string[];
  currentKeys: Set<string>;
  pathname: string;
  depth: number;
  groups: GroupOpenApi;
}) {
  const parentLabel = parentTrail[parentTrail.length - 1] ?? '';
  const branch = joinNavBranch(parentTrail);
  const listNavigation = useListNavigation();
  const deepCurrent = hasDeepNavCurrent(currentKeys);
  return (
    <ul
      id={id}
      hidden={hidden}
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
        const trail = [...parentTrail, child.label];
        const groupId = navGroupId(trail);
        const open = hasChildren ? groups.isOpen(groupId, key) : false;
        const listId = groupListId(key);
        return (
          <li key={`${child.href}-${child.label}`} className="relative">
            <Link
              href={child.href}
              aria-current={selfActive ? 'page' : undefined}
              data-nav-emphasis={emphasis}
              // 押したリンクの枝を覚える（§10.1 の (a)。定性情報を CSRD 側から開いたら CSRD を現在地にする）
              onClick={(event) => {
                rememberNavBranch(branch);
                listNavigation.onLinkClick(event, child.href);
              }}
              className={cn(
                'block rounded-t4d px-2 py-1 text-small',
                hasChildren && 'pr-8',
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
              <>
                <GroupToggle
                  label={child.label}
                  open={open}
                  controls={listId}
                  onToggle={() => groups.toggle(groupId, key)}
                  className="top-0"
                />
                <SidebarChildList
                  id={listId}
                  hidden={!open}
                  items={child.children}
                  parentKey={key}
                  parentTrail={trail}
                  currentKeys={currentKeys}
                  pathname={pathname}
                  depth={depth + 1}
                  groups={groups}
                />
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}
