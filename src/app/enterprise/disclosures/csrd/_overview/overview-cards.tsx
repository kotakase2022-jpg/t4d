import Link from 'next/link';
import {
  CircleCheck,
  CircleDashed,
  Database,
  ScrollText,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import { SectionTitle } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SSBJ_VS_CSRD_MATERIALITY_NOTE } from '@/lib/domain/csrd';
import { COVERAGE_LABEL } from '@/lib/domain/ssbj';
import { formatJst } from '@/lib/format/datetime';
import type { CsrdOverview } from '@/lib/services/csrd/requirements';
import {
  CSRD_APPLICABILITY_KINDS,
  DMA_OUTCOMES,
  SSBJ_COVERAGE_STATUSES,
  type CsrdApplicabilityKind,
} from '@/types/domain';
import { ApplicabilityBadge, DmaOutcomeBadge, ProvisionalBadge } from '../_components/csrd-badges';

/**
 * CSRD 対応状況の要約カード（docs/disclosure-first.md §9.4）。
 * 対応状況の画面の表は既存のギャップ分析表 1 つだけにするため、ここでは表を使わず
 * 一覧（ul / dl）で件数を示す。件数は必ず分母と並べる。
 */

const BASE = '/enterprise/disclosures/csrd';

/** ダブル・マテリアリティ評価（DMA）の要約: 結果ごとの事項数と確定の状態 */
export function DmaSummaryCard({ dma }: { dma: CsrdOverview['dma'] }) {
  return (
    <Card className="overflow-hidden">
      <SectionTitle
        title="ダブル・マテリアリティ評価（DMA）"
        action={
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
      />
      <div className="space-y-2 px-3 pb-3">
        <p className="text-[11px] leading-relaxed text-ink-muted">
          {SSBJ_VS_CSRD_MATERIALITY_NOTE}
        </p>
        <ul aria-label="事項の結果（人の判断）" className="grid grid-cols-5 gap-1.5">
          {DMA_OUTCOMES.map((outcome) => (
            <li key={outcome} className="space-y-1 rounded-t4d border border-line p-2">
              <DmaOutcomeBadge outcome={outcome} />
              <p className="text-[12px] text-ink">
                <span className="text-[16px] font-semibold tabular-nums">
                  {dma.outcomeCounts[outcome]}
                </span>{' '}
                / {dma.matterTotal} 事項
              </p>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-ink-muted">
            {dma.confirmed
              ? `${formatJst(dma.confirmedAt)} に ${dma.confirmedByName ?? '担当者'} が確定しました。DMA に関わる内容を変更すると確定は取り消されます。`
              : 'DMA が未確定のため、テーマ別の要求事項の適用は暫定です。確定は人の操作でのみ行われます。'}
          </p>
          <Button variant="outline" size="xs" asChild>
            <Link href={`${BASE}/settings`}>
              <Settings2 aria-hidden="true" />
              設定（報告範囲・DMA）を開く
            </Link>
          </Button>
        </div>
      </div>
    </Card>
  );
}

const KIND_QUERY: Record<CsrdApplicabilityKind, string> = {
  always: 'applicability=always',
  material: 'applicability=material',
  not_material: 'applicability=not_material',
  undetermined: 'applicability=undetermined',
};

/** 要求事項の適用の内訳（n / 12） */
export function ApplicabilityCard({ counts }: { counts: CsrdOverview['applicabilityCounts'] }) {
  return (
    <Card className="overflow-hidden">
      <SectionTitle
        title="要求事項の適用"
        action={
          <span className="text-[11px] text-ink-muted">
            評価対象（常に適用・重要）{' '}
            <strong className="tabular-nums text-ink">
              {counts.inScope} / {counts.total}
            </strong>{' '}
            件
          </span>
        }
      />
      <div className="space-y-2 px-3 pb-3">
        <ul aria-label="適用の内訳" className="grid grid-cols-2 gap-1.5">
          {CSRD_APPLICABILITY_KINDS.map((kind) => (
            <li key={kind}>
              <Link
                href={`${BASE}/requirements?${KIND_QUERY[kind]}`}
                className="flex items-center justify-between gap-2 rounded-t4d border border-line p-2 transition-colors hover:border-brand-300 hover:bg-brand-50"
              >
                <ApplicabilityBadge
                  applicability={{ kind, perspectives: [], provisional: false }}
                />
                <span className="text-[12px] text-ink">
                  <span className="text-[16px] font-semibold tabular-nums">{counts[kind]}</span> /{' '}
                  {counts.total} 件
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {counts.provisional > 0 && (
          <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-muted">
            <ProvisionalBadge />
            {counts.provisional} / {counts.total} 件の適用は DMA 確定前の暫定です（ESRS 2
            は重要性に関わらず適用のため暫定にしません）。
          </p>
        )}
      </div>
    </Card>
  );
}

const PERSPECTIVES = [
  { key: 'disclosure', label: '開示', Icon: ScrollText },
  { key: 'data', label: 'データ', Icon: Database },
  { key: 'process', label: '業務プロセス・内部統制', Icon: ShieldCheck },
  { key: 'combined', label: '総合（最も遅れている観点）', Icon: CircleCheck },
] as const;

/** 評価対象の 3 観点・総合の件数（重み付きの対応度%は出さない） */
export function CoverageCountsCard({
  counts,
  inScope,
}: {
  counts: CsrdOverview['coverageCounts'];
  inScope: number;
}) {
  return (
    <Card className="overflow-hidden">
      <SectionTitle
        title="評価対象の 3 観点"
        action={
          <span className="text-[11px] text-ink-muted">
            評価対象 {inScope} 件で集計（重み付きの対応度は出しません）
          </span>
        }
      />
      <div className="grid grid-cols-4 gap-1.5 px-3 pb-3">
        {PERSPECTIVES.map(({ key, label, Icon }) => (
          <section
            key={key}
            aria-label={`${label}の件数`}
            className="rounded-t4d border border-line p-2"
          >
            <h3 className="mb-1 flex items-center gap-1 text-[12px] font-semibold text-ink">
              <Icon className="size-3.5 text-ink-muted" aria-hidden="true" />
              {label}
            </h3>
            <dl className="space-y-0.5 text-[11px]">
              {SSBJ_COVERAGE_STATUSES.map((status) => (
                <div key={status} className="flex items-center justify-between gap-2">
                  <dt className="text-ink-muted">{COVERAGE_LABEL[status]}</dt>
                  <dd className="tabular-nums text-ink">
                    {counts[key][status]} / {inScope}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Card>
  );
}
