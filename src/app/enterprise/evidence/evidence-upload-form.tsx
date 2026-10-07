'use client';

import * as React from 'react';
import { Upload } from 'lucide-react';
import { ActionResult } from '@/components/shared/notice';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { EVIDENCE_USAGE_PURPOSE_LABELS } from '@/lib/domain/disclosure-status';
import { withNetworkFallback } from '@/lib/errors/safe-form-action';
import {
  CONFIDENTIALITY_LEVELS,
  EVIDENCE_USAGE_PURPOSES,
  type ConfidentialityLevel,
} from '@/types/domain';
import {
  uploadEvidenceDocumentFormAction,
  type EvidenceUploadFormState,
  type EvidenceUploadValues,
} from './actions';
import { inferEvidenceAttributes } from './infer-attributes';

const INITIAL: EvidenceUploadFormState = { status: 'idle', message: null, values: null };

function valuesOf(formData: FormData): EvidenceUploadValues {
  const get = (key: string) => String(formData.get(key) ?? '');
  return {
    title: get('title'),
    reportingPeriodId: get('reportingPeriodId'),
    editionLabel: get('editionLabel'),
    issuedOn: get('issuedOn'),
    documentType: get('documentType'),
    confidentiality: get('confidentiality'),
    usagePurpose: get('usagePurpose'),
  };
}

const action = withNetworkFallback(
  uploadEvidenceDocumentFormAction,
  (_previous, formData, message): EvidenceUploadFormState => ({
    status: 'error',
    message,
    values: valuesOf(formData),
  }),
);

export interface EvidenceUploadFormProps {
  qualitative: boolean;
  /** 開示優先モード。OFF の組織は従来の Evidence の入力項目だけを出す（REG-F7） */
  disclosureFirst: boolean;
  periods: Array<{ id: string; code: string }>;
  currentPeriodId: string;
  extensions: readonly string[];
  confidentialityLabels: Record<ConfidentialityLevel, string>;
}

/**
 * 資料・証跡の登録フォーム（plan S23。作成パネルの中に置く）。
 *
 * - 2 段: ① ファイル（必須。定性情報は利用目的も必須）→ ② 資料の属性（任意）。属性は既定で閉じ、
 *   システムが分かる値は入れておく（対象年度＝ヘッダーの期間、資料名・文書種別・発行日はファイル名から推定）
 * - 送信中はボタンを止めて「登録中…」と示す（二度押しで同じ資料を 2 件登録しない）
 * - サーバーが断ったとき・通信に失敗したときも、資料名・版・発行日・利用目的などの入力は残す
 *   （ファイルだけはブラウザの制約で選び直しが要るため、その旨を示す）
 */
export function EvidenceUploadForm({
  qualitative,
  disclosureFirst,
  periods,
  currentPeriodId,
  extensions,
  confidentialityLabels,
}: EvidenceUploadFormProps) {
  const [state, formAction] = React.useActionState(action, INITIAL);
  // 失敗して戻ってきたら入力欄を作り直して送った値を入れる（送信後のフォームの初期化で消さない）
  const [generation, setGeneration] = React.useState(0);
  const values = state.status === 'error' ? state.values : null;
  React.useEffect(() => {
    if (state.status === 'error') setGeneration((g) => g + 1);
  }, [state]);
  const full = disclosureFirst || qualitative;
  const errorId = 'ev-upload-error';

  // ファイル名から推定した属性（人が入れた値は上書きしない。空の欄にだけ入れる。資料名は空欄なら
  // サーバーがファイル名を使うので、候補として placeholder にだけ出す）
  const [inferred, setInferred] = React.useState<{
    title: string;
    documentType: string;
    issuedOn: string;
  }>({ title: '', documentType: '', issuedOn: '' });
  const typeRef = React.useRef<HTMLInputElement>(null);
  const issuedRef = React.useRef<HTMLInputElement>(null);
  // 推定で入れた値（欄ごと）。人が書き換えていない（まだ推定のままの）欄は、別のファイルを選び直したら
  // 新しい推定に置き換える（推定が無ければ空に戻す）。以前は空の欄にだけ入れていたため、
  // 1 つ目のファイルの推定（請求書・2026-06-30）が 2 つ目のファイルにそのまま残り、人が入れた値として登録された
  const autoFilled = React.useRef<{ documentType: string | null; issuedOn: string | null }>({
    documentType: null,
    issuedOn: null,
  });
  // 推定を入れたら属性の節を開く（閉じたままだと、推定の値を確かめずに登録してしまう）
  const [guessApplied, setGuessApplied] = React.useState(false);

  const onFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const name = event.target.files?.[0]?.name;
    if (!name) return;
    const guess = inferEvidenceAttributes(name);
    setInferred(guess);
    let applied = false;
    const fill = (
      key: 'documentType' | 'issuedOn',
      input: HTMLInputElement | null,
      value: string,
    ) => {
      if (!input) return;
      const previous = autoFilled.current[key];
      const untouched = input.value === '' || (previous !== null && input.value === previous);
      if (!untouched) return;
      input.value = value;
      autoFilled.current[key] = value || null;
      if (value) applied = true;
    };
    fill('documentType', typeRef.current, guess.documentType);
    fill('issuedOn', issuedRef.current, guess.issuedOn);
    if (applied) setGuessApplied(true);
  };
  const hasInferred = Boolean(inferred.documentType || inferred.issuedOn);
  // 前回の値（失敗して戻ったとき）があれば属性の節を開いて描く。従来の画面は項目が 2 つだけなので開いておく
  const attributesOpen =
    !full ||
    Boolean(
      values &&
      (values.title ||
        values.editionLabel ||
        values.issuedOn ||
        values.documentType ||
        (!qualitative && values.usagePurpose)),
    );

  return (
    <form
      key={generation}
      action={formAction}
      className="space-y-2"
      aria-describedby={values ? errorId : undefined}
    >
      <input type="hidden" name="kind" value={qualitative ? 'qualitative' : 'evidence'} />
      {qualitative && (
        <p className="text-small text-ink-muted">
          利用目的は必須です。「当年度の根拠」以外（過年度の記載・文体の参考）は、当年度の事実の根拠として扱いません。
          資料を登録しただけでは、要求事項は対応済みになりません。
        </p>
      )}
      {state.status === 'error' && state.message && (
        <ActionResult
          id={errorId}
          state={{
            status: 'error',
            message: `${state.message}（入力は残っています。ファイルだけはもう一度選んでください）`,
          }}
        />
      )}

      <FormSection title="① ファイル" kind="required">
        <div className="grid gap-2 sm:grid-cols-2">
          <Field
            label={
              qualitative
                ? `ファイル（${extensions.join(' ')}）`
                : 'ファイル（形式は問いません。本文を抽出できる形式は引用にも使えます）'
            }
            id="ev-file"
            name="file"
            required
          >
            {(p) => (
              <input
                {...p}
                type="file"
                name="file"
                accept={qualitative ? extensions.join(',') : undefined}
                onChange={onFileChange}
                className="block text-small file:mr-2 file:rounded-t4d file:border file:border-line file:bg-surface file:px-2 file:py-1 file:text-small"
              />
            )}
          </Field>
          {qualitative && (
            <Field label="利用目的" id="ev-purpose" name="usagePurpose" required>
              {(p) => (
                <NativeSelect
                  {...p}
                  name="usagePurpose"
                  defaultValue={values?.usagePurpose || 'current_fact'}
                >
                  {EVIDENCE_USAGE_PURPOSES.map((purpose) => (
                    <option key={purpose} value={purpose}>
                      {EVIDENCE_USAGE_PURPOSE_LABELS[purpose]}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
          )}
        </div>
      </FormSection>

      <FormSection
        title={full ? '② 資料の属性（ファイル名から推定した値が入ります）' : '② 資料の属性'}
        kind="optional"
        open={attributesOpen || guessApplied}
      >
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {full && (
            <Field label="資料名" id="ev-title" name="title" hint="空欄ならファイル名">
              {(p) => (
                <Input
                  {...p}
                  name="title"
                  placeholder={inferred.title || '空欄ならファイル名'}
                  defaultValue={values?.title ?? ''}
                />
              )}
            </Field>
          )}
          <Field
            label={full ? '対象年度' : '対象期間'}
            id="ev-period"
            name="reportingPeriodId"
            hint="既定は画面上部で選んでいる報告期間"
          >
            {(p) => (
              <NativeSelect
                {...p}
                name="reportingPeriodId"
                defaultValue={values?.reportingPeriodId ?? currentPeriodId}
              >
                {full && <option value="">指定しない</option>}
                {periods.map((period) => (
                  <option key={period.id} value={period.id}>
                    {period.code}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          {full && (
            <>
              <Field label="版" id="ev-edition" name="editionLabel">
                {(p) => (
                  <Input
                    {...p}
                    name="editionLabel"
                    placeholder="例: 2026年6月 第2版"
                    defaultValue={values?.editionLabel ?? ''}
                  />
                )}
              </Field>
              <Field label="発行日" id="ev-issued" name="issuedOn">
                {(p) => (
                  <Input
                    {...p}
                    ref={issuedRef}
                    name="issuedOn"
                    type="date"
                    defaultValue={values?.issuedOn ?? ''}
                  />
                )}
              </Field>
            </>
          )}
          <Field label="文書種別" id="ev-type" name="documentType">
            {(p) => (
              <Input
                {...p}
                ref={typeRef}
                name="documentType"
                placeholder={full ? '例: 議事録・請求書' : '例: 請求書'}
                defaultValue={values?.documentType ?? ''}
              />
            )}
          </Field>
          {full && (
            <>
              <Field label="機密区分" id="ev-conf" name="confidentiality" hint="既定は「機密」">
                {(p) => (
                  <NativeSelect
                    {...p}
                    name="confidentiality"
                    defaultValue={values?.confidentiality || 'confidential'}
                  >
                    {CONFIDENTIALITY_LEVELS.map((c) => (
                      <option key={c} value={c}>
                        {confidentialityLabels[c]}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              {!qualitative && (
                <Field label="利用目的" id="ev-purpose" name="usagePurpose">
                  {(p) => (
                    <NativeSelect
                      {...p}
                      name="usagePurpose"
                      defaultValue={values?.usagePurpose ?? ''}
                    >
                      <option value="">未設定（証憑）</option>
                      {EVIDENCE_USAGE_PURPOSES.map((purpose) => (
                        <option key={purpose} value={purpose}>
                          {EVIDENCE_USAGE_PURPOSE_LABELS[purpose]}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
              )}
            </>
          )}
        </div>
        {hasInferred && (
          <p className="text-caption text-ink-muted" aria-live="polite">
            ファイル名から推定した値を入れました（推定です。違っていれば直してください。選び直すと、直していない欄は新しいファイルの推定に置き換わります）。
          </p>
        )}
      </FormSection>

      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton
          variant="primary"
          size="sm"
          pendingLabel="登録中…"
          icon={<Upload aria-hidden="true" />}
        >
          登録
        </SubmitButton>
        {full && (
          <span className="text-caption text-ink-muted">
            PDF・Word・テキストは段落・ページ単位で引用できる箇所を抽出します。
          </span>
        )}
      </div>
    </form>
  );
}
