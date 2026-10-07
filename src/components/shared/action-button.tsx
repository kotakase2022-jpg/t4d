'use client';

import * as React from 'react';
import Link from 'next/link';
import { Button, type ButtonSize, type ButtonVariant } from '@/components/ui/button';
import { SubmitButton } from '@/components/ui/submit-button';
import { Hint } from '@/components/ui/tooltip';
import type { ActionSpec } from '@/lib/ui/actions';
import { ConfirmDialog } from './confirm-dialog';

/**
 * ActionSpec 1 つをボタンとして描く（PageActions・RowActions・節の操作が共通で使う）。
 *
 * - link: リンク（download はファイル。新しいタブにはしない）
 * - submit: 隠し項目付きのフォームと送信ボタン（送信中の表示は SubmitButton）
 * - confirm: 確認ダイアログを開くボタン（plan §1.16）
 * - disabledReason: 押せないボタンとして残し、理由を Hint と読み上げの文で出す（なぜ押せないかが分かる）
 */
export function ActionButton({
  action,
  variant = 'secondary',
  size = 'sm',
}: {
  action: ActionSpec;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  if (action.hidden) return null;
  // n キーの飛び先。押せない操作には付けない（押しても何も起きない近道にしないため）
  const shortcut = action.shortcut && !action.disabledReason ? action.shortcut : undefined;

  if (action.disabledReason) {
    const reasonId = `action-reason-${action.id}`;
    // disabled 属性のボタンはフォーカスもホバーも受けず、理由が届かない。aria-disabled にして
    // フォーカスは受け、押しても何もしない（理由は Hint と読み上げの説明で出す）
    return (
      <>
        <Hint label={action.disabledReason}>
          <Button
            variant={variant}
            size={size}
            aria-disabled="true"
            aria-describedby={reasonId}
            onClick={(event) => event.preventDefault()}
            className="cursor-not-allowed opacity-50"
            data-action-id={action.id}
            data-disabled-reason=""
          >
            {action.icon}
            {action.label}
          </Button>
        </Hint>
        <span id={reasonId} className="sr-only">
          {action.disabledReason}
        </span>
      </>
    );
  }

  if (action.kind === 'link') {
    return (
      <Button
        variant={variant}
        size={size}
        asChild
        data-action-id={action.id}
        data-t4d-shortcut={shortcut}
      >
        {action.download || action.external ? (
          <a href={action.href} download={action.download ? '' : undefined}>
            {action.icon}
            {action.label}
          </a>
        ) : (
          <Link href={action.href}>
            {action.icon}
            {action.label}
          </Link>
        )}
      </Button>
    );
  }

  if (action.kind === 'submit') {
    return (
      <form action={action.action} className="inline-flex">
        {Object.entries(action.fields ?? {}).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <SubmitButton
          variant={variant}
          size={size}
          icon={action.icon}
          pendingLabel={action.pendingLabel}
          data-action-id={action.id}
          data-t4d-shortcut={shortcut}
        >
          {action.label}
        </SubmitButton>
      </form>
    );
  }

  return (
    <ConfirmDialog
      {...action.confirm}
      action={action.action}
      fields={action.fields}
      trigger={{
        label: action.label,
        icon: action.icon,
        variant,
        size,
        actionId: action.id,
        shortcut,
      }}
    />
  );
}
