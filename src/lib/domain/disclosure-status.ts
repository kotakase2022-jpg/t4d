/**
 * 開示優先モードの表示ラベル・状態遷移・職務分離・阻害条件（docs/disclosure-first.md §2〜§5）。
 *
 * DB にも画面にも依存しない純粋関数だけを置く。
 *  - ラベルは画面ごとに訳さず、必ずここから引く（設計書の表記に揃える）。
 *  - 職務分離は DB トリガ（0037 の t4d.enforce_review_event）と同じ規則をアプリ層でも判定する
 *    （片方だけに頼らない。アプリ層は操作前に理由を示すため、DB は最後の砦として）。
 *  - 阻害条件の判定は入力を素のデータで受け取り、Service がどの DbClient からでも呼べるようにする。
 */

import { hasBodyContent } from '@/lib/domain/disclosure-block';
import type {
  AnchorAcquiredBy,
  AnchorKind,
  ApplicabilityStatus,
  AvailabilityStatus,
  BlockBody,
  BlockStatus,
  BlockVersionOrigin,
  DisclosureLanguage,
  DisclosureProjectStatus,
  DisclosurePurpose,
  EvidenceUsagePurpose,
  ExportArtifactFormat,
  ExportAudience,
  FrameworkCoverageStatus,
  FrameworkLegalStatus,
  KpiDirection,
  KpiTargetType,
  MaterialityBasis,
  NarrativeStatus,
  NarrativeTheme,
  QuantitativeImportDiffKind,
  QuantitativeImportStatus,
  RecheckDecisionKind,
  RecheckRefKind,
  ReportSnapshotKind,
  ReviewComment,
  ReviewCommentSeverity,
  ReviewEventType,
  ReviewPolicy,
  ReviewRequest,
  ReviewRequestStatus,
  ReviewStage,
  Uuid,
  ValueKind,
} from '@/types/domain';

// ======================================================================
// 表示ラベル
// ======================================================================

export const DISCLOSURE_PURPOSE_LABELS: Record<DisclosurePurpose, string> = {
  ssbj_statutory: 'SSBJ（法定）',
  ssbj_voluntary: 'SSBJ（任意）',
  csrd_40a_prep: 'CSRD 域外（40a）準備',
  csrd_eu_entity: 'CSRD（EU 法人）',
  internal_esg: '社内 ESG 管理',
};

export const APPLICABILITY_STATUS_LABELS: Record<ApplicabilityStatus, string> = {
  not_assessed: '未判定',
  candidate: '適用候補',
  applicable: '適用と判断',
  not_applicable: '対象外と判断',
  voluntary: '任意適用',
  awaiting_confirmation: '確認待ち',
};

export const DISCLOSURE_PROJECT_STATUS_LABELS: Record<DisclosureProjectStatus, string> = {
  preparing: '準備中',
  active: '進行中',
  closed: '完了',
};

export const DISCLOSURE_LANGUAGE_LABELS: Record<DisclosureLanguage, string> = {
  ja: '日本語',
  en: '英語',
};

export const NARRATIVE_THEME_LABELS: Record<NarrativeTheme, string> = {
  risk_opportunity: 'リスク・機会',
  financial_impact: '財務的影響',
  governance: 'ガバナンス',
  strategy: '戦略・対応策',
  policy_other: '方針・その他',
};

export const NARRATIVE_STATUS_LABELS: Record<NarrativeStatus, string> = {
  draft: '下書き',
  confirmed: '確認済み',
  needs_recheck: '要再確認',
};

export const ANCHOR_KIND_LABELS: Record<AnchorKind, string> = {
  pdf_page: 'PDF のページ',
  heading_paragraph: '見出し・段落',
  sheet_cell: 'シートのセル',
  text_range: 'テキストの範囲',
  manual_excerpt: '手動の抜粋',
};

export const ANCHOR_ACQUIRED_BY_LABELS: Record<AnchorAcquiredBy, string> = {
  manual: '手動で指定',
  extracted: '抽出結果から指定',
};

export const BLOCK_STATUS_LABELS: Record<BlockStatus, string> = {
  draft: '下書き',
  review_requested: 'レビュー依頼中',
  returned: '差戻し',
  approval_pending: '承認待ち',
  approved: '承認済み',
};

export const BLOCK_VERSION_ORIGIN_LABELS: Record<BlockVersionOrigin, string> = {
  human: '人が作成',
  human_adopted_ai: 'AI 候補を人が採用',
};

export const REVIEW_REQUEST_STATUS_LABELS: Record<ReviewRequestStatus, string> = {
  open: 'レビュー待ち',
  returned: '差戻し',
  reviewed: 'レビュー完了（承認待ち）',
  approved: '承認済み',
  withdrawn: '取下げ',
};

export const REVIEW_EVENT_TYPE_LABELS: Record<ReviewEventType, string> = {
  requested: 'レビュー依頼',
  returned: '差戻し',
  review_completed: 'レビュー完了',
  approved: '最終承認',
  withdrawn: '依頼の取下げ',
};

export const REVIEW_STAGE_LABELS: Record<ReviewStage, string> = {
  request: '依頼',
  review: 'レビュー（第 1 段）',
  final: '最終承認',
};

export const REVIEW_COMMENT_SEVERITY_LABELS: Record<ReviewCommentSeverity, string> = {
  info: '参考',
  major: '要対応',
};

export const RECHECK_REF_KIND_LABELS: Record<RecheckRefKind, string> = {
  metric: '数値',
  narrative: '定性情報',
};

export const RECHECK_DECISION_LABELS: Record<RecheckDecisionKind, string> = {
  adopt_new: '新しい版を採用',
  keep_old: '引用中の版を維持',
  return_to_owner: '担当者へ差戻し',
};

/**
 * スナップショット種別の表示。画面・出力ファイルはすべてこれを通す（表記を 1 か所に保つ）。
 * approved は社内の最終承認を経た版であり、保証・提出を意味しない。
 * 「確定版」「保証済み」「提出済み」と書くと第三者保証や提出と取り違えられるため使わない（§6.10）
 */
export const REPORT_SNAPSHOT_KIND_LABELS: Record<ReportSnapshotKind, string> = {
  review_draft: 'レビュー用草稿',
  approved: '社内承認済み版',
};

export const EXPORT_ARTIFACT_FORMAT_LABELS: Record<ExportArtifactFormat, string> = {
  docx: 'Word（DOCX）',
  xlsx: 'Excel（XLSX）',
  csv: 'CSV',
};

export const EXPORT_AUDIENCE_LABELS: Record<ExportAudience, string> = {
  internal: '社内確認用',
  external: '社外提出用',
};

export const KPI_TARGET_TYPE_LABELS: Record<KpiTargetType, string> = {
  absolute: '総量',
  intensity: '原単位',
};

export const KPI_DIRECTION_LABELS: Record<KpiDirection, string> = {
  reduce: '削減',
  increase: '増加',
};

export const VALUE_KIND_LABELS: Record<ValueKind, string> = {
  actual: '実績',
  estimate: '推計',
  target: '目標',
};

export const AVAILABILITY_STATUS_LABELS: Record<AvailabilityStatus, string> = {
  value_present: '値あり',
  not_entered: '未入力',
  not_obtained: '未取得',
  not_applicable: '対象外',
  not_calculated: '未算定',
};

export const EVIDENCE_USAGE_PURPOSE_LABELS: Record<EvidenceUsagePurpose, string> = {
  current_fact: '当年度の根拠',
  prior_year_text: '過年度の記載',
  style_reference: '文体の参考',
};

export const FRAMEWORK_LEGAL_STATUS_LABELS: Record<FrameworkLegalStatus, string> = {
  draft: '草案',
  adopted: '採択済み（未発効）',
  promulgated: '公表済み',
  effective: '発効済み',
  superseded: '改訂により旧版',
  sample: 'サンプル（架空）',
};

/** タスクの対象の種類（tasks.target_type）の表示。知らない値は内部名を出さず「その他」にする */
const TASK_TARGET_TYPE_LABELS: Readonly<Record<string, string>> = {
  data_point: 'データ',
  evidence: '資料・証跡',
  disclosure_response: '開示回答',
  disclosure_block: '開示原稿',
  pbc_request: '資料依頼（PBC）',
  ingestion_job: 'データ取込',
  engagement: '保証案件',
  collection_campaign: '収集キャンペーン',
};

export function taskTargetTypeLabel(targetType: string | null | undefined): string {
  return (targetType && TASK_TARGET_TYPE_LABELS[targetType]) || 'その他';
}

/**
 * 基準の版の位置付けの表示（開示ホーム・プロジェクト・出力の表紙が同じ文言を使う）。
 * 草案は「公開草案に基づく準備」、架空の縮小マスターは「サンプル（架空）」と必ず表示し、
 * 「草案」だけの表示で正式な基準と見誤らせない（指示書 §8.1・§14.3）
 */
export function frameworkLegalLabel(version: {
  legalStatus: FrameworkLegalStatus | null;
  coverageStatus?: FrameworkCoverageStatus | null;
  isFixture?: boolean;
}): string {
  const legal = version.legalStatus;
  if (legal === 'sample' || version.coverageStatus === 'sample' || version.isFixture) {
    return 'サンプル（架空）';
  }
  if (legal === 'draft') return '公開草案に基づく準備';
  if (legal) return FRAMEWORK_LEGAL_STATUS_LABELS[legal];
  return '法的位置付け未登録';
}

export const FRAMEWORK_COVERAGE_STATUS_LABELS: Record<FrameworkCoverageStatus, string> = {
  full_for_scope: '対象範囲を全件収録',
  partial: '一部のみ収録',
  not_loaded: '要求事項は未収録',
  sample: 'サンプル（架空）',
};

export const MATERIALITY_BASIS_LABELS: Record<MaterialityBasis, string> = {
  financial: '財務的重要性',
  impact: 'インパクト重要性',
  double: 'ダブル・マテリアリティ',
  not_specified: '指定なし',
};

export const QUANTITATIVE_IMPORT_STATUS_LABELS: Record<QuantitativeImportStatus, string> = {
  validated: '検証済み（未確定）',
  committed: '確定済み',
  rejected: '却下',
};

export const QUANTITATIVE_IMPORT_DIFF_KIND_LABELS: Record<QuantitativeImportDiffKind, string> = {
  new: '新規',
  changed: '変更',
  unchanged: '変更なし',
  error: 'エラー',
};

// ======================================================================
// 値の有無（0039）
// ======================================================================

/**
 * 値から「値あり／未入力」を決める。0039 の backfill と同じ規則
 * （value と text_value がともに null なら未入力）にして、Demo と Supabase で食い違わせない。
 * 未取得・対象外・未算定は値から推測できないため、ここでは決めない。
 */
export function availabilityFromValue(
  value: number | null | undefined,
  textValue: string | null | undefined,
): AvailabilityStatus {
  const hasValue = value !== null && value !== undefined && !Number.isNaN(value);
  const hasText = textValue !== null && textValue !== undefined;
  return hasValue || hasText ? 'value_present' : 'not_entered';
}

/**
 * 値を更新したあとの有無の状態。
 *  - 値が入った → 値あり（理由は消す）
 *  - 値を消した → 未入力
 *  - 値が無いまま → 人が付けた状態（対象外など）と理由を保つ
 */
export function availabilityAfterValueChange(
  current: { availabilityStatus: AvailabilityStatus; absenceReason: string | null },
  value: number | null | undefined,
  textValue: string | null | undefined,
): { availabilityStatus: AvailabilityStatus; absenceReason: string | null } {
  if (availabilityFromValue(value, textValue) === 'value_present') {
    return { availabilityStatus: 'value_present', absenceReason: null };
  }
  if (current.availabilityStatus === 'value_present') {
    return { availabilityStatus: 'not_entered', absenceReason: null };
  }
  return { availabilityStatus: current.availabilityStatus, absenceReason: current.absenceReason };
}

/** 集計・比較に値を使ってよいか（value_present 以外を 0 として足さない） */
export function isValuePresent(status: AvailabilityStatus): boolean {
  return status === 'value_present';
}

// ======================================================================
// 節の状態遷移（§5）
// ======================================================================

export const BLOCK_ACTIONS = [
  'autosave',
  'save_version',
  'request_review',
  'return',
  'complete_review',
  'approve',
  'withdraw',
  'revise_after_approval',
] as const;
export type BlockAction = (typeof BLOCK_ACTIONS)[number];

export interface BlockTransitionRule {
  label: string;
  /** この操作ができる状態 */
  from: readonly BlockStatus[];
  /** 操作後の状態。null は状態を変えない（版やポインタだけが変わる） */
  to: BlockStatus | null;
}

/**
 * 節の状態遷移表（§5 の表をそのままデータにしたもの）。
 * 権限・職務分離・阻害条件はここでは見ない（canCompleteReview / canFinalApprove /
 * evaluateBlockBlockers と組み合わせて Service が判定する）。
 */
export const BLOCK_TRANSITIONS: Readonly<Record<BlockAction, BlockTransitionRule>> = {
  // 作業本文（working_body）だけを更新する。業務上の版は作らない
  autosave: { label: '自動保存', from: ['draft', 'returned'], to: null },
  save_version: { label: '版として保存', from: ['draft', 'returned'], to: null },
  request_review: { label: 'レビュー依頼', from: ['draft', 'returned'], to: 'review_requested' },
  // 第 1 段レビュアー（依頼中）と最終承認者（承認待ち）のどちらも差し戻せる
  return: { label: '差戻し', from: ['review_requested', 'approval_pending'], to: 'returned' },
  complete_review: { label: 'レビュー完了', from: ['review_requested'], to: 'approval_pending' },
  approve: { label: '最終承認', from: ['approval_pending'], to: 'approved' },
  // 依頼者が取り下げると下書きへ戻る（§5 の表には無いが review_events の withdrawn に対応）
  withdraw: {
    label: 'レビュー依頼の取下げ',
    from: ['review_requested', 'approval_pending'],
    to: 'draft',
  },
  // 承認済みの版は残したまま新しい版を作り、下書きへ戻す
  revise_after_approval: { label: '承認後に修正', from: ['approved'], to: 'draft' },
};

export type BlockTransitionResult = { ok: true; to: BlockStatus } | { ok: false; reason: string };

/** 状態遷移表に照らして、操作後の状態を返す（できない操作は理由付きで拒否） */
export function transitionBlock(action: BlockAction, from: BlockStatus): BlockTransitionResult {
  const rule = BLOCK_TRANSITIONS[action];
  if (!rule.from.includes(from)) {
    return {
      ok: false,
      reason: `「${BLOCK_STATUS_LABELS[from]}」の節では「${rule.label}」はできません。`,
    };
  }
  return { ok: true, to: rule.to ?? from };
}

// ======================================================================
// 職務分離（§2・§5。DB 側は 0037 の t4d.enforce_review_event）
// ======================================================================

export const DEFAULT_REVIEW_POLICY_VERSION = 'sod-3role-v1';

/** 規則の版の表示（画面に内部の識別子をそのまま出さない。§4.2） */
const REVIEW_POLICY_LABELS: Readonly<Record<string, string>> = {
  'sod-3role-v1': '作成・レビュー・最終承認の 3 段階（職務分離・第 1 版）',
};

export function reviewPolicyLabel(policyVersion: string): string {
  return REVIEW_POLICY_LABELS[policyVersion] ?? '規則の版（登録外）';
}

/** KPI 目標の表示名（内部の識別子 target_key や列挙値を画面に出さない。§4.2） */
export function kpiTargetLabel(input: {
  metricName: string | null;
  targetYear: number;
  direction: KpiDirection;
}): string {
  return `${input.metricName ?? '指標'} ${input.targetYear}年 ${KPI_DIRECTION_LABELS[input.direction]}目標`;
}

/** 依頼時点で review_requests.policy へ写す既定の規則（依頼者・レビュー・最終承認の 3 役割） */
export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  version: DEFAULT_REVIEW_POLICY_VERSION,
  stages: ['review', 'final'],
  forbidRequesterOrAuthorReview: true,
  forbidRequesterAuthorOrReviewerApproval: true,
  requireReturnReasonAndParagraph: true,
};

export type SodViolation =
  | 'request_not_open'
  | 'request_not_reviewed'
  | 'review_missing'
  | 'requester'
  | 'author'
  | 'contributor'
  | 'reviewer';

export type SodCheck = { ok: true } | { ok: false; code: SodViolation; reason: string };

export interface CompleteReviewInput {
  actorId: Uuid;
  request: Pick<ReviewRequest, 'requestedBy' | 'status'>;
  /** 依頼で固定した版（target_version_id）の作成者 */
  targetVersionCreatedBy: Uuid;
  /**
   * 作成者以外でその版の本文（自動保存）を書いた人（DisclosureBlockVersion.contributorUserIds）。
   * 別の人が依頼すると版の作成者は依頼者になるため、作成者だけを見ると本文を書いた人が
   * 自分の文章をレビュー・承認できてしまう
   */
  targetVersionContributors?: readonly Uuid[] | null;
}

function wroteTargetVersion(input: {
  actorId: Uuid;
  targetVersionContributors?: readonly Uuid[] | null;
}): boolean {
  return (input.targetVersionContributors ?? []).includes(input.actorId);
}

/** 第 1 段のレビュー完了ができるか（依頼者・対象版の作成者・本文を書いた人ではないこと） */
export function canCompleteReview(input: CompleteReviewInput): SodCheck {
  if (input.request.status !== 'open') {
    return {
      ok: false,
      code: 'request_not_open',
      reason: 'レビュー待ちの依頼ではないため、レビューを完了できません。',
    };
  }
  if (input.actorId === input.request.requestedBy) {
    return {
      ok: false,
      code: 'requester',
      reason: 'レビューを依頼した本人はレビューを完了できません（職務分離）。',
    };
  }
  if (input.actorId === input.targetVersionCreatedBy) {
    return {
      ok: false,
      code: 'author',
      reason: 'この版を作成した本人はレビューを完了できません（職務分離）。',
    };
  }
  if (wroteTargetVersion(input)) {
    return {
      ok: false,
      code: 'contributor',
      reason: 'この版の本文を書いた本人（自動保存を含む）はレビューを完了できません（職務分離）。',
    };
  }
  return { ok: true };
}

export interface FinalApproveInput {
  actorId: Uuid;
  request: Pick<ReviewRequest, 'requestedBy' | 'status'>;
  targetVersionCreatedBy: Uuid;
  /** 作成者以外でその版の本文（自動保存）を書いた人 */
  targetVersionContributors?: readonly Uuid[] | null;
  /**
   * 同じ依頼・同じ版でレビュー（第 1 段）を完了した人（review_completed の actor）。
   * 空なら第 1 段を経ていないため最終承認できない（状態だけ「レビュー完了」に書き換えられても通さない）
   */
  reviewCompletedBy: Uuid | null | readonly Uuid[];
}

/**
 * 最終承認ができるか。
 * 依頼者・対象版の作成者・本文を書いた人・同じ依頼のレビュー完了者ではなく、
 * かつ別の人によるレビュー（第 1 段）の完了記録があること（DB の t4d.enforce_review_event と同じ規則）
 */
export function canFinalApprove(input: FinalApproveInput): SodCheck {
  if (input.request.status !== 'reviewed') {
    return {
      ok: false,
      code: 'request_not_reviewed',
      reason: 'レビューが完了していないため、最終承認できません。',
    };
  }
  const completedBy =
    input.reviewCompletedBy === null
      ? []
      : typeof input.reviewCompletedBy === 'string'
        ? [input.reviewCompletedBy]
        : input.reviewCompletedBy;
  if (completedBy.length === 0) {
    return {
      ok: false,
      code: 'review_missing',
      reason: 'レビュー（第 1 段）の完了記録が無いため、最終承認できません。',
    };
  }
  if (input.actorId === input.request.requestedBy) {
    return {
      ok: false,
      code: 'requester',
      reason: 'レビューを依頼した本人は最終承認できません（職務分離）。',
    };
  }
  if (input.actorId === input.targetVersionCreatedBy) {
    return {
      ok: false,
      code: 'author',
      reason: 'この版を作成した本人は最終承認できません（職務分離）。',
    };
  }
  if (wroteTargetVersion(input)) {
    return {
      ok: false,
      code: 'contributor',
      reason: 'この版の本文を書いた本人（自動保存を含む）は最終承認できません（職務分離）。',
    };
  }
  if (completedBy.includes(input.actorId)) {
    return {
      ok: false,
      code: 'reviewer',
      reason: '同じ依頼のレビューを完了した本人は最終承認できません（職務分離）。',
    };
  }
  return { ok: true };
}

/** 差戻しの入力検査（理由と対象段落が必須。本文を渡せば段落の実在も確かめる） */
export function validateReturn(input: {
  reason: string | null | undefined;
  paragraphId: string | null | undefined;
  body?: BlockBody | null;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.reason?.trim() || !input.paragraphId?.trim()) {
    return { ok: false, reason: '差戻しには理由と対象の段落が必要です。' };
  }
  if (input.body && !input.body.paragraphs.some((p) => p.id === input.paragraphId)) {
    return { ok: false, reason: '差戻しの対象の段落が、依頼された版に見つかりません。' };
  }
  return { ok: true };
}

/**
 * 依頼が固定した適用判断（review_requests.decision_ids）の後に、節の基準の判断が更新されたか。
 * 依頼は判断の版を固定する（§10.1）ため、最終承認とレポートの確定で確かめ直す（§10.3）。
 * 判断は追記専用で、基準の現在の判断（project_frameworks.current_decision_id）が依頼の固定した判断に
 * 含まれていなければ、依頼の後に確定し直したことになる。
 */
export function applicabilityDecisionChangedSince(
  request: { decisionIds: readonly Uuid[] },
  currentDecisionId: Uuid | null,
): boolean {
  return currentDecisionId !== null && !request.decisionIds.includes(currentDecisionId);
}

/** review_events.idempotency_key（依頼 ID＋段階＋対象版）。二重押下で同じ判断を 2 回記録しない */
export function reviewEventIdempotencyKey(
  reviewRequestId: Uuid,
  stage: ReviewStage,
  targetVersionId: Uuid,
): string {
  return `${reviewRequestId}:${stage}:${targetVersionId}`;
}

// ======================================================================
// 阻害条件（§5「レビュー依頼」「レビュー完了」「最終承認」の事前条件）
// ======================================================================

export const BLOCK_BLOCKER_CODES = [
  'no_body',
  'unadopted_ai_candidate',
  'unresolved_major_comments',
  'stale_metric_refs',
  'applicability_not_assessed',
  /** 依頼・承認の後に報告範囲（報告主体・期間・対象範囲）が変わった */
  'scope_changed',
  /** 依頼・承認の後に、節の基準の適用判断が更新された */
  'applicability_changed',
] as const;
export type BlockBlockerCode = (typeof BLOCK_BLOCKER_CODES)[number];

export interface BlockBlocker {
  code: BlockBlockerCode;
  message: string;
}

/** 阻害条件の判定に使う素のデータ。Service が DbClient から集めて渡す */
export interface BlockBlockerInput {
  /** 判定対象の本文（提出する版、またはレビュー中の版）。版が無ければ null */
  body: BlockBody | null;
  /** 採用も破棄もされていない AI 候補（段落）の数 */
  pendingAiCandidateCount: number;
  /** 対象の節のコメント（解決済みを含めて渡してよい） */
  comments: ReadonlyArray<Pick<ReviewComment, 'severity' | 'resolvedAt'>>;
  /** 本文が引用している数値と、その Data Point の現在の版 */
  metricRefs: ReadonlyArray<{
    dataPointId: Uuid;
    /** 本文が引用している版 */
    dataPointVersionId: Uuid;
    /** Data Point の現在の版（data_points.current_version_id） */
    currentVersionId: Uuid | null;
    /** 画面に出す名前（例: Scope1 排出量）。無ければ件数だけを示す */
    label?: string;
  }>;
  /** プロジェクトが扱う基準の適用区分 */
  frameworks: ReadonlyArray<{
    frameworkVersionId: Uuid;
    label: string;
    applicabilityStatus: ApplicabilityStatus;
  }>;
}

/**
 * 阻害条件を列挙する。空配列なら阻害なし。
 * どの操作で使うか（依頼・完了・承認・確定）は呼び出し側が決める。ここは条件の有無だけを返す。
 */
export function evaluateBlockBlockers(input: BlockBlockerInput): BlockBlocker[] {
  const blockers: BlockBlocker[] = [];

  if (!hasBodyContent(input.body)) {
    blockers.push({ code: 'no_body', message: '本文がありません。' });
  }

  if (input.pendingAiCandidateCount > 0) {
    blockers.push({
      code: 'unadopted_ai_candidate',
      message: `未採用の AI 候補が ${input.pendingAiCandidateCount} 件あります。採用するか破棄してください。`,
    });
  }

  const unresolvedMajor = input.comments.filter(
    (c) => c.severity === 'major' && c.resolvedAt === null,
  ).length;
  if (unresolvedMajor > 0) {
    blockers.push({
      code: 'unresolved_major_comments',
      message: `未解決の要対応コメントが ${unresolvedMajor} 件あります。`,
    });
  }

  const stale = input.metricRefs.filter(
    (ref) => ref.currentVersionId !== null && ref.currentVersionId !== ref.dataPointVersionId,
  );
  if (stale.length > 0) {
    const labels = stale.map((ref) => ref.label).filter((l): l is string => Boolean(l));
    blockers.push({
      code: 'stale_metric_refs',
      message:
        labels.length > 0
          ? `引用した数値に新しい版があります（${labels.join('、')}）。再確認してください。`
          : `引用した数値に新しい版があります（${stale.length} 件）。再確認してください。`,
    });
  }

  const notAssessed = input.frameworks.filter((f) => f.applicabilityStatus === 'not_assessed');
  if (notAssessed.length > 0) {
    blockers.push({
      code: 'applicability_not_assessed',
      message: `適用判断が未判定の基準があります（${notAssessed.map((f) => f.label).join('、')}）。`,
    });
  }

  return blockers;
}

// ----------------------------------------------------------------------
// 開示ホームのカードと原稿一覧の絞り込み（指示書 §6.1「クリックすると根拠となる項目一覧へ移動」）
//
// カードの件数と、クリックした先の一覧の件数が食い違わないよう、判定をここ 1 か所に置く。
// ホーム（disclosure-home.ts）と原稿一覧（disclosure-block.ts の listProjectBlocks）が同じ関数を通す。
// ----------------------------------------------------------------------

/**
 * 「未解決の必須情報」がある節か。承認済みの節は数えない。
 *  - 保存済みの版を読めない（デモの別インスタンスなど）
 *  - 引用した定性情報に未記入の項目がある
 *  - 阻害条件（本文なし・未解決の要対応コメント・適用判断が未判定）がある
 * 引用の鮮度は「承認後に変更が発生」側で数える。未採用の AI 候補は原稿画面の阻害条件として扱い、
 * ここでは数えない（ホームは AI 候補を数えないため。数えるとカードと一覧が食い違う）。
 */
export function hasUnresolvedRequiredInfo(input: {
  status: BlockStatus;
  versionMissing: boolean;
  narrativeGapCount: number;
  blockers: readonly BlockBlocker[];
}): boolean {
  if (input.status === 'approved') return false;
  return (
    input.versionMissing ||
    input.narrativeGapCount > 0 ||
    input.blockers.some(
      (b) => b.code !== 'stale_metric_refs' && b.code !== 'unadopted_ai_candidate',
    )
  );
}

/**
 * 「承認後に変更が発生」した節か。一度承認された節で、
 *  - 承認済みの版が引用した数値・定性情報に新しい版がある（維持と判断済みの組み合わせを除く）
 *  - または、承認後に修正を始めた（現在の版が承認済みの版と違う）
 * 承認済みの版そのものは変えない（A25）。
 */
export function isChangedAfterApproval(input: {
  approvedVersionId: string | null;
  currentVersionId: string | null;
  approvedVersionHasStaleRefs: boolean;
}): boolean {
  if (input.approvedVersionId === null) return false;
  return input.approvedVersionHasStaleRefs || input.currentVersionId !== input.approvedVersionId;
}
