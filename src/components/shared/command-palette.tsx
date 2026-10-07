'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { Search } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { OPEN_CONFIRM_EVENT, sameScreenConfirmId } from '@/lib/ui/actions';
import { LOCAL_KEYS, readLocal } from '@/lib/ui/local-store';
import {
  PALETTE_GROUP_LABELS,
  arrangePaletteEntries,
  buildPaletteEntries,
  normalizePaletteText,
  type PaletteEntry,
  type PaletteGroup,
} from '@/lib/ui/palette';
import { parseRecentItems } from '@/lib/ui/recent';
import type { TaskVerbContext } from '@/lib/ui/task-verbs';
import { cn } from '@/lib/utils';
import type { PermissionKey } from '@/types/domain';
import { useListNavigation } from './data-table/use-list-href';
import { projectIdFromPath } from './header-context';
import type { NavItem } from './nav-config';
import { engagementIdFromPath, useNavItems, type SidebarVariant } from './sidebar';
import { useShell } from './viewer-context';

export interface CommandEntry {
  label: string;
  href: string;
  group: string;
  keywords?: string[];
}

/**
 * メニューのツリーを候補に展開する。3 階層対応: 「開示対応 / SSBJ / 対応状況」のように
 * 経路をラベルにして全階層を拾う。別導線（secondary）は正規の位置と同じ画面なので候補に重ねない。
 */
export function navCommandEntries(items: NavItem[]): CommandEntry[] {
  const out: CommandEntry[] = [];
  const walk = (nodes: NavItem[], trail: string[]) => {
    for (const item of nodes) {
      if (item.secondary) continue;
      // 入口の画面を開けないグループ（リンク先を子に置き換えた行）は、子と同じ行き先を別名で出さない
      if (item.linkFallback) {
        if (item.children) walk(item.children, [...trail, item.label]);
        continue;
      }
      out.push({
        label: [...trail, item.label].join(' / '),
        href: item.href,
        group: 'ナビゲーション',
        keywords: item.keywords,
      });
      if (item.children) walk(item.children, [...trail, item.label]);
    }
  };
  walk(items, []);
  return out;
}

/** データの検索（Server Action）。2 文字以上で呼ぶ。各種類 8 件まで */
export type PaletteSearchAction = (query: string) => Promise<{ entries: PaletteEntry[] }>;

/** ヘッダーの「検索」ボタンなど、パレットの外から開くためのイベント名 */
export const OPEN_PALETTE_EVENT = 't4d:open-command-palette';

export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_PALETTE_EVENT));
}

/** プロジェクトの画面で開いたときは、そのプロジェクトを「現在のプロジェクト」にする（ヘッダーの表示と同じ決め方） */
function withProjectFromPath(context: TaskVerbContext, pathname: string): TaskVerbContext {
  const projectId = projectIdFromPath(pathname);
  return projectId ? { ...context, currentProjectId: projectId } : context;
}

const DATA_SEARCH_MIN_LENGTH = 2;
const DATA_SEARCH_DELAY_MS = 200;

/**
 * Ctrl/Cmd + K で開くコマンドパレット（指示書 §9・plan §1.10）。
 * 「/」で一覧検索へフォーカスするショートカットもここで束ねる。
 *
 * 候補の順: 最近使った画面 → おすすめ（空のクエリのとき）→ 操作 → 画面 → 設定の項目 → データ。
 * 候補を選ぶとその画面へ移るだけで、操作は実行しない（承認・確定は移った先で人が押す）。
 */
export function CommandPalette({
  variant,
  hiddenHrefs,
  extraEntries = [],
  searchAction,
}: {
  variant: SidebarVariant;
  hiddenHrefs: string[];
  extraEntries?: CommandEntry[];
  searchAction?: PaletteSearchAction;
}) {
  const pathname = usePathname();
  const listNavigation = useListNavigation();
  const shell = useShell();
  const navItems = useNavItems(variant, hiddenHrefs, shell?.hiddenPermissions);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [recent, setRecent] = React.useState<PaletteEntry[]>([]);
  const [data, setData] = React.useState<{ query: string; entries: PaletteEntry[] } | null>(null);
  const [searching, setSearching] = React.useState(false);

  const workspace = variant === 'assurance' ? 'assurance' : 'enterprise';
  const staticGroups = React.useMemo(() => {
    const permissions = shell?.permissions ?? [];
    const can = (permission: PermissionKey) => permissions.includes(permission);
    const navPaths = navCommandEntries(navItems).map((entry) => ({
      href: entry.href,
      label: entry.label,
      keywords: entry.keywords,
    }));
    const built = buildPaletteEntries({
      workspace,
      can,
      profile: shell?.profile,
      verbContext: withProjectFromPath(shell?.verbContext ?? { unitScopeIds: [] }, pathname),
      engagementId: shell?.engagementId ?? engagementIdFromPath(pathname),
      navPaths,
    });
    // メニューの項目は権限で絞った描画中のツリーから必ず出す（パレットを開いた画面のメニューと同じ集合）
    const navScreens: PaletteEntry[] = navPaths.map((nav) => ({
      id: `screen:${nav.href}`,
      group: 'screens',
      label: nav.label,
      href: nav.href,
      keywords: nav.keywords,
    }));
    const extras: PaletteEntry[] = extraEntries.map((entry) => ({
      id: `extra:${entry.href}:${entry.label}`,
      group: 'screens',
      label: entry.label,
      href: entry.href,
      hint: entry.group,
      keywords: entry.keywords,
    }));
    const seen = new Set<string>();
    const screens = [...navScreens, ...built.screens, ...extras].filter((entry) => {
      const key = `${entry.href}\u0000${entry.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ...built, screens };
  }, [extraEntries, navItems, pathname, shell, workspace]);

  // 開いたときに最近使った画面を読む（端末ごと。読めない環境では空のまま）
  React.useEffect(() => {
    if (!open) return;
    const items = readLocal(LOCAL_KEYS.recent(shell?.viewerKey ?? 'anonymous'), parseRecentItems);
    setRecent(
      (items ?? []).map((item) => ({
        id: `recent:${item.href}`,
        group: 'recent',
        label: item.label,
        href: item.href,
        hint: '最近',
      })),
    );
  }, [open, shell?.viewerKey]);

  // データの検索（2 文字以上・入力が止まってから）
  React.useEffect(() => {
    const q = normalizePaletteText(query);
    if (!open || !searchAction || q.length < DATA_SEARCH_MIN_LENGTH) {
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      searchAction(query)
        .then((result) => {
          if (!cancelled) setData({ query, entries: result.entries });
        })
        .catch(() => {
          // 検索に失敗しても画面・操作の候補は使える（データの欄だけ空にする）
          if (!cancelled) setData({ query, entries: [] });
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, DATA_SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query, searchAction]);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (event.key === '/' && !typing && !open) {
        const search = document.querySelector<HTMLInputElement>('[data-t4d-list-search]');
        if (search) {
          event.preventDefault();
          search.focus();
        }
      }
    }
    function onOpenRequest() {
      setOpen(true);
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpenRequest);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpenRequest);
    };
  }, [open]);

  const dataEntries = React.useMemo(
    () =>
      data && normalizePaletteText(data.query) === normalizePaletteText(query) ? data.entries : [],
    [data, query],
  );
  const filtered = React.useMemo(
    () =>
      arrangePaletteEntries(
        {
          recent,
          recommended: staticGroups.recommended,
          actions: staticGroups.actions,
          screens: staticGroups.screens,
          settings: staticGroups.settings,
          data: dataEntries,
        },
        query,
      ),
    [dataEntries, query, recent, staticGroups],
  );

  React.useEffect(() => setActiveIndex(0), [query, open]);

  // 閉じたら入力とデータの検索結果を捨てる。残すと、役割・ワークスペースを切り替えたあとに開いたとき、
  // 前の利用者・組織の検索結果（管理者だけが見られるメンバーなど）が再検索の間だけ並び、Enter で開けた
  React.useEffect(() => {
    if (open) return;
    setQuery('');
    setData(null);
  }, [open]);

  const go = (href: string) => {
    setOpen(false);
    setQuery('');
    // 一覧に利用者の既定ビューがあれば条件を付けて移る（条件付きの行き先はそのまま）
    listNavigation.navigate(href);
    // 今の画面の確認ダイアログ（?confirm=）なら、その画面の「その他」に開くよう頼む。
    // パレットが閉じてから開く（2 つのダイアログのフォーカスの受け渡しを競合させない）
    const confirmId = sameScreenConfirmId(href, pathname);
    if (confirmId) {
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent(OPEN_CONFIRM_EVENT, { detail: confirmId }));
      }, 0);
    }
  };

  const grouped = groupEntries(filtered);
  const showDataSkeleton =
    searching && normalizePaletteText(query).length >= DATA_SEARCH_MIN_LENGTH;
  let optionIndex = -1;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl p-0" hideClose>
        <DialogTitle className="sr-only">コマンドパレット</DialogTitle>
        <DialogDescription className="sr-only">
          画面名・操作・データを入力して移動します。上下キーで選択、Enter で移動、Esc で閉じます。
        </DialogDescription>
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <Search className="size-4 text-ink-muted" aria-hidden="true" />
          <input
            // Command Palette は「開いた瞬間に入力できる」ことが目的の一時ダイアログであり、
            // Radix Dialog の Focus Trap 内で完結するため autoFocus が適切。
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') {
                const target = filtered[activeIndex];
                if (target) {
                  e.preventDefault();
                  go(target.href);
                }
              }
            }}
            placeholder={
              workspace === 'assurance'
                ? '画面・操作・案件を検索（例: サンプリング、母集団、Sign-off）'
                : '画面・操作・指標・要求事項コードを検索（例: SSBJ、電力、CDP）'
            }
            aria-label="コマンドパレット検索"
            // 上下キーで動く「選択中の候補」を支援技術へ伝える。
            // これが無いと、読み上げでは何が選ばれているか分からない。
            role="combobox"
            aria-expanded
            aria-controls="t4d-cmdk-list"
            aria-autocomplete="list"
            aria-activedescendant={
              filtered[activeIndex] ? `t4d-cmdk-option-${activeIndex}` : undefined
            }
            className="h-7 w-full bg-transparent text-body outline-none placeholder:text-ink-muted/70"
          />
          <kbd className="rounded border border-line px-1 text-caption text-ink-muted">Esc</kbd>
        </div>
        {/*
          listbox の直下はグループ（role=group）と候補（option）だけにする。候補の数が変わっても
          ダイアログの高さが変わらないよう、領域は固定の高さにする（データの検索結果の到着でずれない）
        */}
        <div
          id="t4d-cmdk-list"
          role="listbox"
          aria-label="検索結果"
          className="h-80 overflow-y-auto p-1"
        >
          {filtered.length === 0 && !showDataSkeleton && (
            <p className="px-3 py-6 text-center text-small text-ink-muted">
              一致する画面がありません
            </p>
          )}
          {grouped.map(([group, entries]) => (
            <div
              key={group}
              role="group"
              aria-labelledby={`t4d-cmdk-group-${group}`}
              data-palette-group={group}
            >
              <div
                id={`t4d-cmdk-group-${group}`}
                role="presentation"
                className="px-2 pt-1.5 pb-0.5 text-caption font-semibold text-ink-muted"
              >
                {PALETTE_GROUP_LABELS[group]}
              </div>
              {entries.map((entry) => {
                optionIndex += 1;
                const index = optionIndex;
                return (
                  // 候補は combobox の作法どおり、フォーカスを持たない（入力欄に留めたまま
                  // aria-activedescendant で選択中を伝える）。キー操作は入力欄側で処理している。
                  // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                  <div
                    key={`${entry.group}-${entry.id}`}
                    id={`t4d-cmdk-option-${index}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === activeIndex}
                    data-palette-href={entry.href}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => go(entry.href)}
                    className={cn(
                      'flex w-full cursor-pointer items-center justify-between gap-2 rounded-[4px] px-2 py-1.5 text-left text-body',
                      index === activeIndex ? 'bg-brand-50 text-brand-900' : 'text-ink',
                    )}
                  >
                    <span className="truncate">{entry.label}</span>
                    {entry.hint && (
                      <span className="shrink-0 text-caption text-ink-muted">{entry.hint}</span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {showDataSkeleton && (
            <div role="status" aria-live="polite" className="space-y-1 px-2 py-1.5">
              <span className="sr-only">データを検索しています</span>
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-5 w-2/3" />
            </div>
          )}
        </div>
        <p className="border-t border-line px-3 py-1.5 text-caption text-ink-muted">
          操作を選ぶとその画面へ移ります（承認・確定・リセットは移った先で確認してから実行します）。
        </p>
      </DialogContent>
    </Dialog>
  );
}

function groupEntries(entries: readonly PaletteEntry[]): Array<[PaletteGroup, PaletteEntry[]]> {
  const out: Array<[PaletteGroup, PaletteEntry[]]> = [];
  for (const entry of entries) {
    const last = out[out.length - 1];
    if (last && last[0] === entry.group) last[1].push(entry);
    else out.push([entry.group, [entry]]);
  }
  return out;
}
