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
  FlaskConical,
  Hourglass,
  Lock,
  Target,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { DetailBadge } from './detail-badge';
import { SemanticBadge, StatusBadge } from './status-badge';
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

/**
 * Data Point の状態。`needsRecheck` は「承認済みだが、承認後に証跡不足が見つかった」
 * （src/lib/validation/display-state.ts）。DB の状態は承認済みのまま、表示だけ変える（W0 O3）。
 * ラベル・色・アイコンは状態登録簿（src/lib/ui/status/dataPoint.ts）から決める
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
      <SemanticBadge
        semantic="blocked"
        label="承認済み・要再確認"
        detail="承認後に証跡不足が見つかりました。承認は取り消されていません。証跡を確認してください。"
      />
    );
  }
  return <StatusBadge domain="dataPoint" value={status} />;
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
    <DetailBadge tone={s.tone} detail={reason}>
      <s.Icon className="size-3" aria-hidden="true" />
      {AVAILABILITY_STATUS_LABELS[known]}
    </DetailBadge>
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
    <DetailBadge tone="warning" detail={detail}>
      <Hourglass className="size-3" aria-hidden="true" />
      集計未完了
    </DetailBadge>
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

export function ResponseStatusBadge({ status }: { status: ResponseStatus }) {
  return <StatusBadge domain="response" value={status} />;
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

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return <StatusBadge domain="job" value={status} />;
}

export function PbcStatusBadge({ status }: { status: PbcStatus }) {
  return <StatusBadge domain="pbc" value={status} />;
}

/** タスクの状態（DB の値 open / in_progress をそのまま出さない。ラベル＋アイコン） */
export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <StatusBadge domain="task" value={status} />;
}

export function TestStatusBadge({ status }: { status: TestStatus }) {
  return <StatusBadge domain="test" value={status} />;
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
    <DetailBadge tone="warning" detail="Supabase へ接続していません。表示は架空の Fixture です。">
      <FlaskConical className="size-3" aria-hidden="true" />
      デモデータ
    </DetailBadge>
  );
}

export function AiGeneratedBadge({ provider }: { provider: 'openai' | 'mock' }) {
  return provider === 'mock' ? (
    <DetailBadge tone="warning" detail="OpenAI API 未接続。決定論的 Mock AI の出力です。">
      <Bot className="size-3" aria-hidden="true" />
      Mock / AI未接続
    </DetailBadge>
  ) : (
    <DetailBadge tone="brand" detail="AI が生成した下書きです。人の確認・承認が必要です。">
      <Bot className="size-3" aria-hidden="true" />
      AI生成
    </DetailBadge>
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

/**
 * メンバーの状態。
 * 生の enum（invited / active / suspended）をそのまま出すと、
 * 日本語 UI の中で読み手が意味を推測することになる。
 * 色だけに頼らないよう、ラベルとアイコンを併記する（状態登録簿 membership）。
 */
export function MembershipStatusBadge({ status }: { status: MembershipStatus }) {
  return <StatusBadge domain="membership" value={status} />;
}
