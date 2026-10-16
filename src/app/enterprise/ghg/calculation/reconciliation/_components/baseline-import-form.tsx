'use client';

import * as React from 'react';
import { CheckCircle2, Download, FileUp, ListChecks } from 'lucide-react';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { FileDropZone } from '@/components/shared/file-drop-zone';
import { Notice } from '@/components/shared/notice';
import { StepNav, type StepItem } from '@/components/shared/step-nav';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { DECIMAL_SEPARATOR_LABELS, DECIMAL_SEPARATORS } from '@/lib/domain/ghg/number-format';
import type {
  BaselineImportSettings,
  BaselineMappingKey,
  BaselinePreview,
} from '@/lib/services/ghg/baseline-import';
import type { BaselineGranularity, GhgScope } from '@/types/domain';
import {
  confirmBaselineImportAction,
  previewBaselineImportAction,
  type BaselineImportState,
} from '../actions';

/**
 * 既存の算定結果の取込（P97 の副操作。plan §2.4: ファイル → 列の対応と拠点の対応付け → 検証 → 確定）。
 *
 * 検証の結果はサーバーにも Cookie にも持たない（本番は要求ごとに別インスタンス）。確定のときは
 * 同じファイルと設定を送り直し、サーバーが読み直して検証してから追記する（sha256 で同じファイルかを確かめる）。
 * そのため、フォームは React の form action で送らない（送信のあとに入力が初期化され、選んだファイルが消えるため）。
 * 拠点コードの対応付けは利用者が選ぶ（既定値を出さない）。列の対応は見出しの語から既定値を出す。
 */

export interface BaselineFieldOption {
  key: BaselineMappingKey;
  label: string;
  required: boolean;
}

export interface BaselineSiteChoice {
  id: string;
  code: string;
  name: string;
  countryCode: string | null;
}

interface Props {
  periodId: string;
  fields: readonly BaselineFieldOption[];
  units: readonly BaselineSiteChoice[];
  /** 差し替えの候補（同じ期間の既存の算定結果） */
  existing: ReadonlyArray<{ id: string; label: string }>;
  emissionUnits: readonly string[];
  granularityLabels: Readonly<Record<BaselineGranularity, string>>;
  scopeLabels: Readonly<Record<GhgScope, string>>;
  excludedValue: string;
  maxRows: number;
  /** Demo の架空のサンプル（Supabase Mode は null） */
  sample: { href: string; label: string } | null;
}

const IDLE: BaselineImportState = { status: 'idle' };

/** 設定の比較の鍵（空の値を落とし、キーを並べる） */
function settingsKey(settings: {
  mapping: Partial<Record<string, string>>;
  decimalSeparator: string | null;
  defaultEmissionsUnit: string | null;
  sites: Record<string, string>;
}): string {
  const sorted = (record: Partial<Record<string, string>>) =>
    Object.entries(record)
      .filter(([, value]) => !!value)
      .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([
    sorted(settings.mapping),
    settings.decimalSeparator ?? '',
    settings.defaultEmissionsUnit ?? '',
    sorted(settings.sites),
  ]);
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

export function BaselineImportForm(props: Props) {
  const { fields, units, emissionUnits, granularityLabels, scopeLabels, excludedValue } = props;
  const formRef = React.useRef<HTMLFormElement>(null);
  const [previewState, previewDispatch, previewPending] = React.useActionState(
    previewBaselineImportAction,
    IDLE,
  );
  const [confirmState, confirmDispatch, confirmPending] = React.useActionState(
    confirmBaselineImportAction,
    IDLE,
  );
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [mapping, setMapping] = React.useState<Partial<Record<BaselineMappingKey, string>>>({});
  const [decimalSeparator, setDecimalSeparator] = React.useState('');
  const [defaultUnit, setDefaultUnit] = React.useState('');
  const [sites, setSites] = React.useState<Record<string, string>>({});
  const [label, setLabel] = React.useState('');
  const [supersedesId, setSupersedesId] = React.useState('');
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const preview: BaselinePreview | null =
    previewState.status === 'ok' ? previewState.preview : null;

  // サーバーが検証に使った設定を画面の選択に写す（最初の検証では見出しから出した既定値）
  React.useEffect(() => {
    if (previewState.status !== 'ok') return;
    const settings: BaselineImportSettings = previewState.preview.settings;
    setMapping(settings.mapping);
    setDecimalSeparator(settings.decimalSeparator ?? '');
    setDefaultUnit(settings.defaultEmissionsUnit ?? '');
    setSites(settings.sites);
    setLabel((current) =>
      current !== ''
        ? current
        : previewState.preview.fileName.replace(/\.[^.]+$/, '').slice(0, 100),
    );
  }, [previewState]);

  const unitColumnChosen = !!mapping.emissionsUnit;
  // 送る値と同じ形で比べる（単位の列を選んでいるときの単位の欄は無効で、送られない）
  const currentKey = settingsKey({
    mapping,
    decimalSeparator: decimalSeparator || null,
    defaultEmissionsUnit: unitColumnChosen ? null : defaultUnit || null,
    sites,
  });
  const validatedKey = preview ? settingsKey(preview.settings) : null;
  const stale = preview !== null && currentKey !== validatedKey;
  const validation = preview && !stale ? preview.validation : null;
  const ready =
    validation !== null && validation.blockers.length === 0 && label.trim() !== '' && !stale;

  const submitPreview = (step: 'inspect' | 'validate') => {
    const form = formRef.current;
    if (!form) return;
    const data = new FormData(form);
    data.set('step', step);
    React.startTransition(() => previewDispatch(data));
  };

  const onFileChosen = (files: FileList | null) => {
    const file = files?.[0];
    setFileName(file?.name ?? null);
    setLabel('');
    setSites({});
    if (file) submitPreview('inspect');
  };

  const confirm = async () => {
    const form = formRef.current;
    if (!form) return;
    const data = new FormData(form);
    React.startTransition(() => confirmDispatch(data));
  };

  const steps: StepItem[] = [
    { key: 'file', label: 'ファイル', state: preview ? 'done' : 'current' },
    {
      key: 'mapping',
      label: '列の対応と拠点の対応付け',
      state: !preview ? 'todo' : validation ? 'done' : 'current',
    },
    {
      key: 'validate',
      label: '検証',
      state: !validation ? 'todo' : validation.blockers.length > 0 ? 'current' : 'done',
    },
    { key: 'confirm', label: '確定', state: ready ? 'current' : 'todo' },
  ];

  const unitById = new Map(units.map((u) => [u.id, u]));
  const siteLabel = (choice: string): string => {
    if (choice === excludedValue) return '照合に使わない';
    const unit = unitById.get(choice);
    return unit ? `${unit.name}（${unit.code}）` : '—';
  };

  return (
    <div className="space-y-3">
      <StepNav ariaLabel="既存の算定結果の取込の段階" steps={steps} />
      <form
        ref={formRef}
        className="space-y-3"
        // 入力の検査はサーバーの検証で行う（ブラウザの必須の検査で「検証する」が止まると、
        // 確定できない理由の一覧を見られないため）
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submitPreview('validate');
        }}
      >
        <input type="hidden" name="periodId" value={props.periodId} />
        <input type="hidden" name="sha256" value={preview?.sha256 ?? ''} />
        <FileDropZone
          inputId="baseline-file"
          onFilesDropped={(files) => onFileChosen(files)}
          className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-t4d-lg border-2 border-dashed border-line bg-surface-muted px-4 py-5 text-center transition-colors hover:border-brand-400 hover:bg-brand-50"
        >
          <FileUp className="size-5 text-brand-600" aria-hidden="true" />
          <span className="text-body font-medium text-ink">
            既存の算定結果のファイルを選ぶ（クリック）／ここへドロップ
          </span>
          <span className="text-caption text-ink-muted">
            CSV（.csv・.tsv・.txt）か Excel（.xlsx・.xlsm）・5MB まで・{props.maxRows} 行まで。
            ファイルは保存せず、sha256 と行を残します
          </span>
          <input
            id="baseline-file"
            type="file"
            name="file"
            accept=".csv,.tsv,.txt,.xlsx,.xlsm,text/csv,text/tab-separated-values,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            onChange={(event) => onFileChosen(event.currentTarget.files)}
          />
        </FileDropZone>
        {props.sample && (
          <p className="text-caption text-ink-muted">
            試すときは架空のサンプルを使えます:{' '}
            <a
              href={props.sample.href}
              download=""
              className="inline-flex items-center gap-1 text-brand-700 underline-offset-2 hover:underline"
            >
              <Download className="size-3" aria-hidden="true" />
              {props.sample.label}
            </a>
          </p>
        )}
        {fileName && (
          <p role="status" aria-live="polite" className="text-small text-ink-muted">
            選んだファイル: <span className="text-ink">{fileName}</span>
            {previewPending && '（読み込み中…）'}
          </p>
        )}
        {previewState.status === 'error' && (
          <Notice tone="danger" role="alert">
            {previewState.message}
          </Notice>
        )}

        {preview && (
          <>
            <div className="space-y-1 border-t border-line pt-2">
              <p className="text-small text-ink">
                <span className="font-medium">{preview.fileName}</span>
                <span className="ml-2 text-ink-muted">
                  {preview.sheetName ? `シート「${preview.sheetName}」・` : ''}
                  {preview.totalRows} 行・sha256 {shortSha(preview.sha256)}…
                </span>
              </p>
              {preview.warnings.map((warning) => (
                <p key={warning} className="text-caption text-ink-muted">
                  {warning}
                </p>
              ))}
              {preview.headers.length > 0 && (
                <div className="t4d-scroll-x">
                  <Table>
                    <caption className="sr-only">ファイルの先頭 5 行</caption>
                    <THead>
                      <TR>
                        {preview.headers.map((header) => (
                          <TH key={header} className="normal-case">
                            {header}
                          </TH>
                        ))}
                      </TR>
                    </THead>
                    <TBody>
                      {preview.sampleRows.map((row, index) => (
                        <TR key={index}>
                          {preview.headers.map((header) => (
                            <TD key={header} className="text-caption">
                              {row[header] ?? ''}
                            </TD>
                          ))}
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
              )}
            </div>

            <FormSection
              title="列の対応"
              kind="required"
              description="見出しの語から既定値を選んでいます。違っていれば直してください。活動・月・排出係数などの列があると、差の原因を細かく分けられます。"
            >
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                {fields.map((field) => (
                  <Field
                    key={field.key}
                    id={`baseline-map-${field.key}`}
                    label={field.label}
                    required={field.required}
                  >
                    {(control) => (
                      <NativeSelect
                        {...control}
                        name={`map:${field.key}`}
                        value={mapping[field.key] ?? ''}
                        onChange={(event) =>
                          setMapping((current) => ({ ...current, [field.key]: event.target.value }))
                        }
                      >
                        <option value="">（使わない）</option>
                        {preview.headers.map((header) => (
                          <option key={header} value={header}>
                            {header}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </Field>
                ))}
                <Field
                  id="baseline-decimal-separator"
                  label="小数点の記号"
                  hint="選ばなければ「3.741」のような数は読みません（1/1000 の誤読を防ぐため）"
                >
                  {(control) => (
                    <NativeSelect
                      {...control}
                      name="decimalSeparator"
                      value={decimalSeparator}
                      onChange={(event) => setDecimalSeparator(event.target.value)}
                    >
                      <option value="">選ばない</option>
                      {DECIMAL_SEPARATORS.map((separator) => (
                        <option key={separator} value={separator}>
                          {DECIMAL_SEPARATOR_LABELS[separator]}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
                <Field
                  id="baseline-default-unit"
                  label="排出量の単位（単位の列が無いとき）"
                  hint={
                    unitColumnChosen ? '単位の列を使います' : '単位の列が無ければ選んでください'
                  }
                >
                  {(control) => (
                    <NativeSelect
                      {...control}
                      name="defaultEmissionsUnit"
                      value={unitColumnChosen ? '' : defaultUnit}
                      disabled={unitColumnChosen}
                      onChange={(event) => setDefaultUnit(event.target.value)}
                    >
                      <option value="">選ばない</option>
                      {emissionUnits.map((unit) => (
                        <option key={unit} value={unit}>
                          {unit}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
              </div>
            </FormSection>

            <FormSection
              title="拠点の対応付け"
              kind="required"
              description="ファイルの拠点コードごとに、対応する拠点を選んでください（推測で決めません）。照合に使わない拠点コードは「照合に使わない」を選びます。"
            >
              {preview.siteCodes.length === 0 ? (
                <p className="text-small text-ink-muted">
                  拠点コードの列を選んで「検証する」を押すと、ファイルの拠点コードが並びます。
                </p>
              ) : (
                <Table>
                  <caption className="sr-only">拠点コードの対応付け</caption>
                  <THead>
                    <TR>
                      <TH>拠点コード</TH>
                      <TH align="right">行数</TH>
                      <TH>対応する拠点（必須）</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {preview.siteCodes.map(({ code, rows }) => (
                      <TR key={code}>
                        <TD className="font-mono">{code}</TD>
                        <TD align="right" className="tnum">
                          {rows}
                        </TD>
                        <TD>
                          <NativeSelect
                            name={`site:${code}`}
                            value={sites[code] ?? ''}
                            aria-label={`拠点コード ${code} の対応付け`}
                            onChange={(event) =>
                              setSites((current) => ({ ...current, [code]: event.target.value }))
                            }
                          >
                            <option value="">選んでください</option>
                            {units.map((unit) => (
                              <option key={unit.id} value={unit.id}>
                                {`${unit.name}（${unit.code}${unit.countryCode ? `・${unit.countryCode}` : ''}）`}
                              </option>
                            ))}
                            <option value={excludedValue}>照合に使わない</option>
                          </NativeSelect>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </FormSection>

            <div className="flex flex-wrap items-center gap-2">
              <SubmitButton
                variant={validation && validation.blockers.length === 0 ? 'secondary' : 'primary'}
                size="sm"
                icon={<ListChecks aria-hidden="true" />}
                aria-busy={previewPending || undefined}
                disabled={previewPending}
              >
                {previewPending ? '検証中…' : '検証する'}
              </SubmitButton>
              {stale && (
                <span className="text-caption text-warning-ink" role="status">
                  設定を変えました。「検証する」を押して検証し直してください。
                </span>
              )}
            </div>

            {validation && (
              <section aria-label="検証の結果" className="space-y-2 border-t border-line pt-2">
                <h3 className="text-small font-semibold text-ink">検証の結果</h3>
                <ul className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-small md:grid-cols-3">
                  <li>
                    取り込む行 <span className="tnum font-medium">{validation.rowCount}</span> 行
                    （照合に使う {validation.mappedRows}・使わない {validation.excludedRows}）
                  </li>
                  <li>粒度: {granularityLabels[validation.granularity]}</li>
                  <li>
                    区分: {validation.scopes.map((scope) => scopeLabels[scope]).join('・') || '—'}
                  </li>
                  <li>
                    丸めの記述: 読めた {validation.rounding.parsed}・読めない{' '}
                    {validation.rounding.unreadable}・なし {validation.rounding.empty}
                  </li>
                  <li>読めない行 {validation.errorCount} 件</li>
                </ul>
                {validation.rounding.unreadable > 0 && (
                  <Notice tone="info">
                    丸めの記述を読めない行は、照合で「丸め」の原因を当てません（差は残差に入ります）。
                  </Notice>
                )}
                {validation.errors.length > 0 && (
                  <Notice tone="danger" title="読めない行">
                    <ul className="list-disc pl-4">
                      {validation.errors.map((error) => (
                        <li key={`${error.rowNo}-${error.message}`}>
                          {error.rowNo > 0 ? `${error.rowNo} 行目: ` : ''}
                          {error.message}
                        </li>
                      ))}
                      {validation.errorCount > validation.errors.length && (
                        <li>ほか {validation.errorCount - validation.errors.length} 件</li>
                      )}
                    </ul>
                  </Notice>
                )}
                {validation.blockers.length > 0 ? (
                  <Notice tone="warning" title="このままでは確定できません">
                    <ul className="list-disc pl-4">
                      {validation.blockers.map((blocker) => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                    </ul>
                  </Notice>
                ) : (
                  <p className="flex items-center gap-1 text-small text-ink">
                    <CheckCircle2 className="size-3.5 text-success" aria-hidden="true" />
                    確定できます。名前を確かめて「確定する…」を押してください。
                  </p>
                )}
              </section>
            )}

            <div className="grid grid-cols-1 gap-2 border-t border-line pt-2 md:grid-cols-3">
              <Field
                id="baseline-label"
                label="既存の算定結果の名前"
                required
                hint="照合の画面と出力に出す名前（100 字まで）"
              >
                {(control) => (
                  <Input
                    {...control}
                    name="label"
                    maxLength={100}
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                  />
                )}
              </Field>
              {props.existing.length > 0 && (
                <Field
                  id="baseline-supersedes"
                  label="差し替える既存の算定結果"
                  hint="前の取込は残ります（差し替えの記録を付けます）"
                >
                  {(control) => (
                    <NativeSelect
                      {...control}
                      name="supersedesId"
                      value={supersedesId}
                      onChange={(event) => setSupersedesId(event.target.value)}
                    >
                      <option value="">差し替えない（新しく取り込む）</option>
                      {props.existing.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
              )}
            </div>
          </>
        )}
      </form>

      {preview && (
        <div className="flex flex-wrap items-center gap-2">
          <ConfirmDialog
            tier="bulk"
            title="既存の算定結果を確定しますか"
            scope={`${preview.fileName}（sha256 ${shortSha(preview.sha256)}…）を「${label.trim() || '（名前なし）'}」として取り込みます`}
            consequences={[
              '追記で残ります（取り込んだ後は変更できません。直すときは差し替えとして取り込み直します）。',
              'ファイルそのものは保存しません。sha256 と読み取った行を残します。',
              '照合の許容差はこの後、照合するときに入れます（既定値はありません）。',
            ]}
            preview={
              validation ? (
                <div className="space-y-1 rounded-t4d bg-surface-muted px-2 py-1.5">
                  <p>
                    取り込む行 {validation.rowCount} 行（粒度:{' '}
                    {granularityLabels[validation.granularity]}）
                  </p>
                  <ul className="list-disc pl-4 text-caption">
                    {Object.entries(sites).map(([code, choice]) => (
                      <li key={code}>
                        {code} → {siteLabel(choice)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null
            }
            confirmLabel="確定する"
            action={confirm}
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            trigger={{
              label: confirmPending ? '確定中…' : '確定する…',
              variant: ready ? 'primary' : 'secondary',
              disabled: !ready || confirmPending,
              icon: <CheckCircle2 aria-hidden="true" />,
              actionId: 'confirm-baseline-import',
            }}
          />
          {!ready && (
            <span className="text-caption text-ink-muted">
              検証して確定できる状態になり、名前を入れると押せます。
            </span>
          )}
        </div>
      )}
      {confirmState.status === 'error' && (
        <Notice tone="danger" role="alert">
          {confirmState.message}
        </Notice>
      )}
    </div>
  );
}
