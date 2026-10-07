'use client';

import * as React from 'react';
import { Check } from 'lucide-react';
import { SemanticBadge } from '@/components/shared/status-badge';
import { Collapsible } from '@/components/ui/collapsible';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { visibleRowWarnings } from '@/lib/imports/hidden-warnings';
import { confirmImportAction } from '../actions';
import type { ImportPreviewRow } from './preview-types';
import type { StatusSemantic } from '@/lib/ui/status/registry';

/**
 * 取込プレビューの表。
 *
 * サーバー側にジョブが残っている場合も、クライアントが持ち回っている場合も、
 * **同じ見た目・同じ送信内容**にするために 1 つの部品にまとめている。
 *
 * 行の情報（元データの位置など）を hidden で一緒に送るので、
 * 確定するリクエストが別インスタンスへ届いても処理できる。
 */

/** 行の状態（ラベル＋アイコン。意味は状態登録簿の semantic で揃える） */
const ROW_STATUS_LABEL: Record<string, { label: string; semantic: StatusSemantic }> = {
  pending: { label: '未処理', semantic: 'todo' },
  mapped: { label: 'マッピング済み', semantic: 'done' },
  needs_review: { label: '要確認', semantic: 'pending' },
  duplicate: { label: '重複', semantic: 'blocked' },
  rejected: { label: '除外', semantic: 'excluded' },
  confirmed: { label: '確定済み', semantic: 'done' },
  ignored: { label: '対象外', semantic: 'excluded' },
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
  // 指標マスターと無関係と判断した行は、既定では表から畳んでおく。
  // 警告を出さない代わりに「何行を外したか」は必ず見せ、開けば中身も確認できる。
  // 黙って消すと、外した判断が誤っていたときに気づけない。
  // デモでは低確信の行（demoHiddenLowConfidence）も同じ折りたたみへ畳む
  // （2026-09-15 指示④。表示だけで、保存された行の状態・実測値は変えない）
  const folded = (row: ImportPreviewRow) =>
    row.status === 'ignored' || row.demoHiddenLowConfidence === true;
  const ignored = rows.filter(folded);
  const visible = rows.filter((row) => !folded(row));

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
            {visible.map((row) => {
              const status = ROW_STATUS_LABEL[row.status] ?? ROW_STATUS_LABEL.pending;
              // 出さないと決めた警告は表示の直前で落とす。保存済みの行にも効かせるため
              const warnings = visibleRowWarnings(row.warnings);
              return (
                <TR key={row.id}>
                  <TD>
                    <input type="hidden" name="rowId" value={row.id} />
                    <input
                      type="hidden"
                      name={`sourceLocator:${row.id}`}
                      value={row.sourceLocator ?? ''}
                    />
                    <NativeCheckbox
                      name={`include:${row.id}`}
                      defaultChecked={row.status === 'mapped'}
                      aria-label={`行 ${row.rowIndex} を取り込む`}
                    />
                  </TD>
                  <TD className="max-w-[240px]">
                    <div className="truncate text-caption text-ink-muted">
                      {Object.entries(row.raw)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(' / ')}
                    </div>
                    <div className="text-caption text-ink-muted">{row.sourceLocator}</div>
                  </TD>
                  <TD>
                    <NativeSelect
                      size="xs"
                      name={`metricId:${row.id}`}
                      defaultValue={row.metricId ?? ''}
                      aria-label={`行 ${row.rowIndex} の指標`}
                    >
                      <option value="">（未選択）</option>
                      {metrics.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </TD>
                  <TD>
                    <NativeSelect
                      size="xs"
                      name={`unitId:${row.id}`}
                      defaultValue={row.unitId ?? ''}
                      aria-label={`行 ${row.rowIndex} の組織`}
                    >
                      <option value="">（未選択）</option>
                      {units.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </TD>
                  <TD>
                    <input
                      name={`value:${row.id}`}
                      defaultValue={row.value ?? ''}
                      inputMode="decimal"
                      aria-label={`行 ${row.rowIndex} の値`}
                      className="tnum h-7 w-full rounded-t4d border border-line px-1 text-right text-small"
                    />
                  </TD>
                  <TD>
                    <input
                      name={`unitOfMeasure:${row.id}`}
                      defaultValue={row.unitOfMeasure ?? ''}
                      aria-label={`行 ${row.rowIndex} の単位`}
                      className="h-7 w-full rounded-t4d border border-line px-1 text-small"
                    />
                  </TD>
                  <TD>
                    {(() => {
                      // 表示値はデモ変換済みの displayConfidence（無い場合は実測）。
                      // シミュレーション時も元スコアを読み上げで追跡できるようにする（title= はマウスでしか
                      // 読めないため使わない。デモであることは画面の先頭の注記が常に示す）
                      const shown = row.displayConfidence ?? row.confidence;
                      return (
                        <>
                          <span
                            className={
                              shown >= 0.7
                                ? 'tnum text-success'
                                : shown >= 0.4
                                  ? 'tnum text-warning-ink'
                                  : 'tnum text-danger'
                            }
                          >
                            {Math.round(shown * 100)}%
                          </span>
                          {row.confidenceSource === 'demo_simulated' && (
                            <span className="sr-only">
                              （実測スコア {Math.round(row.confidence * 100)}
                              %。表示はデモ用シミュレーション）
                            </span>
                          )}
                        </>
                      );
                    })()}
                  </TD>
                  <TD>
                    <SemanticBadge
                      semantic={status?.semantic ?? 'todo'}
                      label={status?.label ?? '未処理'}
                    />
                    {warnings.length > 0 && (
                      <ul className="mt-0.5 space-y-0.5">
                        {warnings.map((w, i) => (
                          <li key={i} className="text-caption text-warning-ink">
                            <span aria-hidden="true">⚠</span> {w}
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

      {ignored.length > 0 && (
        <Collapsible
          variant="plain"
          summary={`指標マスターと関係が無いため、${ignored.length} 行を取り込み対象外にしました（内容を確認する）`}
          className="border-t border-line px-3"
          bodyClassName="pl-0"
        >
          {/* デモで畳んだ低確信行（status は needs_review のまま）も確定 POST に含め、
              確定時は従来どおり「選択されなかった行」として除外（rejected）へ倒す。
              hidden を出さないと確定後も要確認のまま残り続ける */}
          {ignored
            .filter((row) => row.status !== 'ignored')
            .map((row) => (
              <React.Fragment key={`hidden-${row.id}`}>
                <input type="hidden" name="rowId" value={row.id} />
                <input
                  type="hidden"
                  name={`sourceLocator:${row.id}`}
                  value={row.sourceLocator ?? ''}
                />
              </React.Fragment>
            ))}
          <div className="t4d-scroll-x border-t border-line">
            <Table>
              <THead>
                <TR>
                  <TH>元データ</TH>
                  <TH className="w-[120px]">場所</TH>
                </TR>
              </THead>
              <TBody>
                {ignored.map((row) => (
                  <TR key={row.id}>
                    <TD className="max-w-[520px]">
                      <div className="truncate text-caption text-ink-muted">
                        {Object.entries(row.raw)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(' / ')}
                      </div>
                    </TD>
                    <TD className="text-caption text-ink-muted">{row.sourceLocator}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
          <p className="py-2 text-caption text-ink-muted">
            ここに取り込みたい行がある場合は、指標マスターへ該当の指標を登録してから取り込み直してください。
          </p>
        </Collapsible>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2">
        <p className="text-caption text-ink-muted">
          確定すると非財務データの台帳へ反映されます（既存データがある場合は新しい版が追加されます）。AI
          の推定は候補であり、確定は人が行います。
        </p>
        {/* 表示できる行が 1 件も無いとき（全行が対象外）に空確定させない */}
        <SubmitButton
          variant="primary"
          size="sm"
          icon={<Check aria-hidden="true" />}
          pendingLabel="確定中…"
          disabled={visible.length === 0}
        >
          選択した行を確定
        </SubmitButton>
      </div>
    </form>
  );
}
