'use client';

import * as React from 'react';
import { useFormStatus } from 'react-dom';
import { AlertTriangle } from 'lucide-react';
import { Button, type ButtonSize, type ButtonVariant } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import { SubmitButton } from '@/components/ui/submit-button';
import type { ConfirmSpec, ServerAction } from '@/lib/ui/actions';
import { cn } from '@/lib/utils';

/**
 * 危険な操作の確認（plan §1.16・§3.2 ConfirmDialog）。確認の 4 方式・window.confirm をこれ 1 つへ寄せる。
 *
 * - 範囲 1 行（scope）は常に本文に出す（閉じない。§10.4「上記の範囲」が指すもの）
 * - 必須チェック（acknowledge）・理由（reason）はブラウザの必須の検証で止め、サーバーも従来どおり検査する
 * - 確定ボタンはダイアログの中の唯一の primary（破壊的なら danger）。キャンセルは ghost
 * - 送信が終わったら閉じる（リダイレクトで同じ画面に戻っても開いたまま残さない）
 *
 * 送り方は 2 通り:
 *  - action: ダイアログの中のフォームで送る（単票の操作）
 *  - formId: 画面にある別のフォーム（一括操作の選択行を持つフォーム）を、ダイアログの確定ボタンで送る
 */
export interface ConfirmDialogProps extends ConfirmSpec {
  action?: ServerAction;
  /** 既存のフォームを送るとき（一括操作）。理由欄・確定ボタンが form= でそのフォームに属する */
  formId?: string;
  /** 確定ボタンの name・value（一括操作で to=approved のように操作を区別する） */
  submitter?: { name: string; value: string };
  /** 既存のフォームを送るとき、確定ボタンだけ別の送信先にする（formAction） */
  formAction?: ServerAction;
  /** 隠し項目（action のときだけ） */
  fields?: Record<string, string>;
  /** 同じ名前で複数の値を送る隠し項目（例: ids） */
  multiFields?: Record<string, readonly string[]>;
  /** 画面に置くボタン。省略時は open/onOpenChange で開閉する（メニューの項目から開くとき） */
  trigger?: {
    label: string;
    variant?: ButtonVariant;
    size?: ButtonSize;
    icon?: React.ReactNode;
    disabled?: boolean;
    /** テストの目印 */
    actionId?: string;
    /** キーボードの近道（data-t4d-shortcut。'new' は n キー） */
    shortcut?: 'new';
  };
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 最初から開いて描く（例: パレットから ?confirm= で来たとき） */
  defaultOpen?: boolean;
}

/** フォームの送信が終わったら閉じる（pending が true → false になった時点） */
function CloseWhenDone({ onDone }: { onDone: () => void }) {
  const { pending } = useFormStatus();
  const wasPending = React.useRef(false);
  React.useEffect(() => {
    if (pending) wasPending.current = true;
    else if (wasPending.current) {
      wasPending.current = false;
      onDone();
    }
  }, [pending, onDone]);
  return null;
}

export function ConfirmDialog({
  tier,
  title,
  scope,
  consequences,
  acknowledge,
  reason,
  preview,
  confirmLabel,
  destructive,
  extraFields,
  action,
  formId,
  submitter,
  formAction,
  fields,
  multiFields,
  trigger,
  open: openProp,
  onOpenChange,
  defaultOpen = false,
}: ConfirmDialogProps) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultOpen);
  const open = openProp ?? uncontrolled;
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (openProp === undefined) setUncontrolled(next);
      onOpenChange?.(next);
    },
    [onOpenChange, openProp],
  );
  const close = React.useCallback(() => setOpen(false), [setOpen]);
  const danger = destructive ?? tier === 'irreversible';
  const baseId = React.useId();
  const reasonId = `${baseId}-reason`;
  const ackId = `${baseId}-ack`;
  // 既存のフォームを送るときは、入力をそのフォームに属させる
  const formAttr = formId ? { form: formId } : {};

  const body = (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-1.5">
          {danger && <AlertTriangle className="size-4 text-danger" aria-hidden="true" />}
          {title}
        </DialogTitle>
        <DialogDescription data-confirm-scope="">{scope}</DialogDescription>
      </DialogHeader>
      <div className="space-y-2 px-4 py-3 text-small text-ink" data-confirm-tier={tier}>
        {consequences && consequences.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-4">
            {consequences.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        {preview}
        {extraFields}
        {reason && (
          <div className="space-y-1">
            <label htmlFor={reasonId} className="flex items-center gap-1.5 font-medium">
              {reason.label}
              <span className="text-caption font-normal text-ink-muted">
                {reason.required ? '（必須）' : '（任意）'}
              </span>
            </label>
            <Textarea
              id={reasonId}
              name={reason.name}
              required={reason.required}
              placeholder={reason.placeholder}
              rows={3}
              {...formAttr}
            />
          </div>
        )}
        {acknowledge && (
          <label htmlFor={ackId} className="flex items-center gap-1.5">
            <NativeCheckbox id={ackId} name={acknowledge.name} required {...formAttr} />
            {acknowledge.label}
          </label>
        )}
        {!formId &&
          Object.entries(fields ?? {}).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
        {Object.entries(multiFields ?? {}).flatMap(([name, values]) =>
          values.map((value) => (
            <input key={`${name}-${value}`} type="hidden" name={name} value={value} {...formAttr} />
          )),
        )}
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="ghost" size="sm">
            キャンセル
          </Button>
        </DialogClose>
        <SubmitButton
          variant={danger ? 'danger' : 'primary'}
          size="sm"
          data-confirm-submit=""
          name={submitter?.name}
          value={submitter?.value}
          formAction={formId ? formAction : undefined}
          {...formAttr}
          onClick={
            formId
              ? (event: React.MouseEvent<HTMLButtonElement>) => {
                  // 別のフォームを送るときは、そのフォームの送信の完了を待たずに閉じる
                  // （送信の状態は送ったフォームの側にあり、ここからは見えないため）。
                  // 必須の理由が空など、ブラウザが送信を止めるときは閉じない（入力を失わせない）
                  const form = event.currentTarget.form;
                  if (!form || form.checkValidity()) window.setTimeout(close, 0);
                }
              : undefined
          }
        >
          {confirmLabel}
        </SubmitButton>
      </DialogFooter>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && (
        <DialogTrigger asChild>
          <Button
            variant={trigger.variant ?? 'secondary'}
            size={trigger.size ?? 'sm'}
            disabled={trigger.disabled}
            data-action-id={trigger.actionId}
            data-t4d-shortcut={trigger.shortcut}
          >
            {trigger.icon}
            {trigger.label}
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className={cn('max-w-md')}>
        {formId ? (
          body
        ) : (
          <form action={action}>
            {body}
            <CloseWhenDone onDone={close} />
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
