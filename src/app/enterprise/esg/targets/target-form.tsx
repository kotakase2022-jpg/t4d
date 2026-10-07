'use client';

import { useActionState } from 'react';
import { AlertTriangle, Target } from 'lucide-react';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input, Textarea } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { withNetworkFallback } from '@/lib/errors/safe-form-action';
import { registerKpiTargetAction } from '../actions';
import { INITIAL_KPI_TARGET_FORM_STATE, type KpiTargetFormState } from '../target-form-state';

/** 通信そのものが失敗しても（接続断・502）エラー境界で画面ごと置き換えず、入力を残す */
const registerAction = withNetworkFallback(
  registerKpiTargetAction,
  (previous, formData, message): KpiTargetFormState => {
    const values: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value === 'string' && !key.startsWith('$ACTION')) values[key] = value;
    }
    return { attempt: previous.attempt + 1, message, values };
  },
);

/**
 * KPI 目標の登録・改訂フォーム（plan §2 S24・§1.13）。
 * 15 項目を平らに並べず、必須の節（対象と目標）を先頭に、区分と責任者・方法を任意の節に分ける
 * （任意の節は既定で閉じる。改訂中・値を変えたとき・入力エラーで戻ったときは開いて描く）。
 * 改訂では理由が必須（以前の版を残したまま次の版を足すため）。
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

export function KpiTargetForm({
  metrics,
  members,
  methodologies,
  defaults,
  baseYearSuggestion = null,
  revising,
}: {
  metrics: Array<{ id: string; label: string }>;
  members: Array<{ userId: string; displayName: string }>;
  /** 実績（Data Point）に登録されている算定方法の表記（入力の候補） */
  methodologies: string[];
  defaults: TargetFormDefaults;
  /** 基準年の候補（直近の締めた年度）。新規のときだけ。欄の例と説明に出す */
  baseYearSuggestion?: string | null;
  /** 改訂中の目標（null は新規） */
  revising: { targetKey: string; versionNo: number } | null;
}) {
  const [state, action] = useActionState(registerAction, INITIAL_KPI_TARGET_FORM_STATE);
  const v = (key: keyof TargetFormDefaults) => state.values[key] ?? defaults[key];
  const errorId = 'kpi-target-form-error';
  const failed = state.message !== null;
  // 区分（総量・削減以外）・範囲の説明が入っているとき、改訂中、入力エラーのときは開いて描く
  const kindOpen =
    revising !== null ||
    failed ||
    v('scopeNote') !== '' ||
    v('targetType') === 'intensity' ||
    v('direction') === 'increase';
  const ownerOpen =
    revising !== null || failed || v('methodologyNote') !== '' || v('actualMethodology') !== '';

  return (
    <form
      key={state.attempt}
      action={action}
      className="space-y-3"
      aria-describedby={state.message ? errorId : undefined}
    >
      {state.message && (
        <p
          id={errorId}
          role="alert"
          className="flex items-center gap-1.5 rounded-t4d border border-danger/40 bg-danger-soft px-3 py-1.5 text-small text-ink"
        >
          <AlertTriangle className="size-3.5 shrink-0 text-danger" aria-hidden="true" />
          {state.message}
        </p>
      )}
      <input type="hidden" name="targetKey" value={revising?.targetKey ?? ''} />

      <FormSection title="対象と目標" kind="required">
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="指標" name="metricId" required>
            {(p) => (
              <NativeSelect
                {...p}
                name="metricId"
                defaultValue={v('metricId')}
                disabled={revising !== null}
              >
                <option value="">指標を選ぶ</option>
                {metrics.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          {revising && (
            // 改訂では指標を変えない（disabled の select は送信されないため hidden で送る）
            <input type="hidden" name="metricId" value={v('metricId')} />
          )}
          <Field
            label="対象範囲（境界）"
            name="boundary"
            required
            hint="実績の境界と同じ表記にすると進捗率を計算できます"
          >
            {(p) => <Input {...p} name="boundary" defaultValue={v('boundary')} />}
          </Field>
        </div>
        <div className="grid gap-2 sm:grid-cols-4">
          <Field label="目標年" name="targetYear" required>
            {(p) => (
              <Input {...p} name="targetYear" inputMode="numeric" defaultValue={v('targetYear')} />
            )}
          </Field>
          <Field label="目標値" name="targetValue" required>
            {(p) => (
              <Input
                {...p}
                name="targetValue"
                inputMode="decimal"
                defaultValue={v('targetValue')}
              />
            )}
          </Field>
          <Field
            label="基準年"
            name="baseYear"
            hint={
              baseYearSuggestion
                ? `直近の締めた年度は ${baseYearSuggestion} 年です。基準値とあわせて入れると進捗率が出ます`
                : '基準値とあわせて入れると進捗率が出ます'
            }
          >
            {(p) => (
              <Input
                {...p}
                name="baseYear"
                inputMode="numeric"
                placeholder={baseYearSuggestion ?? undefined}
                defaultValue={v('baseYear')}
              />
            )}
          </Field>
          <Field label="基準値" name="baseValue" hint="空欄なら進捗率を出しません">
            {(p) => (
              <Input {...p} name="baseValue" inputMode="decimal" defaultValue={v('baseValue')} />
            )}
          </Field>
        </div>
      </FormSection>

      {revising && (
        <FormSection title="改訂の理由" kind="required">
          <Field
            label="改訂の理由"
            name="revisionReason"
            required
            hint={`版 ${revising.versionNo} を残したまま版 ${revising.versionNo + 1} を追加します`}
          >
            {(p) => (
              <Textarea
                {...p}
                name="revisionReason"
                rows={2}
                defaultValue={state.values.revisionReason ?? ''}
              />
            )}
          </Field>
        </FormSection>
      )}

      <FormSection
        title="範囲の説明・区分"
        kind="optional"
        open={kindOpen || undefined}
        description="既定は「総量」「削減」です"
      >
        <Field label="対象範囲の説明" name="scopeNote">
          {(p) => <Input {...p} name="scopeNote" defaultValue={v('scopeNote')} />}
        </Field>
        <div className="grid gap-2 sm:grid-cols-2">
          <fieldset className="text-small">
            <legend className="text-small font-medium text-ink">総量／原単位</legend>
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
          <fieldset className="text-small">
            <legend className="text-small font-medium text-ink">方向</legend>
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
        </div>
      </FormSection>

      <FormSection
        title="責任者・算定方法"
        kind="optional"
        open={ownerOpen || undefined}
        description="責任者は登録する人を入れてあります"
      >
        <Field label="責任者" name="ownerUserId">
          {(p) => (
            <NativeSelect {...p} name="ownerUserId" defaultValue={v('ownerUserId')}>
              <option value="">未設定</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.displayName}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="算定方法の注記" name="methodologyNote">
          {(p) => (
            <Textarea {...p} name="methodologyNote" rows={2} defaultValue={v('methodologyNote')} />
          )}
        </Field>
        <Field
          label="前提にした実績の算定方法"
          name="actualMethodology"
          hint="実績の「算定方法」と同じ表記。違えば達成率を出しません"
        >
          {(p) => (
            <Input
              {...p}
              name="actualMethodology"
              list="kpi-actual-methodologies"
              defaultValue={v('actualMethodology')}
              placeholder="例: 実測値の集計"
            />
          )}
        </Field>
        <datalist id="kpi-actual-methodologies">
          {methodologies.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </FormSection>

      <SubmitButton
        variant="primary"
        size="sm"
        pendingLabel="保存中…"
        icon={<Target aria-hidden="true" />}
      >
        {revising ? '改訂した版を追加' : '目標を登録'}
      </SubmitButton>
    </form>
  );
}
