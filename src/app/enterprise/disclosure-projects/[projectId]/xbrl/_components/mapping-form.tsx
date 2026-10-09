import * as React from 'react';
import { Save } from 'lucide-react';
import { Notice } from '@/components/shared/notice';
import { PreservingForm } from '@/components/shared/preserving-form';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { XBRL_PERIOD_ROLE_LABELS, type XbrlTargetOption } from '@/lib/services/xbrl-tagging';
import type { TaxonomyConcept } from '@/lib/xbrl/taxonomy';
import { XBRL_PERIOD_ROLES, type XbrlPeriodRole } from '@/types/domain';
import { saveXbrlMappingAction } from '../actions';

export interface MappingFormValues {
  mappingId: string | null;
  targetKey: string | null;
  conceptId: string | null;
  disclosureItemId: string | null;
  periodRole: XbrlPeriodRole;
  decimals: number | null;
  dimensions: Record<string, string>;
  /** 確定・対象外の行を編集する（保存すると候補に戻る） */
  resetsDecision: boolean;
}

/**
 * XBRL の対応付けの作成・編集のフォーム（CreatePanel の中に置く。plan §1.13）。
 * 必須の節（対象・概念）を先に、任意の節（要求事項・期間・精度・軸）を後に並べる。
 * 精度と軸は数値の確定に要る（未設定の数値の候補は確定できない）。境界の文字列から推測しない。
 * 断られたときは入力を残して理由を示す（PreservingForm）
 */
export function MappingForm({
  projectId,
  packageId,
  snapshotId,
  frameworkVersionId,
  targetOptions,
  numericConcepts,
  textBlockConcepts,
  axes,
  requirementOptions,
  values,
}: {
  projectId: string;
  packageId: string;
  snapshotId: string | null;
  frameworkVersionId: string | null;
  targetOptions: XbrlTargetOption[];
  numericConcepts: TaxonomyConcept[];
  textBlockConcepts: TaxonomyConcept[];
  axes: Array<{ axis: TaxonomyConcept; members: TaxonomyConcept[] }>;
  requirementOptions: Array<{ itemId: string; code: string; title: string }>;
  values: MappingFormValues;
}) {
  const idPrefix = values.mappingId ? 'xbrl-edit' : 'xbrl-new';
  const optionalOpen =
    values.mappingId !== null ||
    values.targetKey !== null ||
    values.decimals !== null ||
    Object.keys(values.dimensions).length > 0;
  return (
    <PreservingForm
      action={saveXbrlMappingAction}
      className="space-y-3 text-small"
      aria-label={values.mappingId ? 'XBRL の対応付けを編集' : 'XBRL の対応付けを追加'}
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="packageId" value={packageId} />
      {values.mappingId && <input type="hidden" name="mappingId" value={values.mappingId} />}
      {snapshotId && <input type="hidden" name="snapshot" value={snapshotId} />}
      {frameworkVersionId && <input type="hidden" name="fw" value={frameworkVersionId} />}

      {values.resetsDecision && (
        <Notice tone="warning">
          内容を変えて保存すると、確定（または対象外）は取り消され「候補」に戻ります。承認権限を持つ別の人が確定し直します。
        </Notice>
      )}

      <FormSection title="対応付け" kind="required">
        <div className="grid gap-2 min-[900px]:grid-cols-2">
          <Field
            label="T4D の対象（数値・節）"
            id={`${idPrefix}-target`}
            required
            hint="表示中のスナップショットの本文にある節と、本文が引用した数値から選びます。"
          >
            {(control) => (
              <NativeSelect {...control} name="targetKey" defaultValue={values.targetKey ?? ''}>
                <option value="" disabled>
                  選んでください
                </option>
                {targetOptions.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field
            label="概念（SAMPLE・架空）"
            id={`${idPrefix}-concept`}
            required
            hint="数値は数値の概念、節は文章の概念（テキストブロック）に対応付けます。"
          >
            {(control) => (
              <NativeSelect {...control} name="conceptId" defaultValue={values.conceptId ?? ''}>
                <option value="" disabled>
                  選んでください
                </option>
                <optgroup label="数値の概念">
                  {numericConcepts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.labelJa}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="文章の概念（テキストブロック）">
                  {textBlockConcepts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.labelJa}
                    </option>
                  ))}
                </optgroup>
              </NativeSelect>
            )}
          </Field>
        </div>
      </FormSection>

      <FormSection
        title="要求事項・期間・精度・軸"
        kind="optional"
        open={optionalOpen}
        description="数値を確定するには精度（decimals）と、境界を表す軸メンバーが要ります（未設定は確定できず、検証の V05・V13 で知らせます）。"
      >
        <div className="grid gap-2 min-[900px]:grid-cols-2">
          <Field
            label="要求事項"
            id={`${idPrefix}-item`}
            hint="空のままなら、節（数値は引用した節）の要求事項を使います。"
          >
            {(control) => (
              <NativeSelect
                {...control}
                name="disclosureItemId"
                defaultValue={values.disclosureItemId ?? ''}
              >
                <option value="">節の要求事項を使う</option>
                {requirementOptions.map((i) => (
                  <option key={i.itemId} value={i.itemId}>
                    {i.code} {i.title.slice(0, 40)}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field
            label="期間"
            id={`${idPrefix}-period`}
            hint="節は当年度だけです。前年度・基準年は、その年の値を本文で引用していると事実になります。"
          >
            {(control) => (
              <NativeSelect {...control} name="periodRole" defaultValue={values.periodRole}>
                {XBRL_PERIOD_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {XBRL_PERIOD_ROLE_LABELS[role]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field
            label="精度（decimals）"
            id={`${idPrefix}-decimals`}
            hint="T4D の単位での小数点以下の桁数（0＝整数、1＝小数第 1 位、-3＝千の位）。節には使いません。"
          >
            {(control) => (
              <Input
                {...control}
                name="decimals"
                type="number"
                inputMode="numeric"
                min={-12}
                max={12}
                step={1}
                defaultValue={values.decimals ?? ''}
                className="w-field-sm"
              />
            )}
          </Field>
          {axes.map(({ axis, members }) => (
            <Field
              key={axis.localName}
              label={axis.labelJa}
              id={`${idPrefix}-dim-${axis.localName}`}
              hint="境界（連結・財務支配力など）を表すメンバー。境界の文字列からは推測しません。"
            >
              {(control) => (
                <NativeSelect
                  {...control}
                  name={`dim:${axis.localName}`}
                  defaultValue={values.dimensions[axis.localName] ?? ''}
                >
                  <option value="">指定しない</option>
                  {members.map((m) => (
                    <option key={m.localName} value={m.localName}>
                      {m.labelJa}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
          ))}
        </div>
      </FormSection>

      <SubmitButton
        size="sm"
        variant="primary"
        pendingLabel="保存中…"
        icon={<Save aria-hidden="true" />}
      >
        {values.mappingId ? '変更を保存（候補）' : '候補として保存'}
      </SubmitButton>
    </PreservingForm>
  );
}
