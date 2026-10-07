'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Bookmark, ChevronDown, Star, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import {
  MAX_USER_VIEWS,
  readTableViews,
  sanitizeViewQuery,
  writeTableViews,
  type TableViewStore,
} from '@/lib/table/views';
import { useViewerKey } from '../viewer-context';

export interface ViewPreset {
  label: string;
  query: string;
  description?: string;
}

/**
 * 保存ビュー（plan §1.9・§3.2）。固定のプリセット（画面が用意する条件）と、利用者が名前を付けて
 * 保存した条件・既定ビューを 1 つのメニューにまとめる。利用者の分は端末ごと（localStorage）。
 *
 * 描画の後に URL を書き換えない。既定ビューは「アプリ内のリンクを押したときに付ける」（useListNavigation）。
 * 保存ビューの読み込みはマウント後（サーバー描画と同じ見た目から始める）。
 */
export function ViewMenu({
  tableId,
  basePath,
  presets = [],
  userViews = false,
}: {
  tableId: string;
  basePath: string;
  presets?: readonly ViewPreset[];
  /** 利用者の保存ビュー・既定ビューを使う */
  userViews?: boolean;
}) {
  const viewerKey = useViewerKey();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentQuery = sanitizeViewQuery(searchParams?.toString() ?? '');
  const [store, setStore] = React.useState<TableViewStore>({ views: [] });
  const [naming, setNaming] = React.useState(false);
  const [name, setName] = React.useState('');

  React.useEffect(() => {
    if (userViews) setStore(readTableViews(viewerKey, tableId));
  }, [tableId, userViews, viewerKey]);

  const save = (next: TableViewStore) => {
    setStore(next);
    writeTableViews(viewerKey, tableId, basePath, next);
  };

  const hrefOf = (query: string) => (query ? `${pathname}?${query}` : pathname);
  const isDefault = Boolean(store.defaultQuery) && store.defaultQuery === currentQuery;
  const defaultName =
    store.views.find((v) => v.query === store.defaultQuery)?.name ??
    presets.find((p) => p.query === store.defaultQuery)?.label ??
    '保存した条件';

  if (presets.length === 0 && !userViews) return null;

  return (
    <div className="flex items-center gap-1.5">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="xs" data-t4d-view-menu="">
            <Bookmark aria-hidden="true" />
            保存ビュー
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[240px]">
          {presets.length > 0 && (
            <>
              <DropdownMenuLabel>よく使う条件</DropdownMenuLabel>
              {presets.map((preset) => (
                <DropdownMenuItem key={preset.label} asChild>
                  <Link href={hrefOf(preset.query)}>
                    {preset.label}
                    {preset.description && (
                      <span className="sr-only">（{preset.description}）</span>
                    )}
                  </Link>
                </DropdownMenuItem>
              ))}
            </>
          )}
          {userViews && (
            <>
              {presets.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel>自分の保存ビュー（この端末）</DropdownMenuLabel>
              {store.views.length === 0 && (
                <p className="px-2 py-1 text-caption text-ink-muted">まだありません</p>
              )}
              {store.views.map((view) => (
                <div key={view.name} className="flex items-center gap-1">
                  <DropdownMenuItem asChild className="flex-1">
                    <Link href={hrefOf(view.query)}>
                      {store.defaultQuery === view.query && (
                        <Star className="size-3 text-warning-ink" aria-label="既定" />
                      )}
                      {view.name}
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    aria-label={`保存ビュー「${view.name}」を削除`}
                    className="px-1.5"
                    onSelect={() =>
                      save({
                        ...store,
                        views: store.views.filter((v) => v.name !== view.name),
                        ...(store.defaultQuery === view.query ? { defaultQuery: undefined } : {}),
                      })
                    }
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </DropdownMenuItem>
                </div>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={store.views.length >= MAX_USER_VIEWS}
                onSelect={() => {
                  setName('');
                  setNaming(true);
                }}
              >
                今の条件を保存…
              </DropdownMenuItem>
              {isDefault ? (
                <DropdownMenuItem onSelect={() => save({ ...store, defaultQuery: undefined })}>
                  既定の条件を解除
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  disabled={currentQuery === ''}
                  onSelect={() => save({ ...store, defaultQuery: currentQuery })}
                >
                  今の条件をメニューから開いたときの既定にする
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 直接の URL・ブックマークで開いたときは既定の条件が付かない。付いていないことが分かるようにする */}
      {userViews && store.defaultQuery && currentQuery === '' && (
        <Link
          href={hrefOf(store.defaultQuery)}
          className="text-caption text-brand-700 hover:underline"
          data-t4d-default-view=""
        >
          既定のビュー: {defaultName}（適用）
        </Link>
      )}

      <Dialog open={naming} onOpenChange={setNaming}>
        <DialogContent className="max-w-sm">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = name.trim();
              if (!trimmed) return;
              save({
                ...store,
                views: [
                  ...store.views.filter((v) => v.name !== trimmed),
                  { name: trimmed, query: currentQuery },
                ].slice(-MAX_USER_VIEWS),
              });
              setNaming(false);
            }}
          >
            <DialogHeader>
              <DialogTitle>今の条件を保存</DialogTitle>
              <DialogDescription>
                絞り込み・並べ替え・列・表示件数を名前を付けて残します（この端末のこの利用者だけ）。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1 px-4 py-3">
              <label htmlFor={`${tableId}-view-name`} className="text-small font-medium text-ink">
                名前
              </label>
              <Input
                id={`${tableId}-view-name`}
                value={name}
                required
                maxLength={40}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="ghost" size="sm">
                  キャンセル
                </Button>
              </DialogClose>
              <SubmitButton variant="primary" size="sm">
                保存
              </SubmitButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
