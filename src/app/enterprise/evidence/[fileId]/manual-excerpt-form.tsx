'use client';

import * as React from 'react';
import { AlertTriangle, Quote } from 'lucide-react';
import { Input, Textarea } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { MANUAL_EXCERPT_MAX_LENGTH } from '@/lib/domain/evidence-limits';
import { NETWORK_ERROR_MESSAGE, withNetworkFallback } from '@/lib/errors/safe-form-action';
import { addManualExcerptFormAction, type ManualExcerptFormState } from '../actions';

const INITIAL: ManualExcerptFormState = {
  status: 'idle',
  message: null,
  values: { page: '', locator: '', text: '' },
};

/** 通信そのものが失敗しても（接続断・502）エラー境界で画面ごと置き換えず、手で写した文言を残す */
const action = withNetworkFallback(
  addManualExcerptFormAction,
  (_previous, formData): ManualExcerptFormState => ({
    status: 'error',
    message: NETWORK_ERROR_MESSAGE,
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
    <form action={formAction} className="space-y-2 px-3 pb-3">
      <input type="hidden" name="fileId" value={fileId} />
      <p className="text-[12px] text-ink-muted">
        テキストを抽出できないページ（画像の PDF など）は、該当箇所の文言を手で写して登録します。
        OCR は行いません。登録した抜粋は「手動の抜粋」として区別され、定性情報の根拠に引用できます。
      </p>
      {state.status === 'error' && state.message && (
        <p
          id={errorId}
          role="alert"
          className="flex items-start gap-1 rounded-t4d border border-danger/40 bg-danger-soft px-2 py-1.5 text-[12px] text-ink"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden="true" />
          {state.message}（入力は残っています）
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)]">
        <div>
          <label htmlFor="mx-page" className="block text-[12px] text-ink">
            ページ
          </label>
          <Input
            id="mx-page"
            name="page"
            type="number"
            min={1}
            step={1}
            value={page}
            onChange={(e) => setPage(e.target.value)}
            className="mt-0.5"
          />
        </div>
        <div>
          <label htmlFor="mx-locator" className="block text-[12px] text-ink">
            位置（見出し・段落・表など）
          </label>
          <Input
            id="mx-locator"
            name="locator"
            placeholder="例: 第2章 2.1 第1段落／表3 の注記"
            value={locator}
            onChange={(e) => setLocator(e.target.value)}
            className="mt-0.5"
          />
        </div>
      </div>
      <div>
        <label htmlFor="mx-text" className="block text-[12px] text-ink">
          抜粋する文言（必須・{MANUAL_EXCERPT_MAX_LENGTH} 文字まで）
        </label>
        <Textarea
          id="mx-text"
          name="text"
          rows={4}
          required
          maxLength={MANUAL_EXCERPT_MAX_LENGTH}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-describedby="mx-count"
          aria-invalid={state.status === 'error' || undefined}
          className="mt-0.5"
        />
        <p
          id="mx-count"
          className={`mt-0.5 text-[11px] ${remaining < 200 ? 'text-[#8a5d00]' : 'text-ink-muted'}`}
        >
          残り {remaining} 文字
        </p>
      </div>
      <SubmitButton size="sm" variant="outline" pendingLabel="保存中…">
        <Quote aria-hidden="true" />
        抜粋を追加
      </SubmitButton>
    </form>
  );
}
