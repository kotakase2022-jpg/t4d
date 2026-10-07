'use client';

import * as React from 'react';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import type { ServerAction } from '@/lib/ui/actions';

/**
 * 対象判定・重要性判断のフォーム（plan §2 S9）。
 *
 * - 必須: 適用区分・重要性（先頭の節）
 * - 条件付き: 「対象外とする理由」「重要性なしとする理由」は、該当を選んだときだけ出す
 *   （選んでいないときは、保存済みの理由を隠し項目で送り直す＝出し分けで値を消さない）
 * - 任意: 担当部署（評価の担当部署が既定。値があれば節を開いて描く）
 * Server Action（saveSsbjScopeAction）と項目名は変えない。
 */
export function ScopeForm({
  action,
  hidden,
  defaults,
}: {
  action: ServerAction;
  hidden: Record<string, string>;
  defaults: {
    applicability: 'applicable' | 'not_applicable';
    materiality: 'material' | 'not_material' | 'not_assessed';
    applicabilityReason: string;
    materialityReason: string;
    ownerDepartment: string;
  };
}) {
  const [applicability, setApplicability] = React.useState(defaults.applicability);
  const [materiality, setMateriality] = React.useState(defaults.materiality);

  return (
    <form action={action} className="space-y-2.5">
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <FormSection title="判断" kind="required">
        <div className="grid grid-cols-2 gap-2">
          <Field label="適用区分" name="applicability" required>
            {(p) => (
              <NativeSelect
                {...p}
                name="applicability"
                aria-label="適用区分"
                value={applicability}
                onChange={(event) =>
                  setApplicability(event.target.value as 'applicable' | 'not_applicable')
                }
              >
                <option value="applicable">対象</option>
                <option value="not_applicable">対象外</option>
              </NativeSelect>
            )}
          </Field>
          <Field label="重要性" name="materiality" required>
            {(p) => (
              <NativeSelect
                {...p}
                name="materiality"
                aria-label="重要性"
                value={materiality}
                onChange={(event) =>
                  setMateriality(event.target.value as 'material' | 'not_material' | 'not_assessed')
                }
              >
                <option value="material">重要性あり</option>
                <option value="not_material">重要性なし</option>
                <option value="not_assessed">未判定</option>
              </NativeSelect>
            )}
          </Field>
        </div>
        {applicability === 'not_applicable' ? (
          <Field
            label="対象外とする理由"
            name="applicabilityReason"
            required
            hint="対象外にするには理由が必要です（監査で根拠を問われます）"
          >
            {(p) => (
              <Input
                {...p}
                name="applicabilityReason"
                defaultValue={defaults.applicabilityReason}
                aria-label="対象外とする理由"
                className="h-7 text-small"
              />
            )}
          </Field>
        ) : (
          <input type="hidden" name="applicabilityReason" value={defaults.applicabilityReason} />
        )}
        {materiality === 'not_material' ? (
          <Field
            label="重要性なしとする理由"
            name="materialityReason"
            required
            hint="重要性なしとするには理由が必要です"
          >
            {(p) => (
              <Input
                {...p}
                name="materialityReason"
                defaultValue={defaults.materialityReason}
                aria-label="重要性なしとする理由"
                className="h-7 text-small"
              />
            )}
          </Field>
        ) : (
          <input type="hidden" name="materialityReason" value={defaults.materialityReason} />
        )}
      </FormSection>
      <FormSection title="担当" kind="optional" open={defaults.ownerDepartment !== ''}>
        <Field label="担当部署" name="ownerDepartment">
          {(p) => (
            <Input
              {...p}
              name="ownerDepartment"
              defaultValue={defaults.ownerDepartment}
              aria-label="担当部署"
              className="h-7 text-small"
            />
          )}
        </Field>
      </FormSection>
      <SubmitButton size="sm" variant="secondary" pendingLabel="保存しています…">
        判定を保存
      </SubmitButton>
    </form>
  );
}
