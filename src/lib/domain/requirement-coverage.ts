/**
 * 要求事項の 5 区分・不足の種類・対象外の承認の状態・担当と期限の出所（トライアル対応 2026-10: NF-02・NF-03）。
 *
 * 区分は保存しない。要求事項タブ・対応表（requirement-matrix）・開示ホーム・定性情報の基準別の状況が、
 * **同じ関数**で毎回導く（件数を画面ごとに食い違わせない。Demo の Cookie も増やさない）。
 *
 * 区分（スライド 5 の 4 区分＋未判定）:
 *  - 対象外（excluded）: 理由付きの対象外・非重要で、別の人が承認済み。または基準単位の対象外判断
 *  - 未判定（undetermined）: 判断なし・理由なしの除外・承認待ち（分母から外さない）
 *  - 未対応（not_addressed）: 適用で、節が無い・節が下書きで不足（定性情報の未記入・当年度の根拠なし・
 *    数値の値なし）・人の評価の最も遅い観点が「未対応」
 *  - 追加確認が必要（needs_check）: 適用で上記以外の未完了（レビュー中・未承認の数値・要再確認・過年度根拠のみ・
 *    AI 判定のみ・評価「一部」）。公開草案・サンプルの基準はここが上限（K6: 充足確認済みにしない）
 *  - 充足確認済み（confirmed）: 対応する節がすべて承認済みで再確認なし・引用数値が承認済み・当年度根拠あり・
 *    人の評価の最も遅い観点が「対応済み／おおむね」・基準の版が公表済み以降
 *
 * DB にも画面にも依存しない純粋関数だけを置く。クライアントの部品からも読めるよう node:crypto を使わない
 * （理由のダイジェストは domain/exclusion-digest.ts。サーバーだけで作る）。
 */

import type {
  BlockStatus,
  ExclusionDecision,
  ExclusionEventType,
  IsoDate,
  IsoDateTime,
  SsbjCoverageStatus,
  Uuid,
} from '@/types/domain';

// ======================================================================
// 区分と不足の種類
// ======================================================================

export const REQUIREMENT_COVERAGE_CATEGORIES = [
  'confirmed',
  'needs_check',
  'not_addressed',
  'undetermined',
  'excluded',
] as const;
export type RequirementCoverageCategory = (typeof REQUIREMENT_COVERAGE_CATEGORIES)[number];

/** 不足の種類（原稿なし・定性情報の未記入・数値なし・根拠なし・データ観点・業務プロセス観点） */
export const REQUIREMENT_GAP_KINDS = [
  'manuscript',
  'narrative',
  'metric',
  'evidence',
  'data',
  'process',
] as const;
export type RequirementGapKind = (typeof REQUIREMENT_GAP_KINDS)[number];

export const REQUIREMENT_GAP_LABELS: Readonly<Record<RequirementGapKind, string>> = {
  manuscript: '原稿なし',
  narrative: '定性情報の未記入',
  metric: '数値なし',
  evidence: '根拠なし',
  data: 'データ観点',
  process: '業務プロセス観点',
};

/** 公開草案・サンプルの基準の上限の補足（K6）。人の確認が済んでいても充足確認済みにしない理由 */
export const DRAFT_STANDARD_CAP_NOTE = '公開草案・サンプルに基づく準備（人の確認済み）';

export type RequirementEvidenceKind = 'current' | 'prior_only' | 'none' | 'no_manuscript';
export type RequirementMetricKind = 'stale' | 'unapproved' | 'missing_value' | 'ok' | 'none';

export interface RequirementCoverageBlock {
  status: BlockStatus;
  /** 保存済みの版がある */
  hasVersion: boolean;
  /** 引用先に新しい版がある・承認後の変更がある（要再確認） */
  recheck: boolean;
  /** 翻訳版の節（要求事項の判定は翻訳元の節で行う） */
  translation: boolean;
}

/** 人の 3 観点の評価（null は未評価） */
export interface RequirementHumanCoverage {
  disclosure: SsbjCoverageStatus | null;
  data: SsbjCoverageStatus | null;
  process: SsbjCoverageStatus | null;
}

export type RequirementDecisionKindForCoverage =
  'applicable' | 'not_applicable' | 'not_material' | 'not_assessed';

export interface RequirementCoverageInput {
  /**
   * 基準の版が公表済み以降か。公開草案（draft）・サンプル（sample）・未確認の版は false
   * （人の確認が済んでいても充足確認済みにしない: K6）
   */
  frameworkPublished: boolean;
  /** 基準単位で対象外と判断した（判断の記録あり）。要求事項はすべて対象外 */
  frameworkExcluded: boolean;
  decision: {
    kind: RequirementDecisionKindForCoverage;
    /** 対象外・非重要の理由（無ければ null） */
    reason: string | null;
    /** 対象外・非重要が別の人に承認されている（理由・区分が承認時から変わっていない） */
    exclusionApproved: boolean;
  };
  blocks: readonly RequirementCoverageBlock[];
  /** 引用した定性情報に未記入の項目がある */
  narrativeMissingFields: boolean;
  evidence: RequirementEvidenceKind;
  metrics: RequirementMetricKind;
  /** 人の評価（無ければ null） */
  human: RequirementHumanCoverage | null;
  /** 評価が AI の候補だけ（人が確認していない） */
  aiOnly: boolean;
}

export interface RequirementCoverageResult {
  category: RequirementCoverageCategory;
  gaps: RequirementGapKind[];
  /** 区分の理由（画面の補足・対応表の列。生の enum を出さない日本語） */
  reasons: string[];
}

const COVERAGE_RANK: Readonly<Record<SsbjCoverageStatus, number>> = {
  covered: 0,
  mostly_covered: 1,
  partial: 2,
  not_covered: 3,
  unconfirmed: 4,
};

/** 人の評価の最も遅い観点。3 観点のどれかが未評価（null）なら null */
export function slowestHumanCoverage(
  human: RequirementHumanCoverage | null,
): SsbjCoverageStatus | null {
  if (!human || human.disclosure === null || human.data === null || human.process === null) {
    return null;
  }
  return [human.disclosure, human.data, human.process].reduce((worst, status) =>
    COVERAGE_RANK[status] > COVERAGE_RANK[worst] ? status : worst,
  );
}

function gapsOf(input: RequirementCoverageInput, originals: RequirementCoverageBlock[]) {
  const gaps: RequirementGapKind[] = [];
  if (originals.length === 0 || !originals.some((b) => b.hasVersion)) gaps.push('manuscript');
  if (input.narrativeMissingFields) gaps.push('narrative');
  if (input.metrics === 'missing_value') gaps.push('metric');
  if (input.evidence === 'none' || input.evidence === 'prior_only') gaps.push('evidence');
  const human = input.human;
  if (human?.data === 'partial' || human?.data === 'not_covered') gaps.push('data');
  if (human?.process === 'partial' || human?.process === 'not_covered') gaps.push('process');
  return gaps;
}

/**
 * 要求事項 1 件の区分を決める（保存しない）。不足の種類と理由も返す。
 * 理由の無い除外・承認待ちの除外は対象外にしない（分母から外さない）
 */
export function classifyRequirement(input: RequirementCoverageInput): RequirementCoverageResult {
  const originals = input.blocks.filter((b) => !b.translation);

  if (input.frameworkExcluded) {
    return { category: 'excluded', gaps: [], reasons: ['基準単位で対象外と判断しています。'] };
  }
  const { decision } = input;
  if (decision.kind === 'not_applicable' || decision.kind === 'not_material') {
    const label = decision.kind === 'not_applicable' ? '対象外' : '非重要';
    if (!decision.reason || decision.reason.trim() === '') {
      return {
        category: 'undetermined',
        gaps: [],
        reasons: [`${label}の理由が記録されていないため、判断済みとして扱いません。`],
      };
    }
    if (!decision.exclusionApproved) {
      return {
        category: 'undetermined',
        gaps: [],
        reasons: [`${label}の承認待ちです（承認されるまで分母から外しません）。`],
      };
    }
    return { category: 'excluded', gaps: [], reasons: [`${label}（理由・承認者あり）`] };
  }
  if (decision.kind === 'not_assessed') {
    return { category: 'undetermined', gaps: [], reasons: ['適用判断がありません。'] };
  }

  // 適用
  const gaps = gapsOf(input, originals);
  const slowest = slowestHumanCoverage(input.human);
  const notAddressed: string[] = [];
  if (originals.length === 0) notAddressed.push('対応する原稿の節がありません。');
  else if (!originals.some((b) => b.hasVersion))
    notAddressed.push('原稿の節に保存済みの版がありません。');
  else if (originals.every((b) => b.status === 'draft')) {
    if (input.narrativeMissingFields)
      notAddressed.push('下書きの節で、定性情報に未記入の項目があります。');
    if (input.evidence === 'none') notAddressed.push('下書きの節で、当年度の根拠がありません。');
    if (input.metrics === 'missing_value')
      notAddressed.push('下書きの節で、数値に値がありません。');
  }
  if (slowest === 'not_covered') notAddressed.push('人の評価で「未対応」の観点があります。');
  if (notAddressed.length > 0) {
    return { category: 'not_addressed', gaps, reasons: notAddressed };
  }

  const needsCheck: string[] = [];
  if (originals.some((b) => b.status === 'review_requested' || b.status === 'approval_pending')) {
    needsCheck.push('レビュー・承認の途中の節があります。');
  }
  if (originals.some((b) => b.status === 'returned')) needsCheck.push('差し戻された節があります。');
  if (originals.some((b) => b.status === 'draft'))
    needsCheck.push('承認されていない節があります。');
  if (originals.some((b) => b.recheck))
    needsCheck.push('引用先の更新で再確認が必要な節があります。');
  if (input.metrics === 'unapproved') needsCheck.push('未承認の数値を引用しています。');
  if (input.metrics === 'stale') needsCheck.push('引用した数値に新しい版があります。');
  if (input.metrics === 'missing_value') needsCheck.push('対応する数値に値がありません。');
  if (input.evidence === 'prior_only') needsCheck.push('根拠が過年度・参考の資料だけです。');
  if (input.evidence === 'none') needsCheck.push('根拠がありません。');
  if (input.narrativeMissingFields) needsCheck.push('定性情報に未記入の項目があります。');
  if (input.aiOnly) needsCheck.push('評価が AI の候補だけで、人が確認していません。');
  else if (slowest === null || slowest === 'unconfirmed') {
    needsCheck.push('人の評価（開示・データ・業務プロセス）が揃っていません。');
  } else if (slowest === 'partial') needsCheck.push('人の評価で「一部対応」の観点があります。');

  if (needsCheck.length > 0) return { category: 'needs_check', gaps, reasons: needsCheck };
  if (!input.frameworkPublished) {
    return { category: 'needs_check', gaps, reasons: [DRAFT_STANDARD_CAP_NOTE] };
  }
  return { category: 'confirmed', gaps, reasons: ['充足を確認済みです。'] };
}

/** 区分ごとの件数（分母付きで並べる。0 件の区分も持つ） */
export function countByCategory(
  categories: readonly RequirementCoverageCategory[],
): Record<RequirementCoverageCategory, number> {
  const out = Object.fromEntries(REQUIREMENT_COVERAGE_CATEGORIES.map((c) => [c, 0])) as Record<
    RequirementCoverageCategory,
    number
  >;
  for (const category of categories) out[category] += 1;
  return out;
}

// ======================================================================
// 対象外・非重要の申請と承認（NF-02）
// ======================================================================

/** 確認ダイアログ・一覧に出す理由の先頭（200 字まで） */
export function exclusionReasonExcerpt(reason: string): string {
  const trimmed = reason.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 199)}…` : trimmed;
}

export const EXCLUSION_STATES = [
  'not_requested',
  'requested',
  'approved',
  'returned',
  'reapproval_required',
] as const;
/**
 * 対象外の承認の状態。not_requested＝申請なし（取り下げ後を含む）、reapproval_required＝承認後に理由・区分を
 * 変えた（承認し直しが必要）
 */
export type ExclusionState = (typeof EXCLUSION_STATES)[number];

export interface ExclusionEventLike {
  id: Uuid;
  event: ExclusionEventType;
  decision: ExclusionDecision;
  reasonDigest: string;
  actorUserId: Uuid;
  note?: string;
  createdAt: IsoDateTime;
}

export interface ExclusionStateResult {
  state: ExclusionState;
  /** 今の理由で申請した人（申請中・承認済み・差戻し） */
  requestedBy: Uuid | null;
  requestedAt: IsoDateTime | null;
  /** 承認・差戻しをした人と日時 */
  decidedBy: Uuid | null;
  decidedAt: IsoDateTime | null;
  /** 差戻しの理由 */
  returnNote: string | null;
}

function byTime<T extends { createdAt: IsoDateTime; id: Uuid }>(a: T, b: T): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/**
 * 1 つの要求事項（同じ組織・期間・基準）の申請・承認の記録から、今の判断（区分・理由）に対する承認の状態を導く。
 * current が null（今は対象外・非重要でない）なら not_requested。reasonDigest は今の区分・理由のダイジェスト
 * （domain/exclusion-digest.ts の exclusionReasonDigest で作る）
 */
export function exclusionStateOf(
  events: readonly ExclusionEventLike[],
  current: { decision: ExclusionDecision; reasonDigest: string } | null,
): ExclusionStateResult {
  const empty: ExclusionStateResult = {
    state: 'not_requested',
    requestedBy: null,
    requestedAt: null,
    decidedBy: null,
    decidedAt: null,
    returnNote: null,
  };
  if (!current) return empty;
  const digest = current.reasonDigest;
  const sorted = [...events].sort(byTime);
  const own = sorted.filter((e) => e.reasonDigest === digest && e.decision === current.decision);
  const latestRequest = [...own].reverse().find((e) => e.event === 'requested');
  if (!latestRequest) {
    // 今の理由では申請が無い。以前の理由で承認されていたなら「再承認が必要」
    const approvedBefore = sorted.some((e) => e.event === 'approved');
    return { ...empty, state: approvedBefore ? 'reapproval_required' : 'not_requested' };
  }
  // 最後の申請の後の決定（承認・差戻し・取り下げ）
  const after = own.filter((e) => byTime(e, latestRequest) > 0 && e.event !== 'requested');
  const decided = after[after.length - 1];
  const base = {
    requestedBy: latestRequest.actorUserId,
    requestedAt: latestRequest.createdAt,
  };
  if (!decided) return { ...empty, ...base, state: 'requested' };
  if (decided.event === 'withdrawn') return empty;
  return {
    ...base,
    state: decided.event === 'approved' ? 'approved' : 'returned',
    decidedBy: decided.actorUserId,
    decidedAt: decided.createdAt,
    returnNote: decided.event === 'returned' ? (decided.note ?? null) : null,
  };
}

// ======================================================================
// 担当・期限の出所（NF-03）
// ======================================================================

export const OWNER_DUE_SOURCES = ['action_plan', 'block', 'assessment', 'project'] as const;
/** 担当・期限の出所。未完了の対応計画 → 節 → 評価 → プロジェクトの順に採る */
export type OwnerDueSource = (typeof OWNER_DUE_SOURCES)[number];

export const OWNER_DUE_SOURCE_LABELS: Readonly<Record<OwnerDueSource, string>> = {
  action_plan: '対応計画',
  block: '原稿の節',
  assessment: '要求事項の評価',
  project: 'プロジェクト',
};

export interface OwnerDueResult {
  ownerUserId: Uuid | null;
  /** 部署など、利用者でない担当の表示（無ければ null） */
  ownerLabel: string | null;
  dueDate: IsoDate | null;
  source: OwnerDueSource;
}

export function resolveOwnerDue(input: {
  plans: ReadonlyArray<{
    assigneeUserId: Uuid | null;
    department: string;
    dueDate: IsoDate | null;
    done: boolean;
  }>;
  blocks: ReadonlyArray<{ ownerUserId: Uuid | null; dueDate: IsoDate | null }>;
  assessment: { ownerUserId: Uuid | null; ownerDepartment: string; dueDate: IsoDate | null } | null;
  projectDueDate: IsoDate | null;
}): OwnerDueResult {
  const open = input.plans
    .filter((p) => !p.done)
    .sort((a, b) => {
      if (a.dueDate === b.dueDate) return 0;
      if (a.dueDate === null) return 1;
      if (b.dueDate === null) return -1;
      return a.dueDate < b.dueDate ? -1 : 1;
    });
  const plan = open[0];
  if (plan) {
    return {
      ownerUserId: plan.assigneeUserId,
      ownerLabel: plan.assigneeUserId ? null : plan.department.trim() || null,
      dueDate: plan.dueDate,
      source: 'action_plan',
    };
  }
  const block = input.blocks.find((b) => b.ownerUserId !== null || b.dueDate !== null);
  if (block) {
    return {
      ownerUserId: block.ownerUserId,
      ownerLabel: null,
      dueDate: block.dueDate,
      source: 'block',
    };
  }
  const a = input.assessment;
  if (a && (a.ownerUserId !== null || a.ownerDepartment.trim() !== '' || a.dueDate !== null)) {
    return {
      ownerUserId: a.ownerUserId,
      ownerLabel: a.ownerDepartment.trim() || null,
      dueDate: a.dueDate,
      source: 'assessment',
    };
  }
  return { ownerUserId: null, ownerLabel: null, dueDate: input.projectDueDate, source: 'project' };
}
