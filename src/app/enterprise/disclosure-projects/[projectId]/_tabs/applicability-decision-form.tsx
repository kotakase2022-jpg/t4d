'use client';

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Input, Textarea } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { NETWORK_ERROR_MESSAGE, withNetworkFallback } from '@/lib/errors/safe-form-action';
import {
  confirmApplicabilityFormAction,
  type ApplicabilityDecisionFormState,
  type ApplicabilityDecisionValues,
} from '../../actions';

const INITIAL: ApplicabilityDecisionFormState = { status: 'idle', message: null, values: null };

function valuesOf(formData: FormData): ApplicabilityDecisionValues {
  const get = (key: string) => String(formData.get(key) ?? '');
  return {
    applicabilityStatus: get('applicabilityStatus'),
    reason: get('reason'),
    ruleRef: get('ruleRef'),
    confirmedOn: get('confirmedOn'),
    transitionalNote: get('transitionalNote'),
  };
}

const action = withNetworkFallback(
  confirmApplicabilityFormAction,
  (_previous, formData): ApplicabilityDecisionFormState => ({
    status: 'error',
    message: NETWORK_ERROR_MESSAGE,
    values: valuesOf(formData),
  }),
);

/**
 * 適用判断を確定するフォーム。断られたとき・通信に失敗したときも、判断・理由・参照規則・
 * 経過措置の注記を消さずに理由を示す（以前はリダイレクトで入力が消えていた）
 */
export function ApplicabilityDecisionForm({
  projectId,
  projectFrameworkId,
  statusOptions,
  defaultRuleRef,
  today,
}: {
  projectId: string;
  projectFrameworkId: string;
  statusOptions: Array<{ value: string; label: string }>;
  defaultRuleRef: string;
  today: string;
}) {
  const [state, formAction] = React.useActionState(action, INITIAL);
  const [generation, setGeneration] = React.useState(0);
  React.useEffect(() => {
    if (state.status === 'error') setGeneration((g) => g + 1);
  }, [state]);
  const values = state.status === 'error' ? state.values : null;
  const pfId = projectFrameworkId;
  const errorId = `dec-error-${pfId}`;

  return (
    <form
      key={generation}
      action={formAction}
      className="space-y-2"
      aria-describedby={values ? errorId : undefined}
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="projectFrameworkId" value={pfId} />
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
      <div>
        <label htmlFor={`st-${pfId}`} className="block text-[12px] text-ink">
          判断（必須）
        </label>
        <select
          id={`st-${pfId}`}
          name="applicabilityStatus"
          required
          defaultValue={values?.applicabilityStatus ?? ''}
          className="mt-0.5 block h-7 w-full rounded-t4d border border-line bg-surface px-2 text-[13px]"
        >
          <option value="" disabled>
            選択してください
          </option>
          {statusOptions.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`reason-${pfId}`} className="block text-[12px] text-ink">
          判断の理由（必須）
        </label>
        <Textarea
          id={`reason-${pfId}`}
          name="reason"
          rows={3}
          required
          defaultValue={values?.reason ?? ''}
          className="mt-0.5"
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label htmlFor={`rule-${pfId}`} className="block text-[12px] text-ink">
            参照した規則・版（必須）
          </label>
          <Input
            id={`rule-${pfId}`}
            name="ruleRef"
            required
            defaultValue={values?.ruleRef ?? defaultRuleRef}
            className="mt-0.5"
          />
        </div>
        <div>
          <label htmlFor={`on-${pfId}`} className="block text-[12px] text-ink">
            規則を確認した日（必須）
          </label>
          <Input
            id={`on-${pfId}`}
            name="confirmedOn"
            type="date"
            required
            defaultValue={values?.confirmedOn ?? today}
            className="mt-0.5"
          />
        </div>
      </div>
      <div>
        <label htmlFor={`tr-${pfId}`} className="block text-[12px] text-ink">
          経過措置・早期適用（条件・対象条項・年度）
        </label>
        <Textarea
          id={`tr-${pfId}`}
          name="transitionalNote"
          rows={2}
          defaultValue={values?.transitionalNote ?? ''}
          className="mt-0.5"
        />
      </div>
      <SubmitButton pendingLabel="確定中…">適用判断を確定</SubmitButton>
      <p className="text-[11px] text-ink-muted">
        判断者は操作したあなたとして記録されます。確定した判断は書き換えず、見直しは新しい判断として追記します。
      </p>
    </form>
  );
}
