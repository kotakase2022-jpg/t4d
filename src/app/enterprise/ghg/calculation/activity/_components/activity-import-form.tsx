'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { FileUp, Loader2, ShieldCheck, Upload } from 'lucide-react';
import { FileDropZone } from '@/components/shared/file-drop-zone';
import { GhgNotice, LoadFactorNotice } from '@/components/shared/ghg-notices';
import { Notice } from '@/components/shared/notice';
import { SemanticBadge, StatusBadge } from '@/components/shared/status-badge';
import { StepNav, type StepItem } from '@/components/shared/step-nav';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { NativeSelect } from '@/components/ui/native-select';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { DECIMAL_SEPARATOR_LABELS, DECIMAL_SEPARATORS } from '@/lib/domain/ghg/number-format';
import { formatNumber } from '@/lib/format/datetime';
import type { ActivityImportPreview, ActivityPreviewRow } from '@/lib/services/ghg/activity-import';
import { GHG_BATCH_KINDS, type GhgBatchKind } from '@/types/domain';
import { importActivityFileAction, previewActivityImportAction } from '../actions';
import {
  activityMappingFields,
  type ActivityMappingField,
  type ActivityMappingSelection,
} from '../_lib/activity-mapping';
import {
  BATCH_KIND_DESCRIPTIONS,
  BATCH_KIND_LABELS,
  carrierKindLabel,
  economyClassLabel,
  monthLabel,
} from '../_lib/labels';

/**
 * 活動量の取込（P94 の CreatePanel の中。plan §2.4 P94・CR-05）。
 *
 * 段階（StepNav）: 種類と拠点 → ファイル → 列の対応 → 検証 → 確定（確定は取込の後、バッチの詳細の画面で行う）。
 * 主操作は段階ごとに 1 つ（検証の前は「検証する」、検証を通ったら「取り込む」。検証し直しは副操作）。
 *
 * 入力（選んだファイル・列の対応）は検証・取込に失敗しても消さない。そのため <form action> の自動リセットは
 * 使わず、Server Action を関数として呼ぶ。取込ではファイルを送り直し、サーバーが同じ規則で検証し直す
 * （検証の結果は Cookie にもサーバーにも残さない。検証したファイルと同じかは sha256 で確かめる）。
 * 検証の後に種類・拠点・差し替え・ファイル・列の対応・小数点の記号を変えたら、もう一度検証するまで取り込めない。
 */

export interface ImportUnitOption {
  id: string;
  code: string;
  name: string;
  countryCode: string;
  overseas: boolean;
  verification: boolean;
}

export interface ReplaceableBatch {
  batchId: string;
  unitId: string;
  kind: GhgBatchKind;
  label: string;
}

const NETWORK_FAILURE =
  '通信に失敗しました（サーバーに届いていない可能性があります）。選んだファイルと列の対応は残しています。もう一度お試しください。';

const NONE = '';

function inputsKey(state: {
  kind: GhgBatchKind;
  unitId: string;
  replaceBatchId: string;
  file: File | null;
  mapping: ActivityMappingSelection | null;
  decimalSeparator: string;
}): string {
  return JSON.stringify({
    kind: state.kind,
    unitId: state.unitId,
    replace: state.replaceBatchId,
    file: state.file ? [state.file.name, state.file.size, state.file.lastModified] : null,
    mapping: state.mapping,
    decimalSeparator: state.decimalSeparator,
  });
}

function t(value: number | null, fraction = 6): string {
  return value === null ? '—' : formatNumber(value, { fraction });
}

function RowNotes({ row }: { row: ActivityPreviewRow }) {
  if (row.error) {
    return (
      <SemanticBadge
        semantic="error"
        label="読めません"
        detail={row.error}
        className="max-w-full"
      />
    );
  }
  return (
    <span className="flex flex-wrap gap-1">
      {row.warnings.map((w) => (
        <SemanticBadge key={w} semantic="blocked" label={w} />
      ))}
      {row.trialError && (
        <SemanticBadge semantic="info" label="試算できません" detail={row.trialError} />
      )}
      {row.warnings.length === 0 && !row.trialError && (
        <span className="text-caption text-ink-muted">—</span>
      )}
    </span>
  );
}

function PreviewTable({ preview }: { preview: ActivityImportPreview }) {
  if (preview.rows.length === 0) return null;
  const transport = preview.kind === 'transport';
  return (
    <div className="t4d-scroll-x">
      <Table>
        <caption className="sr-only">検証の結果（行ごと）</caption>
        <THead>
          <TR>
            <TH align="right">行</TH>
            <TH>月</TH>
            {transport ? (
              <>
                <TH>出荷番号</TH>
                <TH>区分・燃料</TH>
                <TH align="right">
                  <span className="normal-case">t·km</span>
                </TH>
                <TH align="right">最大積載量（kg）</TH>
                <TH align="right">積載率（%）</TH>
                <TH>燃費の区分</TH>
              </>
            ) : (
              <>
                <TH>活動</TH>
                <TH align="right">量</TH>
                <TH>単位</TH>
              </>
            )}
            <TH align="right">
              試算 <span className="normal-case">t-CO2</span>（未丸め）
            </TH>
            <TH>印</TH>
          </TR>
        </THead>
        <TBody>
          {preview.rows.map((row) => (
            <TR key={row.rowNo} data-row-error={row.error ? '' : undefined}>
              <TD align="right" className="tnum">
                {row.rowNo}
              </TD>
              <TD className="tnum">{monthLabel(row.month)}</TD>
              {transport ? (
                <>
                  <TD className="text-caption">{row.transport?.shipmentRef ?? '—'}</TD>
                  <TD className="text-small">
                    {row.transport
                      ? `${carrierKindLabel(row.transport.carrierKind)}・${row.activity}`
                      : row.activity}
                  </TD>
                  <TD align="right" className="tnum">
                    {t(row.transport?.tonKm ?? null, 3)}
                  </TD>
                  <TD align="right" className="tnum">
                    {t(row.transport?.maxPayloadKg ?? null, 0)}
                  </TD>
                  <TD align="right">
                    <span className="inline-flex items-center gap-1">
                      <span className="tnum">{t(row.transport?.loadFactorPct ?? null, 2)}</span>
                      {row.loadFactorSource && (
                        <StatusBadge domain="ghgLoadFactorSource" value={row.loadFactorSource} />
                      )}
                    </span>
                  </TD>
                  <TD className="text-small">
                    {economyClassLabel(row.transport?.fuelEconomyClass ?? null)}
                  </TD>
                </>
              ) : (
                <>
                  <TD className="text-small">{row.activity}</TD>
                  <TD align="right" className="tnum">
                    {t(row.amount, 4)}
                  </TD>
                  <TD className="text-small">{row.unit ?? '—'}</TD>
                </>
              )}
              <TD align="right" className="tnum">
                {t(row.trialT)}
              </TD>
              <TD>
                <RowNotes row={row} />
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

function PreviewSummary({ preview }: { preview: ActivityImportPreview }) {
  const transport = preview.kind === 'transport';
  const items: Array<[string, string]> = [
    ['行', `${preview.rowCount} 行`],
    ['取り込める行', `${preview.validCount} 行`],
    ['読めない行', `${preview.errorCount} 行`],
    ['警告のある行', `${preview.warningCount} 行`],
  ];
  if (transport) {
    items.push(
      ['見なし積載率', `${preview.counts.defaultLoad} 行`],
      ['下限を適用', `${preview.counts.floored} 行`],
      ['最大積載量が範囲外', `${preview.counts.payloadOutOfRange} 行`],
    );
  }
  items.push(['試算できない行', `${preview.counts.errors} 行`]);
  return (
    <dl
      className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-t4d border border-line bg-surface-muted px-3 py-2 text-small sm:grid-cols-4"
      data-activity-preview-summary=""
    >
      {items.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-2">
          <dt className="text-ink-muted">{label}</dt>
          <dd className="tnum font-medium text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ActivityImportForm({
  periodId,
  periodLabel,
  units,
  replaceable,
  demo,
  demoLimits,
  sampleLinks,
}: {
  periodId: string;
  periodLabel: string;
  units: ImportUnitOption[];
  replaceable: ReplaceableBatch[];
  demo: boolean;
  demoLimits: { batches: number; lines: number };
  sampleLinks: Array<{ kind: string; label: string; href: string }>;
}) {
  const router = useRouter();
  const [kind, setKind] = React.useState<GhgBatchKind>('transport');
  const [unitId, setUnitId] = React.useState<string>(units[0]?.id ?? '');
  const [replaceBatchId, setReplaceBatchId] = React.useState<string>(NONE);
  const [file, setFile] = React.useState<File | null>(null);
  // null は「列名から提案する」（最初の検証）。検証の後はサーバーが返した対応を初期値にする
  const [mapping, setMapping] = React.useState<ActivityMappingSelection | null>(null);
  const [decimalSeparator, setDecimalSeparator] = React.useState<string>(NONE);
  const [preview, setPreview] = React.useState<ActivityImportPreview | null>(null);
  const [previewKey, setPreviewKey] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<'preview' | 'import' | null>(null);

  const unit = units.find((u) => u.id === unitId) ?? null;
  const replaceOptions = replaceable.filter((b) => b.unitId === unitId && b.kind === kind);
  const currentKey = inputsKey({ kind, unitId, replaceBatchId, file, mapping, decimalSeparator });
  const fresh = preview !== null && previewKey === currentKey;
  const canImport = fresh && preview.canImport;

  const resetPreview = () => {
    setPreview(null);
    setPreviewKey(null);
    setMessage(null);
  };

  function formDataFor(extra: Record<string, string> = {}): FormData | null {
    if (!file) return null;
    const fd = new FormData();
    fd.set('periodId', periodId);
    fd.set('unitId', unitId);
    fd.set('kind', kind);
    fd.set('replaceBatchId', replaceBatchId);
    fd.set('file', file);
    fd.set('mapping', mapping === null ? '' : JSON.stringify(mapping));
    fd.set('decimalSeparator', decimalSeparator);
    for (const [key, value] of Object.entries(extra)) fd.set(key, value);
    return fd;
  }

  async function runPreview() {
    const fd = formDataFor();
    if (!fd) {
      setMessage('ファイルを選んでください。');
      return;
    }
    setPending('preview');
    setMessage(null);
    try {
      const result = await previewActivityImportAction(fd);
      if (!result.ok) {
        setPreview(null);
        setPreviewKey(null);
        setMessage(result.message);
        return;
      }
      // サーバーが使った対応（提案を含む）を画面の対応にする。同じ入力の鍵で「検証済み」とみなす
      const used = result.preview.mapping;
      setMapping(used);
      setPreview(result.preview);
      setPreviewKey(
        inputsKey({ kind, unitId, replaceBatchId, file, mapping: used, decimalSeparator }),
      );
    } catch {
      setMessage(NETWORK_FAILURE);
    } finally {
      setPending(null);
    }
  }

  async function runImport() {
    if (!preview || !canImport) return;
    const fd = formDataFor({ expectedSha256: preview.file.sha256 });
    if (!fd) return;
    setPending('import');
    setMessage(null);
    try {
      const result = await importActivityFileAction(fd);
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      router.push(result.href);
    } catch {
      setMessage(NETWORK_FAILURE);
    } finally {
      setPending(null);
    }
  }

  const fields = activityMappingFields(kind);
  const headers = preview?.headers ?? [];
  const mappingDone = preview !== null && preview.mappingProblems.length === 0;
  const steps: StepItem[] = [
    { key: 'kind', label: '種類と拠点', state: 'done' },
    { key: 'file', label: 'ファイル', state: file ? 'done' : 'current' },
    {
      key: 'mapping',
      label: '列の対応',
      state: !file ? 'todo' : mappingDone && fresh ? 'done' : 'current',
    },
    {
      key: 'verify',
      label: '検証',
      state: canImport ? 'done' : fresh ? 'current' : 'todo',
    },
    {
      key: 'confirm',
      label: '確定',
      state: canImport ? 'current' : 'todo',
      note: '取り込んだ後、詳細の画面で確定します',
    },
  ];

  return (
    <div className="space-y-3" data-activity-import="">
      <StepNav ariaLabel="活動量の取込の段階" steps={steps} />

      <div className="grid gap-2 md:grid-cols-3">
        <Field label="種類" name="kind" required hint={BATCH_KIND_DESCRIPTIONS[kind]}>
          {(p) => (
            <NativeSelect
              {...p}
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as GhgBatchKind);
                setReplaceBatchId(NONE);
                setMapping(null);
                resetPreview();
              }}
            >
              {GHG_BATCH_KINDS.map((k) => (
                <option key={k} value={k}>
                  {BATCH_KIND_LABELS[k]}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field
          label="拠点"
          name="unitId"
          required
          hint={`期間 ${periodLabel}。担当の拠点だけを選べます`}
        >
          {(p) => (
            <NativeSelect
              {...p}
              value={unitId}
              onChange={(event) => {
                setUnitId(event.target.value);
                setReplaceBatchId(NONE);
                resetPreview();
              }}
            >
              {units.some((u) => u.verification) && (
                <optgroup label="算定の検証拠点">
                  {units
                    .filter((u) => u.verification)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}（{u.code}・{u.countryCode}）
                      </option>
                    ))}
                </optgroup>
              )}
              {units.some((u) => !u.verification) && (
                <optgroup label="その他の拠点">
                  {units
                    .filter((u) => !u.verification)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}（{u.code}・{u.countryCode}）
                      </option>
                    ))}
                </optgroup>
              )}
            </NativeSelect>
          )}
        </Field>
        <Field
          label="取り込み方"
          name="replaceBatchId"
          required
          hint="差し替えは、確定済みのバッチを丸ごと置き換えます（ファイルに無い月は算定に使われなくなります）"
        >
          {(p) => (
            <NativeSelect
              {...p}
              value={replaceBatchId}
              onChange={(event) => {
                setReplaceBatchId(event.target.value);
                resetPreview();
              }}
            >
              <option value={NONE}>追加（新しいバッチとして足す）</option>
              {replaceOptions.map((b) => (
                <option key={b.batchId} value={b.batchId}>
                  差し替え: {b.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      </div>

      {unit?.overseas && kind === 'transport' && <GhgNotice id="N5" />}

      <FileDropZone
        inputId="activity-file"
        onFilesDropped={(files) => {
          setFile(files[0] ?? null);
          setMapping(null);
          resetPreview();
        }}
        className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-t4d-lg border-2 border-dashed border-line bg-surface-muted px-4 py-4 text-center transition-colors hover:border-brand-400 hover:bg-brand-50"
      >
        <FileUp className="size-5 text-brand-600" aria-hidden="true" />
        <span className="text-body font-medium text-ink">
          {file ? `選んだファイル: ${file.name}` : 'クリックしてファイルを選択／ここへドロップ'}
        </span>
        <span className="text-caption text-ink-muted">
          .csv / .tsv / .xlsx（5MB まで）。1 行目が見出しの表
          {demo &&
            `。デモでは 1 回 ${demoLimits.lines} 行まで・取込は ${demoLimits.batches} 回まで`}
        </span>
        <input
          id="activity-file"
          type="file"
          name="file"
          accept=".csv,.tsv,.txt,.xlsx,.xlsm,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="sr-only"
          onChange={(event) => {
            setFile(event.currentTarget.files?.[0] ?? null);
            setMapping(null);
            resetPreview();
          }}
        />
      </FileDropZone>
      {sampleLinks.length > 0 && (
        <p className="text-caption text-ink-muted">
          架空のサンプル:{' '}
          {sampleLinks.map((link, index) => (
            <React.Fragment key={link.kind}>
              {index > 0 && '・'}
              <a href={link.href} download className="text-brand-700 hover:underline">
                {link.label}
              </a>
            </React.Fragment>
          ))}
        </p>
      )}

      {preview && (
        <section aria-labelledby="activity-mapping-title" className="space-y-2">
          <h3 id="activity-mapping-title" className="text-body font-semibold text-ink">
            列の対応
            {preview.mappingSuggested && (
              <span className="ml-2 text-caption font-normal text-ink-muted">
                列名から提案しました。違っていれば選び直して、もう一度検証してください。
              </span>
            )}
          </h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {fields.map((field) => (
              <div key={field.key} data-mapping-field={field.key}>
                <Field
                  label={field.label}
                  id={`mapping-${field.key}`}
                  required={field.need === 'required'}
                  hint={field.hint}
                >
                  {(p) => (
                    <NativeSelect
                      {...p}
                      size="xs"
                      value={mapping?.[field.key] ?? NONE}
                      onChange={(event) => {
                        const value = event.target.value;
                        setMapping((prev) => {
                          const next: ActivityMappingSelection = { ...(prev ?? {}) };
                          if (value === NONE) delete next[field.key as ActivityMappingField];
                          else next[field.key as ActivityMappingField] = value;
                          return next;
                        });
                      }}
                    >
                      <option value={NONE}>（使わない）</option>
                      {headers.map((header) => (
                        <option key={header} value={header}>
                          {header}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
              </div>
            ))}
            <Field
              label="小数点の記号"
              name="decimalSeparator"
              hint="「3.741」のように小数か桁区切りか分からない数は、選ぶまで読みません"
            >
              {(p) => (
                <NativeSelect
                  {...p}
                  size="xs"
                  value={decimalSeparator}
                  onChange={(event) => setDecimalSeparator(event.target.value)}
                >
                  <option value={NONE}>選ばない（曖昧な数は読まない）</option>
                  {DECIMAL_SEPARATORS.map((s) => (
                    <option key={s} value={s}>
                      {DECIMAL_SEPARATOR_LABELS[s]}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
          </div>
          {preview.mappingProblems.length > 0 && (
            <Notice tone="danger" role="alert" title="列の対応を直してください">
              <ul className="list-disc space-y-0.5 pl-4">
                {preview.mappingProblems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Notice>
          )}
        </section>
      )}

      {message && (
        <Notice tone="danger" role="alert">
          {message}
        </Notice>
      )}

      {preview && (
        <section aria-labelledby="activity-verify-title" className="space-y-2">
          <h3
            id="activity-verify-title"
            className="flex items-center gap-2 text-body font-semibold text-ink"
          >
            検証の結果
            {fresh ? (
              preview.canImport ? (
                <SemanticBadge semantic="done" label="取り込めます" />
              ) : (
                <SemanticBadge semantic="error" label="取り込めません" />
              )
            ) : (
              <SemanticBadge
                semantic="pending"
                label="入力を変えました。もう一度検証してください"
              />
            )}
          </h3>
          <p className="text-caption text-ink-muted">
            {preview.file.name}（sha256 {preview.file.sha256.slice(0, 12)}…）・{preview.unit.name}（
            {preview.unit.code}・{preview.unit.countryCode}）・{BATCH_KIND_LABELS[preview.kind]}
            {preview.months.length > 0 &&
              `・${monthLabel(preview.months[0]!)}〜${monthLabel(preview.months[preview.months.length - 1]!)}`}
          </p>
          <PreviewSummary preview={preview} />
          {preview.blockers.length > 0 && (
            <Notice tone="danger" role="alert" title="取り込めない理由">
              <ul className="list-disc space-y-0.5 pl-4">
                {preview.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </Notice>
          )}
          {preview.policyMissing && (
            <Notice tone="warning" title="算定方針がありません">
              この期間の算定方針（丸め・換算・改良トンキロ法の設定）が無いため、試算と下限の判定ができません。取込はできます。算定ルールの画面で保存してから算定してください。
            </Notice>
          )}
          {preview.kind === 'transport' && preview.minLoadPct !== null && (
            <LoadFactorNotice
              defaultRows={preview.counts.defaultLoad}
              minLoadPct={preview.minLoadPct}
              flooredRows={preview.counts.floored}
            />
          )}
          {preview.unit.overseas && preview.kind === 'transport' && preview.counts.overseas > 0 && (
            <Notice tone="info" title="海外拠点の輸送の印">
              {preview.counts.overseas}{' '}
              行に「海外拠点の輸送（国内の方法を適用）」の印を付けて試算しました（組織の算定方針の設定）。
            </Notice>
          )}
          {preview.replace && (
            <Notice tone="warning" title="差し替えると算定に使わなくなる行があります">
              確定すると「{preview.replace.fileName}」（{preview.replace.rowCount}{' '}
              行）を差し替え済みにします。
              {preview.replace.droppedLines > 0
                ? `このファイルに無い月（${preview.replace.droppedMonths.map(monthLabel).join('・')}）の ${preview.replace.droppedLines} 行は算定に使われなくなります。`
                : 'このファイルに無い月の行はありません。'}
            </Notice>
          )}
          {!preview.replace && preview.overlaps > 0 && (
            <Notice tone="warning" title="確定済みの活動量と重なる行があります">
              確定済みの活動量と同じ月・活動（輸送は出荷番号）の行が {preview.overlaps}{' '}
              行あります。追加すると両方が算定に入ります。訂正なら「取り込み方」で差し替えを選んでください。
            </Notice>
          )}
          <PreviewTable preview={preview} />
          {preview.rowCount > preview.rows.length && (
            <p className="text-caption text-ink-muted">
              先頭の {preview.rows.length} 行を表示しています（件数は全 {preview.rowCount}{' '}
              行で数えています）。
            </p>
          )}
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
        <Button
          variant={canImport ? 'secondary' : 'primary'}
          size="sm"
          onClick={runPreview}
          disabled={pending !== null || !file}
          aria-busy={pending === 'preview' || undefined}
          data-action-id="verify-activity"
        >
          {pending === 'preview' ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <ShieldCheck aria-hidden="true" />
          )}
          {pending === 'preview' ? '検証中…' : preview ? '検証し直す' : '検証する'}
        </Button>
        {canImport && (
          <Button
            variant="primary"
            size="sm"
            onClick={runImport}
            disabled={pending !== null}
            aria-busy={pending === 'import' || undefined}
            data-action-id="import-activity-file"
          >
            {pending === 'import' ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <Upload aria-hidden="true" />
            )}
            {pending === 'import'
              ? '取り込み中…'
              : `取り込む（${preview.validCount} 行・確認中として保存）`}
          </Button>
        )}
        <span className="text-caption text-ink-muted">
          {canImport
            ? '取り込むと「確認中」のバッチになります。詳細の画面で行と試算を確かめてから確定してください（確定するまで算定には使いません）。'
            : file
              ? '検証は保存しません。読めない行があれば取り込めません（推測で埋めずに止めます）。'
              : '種類と拠点を選び、ファイルを選んでから検証してください。'}
        </span>
      </div>
    </div>
  );
}
