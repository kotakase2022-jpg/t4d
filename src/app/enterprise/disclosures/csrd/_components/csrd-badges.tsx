import {
  ArrowDown,
  ArrowUp,
  Banknote,
  Calculator,
  Check,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleMinus,
  CircleX,
  Clock,
  Eye,
  FileCheck2,
  FlaskConical,
  Globe,
  Hourglass,
  Lock,
  Minus,
  Scale,
  TriangleAlert,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  CSRD_DATA_STATE_LABEL,
  CSRD_PROVISIONAL_LABEL,
  CSRD_SAMPLE_MASTER_LABEL,
  DMA_OUTCOME_LABEL,
  DMA_PERSPECTIVE_LABEL,
  applicabilityLabel,
  type CsrdApplicability,
  type CsrdDataState,
} from '@/lib/domain/csrd';
import { COVERAGE_LABEL, COVERAGE_TONE, PRIORITY_LABEL } from '@/lib/domain/ssbj';
import type { DmaOutcome, DmaPerspective, SsbjCoverageStatus, SsbjPriority } from '@/types/domain';

/**
 * CSRD の画面で使う状態バッジ（docs/disclosure-first.md §9.4）。
 * 状態は色だけで表さない（ラベルとアイコンを必ず併記する。CLAUDE.md §2）。
 * アイコンは装飾なので読み上げない（aria-hidden）。ラベルが状態そのもの。
 */

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'outline';

const OUTCOME_MAP: Record<DmaOutcome, { tone: Tone; Icon: typeof Check }> = {
  both: { tone: 'success', Icon: Scale },
  impact_only: { tone: 'brand', Icon: Globe },
  financial_only: { tone: 'brand', Icon: Banknote },
  not_material: { tone: 'neutral', Icon: CircleMinus },
  not_assessed: { tone: 'warning', Icon: CircleHelp },
};

/** 事項の結果（両面で重要／インパクトのみ／財務のみ／重要でない／未評価） */
export function DmaOutcomeBadge({ outcome }: { outcome: DmaOutcome }) {
  const s = OUTCOME_MAP[outcome];
  return (
    <Badge tone={s.tone}>
      <s.Icon className="size-3" aria-hidden="true" />
      {DMA_OUTCOME_LABEL[outcome]}
    </Badge>
  );
}

const PERSPECTIVE_ICON: Record<DmaPerspective, typeof Check> = {
  impact: Globe,
  financial: Banknote,
};

/** 適用になった観点（インパクト・財務）。観点が無ければ何も出さない */
export function PerspectiveBadges({ perspectives }: { perspectives: readonly DmaPerspective[] }) {
  if (perspectives.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {perspectives.map((perspective) => {
        const Icon = PERSPECTIVE_ICON[perspective];
        return (
          <Badge key={perspective} tone="outline">
            <Icon className="size-3" aria-hidden="true" />
            {DMA_PERSPECTIVE_LABEL[perspective]}
          </Badge>
        );
      })}
    </span>
  );
}

const APPLICABILITY_MAP: Record<CsrdApplicability['kind'], { tone: Tone; Icon: typeof Check }> = {
  always: { tone: 'brand', Icon: Lock },
  material: { tone: 'success', Icon: Check },
  not_material: { tone: 'neutral', Icon: CircleMinus },
  undetermined: { tone: 'warning', Icon: CircleHelp },
};

/** 暫定（DMA 確定前） */
export function ProvisionalBadge() {
  return (
    <Badge tone="warning">
      <Clock className="size-3" aria-hidden="true" />
      {CSRD_PROVISIONAL_LABEL}
    </Badge>
  );
}

/**
 * 要求事項の適用（ESRS 2（常に適用）／適用（観点）／対象外（重要でない）／未判定）。
 * 暫定のときは「暫定（DMA 確定前）」を併記する
 */
export function ApplicabilityBadge({
  applicability,
}: {
  applicability: Pick<CsrdApplicability, 'kind' | 'perspectives' | 'provisional'>;
}) {
  const s = APPLICABILITY_MAP[applicability.kind];
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={s.tone}>
        <s.Icon className="size-3" aria-hidden="true" />
        {applicabilityLabel(applicability)}
      </Badge>
      {applicability.provisional ? <ProvisionalBadge /> : null}
    </span>
  );
}

/** 架空のサンプル・マスター（正式な ESRS と見誤らせない） */
export function SampleMasterBadge() {
  return (
    <Badge tone="warning">
      <FlaskConical className="size-3" aria-hidden="true" />
      {CSRD_SAMPLE_MASTER_LABEL}
    </Badge>
  );
}

const DATA_STATE_MAP: Record<CsrdDataState, { tone: Tone; Icon: typeof Check }> = {
  approved: { tone: 'success', Icon: CircleCheck },
  in_review: { tone: 'brand', Icon: Eye },
  awaiting_submission: { tone: 'outline', Icon: Hourglass },
  not_entered: { tone: 'warning', Icon: CircleDashed },
};

/**
 * 当期のデータの状況（承認済み／レビュー中／提出待ち／未入力）。要求事項の詳細とデータ収集の画面で
 * 同じ状況を同じ見た目にするため、ここに 1 つだけ置く
 */
export function CsrdDataStateBadge({ state }: { state: CsrdDataState }) {
  const s = DATA_STATE_MAP[state];
  return (
    <Badge tone={s.tone}>
      <s.Icon className="size-3" aria-hidden="true" />
      {CSRD_DATA_STATE_LABEL[state]}
    </Badge>
  );
}

const COVERAGE_ICON: Record<SsbjCoverageStatus, typeof Check> = {
  covered: CircleCheck,
  mostly_covered: CircleCheck,
  partial: TriangleAlert,
  not_covered: CircleX,
  unconfirmed: CircleHelp,
};

/**
 * 対応状況（対応済み／おおむね対応／一部対応／未対応／未確認）。要求事項の一覧・詳細・開示ドラフトで
 * 同じ状態を同じ見た目（ラベル＋アイコン）にするため、ここに 1 つだけ置く。
 * prefix は「開示: 一部対応」のように何の状況かを文字で添えるとき
 */
export function CoverageStatusBadge({
  status,
  prefix,
}: {
  status: SsbjCoverageStatus;
  prefix?: string;
}) {
  const Icon = COVERAGE_ICON[status];
  return (
    <Badge tone={COVERAGE_TONE[status]}>
      <Icon className="size-3" aria-hidden="true" />
      {prefix ? `${prefix}: ` : ''}
      {COVERAGE_LABEL[status]}
    </Badge>
  );
}

/** 要求事項の人の確定値（3 観点をまとめた最終判定）。確定が無ければ「未確認」 */
export function FinalStatusBadge({ status }: { status: SsbjCoverageStatus | null }) {
  return <CoverageStatusBadge status={status ?? 'unconfirmed'} />;
}

const PRIORITY_STYLE: Record<
  SsbjPriority,
  { tone: 'danger' | 'warning' | 'neutral'; Icon: typeof Check }
> = {
  high: { tone: 'danger', Icon: ArrowUp },
  medium: { tone: 'warning', Icon: Minus },
  low: { tone: 'neutral', Icon: ArrowDown },
};

/** 優先度（「優先度: 高」のように何の値かを文字で示す）。一覧・詳細・対応計画で同じ見た目にする */
export function PlanPriorityBadge({ priority }: { priority: SsbjPriority }) {
  const s = PRIORITY_STYLE[priority];
  return (
    <Badge tone={s.tone}>
      <s.Icon className="size-3" aria-hidden="true" />
      優先度: {PRIORITY_LABEL[priority]}
    </Badge>
  );
}

/** 開示が求められる要求事項（任意の要求事項と区別する） */
export function RequiredItemBadge() {
  return (
    <Badge tone="brand">
      <FileCheck2 className="size-3" aria-hidden="true" />
      開示が求められる項目
    </Badge>
  );
}

/** 承認済みの値が推計であること（推計は推計のまま示し、実績と見誤らせない） */
export function EstimateValueBadge() {
  return (
    <Badge tone="warning" title="承認済みですが推計値です（実績値ではありません）">
      <Calculator className="size-3" aria-hidden="true" />
      推計
    </Badge>
  );
}
