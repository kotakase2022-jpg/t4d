'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, MessageSquareWarning } from 'lucide-react';
import { restoreFormValues } from '@/components/shared/preserving-form';
import { Button, type ButtonSize, type ButtonVariant } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { withNetworkFallback } from '@/lib/errors/safe-form-action';
import { statusOptions } from '@/lib/ui/status/registry';
import { submitFeedbackAction } from '../actions';
import {
  FEEDBACK_FIELDS,
  IDLE_FEEDBACK_STATE,
  type FeedbackFormState,
} from '../_lib/feedback-state';

/**
 * 「ご意見・不具合」のダイアログ（トライアル対応 NF-34）。ヘッダー（Stage C が AppShell に取り付ける）と
 * トライアルの評価の改善管理表から開く。
 *
 *  - 入力は 5 項目以下（種類・件名・内容・重大度〔不具合のときだけ〕・関連シナリオ〔一覧を渡したときだけ〕）
 *  - 開いている画面はパス（usePathname）だけを送り、サーバーがルートのパターンにして記録する
 *    （URL の検索条件・ID は記録しない）。環境の版はサーバーが添える
 *  - 送れたら画面を移らず、ダイアログの中で結果と改善管理表へのリンクを示す。断られたら入力を残して理由を示す
 *  - 起動ボタンはアイコン＋文字（アイコンだけにしない）
 */

const KIND_OPTIONS = statusOptions('feedbackKind');
const SEVERITY_OPTIONS = statusOptions('severity');

export const IMPROVEMENT_TABLE_HREF = '/enterprise/trial?tab=feedback';

export interface FeedbackDialogProps {
  /** 関連シナリオの選択肢（渡さなければ欄を出さない） */
  scenarios?: ReadonlyArray<{ id: string; code: string; title: string }>;
  /** 件名・内容の上限（サーバーの検査と同じ値。既定は Demo Mode の上限） */
  titleMaxLength?: number;
  bodyMaxLength?: number;
  triggerLabel?: string;
  triggerVariant?: ButtonVariant;
  triggerSize?: ButtonSize;
}

export function FeedbackDialog({
  scenarios = [],
  titleMaxLength = 60,
  bodyMaxLength = 300,
  triggerLabel = 'ご意見・不具合',
  triggerVariant = 'secondary',
  triggerSize = 'sm',
}: FeedbackDialogProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState<string>('request');
  const action = React.useMemo(
    () =>
      withNetworkFallback(
        submitFeedbackAction,
        (previous: FeedbackFormState, formData: FormData, message: string) => ({
          status: 'error' as const,
          message,
          values: [...formData.entries()].flatMap(([name, value]) =>
            typeof value === 'string' ? [[name, value] as [string, string]] : [],
          ),
          sentTitle: null,
          nonce: previous.nonce,
        }),
      ),
    [],
  );
  const [state, formAction] = React.useActionState(action, IDLE_FEEDBACK_STATE);
  const [generation, setGeneration] = React.useState(0);
  const [showResult, setShowResult] = React.useState(false);
  const formRef = React.useRef<HTMLFormElement>(null);
  const baseId = React.useId();
  const errorId = `${baseId}-error`;

  React.useEffect(() => {
    if (state.status === 'error') {
      setGeneration((g) => g + 1);
      const sentKind = state.values?.find(([name]) => name === FEEDBACK_FIELDS.kind)?.[1];
      if (sentKind) setKind(sentKind);
    }
    if (state.status === 'sent') {
      setShowResult(true);
      setKind('request');
      // 改善管理表を開いているときは一覧に反映する
      router.refresh();
    }
  }, [state, router]);

  React.useLayoutEffect(() => {
    const form = formRef.current;
    if (form && state.status === 'error' && state.values) restoreFormValues(form, state.values);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 作り直した直後（generation が変わったとき）だけ戻す
  }, [generation]);

  const failed = state.status === 'error' && state.message;
  const sent = showResult && state.status === 'sent';

  return (
    <>
      <Button
        variant={triggerVariant}
        size={triggerSize}
        onClick={() => {
          setShowResult(false);
          setOpen(true);
        }}
        data-feedback-trigger=""
      >
        <MessageSquareWarning aria-hidden="true" />
        {triggerLabel}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg" data-feedback-dialog="">
          <DialogHeader>
            <DialogTitle>ご意見・不具合を送る</DialogTitle>
            <DialogDescription>
              改善管理表に登録されます。開いている画面の種類（URL の検索条件・ID
              を除く）と環境の版を自動で添えます。
            </DialogDescription>
          </DialogHeader>
          {sent ? (
            <div className="space-y-2 px-4 py-3" role="status" aria-live="polite">
              <p className="flex items-start gap-1.5 text-small text-ink">
                <CheckCircle2
                  className="mt-0.5 size-3.5 shrink-0 text-success"
                  aria-hidden="true"
                />
                <span>
                  「{state.sentTitle}」を改善管理表に登録しました（状態:
                  未着手）。対応の方針は管理者が記録します。
                </span>
              </p>
              <DialogFooter className="-mx-4 -mb-3 mt-2">
                <Link
                  href={IMPROVEMENT_TABLE_HREF}
                  className="text-small text-brand-700 hover:underline"
                  onClick={() => setOpen(false)}
                >
                  改善管理表を開く
                </Link>
                <Button variant="secondary" size="sm" onClick={() => setShowResult(false)}>
                  続けて送る
                </Button>
                <Button variant="primary" size="sm" onClick={() => setOpen(false)}>
                  完了
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <form
              key={`${generation}-${state.nonce}`}
              ref={formRef}
              action={formAction}
              className="space-y-2 px-4 py-3"
              aria-describedby={failed ? errorId : undefined}
            >
              {failed && (
                <p
                  id={errorId}
                  role="alert"
                  className="flex items-start gap-1.5 rounded-t4d border border-danger/40 bg-danger-soft px-2.5 py-1.5 text-small text-ink"
                >
                  <AlertTriangle
                    className="mt-0.5 size-3.5 shrink-0 text-danger"
                    aria-hidden="true"
                  />
                  <span>{state.message}（入力は残っています）</span>
                </p>
              )}
              <input type="hidden" name={FEEDBACK_FIELDS.route} value={pathname ?? ''} />
              <div className="grid grid-cols-2 gap-2">
                <Field label="種類" id={`${baseId}-kind`} required>
                  {(p) => (
                    <NativeSelect
                      {...p}
                      name={FEEDBACK_FIELDS.kind}
                      defaultValue={kind}
                      onChange={(event) => setKind(event.currentTarget.value)}
                    >
                      {KIND_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
                {kind === 'defect' ? (
                  <Field
                    label="重大度"
                    id={`${baseId}-severity`}
                    hint="業務を止める不具合は「重大」"
                  >
                    {(p) => (
                      <NativeSelect {...p} name={FEEDBACK_FIELDS.severity} defaultValue="">
                        <option value="">未選択</option>
                        {SEVERITY_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </Field>
                ) : (
                  <div aria-hidden="true" />
                )}
              </div>
              <Field label="件名" id={`${baseId}-title`} required hint={`${titleMaxLength} 字以内`}>
                {(p) => <Input {...p} name={FEEDBACK_FIELDS.title} maxLength={titleMaxLength} />}
              </Field>
              <Field label="内容" id={`${baseId}-body`} hint={`${bodyMaxLength} 字以内`}>
                {(p) => (
                  <Textarea {...p} name={FEEDBACK_FIELDS.body} rows={3} maxLength={bodyMaxLength} />
                )}
              </Field>
              {scenarios.length > 0 && (
                <Field label="関連するシナリオ" id={`${baseId}-scenario`}>
                  {(p) => (
                    <NativeSelect {...p} name={FEEDBACK_FIELDS.scenarioId} defaultValue="">
                      <option value="">指定しない</option>
                      {scenarios.map((scenario) => (
                        <option key={scenario.id} value={scenario.id}>
                          {scenario.code} {scenario.title}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
              )}
              <DialogFooter className="-mx-4 -mb-3 mt-2">
                <Button variant="ghost" size="sm" type="button" onClick={() => setOpen(false)}>
                  キャンセル
                </Button>
                <SubmitButton variant="primary" size="sm" pendingLabel="送信中…">
                  送る
                </SubmitButton>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
