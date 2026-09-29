'use client';

import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Equal,
  HelpCircle,
  PencilLine,
  Plus,
  XCircle,
} from 'lucide-react';
import { DataPointStatusBadge } from '@/components/shared/badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import type {
  QuantitativeImportPreview,
  QuantitativeImportPreviewRow,
} from '@/lib/services/quantitative-import';
import type { QuantitativeImportDiffKind } from '@/types/domain';

/**
 * 検証結果の表示（列対応 → 検証 → 追加・更新差分）。
 *
 * 原文セルと変換後の値を並べ、何をどう読んだかを利用者が確かめられるようにする。
 * 状態は色だけで表さない（区分はラベル＋アイコン、理由は文で出す）。
 */

const DIFF_META: Record<
  QuantitativeImportDiffKind,
  {
    tone: 'brand' | 'warning' | 'neutral' | 'danger';
    Icon: typeof Plus;
  }
> = {
  new: { tone: 'brand', Icon: Plus },
  changed: { tone: 'warning', Icon: PencilLine },
  unchanged: { tone: 'neutral', Icon: Equal },
  error: { tone: 'danger', Icon: XCircle },
};

export function DiffKindBadge({
  kind,
  label,
}: {
  kind: QuantitativeImportDiffKind;
  label: string;
}) {
  const meta = DIFF_META[kind];
  return (
    <Badge tone={meta.tone}>
      <meta.Icon className="size-3" aria-hidden="true" />
      {label}
    </Badge>
  );
}

export function MappingSection({ preview }: { preview: QuantitativeImportPreview }) {
  const candidates = preview.mapping.filter((m) => m.candidate).length;
  const unused = preview.mapping.filter((m) => m.field === null).length;
  return (
    <section aria-labelledby="standard-mapping-title" className="space-y-2">
      <h3 id="standard-mapping-title" className="text-[13px] font-semibold text-ink">
        2. 列対応（標準列の確認）
      </h3>
      <p className="text-[12px] text-ink-muted">
        {preview.sourceKind === 'manual'
          ? '手入力の項目は標準列のとおりです。'
          : `${preview.formatLabel}／文字コード: ${preview.encoding}／${preview.delimiterLabel}`}
      </p>
      {candidates > 0 && (
        <p className="flex items-start gap-1.5 rounded-t4d border border-warning/40 bg-warning-soft px-3 py-1.5 text-[12px] text-ink">
          <HelpCircle className="mt-0.5 size-3.5 shrink-0 text-[#8a5d00]" aria-hidden="true" />
          標準列名と一致しない見出しが {candidates}{' '}
          列あり、標準列の「候補」に対応付けました。下の対応が正しいか確認してください。
        </p>
      )}
      {preview.sourceKind !== 'manual' && (
        <div className="overflow-x-auto rounded-t4d border border-line">
          <Table>
            <THead>
              <TR>
                <TH>ファイルの見出し</TH>
                <TH>対応する標準列</TH>
                <TH>判定</TH>
              </TR>
            </THead>
            <TBody>
              {preview.mapping.map((m, index) => (
                <TR key={`${m.header}-${index}`}>
                  <TD className="font-mono text-[12px]">
                    {m.header || `（見出しなし ${index + 1} 列目）`}
                  </TD>
                  <TD>{m.fieldLabel ?? '—'}</TD>
                  <TD>
                    {m.field === null ? (
                      <Badge tone="neutral">
                        <CircleSlash className="size-3" aria-hidden="true" />
                        使わない列
                      </Badge>
                    ) : m.candidate ? (
                      <Badge tone="warning">
                        <HelpCircle className="size-3" aria-hidden="true" />
                        候補（要確認）
                      </Badge>
                    ) : (
                      <Badge tone="success">
                        <CheckCircle2 className="size-3" aria-hidden="true" />
                        標準列
                      </Badge>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
      {unused > 0 && (
        <p className="text-[11px] text-ink-muted">
          使わない列 {unused} 列は登録に使いません（エラーにはしません）。
        </p>
      )}
    </section>
  );
}

export function SummarySection({ preview }: { preview: QuantitativeImportPreview }) {
  const tiles: Array<{ kind: QuantitativeImportDiffKind; label: string; hint: string }> = [
    { kind: 'new', label: '新規', hint: '新しく登録する値' },
    { kind: 'changed', label: '変更', hint: '新しい版を追加する値（旧版は残る）' },
    { kind: 'unchanged', label: '変更なし', hint: '既存と同じ。版を作らない' },
    { kind: 'error', label: 'エラー', hint: '登録しない行（理由を表示）' },
  ];
  return (
    <section aria-labelledby="standard-summary-title" className="space-y-2">
      {/* 検証の直後にフォーカスを移す先（tabIndex=-1: Tab 順には入れない） */}
      <h3 id="standard-summary-title" tabIndex={-1} className="text-[13px] font-semibold text-ink">
        3. 検証
      </h3>
      <p className="text-[12px] text-ink-muted">
        「{preview.fileName}」 {preview.rows.length} 行を検証しました（まだ登録していません）。
      </p>
      <ul className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {tiles.map((tile) => {
          const meta = DIFF_META[tile.kind];
          return (
            <li key={tile.kind} className="rounded-t4d-lg border border-line bg-surface px-3 py-2">
              <span className="flex items-center gap-1 text-[11px] font-medium text-ink-muted">
                <meta.Icon className="size-3" aria-hidden="true" />
                {tile.label}
              </span>
              <span className="tnum mt-0.5 block text-[20px] font-semibold leading-7 text-ink">
                {preview.counts[tile.kind]}
                <span className="ml-1 text-[12px] font-normal text-ink-muted">行</span>
              </span>
              <span className="block text-[11px] text-ink-muted">{tile.hint}</span>
            </li>
          );
        })}
      </ul>
      {preview.fileWarnings.length > 0 && (
        <ul className="space-y-1">
          {preview.fileWarnings.map((warning) => (
            <li
              key={warning}
              className="flex items-start gap-1.5 rounded-t4d border border-warning/40 bg-warning-soft px-3 py-1.5 text-[12px] text-ink"
            >
              <AlertTriangle
                className="mt-0.5 size-3.5 shrink-0 text-[#8a5d00]"
                aria-hidden="true"
              />
              {warning}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type Filter = 'all' | QuantitativeImportDiffKind;

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'すべて' },
  { key: 'error', label: 'エラー' },
  { key: 'changed', label: '変更' },
  { key: 'new', label: '新規' },
  { key: 'unchanged', label: '変更なし' },
];

function ValueCell({ row }: { row: QuantitativeImportPreviewRow }) {
  if (row.availabilityStatus !== 'value_present') {
    return (
      <span className="text-ink">
        {row.availabilityLabel}
        {row.absenceReason && (
          <span className="block text-[11px] text-ink-muted">理由: {row.absenceReason}</span>
        )}
      </span>
    );
  }
  if (row.valueDisplay === '—') {
    return <span className="text-ink-muted">読み取れません</span>;
  }
  return (
    <span className="tnum whitespace-nowrap">
      {row.valueDisplay}
      {row.unitOfMeasure && (
        <span className="ml-1 text-[11px] text-ink-muted">{row.unitOfMeasure}</span>
      )}
    </span>
  );
}

function PreviousCell({ row }: { row: QuantitativeImportPreviewRow }) {
  const previous = row.previous;
  if (!previous) return <span className="text-[11px] text-ink-muted">既存の値なし</span>;
  return (
    <div className="space-y-0.5">
      <div className="tnum whitespace-nowrap text-right">
        {previous.valueDisplay}
        {previous.availabilityStatus === 'value_present' && (
          <span className="ml-1 text-[11px] text-ink-muted">{previous.unitOfMeasure}</span>
        )}
      </div>
      <div className="flex items-center justify-end gap-1 text-[11px] text-ink-muted">
        {previous.versionNo !== null && <span>v{previous.versionNo}</span>}
        <DataPointStatusBadge status={previous.status} />
      </div>
      {row.delta && row.diffKind === 'changed' && (
        <div className="tnum text-right text-[12px] font-medium text-ink">差 {row.delta}</div>
      )}
    </div>
  );
}

export function DiffTable({ preview }: { preview: QuantitativeImportPreview }) {
  const [filter, setFilter] = React.useState<Filter>('all');
  const rows = filter === 'all' ? preview.rows : preview.rows.filter((r) => r.diffKind === filter);
  const countOf = (key: Filter) =>
    key === 'all' ? preview.rows.length : preview.counts[key as QuantitativeImportDiffKind];

  return (
    <section aria-labelledby="standard-diff-title" className="space-y-2">
      <h3 id="standard-diff-title" className="text-[13px] font-semibold text-ink">
        4. 追加・更新差分
      </h3>
      <div role="group" aria-label="差分の絞り込み" className="flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <Button
            key={f.key}
            variant={filter === f.key ? 'secondary' : 'outline'}
            size="xs"
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            {f.label}（{countOf(f.key)}）
          </Button>
        ))}
      </div>
      <div className="max-h-[560px] overflow-auto rounded-t4d border border-line">
        <Table className="min-w-[1280px]">
          {/* 列見出しは固定（縦に長い差分でも、どの列か見失わない） */}
          <THead className="sticky top-0 z-10 bg-surface">
            <TR>
              <TH className="bg-surface">行</TH>
              <TH className="bg-surface">区分</TH>
              <TH className="bg-surface">原文セル（値）</TH>
              <TH className="bg-surface" align="right">
                変換後の値
              </TH>
              <TH className="bg-surface">指標</TH>
              <TH className="bg-surface">期間</TH>
              <TH className="bg-surface">組織・集計範囲</TH>
              <TH className="bg-surface">値の区分</TH>
              <TH className="bg-surface">算定方法・出所</TH>
              <TH className="bg-surface" align="right">
                既存値との差
              </TH>
              <TH className="bg-surface">理由・注意</TH>
            </TR>
          </THead>
          <TBody>
            {rows.length === 0 ? (
              <TR>
                <TD colSpan={11} className="py-6 text-center text-[12px] text-ink-muted">
                  この区分の行はありません。
                </TD>
              </TR>
            ) : (
              rows.map((row) => (
                <TR key={row.rowNo} className="align-top">
                  <TD className="tnum align-top text-[12px] text-ink-muted">
                    {preview.sourceKind === 'manual' ? '手入力' : row.rowNo}
                  </TD>
                  <TD className="align-top">
                    <DiffKindBadge kind={row.diffKind} label={row.diffLabel} />
                  </TD>
                  <TD className="align-top">
                    <span className="font-mono text-[12px]">
                      {row.valueRaw === '' ? (
                        <span className="text-ink-muted">（空欄）</span>
                      ) : (
                        row.valueRaw
                      )}
                    </span>
                    {preview.sourceKind !== 'manual' && (
                      <details className="mt-0.5 text-[11px] text-ink-muted">
                        <summary className="cursor-pointer">元の行</summary>
                        <dl className="mt-0.5 space-y-0.5">
                          {Object.entries(row.raw).map(([header, cell]) => (
                            <div key={header} className="flex gap-1">
                              <dt className="font-mono">{header}:</dt>
                              <dd className="break-all font-mono text-ink">{cell || '（空欄）'}</dd>
                            </div>
                          ))}
                        </dl>
                      </details>
                    )}
                  </TD>
                  <TD align="right" className="align-top">
                    <ValueCell row={row} />
                  </TD>
                  <TD className="align-top">
                    <span className="font-mono text-[12px]">{row.metricCode ?? '—'}</span>
                    {row.metricName && (
                      <span className="block text-[11px] text-ink-muted">{row.metricName}</span>
                    )}
                  </TD>
                  <TD className="align-top whitespace-nowrap">
                    {row.periodLabel ?? '—'}
                    {row.periodRange && (
                      <span className="block text-[11px] text-ink-muted">{row.periodRange}</span>
                    )}
                  </TD>
                  <TD className="align-top">
                    <span className="font-mono text-[12px]">{row.entityCode ?? '—'}</span>
                    {row.unitName && <span className="ml-1">{row.unitName}</span>}
                    <span className="block text-[11px] text-ink-muted">
                      集計範囲: {row.boundary ?? '—'}
                    </span>
                  </TD>
                  <TD className="align-top whitespace-nowrap">
                    {row.valueKindLabel}
                    <span className="block text-[11px] text-ink-muted">
                      {row.availabilityLabel}
                    </span>
                  </TD>
                  <TD className="align-top text-[12px]">
                    <span className="block">算定方法: {row.methodology ?? '—'}</span>
                    <span className="block break-all text-ink-muted">
                      出所: {row.sourceReference ?? '—'}
                    </span>
                  </TD>
                  <TD align="right" className="align-top">
                    <PreviousCell row={row} />
                  </TD>
                  <TD className="align-top">
                    <ul className="min-w-[240px] space-y-0.5 text-[12px]">
                      {row.errors.map((error) => (
                        <li key={error} className="flex items-start gap-1 text-ink">
                          <XCircle
                            className="mt-0.5 size-3 shrink-0 text-danger"
                            aria-hidden="true"
                          />
                          <span>
                            <span className="sr-only">エラー: </span>
                            {error}
                          </span>
                        </li>
                      ))}
                      {row.warnings.map((warning) => (
                        <li key={warning} className="flex items-start gap-1 text-ink-muted">
                          <AlertTriangle
                            className="mt-0.5 size-3 shrink-0 text-[#8a5d00]"
                            aria-hidden="true"
                          />
                          <span>
                            <span className="sr-only">注意: </span>
                            {warning}
                          </span>
                        </li>
                      ))}
                      {row.errors.length === 0 && row.warnings.length === 0 && (
                        <li className="text-ink-muted">—</li>
                      )}
                    </ul>
                  </TD>
                </TR>
              ))
            )}
          </TBody>
        </Table>
      </div>
    </section>
  );
}
