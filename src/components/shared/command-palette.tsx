'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useNavItems, type SidebarVariant } from './sidebar';

export interface CommandEntry {
  label: string;
  href: string;
  group: string;
  keywords?: string[];
}

/**
 * Ctrl/Cmd + K で開くコマンドパレット（指示書 5.4）。
 * 「/」で一覧検索へフォーカスするショートカットもここで束ねる。
 */
export function CommandPalette({
  variant,
  hiddenHrefs,
  extraEntries = [],
}: {
  variant: SidebarVariant;
  hiddenHrefs: string[];
  extraEntries?: CommandEntry[];
}) {
  const router = useRouter();
  const navItems = useNavItems(variant, hiddenHrefs);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [activeIndex, setActiveIndex] = React.useState(0);

  const entries = React.useMemo<CommandEntry[]>(() => {
    const out: CommandEntry[] = [];
    for (const item of navItems) {
      out.push({
        label: item.label,
        href: item.href,
        group: 'ナビゲーション',
        keywords: item.keywords,
      });
      for (const child of item.children ?? []) {
        out.push({
          label: `${item.label} / ${child.label}`,
          href: child.href,
          group: 'ナビゲーション',
        });
      }
    }
    return [...out, ...extraEntries];
  }, [navItems, extraEntries]);

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
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries.slice(0, 30);
    return entries
      .filter((entry) =>
        [entry.label, entry.group, ...(entry.keywords ?? [])].join(' ').toLowerCase().includes(q),
      )
      .slice(0, 30);
  }, [entries, query]);

  React.useEffect(() => setActiveIndex(0), [query, open]);

  const go = (href: string) => {
    setOpen(false);
    setQuery('');
    router.push(href);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl p-0" hideClose>
        <DialogTitle className="sr-only">コマンドパレット</DialogTitle>
        <DialogDescription className="sr-only">
          画面名やキーワードを入力して移動します。上下キーで選択、Enter で移動、Esc で閉じます。
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
            placeholder="画面を検索（例: サンプリング、CDP、母集団）"
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
            className="h-7 w-full bg-transparent text-[13px] outline-none placeholder:text-ink-muted/70"
          />
          <kbd className="rounded border border-line px-1 text-[11px] text-ink-muted">Esc</kbd>
        </div>
        {/*
          listbox の直下は option だけにする（li でくるむと構造が不正になり、
          支援技術が候補を数えられない）。
        */}
        <div
          id="t4d-cmdk-list"
          role="listbox"
          aria-label="検索結果"
          className="max-h-80 overflow-y-auto p-1"
        >
          {filtered.length === 0 && (
            <p className="px-3 py-6 text-center text-[12px] text-ink-muted">
              一致する画面がありません
            </p>
          )}
          {filtered.map((entry, index) => (
            // 候補は combobox の作法どおり、フォーカスを持たない（入力欄に留めたまま
            // aria-activedescendant で選択中を伝える）。キー操作は入力欄側で処理している。
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events
            <div
              key={`${entry.group}-${entry.href}-${entry.label}`}
              id={`t4d-cmdk-option-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === activeIndex}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => go(entry.href)}
              className={cn(
                'flex w-full cursor-pointer items-center justify-between gap-2 rounded-[4px] px-2 py-1.5 text-left text-[13px]',
                index === activeIndex ? 'bg-brand-50 text-brand-900' : 'text-ink',
              )}
            >
              <span className="truncate">{entry.label}</span>
              <span className="shrink-0 text-[11px] text-ink-muted">{entry.group}</span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
