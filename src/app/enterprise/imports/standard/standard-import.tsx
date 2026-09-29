'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ClipboardPaste,
  FileUp,
  Keyboard,
  Loader2,
  RotateCcw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { FileDropZone } from '@/components/shared/file-drop-zone';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { AVAILABILITY_STATUS_LABELS, VALUE_KIND_LABELS } from '@/lib/domain/disclosure-status';
import { cn } from '@/lib/utils';
import type {
  QuantitativeImportCommitResult,
  QuantitativeImportConflict,
  QuantitativeImportPreview,
} from '@/lib/services/quantitative-import';
import {
  AVAILABILITY_STATUSES,
  VALUE_KINDS,
  type AvailabilityStatus,
  type ValueKind,
} from '@/types/domain';
import { commitStandardImportAction, validateStandardImportAction } from './actions';
import { DiffTable, MappingSection, SummarySection } from './import-preview';

/**
 * 数値を登録（標準 CSV・貼り付け・手入力）の操作部品。
 *
 * 手順: ファイル選択 → 列対応 → 検証 → 追加・更新差分 → 登録確定。
 *
 * 入力（選んだファイル・貼り付けた文字・手入力の値）は、検証や確定に失敗しても消さない（A35）。
 * そのため <form action> の自動リセットは使わず、Server Action を関数として呼ぶ。
 * 確定キーは検証結果ごとに 1 つだけ作り、再試行でも同じキーを送る（二重登録しない）。
 */

type SourceKind = 'file' | 'text' | 'manual';

interface ManualState {
  metricCode: string;
  entityCode: string;
  boundaryCode: string;
  availabilityStatus: AvailabilityStatus;
  value: string;
  unit: string;
  valueKind: ValueKind;
  absenceReason: string;
  methodologyCode: string;
  sourceReference: string;
}

type ValidateFeedback = { kind: 'invalid' | 'failure'; message: string } | null;

type CommitFeedback =
  | { kind: 'success'; result: QuantitativeImportCommitResult }
  | { kind: 'conflict'; message: string; conflicts: QuantitativeImportConflict[] }
  | { kind: 'expired' | 'partial' | 'invalid' | 'failure'; message: string }
  | null;

export interface StandardImportProps {
  periods: Array<{ id: string; label: string; startDate: string; endDate: string }>;
  defaultPeriodId: string;
  metrics: Array<{ code: string; name: string; unit: string }>;
  units: Array<{ code: string; name: string }>;
  notations: Array<{ value: string; label: string }>;
  limitsLabel: string;
}

const NETWORK_FAILURE =
  '保存失敗: 通信に失敗しました（サーバーに届いていない可能性があります）。入力内容は保持しています。再試行してください。';

const STEPS = ['ファイル選択', '列対応', '検証', '追加・更新差分', '登録確定'] as const;

function newKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const selectClass =
  'mt-0.5 block h-7 w-full rounded-t4d border border-line bg-surface px-2 text-[13px] text-ink focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-100';

function StepIndicator({ current, done }: { current: number; done: boolean }) {
  return (
    <ol aria-label="登録の手順" className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {STEPS.map((label, index) => {
        const complete = done || index < current;
        const active = !done && index === current;
        return (
          <li
            key={label}
            aria-current={active ? 'step' : undefined}
            className={cn(
              'flex items-center gap-1 text-[12px]',
              active ? 'font-semibold text-brand-800' : complete ? 'text-ink' : 'text-ink-muted',
            )}
          >
            <span
              className={cn(
                'flex size-5 items-center justify-center rounded-full border text-[11px]',
                complete
                  ? 'border-success/40 bg-success-soft text-success'
                  : active
                    ? 'border-brand-300 bg-brand-100 text-brand-900'
                    : 'border-line bg-surface text-ink-muted',
              )}
            >
              {complete ? <Check className="size-3" aria-hidden="true" /> : index + 1}
            </span>
            {label}
            {complete && <span className="sr-only">（完了）</span>}
          </li>
        );
      })}
    </ol>
  );
}

function Alert({
  tone,
  children,
  role = 'alert',
}: {
  tone: 'danger' | 'warning' | 'success';
  children: React.ReactNode;
  role?: 'alert' | 'status';
}) {
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'warning' ? AlertTriangle : XCircle;
  return (
    <div
      role={role}
      aria-live={role === 'status' ? 'polite' : undefined}
      className={cn(
        'flex items-start gap-1.5 rounded-t4d border px-3 py-2 text-[12px] text-ink',
        tone === 'success' && 'border-success/40 bg-success-soft',
        tone === 'warning' && 'border-warning/40 bg-warning-soft',
        tone === 'danger' && 'border-danger/40 bg-danger-soft',
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 size-3.5 shrink-0',
          tone === 'success' && 'text-success',
          tone === 'warning' && 'text-[#8a5d00]',
          tone === 'danger' && 'text-danger',
        )}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
    </div>
  );
}

export function StandardImport({
  periods,
  defaultPeriodId,
  metrics,
  units,
  notations,
  limitsLabel,
}: StandardImportProps) {
  const [sourceKind, setSourceKind] = React.useState<SourceKind>('file');
  const [file, setFile] = React.useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = React.useState(0);
  const [pasted, setPasted] = React.useState('');
  const [manual, setManual] = React.useState<ManualState>({
    metricCode: '',
    entityCode: '',
    boundaryCode: '',
    availabilityStatus: 'value_present',
    value: '',
    unit: '',
    valueKind: 'actual',
    absenceReason: '',
    methodologyCode: '',
    sourceReference: '',
  });
  const [periodId, setPeriodId] = React.useState(defaultPeriodId);
  const [notation, setNotation] = React.useState('auto');

  const [preview, setPreview] = React.useState<QuantitativeImportPreview | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [validateFeedback, setValidateFeedback] = React.useState<ValidateFeedback>(null);

  const [mode, setMode] = React.useState<'all' | 'valid_only'>('all');
  const [confirmExcluded, setConfirmExcluded] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [commitFeedback, setCommitFeedback] = React.useState<CommitFeedback>(null);
  const idempotencyKey = React.useRef<string | null>(null);
  /**
   * 検証したときの元の入力（ファイル・貼り付け・手入力）。確定のときに同じものを送り直す。
   * デモ環境（Vercel）では検証結果がサーバーのメモリにしか無く、確定が別のサーバーに届くと見つからないため、
   * サーバーはこの入力から検証し直し、確認した差分と同じときだけ確定する（解析済みの値は送らない）
   */
  const validatedSource = React.useRef<FormData | null>(null);

  const [validating, startValidate] = React.useTransition();
  const [committing, startCommit] = React.useTransition();
  const resultRef = React.useRef<HTMLDivElement>(null);
  /** 検証の結果の読み上げ（件数とエラーの有無。画面の表示だけでは読み上げ環境で気付けない） */
  const [announcement, setAnnouncement] = React.useState('');
  /**
   * 検証が終わった回数。結果は送信ボタンより下に出るため、フォーカスを結果の見出しへ移して
   * キーボード・読み上げの利用者が結果（エラーの件数）から読み始められるようにする。
   */
  const [validatedCount, setValidatedCount] = React.useState(0);
  React.useEffect(() => {
    if (validatedCount > 0) document.getElementById('standard-summary-title')?.focus();
  }, [validatedCount]);

  const committed = commitFeedback?.kind === 'success';

  const markDirty = () => {
    if (preview && !committed) setDirty(true);
  };

  const updateManual = <K extends keyof ManualState>(key: K, value: ManualState[K]) => {
    setManual((current) => {
      const next = { ...current, [key]: value };
      // 指標を選んだら単位を指標定義の単位にそろえる（換算はしない。違う単位は検証で止まる）
      if (key === 'metricCode') {
        const metric = metrics.find((m) => m.code === value);
        if (metric) next.unit = metric.unit;
      }
      return next;
    });
    markDirty();
  };

  function buildFormData(): FormData | string {
    const fd = new FormData();
    fd.set('source', sourceKind);
    fd.set('reportingPeriodId', periodId);
    fd.set('numberNotation', notation);
    if (sourceKind === 'file') {
      if (!file) return 'CSV ファイルを選んでください。';
      fd.set('file', file);
    } else if (sourceKind === 'text') {
      if (!pasted.trim()) return '貼り付ける内容を入力してください。';
      fd.set('text', pasted);
    } else {
      if (!manual.metricCode) return '指標を選んでください。';
      if (!manual.entityCode) return '組織を選んでください。';
      fd.set('metricCode', manual.metricCode);
      fd.set('entityCode', manual.entityCode);
      fd.set('boundaryCode', manual.boundaryCode);
      fd.set('availabilityStatus', manual.availabilityStatus);
      fd.set('value', manual.availabilityStatus === 'value_present' ? manual.value : '');
      fd.set('unit', manual.unit);
      fd.set('valueKind', manual.valueKind);
      fd.set('absenceReason', manual.absenceReason);
      fd.set('methodologyCode', manual.methodologyCode);
      fd.set('sourceReference', manual.sourceReference);
    }
    return fd;
  }

  function runValidate() {
    const fd = buildFormData();
    if (typeof fd === 'string') {
      setValidateFeedback({ kind: 'invalid', message: fd });
      return;
    }
    setValidateFeedback(null);
    setCommitFeedback(null);
    startValidate(async () => {
      try {
        const result = await validateStandardImportAction(fd);
        if (result.ok) {
          setPreview(result.preview);
          setDirty(false);
          setMode('all');
          setConfirmExcluded(false);
          idempotencyKey.current = newKey();
          validatedSource.current = fd;
          const c = result.preview.counts;
          setAnnouncement(
            `検証しました（まだ登録していません）: 新規 ${c.new} 行／変更 ${c.changed} 行／変更なし ${c.unchanged} 行／エラー ${c.error} 行。`,
          );
          setValidatedCount((n) => n + 1);
        } else {
          setValidateFeedback({ kind: result.kind, message: result.message });
        }
      } catch {
        setValidateFeedback({ kind: 'failure', message: NETWORK_FAILURE });
      }
    });
  }

  function runCommit() {
    if (!preview) return;
    const key = idempotencyKey.current ?? newKey();
    idempotencyKey.current = key;
    setCommitFeedback(null);
    const fd = new FormData();
    for (const [name, value] of validatedSource.current?.entries() ?? []) fd.append(name, value);
    fd.set('batchId', preview.batchId);
    fd.set('previewHash', preview.previewHash);
    fd.set('idempotencyKey', key);
    fd.set('mode', mode);
    fd.set('correctionReason', reason);
    // 確認した差分（競合のときに、どの行が変わったかを示すためだけに使う）
    fd.set(
      'confirmedRows',
      JSON.stringify(
        preview.rows.map((row) => ({
          rowNo: row.rowNo,
          diffKind: row.diffKind,
          previousVersionNo: row.previous?.versionNo ?? null,
          previousStatus: row.previous?.status ?? null,
          previousDisplay: row.previous
            ? `${row.previous.valueDisplay}${row.previous.availabilityStatus === 'value_present' && row.previous.unitOfMeasure ? ` ${row.previous.unitOfMeasure}` : ''}`
            : '（既存の値なし）',
        })),
      ),
    );
    startCommit(async () => {
      try {
        const result = await commitStandardImportAction(fd);
        if (result.ok) {
          setCommitFeedback({ kind: 'success', result: result.result });
        } else if (result.kind === 'conflict') {
          setCommitFeedback({
            kind: 'conflict',
            message: result.message,
            conflicts: result.conflicts ?? [],
          });
        } else {
          setCommitFeedback({ kind: result.kind, message: result.message });
        }
      } catch {
        setCommitFeedback({ kind: 'failure', message: NETWORK_FAILURE });
      }
      resultRef.current?.focus();
    });
  }

  function startOver() {
    setPreview(null);
    setFile(null);
    setFileInputKey((k) => k + 1);
    setPasted('');
    setReason('');
    setMode('all');
    setConfirmExcluded(false);
    setCommitFeedback(null);
    setValidateFeedback(null);
    setDirty(false);
    idempotencyKey.current = null;
    validatedSource.current = null;
  }

  const currentStep = !preview ? 0 : committed ? 4 : 3;
  const validRows = preview
    ? preview.counts.new + preview.counts.changed + preview.counts.unchanged
    : 0;

  const blockers: string[] = [];
  if (preview && !committed) {
    if (dirty) blockers.push('入力を変更しました。もう一度検証してから確定してください。');
    if (validRows === 0)
      blockers.push('登録できる行がありません。エラーを修正して検証し直してください。');
    if (mode === 'all' && preview.counts.error > 0) {
      blockers.push(
        `エラーの行が ${preview.counts.error} 行あるため、この方法では確定できません。修正して検証し直すか、「正常行のみ登録」を選んでください。`,
      );
    }
    if (mode === 'valid_only' && !confirmExcluded) {
      blockers.push('除外する行が登録されないことを確認し、チェックを入れてください。');
    }
    if (preview.counts.changed > 0 && !reason.trim()) {
      blockers.push('既存の値を変える行があります。変更理由を入力してください。');
    }
  }

  const errorRows = preview?.rows.filter((r) => r.diffKind === 'error') ?? [];

  return (
    <div className="space-y-3">
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <Card className="space-y-3 p-3">
        <StepIndicator current={currentStep} done={committed} />

        <section aria-labelledby="standard-source-title" className="space-y-2">
          <h3 id="standard-source-title" className="text-[13px] font-semibold text-ink">
            1. ファイル選択
          </h3>
          <div role="group" aria-label="登録のしかた" className="flex flex-wrap gap-1">
            {(
              [
                ['file', 'CSV ファイル', FileUp],
                ['text', '貼り付け', ClipboardPaste],
                ['manual', '手入力（1 行）', Keyboard],
              ] as const
            ).map(([key, label, Icon]) => (
              <Button
                key={key}
                variant={sourceKind === key ? 'secondary' : 'outline'}
                size="sm"
                aria-pressed={sourceKind === key}
                onClick={() => {
                  setSourceKind(key);
                  markDirty();
                }}
              >
                <Icon aria-hidden="true" />
                {label}
              </Button>
            ))}
          </div>

          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              runValidate();
            }}
          >
            <div className="grid gap-2 md:grid-cols-2">
              <label className="text-[12px] text-ink-muted">
                報告期間（画面の対象期間）
                <select
                  className={selectClass}
                  value={periodId}
                  onChange={(event) => {
                    setPeriodId(event.target.value);
                    markDirty();
                  }}
                >
                  {periods.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label.includes(p.startDate)
                        ? p.label
                        : `${p.label}（${p.startDate}〜${p.endDate}）`}
                    </option>
                  ))}
                </select>
              </label>
              {sourceKind !== 'manual' && (
                <label className="text-[12px] text-ink-muted">
                  数値の書式
                  <select
                    className={selectClass}
                    value={notation}
                    onChange={(event) => {
                      setNotation(event.target.value);
                      markDirty();
                    }}
                  >
                    {notations.map((n) => (
                      <option key={n.value} value={n.value}>
                        {n.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            {sourceKind === 'file' && (
              <>
                <FileDropZone
                  inputId="standard-csv-file"
                  className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-t4d-lg border-2 border-dashed border-line bg-surface-muted px-4 py-6 text-center transition-colors focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-100 hover:border-brand-400 hover:bg-brand-50"
                >
                  <FileUp className="size-5 text-brand-600" aria-hidden="true" />
                  <span className="text-[13px] font-medium text-ink">
                    クリックして CSV を選択 ／ ここへドロップ
                  </span>
                  <span className="text-[11px] text-ink-muted">
                    .csv / .tsv / .txt（UTF-8・BOM 付き UTF-8・Shift_JIS）／ {limitsLabel}
                  </span>
                  <input
                    key={fileInputKey}
                    id="standard-csv-file"
                    type="file"
                    accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values"
                    className="sr-only"
                    onChange={(event) => {
                      setFile(event.currentTarget.files?.[0] ?? null);
                      markDirty();
                    }}
                  />
                </FileDropZone>
                {file && (
                  <p role="status" aria-live="polite" className="text-[12px] text-ink">
                    選択中: <span className="font-medium">{file.name}</span>
                    <span className="ml-1 text-ink-muted">
                      （{Math.max(1, Math.round(file.size / 1024))} KB）
                    </span>
                  </p>
                )}
              </>
            )}

            {sourceKind === 'text' && (
              <label className="block text-[12px] text-ink-muted">
                表計算ソフトからコピーした範囲（見出し行を含む。タブ区切り・カンマ区切りのどちらでも可）
                <Textarea
                  className="mt-0.5 font-mono"
                  rows={6}
                  value={pasted}
                  onChange={(event) => {
                    setPasted(event.target.value);
                    markDirty();
                  }}
                  placeholder={
                    'metric_code\tperiod_start\tperiod_end\tentity_code\tvalue\tunit\nscope1\t2026-04-01\t2027-03-31\tHQ\t1190.9\tt-CO2e'
                  }
                />
              </label>
            )}

            {sourceKind === 'manual' && (
              <ManualFields
                manual={manual}
                metrics={metrics}
                units={units}
                onChange={updateManual}
              />
            )}

            {validateFeedback && (
              <Alert tone="danger">
                <p>{validateFeedback.message}</p>
                {validateFeedback.kind === 'failure' && (
                  <Button variant="outline" size="xs" onClick={runValidate} disabled={validating}>
                    <RotateCcw aria-hidden="true" />
                    再試行
                  </Button>
                )}
              </Alert>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                size="sm"
                // 検証の後は「登録を確定」が主要な操作。再検証は副次の操作として目立たせない（主要 CTA は 1 つ。§4.2）
                variant={preview && !committed ? 'outline' : undefined}
                disabled={validating || committing}
                aria-busy={validating}
              >
                {validating ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <ShieldCheck aria-hidden="true" />
                )}
                {validating
                  ? '検証中…'
                  : preview
                    ? 'もう一度検証する'
                    : '検証する（まだ登録しません）'}
              </Button>
              <span className="text-[11px] text-ink-muted">
                検証では台帳を変えません。差分を確認してから「登録を確定」を押します。
              </span>
            </div>
          </form>
        </section>
      </Card>

      {preview && (
        <Card className="space-y-4 p-3">
          {dirty && !committed && (
            <Alert tone="warning" role="status">
              <p>入力を変更しました。下の検証結果は変更前の内容です。もう一度検証してください。</p>
            </Alert>
          )}
          <MappingSection preview={preview} />
          <SummarySection preview={preview} />
          <DiffTable preview={preview} />

          <section aria-labelledby="standard-commit-title" className="space-y-2">
            <h3 id="standard-commit-title" className="text-[13px] font-semibold text-ink">
              5. 登録確定
            </h3>

            {!committed && (
              <>
                <fieldset className="space-y-1.5">
                  <legend className="text-[12px] text-ink-muted">確定の方法</legend>
                  <label className="flex items-start gap-2 text-[13px] text-ink">
                    <input
                      type="radio"
                      name="standard-commit-mode"
                      className="mt-1"
                      checked={mode === 'all'}
                      onChange={() => setMode('all')}
                    />
                    <span>
                      すべての行を確定（既定）
                      <span className="block text-[11px] text-ink-muted">
                        エラーが 1 行でもあれば確定しません。
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-[13px] text-ink">
                    <input
                      type="radio"
                      name="standard-commit-mode"
                      className="mt-1"
                      checked={mode === 'valid_only'}
                      disabled={preview.counts.error === 0 || validRows === 0}
                      onChange={() => setMode('valid_only')}
                    />
                    <span>
                      正常行のみ登録（エラーの {preview.counts.error} 行を除外）
                      <span className="block text-[11px] text-ink-muted">
                        除外した行は登録されず、未登録のまま残ります（完了扱いにしません）。
                      </span>
                    </span>
                  </label>
                </fieldset>

                {mode === 'valid_only' && errorRows.length > 0 && (
                  <div className="space-y-1 rounded-t4d border border-line bg-surface-muted px-3 py-2">
                    <p className="text-[12px] font-medium text-ink">
                      除外する行（{errorRows.length} 行）
                    </p>
                    <ul className="max-h-40 space-y-0.5 overflow-auto text-[12px] text-ink">
                      {errorRows.map((row) => (
                        <li key={row.rowNo}>
                          {row.rowNo} 行目: {row.errors[0]}
                          {row.errors.length > 1 && `（ほか ${row.errors.length - 1} 件）`}
                        </li>
                      ))}
                    </ul>
                    <label className="flex items-center gap-2 text-[12px] text-ink">
                      <input
                        type="checkbox"
                        checked={confirmExcluded}
                        onChange={(event) => setConfirmExcluded(event.target.checked)}
                      />
                      除外する {errorRows.length} 行は登録されず、未登録のまま残ることを確認しました
                    </label>
                  </div>
                )}

                {preview.counts.changed > 0 && (
                  <label className="block text-[12px] text-ink-muted">
                    変更理由（必須・新しい版に残ります。旧版は消えません）
                    <Textarea
                      className="mt-0.5"
                      rows={2}
                      maxLength={500}
                      required
                      aria-required="true"
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="例: 燃料使用量の集計漏れを訂正"
                    />
                  </label>
                )}

                <p className="text-[11px] text-ink-muted">
                  取込で承認はしません。登録した値は「入力中」になり、承認済みの値を変えた場合は下書きへ戻して「承認後に変更」を記録します。
                </p>

                {blockers.length > 0 && (
                  <ul id="standard-commit-blockers" className="space-y-0.5 text-[12px] text-ink">
                    {blockers.map((blocker) => (
                      <li key={blocker} className="flex items-start gap-1">
                        <AlertTriangle
                          className="mt-0.5 size-3 shrink-0 text-[#8a5d00]"
                          aria-hidden="true"
                        />
                        {blocker}
                      </li>
                    ))}
                  </ul>
                )}

                <Button
                  size="sm"
                  onClick={runCommit}
                  disabled={blockers.length > 0 || committing || validating}
                  aria-busy={committing}
                  aria-describedby={blockers.length > 0 ? 'standard-commit-blockers' : undefined}
                >
                  {committing ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Check aria-hidden="true" />
                  )}
                  {committing ? '登録中…' : '登録を確定'}
                </Button>
              </>
            )}

            <div ref={resultRef} tabIndex={-1} className="outline-none">
              <CommitFeedbackView
                feedback={commitFeedback}
                busy={committing || validating}
                onRevalidate={runValidate}
                onRetryCommit={runCommit}
                onStartOver={startOver}
              />
            </div>
          </section>
        </Card>
      )}
    </div>
  );
}

function ManualFields({
  manual,
  metrics,
  units,
  onChange,
}: {
  manual: ManualState;
  metrics: StandardImportProps['metrics'];
  units: StandardImportProps['units'];
  onChange: <K extends keyof ManualState>(key: K, value: ManualState[K]) => void;
}) {
  const needsReason =
    manual.availabilityStatus === 'not_obtained' ||
    manual.availabilityStatus === 'not_applicable' ||
    manual.availabilityStatus === 'not_calculated';
  return (
    <div className="grid gap-2 md:grid-cols-3">
      <label className="text-[12px] text-ink-muted md:col-span-2">
        指標（必須）
        <select
          className={selectClass}
          value={manual.metricCode}
          required
          onChange={(event) => onChange('metricCode', event.target.value)}
        >
          <option value="">選択してください</option>
          {metrics.map((m) => (
            <option key={m.code} value={m.code}>
              {m.code} — {m.name}（{m.unit}）
            </option>
          ))}
        </select>
      </label>
      <label className="text-[12px] text-ink-muted">
        組織（必須）
        <select
          className={selectClass}
          value={manual.entityCode}
          required
          onChange={(event) => onChange('entityCode', event.target.value)}
        >
          <option value="">選択してください</option>
          {units.map((u) => (
            <option key={u.code} value={u.code}>
              {u.code} — {u.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-[12px] text-ink-muted">
        値の有無
        <select
          className={selectClass}
          value={manual.availabilityStatus}
          onChange={(event) =>
            onChange('availabilityStatus', event.target.value as AvailabilityStatus)
          }
        >
          {AVAILABILITY_STATUSES.map((status) => (
            <option key={status} value={status}>
              {AVAILABILITY_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </label>
      <label className="text-[12px] text-ink-muted">
        値{manual.availabilityStatus === 'value_present' ? '（必須）' : '（値なし）'}
        <Input
          className="mt-0.5 text-right tnum"
          inputMode="decimal"
          value={manual.availabilityStatus === 'value_present' ? manual.value : ''}
          disabled={manual.availabilityStatus !== 'value_present'}
          onChange={(event) => onChange('value', event.target.value)}
          placeholder="例: 1190.9"
        />
      </label>
      <label className="text-[12px] text-ink-muted">
        単位
        <Input
          className="mt-0.5"
          value={manual.unit}
          onChange={(event) => onChange('unit', event.target.value)}
        />
      </label>
      <label className="text-[12px] text-ink-muted">
        値の区分
        <select
          className={selectClass}
          value={manual.valueKind}
          onChange={(event) => onChange('valueKind', event.target.value as ValueKind)}
        >
          {VALUE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {VALUE_KIND_LABELS[kind]}
            </option>
          ))}
        </select>
      </label>
      <label className="text-[12px] text-ink-muted">
        集計範囲
        <select
          className={selectClass}
          value={manual.boundaryCode}
          onChange={(event) => onChange('boundaryCode', event.target.value)}
        >
          <option value="">既定（組織の連結区分から）</option>
          <option value="連結">連結</option>
          <option value="単体">単体</option>
        </select>
      </label>
      <label className="text-[12px] text-ink-muted">
        値が無い理由{needsReason ? '（必須）' : ''}
        <Input
          className="mt-0.5"
          value={manual.absenceReason}
          required={needsReason}
          aria-required={needsReason}
          disabled={manual.availabilityStatus === 'value_present'}
          onChange={(event) => onChange('absenceReason', event.target.value)}
        />
      </label>
      <label className="text-[12px] text-ink-muted">
        算定方法
        <Input
          className="mt-0.5"
          value={manual.methodologyCode}
          onChange={(event) => onChange('methodologyCode', event.target.value)}
        />
      </label>
      <label className="text-[12px] text-ink-muted md:col-span-3">
        出所（資料名・シート・セルなど）
        <Input
          className="mt-0.5"
          value={manual.sourceReference}
          onChange={(event) => onChange('sourceReference', event.target.value)}
        />
      </label>
    </div>
  );
}

function CommitFeedbackView({
  feedback,
  busy,
  onRevalidate,
  onRetryCommit,
  onStartOver,
}: {
  feedback: CommitFeedback;
  busy: boolean;
  onRevalidate: () => void;
  onRetryCommit: () => void;
  onStartOver: () => void;
}) {
  if (!feedback) return null;

  if (feedback.kind === 'success') {
    const r = feedback.result;
    return (
      <Alert tone="success" role="status">
        <p className="font-medium">
          登録を確定しました: 新規 {r.created} 件 ／ 新しい版 {r.updated} 件 ／ 変更なし{' '}
          {r.unchanged} 件{r.excluded > 0 && ` ／ 除外 ${r.excluded} 行（未登録）`}
        </p>
        {r.replayed && (
          <p>
            同じ確定操作の再送だったため、重ねて登録していません（最初の確定結果を表示しています）。
          </p>
        )}
        {r.excluded > 0 && (
          <p>
            除外した行（{r.excludedRows.map((row) => row.rowNo).join('・')}{' '}
            行目）は登録されていません。修正したうえで改めて登録してください。
          </p>
        )}
        <p className="text-ink-muted">
          登録した値は「入力中」です。提出・承認は非財務データの画面から行います。
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="xs" asChild>
            <Link href="/enterprise/data">非財務データで確認する</Link>
          </Button>
          <Button variant="ghost" size="xs" onClick={onStartOver}>
            続けて登録する
          </Button>
        </div>
      </Alert>
    );
  }

  if (feedback.kind === 'conflict') {
    return (
      <Alert tone="danger">
        <p className="font-medium">{feedback.message}</p>
        <div className="overflow-x-auto rounded-t4d border border-line bg-surface">
          <Table>
            <THead>
              <TR>
                <TH>行</TH>
                <TH>対象</TH>
                <TH>理由</TH>
                <TH align="right">検証時の値</TH>
                <TH align="right">現在の値</TH>
              </TR>
            </THead>
            <TBody>
              {feedback.conflicts.map((c) => (
                <TR key={c.rowNo}>
                  <TD className="tnum">{c.rowNo}</TD>
                  <TD className="font-mono text-[12px]">{c.label}</TD>
                  <TD className="text-[12px]">{c.reason}</TD>
                  <TD align="right">{c.previewDisplay}</TD>
                  <TD align="right">{c.currentDisplay}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
        <Button variant="outline" size="xs" onClick={onRevalidate} disabled={busy}>
          <RotateCcw aria-hidden="true" />
          最新の値で検証し直す
        </Button>
      </Alert>
    );
  }

  return (
    <Alert tone="danger">
      <p>{feedback.message}</p>
      {feedback.kind === 'expired' && (
        <Button variant="outline" size="xs" onClick={onRevalidate} disabled={busy}>
          <RotateCcw aria-hidden="true" />
          もう一度検証する
        </Button>
      )}
      {(feedback.kind === 'partial' || feedback.kind === 'failure') && (
        <Button variant="outline" size="xs" onClick={onRetryCommit} disabled={busy}>
          <RotateCcw aria-hidden="true" />
          {feedback.kind === 'partial' ? '続きから確定する' : '再試行'}
        </Button>
      )}
    </Alert>
  );
}
