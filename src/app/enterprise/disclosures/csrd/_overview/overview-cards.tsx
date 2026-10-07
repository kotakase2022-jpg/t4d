import Link from 'next/link';
import {
  CircleCheck,
  CircleDashed,
  Database,
  ScrollText,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import { StatusBreakdown } from '@/components/charts/status-breakdown';
import { Section } from '@/components/shared/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DMA_OUTCOME_LABEL, applicabilityLabel } from '@/lib/domain/csrd';
import { COVERAGE_LABEL } from '@/lib/domain/ssbj';
import { formatJst } from '@/lib/format/datetime';
import type { CsrdOverview } from '@/lib/services/csrd/requirements';
import {
  CSRD_APPLICABILITY_KINDS,
  DMA_OUTCOMES,
  SSBJ_COVERAGE_STATUSES,
  type CsrdApplicabilityKind,
} from '@/types/domain';
import {
  APPLICABILITY_ICON,
  COVERAGE_ICON,
  DMA_OUTCOME_ICON,
  ProvisionalBadge,
} from '../_components/csrd-badges';
import { SsbjDifferenceLine } from '../settings/_components/materiality-note';

/**
 * CSRD 対応状況の要約（docs/disclosure-first.md §9.4・§10.4）。
 * 表は使わず、内訳の図（StatusBreakdown: 帯＋凡例の一覧）で件数を示す。件数は必ず分母と並べる（「n / N 件」）。
 * 帯の色は区分の識別だけで、良し悪しは示さない（ラベルとアイコンを必ず併記）。
 * 装飾の枠（Card）は使わず、見出しと罫線（Section）で区切る（plan §1.19）。
 */

const BASE = '/enterprise/disclosures/csrd';

/** ダブル・マテリアリティ評価（DMA）の要約: 結果ごとの事項数と確定の状態 */
export function DmaSummaryCard({ dma }: { dma: CsrdOverview['dma'] }) {
  return (
    <Section
      title="ダブル・マテリアリティ評価（DMA）"
      actions={
        dma.confirmed ? (
          <Badge tone="success">
            <CircleCheck className="size-3" aria-hidden="true" />
            確定済み
          </Badge>
        ) : (
          <Badge tone="warning">
            <CircleDashed className="size-3" aria-hidden="true" />
            未確定
          </Badge>
        )
      }
      bodyClassName="space-y-2.5"
    >
      <SsbjDifferenceLine />
      <StatusBreakdown
        label="事項の結果（人の判断）"
        unit="事項"
        denominator={dma.matterTotal}
        items={DMA_OUTCOMES.map((outcome) => ({
          key: outcome,
          label: DMA_OUTCOME_LABEL[outcome],
          count: dma.outcomeCounts[outcome],
          icon: DMA_OUTCOME_ICON[outcome],
        }))}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-caption text-ink-muted">
          {dma.confirmed
            ? `${formatJst(dma.confirmedAt)} に ${dma.confirmedByName ?? '担当者'} が確定しました。DMA に関わる内容を変更すると確定は取り消されます。`
            : 'DMA が未確定のため、テーマ別の要求事項の適用は暫定です。確定は人の操作でのみ行われます。'}
        </p>
        <Button variant="secondary" size="xs" asChild>
          <Link href={`${BASE}/settings`}>
            <Settings2 aria-hidden="true" />
            設定（報告範囲・DMA）を開く
          </Link>
        </Button>
      </div>
    </Section>
  );
}

const KIND_QUERY: Record<CsrdApplicabilityKind, string> = {
  always: 'applicability=always',
  material: 'applicability=material',
  not_material: 'applicability=not_material',
  undetermined: 'applicability=undetermined',
};

/** 要求事項の適用の内訳（n / 12）。各区分は要求事項の一覧（絞込）へのリンク */
export function ApplicabilityCard({ counts }: { counts: CsrdOverview['applicabilityCounts'] }) {
  return (
    <Section
      title="要求事項の適用"
      actions={
        <span className="text-caption text-ink-muted">
          評価対象（常に適用・重要）{' '}
          <strong className="tabular-nums text-ink">
            {counts.inScope} / {counts.total}
          </strong>{' '}
          件
        </span>
      }
      bodyClassName="space-y-2.5"
    >
      <StatusBreakdown
        label="適用の内訳"
        denominator={counts.total}
        items={CSRD_APPLICABILITY_KINDS.map((kind) => ({
          key: kind,
          label: applicabilityLabel({ kind, perspectives: [] }),
          count: counts[kind],
          icon: APPLICABILITY_ICON[kind],
          href: `${BASE}/requirements?${KIND_QUERY[kind]}`,
        }))}
      />
      {counts.provisional > 0 && (
        <p className="flex flex-wrap items-center gap-1.5 text-caption text-ink-muted">
          <ProvisionalBadge />
          {counts.provisional} / {counts.total} 件の適用は DMA 確定前の暫定です（ESRS 2
          は重要性に関わらず適用のため暫定にしません）。
        </p>
      )}
    </Section>
  );
}

const PERSPECTIVES = [
  { key: 'disclosure', label: '開示', Icon: ScrollText },
  { key: 'data', label: 'データ', Icon: Database },
  { key: 'process', label: '業務プロセス・内部統制', Icon: ShieldCheck },
  { key: 'combined', label: '総合（最も遅れている観点）', Icon: CircleCheck },
] as const;

/** 評価対象の 3 観点・総合の件数（観点ごとに積み上げ 1 本。重み付きの対応度%は出さない） */
export function CoverageCountsCard({
  counts,
  inScope,
}: {
  counts: CsrdOverview['coverageCounts'];
  inScope: number;
}) {
  return (
    <Section
      title="評価対象の 3 観点"
      actions={
        <span className="text-caption text-ink-muted">
          評価対象 {inScope} 件で集計（重み付きの対応度は出しません）
        </span>
      }
      bodyClassName="grid grid-cols-2 gap-x-4 gap-y-3"
    >
      {PERSPECTIVES.map(({ key, label, Icon }) => (
        <section key={key} aria-label={`${label}の件数`} className="min-w-0 space-y-1">
          <h3 className="flex items-center gap-1 text-small font-semibold text-ink">
            <Icon className="size-3.5 text-ink-muted" aria-hidden="true" />
            {label}
          </h3>
          <StatusBreakdown
            label={`${label}の内訳`}
            denominator={inScope}
            items={SSBJ_COVERAGE_STATUSES.map((status) => ({
              key: status,
              label: COVERAGE_LABEL[status],
              count: counts[key][status],
              icon: COVERAGE_ICON[status],
            }))}
          />
        </section>
      ))}
    </Section>
  );
}
