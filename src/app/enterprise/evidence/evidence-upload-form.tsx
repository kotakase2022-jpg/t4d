'use client';

import * as React from 'react';
import { AlertTriangle, Upload } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { EVIDENCE_USAGE_PURPOSE_LABELS } from '@/lib/domain/disclosure-status';
import { NETWORK_ERROR_MESSAGE, withNetworkFallback } from '@/lib/errors/safe-form-action';
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

const selectClass =
  'mt-0.5 block h-7 w-full rounded-t4d border border-line bg-surface px-2 text-[13px] focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-100';

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
  (_previous, formData): EvidenceUploadFormState => ({
    status: 'error',
    message: NETWORK_ERROR_MESSAGE,
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
 * 資料・証跡の登録フォーム。
 *  - 送信中はボタンを止めて「登録中…」と示す（二度押しで同じ資料を 2 件登録しない）
 *  - サーバーが断ったとき・通信に失敗したときも、資料名・版・発行日・利用目的などの入力は残す
 *    （ファイルだけはブラウザの制約で選び直しが要るため、その旨を示す）
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

  return (
    <form
      key={generation}
      action={formAction}
      className="space-y-2 px-3 pb-3"
      aria-describedby={values ? errorId : undefined}
    >
      <input type="hidden" name="kind" value={qualitative ? 'qualitative' : 'evidence'} />
      {qualitative && (
        <p className="text-[12px] text-ink-muted">
          利用目的は必須です。「当年度の根拠」以外（過年度の記載・文体の参考）は、当年度の事実の根拠として扱いません。
          資料を登録しただけでは、要求事項は対応済みになりません。
        </p>
      )}
      {state.status === 'error' && state.message && (
        <p
          id={errorId}
          role="alert"
          className="flex items-start gap-1 rounded-t4d border border-danger/40 bg-danger-soft px-2 py-1.5 text-[12px] text-ink"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden="true" />
          {state.message}
          （入力は残っています。ファイルだけはもう一度選んでください）
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <div className="sm:col-span-2">
          <label htmlFor="ev-file" className="block text-[12px] text-ink-muted">
            {qualitative
              ? `ファイル（${extensions.join(' ')}）`
              : 'ファイル（形式は問いません。本文を抽出できる形式は引用にも使えます）'}
          </label>
          <input
            id="ev-file"
            type="file"
            name="file"
            required
            accept={qualitative ? extensions.join(',') : undefined}
            className="mt-0.5 block text-[12px] file:mr-2 file:rounded-t4d file:border file:border-line file:bg-surface file:px-2 file:py-1 file:text-[12px]"
          />
        </div>
        {full && (
          <div>
            <label htmlFor="ev-title" className="block text-[12px] text-ink-muted">
              資料名
            </label>
            <Input
              id="ev-title"
              name="title"
              placeholder="空欄ならファイル名"
              defaultValue={values?.title ?? ''}
              className="mt-0.5"
            />
          </div>
        )}
        <div>
          <label htmlFor="ev-period" className="block text-[12px] text-ink-muted">
            {full ? '対象年度' : '対象期間'}
          </label>
          <select
            id="ev-period"
            name="reportingPeriodId"
            defaultValue={values?.reportingPeriodId ?? currentPeriodId}
            className={selectClass}
          >
            {full && <option value="">指定しない</option>}
            {periods.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code}
              </option>
            ))}
          </select>
        </div>
        {full && (
          <>
            <div>
              <label htmlFor="ev-edition" className="block text-[12px] text-ink-muted">
                版
              </label>
              <Input
                id="ev-edition"
                name="editionLabel"
                placeholder="例: 2026年6月 第2版"
                defaultValue={values?.editionLabel ?? ''}
                className="mt-0.5"
              />
            </div>
            <div>
              <label htmlFor="ev-issued" className="block text-[12px] text-ink-muted">
                発行日
              </label>
              <Input
                id="ev-issued"
                name="issuedOn"
                type="date"
                defaultValue={values?.issuedOn ?? ''}
                className="mt-0.5"
              />
            </div>
          </>
        )}
        <div>
          <label htmlFor="ev-type" className="block text-[12px] text-ink-muted">
            文書種別
          </label>
          <Input
            id="ev-type"
            name="documentType"
            placeholder={full ? '例: 議事録・請求書' : '例: 請求書'}
            defaultValue={values?.documentType ?? ''}
            className="mt-0.5"
          />
        </div>
        {full && (
          <>
            <div>
              <label htmlFor="ev-conf" className="block text-[12px] text-ink-muted">
                機密区分
              </label>
              <select
                id="ev-conf"
                name="confidentiality"
                defaultValue={values?.confidentiality || 'confidential'}
                className={selectClass}
              >
                {CONFIDENTIALITY_LEVELS.map((c) => (
                  <option key={c} value={c}>
                    {confidentialityLabels[c]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="ev-purpose" className="block text-[12px] text-ink-muted">
                利用目的{qualitative ? '（必須）' : ''}
              </label>
              <select
                id="ev-purpose"
                name="usagePurpose"
                required={qualitative}
                defaultValue={values?.usagePurpose ?? (qualitative ? 'current_fact' : '')}
                className={selectClass}
              >
                {!qualitative && <option value="">未設定（証憑）</option>}
                {EVIDENCE_USAGE_PURPOSES.map((p) => (
                  <option key={p} value={p}>
                    {EVIDENCE_USAGE_PURPOSE_LABELS[p]}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton size="sm" pendingLabel="登録中…" icon={<Upload aria-hidden="true" />}>
          登録
        </SubmitButton>
        {full && (
          <span className="text-[11px] text-ink-muted">
            PDF・Word・テキストは段落・ページ単位で引用できる箇所を抽出します。機密区分の既定は「機密」です。
          </span>
        )}
      </div>
    </form>
  );
}
