import { FileQuestion, FlaskConical, Scale } from 'lucide-react';
import { SemanticBadge, StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { DISCLOSURE_PROJECT_STATUS_LABELS } from '@/lib/domain/disclosure-status';
import { statusEntry, type StatusSemantic } from '@/lib/ui/status/registry';
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
 *
 * 色とアイコンは状態登録簿の「意味（semantic）」から決める（plan §3.2）。画面ローカルに tone の表を
 * 持たない（同じ意味が画面ごとに別の色・回転するアイコンになるのを防ぐ）。
 */

export function ApplicabilityBadge({
  status,
  confirmed,
}: {
  status: ApplicabilityStatus;
  /** 判断が確定済みか（候補・確認待ちは確定済みでも「確定」とは言わない） */
  confirmed?: boolean;
}) {
  const entry = statusEntry('applicabilityProject', status);
  const unconfirmed = confirmed === false && status !== 'not_assessed';
  return (
    <SemanticBadge
      semantic={entry.semantic}
      label={`${entry.label}${unconfirmed ? '（未確定）' : ''}`}
      dataAttributes={{ 'data-status-domain': 'applicabilityProject', 'data-status-value': status }}
    />
  );
}

/** 法的な位置付け（発効済み・公開草案・サンプル）。誠実さの表示なので語を省かない */
export function LegalStatusBadge({ legal }: { legal: FrameworkLegalView }) {
  const Icon = legal.isSample ? FlaskConical : legal.legalStatus === 'draft' ? FileQuestion : Scale;
  return (
    <Badge tone={legal.tone}>
      <Icon className="size-3" aria-hidden="true" />
      {legal.label}
    </Badge>
  );
}

export function ManuscriptStatusBadge({ status }: { status: BlockStatus | 'not_started' }) {
  if (status === 'not_started') return <SemanticBadge semantic="todo" label="未着手" />;
  return <StatusBadge domain="block" value={status} />;
}

const DECISION_SEMANTIC: Record<RequirementDecisionKind, StatusSemantic> = {
  material: 'done',
  not_applicable: 'excluded',
  not_material: 'excluded',
  // 未判定は判断を待っている（分母から消さない）
  not_assessed: 'pending',
};

export function RequirementDecisionBadge({
  kind,
  label,
}: {
  kind: RequirementDecisionKind;
  label: string;
}) {
  return <SemanticBadge semantic={DECISION_SEMANTIC[kind]} label={label} />;
}

const EVIDENCE_SEMANTIC: Record<EvidenceKind, StatusSemantic> = {
  current: 'done',
  prior_only: 'blocked',
  none: 'error',
  no_manuscript: 'todo',
};

export function EvidenceStateBadge({ kind, label }: { kind: EvidenceKind; label: string }) {
  return <SemanticBadge semantic={EVIDENCE_SEMANTIC[kind]} label={label} />;
}

const METRIC_SEMANTIC: Record<MetricKind, StatusSemantic> = {
  stale: 'blocked',
  unapproved: 'pending',
  missing_value: 'error',
  ok: 'done',
  none: 'todo',
};

export function MetricStateBadge({ kind, label }: { kind: MetricKind; label: string }) {
  return <SemanticBadge semantic={METRIC_SEMANTIC[kind]} label={label} />;
}

/** プロジェクトの状態（準備中 → 進行中 → 完了）。進行中を回転するアイコンで示さない */
const PROJECT_STATUS_SEMANTIC: Record<DisclosureProjectStatus, StatusSemantic> = {
  preparing: 'todo',
  active: 'draft',
  closed: 'done',
};

export function ProjectStatusBadge({ status }: { status: DisclosureProjectStatus }) {
  return (
    <SemanticBadge
      semantic={PROJECT_STATUS_SEMANTIC[status]}
      label={DISCLOSURE_PROJECT_STATUS_LABELS[status]}
    />
  );
}
