import {
  AlertTriangle,
  Ban,
  BookOpen,
  Check,
  CircleDashed,
  CircleDot,
  Clock,
  FileQuestion,
  FlaskConical,
  HelpCircle,
  Loader2,
  RefreshCcw,
  Scale,
  Send,
  Undo2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  APPLICABILITY_STATUS_LABELS,
  BLOCK_STATUS_LABELS,
  DISCLOSURE_PROJECT_STATUS_LABELS,
} from '@/lib/domain/disclosure-status';
import type { ApplicabilityStatus, BlockStatus, DisclosureProjectStatus } from '@/types/domain';
import type {
  EvidenceKind,
  FrameworkLegalView,
  MetricKind,
  RequirementDecisionKind,
} from '@/lib/services/disclosure-project';

/**
 * 開示プロジェクトの画面で使う状態バッジ。
 * 状態は色だけで表さない（ラベルとアイコンを必ず併記する。CLAUDE.md §2）。
 */

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'outline';

const APPLICABILITY_MAP: Record<ApplicabilityStatus, { tone: Tone; Icon: typeof Check }> = {
  not_assessed: { tone: 'neutral', Icon: CircleDashed },
  candidate: { tone: 'outline', Icon: CircleDot },
  awaiting_confirmation: { tone: 'warning', Icon: Clock },
  applicable: { tone: 'success', Icon: Check },
  voluntary: { tone: 'brand', Icon: Check },
  not_applicable: { tone: 'neutral', Icon: Ban },
};

export function ApplicabilityBadge({
  status,
  confirmed,
}: {
  status: ApplicabilityStatus;
  /** 判断が確定済みか（候補・確認待ちは確定済みでも「確定」とは言わない） */
  confirmed?: boolean;
}) {
  const s = APPLICABILITY_MAP[status];
  return (
    <Badge tone={s.tone}>
      <s.Icon className="size-3" aria-hidden="true" />
      {APPLICABILITY_STATUS_LABELS[status]}
      {confirmed === false && status !== 'not_assessed' ? '（未確定）' : ''}
    </Badge>
  );
}

export function LegalStatusBadge({ legal }: { legal: FrameworkLegalView }) {
  const Icon = legal.isSample ? FlaskConical : legal.legalStatus === 'draft' ? FileQuestion : Scale;
  return (
    <Badge tone={legal.tone}>
      <Icon className="size-3" aria-hidden="true" />
      {legal.label}
    </Badge>
  );
}

const BLOCK_MAP: Record<BlockStatus, { tone: Tone; Icon: typeof Check }> = {
  draft: { tone: 'outline', Icon: CircleDot },
  review_requested: { tone: 'brand', Icon: Send },
  returned: { tone: 'warning', Icon: Undo2 },
  approval_pending: { tone: 'brand', Icon: Loader2 },
  approved: { tone: 'success', Icon: Check },
};

export function ManuscriptStatusBadge({ status }: { status: BlockStatus | 'not_started' }) {
  if (status === 'not_started') {
    return (
      <Badge tone="neutral">
        <CircleDashed className="size-3" aria-hidden="true" />
        未着手
      </Badge>
    );
  }
  const s = BLOCK_MAP[status];
  return (
    <Badge tone={s.tone}>
      <s.Icon className="size-3" aria-hidden="true" />
      {BLOCK_STATUS_LABELS[status]}
    </Badge>
  );
}

const DECISION_MAP: Record<RequirementDecisionKind, { tone: Tone; Icon: typeof Check }> = {
  material: { tone: 'success', Icon: Check },
  not_applicable: { tone: 'neutral', Icon: Ban },
  not_material: { tone: 'neutral', Icon: Ban },
  not_assessed: { tone: 'warning', Icon: HelpCircle },
};

export function RequirementDecisionBadge({
  kind,
  label,
}: {
  kind: RequirementDecisionKind;
  label: string;
}) {
  const s = DECISION_MAP[kind];
  return (
    <Badge tone={s.tone}>
      <s.Icon className="size-3" aria-hidden="true" />
      {label}
    </Badge>
  );
}

const EVIDENCE_MAP: Record<EvidenceKind, { tone: Tone; Icon: typeof Check }> = {
  current: { tone: 'success', Icon: BookOpen },
  prior_only: { tone: 'warning', Icon: AlertTriangle },
  none: { tone: 'danger', Icon: AlertTriangle },
  no_manuscript: { tone: 'neutral', Icon: CircleDashed },
};

export function EvidenceStateBadge({ kind, label }: { kind: EvidenceKind; label: string }) {
  const s = EVIDENCE_MAP[kind];
  return (
    <Badge tone={s.tone}>
      <s.Icon className="size-3" aria-hidden="true" />
      {label}
    </Badge>
  );
}

const METRIC_MAP: Record<MetricKind, { tone: Tone; Icon: typeof Check }> = {
  stale: { tone: 'warning', Icon: RefreshCcw },
  unapproved: { tone: 'warning', Icon: AlertTriangle },
  missing_value: { tone: 'danger', Icon: AlertTriangle },
  ok: { tone: 'success', Icon: Check },
  none: { tone: 'neutral', Icon: CircleDashed },
};

export function MetricStateBadge({ kind, label }: { kind: MetricKind; label: string }) {
  const s = METRIC_MAP[kind];
  return (
    <Badge tone={s.tone}>
      <s.Icon className="size-3" aria-hidden="true" />
      {label}
    </Badge>
  );
}

const PROJECT_STATUS_MAP: Record<DisclosureProjectStatus, { tone: Tone; Icon: typeof Check }> = {
  preparing: { tone: 'outline', Icon: CircleDot },
  active: { tone: 'brand', Icon: Loader2 },
  closed: { tone: 'neutral', Icon: Check },
};

export function ProjectStatusBadge({ status }: { status: DisclosureProjectStatus }) {
  const s = PROJECT_STATUS_MAP[status];
  return (
    <Badge tone={s.tone}>
      <s.Icon className="size-3" aria-hidden="true" />
      {DISCLOSURE_PROJECT_STATUS_LABELS[status]}
    </Badge>
  );
}
