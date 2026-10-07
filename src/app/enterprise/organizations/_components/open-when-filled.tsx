'use client';

import * as React from 'react';

/**
 * 任意の節（FormSection kind="optional" の details）の中に置き、入力が入っていれば節を開く。
 *
 * 入力エラーで戻ったとき、PreservingForm はフォームを作り直してから送った値を DOM に戻す
 * （restoreFormValues。親の layout effect）。作り直した節は既定で閉じるため、直すべき値（下限・上限など）が
 * 閉じた節に隠れてしまう。値を戻した後（子の passive effect は親の layout effect の後に動く）に節の中を見て、
 * 値の入った欄があれば開く。開閉は保存しない（docs/disclosure-first.md §10.4）。
 */
export function OpenWhenFilled() {
  const ref = React.useRef<HTMLSpanElement>(null);
  React.useEffect(() => {
    const details = ref.current?.closest('details');
    if (!details || details.open) return;
    const filled = Array.from(details.querySelectorAll('input, textarea')).some((element) => {
      if (element instanceof HTMLTextAreaElement) return element.value.trim() !== '';
      if (!(element instanceof HTMLInputElement)) return false;
      if (element.type === 'checkbox' || element.type === 'radio') return element.checked;
      return element.type !== 'hidden' && element.value.trim() !== '';
    });
    if (filled) details.open = true;
  }, []);
  return <span ref={ref} hidden />;
}
