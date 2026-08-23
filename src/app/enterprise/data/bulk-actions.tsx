'use client';

import * as React from 'react';
import { Check, Send, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { bulkTransitionAction, type BulkTransitionState } from '../actions';

/**
 * 一括操作バー（指示書 15.2 Bulk Submit 等）。
 * 選択チェックボックスは一覧側にあり、`form="bulk-form"` でこのフォームへ束ねている。
 *
 * 一括操作は 1 件ずつ状態遷移と権限を検査するため、**部分的に失敗する**。
 * 結果を表示しないと「押しても何も起きない」ように見えるので、
 * 成功件数と失敗理由を必ず返して出す。
 */
export function BulkActionBar({
  canWrite,
  canApprove,
}: {
  canWrite: boolean;
  canApprove: boolean;
}) {
  const [count, setCount] = React.useState(0);
  const [state, formAction, pending] = React.useActionState<BulkTransitionState | null, FormData>(
    bulkTransitionAction,
    null,
  );

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

  const disabled = count === 0 || pending;

  return (
    <div className="mt-2">
      <form
        id="bulk-form"
        action={formAction}
        className="flex items-center gap-2 rounded-t4d-lg border border-line bg-surface px-3 py-2"
      >
        <span className="text-[12px] text-ink-muted" aria-live="polite">
          {count} 件を選択中
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {canWrite && (
            <Button
              type="submit"
              name="to"
              value="submitted"
              size="sm"
              variant="outline"
              disabled={disabled}
            >
              <Send aria-hidden="true" />
              一括提出
            </Button>
          )}
          {canApprove && (
            <>
              <Button
                type="submit"
                name="to"
                value="in_review"
                size="sm"
                variant="outline"
                disabled={disabled}
              >
                レビューへ
              </Button>
              <Button
                type="submit"
                name="to"
                value="returned"
                size="sm"
                variant="outline"
                disabled={disabled}
              >
                <Undo2 aria-hidden="true" />
                差戻し
              </Button>
              <Button type="submit" name="to" value="approved" size="sm" disabled={disabled}>
                <Check aria-hidden="true" />
                一括承認
              </Button>
            </>
          )}
        </div>
      </form>

      {state && (
        <p
          role="status"
          aria-live="polite"
          className={
            state.failures.length > 0
              ? 'mt-1.5 rounded-t4d border border-warning/40 bg-warning-soft px-3 py-1.5 text-[12px] text-ink'
              : 'mt-1.5 px-3 py-1.5 text-[12px] text-ink-muted'
          }
        >
          {state.message}
        </p>
      )}
    </div>
  );
}
