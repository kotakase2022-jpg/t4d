import { FICTIONAL_MEMBER_EMAIL_SUFFIX } from '@/lib/fixtures/trial-ids';
import type { FixtureDb } from '@/lib/fixtures/store';
import {
  AI_PROVIDER_STORAGES,
  AI_TRAINING_USES,
  APPROVAL_ROUTE_PURPOSES,
  COST_CLASSES,
  ENTERPRISE_ROLES,
  EXCLUSION_DECISIONS,
  EXCLUSION_EVENT_TYPES,
  EXCLUSION_SOURCES,
  EXPORT_AUDIENCES,
  EXPORT_RECONCILIATION_SOURCES,
  FEEDBACK_CHANNELS,
  FEEDBACK_KINDS,
  FEEDBACK_SEVERITIES,
  FEEDBACK_STATUSES,
  NDA_STATUSES,
  RECONCILED_FORMATS,
  REPORT_NOTE_TARGET_TYPES,
  REQUIREMENT_APPLICABILITIES,
  RESPONSE_CONTENT_LINK_SOURCES,
  RESPONSE_CONTENT_TARGET_KINDS,
  REVIEW_NOTE_STATUSES,
  SSBJ_COVERAGE_STATUSES,
  TRIAL_COMPLETIONS,
  TRIAL_DECISIONS,
  TRIAL_END_DISPOSITIONS,
  TRIAL_JUDGEMENTS,
  TRIAL_PHASES,
  TRIAL_TASK_KEYS,
  TRIAL_TIMING_METHODS,
  TRIAL_TIMING_MODES,
  XBRL_MAPPING_EVENT_TYPES,
  XBRL_MAPPING_ORIGINS,
  XBRL_MAPPING_STATUSES,
  XBRL_PERIOD_ROLES,
  XBRL_TARGET_KINDS,
  type PermissionKey,
} from '@/types/domain';
import type { TableName } from './types';

/**
 * Cookie から戻すトライアル対応（2026-10。0049〜0057）の行の検査（plan 付録 B）。
 *
 * Fixture DB はインスタンスの全利用者で共有される。偽の Cookie で、別の組織・別の案件の行、権限の無い人・
 * 別の人の名義の行、職務分離を通らない承認、大きすぎる本文を全員の画面に出させない。DB の RLS（書込権限・
 * 組織）・CHECK・複合外部キー・ガードトリガと同じ規則を通す（demo-csrd-checks.ts と同じ方針）。
 * 既にある行の主キー・組織・親は書き換えさせない。追記専用の表（TRIAL_APPEND_ONLY_TABLES）は既にある行を
 * 書き換えない（demo-edit-codec.ts の APPEND_ONLY_TABLES に足す）。
 *
 * 本文の上限は Demo Mode の Cookie の容量に合わせる（Supabase Mode は DB の上限）。
 */

/** Demo Mode の本文の上限（サービスの入力検査もこの値を使う） */
export const DEMO_TEXT_LIMITS = {
  /** 要求事項の判断の理由・メモ、保証側のコメント・回答 */
  note: 400,
  /** トライアルの記録の本文・コメント、AI の候補の不採用の理由 */
  trialText: 300,
  /** フィードバックの件名 */
  trialTitle: 60,
} as const;

/**
 * 持ち回すトライアル対応の表（PERSISTED_TABLES に入れる）。開示デモのリセット（DISCLOSURE_DEMO_RESET_TABLES・
 * DISCLOSURE_CLIENT_RESET_TABLES）は、監査法人の行（reviewNotes）を除くすべてを組織の範囲で戻す
 */
export const TRIAL_PERSISTED_TABLES = [
  'projectRequirementAssessments',
  'projectRequirementAssessmentEvents',
  'requirementExclusionEvents',
  'narrativeRequirementLinks',
  'sharedReportCopies',
  'reviewNotes',
  'reviewNoteResponses',
  'exportReconciliations',
  'trialPrograms',
  'trialScenarioRuns',
  'trialScenarioJudgements',
  'trialFeedbackItems',
  'trialTaskTimings',
  'aiFeedback',
  'approvalRoutes',
  'approvalRouteStages',
  'organizationDataTerms',
  'memberships',
  'xbrlTagMappings',
  'xbrlTagMappingEvents',
  'responseContentLinks',
  'responseEvidenceLinks',
] as const satisfies readonly TableName[];

/** 追記専用（DB では forbid_mutation）。既にある行は Cookie から書き換えない */
export const TRIAL_APPEND_ONLY_TABLES = [
  'projectRequirementAssessmentEvents',
  'requirementExclusionEvents',
  'reviewNoteResponses',
  'exportReconciliations',
  'trialScenarioRuns',
  'trialScenarioJudgements',
  'trialTaskTimings',
  'aiFeedback',
  'organizationDataTerms',
  'xbrlTagMappingEvents',
  'responseEvidenceLinks',
] as const satisfies readonly TableName[];

/**
 * 戻す順番（demo-edit-codec.ts の DEFERRED_ORDER に足す。小さいほど先）。親の行が先に要るもの:
 *  - 判断 → 判断の履歴・対象外の申請（申請は今の理由のダイジェストと照らす）
 *  - スナップショット（6）→ 共有した写し → 保証側のコメント → 回答。スナップショット → 突合
 *  - 道筋 → 段階、対応付け → 履歴、AI の実行（先に戻る）→ 評価
 */
export const TRIAL_DEFERRED_ORDER: Readonly<Record<string, number>> = {
  projectRequirementAssessments: 5,
  narrativeRequirementLinks: 5,
  approvalRoutes: 5,
  xbrlTagMappings: 5,
  responseContentLinks: 5,
  responseEvidenceLinks: 5,
  trialPrograms: 5,
  trialFeedbackItems: 5,
  organizationDataTerms: 5,
  memberships: 5,
  aiFeedback: 5,
  projectRequirementAssessmentEvents: 6,
  requirementExclusionEvents: 6,
  approvalRouteStages: 6,
  xbrlTagMappingEvents: 6,
  trialScenarioRuns: 6,
  trialScenarioJudgements: 6,
  sharedReportCopies: 7,
  exportReconciliations: 7,
  trialTaskTimings: 7,
  reviewNotes: 8,
  reviewNoteResponses: 9,
};

/** 組織の利用者がその権限を持つか（demo-edit-codec.ts の memberPermissions を使う） */
export type PermissionCheck = (
  organizationId: unknown,
  userId: unknown,
  permission: PermissionKey,
) => boolean;

type Row = Record<string, unknown>;

const isString = (value: unknown): value is string => typeof value === 'string';
const isNonEmpty = (value: unknown): value is string => isString(value) && value.trim() !== '';
const isOptionalString = (value: unknown): boolean => value === null || isString(value);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');
const oneOf = (values: readonly string[], value: unknown): boolean =>
  isString(value) && values.includes(value);
const optionalOneOf = (values: readonly string[], value: unknown): boolean =>
  value === null || oneOf(values, value);
const isTimestamp = (value: unknown): boolean =>
  isString(value) && Number.isFinite(Date.parse(value));
const optionalTimestamp = (value: unknown): boolean => value === null || isTimestamp(value);
const isDate = (value: unknown): boolean => isString(value) && /^\d{4}-\d{2}-\d{2}$/.test(value);
const optionalDate = (value: unknown): boolean => value === null || isDate(value);
const isPlainObject = (value: unknown): value is Row =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const within = (value: unknown, max: number): boolean => isString(value) && value.length <= max;
const nonNegative = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const optionalNonNegativeInt = (value: unknown): boolean =>
  value === null || (Number.isInteger(value) && (value as number) >= 0);
/** JSON の列の大きさの上限（偽の Cookie で巨大な before / after を持たせない） */
const smallJson = (value: unknown, max = 2000): boolean =>
  JSON.stringify(value ?? null).length <= max;

/** 既にある行の主キー・組織・親が変わっていないか */
function keysUnchanged(existing: Row | undefined, next: Row, keys: readonly string[]): boolean {
  if (!existing) return true;
  return ['id', ...keys].every(
    (key) => JSON.stringify(existing[key]) === JSON.stringify(next[key]),
  );
}

/** 既にある行で変わってよい列以外が変わっていないか */
function onlyChanged(existing: Row, next: Row, allowed: readonly string[]): boolean {
  const keys = new Set([...Object.keys(existing), ...Object.keys(next)]);
  for (const key of keys) {
    if (allowed.includes(key)) continue;
    if (JSON.stringify(existing[key] ?? null) !== JSON.stringify(next[key] ?? null)) return false;
  }
  return true;
}

function activeMember(db: FixtureDb, organizationId: unknown, userId: unknown): boolean {
  return db.memberships.some(
    (m) => m.organizationId === organizationId && m.userId === userId && m.status === 'active',
  );
}

/** 行を書いた人（更新者、無ければ作成者） */
function writerOf(next: Row): unknown {
  return next.updatedBy ?? next.createdBy;
}

/**
 * 名義の列（決定者・確認者など）は、入れた・変えた書込の書き手本人だけ（t4d.csrd_actor_must_be_self と同じ）。
 * 既にある行で名義が変わらなければ見ない（後の書込が別の人でもよい）
 */
function actorIsSelf(existing: Row | undefined, next: Row, column: string): boolean {
  const actor = next[column];
  if (actor === null || actor === undefined) return true;
  if (existing && existing[column] === actor) return true;
  return actor === writerOf(next);
}

function itemInVersion(db: FixtureDb, itemId: unknown, frameworkVersionId: unknown): boolean {
  return db.disclosureItems.some(
    (i) => i.id === itemId && i.frameworkVersionId === frameworkVersionId,
  );
}

function aiRunOfOrg(db: FixtureDb, organizationId: unknown, aiRunId: unknown): boolean {
  if (aiRunId === null) return true;
  const run = db.aiRuns.find((r) => r.id === aiRunId);
  return !!run && run.organizationId === organizationId;
}

// ----------------------------------------------------------------------
// 要求事項の判断・対象外の申請・定性情報の対応付け（0049）
// ----------------------------------------------------------------------

function acceptProjectAssessment(
  db: FixtureDb,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  if (!keysUnchanged(existing, next, ['organizationId', 'projectFrameworkId', 'itemId'])) {
    return false;
  }
  const pf = db.projectFrameworks.find((f) => f.id === next.projectFrameworkId);
  if (!pf || pf.organizationId !== next.organizationId) return false;
  if (!itemInVersion(db, next.itemId, pf.frameworkVersionId)) return false;
  if (!can(next.organizationId, writerOf(next), 'enterprise.disclosure.write')) return false;
  if (!oneOf(REQUIREMENT_APPLICABILITIES, next.applicability)) return false;
  for (const key of ['applicabilityReason', 'ruleRef', 'missingInformation', 'actionNote']) {
    if (!within(next[key], DEMO_TEXT_LIMITS.note)) return false;
  }
  if (
    (next.applicability === 'not_applicable' || next.applicability === 'not_material') &&
    !isNonEmpty(next.applicabilityReason)
  ) {
    return false;
  }
  for (const key of ['disclosureCoverage', 'dataCoverage', 'processCoverage']) {
    if (!optionalOneOf(SSBJ_COVERAGE_STATUSES, next[key])) return false;
  }
  if (next.ownerUserId !== null && !activeMember(db, next.organizationId, next.ownerUserId)) {
    return false;
  }
  if (!optionalDate(next.dueOn)) return false;
  if ((next.decidedAt === null) !== (next.decidedBy === null)) return false;
  if ((next.reviewedAt === null) !== (next.reviewedBy === null)) return false;
  if (!optionalTimestamp(next.decidedAt) || !optionalTimestamp(next.reviewedAt)) return false;
  if (!actorIsSelf(existing, next, 'decidedBy') || !actorIsSelf(existing, next, 'reviewedBy')) {
    return false;
  }
  return !db.projectRequirementAssessments.some(
    (a) =>
      a.id !== next.id &&
      a.projectFrameworkId === next.projectFrameworkId &&
      a.itemId === next.itemId,
  );
}

function acceptAssessmentEvent(
  db: FixtureDb,
  _existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  const assessment = db.projectRequirementAssessments.find((a) => a.id === next.assessmentId);
  if (
    !assessment ||
    assessment.organizationId !== next.organizationId ||
    assessment.projectFrameworkId !== next.projectFrameworkId ||
    assessment.itemId !== next.itemId
  ) {
    return false;
  }
  if (!can(next.organizationId, next.actorUserId, 'enterprise.disclosure.write')) return false;
  if (!within(next.reason, DEMO_TEXT_LIMITS.note) || !isTimestamp(next.createdAt)) return false;
  if (next.before !== null && !isPlainObject(next.before)) return false;
  if (!isPlainObject(next.after)) return false;
  return smallJson(next.before) && smallJson(next.after);
}

/**
 * 判断の行があるか（無ければ null）と、理由を記録した人（プロジェクトの判断は決定者、SSBJ の評価は
 * 最後に更新した人。サービスの resolveExclusionTarget と同じ）
 */
function currentExclusionOf(db: FixtureDb, next: Row): { recorder: unknown } | null {
  if (next.source === 'ssbj_assessment') {
    const a = db.ssbjAssessments.find(
      (x) =>
        x.organizationId === next.organizationId &&
        x.reportingPeriodId === next.reportingPeriodId &&
        x.itemId === next.itemId,
    );
    if (!a) return null;
    return { recorder: a.reasonRecordedBy ?? a.updatedBy ?? a.createdBy ?? null };
  }
  const pf = db.projectFrameworks.find((f) => f.id === next.projectFrameworkId);
  if (
    !pf ||
    pf.organizationId !== next.organizationId ||
    pf.frameworkVersionId !== next.frameworkVersionId
  ) {
    return null;
  }
  const a = db.projectRequirementAssessments.find(
    (x) =>
      x.organizationId === next.organizationId &&
      x.projectFrameworkId === next.projectFrameworkId &&
      x.itemId === next.itemId,
  );
  if (!a) return null;
  return { recorder: a.decidedBy };
}

/**
 * 対象外・非重要の申請・承認（0049 の t4d.requirement_exclusion_event_guard と同じ規則）。
 *
 * DB は記録した時点の判断（区分・理由）とダイジェストの一致を確かめる。Cookie から戻すときは「その時点」の
 * 判断が分からない（後で理由を変えると、正しく記録された申請・承認まで捨ててしまう）ため、ダイジェストは形だけを
 * 見る。承認が効くのは今の理由のダイジェストと一致するときだけ（exclusionStateOf）なので、古い・偽の
 * ダイジェストの承認は分母から外れない。判断の行の存在・職務分離・権限は DB と同じに確かめる
 */
function acceptExclusionEvent(
  db: FixtureDb,
  _existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  if (!oneOf(EXCLUSION_SOURCES, next.source) || !oneOf(EXCLUSION_EVENT_TYPES, next.event)) {
    return false;
  }
  if (!oneOf(EXCLUSION_DECISIONS, next.decision)) return false;
  if (!isString(next.reasonDigest) || !/^[0-9a-f]{64}$/.test(next.reasonDigest)) return false;
  if (!within(next.reasonExcerpt, 200) || !within(next.note, DEMO_TEXT_LIMITS.note)) return false;
  if (next.event === 'returned' && !isNonEmpty(next.note)) return false;
  if ((next.source === 'project_assessment') !== (next.projectFrameworkId !== null)) return false;
  if (!isTimestamp(next.createdAt)) return false;
  if (!itemInVersion(db, next.itemId, next.frameworkVersionId)) return false;
  if (
    !db.periods.some(
      (p) => p.id === next.reportingPeriodId && p.organizationId === next.organizationId,
    )
  ) {
    return false;
  }
  const current = currentExclusionOf(db, next);
  if (!current) return false;
  if (next.event === 'requested') {
    return can(next.organizationId, next.actorUserId, 'enterprise.disclosure.write');
  }
  // 同じ内容（区分・ダイジェスト）の記録を新しい順に。最後の記録が申請のときだけ決定（承認・差戻し・取り下げ）を
  // 受け付ける（差し戻した・取り下げた申請を、申請し直さずに承認させない）
  const sameContent = db.requirementExclusionEvents
    .filter(
      (e) =>
        e.organizationId === next.organizationId &&
        e.itemId === next.itemId &&
        e.reportingPeriodId === next.reportingPeriodId &&
        e.projectFrameworkId === next.projectFrameworkId &&
        e.reasonDigest === next.reasonDigest &&
        e.decision === next.decision,
    )
    .sort((a, b) =>
      a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? 1 : -1) : a.id < b.id ? 1 : -1,
    );
  const latest = sameContent[0];
  if (!latest || latest.event !== 'requested') return false;
  if (!isString(next.createdAt) || next.createdAt <= latest.createdAt) return false;
  const requester = latest.actorUserId;
  if (!requester) return false;
  if (next.event === 'withdrawn') {
    return (
      next.actorUserId === requester ||
      can(next.organizationId, next.actorUserId, 'enterprise.disclosure.write')
    );
  }
  // 承認・差戻し: 申請者・理由を記録した人と別の、開示の承認権限を持つ人
  if (next.actorUserId === requester) return false;
  if (next.event === 'approved' && current.recorder && next.actorUserId === current.recorder) {
    return false;
  }
  return can(next.organizationId, next.actorUserId, 'enterprise.disclosure.approve');
}

function acceptNarrativeLink(
  db: FixtureDb,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  if (existing) {
    // 外す（deleted_at）以外に変更しない。外したものは戻さない
    if (existing.deletedAt !== null) return false;
    if (!onlyChanged(existing, next, ['deletedAt', 'deletedBy'])) return false;
    if (!isTimestamp(next.deletedAt) || !isString(next.deletedBy)) return false;
    return can(next.organizationId, next.deletedBy, 'enterprise.disclosure.write');
  }
  const record = db.narrativeRecords.find((r) => r.id === next.narrativeRecordId);
  if (!record || record.organizationId !== next.organizationId) return false;
  if (!itemInVersion(db, next.itemId, next.frameworkVersionId)) return false;
  if (next.deletedAt !== null || next.deletedBy !== null || !isTimestamp(next.createdAt)) {
    return false;
  }
  if (!can(next.organizationId, next.createdBy, 'enterprise.disclosure.write')) return false;
  return !db.narrativeRequirementLinks.some(
    (l) =>
      l.id !== next.id &&
      l.deletedAt === null &&
      l.narrativeRecordId === next.narrativeRecordId &&
      l.itemId === next.itemId,
  );
}

// ----------------------------------------------------------------------
// 保証側への共有・コメント・回答（0050）
// ----------------------------------------------------------------------

function acceptSharedCopy(
  db: FixtureDb,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  const engagement = db.engagements.find((e) => e.id === next.engagementId);
  if (
    !engagement ||
    engagement.clientOrganizationId !== next.clientOrganizationId ||
    engagement.assuranceFirmId !== next.assuranceFirmId
  ) {
    return false;
  }
  if (existing) {
    // 取り下げ（1 回だけ）以外は変えない
    if (existing.withdrawnAt !== null) return false;
    if (!onlyChanged(existing, next, ['withdrawnAt', 'withdrawnBy'])) return false;
    if (!isTimestamp(next.withdrawnAt) || !isString(next.withdrawnBy)) return false;
    return can(next.clientOrganizationId, next.withdrawnBy, 'enterprise.grant.manage');
  }
  if (next.withdrawnAt !== null || next.withdrawnBy !== null) {
    // 取り下げた写しを新しい行として戻すときは、取り下げた人の権限も見る
    if (!isTimestamp(next.withdrawnAt) || !isString(next.withdrawnBy)) return false;
    if (!can(next.clientOrganizationId, next.withdrawnBy, 'enterprise.grant.manage')) return false;
  }
  const snapshot = db.reportSnapshots.find((s) => s.id === next.snapshotId);
  if (
    !snapshot ||
    snapshot.organizationId !== next.clientOrganizationId ||
    snapshot.snapshotKind !== 'approved' ||
    snapshot.contentHash !== next.snapshotContentHash
  ) {
    return false;
  }
  if (!db.grants.some((g) => g.engagementId === engagement.id && g.revokedAt === null)) {
    return false;
  }
  if (!can(next.clientOrganizationId, next.sharedBy, 'enterprise.grant.manage')) return false;
  if (!isTimestamp(next.sharedAt)) return false;
  return !db.sharedReportCopies.some(
    (c) =>
      c.id !== next.id &&
      c.withdrawnAt === null &&
      next.withdrawnAt === null &&
      c.engagementId === next.engagementId &&
      c.snapshotId === next.snapshotId,
  );
}

function engagementMember(db: FixtureDb, engagementId: unknown, userId: unknown): boolean {
  return db.engagementMembers.some(
    (m) => m.engagementId === engagementId && m.userId === userId && m.removedAt === null,
  );
}

function acceptReviewNote(
  db: FixtureDb,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  const engagement = db.engagements.find((e) => e.id === next.engagementId);
  if (!engagement || engagement.assuranceFirmId !== next.assuranceFirmId) return false;
  if (
    !keysUnchanged(existing, next, [
      'engagementId',
      'assuranceFirmId',
      'raisedBy',
      'targetType',
      'targetId',
      'targetCopyId',
      'targetBlockId',
      'targetParagraphId',
      'targetDataPointVersionId',
      'createdAt',
      'createdBy',
    ])
  ) {
    return false;
  }
  // 書き手は案件のメンバーで、法人の review.write を持つ（0013 の can_write_engagement_workpaper と同じ）
  const writer = writerOf(next);
  if (!engagementMember(db, engagement.id, writer)) return false;
  if (!can(engagement.assuranceFirmId, writer, 'assurance.review.write')) return false;
  if (!existing && next.raisedBy !== writer) return false;
  if (!isNonEmpty(next.body) || !within(next.body, DEMO_TEXT_LIMITS.note)) return false;
  if (!oneOf(REVIEW_NOTE_STATUSES, next.status) || typeof next.sharedWithClient !== 'boolean') {
    return false;
  }
  if (!isOptionalString(next.resolutionComment) || !optionalTimestamp(next.resolvedAt))
    return false;
  if (next.resolutionComment !== null && !within(next.resolutionComment, DEMO_TEXT_LIMITS.note)) {
    return false;
  }
  if (next.assignedTo !== null && !engagementMember(db, engagement.id, next.assignedTo)) {
    return false;
  }
  if (!isString(next.targetType)) return false;
  if (oneOf(REPORT_NOTE_TARGET_TYPES, next.targetType)) {
    if (!isString(next.targetCopyId)) return false;
    const copy = db.sharedReportCopies.find((c) => c.id === next.targetCopyId);
    // 企業の開示デモのリセットで写しが消えても、保証側のコメントは監査法人の記録として戻す
    // （写しの本文は無いため、画面は「写しが見つかりません」と出す。書き手・権限は上で確かめた）
    if (!copy) return reportTargetShapeOk(next);
    if (copy.engagementId !== engagement.id) return false;
    // 新しいコメントは取り下げていない写しだけに（取り下げた後の状態の変更は受け付ける）
    if (!existing && copy.withdrawnAt !== null) return false;
    return reportTargetShapeOk(next);
  }
  return (
    next.targetCopyId === null &&
    next.targetBlockId === null &&
    next.targetParagraphId === null &&
    next.targetDataPointVersionId === null
  );
}

/** 開示レポートの段落・数値を指すコメントの対象の形 */
function reportTargetShapeOk(next: Row): boolean {
  if (next.targetType === 'report_paragraph') {
    return isString(next.targetBlockId) && isNonEmpty(next.targetParagraphId);
  }
  return isString(next.targetDataPointVersionId);
}

function acceptNoteResponse(
  db: FixtureDb,
  _existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  const note = db.reviewNotes.find((n) => n.id === next.reviewNoteId);
  const engagement = note ? db.engagements.find((e) => e.id === note.engagementId) : undefined;
  if (!note || !engagement || !note.sharedWithClient) return false;
  if (note.engagementId !== next.engagementId) return false;
  if (engagement.clientOrganizationId !== next.clientOrganizationId) return false;
  if (!isNonEmpty(next.body) || !within(next.body, DEMO_TEXT_LIMITS.note)) return false;
  if (!isTimestamp(next.respondedAt)) return false;
  return can(next.clientOrganizationId, next.respondedBy, 'enterprise.disclosure.write');
}

// ----------------------------------------------------------------------
// 出力の突合（0051）
// ----------------------------------------------------------------------

/** Demo Mode で載せる突合の明細の上限 */
export const DEMO_RECONCILIATION_MISMATCH_MAX = 5;

function acceptReconciliation(
  db: FixtureDb,
  _existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  const snapshot = db.reportSnapshots.find((s) => s.id === next.snapshotId);
  if (!snapshot || snapshot.organizationId !== next.organizationId) return false;
  if (!oneOf(EXPORT_RECONCILIATION_SOURCES, next.source)) return false;
  if (!oneOf(RECONCILED_FORMATS, next.format) || !oneOf(EXPORT_AUDIENCES, next.audience)) {
    return false;
  }
  if (!isOptionalString(next.frameworkVersionId)) return false;
  if (!isString(next.fileSha256) || !/^[0-9a-f]{64}$/.test(next.fileSha256)) return false;
  if (!within(next.checkerVersion, 60)) return false;
  for (const key of ['paragraphsChecked', 'numbersChecked', 'rowsChecked', 'mismatchCount']) {
    if (!Number.isInteger(next[key]) || (next[key] as number) < 0) return false;
  }
  if (
    !Array.isArray(next.mismatches) ||
    next.mismatches.length > DEMO_RECONCILIATION_MISMATCH_MAX
  ) {
    return false;
  }
  if (!smallJson(next.mismatches)) return false;
  if (!isTimestamp(next.createdAt)) return false;
  return can(next.organizationId, next.createdBy, 'enterprise.export.run');
}

// ----------------------------------------------------------------------
// トライアルの評価（0055）
// ----------------------------------------------------------------------

function acceptTrialProgram(
  db: FixtureDb,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  if (!keysUnchanged(existing, next, ['organizationId', 'createdAt', 'createdBy'])) return false;
  if (!can(next.organizationId, writerOf(next), 'enterprise.org.manage')) return false;
  if (!isNonEmpty(next.name) || !within(next.name, DEMO_TEXT_LIMITS.trialTitle)) return false;
  if (!oneOf(TRIAL_PHASES, next.phase)) return false;
  if (
    !oneOf(TRIAL_END_DISPOSITIONS, next.endDisposition) ||
    !oneOf(TRIAL_DECISIONS, next.decision)
  ) {
    return false;
  }
  if (
    !optionalDate(next.startsOn) ||
    !optionalDate(next.endsOn) ||
    !optionalDate(next.endAgreedOn)
  ) {
    return false;
  }
  if (isString(next.startsOn) && isString(next.endsOn) && next.startsOn > next.endsOn) return false;
  for (const key of ['targetDataNote', 'decisionConditions', 'decidedByLabel']) {
    if (!within(next[key], DEMO_TEXT_LIMITS.trialText)) return false;
  }
  for (const key of ['includedUnitIds', 'selectedRequirementItemIds', 'selectedMetricIds']) {
    if (!isStringArray(next[key]) || (next[key] as string[]).length > 200) return false;
  }
  if (
    !(next.includedUnitIds as string[]).every((id) =>
      db.units.some((u) => u.id === id && u.organizationId === next.organizationId),
    )
  ) {
    return false;
  }
  if (next.projectId !== null) {
    const project = db.disclosureProjects.find((p) => p.id === next.projectId);
    if (!project || project.organizationId !== next.organizationId) return false;
  }
  for (const key of [
    'plannedMembers',
    'plannedSites',
    'plannedQuantitativeMetrics',
    'plannedNarrativeBlocks',
    'plannedRequirements',
    'plannedFiscalYears',
    'plannedFiles',
    'plannedApprovalLevels',
  ]) {
    if (!optionalNonNegativeInt(next[key])) return false;
  }
  if (!isPlainObject(next.options) || !isPlainObject(next.agreements)) return false;
  return smallJson(next.options) && smallJson(next.agreements);
}

function scenarioOfOrg(db: FixtureDb, organizationId: unknown, scenarioId: unknown): boolean {
  return db.trialScenarios.some((s) => s.id === scenarioId && s.organizationId === organizationId);
}

function acceptScenarioRun(db: FixtureDb, _existing: Row | undefined, next: Row): boolean {
  if (!scenarioOfOrg(db, next.organizationId, next.scenarioId)) return false;
  if (!activeMember(db, next.organizationId, next.performedBy)) return false;
  if (!oneOf(TRIAL_COMPLETIONS, next.completion)) return false;
  if (next.minutes !== null && !nonNegative(next.minutes)) return false;
  if (!Number.isInteger(next.helpCount) || (next.helpCount as number) < 0) return false;
  if (
    next.easeRating !== null &&
    (!Number.isInteger(next.easeRating) ||
      (next.easeRating as number) < 1 ||
      (next.easeRating as number) > 5)
  ) {
    return false;
  }
  if (!optionalTimestamp(next.startedAt) || !optionalTimestamp(next.endedAt)) return false;
  if (isString(next.startedAt) && isString(next.endedAt) && next.startedAt > next.endedAt) {
    return false;
  }
  if (!within(next.comment, DEMO_TEXT_LIMITS.trialText)) return false;
  if (!within(next.performedRole, DEMO_TEXT_LIMITS.trialTitle)) return false;
  if (!within(next.environmentVersion, 60)) return false;
  if (!isPlainObject(next.evidence) || !smallJson(next.evidence, 600)) return false;
  if (next.supersedesRunId !== null) {
    const previous = db.trialScenarioRuns.find((r) => r.id === next.supersedesRunId);
    if (
      !previous ||
      previous.organizationId !== next.organizationId ||
      previous.scenarioId !== next.scenarioId
    ) {
      return false;
    }
  }
  return isTimestamp(next.createdAt);
}

function acceptJudgement(
  db: FixtureDb,
  _existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  if (!scenarioOfOrg(db, next.organizationId, next.scenarioId)) return false;
  if (!oneOf(TRIAL_JUDGEMENTS, next.judgement)) return false;
  if (!isNonEmpty(next.reason) || !within(next.reason, DEMO_TEXT_LIMITS.trialText)) return false;
  if (!within(next.measuredValue, DEMO_TEXT_LIMITS.trialTitle)) return false;
  if (!isTimestamp(next.judgedAt)) return false;
  return can(next.organizationId, next.judgedBy, 'enterprise.org.manage');
}

/** トリアージ（状態・方針・費用区分・担当・期限・必須要件・合意）は org.manage だけが変える */
const FEEDBACK_TRIAGE_COLUMNS = [
  'status',
  'responsePolicy',
  'costClass',
  'ownerLabel',
  'dueOn',
  'mandatoryRequirement',
  'resolvedInVersion',
  'verificationResult',
  'verifiedBy',
  'verifiedAt',
  'agreed',
  'updatedAt',
  'updatedBy',
] as const;

function acceptFeedback(
  db: FixtureDb,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  if (!keysUnchanged(existing, next, ['organizationId', 'createdAt', 'createdBy'])) return false;
  if (!oneOf(FEEDBACK_KINDS, next.kind) || !oneOf(FEEDBACK_CHANNELS, next.channel)) return false;
  if (!isNonEmpty(next.title) || !within(next.title, DEMO_TEXT_LIMITS.trialTitle)) return false;
  if (!within(next.body, DEMO_TEXT_LIMITS.trialText)) return false;
  if (!within(next.routePattern, 300)) return false;
  if (!optionalOneOf(FEEDBACK_SEVERITIES, next.severity)) return false;
  if (next.severity !== null && next.kind !== 'defect') return false;
  if (!oneOf(FEEDBACK_STATUSES, next.status) || !oneOf(COST_CLASSES, next.costClass)) return false;
  for (const key of ['responsePolicy', 'ownerLabel', 'resolvedInVersion', 'verificationResult']) {
    if (!within(next[key], DEMO_TEXT_LIMITS.trialText)) return false;
  }
  if (!optionalDate(next.dueOn) || !optionalTimestamp(next.verifiedAt)) return false;
  if ((next.verifiedAt === null) !== (next.verifiedBy === null)) return false;
  if (typeof next.mandatoryRequirement !== 'boolean' || typeof next.agreed !== 'boolean') {
    return false;
  }
  if (next.scenarioId !== null && !scenarioOfOrg(db, next.organizationId, next.scenarioId)) {
    return false;
  }
  if (!existing) {
    // 投稿は組織メンバー本人
    return activeMember(db, next.organizationId, next.createdBy);
  }
  // 更新はトリアージの権限者。投稿の内容（種類・件名・本文など）は変えない
  if (!can(next.organizationId, writerOf(next), 'enterprise.org.manage')) return false;
  if (!onlyChanged(existing, next, [...FEEDBACK_TRIAGE_COLUMNS, 'severity', 'deletedAt'])) {
    return false;
  }
  return actorIsSelf(existing, next, 'verifiedBy');
}

function acceptTaskTiming(db: FixtureDb, _existing: Row | undefined, next: Row): boolean {
  if (!activeMember(db, next.organizationId, next.recordedBy)) return false;
  if (!oneOf(TRIAL_TASK_KEYS, next.taskKey) || !oneOf(TRIAL_TIMING_MODES, next.mode)) return false;
  if (!oneOf(TRIAL_TIMING_METHODS, next.method)) return false;
  if (typeof next.quantity !== 'number' || !(next.quantity > 0) || !nonNegative(next.minutes)) {
    return false;
  }
  if (!within(next.unitLabel, DEMO_TEXT_LIMITS.trialTitle)) return false;
  if (!within(next.department, DEMO_TEXT_LIMITS.trialTitle)) return false;
  if (!within(next.note, DEMO_TEXT_LIMITS.trialText) || !isDate(next.measuredOn)) return false;
  if (next.scenarioRunId !== null) {
    const run = db.trialScenarioRuns.find((r) => r.id === next.scenarioRunId);
    if (!run || run.organizationId !== next.organizationId) return false;
  }
  if (next.supersedesId !== null) {
    const previous = db.trialTaskTimings.find((t) => t.id === next.supersedesId);
    if (!previous || previous.organizationId !== next.organizationId) return false;
  }
  return isTimestamp(next.createdAt);
}

function acceptAiFeedback(db: FixtureDb, _existing: Row | undefined, next: Row): boolean {
  const run = db.aiRuns.find((r) => r.id === next.aiRunId);
  if (!run || run.organizationId !== next.organizationId) return false;
  if (!activeMember(db, next.organizationId, next.userId)) return false;
  if (!oneOf(['accepted', 'edited_accepted', 'rejected'], next.decision)) return false;
  if (next.comment !== null && !within(next.comment, DEMO_TEXT_LIMITS.trialText)) return false;
  return isTimestamp(next.createdAt);
}

// ----------------------------------------------------------------------
// 承認ルート・データ取扱条件・架空メンバー（0056）
// ----------------------------------------------------------------------

/** Demo Mode で持ち回す承認ルートの段階の上限（1 ルート） */
const DEMO_ROUTE_STAGE_MAX = 5;

function acceptApprovalRoute(
  db: FixtureDb,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  if (!keysUnchanged(existing, next, ['organizationId'])) return false;
  if (!db.organizations.some((o) => o.id === next.organizationId)) return false;
  if (!can(next.organizationId, writerOf(next), 'enterprise.org.manage')) return false;
  if (!isNonEmpty(next.name) || !within(next.name, DEMO_TEXT_LIMITS.trialTitle)) return false;
  if (!within(next.description, DEMO_TEXT_LIMITS.trialText)) return false;
  if (typeof next.isDefault !== 'boolean' || !oneOf(APPROVAL_ROUTE_PURPOSES, next.purpose)) {
    return false;
  }
  // 既定のルートは組織にひとつだけ
  return (
    !next.isDefault ||
    !db.approvalRoutes.some(
      (r) => r.id !== next.id && r.organizationId === next.organizationId && r.isDefault,
    )
  );
}

function acceptRouteStage(
  db: FixtureDb,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  if (!keysUnchanged(existing, next, ['organizationId', 'routeId'])) return false;
  const route = db.approvalRoutes.find((r) => r.id === next.routeId);
  if (!route || route.organizationId !== next.organizationId) return false;
  // 段階には更新者の列が無いため、ルートを最後に書いた人の権限で見る
  if (!can(route.organizationId, route.updatedBy ?? route.createdBy, 'enterprise.org.manage')) {
    return false;
  }
  if (
    !Number.isInteger(next.stageNo) ||
    (next.stageNo as number) < 1 ||
    (next.stageNo as number) > DEMO_ROUTE_STAGE_MAX
  ) {
    return false;
  }
  if (!isNonEmpty(next.name) || !within(next.name, DEMO_TEXT_LIMITS.trialTitle)) return false;
  if (next.approverRole !== '' && !oneOf(ENTERPRISE_ROLES, next.approverRole)) return false;
  if (next.approverUserId !== null && !activeMember(db, next.organizationId, next.approverUserId)) {
    return false;
  }
  if (!within(next.department, DEMO_TEXT_LIMITS.trialTitle)) return false;
  if (!optionalTimestamp(next.deletedAt ?? null)) return false;
  const live = db.approvalRouteStages.filter(
    (s) => s.routeId === next.routeId && s.id !== next.id && !s.deletedAt,
  );
  if (!next.deletedAt && live.length + 1 > DEMO_ROUTE_STAGE_MAX) return false;
  return next.deletedAt ? true : !live.some((s) => s.stageNo === next.stageNo);
}

function acceptDataTerms(
  db: FixtureDb,
  _existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  if (!can(next.organizationId, next.createdBy, 'enterprise.org.manage')) return false;
  if (!Number.isInteger(next.versionNo) || (next.versionNo as number) < 1) return false;
  if (
    db.organizationDataTerms.some(
      (t) => t.organizationId === next.organizationId && t.versionNo >= (next.versionNo as number),
    )
  ) {
    return false;
  }
  if (!oneOf(NDA_STATUSES, next.ndaStatus) || !oneOf(AI_TRAINING_USES, next.aiTrainingUse)) {
    return false;
  }
  if (!oneOf(AI_PROVIDER_STORAGES, next.aiProviderStorage)) return false;
  for (const key of [
    'processingTermsRef',
    'storageLocation',
    'retentionPolicy',
    'returnMethod',
    'deletionMethod',
    'agreedByLabel',
    'note',
  ]) {
    if (!within(next[key], DEMO_TEXT_LIMITS.trialText)) return false;
  }
  if (!Array.isArray(next.subprocessors) || next.subprocessors.length > 10) return false;
  if (!smallJson(next.subprocessors)) return false;
  return optionalDate(next.agreedOn) && isTimestamp(next.createdAt);
}

/**
 * 架空メンバーのメンバーシップの変更（担当拠点・状態）だけを受け付ける。新しい行・実在のデモ利用者の行・
 * 組織や利用者の付け替えは受け付けない（なりすまし・権限の注入に使わせない）。役割（membership_roles）は
 * 主キーを持たないため持ち回さない
 */
function acceptMembership(
  db: FixtureDb,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  if (!existing) return false;
  const profile = db.profiles.find((p) => p.id === existing.userId);
  if (!profile || !profile.email.endsWith(FICTIONAL_MEMBER_EMAIL_SUFFIX)) return false;
  if (!onlyChanged(existing, next, ['unitScopeIds', 'status', 'updatedAt', 'updatedBy'])) {
    return false;
  }
  if (!oneOf(['active', 'suspended'], next.status)) return false;
  if (!isStringArray(next.unitScopeIds)) return false;
  if (
    !next.unitScopeIds.every((id) =>
      db.units.some((u) => u.id === id && u.organizationId === existing.organizationId),
    )
  ) {
    return false;
  }
  return can(existing.organizationId, writerOf(next), 'enterprise.member.manage');
}

// ----------------------------------------------------------------------
// XBRL の対応付け（0054）
// ----------------------------------------------------------------------

function acceptXbrlMapping(
  db: FixtureDb,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  if (!keysUnchanged(existing, next, ['organizationId', 'createdBy', 'createdAt'])) return false;
  const concept = db.xbrlConcepts.find(
    (c) => c.id === next.conceptId && c.packageId === next.packageId,
  );
  if (!concept || (concept.kind !== 'item' && concept.kind !== 'text_block')) return false;
  if (!oneOf(XBRL_TARGET_KINDS, next.targetKind) || !oneOf(XBRL_PERIOD_ROLES, next.periodRole)) {
    return false;
  }
  if (!oneOf(XBRL_MAPPING_STATUSES, next.status) || !oneOf(XBRL_MAPPING_ORIGINS, next.origin)) {
    return false;
  }
  if (next.targetKind === 'metric') {
    const metric = db.metrics.find((m) => m.id === next.metricId);
    if (!metric || metric.organizationId !== next.organizationId) return false;
  }
  if (
    next.targetKind === 'block' &&
    (!isString(next.frameworkVersionId) || !isString(next.sectionKey))
  ) {
    return false;
  }
  if (next.unitId !== null) {
    const unit = db.units.find((u) => u.id === next.unitId);
    if (!unit || unit.organizationId !== next.organizationId) return false;
  }
  if (next.projectId !== null) {
    const project = db.disclosureProjects.find((p) => p.id === next.projectId);
    if (!project || project.organizationId !== next.organizationId) return false;
  }
  if (
    next.disclosureItemId !== null &&
    next.frameworkVersionId !== null &&
    !itemInVersion(db, next.disclosureItemId, next.frameworkVersionId)
  ) {
    return false;
  }
  if (!isPlainObject(next.dimensions) || !smallJson(next.dimensions, 600)) return false;
  if (
    next.decimals !== null &&
    (!Number.isInteger(next.decimals) || Math.abs(next.decimals as number) > 12)
  ) {
    return false;
  }
  if (!Number.isInteger(next.scale) || Math.abs(next.scale as number) > 12) return false;
  if (next.status === 'excluded' && !isNonEmpty(next.excludedReason)) return false;
  if (!within(next.excludedReason, DEMO_TEXT_LIMITS.trialText)) return false;
  if ((next.origin === 'ai_adopted') !== (next.aiRunId !== null)) return false;
  if (!aiRunOfOrg(db, next.organizationId, next.aiRunId)) return false;
  if ((next.confirmedAt === null) !== (next.confirmedBy === null)) return false;
  if (next.status === 'confirmed' && next.confirmedAt === null) return false;
  // 職務分離: 作った人は確定しない
  if (next.confirmedBy !== null && next.createdBy !== null && next.confirmedBy === next.createdBy) {
    return false;
  }
  const writer = writerOf(next);
  if (!existing) {
    // 作成は本人の名義で、候補として（DB の 0059 と同じ。別の人を作成者にした行・作成と同時に確定した行を
    // Cookie から戻さない）
    if (next.createdBy !== writer) return false;
    if (next.status !== 'candidate' || next.confirmedBy !== null || next.confirmedAt !== null) {
      return false;
    }
  }
  const confirmChanged =
    next.status === 'confirmed' &&
    (!existing || existing.status !== 'confirmed' || existing.confirmedBy !== next.confirmedBy);
  if (confirmChanged) {
    if (next.confirmedBy !== writer) return false;
    if (!can(next.organizationId, writer, 'enterprise.disclosure.approve')) return false;
    // 職務分離: 最後に内容を変えた人は確定しない。内容の変更と確定を同じ書込で行わない（DB の 0059 と同じ）
    if (existing && existing.updatedBy !== null && existing.updatedBy === next.confirmedBy) {
      return false;
    }
    if (
      existing &&
      !onlyChanged(existing, next, [
        'status',
        'confirmedBy',
        'confirmedAt',
        'updatedAt',
        'updatedBy',
      ])
    ) {
      return false;
    }
  }
  if (can(next.organizationId, writer, 'enterprise.disclosure.write')) return true;
  // 承認権限だけの人は確定の列だけを変えられる
  return (
    !!existing &&
    can(next.organizationId, writer, 'enterprise.disclosure.approve') &&
    onlyChanged(existing, next, ['status', 'confirmedBy', 'confirmedAt', 'updatedAt', 'updatedBy'])
  );
}

function acceptXbrlMappingEvent(
  db: FixtureDb,
  _existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  const mapping = db.xbrlTagMappings.find((m) => m.id === next.mappingId);
  if (!mapping || mapping.organizationId !== next.organizationId) return false;
  if (!oneOf(XBRL_MAPPING_EVENT_TYPES, next.event)) return false;
  if (next.before !== null && !isPlainObject(next.before)) return false;
  if (next.after !== null && !isPlainObject(next.after)) return false;
  if (!smallJson(next.before) || !smallJson(next.after)) return false;
  if (!within(next.reason, DEMO_TEXT_LIMITS.trialText) || !isTimestamp(next.createdAt))
    return false;
  return (
    can(next.organizationId, next.actorUserId, 'enterprise.disclosure.write') ||
    can(next.organizationId, next.actorUserId, 'enterprise.disclosure.approve')
  );
}

// ----------------------------------------------------------------------
// CDP の回答と情報の対応付け（0057）・回答の根拠
// ----------------------------------------------------------------------

function acceptResponseContentLink(
  db: FixtureDb,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  if (existing) {
    if (existing.deletedAt !== null) return false;
    if (!onlyChanged(existing, next, ['deletedAt', 'deletedBy'])) return false;
    if (!isTimestamp(next.deletedAt) || !isString(next.deletedBy)) return false;
    return can(next.organizationId, next.deletedBy, 'enterprise.disclosure.write');
  }
  // 同じセッションで付けて外した行は、外した状態の 1 行として届く（Cookie は行の最後の形だけを持つ）。
  // 外した人も編集の権限を持つ本人であること（0057 の response_content_links_deleted_self と同じ）
  const deleted = next.deletedAt !== null || next.deletedBy !== null;
  if (deleted) {
    if (!isTimestamp(next.deletedAt) || !isString(next.deletedBy)) return false;
    if (!can(next.organizationId, next.deletedBy, 'enterprise.disclosure.write')) return false;
  }
  if (!db.disclosureItems.some((i) => i.id === next.itemId)) return false;
  if (!oneOf(RESPONSE_CONTENT_TARGET_KINDS, next.targetKind)) return false;
  if (!oneOf(RESPONSE_CONTENT_LINK_SOURCES, next.linkSource)) return false;
  if ((next.linkSource === 'ai_adopted') !== (next.aiRunId !== null)) return false;
  if (!aiRunOfOrg(db, next.organizationId, next.aiRunId)) return false;
  const targetOk =
    next.targetKind === 'narrative_record'
      ? db.narrativeRecords.some(
          (r) => r.id === next.targetId && r.organizationId === next.organizationId,
        )
      : next.targetKind === 'disclosure_block'
        ? db.disclosureBlocks.some(
            (b) => b.id === next.targetId && b.organizationId === next.organizationId,
          )
        : db.disclosureItems.some((i) => i.id === next.targetId);
  if (!targetOk) return false;
  if (!isTimestamp(next.confirmedAt)) return false;
  if (!can(next.organizationId, next.confirmedBy, 'enterprise.disclosure.write')) return false;
  // 外した行は一意の制約（有効な行どうし）に数えない
  if (deleted) return true;
  return !db.responseContentLinks.some(
    (l) =>
      l.id !== next.id &&
      l.deletedAt === null &&
      l.organizationId === next.organizationId &&
      l.itemId === next.itemId &&
      l.targetKind === next.targetKind &&
      l.targetId === next.targetId,
  );
}

function acceptResponseEvidenceLink(db: FixtureDb, _existing: Row | undefined, next: Row): boolean {
  const response = db.disclosureResponses.find((r) => r.id === next.responseId);
  const link = db.evidenceLinks.find((l) => l.id === next.evidenceLinkId);
  if (!response || response.organizationId !== next.organizationId) return false;
  if (!link || link.organizationId !== next.organizationId) return false;
  if (!isTimestamp(next.createdAt)) return false;
  return !db.responseEvidenceLinks.some(
    (l) =>
      l.id !== next.id &&
      l.responseId === next.responseId &&
      l.evidenceLinkId === next.evidenceLinkId,
  );
}

/** CDP の質問か（項目 → 基準の版 → 基準のキー） */
function isCdpItem(db: FixtureDb, itemId: unknown): boolean {
  const item = db.disclosureItems.find((i) => i.id === itemId);
  const version = item ? db.frameworkVersions.find((v) => v.id === item.frameworkVersionId) : null;
  const framework = version ? db.frameworks.find((f) => f.id === version.frameworkId) : null;
  return framework?.key === 'cdp';
}

/**
 * CDP の質問と指標の対応付け（disclosure_mappings。T7 の回答画面の確定・追加・外す）。外すのは確定者・日時を
 * null にする更新。戻すのは CDP の質問だけ（SSBJ・CSRD の対応付けはこの経路で変えない）・指標と組織単位は
 * 同じ組織・書き手は開示の編集の権限・確定者は書き手本人・(組織, 質問, 指標, 組織単位) で 1 行
 */
function acceptDisclosureMapping(
  db: FixtureDb,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  if (!keysUnchanged(existing, next, ['organizationId', 'itemId', 'metricId', 'unitId'])) {
    return false;
  }
  if (!isCdpItem(db, next.itemId)) return false;
  if (!db.metrics.some((m) => m.id === next.metricId && m.organizationId === next.organizationId)) {
    return false;
  }
  if (
    next.unitId !== null &&
    !db.units.some((u) => u.id === next.unitId && u.organizationId === next.organizationId)
  ) {
    return false;
  }
  if (!oneOf(['manual', 'ai_suggested'], next.mappingSource)) return false;
  if (!aiRunOfOrg(db, next.organizationId, next.aiRunId ?? null)) return false;
  if (!isOptionalString(next.transform ?? null) || !within(next.transform ?? '', 200)) return false;
  if (!can(next.organizationId, writerOf(next), 'enterprise.disclosure.write')) return false;
  if ((next.confirmedBy === null) !== (next.confirmedAt === null)) return false;
  if (next.confirmedAt !== null && !isTimestamp(next.confirmedAt)) return false;
  if (!actorIsSelf(existing, next, 'confirmedBy')) return false;
  return !db.disclosureMappings.some(
    (m) =>
      m.id !== next.id &&
      m.organizationId === next.organizationId &&
      m.itemId === next.itemId &&
      m.metricId === next.metricId &&
      (m.unitId ?? null) === (next.unitId ?? null),
  );
}

/**
 * 回答の承認の職務分離（0057 の t4d.disclosure_response_approval_sod の中心の規則）: 現在の版を作った人は
 * 承認者になれない。Cookie は行の最後の形だけを持つ（承認の後の担当の変更などで書き手が変わる）ため、
 * 「承認者＝その書込の書き手」は確かめられない。版が戻っていない回答（回答の版は持ち回さない）は見ない
 */
function acceptDisclosureResponse(db: FixtureDb, existing: Row | undefined, next: Row): boolean {
  if (next.status !== 'approved') return true;
  if (
    existing &&
    existing.status === 'approved' &&
    existing.currentVersionId === next.currentVersionId &&
    existing.approvedBy === next.approvedBy
  ) {
    return true;
  }
  const version = db.disclosureResponseVersions.find(
    (v) => v.id === next.currentVersionId && v.responseId === next.id,
  );
  const author = version?.createdBy ?? null;
  return !(author !== null && author === next.approvedBy);
}

// ----------------------------------------------------------------------
// 入口
// ----------------------------------------------------------------------

type Check = (db: FixtureDb, existing: Row | undefined, next: Row, can: PermissionCheck) => boolean;

const CHECKS: Readonly<Record<string, Check>> = {
  projectRequirementAssessments: acceptProjectAssessment,
  projectRequirementAssessmentEvents: acceptAssessmentEvent,
  narrativeRequirementLinks: acceptNarrativeLink,
  sharedReportCopies: acceptSharedCopy,
  reviewNotes: acceptReviewNote,
  reviewNoteResponses: acceptNoteResponse,
  exportReconciliations: acceptReconciliation,
  trialPrograms: acceptTrialProgram,
  trialScenarioRuns: acceptScenarioRun,
  trialScenarioJudgements: acceptJudgement,
  trialFeedbackItems: acceptFeedback,
  trialTaskTimings: acceptTaskTiming,
  aiFeedback: acceptAiFeedback,
  approvalRoutes: acceptApprovalRoute,
  approvalRouteStages: acceptRouteStage,
  organizationDataTerms: acceptDataTerms,
  memberships: acceptMembership,
  xbrlTagMappings: acceptXbrlMapping,
  xbrlTagMappingEvents: acceptXbrlMappingEvent,
  responseContentLinks: acceptResponseContentLink,
  responseEvidenceLinks: acceptResponseEvidenceLink,
  // T7 の依頼（CDP 回答の管理）。持ち回しの表は demo-edit-codec.ts の PERSISTED_TABLES
  disclosureMappings: acceptDisclosureMapping,
  disclosureResponses: (db, existing, next) => acceptDisclosureResponse(db, existing, next),
};

/** この表の行をトライアル対応の規則で検査するか */
export function isTrialCheckedTable(table: string): boolean {
  return table in CHECKS || table === 'requirementExclusionEvents';
}

/**
 * Cookie から戻すトライアル対応の行を検査する。受け付けるなら true
 */
export function acceptTrialEdit(
  db: FixtureDb,
  table: string,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  if (!isString(next.id)) return false;
  if (table === 'requirementExclusionEvents') {
    return isString(next.organizationId) && acceptExclusionEvent(db, existing, next, can);
  }
  const check = CHECKS[table];
  if (!check) return true;
  return check(db, existing, next, can);
}
