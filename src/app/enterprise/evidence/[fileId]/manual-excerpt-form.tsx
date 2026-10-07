'use client';

import * as React from 'react';
import { Quote } from 'lucide-react';
import { ActionResult } from '@/components/shared/notice';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { MANUAL_EXCERPT_MAX_LENGTH } from '@/lib/domain/evidence-limits';
import { withNetworkFallback } from '@/lib/errors/safe-form-action';
import { addManualExcerptFormAction, type ManualExcerptFormState } from '../actions';

const INITIAL: ManualExcerptFormState = {
  status: 'idle',
  message: null,
  values: { page: '', locator: '', text: '' },
};

/** 通信そのものが失敗しても（接続断・502）エラー境界で画面ごと置き換えず、手で写した文言を残す */
const action = withNetworkFallback(
  addManualExcerptFormAction,
  (_previous, formData, message): ManualExcerptFormState => ({
    status: 'error',
    message,
    values: {
      page: String(formData.get('page') ?? ''),
      locator: String(formData.get('locator') ?? ''),
      text: String(formData.get('text') ?? ''),
    },
  }),
);

/**
 * 手動抜粋の入力。上限の文字数を入力欄にも持たせ、残りの文字数を示す。
 * 保存に失敗しても、手で写した文言・ページ・位置は消さない（サーバーが入力値を返す）。
 */
export function ManualExcerptForm({ fileId }: { fileId: string }) {
  const [state, formAction] = React.useActionState(action, INITIAL);
  const [text, setText] = React.useState('');
  const [page, setPage] = React.useState('');
  const [locator, setLocator] = React.useState('');

  // 失敗して戻ってきたら、送った値を入力欄へ戻す（送信後にフォームが初期化されても消えない）
  React.useEffect(() => {
    if (state.status !== 'error') return;
    setText(state.values.text);
    setPage(state.values.page);
    setLocator(state.values.locator);
  }, [state]);

  const remaining = MANUAL_EXCERPT_MAX_LENGTH - text.length;
  const errorId = 'mx-error';
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="fileId" value={fileId} />
      <p className="text-small text-ink-muted">
        テキストを抽出できないページ（画像の PDF など）は、該当箇所の文言を手で写して登録します。
        OCR は行いません。登録した抜粋は「手動の抜粋」として区別され、定性情報の根拠に引用できます。
      </p>
      {state.status === 'error' && state.message && (
        <ActionResult
          id={errorId}
          state={{ status: 'error', message: `${state.message}（入力は残っています）` }}
        />
      )}
      <div className="grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)]">
        <Field label="ページ" id="mx-page" name="page">
          {(p) => (
            <Input
              {...p}
              name="page"
              type="number"
              min={1}
              step={1}
              value={page}
              onChange={(e) => setPage(e.target.value)}
            />
          )}
        </Field>
        <Field label="位置（見出し・段落・表など）" id="mx-locator" name="locator">
          {(p) => (
            <Input
              {...p}
              name="locator"
              placeholder="例: 第2章 2.1 第1段落／表3 の注記"
              value={locator}
              onChange={(e) => setLocator(e.target.value)}
            />
          )}
        </Field>
      </div>
      <Field
        label={`抜粋する文言（${MANUAL_EXCERPT_MAX_LENGTH} 文字まで）`}
        id="mx-text"
        name="text"
        required
        hint={
          <span className={remaining < 200 ? 'text-warning-ink' : undefined}>
            残り {remaining} 文字
          </span>
        }
      >
        {(p) => (
          <Textarea
            {...p}
            name="text"
            rows={4}
            maxLength={MANUAL_EXCERPT_MAX_LENGTH}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-invalid={state.status === 'error' || undefined}
          />
        )}
      </Field>
      <SubmitButton size="sm" variant="secondary" pendingLabel="保存中…">
        <Quote aria-hidden="true" />
        抜粋を追加
      </SubmitButton>
    </form>
  );
}
