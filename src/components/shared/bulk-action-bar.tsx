'use client';

import * as React from 'react';
import { SubmitButton } from '@/components/ui/submit-button';
import type { ConfirmSpec, ServerAction } from '@/lib/ui/actions';
import { ConfirmDialog } from './confirm-dialog';

/**
 * 一括操作のバー（plan §1.7・§3.2 BulkActionBar）。行を選んだときだけ表の下端に出る
 * （選択 0 件では描かない。押せない一括ボタンを常に並べない。指示書 §5）。
 *
 * 行の選択は表の側のチェックボックス（`form={formId}`・`name`・`data-t4d-select`・`data-row-status`）。
 * このバーが持つフォーム（id=formId）へ form 属性で束ね、選んだ行がそのまま送られる。
 * 選択行の状態の内訳（data-row-status のラベル）を件数と一緒に出す（何を一括で動かすかが分かる）。
 *
 * 承認・差戻しのような重い一括操作は confirm を付ける（件数と内訳の確認。差戻しは理由必須。§1.16 区分 2）。
 * 一括操作を置くのは、サービスが既に複数件を受ける表だけ（§1.7）。
 */
export interface BulkActionSpec {
  id: string;
  label: string;
  icon?: React.ReactNode;
  /** 送信先。省略時はバーの action（送信ボタンの name・value で操作を区別する） */
  action?: ServerAction;
  /** 送信ボタンの name・value（例: to=approved） */
  submitter?: { name: string; value: string };
  variant?: 'primary' | 'secondary';
  hidden?: boolean;
  confirm?: Omit<ConfirmSpec, 'scope'> & { scope: (count: number, breakdown: string) => string };
}

function selectedBoxes(formId: string, name: string): HTMLInputElement[] {
  return [
    ...document.querySelectorAll<HTMLInputElement>(
      `input[type="checkbox"][data-t4d-select][form="${formId}"][name="${name}"]:checked`,
    ),
  ];
}

/** 選択行の状態の内訳（例「提出済み 3・レビュー中 2」） */
export function selectionBreakdown(statuses: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  return [...counts.entries()].map(([status, n]) => `${status} ${n}`).join('・');
}

export function BulkActionBar({
  formId,
  name = 'selected',
  action,
  actions,
  pending = false,
  children,
}: {
  formId: string;
  /** 行のチェックボックスの name（送られる値の名前） */
  name?: string;
  /** バーのフォームの送信先（各操作が action を持てば省略可） */
  action?: ServerAction;
  actions: readonly BulkActionSpec[];
  /** 送信中（useActionState の pending）。ボタンを止める */
  pending?: boolean;
  /** 結果の表示（成功件数・失敗理由）。選択が 0 件になっても出し続ける */
  children?: React.ReactNode;
}) {
  const [statuses, setStatuses] = React.useState<string[]>([]);

  React.useEffect(() => {
    const update = () =>
      setStatuses(selectedBoxes(formId, name).map((box) => box.dataset.rowStatus ?? '状態不明'));
    update();
    document.addEventListener('change', update);
    return () => document.removeEventListener('change', update);
  }, [formId, name]);

  const count = statuses.length;
  const breakdown = selectionBreakdown(statuses);
  const visible = actions.filter((a) => !a.hidden);

  return (
    <>
      {/* 行のチェックボックスが属するフォーム。選択 0 件でも置いておく（form 属性の行き先） */}
      <form id={formId} action={action} hidden={count === 0} data-bulk-form="">
        {count > 0 && (
          <div
            role="region"
            aria-label="一括操作"
            data-bulk-action-bar=""
            className="sticky bottom-0 z-(--z-sticky) mt-2 flex flex-wrap items-center gap-2 rounded-t4d-lg border border-brand-200 bg-surface px-3 py-2 shadow-raised"
          >
            <span className="text-small text-ink" aria-live="polite">
              <span className="font-semibold">{count} 件</span>を選択中
              {breakdown && <span className="text-ink-muted">（{breakdown}）</span>}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              {visible.map((spec) =>
                spec.confirm ? (
                  <ConfirmDialog
                    key={spec.id}
                    {...spec.confirm}
                    scope={spec.confirm.scope(count, breakdown)}
                    formId={formId}
                    submitter={spec.submitter}
                    formAction={spec.action}
                    trigger={{
                      label: spec.label,
                      icon: spec.icon,
                      variant: spec.variant ?? 'secondary',
                      disabled: pending,
                      actionId: spec.id,
                    }}
                  />
                ) : (
                  <SubmitButton
                    key={spec.id}
                    size="sm"
                    variant={spec.variant ?? 'secondary'}
                    name={spec.submitter?.name}
                    value={spec.submitter?.value}
                    formAction={spec.action}
                    disabled={pending}
                    icon={spec.icon}
                    data-action-id={spec.id}
                  >
                    {spec.label}
                  </SubmitButton>
                ),
              )}
            </div>
          </div>
        )}
      </form>
      {children}
    </>
  );
}
