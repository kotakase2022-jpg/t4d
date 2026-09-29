'use client';

import { useActionState } from 'react';
import { AlertTriangle, Target } from 'lucide-react';
import { Input, Textarea } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { registerKpiTargetAction } from '../actions';
import { INITIAL_KPI_TARGET_FORM_STATE } from '../target-form-state';

/**
 * KPI 目標の登録・改訂フォーム。
 * 保存に失敗しても入力を失わないよう、失敗時は返ってきた入力値でフォームを作り直す。
 */

export interface TargetFormDefaults {
  targetKey: string;
  metricId: string;
  boundary: string;
  scopeNote: string;
  baseYear: string;
  baseValue: string;
  targetYear: string;
  targetValue: string;
  targetType: string;
  direction: string;
  methodologyNote: string;
  actualMethodology: string;
  ownerUserId: string;
}

const fieldClass = 'block text-[11px] text-ink-muted';
const selectClass =
  'mt-0.5 h-7 w-full rounded-t4d border border-line bg-surface px-2 text-[12px] text-ink focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-100';

export function KpiTargetForm({
  metrics,
  members,
  methodologies,
  defaults,
  revising,
}: {
  metrics: Array<{ id: string; label: string }>;
  members: Array<{ userId: string; displayName: string }>;
  /** 実績（Data Point）に登録されている算定方法の表記（入力の候補） */
  methodologies: string[];
  defaults: TargetFormDefaults;
  /** 改訂中の目標（null は新規） */
  revising: { targetKey: string; versionNo: number } | null;
}) {
  const [state, action] = useActionState(registerKpiTargetAction, INITIAL_KPI_TARGET_FORM_STATE);
  const v = (key: keyof TargetFormDefaults) => state.values[key] ?? defaults[key];
  const errorId = 'kpi-target-form-error';

  return (
    <form
      key={state.attempt}
      action={action}
      className="space-y-2"
      aria-describedby={state.message ? errorId : undefined}
    >
      {state.message && (
        <p
          id={errorId}
          role="alert"
          className="flex items-center gap-1.5 rounded-t4d border border-danger/40 bg-danger-soft px-3 py-1.5 text-[12px] text-ink"
        >
          <AlertTriangle className="size-3.5 shrink-0 text-danger" aria-hidden="true" />
          {state.message}
        </p>
      )}
      <input type="hidden" name="targetKey" value={revising?.targetKey ?? ''} />

      <div className="grid gap-2 sm:grid-cols-2">
        <label className={fieldClass}>
          指標
          <select
            name="metricId"
            required
            defaultValue={v('metricId')}
            className={selectClass}
            disabled={revising !== null}
          >
            <option value="">選択してください</option>
            {metrics.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {revising && (
            // 改訂では指標を変えない（disabled の select は送信されないため hidden で送る）
            <input type="hidden" name="metricId" value={v('metricId')} />
          )}
        </label>
        <label className={fieldClass}>
          対象範囲（境界。実績の境界と同じ表記にすると進捗率を計算できます）
          <Input name="boundary" required defaultValue={v('boundary')} className="mt-0.5" />
        </label>
      </div>
      <label className={fieldClass}>
        対象範囲の説明
        <Input name="scopeNote" defaultValue={v('scopeNote')} className="mt-0.5" />
      </label>

      <div className="grid gap-2 sm:grid-cols-4">
        <label className={fieldClass}>
          基準年
          <Input
            name="baseYear"
            inputMode="numeric"
            defaultValue={v('baseYear')}
            className="mt-0.5"
          />
        </label>
        <label className={fieldClass}>
          基準値
          <Input
            name="baseValue"
            inputMode="decimal"
            defaultValue={v('baseValue')}
            className="mt-0.5"
          />
        </label>
        <label className={fieldClass}>
          目標年
          <Input
            name="targetYear"
            required
            inputMode="numeric"
            defaultValue={v('targetYear')}
            className="mt-0.5"
          />
        </label>
        <label className={fieldClass}>
          目標値
          <Input
            name="targetValue"
            required
            inputMode="decimal"
            defaultValue={v('targetValue')}
            className="mt-0.5"
          />
        </label>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <fieldset className="text-[12px]">
          <legend className="text-[11px] text-ink-muted">総量／原単位</legend>
          <label className="mr-3 inline-flex items-center gap-1">
            <input
              type="radio"
              name="targetType"
              value="absolute"
              defaultChecked={v('targetType') !== 'intensity'}
            />
            総量
          </label>
          <label className="inline-flex items-center gap-1">
            <input
              type="radio"
              name="targetType"
              value="intensity"
              defaultChecked={v('targetType') === 'intensity'}
            />
            原単位
          </label>
        </fieldset>
        <fieldset className="text-[12px]">
          <legend className="text-[11px] text-ink-muted">方向</legend>
          <label className="mr-3 inline-flex items-center gap-1">
            <input
              type="radio"
              name="direction"
              value="reduce"
              defaultChecked={v('direction') !== 'increase'}
            />
            削減
          </label>
          <label className="inline-flex items-center gap-1">
            <input
              type="radio"
              name="direction"
              value="increase"
              defaultChecked={v('direction') === 'increase'}
            />
            増加
          </label>
        </fieldset>
        <label className={fieldClass}>
          責任者
          <select name="ownerUserId" defaultValue={v('ownerUserId')} className={selectClass}>
            <option value="">未設定</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className={fieldClass}>
        算定方法の注記
        <Textarea
          name="methodologyNote"
          rows={2}
          defaultValue={v('methodologyNote')}
          className="mt-0.5"
        />
      </label>
      <label className={fieldClass}>
        前提にした実績の算定方法（実績の「算定方法」と同じ表記。違えば達成率を出しません）
        <Input
          name="actualMethodology"
          list="kpi-actual-methodologies"
          defaultValue={v('actualMethodology')}
          placeholder="例: 実測値の集計"
          className="mt-0.5"
        />
        <datalist id="kpi-actual-methodologies">
          {methodologies.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>

      {revising && (
        <label className={fieldClass}>
          改訂の理由（必須。版 {revising.versionNo} を残したまま版 {revising.versionNo + 1}{' '}
          を追加します）
          <Textarea
            name="revisionReason"
            rows={2}
            required
            defaultValue={state.values.revisionReason ?? ''}
            className="mt-0.5"
          />
        </label>
      )}

      <SubmitButton size="sm" pendingLabel="保存中…" icon={<Target aria-hidden="true" />}>
        {revising ? '改訂した版を追加' : '目標を登録'}
      </SubmitButton>
    </form>
  );
}
