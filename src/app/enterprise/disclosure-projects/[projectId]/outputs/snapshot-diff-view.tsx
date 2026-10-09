import { ArrowRight, Minus, Plus } from 'lucide-react';
import { SemanticBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/states';
import { Collapsible } from '@/components/ui/collapsible';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { APPLICABILITY_STATUS_LABELS } from '@/lib/domain/disclosure-status';
import type { BlockChangeKind, MetricDiff, SnapshotDiff } from '@/lib/domain/snapshot-diff';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { SNAPSHOT_KIND_DISPLAY } from '@/lib/services/report-snapshot';
import type { ParagraphDiff } from '@/lib/domain/disclosure-block';

/**
 * 承認版どうしの差分の表示（トライアル対応 NF-13。出力タブの「差分を見る」）。
 * 2 つのスナップショット（固定した写し）だけから作った差分を示す。保存しない。
 * 変化の種類は色だけにせず、ラベル＋アイコン（SemanticBadge）と文字（追加・削除・変更）で示す。
 */

const BLOCK_CHANGE: Record<
  Exclude<BlockChangeKind, 'unchanged'>,
  { label: string; semantic: 'done' | 'excluded' | 'in_review' }
> = {
  added: { label: '追加', semantic: 'done' },
  removed: { label: '削除', semantic: 'excluded' },
  changed: { label: '変更', semantic: 'in_review' },
};

function metricValue(side: MetricDiff['from']): string {
  if (!side) return '—';
  const value =
    side.value !== null
      ? `${formatNumber(side.value)} ${side.unitOfMeasure}`.trim()
      : (side.textValue ?? '（値なし）');
  return `${value}（版 ${side.versionNo}）`;
}

function ParagraphChange({ diff }: { diff: ParagraphDiff }) {
  if (diff.kind === 'unchanged') return null;
  if (diff.kind === 'added' || diff.kind === 'removed') {
    const added = diff.kind === 'added';
    return (
      <li className="flex items-start gap-1.5">
        {added ? (
          <Plus className="mt-0.5 size-3 shrink-0 text-success" aria-hidden="true" />
        ) : (
          <Minus className="mt-0.5 size-3 shrink-0 text-danger" aria-hidden="true" />
        )}
        <span>
          <span className="font-medium">{added ? '追加: ' : '削除: '}</span>
          <span className={added ? undefined : 'line-through'}>{diff.text}</span>
        </span>
      </li>
    );
  }
  return (
    <li className="space-y-0.5">
      <span className="font-medium">変更: </span>
      <span>
        {diff.segments.map((segment, index) =>
          segment.op === 'equal' ? (
            <span key={index}>{segment.text}</span>
          ) : segment.op === 'insert' ? (
            <ins key={index} className="bg-success-soft no-underline">
              <span className="sr-only">（追加）</span>
              {segment.text}
            </ins>
          ) : (
            <del key={index} className="bg-danger-soft">
              <span className="sr-only">（削除）</span>
              {segment.text}
            </del>
          ),
        )}
      </span>
    </li>
  );
}

export function SnapshotDiffView({ diff }: { diff: SnapshotDiff }) {
  const label = (ref: SnapshotDiff['from']) =>
    `${SNAPSHOT_KIND_DISPLAY[ref.snapshotKind]} No.${ref.snapshotNo}（${formatJst(ref.createdAt)}）`;
  const changedBlocks = diff.blocks.filter((b) => b.kind !== 'unchanged');
  return (
    <div className="space-y-2" data-testid="snapshot-diff">
      <p className="flex flex-wrap items-center gap-1.5 text-small text-ink">
        <span>{label(diff.from)}</span>
        <ArrowRight className="size-3.5 text-ink-muted" aria-hidden="true" />
        <span>{label(diff.to)}</span>
      </p>
      <p className="text-small text-ink-muted">
        節 追加 {diff.summary.addedBlocks}・削除 {diff.summary.removedBlocks}・変更{' '}
        {diff.summary.changedBlocks}（段落 {diff.summary.changedParagraphs}）／数値{' '}
        {diff.summary.metricChanges}／要求事項の付け替え {diff.summary.requirementChanges}
        ／判断の変更 {diff.summary.decisionChanges}
      </p>
      {diff.summary.identical ? (
        <EmptyState
          kind="done"
          size="compact"
          title="違いはありません"
          description="2 つのスナップショットの本文・数値・要求事項・判断は同じです。"
        />
      ) : (
        <>
          {changedBlocks.length > 0 && (
            <div className="space-y-1.5">
              <h3 className="text-small font-semibold text-ink">節の本文</h3>
              <ul className="space-y-1.5">
                {changedBlocks.map((block) => {
                  const change = BLOCK_CHANGE[block.kind as Exclude<BlockChangeKind, 'unchanged'>];
                  return (
                    <li key={block.blockId} className="rounded-t4d border border-line px-2 py-1.5">
                      <p className="flex flex-wrap items-center gap-1.5 text-small font-medium text-ink">
                        <SemanticBadge semantic={change.semantic} label={change.label} />
                        {block.title}
                        <span className="text-caption font-normal text-ink-muted">
                          版 {block.fromVersionNo ?? '—'} → 版 {block.toVersionNo ?? '—'}
                          （変わった段落 {block.changedParagraphCount}）
                        </span>
                      </p>
                      {block.paragraphs.some((p) => p.kind !== 'unchanged') && (
                        <Collapsible variant="plain" summary="段落の差分を見る" className="mt-1">
                          <ul className="space-y-1 text-small text-ink">
                            {block.paragraphs.map((p) => (
                              <ParagraphChange key={`${p.kind}-${p.paragraphId}`} diff={p} />
                            ))}
                          </ul>
                        </Collapsible>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {diff.metrics.length > 0 && (
            <div className="t4d-scroll-x">
              <Table>
                <caption className="sr-only">数値の版と値の違い</caption>
                <THead>
                  <TR>
                    <TH>数値</TH>
                    <TH>変化</TH>
                    <TH>比較元</TH>
                    <TH>比較先</TH>
                  </TR>
                </THead>
                <TBody>
                  {diff.metrics.map((m) => (
                    <TR key={m.dataPointId}>
                      <TD className="text-small">{m.label}</TD>
                      <TD className="text-small">
                        {m.kind === 'added'
                          ? '追加'
                          : m.kind === 'removed'
                            ? '削除'
                            : '版・値の変更'}
                      </TD>
                      <TD className="text-small">{metricValue(m.from)}</TD>
                      <TD className="text-small">{metricValue(m.to)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
          {diff.requirements.length > 0 && (
            <ul className="space-y-0.5 text-small text-ink">
              {diff.requirements.map((r) => (
                <li key={r.blockId}>
                  要求事項の付け替え（{r.title}）: 追加 {r.added.join('、') || 'なし'}／外した{' '}
                  {r.removed.join('、') || 'なし'}
                </li>
              ))}
            </ul>
          )}
          {diff.decisions.length > 0 && (
            <ul className="space-y-0.5 text-small text-ink">
              {diff.decisions.map((d) => (
                <li key={d.frameworkVersionId}>
                  判断の変更（{d.label}）:{' '}
                  {d.presence !== 'both'
                    ? d.presence === 'added'
                      ? '基準を追加'
                      : '基準を外した'
                    : [
                        d.applicability
                          ? `適用判断 ${APPLICABILITY_STATUS_LABELS[d.applicability.from]} → ${APPLICABILITY_STATUS_LABELS[d.applicability.to]}`
                          : null,
                        d.decisionChanged && !d.applicability ? '適用判断の記録を更新' : null,
                        d.addedAssessmentEvents > 0
                          ? `要求事項の判断の記録 ${d.addedAssessmentEvents} 件`
                          : null,
                        d.addedExclusionEvents > 0
                          ? `対象外の申請・承認の記録 ${d.addedExclusionEvents} 件`
                          : null,
                        d.assessmentDigestChanged ? '評価の値が変わった' : null,
                      ]
                        .filter((t): t is string => t !== null)
                        .join('／')}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
