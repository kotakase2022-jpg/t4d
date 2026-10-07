'use client';

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { withNetworkFallback } from '@/lib/errors/safe-form-action';
import { saveProjectFrameworkFormAction, type FrameworkConditionsFormState } from '../../actions';

export interface ConditionFieldView {
  key: string;
  label: string;
  kind: 'number' | 'text';
  unit?: string;
  help?: string;
  /** 保存済みの値（未入力は空文字） */
  saved: string;
}

const INITIAL: FrameworkConditionsFormState = {
  status: 'idle',
  message: null,
  fieldErrors: {},
  values: {},
};

/** 通信そのものが失敗しても（接続断・502）エラー境界で画面ごと置き換えず、入力した条件を残す */
const action = withNetworkFallback(
  saveProjectFrameworkFormAction,
  (_previous, formData, message): FrameworkConditionsFormState => {
    const values: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value !== 'string') continue;
      if (key.startsWith('condition.') || key === 'preparationStatus') values[key] = value;
    }
    return { status: 'error', message, fieldErrors: {}, values };
  },
);

/**
 * 適用条件（保存して準備を始める）。読めない値があっても、その回に入力した条件を消さず、
 * 項目ごとに理由を示す（以前はページ上部の帯に最初の 1 件だけが出て、入力は保存前の値へ戻っていた）。
 */
export function FrameworkConditionsForm({
  projectId,
  projectFrameworkId,
  fields,
  decided,
  decidedStatusLabel,
  preparationStatus,
  baseUpdatedAt,
}: {
  projectId: string;
  projectFrameworkId: string;
  fields: ConditionFieldView[];
  decided: boolean;
  decidedStatusLabel: string;
  preparationStatus: 'candidate' | 'awaiting_confirmation';
  /** 画面が読み込んだ時点の更新時刻（別の人の保存を黙って上書きしない） */
  baseUpdatedAt: string;
}) {
  const [state, formAction] = React.useActionState(action, INITIAL);
  const errorId = `pf-error-${projectFrameworkId}`;
  const failed = state.status === 'error' || state.status === 'conflict';
  // 失敗して戻ってきたら、送った値で入力欄を作り直す（key を変えて defaultValue を入れ替える）
  const attempt = failed ? JSON.stringify([state.status, state.values]) : 'saved';
  const valueOf = (name: string, saved: string) =>
    failed && name in state.values ? (state.values[name] ?? '') : saved;

  return (
    <form action={formAction} className="space-y-2" key={attempt}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="projectFrameworkId" value={projectFrameworkId} />
      {/* 競合を見た後は最新の時刻を土台にする（「このまま上書き保存」） */}
      <input type="hidden" name="baseUpdatedAt" value={state.baseUpdatedAt ?? baseUpdatedAt} />
      {failed && state.message && (
        <p
          id={errorId}
          role="alert"
          className="flex items-start gap-1 rounded-t4d border border-danger/40 bg-danger-soft px-2 py-1.5 text-small text-ink"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden="true" />
          <span>
            {state.status === 'conflict' ? state.message : `${state.message}（入力は残っています）`}
            {state.status === 'conflict' && (
              <>
                {' '}
                <a
                  href={`/enterprise/disclosure-projects/${projectId}?tab=settings#pf-${projectFrameworkId}`}
                  className="text-brand-800 underline"
                >
                  最新の条件を読み込む
                </a>
              </>
            )}
          </span>
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {fields.map((field) => {
          const id = `c-${projectFrameworkId}-${field.key}`;
          const name = `condition.${field.key}`;
          const fieldError = state.fieldErrors[name];
          const describedBy = [field.help ? `${id}-help` : null, fieldError ? `${id}-error` : null]
            .filter(Boolean)
            .join(' ');
          return (
            <div key={field.key}>
              <label htmlFor={id} className="block text-small text-ink">
                {field.label}
                {field.unit ? `（${field.unit}）` : ''}
              </label>
              <Input
                id={id}
                name={name}
                inputMode={field.kind === 'number' ? 'decimal' : undefined}
                defaultValue={valueOf(name, field.saved)}
                placeholder="未入力（不明）"
                className="mt-0.5"
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={describedBy || undefined}
              />
              {fieldError && (
                <p id={`${id}-error`} className="text-caption text-danger">
                  {fieldError}
                </p>
              )}
              {field.help && (
                <p id={`${id}-help`} className="text-caption text-ink-muted">
                  {field.help}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <div>
        <label htmlFor={`prep-${projectFrameworkId}`} className="block text-small text-ink">
          準備の区分
        </label>
        {decided ? (
          <p className="text-caption text-ink-muted">
            判断が確定済みのため区分は変わりません（{decidedStatusLabel}
            ）。見直す場合は判断を追記してください。
          </p>
        ) : (
          <NativeSelect
            id={`prep-${projectFrameworkId}`}
            name="preparationStatus"
            defaultValue={valueOf('preparationStatus', preparationStatus)}
            className="mt-0.5"
          >
            <option value="candidate">適用候補</option>
            <option value="awaiting_confirmation">確認待ち</option>
          </NativeSelect>
        )}
      </div>
      <SubmitButton variant="secondary" pendingLabel="保存中…">
        {state.status === 'conflict' ? 'このまま上書き保存' : '保存して準備を始める'}
      </SubmitButton>
      <p className="text-caption text-ink-muted">
        空欄は「不明」として保存し、0 や対象外とは扱いません。保存しても適用判断は確定しません。
      </p>
    </form>
  );
}
