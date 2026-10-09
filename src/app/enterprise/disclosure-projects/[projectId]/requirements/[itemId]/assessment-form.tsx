'use client';

import { Save } from 'lucide-react';
import { PreservingForm } from '@/components/shared/preserving-form';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input, Textarea } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { saveRequirementAssessmentAction } from '../actions';

const APPLICABILITY_OPTIONS = [
  ['applicable', '適用'],
  ['not_applicable', '対象外'],
  ['not_material', '非重要'],
  ['not_assessed', '未判定'],
] as const;

const COVERAGE_OPTIONS = [
  ['', '未評価'],
  ['covered', '対応済み'],
  ['mostly_covered', 'おおむね対応'],
  ['partial', '一部対応'],
  ['not_covered', '未対応'],
  ['unconfirmed', '未確認'],
] as const;

const ASPECTS = [
  ['disclosureCoverage', '開示'],
  ['dataCoverage', 'データ'],
  ['processCoverage', '業務プロセス'],
] as const;

export interface AssessmentFormDefaults {
  applicability: string;
  applicabilityReason: string;
  ruleRef: string;
  disclosureCoverage: string;
  dataCoverage: string;
  processCoverage: string;
  missingInformation: string;
  ownerUserId: string;
  dueOn: string;
  actionNote: string;
}

/**
 * 要求事項の判断を記録するフォーム（トライアル対応 NF-01。要求事項の詳細の CreatePanel の中）。
 * 必須の節（適用区分・理由）を先に、任意の節（3 観点の評価・担当と期限・メモ）を後に並べる。
 * 対象外・非重要を選んだときだけ理由を必須にする（送る前にブラウザが止め、最終の検査はサーバー）。
 * 断られたら入力を残して理由を示す（PreservingForm）。
 */
export function AssessmentForm({
  projectId,
  projectFrameworkId,
  itemId,
  textLimit,
  members,
  defaults,
}: {
  projectId: string;
  projectFrameworkId: string;
  itemId: string;
  textLimit: number;
  members: Array<{ userId: string; name: string }>;
  defaults: AssessmentFormDefaults;
}) {
  const hasOptional =
    defaults.disclosureCoverage !== '' ||
    defaults.dataCoverage !== '' ||
    defaults.processCoverage !== '';
  return (
    <PreservingForm
      action={saveRequirementAssessmentAction}
      className="space-y-3"
      aria-label="判断を記録"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="projectFrameworkId" value={projectFrameworkId} />
      <input type="hidden" name="itemId" value={itemId} />
      <FormSection title="適用の判断" kind="required">
        <div className="grid gap-2 sm:grid-cols-[200px_minmax(0,1fr)]">
          <Field label="適用区分" id="assessment-applicability" required>
            {(control) => (
              <NativeSelect {...control} name="applicability" defaultValue={defaults.applicability}>
                {APPLICABILITY_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <label className="block space-y-1" htmlFor="assessment-reason">
            <span className="block text-small font-medium text-ink">
              理由（対象外・非重要を選んだときは必須）
            </span>
            <Textarea
              id="assessment-reason"
              name="applicabilityReason"
              rows={3}
              maxLength={textLimit}
              defaultValue={defaults.applicabilityReason}
              data-required-if="applicability=not_applicable|not_material"
              aria-describedby="assessment-reason-hint"
            />
            <span id="assessment-reason-hint" className="block text-caption text-ink-muted">
              {textLimit}{' '}
              字まで。対象外・非重要は、別の人の承認があるまで分母から外しません。理由を変えると承認し直しです。
            </span>
          </label>
        </div>
      </FormSection>

      <FormSection
        title="3 観点の評価（開示・データ・業務プロセス）"
        kind="optional"
        open={hasOptional}
      >
        <div className="grid gap-2 sm:grid-cols-3">
          {ASPECTS.map(([name, label]) => (
            <Field key={name} label={label} id={`assessment-${name}`}>
              {(control) => (
                <NativeSelect {...control} name={name} defaultValue={defaults[name]}>
                  {COVERAGE_OPTIONS.map(([value, optionLabel]) => (
                    <option key={value} value={value}>
                      {optionLabel}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
          ))}
        </div>
        <Field label="不足情報" id="assessment-missing" hint={`${textLimit} 字まで`}>
          {(control) => (
            <Textarea
              {...control}
              name="missingInformation"
              rows={2}
              maxLength={textLimit}
              defaultValue={defaults.missingInformation}
            />
          )}
        </Field>
      </FormSection>

      <FormSection
        title="担当・期限・参照した規則・対応メモ"
        kind="optional"
        open={defaults.ownerUserId !== '' || defaults.dueOn !== ''}
      >
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="担当" id="assessment-owner">
            {(control) => (
              <NativeSelect {...control} name="ownerUserId" defaultValue={defaults.ownerUserId}>
                <option value="">未設定</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="期限" id="assessment-due">
            {(control) => (
              <Input {...control} type="date" name="dueOn" defaultValue={defaults.dueOn} />
            )}
          </Field>
          <Field label="参照した規則" id="assessment-rule" hint="例: 基準の項番・社内の判断基準">
            {(control) => (
              <Input
                {...control}
                name="ruleRef"
                maxLength={textLimit}
                defaultValue={defaults.ruleRef}
              />
            )}
          </Field>
        </div>
        <Field label="対応メモ" id="assessment-action-note">
          {(control) => (
            <Textarea
              {...control}
              name="actionNote"
              rows={2}
              maxLength={textLimit}
              defaultValue={defaults.actionNote}
            />
          )}
        </Field>
      </FormSection>

      <Field
        label="変更の理由（履歴に残します）"
        id="assessment-change-reason"
        hint="任意。判断を変えた理由を残すと、担当が替わっても経緯を追えます。"
      >
        {(control) => <Input {...control} name="changeReason" maxLength={textLimit} />}
      </Field>

      <SubmitButton
        variant="primary"
        size="sm"
        icon={<Save aria-hidden="true" />}
        pendingLabel="保存しています…"
      >
        判断を保存
      </SubmitButton>
    </PreservingForm>
  );
}
