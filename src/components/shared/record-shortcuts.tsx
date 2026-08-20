'use client';

import * as React from 'react';

/**
 * 連続レビュー用のキーボードショートカット（指示書 5.4）。
 *
 * `Ctrl/Cmd + K` と `/` は CommandPalette 側が持つ。ここは残りを担当する。
 *
 *   j / k … 一覧の次 / 前のレコードへ移動（`[data-t4d-record]` を辿る）
 *   e     … Evidence セクションへ移動（`[data-t4d-shortcut="evidence"]`）
 *   c     … コメント入力へフォーカス（`[data-t4d-shortcut="comment"]` / `[name="comment"]`）
 *   s     … 下書き保存（`[data-t4d-shortcut="save"]`）
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

export function RecordShortcuts() {
  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (shouldIgnore(event)) return;

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
          focusFirst([
            '[data-t4d-shortcut="comment"]',
            'input[name="comment"]',
            'textarea[name="comment"]',
          ]);
          break;
        case 's': {
          const save = document.querySelector<HTMLElement>('[data-t4d-shortcut="save"]');
          if (!save) return;
          event.preventDefault();
          // 下書き保存のみ。requestSubmit を使うので必須項目の検証は通常どおり働く。
          save.click();
          break;
        }
        default:
          break;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return null;
}
