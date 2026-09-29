import Link from 'next/link';
import { AlertTriangle, CheckCircle2, CircleDashed, Info, Target, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { KPI_DIRECTION_LABELS, KPI_TARGET_TYPE_LABELS } from '@/lib/domain/disclosure-status';
import { formatNumber, formatPercent } from '@/lib/format/datetime';
import {
  PROGRESS_FORMULA,
  type KpiCardView,
  type KpiDataState,
  type KpiTargetView,
  type ProgressResult,
  type YoyResult,
} from '@/lib/services/kpi';

/**
 * ESG 経営の KPI カード（Server Component）。
 * 状態は色だけで示さない（バッジはラベルとアイコンを併記する）。
 * 率・差を出さない理由（比較条件の確認が必要・分母 0 など）は、そのまま文で示す。
 */

export function signed(value: number): string {
  if (value === 0) return '±0';
  return `${value > 0 ? '+' : '−'}${formatNumber(Math.abs(value))}`;
}

export function DataStateBadge({ state }: { state: KpiDataState }) {
  const Icon =
    state.tone === 'success'
      ? CheckCircle2
      : state.tone === 'warning'
        ? AlertTriangle
        : state.tone === 'danger'
          ? XCircle
          : CircleDashed;
  return (
    <Badge tone={state.tone}>
      <Icon className="size-3" aria-hidden="true" />
      {state.label}
    </Badge>
  );
}

export function NeedsCheckBadge() {
  return (
    <Badge tone="warning">
      <AlertTriangle className="size-3" aria-hidden="true" />
      比較条件の確認が必要
    </Badge>
  );
}

export function targetText(view: KpiTargetView, unit: string): string {
  const t = view.target;
  const base =
    t.baseYear !== null && t.baseValue !== null
      ? `基準 ${t.baseYear} 年 ${formatNumber(t.baseValue)}`
      : '基準値なし';
  return `${t.targetYear} 年 ${formatNumber(t.targetValue)} ${unit}（${base}・${KPI_DIRECTION_LABELS[t.direction]}・${KPI_TARGET_TYPE_LABELS[t.targetType]}・範囲「${t.boundary}」）`;
}

function ProgressView({ progress }: { progress: ProgressResult }) {
  if (progress.status === 'ok') {
    return (
      <div>
        <p className="tnum text-[14px] font-semibold text-ink">{formatPercent(progress.rate, 1)}</p>
        <p className="text-[11px] text-ink-muted">{progress.explanation}</p>
        <p className="text-[11px] text-ink-muted">式: {PROGRESS_FORMULA}</p>
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      {progress.code === 'not_comparable' && <NeedsCheckBadge />}
      <p className="text-[11px] text-ink-muted">{progress.reason}</p>
    </div>
  );
}

function YoyView({ yoy, unit }: { yoy: YoyResult; unit: string }) {
  if (yoy.status === 'ok') {
    return (
      <div>
        <p className="tnum text-ink">
          {signed(yoy.diff)} {unit}
          <span className="ml-1 text-[11px] text-ink-muted">
            （{yoy.previousPeriod.code} 比
            {yoy.diffRate === null
              ? '・前年値が 0 のため率は出しません'
              : ` ${yoy.diffRate > 0 ? '+' : yoy.diffRate < 0 ? '−' : '±'}${formatPercent(Math.abs(yoy.diffRate), 1)}`}
            ）
          </span>
        </p>
        {yoy.notes.length > 0 && (
          <ul className="mt-0.5 list-disc pl-4 text-[11px] text-ink-muted">
            {yoy.notes.map((note) => (
              <li key={note}>遡及修正: {note}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  if (yoy.status === 'needs_check') {
    return (
      <div className="space-y-0.5">
        <NeedsCheckBadge />
        <ul className="list-disc pl-4 text-[11px] text-ink-muted">
          {yoy.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </div>
    );
  }
  return <p className="text-[11px] text-ink-muted">{yoy.reason}</p>;
}

function ActualView({ card }: { card: KpiCardView }) {
  const unit = card.metric?.unit ?? '';
  const current = card.current;
  return (
    <div>
      {card.actualValue !== null && card.confirmed ? (
        <p className="text-ink">
          <span className="tnum text-[16px] font-semibold">{formatNumber(card.actualValue)}</span>{' '}
          {unit}
          <span className="ml-1 text-[11px] text-ink-muted">
            （{card.confirmed.period.code}・確定／範囲「{card.confirmed.boundary ?? '—'}」）
          </span>
        </p>
      ) : current && !current.computable ? (
        <p className="text-ink">全社値は算定できません</p>
      ) : (
        <p className="text-ink">確定した実績はありません</p>
      )}
      {current &&
        current.computable &&
        !current.complete &&
        current.approvedValue !== null &&
        current.period.id !== card.confirmed?.period.id && (
          <p className="text-[11px] text-ink-muted">
            {current.period.code} は集計中: 承認済み分のみ {formatNumber(current.approvedValue)}{' '}
            {unit}（実績・進捗率・前年差には使いません）
          </p>
        )}
    </div>
  );
}

function SubRows({ card }: { card: KpiCardView }) {
  if (card.subRows.length === 0) return null;
  if (card.spec.kind === 'scope3') {
    const registered = card.subRows.filter((r) => r.state?.hasData);
    const unregistered = card.subRows.filter((r) => !r.state?.hasData);
    return (
      <div className="rounded-t4d border border-line bg-surface-muted px-2 py-1.5">
        <p className="text-[11px] font-medium text-ink">
          カテゴリ別（{card.selectedPeriod.code}）: 登録あり {registered.length}/
          {card.subRows.length}
        </p>
        <ul className="mt-0.5 space-y-0.5 text-[11px] text-ink">
          {registered.map((row) => (
            <li key={row.code}>
              {row.label}: <span className="tnum">{row.display}</span>
            </li>
          ))}
        </ul>
        {unregistered.length > 0 && (
          <p className="mt-0.5 text-[11px] text-ink-muted">
            未算定（データなし）:{' '}
            {unregistered.map((row) => row.code.replace('scope3_cat', 'Cat.')).join('、')}
          </p>
        )}
        <p className="mt-0.5 text-[11px] text-ink-muted">
          カテゴリの値を足して Scope3 合計とはしません。
        </p>
      </div>
    );
  }
  return (
    <ul className="space-y-0.5 rounded-t4d border border-line bg-surface-muted px-2 py-1.5 text-[11px]">
      {card.subRows.map((row) => (
        <li key={row.code} className="text-ink">
          {row.label}（{card.selectedPeriod.code}）: <span className="tnum">{row.display}</span>
        </li>
      ))}
    </ul>
  );
}

export function KpiCard({ card, detailHref }: { card: KpiCardView; detailHref?: string }) {
  const unit = card.metric?.unit ?? '';
  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-wrap">
        <CardTitle>{card.spec.label}</CardTitle>
        <DataStateBadge state={card.dataState} />
      </CardHeader>
      <CardContent className="flex-1 space-y-2 text-[12px]">
        <p className="flex items-start gap-1 text-[11px] text-ink-muted">
          <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          {card.spec.note}
        </p>
        <dl className="grid grid-cols-[8em_1fr] gap-x-2 gap-y-1.5">
          <dt className="text-ink-muted">実績</dt>
          <dd>
            <ActualView card={card} />
          </dd>
          <dt className="text-ink-muted">目標</dt>
          <dd>
            {card.target ? (
              <div>
                <p className="flex items-start gap-1 text-ink">
                  <Target className="mt-0.5 size-3 shrink-0 text-brand-600" aria-hidden="true" />
                  {targetText(card.target, unit)}
                </p>
                <p className="text-[11px] text-ink-muted">
                  版 {card.target.target.versionNo}
                  {card.target.ownerName ? `・責任者 ${card.target.ownerName}` : ''}
                  {card.otherTargetCount > 0 ? `・ほか ${card.otherTargetCount} 件の目標` : ''}
                </p>
              </div>
            ) : (
              <p className="text-ink-muted">目標は登録されていません</p>
            )}
          </dd>
          <dt className="text-ink-muted">目標差</dt>
          <dd>
            {card.targetGap.status === 'ok' ? (
              <p className="tnum text-ink">
                {signed(card.targetGap.gap)} {unit}
                <span className="ml-1 text-[11px] text-ink-muted">
                  （実績 − 目標値。{card.targetGap.text}）
                </span>
              </p>
            ) : (
              <p className="text-[11px] text-ink-muted">{card.targetGap.reason}</p>
            )}
          </dd>
          <dt className="text-ink-muted">進捗率</dt>
          <dd>
            <ProgressView progress={card.progress} />
          </dd>
          <dt className="text-ink-muted">前年同条件との差</dt>
          <dd>
            <YoyView yoy={card.yoy} unit={unit} />
          </dd>
        </dl>
        {card.dataState.details.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-ink-muted">
            {card.dataState.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        )}
        <SubRows card={card} />
      </CardContent>
      {detailHref && (
        <div className="border-t border-line px-3 py-2 text-right">
          <Link
            href={detailHref}
            className="text-[12px] font-medium text-brand-700 hover:underline"
          >
            {card.spec.label} の詳細（推移・内訳・根拠）
          </Link>
        </div>
      )}
    </Card>
  );
}
