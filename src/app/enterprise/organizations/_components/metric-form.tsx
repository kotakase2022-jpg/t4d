import * as React from 'react';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input, Textarea } from '@/components/ui/input';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import { NativeSelect } from '@/components/ui/native-select';
import {
  AGGREGATION_METHOD_LABEL,
  MATERIALITY_LABEL,
  METRIC_CATEGORY_LABEL,
  METRIC_DATA_TYPE_LABEL,
} from '@/lib/domain/metrics';
import {
  AGGREGATION_METHODS,
  METRIC_CATEGORIES,
  METRIC_DATA_TYPES,
  type MetricDefinition,
} from '@/types/domain';
import { OpenWhenFilled } from './open-when-filled';

/**
 * 指標マスターの入力欄（専用ページ。plan §2 S10・§1.13）。19 項目をモーダルに詰めず、
 * 必須の節（基本）を先頭に、残りを任意の節（既定で閉じる。値があれば開く）に分ける。
 * フォーム（PreservingForm）と送信ボタンはページが置く。
 *
 * 選択肢はドメインの表示名（一覧と同じ語）から作る。以前のダイアログは分類の選択肢に
 * 「気候関連の財務影響」が無く、その分類の指標を編集すると「温室効果ガス」に化けていた。
 */

const FREQUENCY_LABEL: Record<MetricDefinition['reportingFrequency'], string> = {
  annual: '年次',
  quarterly: '四半期',
  monthly: '月次',
};

/** 前年変動許容の表示（整数へ丸めると、再保存のたびに値が変わってしまう） */
function yoyPercentText(ratio: number | null | undefined): string {
  return ratio == null ? '' : String(Number((ratio * 100).toFixed(4)));
}

export function MetricFormFields({
  metric,
  metricCodes,
}: {
  /** 編集のときの指標（新規は無し） */
  metric?: MetricDefinition;
  /** 分子・分母の候補（コードを覚えさせない。plan §1.9） */
  metricCodes: readonly { code: string; name: string }[];
}) {
  const editing = Boolean(metric);
  const managementOpen = Boolean(
    metric &&
    (metric.description ||
      metric.responsibleDepartment ||
      metric.materiality !== 'medium' ||
      metric.reportingFrequency !== 'annual' ||
      metric.requiresEvidence),
  );
  const aggregationOpen = Boolean(
    metric &&
    (metric.aggregationMethod !== 'sum' ||
      (metric.baseUnit && metric.baseUnit !== metric.unit) ||
      metric.hqOnly),
  );
  const validationOpen = Boolean(
    metric &&
    (metric.yoyWarningRatio !== null || metric.minValue !== null || metric.maxValue !== null),
  );
  const formulaOpen = Boolean(
    metric && (metric.numeratorMetricCode || metric.denominatorMetricCode || metric.formula),
  );

  return (
    <div className="space-y-3">
      {metric && <input type="hidden" name="metricId" value={metric.id} />}

      <FormSection title="基本" kind="required">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            label="指標コード"
            name="code"
            required
            hint={
              editing
                ? 'コードは変えられません（データ・取込・開示の紐付けに使うため）'
                : '英小文字・数字・_ で書きます（例: water_withdrawal）'
            }
          >
            {(p) => (
              <Input
                {...p}
                name="code"
                defaultValue={metric?.code}
                readOnly={editing}
                autoComplete="off"
              />
            )}
          </Field>
          <Field label="指標名" name="name" required className="lg:col-span-2">
            {(p) => <Input {...p} name="name" defaultValue={metric?.name} />}
          </Field>
          <Field label="単位" name="unit" required>
            {(p) => (
              <Input {...p} name="unit" defaultValue={metric?.unit} placeholder="例: t-CO2e" />
            )}
          </Field>
          <Field label="分類" name="category" required>
            {(p) => (
              <NativeSelect {...p} name="category" defaultValue={metric?.category ?? 'ghg'}>
                {METRIC_CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {METRIC_CATEGORY_LABEL[value]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="データ型" name="dataType" required>
            {(p) => (
              <NativeSelect {...p} name="dataType" defaultValue={metric?.dataType ?? 'number'}>
                {METRIC_DATA_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {METRIC_DATA_TYPE_LABEL[value]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        </div>
      </FormSection>

      <FormSection
        title="定義と管理"
        kind="optional"
        open={managementOpen || undefined}
        description="定義・責任部署・重要度・報告頻度・根拠資料の要否"
      >
        <OpenWhenFilled />
        <Field label="定義" name="description">
          {(p) => (
            <Textarea {...p} name="description" rows={2} defaultValue={metric?.description} />
          )}
        </Field>
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="責任部署" name="responsibleDepartment">
            {(p) => (
              <Input
                {...p}
                name="responsibleDepartment"
                defaultValue={metric?.responsibleDepartment ?? ''}
              />
            )}
          </Field>
          <Field label="重要度" name="materiality">
            {(p) => (
              <NativeSelect
                {...p}
                name="materiality"
                defaultValue={metric?.materiality ?? 'medium'}
              >
                {(['high', 'medium', 'low'] as const).map((value) => (
                  <option key={value} value={value}>
                    {MATERIALITY_LABEL[value]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="報告頻度" name="reportingFrequency">
            {(p) => (
              <NativeSelect
                {...p}
                name="reportingFrequency"
                defaultValue={metric?.reportingFrequency ?? 'annual'}
              >
                {(['annual', 'quarterly', 'monthly'] as const).map((value) => (
                  <option key={value} value={value}>
                    {FREQUENCY_LABEL[value]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        </div>
        <NativeCheckbox
          name="requiresEvidence"
          defaultChecked={metric?.requiresEvidence ?? false}
          label="根拠資料の添付を必須にする"
        />
      </FormSection>

      <FormSection
        title="集計"
        kind="optional"
        open={aggregationOpen || undefined}
        description="拠点の値のまとめ方・換算の基準単位・本社だけで集めるか"
      >
        <OpenWhenFilled />
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="集計方法" name="aggregationMethod">
            {(p) => (
              <NativeSelect
                {...p}
                name="aggregationMethod"
                defaultValue={metric?.aggregationMethod ?? 'sum'}
              >
                {AGGREGATION_METHODS.map((value) => (
                  <option key={value} value={value}>
                    {AGGREGATION_METHOD_LABEL[value]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="基準単位（換算用）" name="baseUnit" hint="空欄なら単位と同じ">
            {(p) => <Input {...p} name="baseUnit" defaultValue={metric?.baseUnit} />}
          </Field>
        </div>
        <NativeCheckbox
          name="hqOnly"
          defaultChecked={metric?.hqOnly ?? false}
          label="本社のみで収集する（拠点別に集めない）"
        />
      </FormSection>

      <FormSection
        title="検証"
        kind="optional"
        open={validationOpen || undefined}
        description="前年からの変動・値の範囲の検査。空欄なら判定しません"
      >
        <OpenWhenFilled />
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="前年変動許容（±%）" name="yoyWarningPercent" hint="0 より大きく 1000 以下">
            {(p) => (
              <Input
                {...p}
                name="yoyWarningPercent"
                inputMode="decimal"
                defaultValue={yoyPercentText(metric?.yoyWarningRatio)}
                placeholder="空欄で判定なし"
              />
            )}
          </Field>
          <Field label="下限" name="minValue">
            {(p) => (
              <Input
                {...p}
                name="minValue"
                inputMode="decimal"
                defaultValue={metric?.minValue ?? ''}
                placeholder="空欄で判定なし"
              />
            )}
          </Field>
          <Field label="上限" name="maxValue">
            {(p) => (
              <Input
                {...p}
                name="maxValue"
                inputMode="decimal"
                defaultValue={metric?.maxValue ?? ''}
                placeholder="空欄で判定なし"
              />
            )}
          </Field>
        </div>
      </FormSection>

      <FormSection
        title="計算式"
        kind="optional"
        open={formulaOpen || undefined}
        description="比率の指標は分子・分母の指標を指定します（検証で分子 ≦ 分母を確かめます）"
      >
        <OpenWhenFilled />
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="分子の指標コード（比率のみ）" name="numeratorMetricCode">
            {(p) => (
              <Input
                {...p}
                name="numeratorMetricCode"
                list="metric-code-options"
                defaultValue={metric?.numeratorMetricCode ?? ''}
                placeholder="例 managers_female"
              />
            )}
          </Field>
          <Field label="分母の指標コード（比率のみ）" name="denominatorMetricCode">
            {(p) => (
              <Input
                {...p}
                name="denominatorMetricCode"
                list="metric-code-options"
                defaultValue={metric?.denominatorMetricCode ?? ''}
                placeholder="例 managers_total"
              />
            )}
          </Field>
          <Field label="算定式" name="formula">
            {(p) => (
              <Input
                {...p}
                name="formula"
                defaultValue={metric?.formula ?? ''}
                placeholder="任意"
              />
            )}
          </Field>
        </div>
        <datalist id="metric-code-options">
          {metricCodes.map((option) => (
            <option key={option.code} value={option.code}>
              {option.name}
            </option>
          ))}
        </datalist>
      </FormSection>
    </div>
  );
}
