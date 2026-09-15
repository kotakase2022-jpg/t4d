'use client';

import * as React from 'react';
import { AlertTriangle, CheckCircle2, FileUp, Link2, Upload } from 'lucide-react';
import { FileDropZone } from '@/components/shared/file-drop-zone';
import { Badge } from '@/components/ui/badge';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { normalizeUnit } from '@/lib/domain/supplier-units';
import { formatNumber } from '@/lib/format/datetime';
import { parseFlexibleNumber } from '@/lib/imports/number';
import type { FactorCandidate, SupplierPreviewRow } from '@/lib/services/scope3-suppliers';
import {
  confirmSupplierImportAction,
  previewSupplierImportAction,
  type SupplierConfirmState,
  type SupplierUploadResult,
} from '../../actions';

/**
 * サプライヤー一次データの投入フォーム（複数ファイル対応）。
 *
 * 一般のデータ取込（AI マッピング）と違い、ここは規則ベースの決定論解析。
 * 行ごとに 排出量／物理量／金額 のどれかへ自動仕訳し、物理量・金額の行は
 * 排出量原単位（排出係数）を自動解決する。数値・単位・原単位はプレビュー上で
 * 手修正でき（2026-09-15 指示①-2）、確定時はサーバー側でマスターと再照合・
 * 再正規化するため、hidden の改ざんや画面と食い違う編集では通らない。
 */

const DATA_TYPE_LABELS: Record<string, string> = {
  emissions: '排出量',
  physical: '物理量',
  monetary: '金額',
};

function DataTypeBadge({ dataType }: { dataType: SupplierPreviewRow['dataType'] }) {
  if (!dataType) return <span className="text-[11px] text-ink-muted">—</span>;
  return (
    <Badge
      tone={dataType === 'emissions' ? 'brand' : dataType === 'physical' ? 'neutral' : 'outline'}
    >
      <CheckCircle2 className="size-3" aria-hidden="true" />
      {DATA_TYPE_LABELS[dataType]}
    </Badge>
  );
}

/** サービス側 roundEmissions と同じ丸め（手修正時のクライアント再計算用） */
function roundEmissions(value: number): number {
  return Math.round(value * 10) / 10;
}

function candidateOptionLabel(candidate: FactorCandidate): string {
  const parts = [
    `${candidate.factorValue} ${candidate.factorUnit}`,
    candidate.region ?? '汎用',
    `${candidate.factorYear}年`,
  ];
  return `${candidate.recommended ? '★ ' : ''}${candidate.name}（${parts.join('・')}）`;
}

function ConfidenceCell({ row }: { row: SupplierPreviewRow }) {
  const shown = row.displayConfidence ?? row.rawConfidence;
  if (shown === null || shown === undefined) {
    return <span className="text-[11px] text-ink-muted">—</span>;
  }
  const pct = Math.round(shown * 100);
  const hint =
    row.confidenceSource === 'demo_simulated' && row.rawConfidence !== null
      ? `実測スコア ${Math.round(row.rawConfidence * 100)}%（表示はデモ用シミュレーション）`
      : undefined;
  return (
    <span
      title={hint}
      className={`font-medium tabular-nums ${pct >= 90 ? 'text-success' : pct >= 80 ? 'text-ink' : 'text-[#8a5d00]'}`}
    >
      {pct}%
    </span>
  );
}

interface RowViewProps {
  rowKey: string;
  row: SupplierPreviewRow;
  amountText: string;
  unitText: string;
  selectedCode: string;
  onAmountChange: (key: string, value: string) => void;
  onUnitChange: (key: string, value: string) => void;
  onFactorChange: (key: string, value: string) => void;
}

/**
 * プレビュー 1 行。React.memo で「編集した行だけ」を再レンダーする
 * （20 ファイル 240 行 × 係数セレクトを、1 キーストロークごとに
 * 全行描き直すと入力がもたつくため）。
 */
const SupplierPreviewRowView = React.memo(function SupplierPreviewRowView({
  rowKey,
  row,
  amountText,
  unitText,
  selectedCode,
  onAmountChange,
  onUnitChange,
  onFactorChange,
}: RowViewProps) {
  const importable = row.skippedReason === null && row.errors.length === 0;

  // 数値・単位の解釈は解析／確定サーバーと同じ規則（parseFlexibleNumber・normalizeUnit）。
  // 表示と確定値がずれる「クライアントだけの解釈」を作らない
  const amountNumber = parseFlexibleNumber(amountText);
  const hasAmount = amountNumber !== null && amountNumber > 0;
  const unitNorm = normalizeUnit(unitText);
  // 正規形が行の単位と同じなら、倍率つき表記（g・円 等）も係数と照合できる
  const unitCompatible =
    unitNorm !== null &&
    (row.dataType === 'emissions' ? unitNorm.kind === 'emissions' : unitNorm.unit === row.unit);
  const unitWarning = !importable
    ? null
    : unitNorm === null
      ? `単位「${unitText}」は解釈できません`
      : !unitCompatible
        ? `単位「${unitNorm.unit}」に合う係数が候補にありません（確定時にエラーになります）`
        : null;

  const activeFactor =
    (selectedCode !== '' ? row.factorCandidates.find((c) => c.code === selectedCode) : null) ??
    (row.factor?.code === selectedCode ? row.factor : null);
  const effectiveAmount =
    hasAmount && unitNorm !== null && unitCompatible ? amountNumber * unitNorm.multiplier : null;
  const emissions = !importable
    ? row.emissions
    : effectiveAmount === null
      ? null
      : row.dataType === 'emissions'
        ? roundEmissions(effectiveAmount)
        : activeFactor
          ? roundEmissions(effectiveAmount * activeFactor.factorValue)
          : null;

  return (
    <TR>
      <TD>
        {importable ? (
          <>
            <input type="hidden" name="srow" value={rowKey} />
            <input type="hidden" name={`supplierCode:${rowKey}`} value={row.supplierCode} />
            <input type="hidden" name={`item:${rowKey}`} value={row.item} />
            <input type="hidden" name={`dataType:${rowKey}`} value={row.dataType ?? ''} />
            <input
              type="checkbox"
              name={`include:${rowKey}`}
              defaultChecked={!row.needsFactorChoice || row.recommendedFactorCode !== null}
              disabled={row.needsFactorChoice && selectedCode === ''}
              aria-label={`${row.supplierName ?? row.supplierCode} ${row.item} を取り込む${row.needsFactorChoice && selectedCode === '' ? '（先に原単位を選択してください）' : ''}`}
              className="size-3.5 accent-brand-600"
            />
          </>
        ) : (
          <span className="sr-only">取込対象外</span>
        )}
      </TD>
      <TD className="font-medium text-ink">
        {row.supplierName ?? row.supplierCode}
        <span className="ml-1 font-mono text-[11px] text-ink-muted">{row.supplierCode}</span>
      </TD>
      <TD>{row.item}</TD>
      <TD>
        <DataTypeBadge dataType={row.dataType} />
      </TD>
      {/* 単位は正規形へ換算して見せるため、数値も換算後で揃える
          （2.5 MWh の行を「2.5 / kWh」と読ませない）。
          取込可能な行は数値・単位を直接手修正できる（確定時にサーバーが再正規化・再検証） */}
      <TD align="right">
        {importable ? (
          <input
            name={`amount:${rowKey}`}
            value={amountText}
            onChange={(event) => onAmountChange(rowKey, event.target.value)}
            inputMode="decimal"
            aria-label={`${row.supplierName ?? row.supplierCode} ${row.item} の数値`}
            title={
              String(row.amountRaw) !== String(amountText)
                ? `元の表記: ${row.amountRaw}`
                : undefined
            }
            className="tnum h-6 w-24 rounded-t4d border border-line bg-surface px-1 text-right text-[12px]"
          />
        ) : row.amount !== null ? (
          formatNumber(row.amount)
        ) : (
          row.amountRaw
        )}
      </TD>
      <TD className="text-[11px]">
        {importable ? (
          <span className="flex flex-col gap-0.5">
            <input
              name={`unit:${rowKey}`}
              value={unitText}
              onChange={(event) => onUnitChange(rowKey, event.target.value)}
              aria-label={`${row.supplierName ?? row.supplierCode} ${row.item} の単位`}
              title="表記ゆらぎ（g・円 等）は確定時に正規化・換算されます"
              className={`h-6 w-14 rounded-t4d border bg-surface px-1 text-[11px] ${unitWarning ? 'border-danger' : 'border-line'}`}
            />
            {unitWarning && <span className="text-danger">{unitWarning}</span>}
          </span>
        ) : (
          (row.unit ?? '—')
        )}
      </TD>
      <TD className="text-[11px]">
        {row.dataType === 'emissions' ? (
          <span className="text-ink-muted">不要（報告値）</span>
        ) : importable && row.factorCandidates.length > 0 ? (
          // 解決済みの行も同じセレクトで選び直せる（2026-09-15 指示①-2）。
          // 候補は同じ単位の原単位のみ。確定時はサーバーが再照合する
          <span className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1">
              {/* text-warning は明度が高く読めないため、警告文字色は既存慣例の #8a5d00 */}
              {row.needsFactorChoice && (
                <Link2 className="size-3 shrink-0 text-[#8a5d00]" aria-hidden="true" />
              )}
              <select
                name={`factorCode:${rowKey}`}
                value={selectedCode}
                onChange={(event) => onFactorChange(rowKey, event.target.value)}
                aria-label={`${row.supplierName ?? row.supplierCode} ${row.item} の排出量原単位`}
                className="h-6 max-w-[280px] rounded-t4d border border-line bg-surface px-1 text-[11px]"
              >
                {(row.needsFactorChoice || selectedCode === '') && (
                  <option value="">原単位を選択…</option>
                )}
                {row.factorCandidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.code}>
                    {candidateOptionLabel(candidate)}
                  </option>
                ))}
              </select>
            </span>
            {activeFactor && (
              <span className="text-ink-muted">
                {activeFactor.reason}
                {activeFactor.boundary ? ` ／ 境界: ${activeFactor.boundary}` : ''}
              </span>
            )}
          </span>
        ) : row.factor ? (
          <>
            <input type="hidden" name={`factorCode:${rowKey}`} value={row.factor.code} />
            {row.factor.name}
            <span className="ml-1 font-mono text-ink-muted">{row.factor.code}</span>
            {row.factorReason && (
              <span className="ml-1 text-ink-muted">（{row.factorReason}）</span>
            )}
          </>
        ) : (
          <span className="font-mono">{row.factorCode || '—'}</span>
        )}
      </TD>
      <TD align="right" className="font-medium">
        {formatNumber(emissions)}
      </TD>
      <TD align="right">
        <ConfidenceCell row={row} />
      </TD>
      <TD>
        {row.skippedReason ? (
          <span className="text-[11px] text-ink-muted">{row.skippedReason}</span>
        ) : row.errors.length > 0 ? (
          <ul className="space-y-0.5">
            {row.errors.map((message) => (
              <li key={message} className="flex items-start gap-1 text-[11px] text-danger">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                {message}
              </li>
            ))}
          </ul>
        ) : row.needsFactorChoice ? (
          <Badge tone="warning">
            <Link2 className="size-3" aria-hidden="true" />
            {row.recommendedFactorCode ? '推薦候補を選択中（変更可）' : '原単位の紐づけ待ち'}
          </Badge>
        ) : row.replacesExisting ? (
          <Badge tone="warning">
            <AlertTriangle className="size-3" aria-hidden="true" />
            既存の内訳を置き換え
          </Badge>
        ) : (
          <Badge tone="success">
            <CheckCircle2 className="size-3" aria-hidden="true" />
            新規
          </Badge>
        )}
      </TD>
    </TR>
  );
});

export function SupplierUploadForm({ reportingPeriodId }: { reportingPeriodId: string }) {
  const [state, formAction] = React.useActionState<SupplierUploadResult | null, FormData>(
    previewSupplierImportAction,
    null,
  );
  // 確定は useActionState 経由: 検証エラーを画面内に出し、プレビューと手修正を失わない
  const [confirmState, confirmDispatch] = React.useActionState<SupplierConfirmState, FormData>(
    confirmSupplierImportAction,
    null,
  );
  const formRef = React.useRef<HTMLFormElement>(null);
  const [selectedNames, setSelectedNames] = React.useState<string[]>([]);
  // 紐づけ待ち行で選んだ原単位。推薦候補がある行は推薦を初期値にする
  const [chosenFactors, setChosenFactors] = React.useState<Record<string, string>>({});
  // 取込結果の手修正（数値・単位）。キーは行、値は入力中の文字列（未編集の行はキー無し）
  const [editedAmounts, setEditedAmounts] = React.useState<Record<string, string>>({});
  const [editedUnits, setEditedUnits] = React.useState<Record<string, string>>({});
  // 解析世代。React key に混ぜて、解析し直しで非制御のチェックボックスも初期状態へ戻す
  const [generation, setGeneration] = React.useState(0);

  // ファイル実体は 2 段で持つ:
  //  - pendingFilesRef … いま input が選んでいるファイル（解析前）
  //  - analyzedFiles   … 表示中のプレビューを生んだファイル（ファイル名クリックの DL 元）
  // 選択のたびに DL 元まで差し替えると、旧プレビューのファイル名から別実体が落ちる
  const pendingFilesRef = React.useRef<Map<string, File>>(new Map());
  const [analyzedFiles, setAnalyzedFiles] = React.useState<Map<string, File>>(new Map());
  const rememberFiles = (files: Iterable<File>) => {
    pendingFilesRef.current = new Map(Array.from(files).map((file) => [file.name, file]));
  };
  const downloadUploadedFile = (name: string) => {
    const file = analyzedFiles.get(name);
    if (!file) return;
    const url = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  const previews = state?.ok ? state.previews : null;

  // 解析し直したら前回の選択・手修正・チェック状態を持ち越さない
  // （同じ行キーが別の明細を指しうるため）。DL 元の実体もこの時点の選択で確定する
  React.useEffect(() => {
    setChosenFactors({});
    setEditedAmounts({});
    setEditedUnits({});
    setGeneration((g) => g + 1);
    setAnalyzedFiles(pendingFilesRef.current);
  }, [state]);

  const onAmountChange = React.useCallback((key: string, value: string) => {
    setEditedAmounts((prev) => ({ ...prev, [key]: value }));
  }, []);
  const onUnitChange = React.useCallback((key: string, value: string) => {
    setEditedUnits((prev) => ({ ...prev, [key]: value }));
  }, []);
  const onFactorChange = React.useCallback((key: string, value: string) => {
    setChosenFactors((prev) => ({ ...prev, [key]: value }));
  }, []);

  // 全ファイル横断のサマリー（表示信頼度の min／平均／max と 80〜97% 内の割合）
  const summary = React.useMemo(() => {
    if (!previews) return null;
    const rows = previews.flatMap((p) => p.rows);
    const detailRows = rows.filter((r) => r.skippedReason === null);
    const confidences = rows
      .map((r) => r.displayConfidence ?? r.rawConfidence)
      .filter((v): v is number => v !== null && v !== undefined);
    const inRange = confidences.filter((v) => v >= 0.8 && v <= 0.97).length;
    return {
      fileCount: previews.length,
      detailCount: detailRows.length,
      validCount: previews.reduce((sum, p) => sum + p.validCount, 0),
      needsMappingCount: previews.reduce((sum, p) => sum + p.needsMappingCount, 0),
      errorRowCount: detailRows.filter((r) => r.errors.length > 0).length,
      fileErrorCount: previews.reduce((sum, p) => sum + p.fileErrors.length, 0),
      // 80〜97% の帯はデモ表示のときだけ意味を持つ（実測モードでは出さない）
      hasSimulated: rows.some((r) => r.confidenceSource === 'demo_simulated'),
      confidence:
        confidences.length === 0
          ? null
          : {
              min: Math.min(...confidences),
              avg: confidences.reduce((sum, v) => sum + v, 0) / confidences.length,
              max: Math.max(...confidences),
              inRangeRatio: inRange / confidences.length,
            },
    };
  }, [previews]);

  return (
    <div className="space-y-3">
      <form ref={formRef} action={formAction} className="space-y-3">
        <input type="hidden" name="reportingPeriodId" value={reportingPeriodId} />
        <FileDropZone
          inputId="supplier-file"
          onFilesDropped={(files) => {
            setSelectedNames(Array.from(files).map((f) => f.name));
            rememberFiles(files);
            // ドロップは「これを今すぐ解析する」という操作。そのまま解析を始める
            formRef.current?.requestSubmit();
          }}
          className="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-t4d-lg border-2 border-dashed border-line bg-surface-muted px-4 py-8 text-center transition-colors hover:border-brand-400 hover:bg-brand-50"
        >
          <FileUp className="size-6 text-brand-600" aria-hidden="true" />
          <span className="text-[13px] font-medium text-ink">
            クリックしてファイルを選択（複数可）／ ここへドロップ
          </span>
          <span className="text-[11px] text-ink-muted">
            排出量（t-CO2e）・物理量（kWh・m3・L・kg・個・m2）・金額（千円）の素データを自動仕訳します
            ／ 多言語ヘッダー・前置き行対応 ／ .csv / .tsv / .xlsx ／ 各 5MB まで
          </span>
          <input
            id="supplier-file"
            type="file"
            name="files"
            multiple
            accept=".csv,.tsv,.txt,.xlsx,.xlsm,text/csv,text/tab-separated-values,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              setSelectedNames(files.map((f) => f.name));
              rememberFiles(files);
            }}
          />
        </FileDropZone>

        {selectedNames.length > 0 && (
          <p role="status" aria-live="polite" className="text-[12px] text-ink-muted">
            受け付けたファイル（{selectedNames.length} 件）:{' '}
            <span className="text-ink">
              {selectedNames.length <= 3
                ? selectedNames.join('、')
                : `${selectedNames.slice(0, 3).join('、')} ほか ${selectedNames.length - 3} 件`}
            </span>
          </p>
        )}

        {state && !state.ok && (
          <p
            role="alert"
            className="rounded-t4d border border-danger/40 bg-danger-soft px-3 py-1.5 text-[12px] text-ink"
          >
            {state.message}
          </p>
        )}

        <div className="flex items-center gap-2">
          <SubmitButton size="sm" icon={<Upload aria-hidden="true" />} pendingLabel="解析中…">
            解析する
          </SubmitButton>
          <span className="text-[11px] text-ink-muted">
            解析が終わるとプレビュー画面へ移ります。
            テンプレートに記入したファイルもここへドロップしてください。
          </span>
        </div>
      </form>

      {previews && summary && (
        <div className="space-y-3 border-t border-line pt-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-t4d border border-line bg-surface-muted px-3 py-2 text-[12px]">
            <span>
              解析結果: <span className="font-medium text-ink">{summary.fileCount} ファイル</span>
              ・明細 <span className="font-medium text-ink">{summary.detailCount} 行</span>
            </span>
            <span>
              そのまま確定できる行{' '}
              <span className="font-medium text-ink">{summary.validCount}</span>／
              原単位の紐づけ待ち{' '}
              <span className="font-medium text-ink">{summary.needsMappingCount}</span>
            </span>
            {(summary.errorRowCount > 0 || summary.fileErrorCount > 0) && (
              <span className="text-danger">
                エラー行 {summary.errorRowCount} ／ ファイルエラー {summary.fileErrorCount}
              </span>
            )}
            {summary.confidence && (
              <span className="text-ink-muted">
                信頼度 最小 {Math.round(summary.confidence.min * 100)}% ／ 平均{' '}
                {Math.round(summary.confidence.avg * 100)}% ／ 最大{' '}
                {Math.round(summary.confidence.max * 100)}%
                {summary.hasSimulated &&
                  `（80〜97% 内 ${Math.round(summary.confidence.inRangeRatio * 100)}%）`}
              </span>
            )}
          </div>

          <form action={confirmDispatch} className="space-y-4">
            <input type="hidden" name="reportingPeriodId" value={reportingPeriodId} />
            {previews.map((preview, fileIndex) => (
              <section
                key={`g${generation}-${fileIndex}-${preview.fileName}`}
                className="space-y-2"
              >
                <p className="text-[12px] text-ink">
                  {/* ファイル名クリックで投入した元ファイルを再ダウンロード（2026-09-15 指示①-1）。
                      実体はこのブラウザが保持する File。無ければただの名前として出す */}
                  {analyzedFiles.has(preview.fileName) ? (
                    <button
                      type="button"
                      onClick={() => downloadUploadedFile(preview.fileName)}
                      title="クリックで投入した元ファイルをダウンロード"
                      className="font-medium text-brand-700 underline-offset-2 hover:underline"
                    >
                      {preview.fileName}
                    </button>
                  ) : (
                    <span className="font-medium">{preview.fileName}</span>
                  )}
                  <span className="ml-2 text-ink-muted">
                    文字コード: {preview.encoding} ／ そのまま確定できる行 {preview.validCount} ／
                    原単位の紐づけ待ち {preview.needsMappingCount} ／ 全 {preview.rows.length} 行
                  </span>
                </p>

                {preview.fileErrors.length > 0 && (
                  <ul role="alert" className="space-y-1">
                    {preview.fileErrors.map((message) => (
                      <li
                        key={message}
                        className="flex items-start gap-1.5 rounded-t4d border border-danger/40 bg-danger-soft px-3 py-1.5 text-[12px] text-ink"
                      >
                        <AlertTriangle
                          className="mt-0.5 size-3.5 shrink-0 text-danger"
                          aria-hidden="true"
                        />
                        {message}
                      </li>
                    ))}
                  </ul>
                )}

                {preview.fileNotes.length > 0 && (
                  <ul className="space-y-0.5">
                    {preview.fileNotes.map((message) => (
                      <li key={message} className="text-[11px] text-ink-muted">
                        ℹ {message}
                      </li>
                    ))}
                  </ul>
                )}

                {preview.rows.length > 0 && (
                  <div className="t4d-scroll-x">
                    <Table>
                      <THead>
                        <TR>
                          <TH className="w-8">
                            <span className="sr-only">取込対象</span>
                          </TH>
                          <TH>サプライヤー</TH>
                          <TH>品目</TH>
                          <TH>種別</TH>
                          <TH align="right">数値</TH>
                          <TH>単位</TH>
                          <TH>排出量原単位（係数）</TH>
                          {/* TH は uppercase が掛かるため、大小文字に意味がある単位は normal-case で守る */}
                          <TH align="right">
                            排出量<span className="normal-case">(t-CO2e)</span>
                          </TH>
                          <TH align="right">信頼度</TH>
                          <TH>判定</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {preview.rows.map((row) => {
                          const rowKey = `f${fileIndex}r${row.rowIndex}`;
                          const normalizedAmount =
                            row.amount !== null ? Math.round(row.amount * 1e6) / 1e6 : null;
                          return (
                            <SupplierPreviewRowView
                              key={`g${generation}-${rowKey}`}
                              rowKey={rowKey}
                              row={row}
                              amountText={
                                editedAmounts[rowKey] ??
                                (normalizedAmount !== null
                                  ? String(normalizedAmount)
                                  : row.amountRaw)
                              }
                              unitText={editedUnits[rowKey] ?? row.unit ?? ''}
                              selectedCode={
                                chosenFactors[rowKey] ??
                                row.recommendedFactorCode ??
                                row.factor?.code ??
                                ''
                              }
                              onAmountChange={onAmountChange}
                              onUnitChange={onUnitChange}
                              onFactorChange={onFactorChange}
                            />
                          );
                        })}
                      </TBody>
                    </Table>
                  </div>
                )}
              </section>
            ))}

            {confirmState && !confirmState.ok && (
              <p
                role="alert"
                className="flex items-start gap-1.5 rounded-t4d border border-danger/40 bg-danger-soft px-3 py-1.5 text-[12px] text-ink"
              >
                <AlertTriangle
                  className="mt-0.5 size-3.5 shrink-0 text-danger"
                  aria-hidden="true"
                />
                {confirmState.message}
              </p>
            )}

            <div className="flex items-center gap-2">
              <SubmitButton
                size="sm"
                icon={<CheckCircle2 aria-hidden="true" />}
                pendingLabel="確定中…"
                disabled={summary.validCount === 0 && summary.needsMappingCount === 0}
              >
                チェックした行を確定する
              </SubmitButton>
              <span className="text-[11px] text-ink-muted">
                確定すると Scope3 Cat.1 の算定根拠へ新しい版を追記します（過去の版は残ります）。
                推薦候補（★）は初期選択済みです。数値・単位・係数を変更するとその場で再計算されます。
              </span>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
