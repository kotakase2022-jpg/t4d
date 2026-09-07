'use client';

import * as React from 'react';
import { AlertTriangle, CheckCircle2, FileUp, Upload } from 'lucide-react';
import { FileDropZone } from '@/components/shared/file-drop-zone';
import { Badge } from '@/components/ui/badge';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { formatNumber } from '@/lib/format/datetime';
import {
  confirmSupplierImportAction,
  previewSupplierImportAction,
  type SupplierUploadResult,
} from '../../actions';

/**
 * サプライヤー購買 CSV の投入フォーム。
 *
 * 一般のデータ取込（AI マッピング）と違い、ここは規則ベースの決定論解析。
 * 解析結果はサーバーの応答としてこの画面へ返し、行を確認してから確定する
 * （確定時はサーバー側でマスターと再照合するため、hidden の改ざんでは通らない）。
 */
export function SupplierUploadForm({ reportingPeriodId }: { reportingPeriodId: string }) {
  const [state, formAction] = React.useActionState<SupplierUploadResult | null, FormData>(
    previewSupplierImportAction,
    null,
  );
  const formRef = React.useRef<HTMLFormElement>(null);
  const [selectedName, setSelectedName] = React.useState<string | null>(null);

  const preview = state?.ok ? state.preview : null;

  return (
    <div className="space-y-3">
      <form ref={formRef} action={formAction} className="space-y-3">
        <input type="hidden" name="reportingPeriodId" value={reportingPeriodId} />
        <FileDropZone
          inputId="supplier-file"
          onFilesDropped={(files) => {
            setSelectedName(files[0]?.name ?? null);
            // ドロップは「これを今すぐ解析する」という操作。そのまま解析を始める
            formRef.current?.requestSubmit();
          }}
          className="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-t4d-lg border-2 border-dashed border-line bg-surface-muted px-4 py-8 text-center transition-colors hover:border-brand-400 hover:bg-brand-50"
        >
          <FileUp className="size-6 text-brand-600" aria-hidden="true" />
          <span className="text-[13px] font-medium text-ink">
            クリックして CSV を選択 ／ ここへドロップ
          </span>
          <span className="text-[11px] text-ink-muted">
            列: サプライヤーコード ／ 品目 ／ 購買金額(千円) ／ 排出係数コード（テンプレートを参照）
            ／ 対応形式: .csv / .tsv ／ 5MB まで
          </span>
          <input
            id="supplier-file"
            type="file"
            name="file"
            accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
            className="sr-only"
            onChange={(event) => setSelectedName(event.currentTarget.files?.[0]?.name ?? null)}
          />
        </FileDropZone>

        {selectedName && (
          <p role="status" aria-live="polite" className="text-[12px] text-ink-muted">
            受け付けたファイル: <span className="text-ink">{selectedName}</span>
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
            解析は規則ベースで行います（AI は使いません）。確定するまでデータは変わりません。
          </span>
        </div>
      </form>

      {preview && (
        <div className="space-y-2 border-t border-line pt-3">
          <p className="text-[12px] text-ink">
            <span className="font-medium">{preview.fileName}</span>
            <span className="ml-2 text-ink-muted">
              文字コード: {preview.encoding} ／ 取込可能 {preview.validCount} 行 ／ 全{' '}
              {preview.rows.length} 行
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

          {preview.rows.length > 0 && (
            <form action={confirmSupplierImportAction} className="space-y-2">
              <input type="hidden" name="reportingPeriodId" value={reportingPeriodId} />
              <div className="t4d-scroll-x">
                <Table>
                  <THead>
                    <TR>
                      <TH className="w-8">
                        <span className="sr-only">取込対象</span>
                      </TH>
                      <TH>サプライヤー</TH>
                      <TH>品目</TH>
                      <TH align="right">購買金額(千円)</TH>
                      <TH>排出係数</TH>
                      {/* TH は uppercase が掛かるため、大小文字に意味がある単位は normal-case で守る */}
                      <TH align="right">
                        排出量<span className="normal-case">(t-CO2e)</span>
                      </TH>
                      <TH>判定</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {preview.rows.map((row) => {
                      const key = `r${row.rowIndex}`;
                      const importable = row.skippedReason === null && row.errors.length === 0;
                      return (
                        <TR key={key}>
                          <TD>
                            {importable ? (
                              <>
                                <input type="hidden" name="srow" value={key} />
                                <input
                                  type="hidden"
                                  name={`supplierCode:${key}`}
                                  value={row.supplierCode}
                                />
                                <input type="hidden" name={`item:${key}`} value={row.item} />
                                <input
                                  type="hidden"
                                  name={`amount:${key}`}
                                  value={row.amountThousandJpy ?? ''}
                                />
                                <input
                                  type="hidden"
                                  name={`factorCode:${key}`}
                                  value={row.factorCode}
                                />
                                <input
                                  type="checkbox"
                                  name={`include:${key}`}
                                  defaultChecked
                                  aria-label={`${row.supplierName ?? row.supplierCode} ${row.item} を取り込む`}
                                  className="size-3.5 accent-brand-600"
                                />
                              </>
                            ) : (
                              <span className="sr-only">取込対象外</span>
                            )}
                          </TD>
                          <TD className="font-medium text-ink">
                            {row.supplierName ?? row.supplierCode}
                            <span className="ml-1 font-mono text-[11px] text-ink-muted">
                              {row.supplierCode}
                            </span>
                          </TD>
                          <TD>{row.item}</TD>
                          <TD align="right">{row.amountRaw}</TD>
                          <TD className="text-[11px]">
                            {row.factorName ? (
                              <>
                                {row.factorName}
                                <span className="ml-1 font-mono text-ink-muted">
                                  {row.factorCode}
                                </span>
                              </>
                            ) : (
                              <span className="font-mono">{row.factorCode}</span>
                            )}
                          </TD>
                          <TD align="right" className="font-medium">
                            {formatNumber(row.emissions)}
                          </TD>
                          <TD>
                            {row.skippedReason ? (
                              <span className="text-[11px] text-ink-muted">
                                {row.skippedReason}
                              </span>
                            ) : row.errors.length > 0 ? (
                              <ul className="space-y-0.5">
                                {row.errors.map((message) => (
                                  <li
                                    key={message}
                                    className="flex items-start gap-1 text-[11px] text-danger"
                                  >
                                    <AlertTriangle
                                      className="mt-0.5 size-3 shrink-0"
                                      aria-hidden="true"
                                    />
                                    {message}
                                  </li>
                                ))}
                              </ul>
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
                    })}
                  </TBody>
                </Table>
              </div>

              <div className="flex items-center gap-2">
                <SubmitButton
                  size="sm"
                  icon={<CheckCircle2 aria-hidden="true" />}
                  pendingLabel="確定中…"
                  disabled={preview.validCount === 0}
                >
                  チェックした行を確定する
                </SubmitButton>
                <span className="text-[11px] text-ink-muted">
                  確定すると Scope3 Cat.1 の算定根拠へ新しい版を追記します（過去の版は残ります）。
                </span>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
