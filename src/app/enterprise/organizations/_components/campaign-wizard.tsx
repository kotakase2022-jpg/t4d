'use client';

import * as React from 'react';
import { ArrowLeft, ArrowRight, Send } from 'lucide-react';
import { StepNav, type StepItem } from '@/components/shared/step-nav';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input, Textarea } from '@/components/ui/input';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';

/**
 * 収集キャンペーンの作成（plan §2 S10・§0.3 Wizard: StepNav で「範囲 → 期限・説明」）。
 * 115 のチェックをモーダルに並べていたものを専用ページの 2 段に分ける。
 *
 * - 既定値はページが決める（期間＝ヘッダー、期限＝提出期限、拠点＝連結対象、指標＝前回のキャンペーン）
 * - 両方の段の入力は常にフォームの中にある（hidden で隠すだけ）ので、送ればすべて届く
 * - チェックは DOM を正とする（入力エラーで戻ったとき PreservingForm が DOM に値を戻すため）。件数は DOM から数える
 * - 次へ進む前に、組織と指標を 1 つ以上選んだかを確かめる（サービスも同じ検査をする）
 */

export interface CampaignChoice {
  id: string;
  label: string;
  /** 表示の字下げ（組織の階層） */
  depth?: number;
  /** 群の見出し（指標の分類） */
  group?: string;
}

type Step = 'scope' | 'details';

function countChecked(root: HTMLElement | null, name: string): number {
  return root?.querySelectorAll(`input[type="checkbox"][name="${name}"]:checked`).length ?? 0;
}

function ChoiceGroup({
  legend,
  name,
  choices,
  defaults,
  count,
  onToggleAll,
}: {
  legend: string;
  name: string;
  choices: readonly CampaignChoice[];
  defaults: ReadonlySet<string>;
  count: number;
  onToggleAll: (checked: boolean) => void;
}) {
  let previousGroup: string | undefined;
  return (
    <fieldset className="min-w-0 space-y-1.5 rounded-t4d border border-line p-2">
      <legend className="flex flex-wrap items-center gap-2 px-1 text-small font-medium text-ink">
        {legend}
        <span className="tnum text-caption font-normal text-ink-muted">
          {count} / {choices.length} 件を選択
        </span>
      </legend>
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" size="xs" variant="ghost" onClick={() => onToggleAll(true)}>
          {legend}をすべて選ぶ
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={() => onToggleAll(false)}>
          {legend}をすべて外す
        </Button>
      </div>
      <ul className="max-h-72 space-y-0.5 overflow-y-auto pr-1">
        {choices.map((choice) => {
          const header =
            choice.group && choice.group !== previousGroup ? (
              <li
                key={`group-${choice.group}`}
                className="pt-1 text-caption font-semibold text-ink-muted"
              >
                {choice.group}
              </li>
            ) : null;
          previousGroup = choice.group;
          return (
            <React.Fragment key={choice.id}>
              {header}
              <li style={{ paddingLeft: (choice.depth ?? 0) * 14 }}>
                <NativeCheckbox
                  name={name}
                  value={choice.id}
                  defaultChecked={defaults.has(choice.id)}
                  label={choice.label}
                />
              </li>
            </React.Fragment>
          );
        })}
      </ul>
    </fieldset>
  );
}

export function CampaignWizard({
  periods,
  units,
  metrics,
  defaults,
}: {
  periods: readonly { id: string; label: string }[];
  units: readonly CampaignChoice[];
  metrics: readonly CampaignChoice[];
  defaults: {
    name: string;
    reportingPeriodId: string;
    dueDate: string;
    unitIds: readonly string[];
    metricIds: readonly string[];
  };
}) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [step, setStep] = React.useState<Step>('scope');
  const [counts, setCounts] = React.useState({
    units: defaults.unitIds.length,
    metrics: defaults.metricIds.length,
  });
  const [scopeError, setScopeError] = React.useState<string | null>(null);
  const unitDefaults = React.useMemo(() => new Set(defaults.unitIds), [defaults.unitIds]);
  const metricDefaults = React.useMemo(() => new Set(defaults.metricIds), [defaults.metricIds]);

  const recount = React.useCallback(() => {
    setCounts({
      units: countChecked(rootRef.current, 'unitIds'),
      metrics: countChecked(rootRef.current, 'metricIds'),
    });
  }, []);

  // 入力エラーで戻ったとき（PreservingForm が DOM に値を戻した後）にも件数を合わせる
  React.useEffect(() => {
    recount();
  }, [recount]);

  const toggleAll = (name: string, checked: boolean) => {
    for (const box of rootRef.current?.querySelectorAll<HTMLInputElement>(
      `input[type="checkbox"][name="${name}"]`,
    ) ?? []) {
      box.checked = checked;
    }
    recount();
  };

  const goNext = () => {
    if (counts.units === 0 || counts.metrics === 0) {
      setScopeError(
        counts.units === 0
          ? '対象組織を 1 つ以上選んでください。'
          : '対象指標を 1 つ以上選んでください。',
      );
      return;
    }
    setScopeError(null);
    setStep('details');
  };

  const steps: StepItem[] = [
    {
      key: 'scope',
      label: '範囲（期間・組織・指標）',
      state: step === 'scope' ? 'current' : 'done',
    },
    { key: 'details', label: '期限・説明', state: step === 'details' ? 'current' : 'todo' },
  ];
  const scopeCount = counts.units * counts.metrics;

  return (
    <div ref={rootRef} className="space-y-3" onChange={recount}>
      <StepNav ariaLabel="収集キャンペーンの作成の段階" steps={steps} />

      <div hidden={step !== 'scope'} className="space-y-3" data-campaign-step="scope">
        <FormSection title="範囲" kind="required">
          <Field
            label="対象期間"
            name="reportingPeriodId"
            required
            hint="ヘッダーで選んでいる報告期間を入れてあります"
          >
            {(p) => (
              <NativeSelect
                {...p}
                name="reportingPeriodId"
                defaultValue={defaults.reportingPeriodId}
                className="max-w-sm"
              >
                {periods.map((period) => (
                  <option key={period.id} value={period.id}>
                    {period.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <div className="grid gap-2 lg:grid-cols-2">
            <ChoiceGroup
              legend="対象組織"
              name="unitIds"
              choices={units}
              defaults={unitDefaults}
              count={counts.units}
              onToggleAll={(checked) => toggleAll('unitIds', checked)}
            />
            <ChoiceGroup
              legend="対象指標"
              name="metricIds"
              choices={metrics}
              defaults={metricDefaults}
              count={counts.metrics}
              onToggleAll={(checked) => toggleAll('metricIds', checked)}
            />
          </div>
        </FormSection>
        {scopeError && (
          <p role="alert" className="text-small text-danger">
            {scopeError}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="primary" size="sm" onClick={goNext}>
            次へ（期限・説明）
            <ArrowRight aria-hidden="true" />
          </Button>
          <span className="text-small text-ink-muted" aria-live="polite">
            対象 {counts.units} 組織 × {counts.metrics} 指標 ＝ 収集スコープ {scopeCount} 件
          </span>
        </div>
      </div>

      <div hidden={step !== 'details'} className="space-y-3" data-campaign-step="details">
        <FormSection title="期限・説明" kind="required">
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="キャンペーン名" name="name" required>
              {(p) => <Input {...p} name="name" defaultValue={defaults.name} />}
            </Field>
            <Field
              label="提出期限"
              name="dueDate"
              required
              hint="報告期間の提出期限を入れてあります"
            >
              {(p) => <Input {...p} name="dueDate" type="date" defaultValue={defaults.dueDate} />}
            </Field>
          </div>
          <Field label="説明" name="description" hint="担当者に伝えたいこと（任意）">
            {(p) => <Textarea {...p} name="description" rows={2} />}
          </Field>
        </FormSection>
        <p className="text-small text-ink">
          対象 {counts.units} 組織 × {counts.metrics} 指標 ＝ 収集スコープ{' '}
          <span className="tnum font-semibold">{scopeCount}</span>{' '}
          件。対象の組織ごとに提出のタスクを作ります。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => setStep('scope')}>
            <ArrowLeft aria-hidden="true" />
            範囲に戻る
          </Button>
          <SubmitButton
            variant="primary"
            size="sm"
            icon={<Send aria-hidden="true" />}
            pendingLabel="作成中…"
          >
            作成する
          </SubmitButton>
        </div>
      </div>
    </div>
  );
}
