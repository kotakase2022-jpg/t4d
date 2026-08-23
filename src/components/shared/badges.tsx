import {
  AlertTriangle,
  Bot,
  Check,
  CircleDashed,
  CircleDot,
  FileWarning,
  FlaskConical,
  Loader2,
  Lock,
  Send,
  Undo2,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type {
  MembershipStatus,
  DataPointStatus,
  IssueSeverity,
  JobStatus,
  PbcStatus,
  Priority,
  ResponseStatus,
  ScopeInclusion,
  TestStatus,
  ValidationSeverity,
} from '@/types/domain';

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'outline';

/**
 * 状態は「色だけ」で表さない（指示書 5.4）。
 * すべてのバッジがラベル文字列とアイコンを併記する。
 */

const DATA_POINT_STATUS_MAP: Record<
  DataPointStatus,
  { label: string; tone: Tone; Icon: typeof Check }
> = {
  not_started: { label: '未着手', tone: 'neutral', Icon: CircleDashed },
  draft: { label: '入力中', tone: 'outline', Icon: CircleDot },
  submitted: { label: '提出済み', tone: 'brand', Icon: Send },
  in_review: { label: 'レビュー中', tone: 'brand', Icon: Loader2 },
  returned: { label: '差戻し', tone: 'warning', Icon: Undo2 },
  approved: { label: '承認済み', tone: 'success', Icon: Check },
};

export function DataPointStatusBadge({ status }: { status: DataPointStatus }) {
  const s = DATA_POINT_STATUS_MAP[status];
  return (
    <Badge tone={s.tone}>
      <s.Icon className="size-3" aria-hidden="true" />
      {s.label}
    </Badge>
  );
}

const RESPONSE_STATUS_MAP: Record<
  ResponseStatus,
  { label: string; tone: Tone; Icon: typeof Check }
> = {
  not_started: { label: '未着手', tone: 'neutral', Icon: CircleDashed },
  draft: { label: '作成中', tone: 'outline', Icon: CircleDot },
  in_review: { label: 'レビュー中', tone: 'brand', Icon: Loader2 },
  returned: { label: '差戻し', tone: 'warning', Icon: Undo2 },
  approved: { label: '承認済み', tone: 'success', Icon: Check },
};

export function ResponseStatusBadge({ status }: { status: ResponseStatus }) {
  const s = RESPONSE_STATUS_MAP[status];
  return (
    <Badge tone={s.tone}>
      <s.Icon className="size-3" aria-hidden="true" />
      {s.label}
    </Badge>
  );
}

const PRIORITY_MAP: Record<Priority, { label: string; tone: Tone }> = {
  critical: { label: '最優先', tone: 'danger' },
  high: { label: '高', tone: 'warning' },
  medium: { label: '中', tone: 'brand' },
  low: { label: '低', tone: 'neutral' },
};

export function PriorityBadge({ priority }: { priority: Priority }) {
  const p = PRIORITY_MAP[priority];
  return (
    <Badge tone={p.tone}>
      <CircleDot className="size-3" aria-hidden="true" />
      優先度: {p.label}
    </Badge>
  );
}

export function ValidationBadge({
  errorCount,
  warningCount,
}: {
  errorCount: number;
  warningCount: number;
}) {
  if (errorCount > 0) {
    return (
      <Badge tone="danger">
        <XCircle className="size-3" aria-hidden="true" />
        エラー {errorCount}
      </Badge>
    );
  }
  if (warningCount > 0) {
    return (
      <Badge tone="warning">
        <AlertTriangle className="size-3" aria-hidden="true" />
        警告 {warningCount}
      </Badge>
    );
  }
  return (
    <Badge tone="success">
      <Check className="size-3" aria-hidden="true" />
      検証OK
    </Badge>
  );
}

export function SeverityBadge({ severity }: { severity: ValidationSeverity }) {
  const map: Record<ValidationSeverity, { label: string; tone: Tone }> = {
    error: { label: 'エラー', tone: 'danger' },
    warning: { label: '警告', tone: 'warning' },
    info: { label: '情報', tone: 'neutral' },
  };
  const s = map[severity];
  return (
    <Badge tone={s.tone}>
      <AlertTriangle className="size-3" aria-hidden="true" />
      {s.label}
    </Badge>
  );
}

export function EvidenceBadge({ count, required }: { count: number; required: boolean }) {
  if (count > 0) {
    return (
      <Badge tone="success">
        <Check className="size-3" aria-hidden="true" />
        Evidence {count}
      </Badge>
    );
  }
  return required ? (
    <Badge tone="danger">
      <FileWarning className="size-3" aria-hidden="true" />
      Evidence 不足
    </Badge>
  ) : (
    <Badge tone="neutral">
      <CircleDashed className="size-3" aria-hidden="true" />
      Evidence なし
    </Badge>
  );
}

const JOB_STATUS_MAP: Record<JobStatus, { label: string; tone: Tone }> = {
  queued: { label: '待機中', tone: 'neutral' },
  processing: { label: '処理中', tone: 'brand' },
  needs_review: { label: '要確認', tone: 'warning' },
  completed: { label: '完了', tone: 'success' },
  failed: { label: '失敗', tone: 'danger' },
  cancelled: { label: '中止', tone: 'neutral' },
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const s = JOB_STATUS_MAP[status];
  return (
    <Badge tone={s.tone}>
      <CircleDot className="size-3" aria-hidden="true" />
      {s.label}
    </Badge>
  );
}

const PBC_STATUS_MAP: Record<PbcStatus, { label: string; tone: Tone }> = {
  draft: { label: '下書き', tone: 'neutral' },
  sent: { label: '送付済み', tone: 'brand' },
  acknowledged: { label: '受領確認', tone: 'brand' },
  submitted: { label: '提出済み', tone: 'brand' },
  under_review: { label: '確認中', tone: 'brand' },
  accepted: { label: '受理', tone: 'success' },
  rejected: { label: '差戻し', tone: 'warning' },
  overdue: { label: '期限超過', tone: 'danger' },
  closed: { label: 'クローズ', tone: 'neutral' },
};

export function PbcStatusBadge({ status }: { status: PbcStatus }) {
  const s = PBC_STATUS_MAP[status];
  return (
    <Badge tone={s.tone}>
      <CircleDot className="size-3" aria-hidden="true" />
      {s.label}
    </Badge>
  );
}

const TEST_STATUS_MAP: Record<TestStatus, { label: string; tone: Tone }> = {
  not_started: { label: '未着手', tone: 'neutral' },
  in_progress: { label: '実施中', tone: 'brand' },
  prepared: { label: '作成済み', tone: 'brand' },
  reviewed: { label: 'レビュー済み', tone: 'success' },
  exception: { label: '例外あり', tone: 'danger' },
};

export function TestStatusBadge({ status }: { status: TestStatus }) {
  const s = TEST_STATUS_MAP[status];
  return (
    <Badge tone={s.tone}>
      <FlaskConical className="size-3" aria-hidden="true" />
      {s.label}
    </Badge>
  );
}

export function IssueSeverityBadge({ severity }: { severity: IssueSeverity }) {
  const map: Record<IssueSeverity, { label: string; tone: Tone }> = {
    high: { label: '重要度: 高', tone: 'danger' },
    medium: { label: '重要度: 中', tone: 'warning' },
    low: { label: '重要度: 低', tone: 'neutral' },
  };
  const s = map[severity];
  return (
    <Badge tone={s.tone}>
      <AlertTriangle className="size-3" aria-hidden="true" />
      {s.label}
    </Badge>
  );
}

export function ScopeInclusionBadge({ inclusion }: { inclusion: ScopeInclusion }) {
  const map: Record<ScopeInclusion, { label: string; tone: Tone }> = {
    included: { label: '対象', tone: 'success' },
    excluded: { label: '対象外', tone: 'neutral' },
    pending: { label: '保留', tone: 'warning' },
  };
  const s = map[inclusion];
  return (
    <Badge tone={s.tone}>
      <CircleDot className="size-3" aria-hidden="true" />
      {s.label}
    </Badge>
  );
}

export function DemoDataBadge() {
  return (
    <Badge tone="warning" title="Supabase へ接続していません。表示は架空の Fixture です。">
      <FlaskConical className="size-3" aria-hidden="true" />
      デモデータ
    </Badge>
  );
}

export function AiGeneratedBadge({ provider }: { provider: 'openai' | 'mock' }) {
  return provider === 'mock' ? (
    <Badge tone="warning" title="OpenAI API 未接続。決定論的 Mock AI の出力です。">
      <Bot className="size-3" aria-hidden="true" />
      Mock / AI未接続
    </Badge>
  ) : (
    <Badge tone="brand" title="AI が生成した下書きです。人の確認・承認が必要です。">
      <Bot className="size-3" aria-hidden="true" />
      AI生成
    </Badge>
  );
}

export function ReadOnlyBadge({ label = 'Read-only（企業原本）' }: { label?: string }) {
  return (
    <Badge tone="neutral">
      <Lock className="size-3" aria-hidden="true" />
      {label}
    </Badge>
  );
}

const MEMBERSHIP_STATUS_MAP: Record<
  MembershipStatus,
  { label: string; tone: Tone; Icon: typeof Check }
> = {
  invited: { label: '招待中', tone: 'outline', Icon: Send },
  active: { label: '有効', tone: 'success', Icon: Check },
  suspended: { label: '停止中', tone: 'danger', Icon: Lock },
};

/**
 * メンバーの状態。
 * 生の enum（invited / active / suspended）をそのまま出すと、
 * 日本語 UI の中で読み手が意味を推測することになる。
 * 色だけに頼らないよう、ラベルとアイコンを併記する。
 */
export function MembershipStatusBadge({ status }: { status: MembershipStatus }) {
  const s = MEMBERSHIP_STATUS_MAP[status];
  return (
    <Badge tone={s.tone}>
      <s.Icon className="size-3" aria-hidden="true" />
      {s.label}
    </Badge>
  );
}
