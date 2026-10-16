'use client';

import * as React from 'react';
import { AlertTriangle, CheckCircle2, FileUp, ListChecks, Upload } from 'lucide-react';
import { FileDropZone } from '@/components/shared/file-drop-zone';
import { Notice } from '@/components/shared/notice';
import { SemanticBadge } from '@/components/shared/status-badge';
import { StepNav, type StepItem } from '@/components/shared/step-nav';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input, Textarea } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import {
  EMISSION_BASIS_LABELS,
  FACTOR_FIELD_GROUPS,
  FACTOR_IMPORT_FIELD_LABELS,
  FACTOR_IMPORT_FIELDS,
  FACTOR_KIND_LABELS,
  REQUIRED_FACTOR_FIELDS,
  type FactorColumnMapping,
  type ImportedFactor,
} from '@/lib/domain/ghg/factor-import';
import {
  DECIMAL_SEPARATOR_LABELS,
  DECIMAL_SEPARATORS,
  type DecimalSeparator,
} from '@/lib/domain/ghg/number-format';
import { formatNumber } from '@/lib/format/datetime';
import { confirmFactorSetImportAction, previewFactorSetImportAction } from '../actions';
import {
  MAPPING_FIELD_PREFIX,
  type FactorImportConfirmState,
  type FactorImportPreviewState,
} from '../_lib/import-state';

/**
 * 係数セットの取込（P91 の CreatePanel。plan §2.4: ファイル → 列の対応 → 検証 → 確定）。
 *
 * - プレビューの結果はサーバーに残さない。ファイルはこのブラウザが持ち、検証・確定のたびに送り直す
 *   （本番は要求ごとに別のインスタンスになりうる。plan §2.7）。確定はサーバーが検証し直し、指紋が違えば断る
 * - 列の対応・小数点の記号・基準年・出典・ファイルを変えたら、検証し直すまで確定できない（見た内容と違うものを書かない）
 * - 主な操作は段階ごとに 1 つ（検証する → 確定する）。もう一方は副操作
 * - 送ったあとにフォームを初期値へ戻さない（入力を保つ）ため、送信は onSubmit で行う
 */

const SELECT_NONE = '';

function fileKey(file: File | null): string {
  return file ? `${file.name}|${file.size}|${file.lastModified}` : '';
}

function sameMapping(a: FactorColumnMapping, b: FactorColumnMapping): boolean {
  return FACTOR_IMPORT_FIELDS.every((f) => (a[f] ?? '') === (b[f] ?? ''));
}

function valueText(f: ImportedFactor): string {
  if (f.activityKind === 'transport_formula') {
    const params = f.params as { S?: number; classes?: Record<string, unknown> };
    return `式（S ${params.S ?? '—'}・燃費区分 ${Object.keys(params.classes ?? {}).length}）`;
  }
  if (f.activityKind === 'transport_default') {
    const params = f.params as { table?: unknown[] };
    return `原単位表（${params.table?.length ?? 0} 区分）`;
  }
  if (f.calorificValue !== null && f.carbonFactor !== null) {
    return `${formatNumber(f.calorificValue, { fraction: 12 })} ${f.calorificUnit ?? ''} × ${formatNumber(f.carbonFactor, { fraction: 12 })} ${f.carbonFactorUnit ?? ''}`;
  }
  return `${formatNumber(f.factorValue, { fraction: 12 })} ${f.factorUnit}`;
}

export function FactorImportForm({
  defaultReferenceYear,
  sampleHref,
}: {
  defaultReferenceYear: string;
  /** 架空のサンプル（E20。Demo Mode だけ） */
  sampleHref: string | null;
}) {
  const [previewState, previewDispatch, previewPending] = React.useActionState<
    FactorImportPreviewState,
    FormData
  >(previewFactorSetImportAction, null);
  const [confirmState, confirmDispatch, confirmPending] = React.useActionState<
    FactorImportConfirmState,
    FormData
  >(confirmFactorSetImportAction, null);

  const [file, setFile] = React.useState<File | null>(null);
  const [mapping, setMapping] = React.useState<FactorColumnMapping>({});
  const [separator, setSeparator] = React.useState<DecimalSeparator | ''>('');
  const [referenceYear, setReferenceYear] = React.useState(defaultReferenceYear);
  const [sourceLabel, setSourceLabel] = React.useState('');
  const dispatchedFileKey = React.useRef('');
  const [previewFileKey, setPreviewFileKey] = React.useState('');

  const preview = previewState?.ok ? previewState.preview : null;

  // 検証の結果が届いたら、その時点の列の対応（初回は見出しから作った候補）を画面の選択にする
  React.useEffect(() => {
    if (!previewState?.ok) return;
    setMapping(previewState.preview.mapping);
    setSeparator(previewState.preview.decimalSeparator ?? '');
    setPreviewFileKey(dispatchedFileKey.current);
  }, [previewState]);

  const dirty =
    preview !== null &&
    (!sameMapping(mapping, preview.mapping) ||
      separator !== (preview.decimalSeparator ?? '') ||
      referenceYear.trim() !== preview.referenceYear ||
      sourceLabel.trim() !== preview.sourceLabel ||
      fileKey(file) !== previewFileKey);
  const errors = preview?.result.errors ?? [];
  const mappingErrors = errors.filter((e) => e.line === null);
  const validated =
    preview !== null && !dirty && errors.length === 0 && preview.result.factors.length > 0;

  const steps: StepItem[] = [
    { key: 'file', label: 'ファイル', state: file ? 'done' : 'current' },
    {
      key: 'mapping',
      label: '列の対応',
      state: !preview ? 'todo' : dirty || mappingErrors.length > 0 ? 'current' : 'done',
    },
    {
      key: 'validate',
      label: '検証',
      state: !preview || dirty ? 'todo' : errors.length > 0 ? 'current' : 'done',
    },
    { key: 'confirm', label: '確定', state: validated ? 'current' : 'todo' },
  ];

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const intent = submitter?.value === 'confirm' ? 'confirm' : 'validate';
    const data = new FormData(event.currentTarget);
    if (file) data.set('file', file);
    if (intent === 'validate') dispatchedFileKey.current = fileKey(file);
    React.startTransition(() => {
      if (intent === 'confirm') confirmDispatch(data);
      else previewDispatch(data);
    });
  };

  const pending = previewPending || confirmPending;

  return (
    <form onSubmit={onSubmit} className="space-y-3" aria-label="係数セットの取込">
      <StepNav ariaLabel="係数セットの取込の段階" steps={steps} />

      <FormSection title="ファイルとセットの情報" kind="required">
        <FileDropZone
          inputId="factor-file"
          onFilesDropped={(files) => setFile(files[0] ?? null)}
          className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-t4d-lg border-2 border-dashed border-line bg-surface-muted px-4 py-5 text-center transition-colors hover:border-brand-400 hover:bg-brand-50"
        >
          <FileUp className="size-5 text-brand-600" aria-hidden="true" />
          <span className="text-body font-medium text-ink">
            係数の表のファイルを選ぶ ／ ここへドロップ
          </span>
          <span className="text-caption text-ink-muted">
            CSV（.csv・.tsv）・Excel（.xlsx）・5MB まで。1 行に 1
            つの係数（改良トンキロ法は燃費区分・区分ごとに 1 行）
          </span>
          <input
            id="factor-file"
            type="file"
            name="file"
            accept=".csv,.tsv,.txt,.xlsx,.xlsm,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
          />
        </FileDropZone>
        <p role="status" aria-live="polite" className="text-small text-ink-muted">
          {file ? (
            <>
              選んだファイル: <span className="text-ink">{file.name}</span>
            </>
          ) : (
            'ファイルはまだ選んでいません。'
          )}
          {sampleHref && (
            <>
              {' '}
              ／{' '}
              <a href={sampleHref} download className="text-brand-700 hover:underline">
                架空のサンプル（係数セット CSV）をダウンロード
              </a>
            </>
          )}
        </p>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <Field
            label="セットのコード"
            name="code"
            required
            hint="例 ORG-2025R（空白なし・40 文字まで）"
          >
            {(p) => <Input {...p} name="code" maxLength={40} autoComplete="off" />}
          </Field>
          <Field label="セットの名称" name="name" required>
            {(p) => <Input {...p} name="name" maxLength={200} />}
          </Field>
          <Field
            label="出所"
            name="origin"
            required
            hint="架空（デモ）は選べません（Fixture だけ）"
          >
            {(p) => (
              <NativeSelect {...p} name="origin" defaultValue="customer_specified">
                <option value="customer_specified">組織指定</option>
                <option value="public_reference">公的参照</option>
              </NativeSelect>
            )}
          </Field>
          <Field label="版" name="versionLabel" required hint="例 2025 年版 改訂">
            {(p) => <Input {...p} name="versionLabel" maxLength={100} />}
          </Field>
          <Field
            label="出典"
            name="sourceLabel"
            required
            hint="誰が・何の資料で定めた係数か。出典の列が無い行に使います"
            className="sm:col-span-2"
          >
            {(p) => (
              <Input
                {...p}
                name="sourceLabel"
                maxLength={300}
                value={sourceLabel}
                onChange={(event) => setSourceLabel(event.currentTarget.value)}
              />
            )}
          </Field>
          <Field label="公表日" name="publishedOn">
            {(p) => <Input {...p} name="publishedOn" type="date" />}
          </Field>
          <Field label="基準年" name="referenceYear" hint="年度の列・適用開始が無い行の年度">
            {(p) => (
              <Input
                {...p}
                name="referenceYear"
                inputMode="numeric"
                maxLength={4}
                value={referenceYear}
                onChange={(event) => setReferenceYear(event.currentTarget.value)}
              />
            )}
          </Field>
          <Field label="メモ" name="notes" className="sm:col-span-2 xl:col-span-4">
            {(p) => <Textarea {...p} name="notes" rows={2} maxLength={300} />}
          </Field>
        </div>
      </FormSection>

      {preview && (
        <section aria-labelledby="factor-mapping-title" className="space-y-2">
          <h3 id="factor-mapping-title" className="text-body font-semibold text-ink">
            列の対応（{preview.fileName}・見出し {preview.headers.length} 列）
          </h3>
          <p className="text-caption text-ink-muted">
            {preview.mappingSuggested
              ? '見出しの語から候補を選んであります（推測で確定しません）。確かめてから検証してください。'
              : '選んだ列の対応で検証しました。変えたら検証し直してください。'}
          </p>
          <input type="hidden" name="mappingProvided" value="1" />
          <input type="hidden" name="previewToken" value={preview.previewToken} />
          {FACTOR_FIELD_GROUPS.map((group) => (
            <fieldset key={group.title} className="space-y-1">
              <legend className="text-small font-semibold text-ink">{group.title}</legend>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {group.fields.map((name) => (
                  <Field
                    key={name}
                    label={FACTOR_IMPORT_FIELD_LABELS[name]}
                    id={`factor-map-${name}`}
                    required={REQUIRED_FACTOR_FIELDS.includes(name)}
                  >
                    {(p) => (
                      <NativeSelect
                        {...p}
                        size="sm"
                        name={`${MAPPING_FIELD_PREFIX}${name}`}
                        value={mapping[name] ?? SELECT_NONE}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          setMapping((prev) => ({ ...prev, [name]: value || undefined }));
                        }}
                      >
                        <option value={SELECT_NONE}>（使わない）</option>
                        {preview.headers.map((header) => (
                          <option key={header} value={header}>
                            {header}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </Field>
                ))}
              </div>
            </fieldset>
          ))}
          <Field
            label="小数点の記号"
            id="factor-decimal-separator"
            hint="「0.437」は 0.437 とも 437 とも読めます。選ぶまで、そのような値は読みません（推測で埋めません）"
            className="max-w-field-lg"
          >
            {(p) => (
              <NativeSelect
                {...p}
                name="decimalSeparator"
                value={separator}
                onChange={(event) =>
                  setSeparator(event.currentTarget.value as DecimalSeparator | '')
                }
              >
                <option value="">選ばない</option>
                {DECIMAL_SEPARATORS.map((s) => (
                  <option key={s} value={s}>
                    {DECIMAL_SEPARATOR_LABELS[s]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        </section>
      )}

      {previewState && !previewState.ok && (
        <Notice tone="danger" role="alert">
          {previewState.message}
        </Notice>
      )}
      {confirmState && !confirmState.ok && (
        <Notice tone="danger" role="alert">
          {confirmState.message}
        </Notice>
      )}
      {dirty && (
        <Notice tone="warning" role="status">
          検証した後にファイル・列の対応・小数点の記号・基準年・出典を変えました。もう一度検証してから確定してください。
        </Notice>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton
          name="intent"
          value="validate"
          variant={validated ? 'secondary' : 'primary'}
          size="sm"
          disabled={pending || !file}
          aria-busy={previewPending || undefined}
          icon={preview ? <ListChecks aria-hidden="true" /> : <Upload aria-hidden="true" />}
        >
          {previewPending
            ? '検証中…'
            : preview
              ? '列の対応を反映して検証する'
              : 'ファイルを読んで検証する'}
        </SubmitButton>
        {preview && (
          <SubmitButton
            name="intent"
            value="confirm"
            variant={validated ? 'primary' : 'secondary'}
            size="sm"
            disabled={pending || !validated}
            aria-busy={confirmPending || undefined}
            aria-describedby="factor-confirm-note"
            icon={<CheckCircle2 aria-hidden="true" />}
          >
            {confirmPending ? '確定中…' : '確定する（下書きのセットを作る）'}
          </SubmitButton>
        )}
        <span id="factor-confirm-note" className="text-caption text-ink-muted">
          {!file
            ? 'ファイルを選ぶと検証できます。'
            : validated
              ? '確定すると下書きのセットになります。内容を確かめてから有効にします（有効にした後は係数を変えられません）。'
              : preview && errors.length > 0
                ? `検証のエラーが ${errors.length} 件あります。直すまで確定できません。`
                : '検証すると、読めた係数とエラーがこの下に並びます。'}
        </span>
      </div>

      {preview && (
        <section
          aria-labelledby="factor-preview-title"
          className="space-y-2 border-t border-line pt-2"
        >
          <h3
            id="factor-preview-title"
            className="flex flex-wrap items-center gap-2 text-body font-semibold text-ink"
          >
            検証の結果
            {errors.length === 0 ? (
              <SemanticBadge semantic="done" label="エラーなし" />
            ) : (
              <SemanticBadge semantic="error" label={`エラー ${errors.length} 件`} />
            )}
            {preview.result.warnings.length > 0 && (
              <SemanticBadge
                semantic="blocked"
                label={`警告 ${preview.result.warnings.length} 件`}
              />
            )}
          </h3>
          <p className="text-small text-ink-muted">
            読んだ行 {preview.result.rowCount} 行 ／ 係数 {preview.result.factors.length} 件 ／
            ファイルの sha256 <span className="font-mono">{preview.sha256.slice(0, 12)}</span>
          </p>
          {preview.sheetNotes.length > 0 && (
            <ul
              className="space-y-0.5 text-caption text-ink-muted"
              aria-label="ファイルの読み方の注記"
            >
              {preview.sheetNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          {errors.length > 0 && (
            // 読み上げの通知（alert）はリストの外側に付ける。ul に role="alert" を付けると list の役割が消え、
            // li が親の無い listitem になる（支援技術がエラーの件数・並びを伝えられない）
            <div role="alert">
              <ul aria-label="検証のエラー" className="space-y-0.5">
                {errors.slice(0, 50).map((e, index) => (
                  <li
                    key={`${e.line}-${index}`}
                    className="flex items-start gap-1 text-small text-danger"
                  >
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    {e.line !== null ? `${e.line} 行目: ` : ''}
                    {e.message}
                  </li>
                ))}
                {errors.length > 50 && (
                  <li className="text-small text-danger">ほか {errors.length - 50} 件</li>
                )}
              </ul>
            </div>
          )}
          {preview.result.warnings.length > 0 && (
            <ul aria-label="検証の警告" className="space-y-0.5">
              {preview.result.warnings.map((w, index) => (
                <li
                  key={`${w.line}-${index}`}
                  className="flex items-start gap-1 text-small text-warning-ink"
                >
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  {w.line !== null ? `${w.line} 行目: ` : ''}
                  {w.message}
                </li>
              ))}
            </ul>
          )}
          {preview.result.factors.length > 0 && (
            <div className="t4d-scroll-x">
              <Table>
                <caption className="sr-only">読めた係数</caption>
                <THead>
                  <TR>
                    <TH>係数コード</TH>
                    <TH>名称</TH>
                    <TH>種類</TH>
                    <TH>活動</TH>
                    <TH>国</TH>
                    <TH>基準</TH>
                    <TH align="right">年度</TH>
                    <TH>値</TH>
                    <TH>元の行</TH>
                  </TR>
                </THead>
                <TBody>
                  {preview.result.factors.map((f) => (
                    <TR key={`${f.code}-${f.factorYear}`}>
                      <TD className="font-mono text-caption">{f.code}</TD>
                      <TD>{f.name}</TD>
                      <TD>{f.activityKind ? FACTOR_KIND_LABELS[f.activityKind] : '—'}</TD>
                      <TD className="font-mono text-caption">{f.activityCode}</TD>
                      <TD>{f.countryCode ?? '—'}</TD>
                      <TD>{f.basis ? EMISSION_BASIS_LABELS[f.basis] : '—'}</TD>
                      <TD align="right" className="tnum">
                        {f.factorYear}
                      </TD>
                      <TD className="text-caption">{valueText(f)}</TD>
                      <TD className="tnum text-caption">{f.lines.join('・')}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </section>
      )}
    </form>
  );
}
