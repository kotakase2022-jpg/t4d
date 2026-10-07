'use client';

import * as React from 'react';
import { AlertTriangle, Plus } from 'lucide-react';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { withNetworkFallback } from '@/lib/errors/safe-form-action';
import {
  createBlockFormAction,
  type CreateBlockFormState,
  type CreateBlockFormValues,
} from '../blocks/actions';

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
  (_previous, formData, message): CreateBlockFormState => ({
    status: 'error',
    message,
    values: valuesOf(formData),
  }),
);

export interface AddBlockFormProps {
  projectId: string;
  frameworks: Array<{ versionId: string; label: string }>;
  rows: Array<{ id: string; title: string; languageLabel: string }>;
}

/**
 * 節を追加するフォーム（新しい節・翻訳版）。原稿タブの CreatePanel（?new=1）の中に置く
 * （一覧の上に作成フォームを常設しない。plan §1.13）。
 * 必須（基準の版・題名・節のキー）を先に、任意（言語・翻訳元）を後に並べる。言語は日本語が既定。
 * サーバーが断ったとき（キーの重複など）・通信に失敗したときも、題名・キー・言語・翻訳元の入力を残し、
 * 理由を示す。送信中はボタンを止める
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
    <form
      key={generation}
      action={formAction}
      className="grid gap-2 text-small min-[900px]:grid-cols-2"
      aria-describedby={values ? errorId : undefined}
    >
      <input type="hidden" name="projectId" value={projectId} />
      {state.status === 'error' && state.message && (
        <p
          id={errorId}
          role="alert"
          className="flex items-start gap-1 rounded-t4d border border-danger/40 bg-danger-soft px-2 py-1.5 text-small text-ink min-[900px]:col-span-2"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden="true" />
          {state.message}（入力は残っています）
        </p>
      )}
      <Field label="基準の版" id="new-block-framework" required>
        {(control) => (
          <NativeSelect
            {...control}
            name="frameworkVersionId"
            defaultValue={values?.frameworkVersionId || frameworks[0]?.versionId}
          >
            {frameworks.map((f) => (
              <option key={f.versionId} value={f.versionId}>
                {f.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <Field label="題名" id="new-block-title" required>
        {(control) => <Input {...control} name="title" defaultValue={values?.title ?? ''} />}
      </Field>
      <Field
        label="節のキー（半角英小文字・数字・_・-）"
        id="new-block-key"
        required
        hint="例: risk_opportunity。大文字・日本語・空白は使えません。"
      >
        {(control) => (
          <Input
            {...control}
            name="sectionKey"
            maxLength={60}
            pattern={SECTION_KEY_PATTERN}
            defaultValue={values?.sectionKey ?? ''}
            className="font-mono"
          />
        )}
      </Field>
      <Field label="言語" id="new-block-language">
        {(control) => (
          <NativeSelect {...control} name="language" defaultValue={values?.language || 'ja'}>
            <option value="ja">日本語</option>
            <option value="en">英語</option>
          </NativeSelect>
        )}
      </Field>
      <Field
        label="翻訳元の節（翻訳版を作る場合）"
        id="new-block-translation"
        className="min-[900px]:col-span-2"
      >
        {(control) => (
          <NativeSelect
            {...control}
            name="translationOfBlockId"
            defaultValue={values?.translationOfBlockId ?? ''}
          >
            <option value="">翻訳版ではない</option>
            {rows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.title}（{row.languageLabel}）
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <div className="min-[900px]:col-span-2">
        <SubmitButton
          size="sm"
          variant="primary"
          pendingLabel="追加中…"
          icon={<Plus aria-hidden="true" />}
        >
          節を追加
        </SubmitButton>
      </div>
    </form>
  );
}
