import {
  Banknote,
  Check,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleMinus,
  Clock,
  Eye,
  FlaskConical,
  Globe,
  Hourglass,
  Lock,
  Scale,
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
import type { DmaOutcome, DmaPerspective } from '@/types/domain';

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
