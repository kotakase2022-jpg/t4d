'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { PermissionKey } from '@/types/domain';
import { canOpenRoute, routeForPath } from './route-catalog';
import { useShell } from './viewer-context';

/**
 * 連続レビュー用のキーボードショートカット（指示書 5.4）。
 *
 * `Ctrl/Cmd + K` と `/` は CommandPalette 側が持つ。ここは残りを担当する。
 *
 *   j / k … 一覧の次 / 前のレコードへ移動（`[data-t4d-record]` を辿る）
 *   e     … Evidence セクションへ移動（`[data-t4d-shortcut="evidence"]`）
 *   c     … コメント入力へフォーカス（`[data-t4d-shortcut="comment"]`）
 *   s     … 下書き保存（`[data-t4d-shortcut="save"]`）
 *   x     … フォーカス中の行の選択を切り替える（`[data-t4d-record] [data-t4d-select]`。一括操作）
 *   n     … その画面の新規作成（`[data-t4d-shortcut="new"]`。開くだけで保存はしない）
 *   g → h/d/w/i/s/c … ホーム・非財務データ・ワークフロー・取込・SSBJ・CSRD へ移動（plan §1.11）
 *
 * 設計上の約束:
 *  - **対象が無い画面では何もしない。** 押しても副作用が起きないことを保証する。
 *  - `s` を割り当ててよいのは**下書き保存だけ**。提出・承認・確定・Sign-off には
 *    絶対に割り当てない（誤打鍵で業務が確定してしまうため）。
 *    この境界は `data-t4d-shortcut="save"` を付ける側の責務。
 *  - 入力中（input / textarea / contenteditable）と修飾キー併用時は無効。
 *  - ダイアログが開いている間は無効（Palette やモーダルの操作を奪わない）。
 */

/** 入力中・ダイアログ表示中はショートカットを無効にする。 */
function shouldIgnore(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return true;
  const target = event.target as HTMLElement | null;
  if (
    target?.tagName === 'INPUT' ||
    target?.tagName === 'TEXTAREA' ||
    target?.tagName === 'SELECT' ||
    target?.isContentEditable === true
  ) {
    return true;
  }
  return document.querySelector('[role="dialog"]') !== null;
}

/** レコード行の中で「開く」対象になるリンク。無ければ行自身。 */
function focusTargetOf(record: Element): HTMLElement | null {
  const link = record.querySelector<HTMLElement>('a[href]');
  return link ?? (record as HTMLElement);
}

function moveRecord(direction: 1 | -1): void {
  const records = [...document.querySelectorAll('[data-t4d-record]')];
  if (records.length === 0) return;

  const active = document.activeElement;
  const currentIndex = records.findIndex((r) => r.contains(active));
  // 未選択なら j は先頭、k は末尾から始める
  const nextIndex =
    currentIndex === -1
      ? direction === 1
        ? 0
        : records.length - 1
      : Math.min(Math.max(currentIndex + direction, 0), records.length - 1);

  const record = records[nextIndex];
  if (!record) return;
  const target = focusTargetOf(record);
  if (!target) return;
  target.focus({ preventScroll: true });
  record.scrollIntoView({ block: 'nearest' });
}

function focusFirst(selectors: string[]): void {
  for (const selector of selectors) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element) {
      element.focus({ preventScroll: true });
      element.scrollIntoView({ block: 'nearest' });
      return;
    }
  }
}

/** g の後に押すキー → 行き先（企業ワークスペース） */
export const GO_SHORTCUTS: Record<string, string> = {
  h: '/enterprise/dashboard',
  d: '/enterprise/data',
  w: '/enterprise/workflows',
  i: '/enterprise/imports',
  s: '/enterprise/disclosures/ssbj',
  c: '/enterprise/disclosures/csrd',
};

/**
 * その利用者が g で移れる行き先（キー → 行き先）。開けない画面（権限なし）へは移さない
 * （メニュー・パレットと同じく、「権限なし」に着く操作を出さない。plan R3）。
 * 監査法人ではホームだけ（他の行き先は企業の画面のため）。
 * 権限が分からない（AppShell の外）ときは絞らない（検査はページのゲートが行う）
 */
export function goShortcutTargets(
  homeHref: string,
  can: ((permission: PermissionKey) => boolean) | null,
): Record<string, string> {
  const targets: Record<string, string> = { h: homeHref };
  if (!homeHref.startsWith('/enterprise')) return targets;
  for (const [key, href] of Object.entries(GO_SHORTCUTS)) {
    if (key === 'h') continue;
    const route = routeForPath(href);
    if (!can || !route || canOpenRoute(route, can)) targets[key] = href;
  }
  return targets;
}

/** g を押してから次のキーを待つ時間 */
const GO_PREFIX_TIMEOUT_MS = 1500;

/** フォーカス中の行の選択チェックを切り替える */
function toggleFocusedRecordSelection(): boolean {
  const record = document.activeElement?.closest('[data-t4d-record]');
  const checkbox = record?.querySelector<HTMLInputElement>(
    'input[type="checkbox"][data-t4d-select]',
  );
  if (!checkbox || checkbox.disabled) return false;
  checkbox.click();
  return true;
}

export function RecordShortcuts({ homeHref = '/enterprise/dashboard' }: { homeHref?: string }) {
  const router = useRouter();
  const shell = useShell();
  const goTargets = React.useMemo(
    () =>
      goShortcutTargets(
        homeHref,
        shell ? (permission: PermissionKey) => shell.permissions.includes(permission) : null,
      ),
    [homeHref, shell],
  );
  React.useEffect(() => {
    let goPrefixAt = 0;
    function onKeyDown(event: KeyboardEvent) {
      if (shouldIgnore(event)) return;

      // g → キー（移動）。開ける画面だけ（goShortcutTargets）
      if (goPrefixAt > 0 && Date.now() - goPrefixAt < GO_PREFIX_TIMEOUT_MS) {
        goPrefixAt = 0;
        const target = Object.prototype.hasOwnProperty.call(goTargets, event.key)
          ? goTargets[event.key]
          : undefined;
        if (target) {
          event.preventDefault();
          router.push(target);
        }
        return;
      }
      if (event.key === 'g') {
        goPrefixAt = Date.now();
        return;
      }

      switch (event.key) {
        case 'j':
          event.preventDefault();
          moveRecord(1);
          break;
        case 'k':
          event.preventDefault();
          moveRecord(-1);
          break;
        case 'e':
          event.preventDefault();
          focusFirst(['[data-t4d-shortcut="evidence"]']);
          break;
        case 'c':
          event.preventDefault();
          // 印だけを見る。name="comment" を拾うと、Data Point 詳細では
          // 差戻し理由の入力欄へ飛んでしまう（コメント欄ではない）。
          focusFirst(['[data-t4d-shortcut="comment"]']);
          break;
        case 's': {
          const save = document.querySelector<HTMLElement>('[data-t4d-shortcut="save"]');
          if (!save) return;
          event.preventDefault();
          // 下書き保存のみ。requestSubmit を使うので必須項目の検証は通常どおり働く。
          save.click();
          break;
        }
        case 'x':
          if (toggleFocusedRecordSelection()) event.preventDefault();
          break;
        case 'n': {
          // 新規作成は「開く」だけ（作成フォーム・専用ページへ移る）。保存・確定には割り当てない
          const create = document.querySelector<HTMLElement>('[data-t4d-shortcut="new"]');
          if (!create) return;
          event.preventDefault();
          create.click();
          break;
        }
        default:
          break;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goTargets, router]);

  return null;
}
