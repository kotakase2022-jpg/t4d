import {
  Bot,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleMinus,
  CircleX,
  PenLine,
  TriangleAlert,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { COVERAGE_LABEL, COVERAGE_TONE } from '@/lib/domain/ssbj';
import type { CsrdDisclosureDraft, SsbjCoverageStatus } from '@/types/domain';

/**
 * CSRD 開示ドラフトの状態バッジ。色だけで状態を表さない（ラベルとアイコンを併記する。CLAUDE.md §2）。
 */

export type CsrdDraftState = 'confirmed' | 'body_unconfirmed' | 'ai_only' | 'none';

/** 節の状態: 確定済み／本文あり・未確定／AI 草案のみ（本文未採用）／未作成 */
export function draftStateOf(draft: CsrdDisclosureDraft | null): CsrdDraftState {
  if (!draft) return 'none';
  if (draft.confirmedAt) return 'confirmed';
  if (draft.body.trim() !== '') return 'body_unconfirmed';
  if (draft.aiBody.trim() !== '') return 'ai_only';
  return 'none';
}

const DRAFT_STATE: Record<
  CsrdDraftState,
  { label: string; tone: 'success' | 'warning' | 'brand' | 'neutral'; Icon: typeof Bot }
> = {
  confirmed: { label: '確定済み', tone: 'success', Icon: CircleCheck },
  body_unconfirmed: { label: '本文あり・未確定', tone: 'warning', Icon: PenLine },
  ai_only: { label: 'AI 草案のみ（本文未採用）', tone: 'brand', Icon: Bot },
  none: { label: '未作成', tone: 'neutral', Icon: CircleDashed },
};

export function DraftStateBadge({ state }: { state: CsrdDraftState }) {
  const s = DRAFT_STATE[state];
  return (
    <Badge tone={s.tone}>
      <s.Icon className="size-3" aria-hidden="true" />
      {s.label}
    </Badge>
  );
}

const COVERAGE_ICON: Record<SsbjCoverageStatus, typeof Bot> = {
  covered: CircleCheck,
  mostly_covered: CircleCheck,
  partial: TriangleAlert,
  not_covered: CircleX,
  unconfirmed: CircleHelp,
};

/** 要求事項の人の確定値（3 観点をまとめた最終判定）。確定が無ければ「未確認」 */
export function FinalStatusBadge({ status }: { status: SsbjCoverageStatus | null }) {
  const value = status ?? 'unconfirmed';
  const Icon = COVERAGE_ICON[value];
  return (
    <Badge tone={COVERAGE_TONE[value]}>
      <Icon className="size-3" aria-hidden="true" />
      {COVERAGE_LABEL[value]}
    </Badge>
  );
}

/** 担当者の確認の有無（AI の候補だけの要求事項は草案の根拠にならない） */
export function ReviewedBadge({ reviewed }: { reviewed: boolean }) {
  return reviewed ? (
    <Badge tone="outline">
      <CircleCheck className="size-3" aria-hidden="true" />
      担当者確認済み
    </Badge>
  ) : (
    <Badge tone="neutral">
      <CircleMinus className="size-3" aria-hidden="true" />
      担当者未確認
    </Badge>
  );
}
