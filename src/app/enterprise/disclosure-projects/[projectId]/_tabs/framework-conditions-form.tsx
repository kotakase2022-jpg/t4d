'use client';

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
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
}: {
  projectId: string;
  projectFrameworkId: string;
  fields: ConditionFieldView[];
  decided: boolean;
  decidedStatusLabel: string;
  preparationStatus: 'candidate' | 'awaiting_confirmation';
}) {
  const [state, action] = React.useActionState(saveProjectFrameworkFormAction, INITIAL);
  const errorId = `pf-error-${projectFrameworkId}`;
  // 失敗して戻ってきたら、送った値で入力欄を作り直す（key を変えて defaultValue を入れ替える）
  const attempt = state.status === 'error' ? JSON.stringify(state.values) : 'saved';
  const valueOf = (name: string, saved: string) =>
    state.status === 'error' && name in state.values ? (state.values[name] ?? '') : saved;

  return (
    <form action={action} className="space-y-2" key={attempt}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="projectFrameworkId" value={projectFrameworkId} />
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
              <label htmlFor={id} className="block text-[12px] text-ink">
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
                <p id={`${id}-error`} className="text-[11px] text-danger">
                  {fieldError}
                </p>
              )}
              {field.help && (
                <p id={`${id}-help`} className="text-[11px] text-ink-muted">
                  {field.help}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <div>
        <label htmlFor={`prep-${projectFrameworkId}`} className="block text-[12px] text-ink">
          準備の区分
        </label>
        {decided ? (
          <p className="text-[11px] text-ink-muted">
            判断が確定済みのため区分は変わりません（{decidedStatusLabel}
            ）。見直す場合は判断を追記してください。
          </p>
        ) : (
          <select
            id={`prep-${projectFrameworkId}`}
            name="preparationStatus"
            defaultValue={valueOf('preparationStatus', preparationStatus)}
            className="mt-0.5 block h-7 w-full rounded-t4d border border-line bg-surface px-2 text-[13px]"
          >
            <option value="candidate">適用候補</option>
            <option value="awaiting_confirmation">確認待ち</option>
          </select>
        )}
      </div>
      <SubmitButton variant="outline" pendingLabel="保存中…">
        保存して準備を始める
      </SubmitButton>
      <p className="text-[11px] text-ink-muted">
        空欄は「不明」として保存し、0 や対象外とは扱いません。保存しても適用判断は確定しません。
      </p>
    </form>
  );
}
