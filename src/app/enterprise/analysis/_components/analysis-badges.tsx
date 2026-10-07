import {
  BadgeCheck,
  Ban,
  CalendarClock,
  Check,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  Clock,
  FilePen,
  FlaskConical,
  Info,
  ShieldCheck,
  ShieldOff,
  TriangleAlert,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { DEMO_BENCHMARK_NOTICE } from '@/lib/domain/benchmark';
import type { DiagnosisState } from '@/lib/services/analysis/diagnosis';
import type { RegulationPositioningKind } from '@/lib/services/analysis/regulations';

/**
 * 分析の画面で使う状態バッジ（docs/disclosure-first.md §9.5・§9.6）。
 * 状態は色だけで表さない（ラベルとアイコンを必ず併記する。CLAUDE.md §2）。
 * アイコンは装飾なので読み上げない（aria-hidden）。ラベルが状態そのもの。
 * 他社比較では値の良し悪しを色で示さない（比較の可否・開示の有無だけをバッジにする）。
 */

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'outline';

const DIAGNOSIS_STATE_MAP: Record<DiagnosisState, { tone: Tone; Icon: typeof Check }> = {
  gap: { tone: 'warning', Icon: TriangleAlert },
  pending: { tone: 'brand', Icon: Clock },
  ok: { tone: 'success', Icon: CircleCheck },
  not_applicable: { tone: 'neutral', Icon: CircleMinus },
};

/** 領域の状態（不足あり／確認待ちあり／不足なし／算定対象外） */
export function DiagnosisStateBadge({ state, label }: { state: DiagnosisState; label: string }) {
  const s = DIAGNOSIS_STATE_MAP[state];
  return (
    <Badge tone={s.tone}>
      <s.Icon className="size-3" aria-hidden="true" />
      {label}
    </Badge>
  );
}

const POSITIONING_MAP: Record<RegulationPositioningKind, { tone: Tone; Icon: typeof Check }> = {
  published: { tone: 'success', Icon: BadgeCheck },
  draft_prep: { tone: 'brand', Icon: FilePen },
  sample: { tone: 'warning', Icon: FlaskConical },
  planned: { tone: 'neutral', Icon: CalendarClock },
  other: { tone: 'outline', Icon: Info },
};

/** 基準の位置付け（公表済み／公開草案に基づく準備／サンプル（架空）／今後対応予定） */
export function PositioningBadge({
  kind,
  label,
}: {
  kind: RegulationPositioningKind;
  label: string;
}) {
  const s = POSITIONING_MAP[kind];
  return (
    <Badge tone={s.tone}>
      <s.Icon className="size-3" aria-hidden="true" />
      {label}
    </Badge>
  );
}

/** 比較できる／比較対象外（良し悪しではなく、比較の可否だけを示す） */
export function ComparabilityBadge({ comparable }: { comparable: boolean }) {
  return comparable ? (
    <Badge tone="outline">
      <Check className="size-3" aria-hidden="true" />
      比較可
    </Badge>
  ) : (
    <Badge tone="neutral">
      <Ban className="size-3" aria-hidden="true" />
      比較対象外
    </Badge>
  );
}

/** 未開示（0 ではない） */
export function UndisclosedBadge() {
  return (
    <Badge tone="neutral">
      <CircleDashed className="size-3" aria-hidden="true" />
      未開示
    </Badge>
  );
}

/** 第三者保証の有無（注記。比較の可否には使わない） */
export function AssuranceNote({ assured }: { assured: boolean }) {
  const Icon = assured ? ShieldCheck : ShieldOff;
  return (
    <span className="inline-flex items-center gap-1 text-caption text-ink-muted">
      <Icon className="size-3" aria-hidden="true" />
      {assured ? '保証あり' : '保証なし'}
    </span>
  );
}

/** 架空の比較データであることの表示（画面の先頭） */
export function DemoBenchmarkBanner() {
  return (
    <div
      role="note"
      aria-label="比較データについて"
      className="flex items-start gap-2 rounded-t4d border border-warning/40 bg-warning-soft px-3 py-2 text-small text-ink"
    >
      <FlaskConical className="mt-0.5 size-4 shrink-0 text-warning-ink" aria-hidden="true" />
      <div>
        <p className="font-semibold">{DEMO_BENCHMARK_NOTICE}</p>
        <p className="mt-0.5 text-caption text-ink-muted">
          ピアA〜E社はデモ用に作った架空の会社です。他のテナント（他社の利用企業）のデータは使っていません。
        </p>
      </div>
    </div>
  );
}
