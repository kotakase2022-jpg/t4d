'use client';

import * as React from 'react';
import { AlertTriangle, Plus } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { NETWORK_ERROR_MESSAGE, withNetworkFallback } from '@/lib/errors/safe-form-action';
import {
  createBlockFormAction,
  type CreateBlockFormState,
  type CreateBlockFormValues,
} from '../blocks/actions';

const selectClass =
  'mt-0.5 h-7 w-full rounded-t4d border border-line bg-surface px-1 text-[12px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

const INITIAL: CreateBlockFormState = { status: 'idle', message: null, values: null };

/** 節のキーの形式（サーバーの createBlock と同じ規則。送る前にブラウザでも確かめる） */
export const SECTION_KEY_PATTERN = '[a-z0-9_\\-]{1,60}';

function valuesOf(formData: FormData): CreateBlockFormValues {
  const get = (key: string) => String(formData.get(key) ?? '');
  return {
    frameworkVersionId: get('frameworkVersionId'),
    language: get('language'),
    title: get('title'),
    sectionKey: get('sectionKey'),
    translationOfBlockId: get('translationOfBlockId'),
  };
}

const action = withNetworkFallback(
  createBlockFormAction,
  (_previous, formData): CreateBlockFormState => ({
    status: 'error',
    message: NETWORK_ERROR_MESSAGE,
    values: valuesOf(formData),
  }),
);

export interface AddBlockFormProps {
  projectId: string;
  frameworks: Array<{ versionId: string; label: string }>;
  rows: Array<{ id: string; title: string; languageLabel: string }>;
}

/**
 * 節を追加するフォーム（新しい節・翻訳版）。
 * サーバーが断ったとき（キーの重複など）・通信に失敗したときも、題名・キー・言語・翻訳元の入力を残し、
 * フォームを開いたまま理由を示す。送信中はボタンを止める
 */
export function AddBlockForm({ projectId, frameworks, rows }: AddBlockFormProps) {
  const [state, formAction] = React.useActionState(action, INITIAL);
  const [generation, setGeneration] = React.useState(0);
  React.useEffect(() => {
    if (state.status === 'error') setGeneration((g) => g + 1);
  }, [state]);
  const values = state.status === 'error' ? state.values : null;
  const errorId = 'new-block-error';

  return (
    <details className="p-3" open={values !== null || undefined}>
      <summary className="flex cursor-pointer items-center gap-1 text-[13px] font-semibold text-ink">
        <Plus className="size-4" aria-hidden="true" />
        節を追加（新しい節・翻訳版）
      </summary>
      <form
        key={generation}
        action={formAction}
        className="mt-2 grid gap-2 text-[12px] min-[900px]:grid-cols-2"
        aria-describedby={values ? errorId : undefined}
      >
        <input type="hidden" name="projectId" value={projectId} />
        {state.status === 'error' && state.message && (
          <p
            id={errorId}
            role="alert"
            className="flex items-start gap-1 rounded-t4d border border-danger/40 bg-danger-soft px-2 py-1.5 text-[12px] text-ink min-[900px]:col-span-2"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden="true" />
            {state.message}（入力は残っています）
          </p>
        )}
        <label className="text-ink">
          基準の版
          <select
            name="frameworkVersionId"
            required
            defaultValue={values?.frameworkVersionId || frameworks[0]?.versionId}
            className={selectClass}
          >
            {frameworks.map((f) => (
              <option key={f.versionId} value={f.versionId}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-ink">
          言語
          <select name="language" defaultValue={values?.language || 'ja'} className={selectClass}>
            <option value="ja">日本語</option>
            <option value="en">英語</option>
          </select>
        </label>
        <label htmlFor="new-block-title" className="text-ink">
          題名
          <Input
            id="new-block-title"
            name="title"
            required
            defaultValue={values?.title ?? ''}
            className="mt-0.5"
          />
        </label>
        <label htmlFor="new-block-key" className="text-ink">
          節のキー（半角英小文字・数字・_・-）
          <Input
            id="new-block-key"
            name="sectionKey"
            required
            maxLength={60}
            pattern={SECTION_KEY_PATTERN}
            title="半角英小文字・数字・_・- の 60 文字以内（例: risk_opportunity）"
            aria-describedby="new-block-key-hint"
            defaultValue={values?.sectionKey ?? ''}
            className="mt-0.5 font-mono"
          />
          <span id="new-block-key-hint" className="mt-0.5 block text-[11px] text-ink-muted">
            例: risk_opportunity。大文字・日本語・空白は使えません。
          </span>
        </label>
        <label className="text-ink min-[900px]:col-span-2">
          翻訳元の節（翻訳版を作る場合）
          <select
            name="translationOfBlockId"
            defaultValue={values?.translationOfBlockId ?? ''}
            className={selectClass}
          >
            <option value="">翻訳版ではない</option>
            {rows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.title}（{row.languageLabel}）
              </option>
            ))}
          </select>
        </label>
        <div className="min-[900px]:col-span-2">
          <SubmitButton size="sm" variant="outline" pendingLabel="追加中…">
            節を追加
          </SubmitButton>
        </div>
      </form>
    </details>
  );
}
