import {
  ArrowDown,
  ArrowUp,
  Ban,
  CircleDashed,
  CircleMinus,
  Database,
  EyeOff,
  FlaskConical,
  Minus,
  TriangleAlert,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  DEMO_BASELINE_NOTICE,
  EVIDENCE_KIND_LABEL,
  FINANCIAL_IMPACT_NOTICE,
  NO_ASSUMPTIONS_NOTICE,
  dataDepthNotice,
  formatMillionYen,
  type EvidenceKind,
  type PathwayStatus,
} from '@/lib/domain/financial-impact';
import { cn } from '@/lib/utils';

/**
 * 財務影響分析の表示部品（docs/disclosure-first.md §10.3）。
 *  - 状態・根拠の種類はラベル＋アイコン（色だけで示さない。CLAUDE.md §2）
 *  - 影響額は矢印＋符号＋文字（増益／減益）。良し悪しを色で示さない（中立色）
 *  - 誠実さの注記（試算・架空・データの厚み・前提なし）は折りたたまない
 */

const EVIDENCE_ICON: Record<EvidenceKind, typeof Database> = {
  data: Database,
  assumption: FlaskConical,
  unquantified: CircleDashed,
  out_of_scope: CircleMinus,
};

/** 根拠の種類（データに基づく／仮定に依存／未定量／算定対象外） */
export function EvidenceBadge({ kind }: { kind: EvidenceKind }) {
  const Icon = EVIDENCE_ICON[kind];
  return (
    <Badge tone={kind === 'data' ? 'outline' : 'neutral'}>
      <Icon className="size-3" aria-hidden="true" />
      {EVIDENCE_KIND_LABEL[kind]}
    </Badge>
  );
}

export function EvidenceBadges({ kinds }: { kinds: readonly EvidenceKind[] }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {kinds.map((kind) => (
        <EvidenceBadge key={kind} kind={kind} />
      ))}
    </span>
  );
}

/** 経路の状態（未定量・無効のときだけ。定量化できた経路は値で示す） */
export function PathwayStatusBadge({ status }: { status: PathwayStatus }) {
  if (status === 'quantified') return null;
  if (status === 'disabled') {
    return (
      <Badge tone="neutral">
        <Ban className="size-3" aria-hidden="true" />
        無効
      </Badge>
    );
  }
  return (
    <Badge tone="neutral">
      <CircleDashed className="size-3" aria-hidden="true" />
      {status === 'no_origin' ? '未算定' : '未定量'}
    </Badge>
  );
}

/** 増益／減益／変化なし（色ではなく文字で示す） */
export function directionWord(value: number): string {
  if (value > 0) return '増益';
  if (value < 0) return '減益';
  return '変化なし';
}

/**
 * 影響額（百万円・小数 1 桁、丸めは表示だけ）。矢印＋符号＋文字。null は「未定量」（0 にしない）
 */
export function ImpactValue({
  value,
  size = 'md',
  unquantifiedLabel = '未定量',
  className,
}: {
  value: number | null;
  size?: 'md' | 'lg';
  unquantifiedLabel?: string;
  className?: string;
}) {
  if (value === null) {
    return (
      <span className={cn('inline-flex items-center gap-1 text-[12px] text-ink-muted', className)}>
        <CircleDashed className="size-3.5 shrink-0" aria-hidden="true" />
        {unquantifiedLabel}
      </span>
    );
  }
  const Icon = value > 0 ? ArrowUp : value < 0 ? ArrowDown : Minus;
  return (
    <span className={cn('inline-flex items-baseline gap-1 whitespace-nowrap text-ink', className)}>
      <Icon
        className={cn('shrink-0 self-center', size === 'lg' ? 'size-4' : 'size-3.5')}
        aria-hidden="true"
      />
      <span
        className={cn(
          'tnum font-semibold',
          size === 'lg' ? 'text-[20px] leading-7' : 'text-[13px]',
        )}
      >
        {formatMillionYen(value)}
      </span>
      <span className="text-[11px] text-ink-muted">百万円（{directionWord(value)}）</span>
    </span>
  );
}

/** 「定量化できた経路のみ（n / N 経路）」。合計には必ず添える */
export function QuantifiedCount({ quantified, enabled }: { quantified: number; enabled: number }) {
  return (
    <span className="block text-[11px] text-ink-muted">
      定量化できた経路のみ（
      <span className="tnum font-semibold text-ink">
        {quantified} / {enabled}
      </span>{' '}
      経路）
    </span>
  );
}

/**
 * 常に見える注記（文言固定。E2E で確かめる）。試算であること・架空の前提／前提なし・データの厚み
 */
export function ImpactNotices({
  source,
  dataDepthYears,
}: {
  source: 'demo' | 'none';
  /** 基準年度が無いときは null（データの厚みは出さない） */
  dataDepthYears: number | null;
}) {
  return (
    <div
      role="note"
      aria-label="試算についての注記"
      className="flex items-start gap-2 rounded-t4d border border-warning/40 bg-warning-soft px-3 py-2 text-[12px] text-ink"
    >
      <FlaskConical className="mt-0.5 size-4 shrink-0 text-[#8a5d00]" aria-hidden="true" />
      <ul className="space-y-0.5">
        <li className="font-semibold">{FINANCIAL_IMPACT_NOTICE}</li>
        <li>{source === 'demo' ? DEMO_BASELINE_NOTICE : NO_ASSUMPTIONS_NOTICE}</li>
        {dataDepthYears !== null && <li>{dataDepthNotice(dataDepthYears)}</li>}
      </ul>
    </div>
  );
}

/** URL の値を既定に戻した通知（入力エラー。折りたたまない） */
export function ParamNotices({ notices }: { notices: readonly string[] }) {
  if (notices.length === 0) return null;
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-t4d border border-line bg-surface px-3 py-2 text-[12px] text-ink"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
      <div>
        <p className="font-semibold">URL の値の一部を既定に戻して試算しました</p>
        <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
          {notices.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** 権限が無く出さなかった領域の 1 行（折りたたまない） */
export function HiddenAreaNote({ note, areas }: { note: string; areas: string }) {
  return (
    <p
      role="note"
      className="flex items-center gap-1.5 rounded-t4d border border-line bg-surface-muted px-3 py-1.5 text-[12px] text-ink-muted"
    >
      <EyeOff className="size-3.5 shrink-0" aria-hidden="true" />
      {note}（{areas}）
    </p>
  );
}
