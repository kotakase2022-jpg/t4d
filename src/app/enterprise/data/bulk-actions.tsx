'use client';

import * as React from 'react';
import { Check, Send, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { bulkTransitionAction } from '../actions';

/**
 * 一括操作バー（指示書 15.2 Bulk Submit 等）。
 * 選択チェックボックスは一覧側にあり、`form="bulk-form"` でこのフォームへ束ねている。
 */
export function BulkActionBar() {
  const [count, setCount] = React.useState(0);

  React.useEffect(() => {
    const update = () => {
      const checked = document.querySelectorAll<HTMLInputElement>(
        'input[name="selected"][form="bulk-form"]:checked',
      );
      setCount(checked.length);
    };
    update();
    document.addEventListener('change', update);
    return () => document.removeEventListener('change', update);
  }, []);

  return (
    <form
      id="bulk-form"
      action={bulkTransitionAction}
      className="mt-2 flex items-center gap-2 rounded-t4d-lg border border-line bg-surface px-3 py-2"
    >
      <span className="text-[12px] text-ink-muted" aria-live="polite">
        {count} 件を選択中
      </span>
      <div className="ml-auto flex items-center gap-1.5">
        <Button
          type="submit"
          name="to"
          value="submitted"
          size="sm"
          variant="outline"
          disabled={count === 0}
        >
          <Send aria-hidden="true" />
          一括提出
        </Button>
        <Button
          type="submit"
          name="to"
          value="in_review"
          size="sm"
          variant="outline"
          disabled={count === 0}
        >
          レビューへ
        </Button>
        <Button
          type="submit"
          name="to"
          value="returned"
          size="sm"
          variant="outline"
          disabled={count === 0}
        >
          <Undo2 aria-hidden="true" />
          差戻し
        </Button>
        <Button type="submit" name="to" value="approved" size="sm" disabled={count === 0}>
          <Check aria-hidden="true" />
          一括承認
        </Button>
      </div>
    </form>
  );
}
