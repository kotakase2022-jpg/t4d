'use client';

import * as React from 'react';
import { Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { confirmImportAction } from '../actions';
import type { ImportPreviewRow } from './preview-types';

/**
 * 取込プレビューの表。
 *
 * サーバー側にジョブが残っている場合も、クライアントが持ち回っている場合も、
 * **同じ見た目・同じ送信内容**にするために 1 つの部品にまとめている。
 *
 * 行の情報（元データの位置など）を hidden で一緒に送るので、
 * 確定するリクエストが別インスタンスへ届いても処理できる。
 */

const ROW_STATUS_LABEL: Record<
  string,
  { label: string; tone: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' }
> = {
  pending: { label: '未処理', tone: 'neutral' },
  mapped: { label: 'マッピング済み', tone: 'success' },
  needs_review: { label: '要確認', tone: 'warning' },
  duplicate: { label: '重複', tone: 'warning' },
  rejected: { label: '除外', tone: 'neutral' },
  confirmed: { label: '確定済み', tone: 'brand' },
};

export interface PreviewOption {
  id: string;
  name: string;
}

export function ImportPreviewTable({
  jobId,
  reportingPeriodId,
  rows,
  metrics,
  units,
}: {
  jobId: string;
  reportingPeriodId: string;
  rows: ImportPreviewRow[];
  metrics: PreviewOption[];
  units: PreviewOption[];
}) {
  return (
    <form action={confirmImportAction}>
      <input type="hidden" name="jobId" value={jobId} />
      {/* ジョブが別インスタンスにしか無くても確定できるよう、期間も一緒に送る */}
      <input type="hidden" name="reportingPeriodId" value={reportingPeriodId} />
      <div className="t4d-scroll-x">
        <Table className="t4d-sticky-head">
          <THead>
            <TR>
              <TH className="w-10">取込</TH>
              <TH>元データ</TH>
              <TH className="w-[200px]">指標</TH>
              <TH className="w-[160px]">組織</TH>
              <TH className="w-[120px]">値</TH>
              <TH className="w-[90px]">単位</TH>
              <TH className="w-[90px]">信頼度</TH>
              <TH>状態・警告</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((row) => {
              const status = ROW_STATUS_LABEL[row.status] ?? ROW_STATUS_LABEL.pending;
              return (
                <TR key={row.id}>
                  <TD>
                    <input type="hidden" name="rowId" value={row.id} />
                    <input
                      type="hidden"
                      name={`sourceLocator:${row.id}`}
                      value={row.sourceLocator ?? ''}
                    />
                    <input
                      type="checkbox"
                      name={`include:${row.id}`}
                      defaultChecked={row.status === 'mapped'}
                      aria-label={`行 ${row.rowIndex} を取り込む`}
                      className="size-3.5 accent-[#0b57a4]"
                    />
                  </TD>
                  <TD className="max-w-[240px]">
                    <div className="truncate text-[11px] text-ink-muted">
                      {Object.entries(row.raw)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(' / ')}
                    </div>
                    <div className="text-[11px] text-ink-muted">{row.sourceLocator}</div>
                  </TD>
                  <TD>
                    <select
                      name={`metricId:${row.id}`}
                      defaultValue={row.metricId ?? ''}
                      aria-label={`行 ${row.rowIndex} の指標`}
                      className="h-7 w-full rounded-t4d border border-line bg-surface px-1 text-[12px]"
                    >
                      <option value="">（未選択）</option>
                      {metrics.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </TD>
                  <TD>
                    <select
                      name={`unitId:${row.id}`}
                      defaultValue={row.unitId ?? ''}
                      aria-label={`行 ${row.rowIndex} の組織`}
                      className="h-7 w-full rounded-t4d border border-line bg-surface px-1 text-[12px]"
                    >
                      <option value="">（未選択）</option>
                      {units.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  </TD>
                  <TD>
                    <input
                      name={`value:${row.id}`}
                      defaultValue={row.value ?? ''}
                      inputMode="decimal"
                      aria-label={`行 ${row.rowIndex} の値`}
                      className="tnum h-7 w-full rounded-t4d border border-line px-1 text-right text-[12px]"
                    />
                  </TD>
                  <TD>
                    <input
                      name={`unitOfMeasure:${row.id}`}
                      defaultValue={row.unitOfMeasure ?? ''}
                      aria-label={`行 ${row.rowIndex} の単位`}
                      className="h-7 w-full rounded-t4d border border-line px-1 text-[12px]"
                    />
                  </TD>
                  <TD>
                    <span
                      className={
                        row.confidence >= 0.7
                          ? 'tnum text-success'
                          : row.confidence >= 0.4
                            ? 'tnum text-[#8a5d00]'
                            : 'tnum text-danger'
                      }
                    >
                      {Math.round(row.confidence * 100)}%
                    </span>
                  </TD>
                  <TD>
                    <Badge tone={status?.tone ?? 'neutral'}>{status?.label}</Badge>
                    {row.warnings.length > 0 && (
                      <ul className="mt-0.5 space-y-0.5">
                        {row.warnings.map((w, i) => (
                          <li key={i} className="text-[11px] text-[#8a5d00]">
                            ⚠ {w}
                          </li>
                        ))}
                      </ul>
                    )}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2">
        <p className="text-[11px] text-ink-muted">
          確定すると Data Point 台帳へ反映されます（既存データがある場合は新しい Version
          が追加されます）。AI の推定は候補であり、確定は人が行います。
        </p>
        <SubmitButton size="sm" icon={<Check aria-hidden="true" />} pendingLabel="確定中…">
          選択した行を確定
        </SubmitButton>
      </div>
    </form>
  );
}
