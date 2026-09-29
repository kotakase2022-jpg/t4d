'use client';

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Textarea } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { withNetworkFallback } from '@/lib/errors/safe-form-action';
import {
  returnReviewFormAction,
  withdrawReviewFormAction,
  type ReviewDecisionFormState,
} from '../actions';

const INITIAL: ReviewDecisionFormState = {
  status: 'idle',
  message: null,
  values: { reason: '', paragraphId: '' },
};

/** 呼び出しそのものが失敗しても（通信の失敗・サーバーの例外）、書いた理由と選んだ段落を残す */
const onFailure = (
  _previous: ReviewDecisionFormState,
  formData: FormData,
  message: string,
): ReviewDecisionFormState => ({
  status: 'error',
  message,
  values: {
    reason: String(formData.get('reason') ?? ''),
    paragraphId: String(formData.get('paragraphId') ?? ''),
  },
});

const returnAction = withNetworkFallback(returnReviewFormAction, onFailure);
const withdrawAction = withNetworkFallback(withdrawReviewFormAction, onFailure);

interface HiddenFields {
  projectId: string;
  blockId: string;
  requestId: string;
}

function Hidden({ projectId, blockId, requestId }: HiddenFields) {
  return (
    <>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="blockId" value={blockId} />
      <input type="hidden" name="requestId" value={requestId} />
    </>
  );
}

function ErrorLine({ id, message }: { id: string; message: string | null }) {
  if (!message) return null;
  return (
    <p
      id={id}
      role="alert"
      className="flex items-start gap-1 rounded-t4d border border-danger/40 bg-danger-soft px-2 py-1 text-[12px] text-ink"
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden="true" />
      {message}
    </p>
  );
}

/**
 * 差戻しのフォーム。断られたとき・呼び出しが失敗したときも、書いた理由と選んだ段落を残す
 * （以前は通常のフォームで、失敗すると作り直されて長い理由が消えていた）
 */
export function ReturnReviewForm({
  paragraphs,
  ...hidden
}: HiddenFields & { paragraphs: Array<{ id: string; label: string }> }) {
  const [state, formAction] = React.useActionState(returnAction, INITIAL);
  // 失敗して戻ったら、送った値で入力欄を作り直す（key を変えて defaultValue を入れ替える）
  const attempt = state.status === 'error' ? JSON.stringify(state.values) : 'initial';
  const errorId = `return-error-${hidden.requestId}`;
  return (
    <form
      key={attempt}
      action={formAction}
      className="space-y-1 rounded-t4d border border-line p-2"
      aria-describedby={state.message ? errorId : undefined}
    >
      <Hidden {...hidden} />
      <ErrorLine id={errorId} message={state.message} />
      <label className="block text-[12px] text-ink">
        差戻しの対象の段落（必須）
        <select
          name="paragraphId"
          required
          defaultValue={state.values.paragraphId}
          className="mt-0.5 h-7 w-full rounded-t4d border border-line bg-surface px-1 text-[12px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          <option value="" disabled>
            段落を選択
          </option>
          {paragraphs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor="return-reason" className="block text-[12px] text-ink">
        差戻しの理由（必須）
      </label>
      <Textarea
        id="return-reason"
        name="reason"
        rows={2}
        required
        defaultValue={state.values.reason}
      />
      <SubmitButton size="sm" variant="outline" pendingLabel="差戻し中…">
        差し戻す
      </SubmitButton>
    </form>
  );
}

/** 依頼の取下げ（理由は任意。断られても書いた理由を残す） */
export function WithdrawReviewForm(hidden: HiddenFields) {
  const [state, formAction] = React.useActionState(withdrawAction, INITIAL);
  const attempt = state.status === 'error' ? JSON.stringify(state.values) : 'initial';
  const errorId = `withdraw-error-${hidden.requestId}`;
  return (
    <form
      key={attempt}
      action={formAction}
      className="space-y-1 rounded-t4d border border-line p-2"
      aria-describedby={state.message ? errorId : undefined}
    >
      <Hidden {...hidden} />
      <ErrorLine id={errorId} message={state.message} />
      <label htmlFor="withdraw-reason" className="block text-[12px] text-ink">
        依頼を取り下げて編集に戻る（理由は任意）
      </label>
      <Textarea id="withdraw-reason" name="reason" rows={1} defaultValue={state.values.reason} />
      <SubmitButton size="sm" variant="ghost" pendingLabel="取下げ中…">
        依頼を取り下げる
      </SubmitButton>
    </form>
  );
}
