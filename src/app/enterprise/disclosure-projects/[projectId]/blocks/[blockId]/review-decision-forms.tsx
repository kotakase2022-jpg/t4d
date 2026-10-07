'use client';

import * as React from 'react';
import { AlertTriangle, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
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
      className="flex items-start gap-1 rounded-t4d border border-danger/40 bg-danger-soft px-2 py-1 text-small text-ink"
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden="true" />
      {message}
    </p>
  );
}

/**
 * 差戻しのフォーム。断られたとき・呼び出しが失敗したときも、書いた理由と選んだ段落を残す
 * （以前は通常のフォームで、失敗すると作り直されて長い理由が消えていた）。
 * 差戻しの理由と対象の段落は必須（plan §1.16: 差戻しは全画面で理由を必須）
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
      className="space-y-1.5"
      aria-describedby={state.message ? errorId : undefined}
    >
      <Hidden {...hidden} />
      <ErrorLine id={errorId} message={state.message} />
      <label className="block text-small text-ink">
        差戻しの対象の段落（必須）
        <NativeSelect
          name="paragraphId"
          required
          defaultValue={state.values.paragraphId}
          className="mt-0.5"
        >
          <option value="" disabled>
            段落を選択
          </option>
          {paragraphs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </NativeSelect>
      </label>
      <label htmlFor="return-reason" className="block text-small text-ink">
        差戻しの理由（必須）
      </label>
      <Textarea
        id="return-reason"
        name="reason"
        rows={3}
        required
        defaultValue={state.values.reason}
      />
      <div className="flex justify-end">
        <SubmitButton
          size="sm"
          variant="primary"
          pendingLabel="差戻し中…"
          icon={<Undo2 aria-hidden="true" />}
        >
          差し戻す
        </SubmitButton>
      </div>
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
      className="space-y-1.5"
      aria-describedby={state.message ? errorId : undefined}
    >
      <Hidden {...hidden} />
      <ErrorLine id={errorId} message={state.message} />
      <label htmlFor="withdraw-reason" className="block text-small text-ink">
        取り下げる理由（任意）
      </label>
      <Textarea id="withdraw-reason" name="reason" rows={2} defaultValue={state.values.reason} />
      <div className="flex justify-end">
        <SubmitButton size="sm" variant="primary" pendingLabel="取下げ中…">
          依頼を取り下げる
        </SubmitButton>
      </div>
    </form>
  );
}

/**
 * 「差し戻す…」（plan §1.15 原稿のレビュー中・最終承認待ちの secondary）。理由と段落を入れる小さなダイアログ。
 * 送信はフォームの状態を返す Action のまま（断られても入力を残す。ダイアログも閉じない）
 */
export function ReturnReviewDialog({
  versionLabel,
  paragraphs,
  ...hidden
}: HiddenFields & { versionLabel: string; paragraphs: Array<{ id: string; label: string }> }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm" data-action-id="return-review">
          <Undo2 aria-hidden="true" />
          差し戻す…
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>この版を差し戻しますか</DialogTitle>
          <DialogDescription data-confirm-scope="">
            {versionLabel} を作成担当へ戻します。対象の段落と理由を記録し、作成担当へ通知します。
          </DialogDescription>
        </DialogHeader>
        <div className="px-4 py-3">
          <ReturnReviewForm paragraphs={paragraphs} {...hidden} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 「依頼を取り下げる…」（依頼した本人。節は下書きに戻り、編集できる） */
export function WithdrawReviewDialog({
  versionLabel,
  ...hidden
}: HiddenFields & { versionLabel: string }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm" data-action-id="withdraw-review">
          依頼を取り下げる…
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>レビュー依頼を取り下げますか</DialogTitle>
          <DialogDescription data-confirm-scope="">
            {versionLabel} のレビュー依頼を取り下げます。節は下書きに戻り、編集できます。
          </DialogDescription>
        </DialogHeader>
        <div className="px-4 py-3">
          <WithdrawReviewForm {...hidden} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
