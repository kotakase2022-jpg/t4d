'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, ChevronDown } from 'lucide-react';
import { Button, type ButtonSize, type ButtonVariant } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { OPEN_CONFIRM_EVENT, orderMenuItems, type MenuActionSpec } from '@/lib/ui/actions';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from './confirm-dialog';

/**
 * 「その他 ▾」のメニュー（plan §1.5 L2・L3、§3.1 MoreMenu）。頻度の低い操作（出力・複製・AI の補助・
 * 履歴）と管理者向けの操作（デモのリセットなど）を置く。
 *
 * - 起動ボタンは文字付き（「その他」）。アイコンだけにしない
 * - 並び: 日常 → 出力 → 高度、破壊的な操作は区切り線の下に赤字＋アイコン
 * - submit の項目はメニューの外の隠しフォームを送る（メニューは選ぶと閉じて中身が消えるため）
 * - confirm の項目は確認ダイアログを開く（メニューの外に置き、閉じたメニューに引きずられない）
 * - 押せない項目は理由を項目の中に文字で出す（Radix の disabled はキーボードで飛ばされ、理由が届かない）
 */
export function MoreMenu({
  label = 'その他',
  items,
  align = 'end',
  triggerVariant = 'secondary',
  triggerSize = 'sm',
  triggerAriaLabel,
  /** 確認ダイアログを最初から開く項目（例: パレットから ?confirm= で来たとき） */
  openConfirmId,
}: {
  label?: string;
  items: readonly MenuActionSpec[];
  align?: 'start' | 'end';
  triggerVariant?: ButtonVariant;
  triggerSize?: ButtonSize;
  /** 行の操作のように、同じ文字のボタンが並ぶときの区別（例: 「東日本工場 の操作」） */
  triggerAriaLabel?: string;
  openConfirmId?: string;
}) {
  const ordered = React.useMemo(() => orderMenuItems(items), [items]);
  const formRefs = React.useRef(new Map<string, HTMLFormElement>());
  const [openConfirm, setOpenConfirm] = React.useState<string | null>(openConfirmId ?? null);
  // ?confirm= が後から変わったときも開く。Next は検索条件だけが変わる遷移（同じ画面のまま
  // パレットから ?confirm= へ移る）では部品を作り直さないため、初期値だけでは開かなかった
  const [syncedConfirmId, setSyncedConfirmId] = React.useState(openConfirmId);
  if (openConfirmId !== syncedConfirmId) {
    setSyncedConfirmId(openConfirmId);
    if (openConfirmId) setOpenConfirm(openConfirmId);
  }
  // 同じ URL への遷移（一度閉じてから同じコマンドをもう一度選ぶ）は props も変わらないので、
  // パレットからの依頼（OPEN_CONFIRM_EVENT）で開く
  React.useEffect(() => {
    function onRequest(event: Event) {
      const id = (event as CustomEvent<unknown>).detail;
      const target = ordered.find((item) => item.id === id);
      if (target && target.kind === 'confirm' && !target.hidden && !target.disabledReason) {
        setOpenConfirm(target.id);
      }
    }
    window.addEventListener(OPEN_CONFIRM_EVENT, onRequest);
    return () => window.removeEventListener(OPEN_CONFIRM_EVENT, onRequest);
  }, [ordered]);

  if (ordered.length === 0) return null;

  let previousGroup: string | null = null;
  let destructiveStarted = false;

  return (
    <>
      {/* modal にしない: 項目から確認ダイアログを開いたとき、メニューの閉じ処理（body の pointer-events・
          フォーカスの戻し）とダイアログが競合しないようにする */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant={triggerVariant}
            size={triggerSize}
            aria-label={triggerAriaLabel}
            data-more-menu=""
          >
            {label}
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="min-w-[220px]">
          {ordered.map((item) => {
            const group = item.group ?? 'main';
            const separators: React.ReactNode[] = [];
            if (item.destructive && !destructiveStarted) {
              destructiveStarted = true;
              if (previousGroup !== null)
                separators.push(<DropdownMenuSeparator key={`sep-d-${item.id}`} />);
            } else if (!item.destructive && previousGroup !== null && previousGroup !== group) {
              separators.push(<DropdownMenuSeparator key={`sep-${item.id}`} />);
            }
            previousGroup = group;
            return (
              <React.Fragment key={item.id}>
                {separators}
                <MenuEntry
                  item={item}
                  onSubmit={() => formRefs.current.get(item.id)?.requestSubmit()}
                  onConfirm={() => setOpenConfirm(item.id)}
                />
              </React.Fragment>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {ordered.map((item) => {
        if (item.hidden || item.disabledReason) return null;
        if (item.kind === 'submit') {
          return (
            <form
              key={item.id}
              action={item.action}
              hidden
              ref={(el) => {
                if (el) formRefs.current.set(item.id, el);
                else formRefs.current.delete(item.id);
              }}
            >
              {Object.entries(item.fields ?? {}).map(([name, value]) => (
                <input key={name} type="hidden" name={name} value={value} />
              ))}
            </form>
          );
        }
        if (item.kind === 'confirm') {
          return (
            <ConfirmDialog
              key={item.id}
              {...item.confirm}
              destructive={item.confirm.destructive ?? item.destructive}
              action={item.action}
              fields={item.fields}
              open={openConfirm === item.id}
              onOpenChange={(next) => setOpenConfirm(next ? item.id : null)}
            />
          );
        }
        return null;
      })}
    </>
  );
}

function MenuEntry({
  item,
  onSubmit,
  onConfirm,
}: {
  item: MenuActionSpec;
  onSubmit: () => void;
  onConfirm: () => void;
}) {
  const className = cn(item.destructive && 'text-danger focus:bg-danger-soft');
  const icon = item.destructive ? (
    <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
  ) : (
    item.icon
  );

  if (item.disabledReason) {
    return (
      <DropdownMenuItem
        aria-disabled="true"
        data-action-id={item.id}
        className="cursor-default flex-col items-start gap-0 text-ink-muted"
        onSelect={(event) => event.preventDefault()}
      >
        <span className="flex items-center gap-2">
          {icon}
          {item.label}
        </span>
        <span className="text-caption">（{item.disabledReason}）</span>
      </DropdownMenuItem>
    );
  }

  if (item.kind === 'link') {
    return (
      <DropdownMenuItem asChild className={className} data-action-id={item.id}>
        {item.download || item.external ? (
          <a href={item.href} download={item.download ? '' : undefined}>
            {icon}
            {item.label}
          </a>
        ) : (
          <Link href={item.href}>
            {icon}
            {item.label}
          </Link>
        )}
      </DropdownMenuItem>
    );
  }

  return (
    <DropdownMenuItem
      className={className}
      data-action-id={item.id}
      onSelect={item.kind === 'submit' ? onSubmit : onConfirm}
    >
      {icon}
      {item.label}
      {/* 確認ダイアログが開く項目は「…」で示す（state-actions のラベルが既に付けていれば重ねない） */}
      {item.kind === 'confirm' && !item.label.endsWith('…') && '…'}
    </DropdownMenuItem>
  );
}
