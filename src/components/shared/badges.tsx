import {
  AlertTriangle,
  Ban,
  Bot,
  Calculator,
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleHelp,
  FileWarning,
  FlaskConical,
  Hourglass,
  Loader2,
  Lock,
  Send,
  Target,
  Undo2,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { AVAILABILITY_STATUS_LABELS, VALUE_KIND_LABELS } from '@/lib/domain/disclosure-status';
import type {
  AvailabilityStatus,
  MembershipStatus,
  DataPointStatus,
  IssueSeverity,
  JobStatus,
  PbcStatus,
  Priority,
  ResponseStatus,
  ScopeInclusion,
  TaskStatus,
  TestStatus,
  ValidationSeverity,
  ValueKind,
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

/**
 * Data Point の状態。`needsRecheck` は「承認済みだが、承認後に証跡不足が見つかった」
 * （src/lib/validation/display-state.ts）。DB の状態は承認済みのまま、表示だけ変える（W0 O3）
 */
export function DataPointStatusBadge({
  status,
  needsRecheck = false,
}: {
  status: DataPointStatus;
  needsRecheck?: boolean;
}) {
  if (status === 'approved' && needsRecheck) {
    return (
      <Badge
        tone="warning"
        title="承認後に証跡不足が見つかりました。承認は取り消されていません。証跡を確認してください。"
      >
        <AlertTriangle className="size-3" aria-hidden="true" />
        承認済み・要再確認
      </Badge>
    );
  }
  const s = DATA_POINT_STATUS_MAP[status];
  return (
    <Badge tone={s.tone}>
      <s.Icon className="size-3" aria-hidden="true" />
      {s.label}
    </Badge>
  );
}

const AVAILABILITY_MAP: Record<AvailabilityStatus, { tone: Tone; Icon: typeof Check }> = {
  value_present: { tone: 'success', Icon: CircleCheck },
  not_entered: { tone: 'warning', Icon: CircleDashed },
  not_obtained: { tone: 'warning', Icon: Hourglass },
  not_applicable: { tone: 'neutral', Icon: Ban },
  not_calculated: { tone: 'warning', Icon: Calculator },
};

/**
 * 値の有無（値あり／未入力／未取得／対象外／未算定）。空欄を 0 と見せないために使う（§7.1）。
 * `reason` は未取得・対象外・未算定の理由（title で補足する）
 */
export function AvailabilityBadge({
  status,
  reason,
}: {
  /** 0039 より前の行（以前のデプロイの Cookie に残った行など）は状態を持たないことがある */
  status: AvailabilityStatus | undefined;
  reason?: string | null;
}) {
  // 状態の無い行は 0039 の backfill と同じく「値あり」として示す（画面を落とさない）
  const known: AvailabilityStatus = status && status in AVAILABILITY_MAP ? status : 'value_present';
  const s = AVAILABILITY_MAP[known];
  return (
    <Badge tone={s.tone} title={reason ?? undefined}>
      <s.Icon className="size-3" aria-hidden="true" />
      {AVAILABILITY_STATUS_LABELS[known]}
    </Badge>
  );
}

/** 値の区分（実績／推計／目標）。推計・目標を実績と取り違えないために使う（§7.1） */
export function ValueKindBadge({ kind }: { kind: ValueKind | undefined }) {
  const map: Record<ValueKind, { tone: Tone; Icon: typeof Check }> = {
    actual: { tone: 'neutral', Icon: Check },
    estimate: { tone: 'warning', Icon: CircleHelp },
    target: { tone: 'brand', Icon: Target },
  };
  // 区分の無い行（0039 より前）は backfill と同じく「実績」として示す
  const known: ValueKind = kind && kind in map ? kind : 'actual';
  const s = map[known];
  return (
    <Badge tone={s.tone}>
      <s.Icon className="size-3" aria-hidden="true" />
      {VALUE_KIND_LABELS[known]}
    </Badge>
  );
}

/**
 * 合計を出せない状態（例: Scope3 合計が未登録で、カテゴリーも揃っていない）。
 * 0 と表示すると「排出ゼロ」と読めてしまうため、ラベルで示す（W0 O4）
 */
export function AggregationIncompleteBadge({ detail }: { detail?: string }) {
  return (
    <Badge tone="warning" title={detail}>
      <Hourglass className="size-3" aria-hidden="true" />
      集計未完了
    </Badge>
  );
}

/**
 * 要求事項に対応付いた指標のデータの揃い具合（W0 O7）。
 * 1 つの指標に値があるだけで、複数の指標を求める項目を「データあり」としない。
 */
export function DataCoverageBadge({
  coverage,
  missingNames = [],
  noneLabel = 'データなし',
}: {
  coverage: 'full' | 'partial' | 'none';
  missingNames?: string[];
  /** 「データなし」の表記（承認済みの値だけを見る画面では「承認済みデータなし」） */
  noneLabel?: string;
}) {
  if (coverage === 'full') {
    return (
      <Badge tone="success">
        <CircleCheck className="size-3" aria-hidden="true" />
        データあり
      </Badge>
    );
  }
  if (coverage === 'partial') {
    return (
      <Badge tone="warning">
        <CircleAlert className="size-3" aria-hidden="true" />
        一部データあり（不足: {missingNames.join('・')}）
      </Badge>
    );
  }
  return (
    <Badge tone="warning">
      <CircleDashed className="size-3" aria-hidden="true" />
      {noneLabel}
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

const TASK_STATUS_MAP: Record<TaskStatus, { label: string; tone: Tone; icon: typeof CircleDot }> = {
  open: { label: '未着手', tone: 'neutral', icon: CircleDashed },
  in_progress: { label: '対応中', tone: 'brand', icon: Loader2 },
  blocked: { label: '保留（阻害あり）', tone: 'warning', icon: AlertTriangle },
  done: { label: '完了', tone: 'success', icon: CircleCheck },
  cancelled: { label: '取消', tone: 'neutral', icon: Ban },
};

/** タスクの状態（DB の値 open / in_progress をそのまま出さない。ラベル＋アイコン） */
export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const s = TASK_STATUS_MAP[status] ?? { label: '状態不明', tone: 'neutral', icon: CircleHelp };
  const Icon = s.icon;
  return (
    <Badge tone={s.tone}>
      <Icon className="size-3" aria-hidden="true" />
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
