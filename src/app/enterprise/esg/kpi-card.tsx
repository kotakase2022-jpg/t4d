import Link from 'next/link';
import { AlertTriangle, CheckCircle2, CircleDashed, Info, Target, XCircle } from 'lucide-react';
import { CategoryGrid } from '@/components/charts/category-grid';
import { FractionBar } from '@/components/charts/fraction-bar';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible } from '@/components/ui/collapsible';
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
 *
 * 文字量を減らすため（docs/disclosure-first.md §10.4 B6）、実績・目標・進捗率・比較条件の確認の
 * 最初の理由・集計中の途中値・「全社値は算定できません」だけを常に見せ、指標の注記・式・集計の内訳・
 * 遡及修正・副指標は既定で閉じた「注記・内訳」にまとめる（開閉は保存しない）。
 */

/** 表示用の丸め（小数 2 桁まで）。分数の文字に浮動小数の誤差（2268.3999…）を出さない */
function roundForDisplay(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * 進捗率の帯（基準 → 目標）。進捗率と同じ式 (基準 − 実績) ÷ (基準 − 目標) の分子・分母を、
 * 目標の向き（削減・増加）に揃えて「進んだ量 / 必要な量」で示す。逆向きに動いた年は分子が負になり、
 * 帯は伸びない（0 に見せかけず、数値の文字で負を示す）
 */
export function progressFraction(
  card: KpiCardView,
): { label: string; numerator: number; denominator: number; unit: string } | null {
  if (card.progress.status !== 'ok' || !card.target || card.actualValue === null) return null;
  const { baseValue, targetValue } = card.target.target;
  if (baseValue === null || baseValue === targetValue) return null;
  const reducing = baseValue > targetValue;
  const sign = reducing ? 1 : -1;
  return {
    label: `基準からの${reducing ? '削減' : '増加'}（目標まで）`,
    numerator: roundForDisplay((baseValue - card.actualValue) * sign),
    denominator: roundForDisplay(Math.abs(baseValue - targetValue)),
    unit: card.metric?.unit ?? '',
  };
}

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
      ? // 基準値にも単位を付ける（原単位の目標で、単位の無い数だけを読ませない。§4.2）
        `基準 ${t.baseYear} 年 ${formatNumber(t.baseValue)} ${unit}`.trim()
      : '基準値なし';
  return `${t.targetYear} 年 ${formatNumber(t.targetValue)} ${unit}（${base}・${KPI_DIRECTION_LABELS[t.direction]}・${KPI_TARGET_TYPE_LABELS[t.targetType]}・範囲「${t.boundary}」）`;
}

function ProgressView({ progress, card }: { progress: ProgressResult; card: KpiCardView }) {
  if (progress.status === 'ok') {
    const fraction = progressFraction(card);
    // 0〜100% の通常の進み方の説明は注記・内訳へ。目標から遠ざかった・目標を超えたときは読み違えないよう見せる
    const unusual = progress.rate < 0 || progress.rate > 100;
    return (
      <div className="space-y-1">
        <p className="tnum text-[14px] font-semibold text-ink">{formatPercent(progress.rate, 1)}</p>
        {fraction && (
          <FractionBar
            label={fraction.label}
            numerator={fraction.numerator}
            denominator={fraction.denominator}
            unit={fraction.unit}
            format={formatNumber}
          />
        )}
        {unusual && <p className="text-[11px] text-ink-muted">{progress.explanation}</p>}
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
        {/* 遡及修正の中身は注記・内訳へ。あること自体は差の読み方に関わるので見せる */}
        {yoy.notes.length > 0 && (
          <p className="text-[11px] text-ink-muted">遡及修正 {yoy.notes.length} 件あり</p>
        )}
      </div>
    );
  }
  if (yoy.status === 'needs_check') {
    const [first, ...rest] = yoy.reasons;
    return (
      <div className="space-y-0.5">
        <NeedsCheckBadge />
        {first && (
          <p className="text-[11px] text-ink-muted">
            {first}
            {rest.length > 0 && `（ほか ${rest.length} 件）`}
          </p>
        )}
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
    return (
      <div className="space-y-1">
        <p className="text-[11px] font-medium text-ink">
          カテゴリ別（{card.selectedPeriod.code}）: 登録あり {registered.length}/
          {card.subRows.length}
        </p>
        {/* データの無いカテゴリは値を渡さない（「0」と書かず「未算定」と示す） */}
        <CategoryGrid
          label={`Scope3 カテゴリ別（${card.selectedPeriod.code}）`}
          columns={3}
          items={card.subRows.map((row) => {
            const hasData = Boolean(row.state?.hasData);
            return {
              key: row.code,
              label: row.code.replace('scope3_cat', 'Cat.'),
              stateLabel: hasData ? row.statusLabel : '未算定（データなし）',
              icon: hasData ? CheckCircle2 : CircleDashed,
              filled: hasData,
              ...(hasData ? { value: row.display } : {}),
            };
          })}
        />
        <p className="text-[11px] text-ink-muted">カテゴリの値を足して Scope3 合計とはしません。</p>
      </div>
    );
  }
  return (
    <ul className="space-y-0.5 text-[11px]">
      {card.subRows.map((row) => (
        <li key={row.code} className="text-ink">
          {row.label}（{card.selectedPeriod.code}）: <span className="tnum">{row.display}</span>
        </li>
      ))}
    </ul>
  );
}

/** 「注記・内訳」の 1 行（閉じていても何が入っているか分かるよう件数を添える） */
function notesSummary(card: KpiCardView, noteCount: number): string {
  const parts = [`注記 ${noteCount} 件`];
  if (card.spec.kind === 'scope3' && card.subRows.length > 0) {
    const registered = card.subRows.filter((r) => r.state?.hasData).length;
    parts.push(`カテゴリ 登録あり ${registered}/${card.subRows.length}`);
  } else if (card.subRows.length > 0) {
    parts.push(`副指標 ${card.subRows.length} 件`);
  }
  return `注記・内訳（${parts.join('・')}）`;
}

/** 既定で閉じた「注記・内訳」: 指標の注記・進捗率の式・集計の内訳・遡及修正・比較条件の残りの理由・副指標 */
function CardNotes({ card }: { card: KpiCardView }) {
  const notes: string[] = [card.spec.note];
  if (card.progress.status === 'ok') {
    notes.push(`進捗率: ${card.progress.explanation}（式: ${PROGRESS_FORMULA}）`);
  }
  if (card.yoy.status === 'ok') {
    notes.push(...card.yoy.notes.map((note) => `遡及修正: ${note}`));
  } else if (card.yoy.status === 'needs_check') {
    notes.push(...card.yoy.reasons.slice(1).map((reason) => `前年との比較: ${reason}`));
  }
  notes.push(...card.dataState.details);
  return (
    <Collapsible variant="plain" summary={notesSummary(card, notes.length)}>
      <div className="space-y-2">
        <ul className="space-y-0.5 text-[11px] text-ink-muted">
          {notes.map((note, index) => (
            <li key={`${index}-${note}`} className="flex items-start gap-1">
              <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              <span>{note}</span>
            </li>
          ))}
        </ul>
        <SubRows card={card} />
      </div>
    </Collapsible>
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
            <ProgressView progress={card.progress} card={card} />
          </dd>
          <dt className="text-ink-muted">前年同条件との差</dt>
          <dd>
            <YoyView yoy={card.yoy} unit={unit} />
          </dd>
        </dl>
        <CardNotes card={card} />
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
