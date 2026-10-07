'use client';

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { IDLE_FORM_STATE, formFailure, type FormActionState } from '@/lib/errors/form-action-state';
import { withNetworkFallback } from '@/lib/errors/safe-form-action';

type Action = (previous: FormActionState, formData: FormData) => Promise<FormActionState>;

/**
 * 送った値をフォームへ戻す（隠し項目・ファイルは戻さない。隠し項目は表示時の値のまま）。
 * 送られなかったチェックボックス・ラジオは外す（未選択で送ったものは未選択に戻す）
 */
export function restoreFormValues(form: HTMLFormElement, values: Array<[string, string]>): void {
  const byName = new Map<string, string[]>();
  for (const [name, value] of values) byName.set(name, [...(byName.get(name) ?? []), value]);
  for (const element of Array.from(form.elements)) {
    if (
      !(element instanceof HTMLInputElement) &&
      !(element instanceof HTMLTextAreaElement) &&
      !(element instanceof HTMLSelectElement)
    ) {
      continue;
    }
    if (!element.name) continue;
    const sent = byName.get(element.name);
    if (element instanceof HTMLInputElement) {
      if (element.type === 'hidden' || element.type === 'file') continue;
      if (element.type === 'checkbox' || element.type === 'radio') {
        element.checked = sent?.includes(element.value) ?? false;
        continue;
      }
    }
    if (sent === undefined) continue;
    if (element instanceof HTMLSelectElement && element.multiple) {
      for (const option of Array.from(element.options))
        option.selected = sent.includes(option.value);
      continue;
    }
    element.value = sent[0] ?? '';
  }
}

/**
 * 条件付きの必須（data-required-if="名前=値1|値2"）を、いまの選択に合わせる。
 * 例: 判断で「重要」「重要でない」を選んだときだけ、根拠を必須にする（送る前にブラウザが止める）
 */
export function syncConditionalRequired(form: HTMLFormElement): void {
  for (const element of Array.from(form.querySelectorAll<HTMLElement>('[data-required-if]'))) {
    const rule = element.dataset.requiredIf ?? '';
    const [name, accepted = ''] = rule.split('=');
    if (!name) continue;
    const field = form.elements.namedItem(name);
    const current =
      field instanceof RadioNodeList
        ? field.value
        : field instanceof HTMLInputElement || field instanceof HTMLSelectElement
          ? field.value
          : '';
    const required = accepted.split('|').includes(current);
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      element.required = required;
    }
  }
}

/**
 * 入力を残したまま理由を示すフォーム（Server Action は FormActionState を返す）。
 *
 * サーバーが断ったとき（入力の誤り・別の操作による更新など）・通信やサーバーの失敗のときも、
 * リダイレクトせずに理由をフォームの上に示し、送った値をフォームへ戻す。成功したら Server Action が
 * リダイレクトする（従来の ?flash= と同じ）。
 *
 * React 19 は Server Action の後にフォームを初期値へ戻す。戻した後に値を入れ直すため、失敗のたびに
 * フォームを作り直し（key）、作り直したフォームへ値を戻す。中身はサーバーが描いた欄のままでよい
 * （欄は defaultValue で描く。React の状態で値を持つ欄はこの仕組みでは戻らない）
 */
export function PreservingForm({
  action,
  children,
  className,
  id,
  'aria-label': ariaLabel,
}: {
  action: Action;
  children: React.ReactNode;
  className?: string;
  id?: string;
  'aria-label'?: string;
}) {
  const wrapped = React.useMemo(
    () =>
      withNetworkFallback(action, (_previous, formData, message) => formFailure(message, formData)),
    [action],
  );
  const [state, formAction] = React.useActionState(wrapped, IDLE_FORM_STATE);
  const [generation, setGeneration] = React.useState(0);
  const formRef = React.useRef<HTMLFormElement>(null);
  const errorId = React.useId();

  React.useEffect(() => {
    if (state.status === 'error') setGeneration((g) => g + 1);
  }, [state]);

  React.useLayoutEffect(() => {
    const form = formRef.current;
    if (!form) return;
    if (state.status === 'error' && state.values) restoreFormValues(form, state.values);
    syncConditionalRequired(form);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 作り直した直後（generation が変わったとき）だけ戻す
  }, [generation]);

  const failed = state.status === 'error' && state.message;
  return (
    <form
      key={generation}
      ref={formRef}
      id={id}
      action={formAction}
      className={className}
      aria-label={ariaLabel}
      aria-describedby={failed ? errorId : undefined}
      onChange={(event) => syncConditionalRequired(event.currentTarget)}
    >
      {failed && (
        <p
          id={errorId}
          role="alert"
          className="flex items-start gap-1.5 rounded-t4d border border-danger/40 bg-danger-soft px-2.5 py-1.5 text-small text-ink"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden="true" />
          <span>{state.message}（入力は残っています）</span>
        </p>
      )}
      {children}
    </form>
  );
}
