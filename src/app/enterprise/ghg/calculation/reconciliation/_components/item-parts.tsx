import * as React from 'react';
import { StatusBadge } from '@/components/shared/status-badge';
import { StackedBar, StackedBarLegendChip } from '@/components/ui/stacked-bar';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { itemSubjectLabel } from '@/lib/domain/ghg/attribution';
import { activityLabel, GHG_SCOPE_LABELS } from '@/lib/domain/ghg/calculate';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import type { ReconciliationItemView } from '@/lib/services/ghg/reconciliation';
import { statusLabel, type GhgCauseState } from '@/lib/ui/status/registry';
import type { GhgReconVerdict, ReconciliationItem } from '@/types/domain';

/**
 * 照合の詳細（P98）の項目の部品。Server Component。
 *
 * 数値は保存した値を桁を多めに出す（表示の丸めで差を消さない）。単位はすべて t-CO2e。
 * 原因別の寄与は帯（絶対値の構成）と数値の表を並べる（色だけで示さない。帯の凡例にも名前と値を書く）。
 */

/** 表示の桁（差を消さないよう多めに。末尾の 0 は出さない） */
export const T_DIGITS = { fraction: 6 } as const;

export function formatT(value: number | null): string {
  return value === null ? '—' : formatNumber(value, T_DIGITS);
}

/** 項目の活動（区分の合計だけの項目は「区分の合計」） */
export function itemActivityText(
  item: Pick<ReconciliationItem, 'activityKind' | 'activityCode' | 'month' | 'shipmentRef'>,
): string {
  const activity =
    item.activityKind && item.activityCode
      ? activityLabel(item.activityKind, item.activityCode)
      : '区分の合計';
  const subject = itemSubjectLabel(item);
  return subject ? `${activity}・${subject}` : activity;
}

/** 項目の名前（拠点・区分・活動〔・月・出荷〕） */
export function itemLabel(
  item: Pick<
    ReconciliationItem,
    'unitId' | 'scope' | 'activityKind' | 'activityCode' | 'month' | 'shipmentRef'
  >,
  unitName: (id: string | null) => string,
): string {
  return `${unitName(item.unitId)}・${GHG_SCOPE_LABELS[item.scope]}・${itemActivityText(item)}`;
}

/** 判定の並び（要確認を先に） */
export const VERDICT_ORDER: Record<GhgReconVerdict, number> = {
  needs_review: 0,
  unexplained: 1,
  one_sided: 2,
  cause_confirmed: 3,
  within_tolerance: 4,
};

/** 主な原因のバッジ（寄与の最大。残差が最大なら「原因不明（残差）」。差が無ければ —） */
export function MainCauseBadge({
  item,
}: {
  item: Pick<ReconciliationItem, 'mainCause' | 'residual'>;
}) {
  if (item.mainCause) return <StatusBadge domain="ghgCause" value={item.mainCause} />;
  if (item.residual !== 0) return <StatusBadge domain="ghgCause" value="residual" />;
  return <span className="text-ink-muted">—</span>;
}

/** 展開行: 原因別の寄与・単独差・残差・確認の記録の履歴 */
export function ItemBreakdown({
  item,
  userName,
  whatIfHref,
}: {
  item: ReconciliationItemView;
  userName: (id: string) => string;
  /** この項目で仮説の再計算をする行き先（候補が無ければ null） */
  whatIfHref: string | null;
}) {
  const segments: Array<{ key: GhgCauseState; value: number; signed: number }> = [
    ...item.steps
      .filter((s) => s.delta !== 0)
      .map((s) => ({ key: s.cause, value: Math.abs(s.delta), signed: s.delta })),
    ...(item.residual !== 0
      ? [{ key: 'residual' as const, value: Math.abs(item.residual), signed: item.residual }]
      : []),
  ];
  const sum = item.steps.reduce((a, s) => a + s.delta, 0) + item.residual;
  return (
    <div className="space-y-2" data-item-breakdown={item.key}>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0">
          <p className="mb-1 text-small font-semibold text-ink">
            原因別の寄与（上から順に既存の算定の前提に揃えた差・t-CO2e）
          </p>
          <Table>
            <caption className="sr-only">原因別の寄与</caption>
            <THead>
              <TR>
                <TH align="right">順</TH>
                <TH>原因</TH>
                <TH align="right">寄与</TH>
                <TH align="right">単独差</TH>
                <TH>適用</TH>
              </TR>
            </THead>
            <TBody>
              {item.steps.map((step, index) => (
                <TR key={step.cause}>
                  <TD align="right" className="tnum">
                    {index + 1}
                  </TD>
                  <TD>
                    <StatusBadge domain="ghgCause" value={step.cause} />
                  </TD>
                  <TD align="right" className="tnum">
                    {formatT(step.delta)}
                  </TD>
                  <TD align="right" className="tnum">
                    {formatT(item.single.find((s) => s.cause === step.cause)?.delta ?? null)}
                  </TD>
                  <TD className="text-caption">
                    {step.applicable ? '適用' : '適用できない（既存の側に情報が無い）'}
                  </TD>
                </TR>
              ))}
              <TR>
                <TD />
                <TD>
                  <StatusBadge domain="ghgCause" value="residual" />
                </TD>
                <TD align="right" className="tnum">
                  {formatT(item.residual)}
                </TD>
                <TD />
                <TD className="text-caption">説明できない差</TD>
              </TR>
              <TR>
                <TD />
                <TD className="font-medium">合計（＝差 既存−T4D）</TD>
                <TD align="right" className="tnum font-medium">
                  {formatT(sum)}
                </TD>
                <TD />
                <TD className="text-caption">差 {formatT(item.diff)}</TD>
              </TR>
            </TBody>
          </Table>
          <p className="mt-1 text-caption text-ink-muted">
            読み方は、この表の上の「原因別の寄与の読み方」をご覧ください（順序で配分が変わること・単独差の合計と総差の関係）。
          </p>
        </div>
        <div className="min-w-0 space-y-1">
          <p className="text-small font-semibold text-ink">寄与の大きさ（絶対値の構成）</p>
          {segments.length === 0 ? (
            <p className="text-small text-ink-muted">差はありません。</p>
          ) : (
            <>
              <StackedBar
                label="原因別の寄与の大きさ"
                unit=" t"
                segments={segments.map((s) => ({
                  label: statusLabel('ghgCause', s.key),
                  value: s.value,
                }))}
              />
              <ul className="space-y-0.5 text-caption">
                {segments.map((s, index) => (
                  <li key={s.key} className="flex items-center gap-1.5">
                    <StackedBarLegendChip index={index} />
                    <StatusBadge domain="ghgCause" value={s.key} />
                    <span className="tnum">{formatT(s.signed)} t</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {whatIfHref && (
            <a
              href={whatIfHref}
              className="inline-block text-small text-brand-700 underline-offset-2 hover:underline"
            >
              この項目で仮説の再計算をする（保存しません）
            </a>
          )}
        </div>
      </div>
      <div>
        <p className="mb-1 text-small font-semibold text-ink">確認の記録</p>
        {item.notes.length === 0 ? (
          <p className="text-small text-ink-muted">まだ確認の記録はありません。</p>
        ) : (
          <ul className="space-y-1 text-small">
            {[...item.notes].reverse().map((note) => (
              <li key={note.id} className="flex flex-wrap items-center gap-1.5">
                <span className="tnum text-caption text-ink-muted">
                  {formatJst(note.decidedAt)}
                </span>
                <span>{userName(note.decidedBy)}</span>
                <StatusBadge domain="ghgCause" value={note.confirmedCause} />
                {note.comment && <span className="text-ink">{note.comment}</span>}
                {item.latestNote?.id === note.id ? (
                  <span className="text-caption text-ink-muted">（最新）</span>
                ) : (
                  <span className="text-caption text-ink-muted">（差し替え済み）</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
