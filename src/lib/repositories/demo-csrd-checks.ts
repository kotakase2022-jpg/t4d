import { CSRD_DRAFT_BODY_MAX } from '@/lib/domain/csrd';
import { validateIroShape } from '@/lib/domain/dma';
import { combineCoverage } from '@/lib/domain/ssbj';
import type { FixtureDb } from '@/lib/fixtures/store';
import {
  CSRD_SECTIONS,
  DMA_AXIS_ASSESSMENTS,
  ESRS_TOPICS,
  SSBJ_ACTION_STATUSES,
  SSBJ_ACTION_TYPES,
  SSBJ_CONSOLIDATION_SCOPES,
  SSBJ_COVERAGE_STATUSES,
  SSBJ_GAP_KINDS,
  SSBJ_PRIORITIES,
  SSBJ_REVIEW_DECISIONS,
  SSBJ_VALUE_CHAIN_SCOPES,
  type CsrdActionPlan,
  type CsrdAnalysisSettings,
  type CsrdAssessment,
  type CsrdDisclosureDraft,
  type CsrdDmaIro,
  type CsrdDmaMatter,
  type MetricAssignment,
  type PermissionKey,
} from '@/types/domain';
import type { TableName } from './types';

/**
 * Cookie から戻す CSRD の行（0044〜0046）と、CSRD の収集項目が作る割当（metric_assignments）の検査
 * （docs/disclosure-first.md §9.3「デモ永続化」）。
 *
 * Fixture DB はインスタンスの全利用者で共有される。偽の Cookie で、別の組織の期間・事項・評価・
 * 拠点・指標を指す行や、権限の無い人の名義の行、条件を満たさない「DMA 確定」を全員の画面に出させない。
 * DB の RLS（書込権限・組織）・CHECK・複合外部キー・ガードトリガ（CSRD の要求事項に限る）と同じ規則を通す。
 * 既にある行の組織・期間・親（事項・評価・要求事項・節）は書き換えさせない（主キーと業務キーを守る）。
 */

/** 持ち回す CSRD の表（PERSISTED_TABLES と DISCLOSURE_DEMO_RESET_TABLES に入れる） */
export const CSRD_PERSISTED_TABLES = [
  'csrdAnalysisSettings',
  'csrdDmaMatters',
  'csrdDmaIros',
  'csrdAssessments',
  'csrdActionPlans',
  'csrdDisclosureDrafts',
] as const satisfies readonly TableName[];

/**
 * 戻す順番（demo-edit-codec.ts の DEFERRED_ORDER に足す。小さいほど先）。
 *  - 事項 → IRO（事項の行が要る）、評価 → 計画（評価の行が要る）
 *  - 分析条件は事項の後（DMA の確定の条件を、戻した事項の判断で確かめる）
 *  - 割当は指標・拠点（先に戻る表）の後
 */
export const CSRD_DEFERRED_ORDER: Readonly<Record<string, number>> = {
  csrdDmaMatters: 1,
  csrdAssessments: 1,
  metricAssignments: 1,
  csrdDmaIros: 2,
  csrdActionPlans: 2,
  csrdAnalysisSettings: 3,
  csrdDisclosureDrafts: 3,
};

/** 組織の利用者がその権限を持つか（demo-edit-codec.ts の memberPermissions を使う） */
export type PermissionCheck = (
  organizationId: unknown,
  userId: unknown,
  permission: PermissionKey,
) => boolean;

type Row = Record<string, unknown>;

const isString = (value: unknown): value is string => typeof value === 'string';
const isOptionalString = (value: unknown): boolean => value === null || isString(value);
const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');
const oneOf = (values: readonly string[], value: unknown): boolean =>
  isString(value) && values.includes(value);
const optionalOneOf = (values: readonly string[], value: unknown): boolean =>
  value === null || oneOf(values, value);
const isTimestamp = (value: unknown): boolean =>
  isString(value) && Number.isFinite(Date.parse(value));
const optionalTimestamp = (value: unknown): boolean => value === null || isTimestamp(value);

/** 期間がその組織のものか */
function periodOfOrg(db: FixtureDb, organizationId: unknown, periodId: unknown): boolean {
  return db.periods.some((p) => p.id === periodId && p.organizationId === organizationId);
}

/** 既にある行の主キー・組織・業務キーが変わっていないか */
function keysUnchanged(existing: Row | undefined, next: Row, keys: readonly string[]): boolean {
  if (!existing) return true;
  return ['id', 'organizationId', ...keys].every((key) => existing[key] === next[key]);
}

/** 同じ業務キーの別の行が無いか（UNIQUE 制約） */
function unique<T extends { id: string }>(
  rows: readonly T[],
  next: Row,
  matches: (row: T) => boolean,
): boolean {
  return !rows.some((row) => row.id !== next.id && matches(row));
}

/** 行を書いた人（更新者、無ければ作成者）がその権限を持つか */
function writerCan(next: Row, can: PermissionCheck, permission: PermissionKey): boolean {
  return can(next.organizationId, next.updatedBy ?? next.createdBy, permission);
}

/**
 * 判断者・確定者が、行を書いた人（更新者）本人か（0047 の t4d.csrd_actor_must_be_self と同じ規則）。
 * 分析条件・事項・節は、確定・判断を入れる書込で名義と更新者を同時に入れ、ほかの書込は確定を外すため、
 * 名義が入っている行では必ず名義 = 更新者になる。偽の Cookie で別の人の名義を名乗らせない。
 * 評価（csrd_assessments）は、確認の後に AI の分析が更新者だけを変えるため、この規則を当てない（DB 側で見る）
 */
function actorIsWriter(next: Row, actor: unknown): boolean {
  return actor === null || actor === (next.updatedBy ?? next.createdBy);
}

/** AI の実行は、このインスタンスにあれば同じ組織のもの（押し出された実行は「無い」として受け付ける） */
function aiRunOfOrg(db: FixtureDb, organizationId: unknown, aiRunId: unknown): boolean {
  if (aiRunId === null) return true;
  if (!isString(aiRunId)) return false;
  const run = db.aiRuns.find((r) => r.id === aiRunId);
  return !run || run.organizationId === organizationId;
}

function activeMember(db: FixtureDb, organizationId: unknown, userId: unknown): boolean {
  return db.memberships.some(
    (m) => m.organizationId === organizationId && m.userId === userId && m.status === 'active',
  );
}

/** 閾値（numeric(2,1)、1.0〜5.0） */
function isThreshold(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 1 &&
    value <= 5 &&
    Math.abs(Math.round(value * 10) - value * 10) < 1e-9
  );
}

// ----------------------------------------------------------------------
// 表ごとの検査
// ----------------------------------------------------------------------

/**
 * 分析条件。DMA の確定は、確定者の編集権限と確定の条件（報告範囲の決定・ステークホルダー関与・
 * 10 事項すべての判断）を、戻した事項の判断で確かめる。条件を満たさない確定は外して受け付ける
 * （事項の判断が Cookie から押し出されたとき、報告範囲・閾値の変更まで捨てない）
 */
function acceptSettings(
  db: FixtureDb,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  const row = next as unknown as CsrdAnalysisSettings;
  if (!periodOfOrg(db, row.organizationId, row.reportingPeriodId)) return false;
  if (!keysUnchanged(existing, next, ['reportingPeriodId'])) return false;
  if (
    !unique(
      db.csrdAnalysisSettings,
      next,
      (r) =>
        r.organizationId === row.organizationId && r.reportingPeriodId === row.reportingPeriodId,
    )
  ) {
    return false;
  }
  if (!writerCan(next, can, 'enterprise.disclosure.write')) return false;
  if (
    !oneOf(SSBJ_CONSOLIDATION_SCOPES, row.consolidationScope) ||
    !oneOf(SSBJ_VALUE_CHAIN_SCOPES, row.valueChainScope) ||
    row.scoringMethod !== 'dma-demo-v1' ||
    !isThreshold(row.impactThreshold) ||
    !isThreshold(row.financialThreshold) ||
    !isString(row.consolidationNote) ||
    !isString(row.valueChainNote) ||
    !isString(row.methodNote) ||
    !isString(row.stakeholderEngagementNote) ||
    !isStringArray(row.includedUnitIds)
  ) {
    return false;
  }
  // 報告対象の拠点は同じ組織のものだけ
  if (
    !row.includedUnitIds.every((id) =>
      db.units.some((u) => u.id === id && u.organizationId === row.organizationId),
    )
  ) {
    return false;
  }
  if (!optionalTimestamp(row.dmaConfirmedAt)) return false;
  const confirmationValid =
    row.dmaConfirmedAt !== null &&
    can(row.organizationId, row.dmaConfirmedBy, 'enterprise.disclosure.write') &&
    actorIsWriter(next, row.dmaConfirmedBy) &&
    dmaConfirmable(db, row);
  if (!confirmationValid) {
    next.dmaConfirmedAt = null;
    next.dmaConfirmedBy = null;
  }
  return true;
}

/** DMA の確定の条件（settings.ts の dmaReadiness と同じ規則を、このインスタンスの行で確かめる） */
function dmaConfirmable(db: FixtureDb, settings: CsrdAnalysisSettings): boolean {
  const boundaryDecided =
    settings.valueChainScope !== 'not_decided' &&
    (settings.consolidationScope !== 'custom' || settings.consolidationNote.trim() !== '');
  if (!boundaryDecided || settings.stakeholderEngagementNote.trim() === '') return false;
  const matters = db.csrdDmaMatters.filter(
    (m) =>
      m.organizationId === settings.organizationId &&
      m.reportingPeriodId === settings.reportingPeriodId,
  );
  return ESRS_TOPICS.every((topic) => {
    const matter = matters.find((m) => m.esrsTopic === topic);
    return (
      matter !== undefined &&
      matter.impactAssessment !== 'not_assessed' &&
      matter.financialAssessment !== 'not_assessed'
    );
  });
}

function acceptMatter(
  db: FixtureDb,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  const row = next as unknown as CsrdDmaMatter;
  if (!periodOfOrg(db, row.organizationId, row.reportingPeriodId)) return false;
  if (!oneOf(ESRS_TOPICS, row.esrsTopic)) return false;
  if (!keysUnchanged(existing, next, ['reportingPeriodId', 'esrsTopic'])) return false;
  if (
    !unique(
      db.csrdDmaMatters,
      next,
      (r) =>
        r.organizationId === row.organizationId &&
        r.reportingPeriodId === row.reportingPeriodId &&
        r.esrsTopic === row.esrsTopic,
    )
  ) {
    return false;
  }
  if (!writerCan(next, can, 'enterprise.disclosure.write')) return false;
  if (
    !oneOf(DMA_AXIS_ASSESSMENTS, row.impactAssessment) ||
    !oneOf(DMA_AXIS_ASSESSMENTS, row.financialAssessment) ||
    !isString(row.impactRationale) ||
    !isString(row.financialRationale) ||
    !isString(row.stakeholderNote)
  ) {
    return false;
  }
  // 評価済みの軸は根拠が必須（0044 の CHECK と同じ）
  if (row.impactAssessment !== 'not_assessed' && row.impactRationale.trim() === '') return false;
  if (row.financialAssessment !== 'not_assessed' && row.financialRationale.trim() === '') {
    return false;
  }
  if ((row.decidedAt === null) !== (row.decidedBy === null)) return false;
  if (row.decidedAt !== null) {
    if (!isTimestamp(row.decidedAt)) return false;
    if (!can(row.organizationId, row.decidedBy, 'enterprise.disclosure.write')) return false;
    if (!actorIsWriter(next, row.decidedBy)) return false;
  }
  return true;
}

function acceptIro(
  db: FixtureDb,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  const row = next as unknown as CsrdDmaIro;
  if (!periodOfOrg(db, row.organizationId, row.reportingPeriodId)) return false;
  if (!keysUnchanged(existing, next, ['reportingPeriodId', 'matterId'])) return false;
  // 事項は同じ組織・同じ期間の行だけ（複合外部キーと同じ）
  const matter = db.csrdDmaMatters.find((m) => m.id === row.matterId);
  if (
    !matter ||
    matter.organizationId !== row.organizationId ||
    matter.reportingPeriodId !== row.reportingPeriodId
  ) {
    return false;
  }
  if (!writerCan(next, can, 'enterprise.disclosure.write')) return false;
  if (!optionalTimestamp(row.deletedAt ?? null)) return false;
  if (
    !isString(row.subTopic) ||
    !isString(row.description) ||
    !isString(row.affectedStakeholders) ||
    typeof row.humanRights !== 'boolean'
  ) {
    return false;
  }
  if (validateIroShape(row).length > 0) return false;
  // 根拠の引用位置は同じ組織のもの（0052 の t4d.iro_source_anchor_guard と同じ）。方針・行動のメモは 400 字まで
  const anchors = (row as { sourceAnchorIds?: unknown }).sourceAnchorIds ?? [];
  if (
    !Array.isArray(anchors) ||
    anchors.length > 50 ||
    !anchors.every((id) =>
      db.sourceAnchors.some((a) => a.id === id && a.organizationId === row.organizationId),
    )
  ) {
    return false;
  }
  const note = (row as { policyActionNote?: unknown }).policyActionNote ?? '';
  if (!isString(note) || note.length > 400) return false;
  if (row.relatedImpactIroId !== null) {
    const related = db.csrdDmaIros.find((i) => i.id === row.relatedImpactIroId);
    if (
      !related ||
      related.id === row.id ||
      related.organizationId !== row.organizationId ||
      related.matterId !== row.matterId ||
      related.iroType !== 'impact'
    ) {
      return false;
    }
  }
  return true;
}

/** 要求事項が CSRD の版のものか（0045 の t4d.csrd_assessment_item_guard と同じ） */
function isCsrdItem(db: FixtureDb, itemId: unknown): boolean {
  const item = db.disclosureItems.find((i) => i.id === itemId);
  if (!item) return false;
  const version = db.frameworkVersions.find((v) => v.id === item.frameworkVersionId);
  const framework = version ? db.frameworks.find((f) => f.id === version.frameworkId) : undefined;
  return framework?.key === 'csrd';
}

function acceptAssessment(
  db: FixtureDb,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  const row = next as unknown as CsrdAssessment;
  if (!periodOfOrg(db, row.organizationId, row.reportingPeriodId)) return false;
  if (!keysUnchanged(existing, next, ['reportingPeriodId', 'itemId'])) return false;
  if (!isCsrdItem(db, row.itemId)) return false;
  if (
    !unique(
      db.csrdAssessments,
      next,
      (r) =>
        r.organizationId === row.organizationId &&
        r.reportingPeriodId === row.reportingPeriodId &&
        r.itemId === row.itemId,
    )
  ) {
    return false;
  }
  if (!writerCan(next, can, 'enterprise.disclosure.write')) return false;
  const human = [row.disclosureStatus, row.dataStatus, row.processStatus] as const;
  if (!human.every((s) => oneOf(SSBJ_COVERAGE_STATUSES, s))) return false;
  const ai = [row.aiDisclosureStatus, row.aiDataStatus, row.aiProcessStatus, row.aiStatus];
  if (!ai.every((s) => optionalOneOf(SSBJ_COVERAGE_STATUSES, s))) return false;
  // AI の候補は 3 観点・総合・実行日時がそろって入る（0045 の CHECK と同じ）
  const aiPresent = ai.map((s) => s !== null).concat(row.aiEvaluatedAt !== null);
  if (aiPresent.some((p) => p !== aiPresent[0])) return false;
  if (!optionalTimestamp(row.aiEvaluatedAt)) return false;
  if (
    !isString(row.aiComment) ||
    !isStringArray(row.aiMissingInfo) ||
    !isString(row.aiRecommendation) ||
    !isString(row.reviewComment) ||
    !isString(row.ownerDepartment)
  ) {
    return false;
  }
  if (!aiRunOfOrg(db, row.organizationId, row.aiRunId)) return false;
  // 最終判定は人が確認したときだけ。確認した人は編集権限を持つ。総合は人の 3 観点から
  if ((row.finalStatus === null) !== (row.reviewedAt === null)) return false;
  if ((row.reviewedAt === null) !== (row.reviewedBy === null)) return false;
  if (!optionalOneOf(SSBJ_REVIEW_DECISIONS, row.reviewDecision)) return false;
  if (row.reviewDecision !== null && row.reviewedAt === null) return false;
  if (row.reviewedAt !== null) {
    if (!isTimestamp(row.reviewedAt)) return false;
    if (!can(row.organizationId, row.reviewedBy, 'enterprise.disclosure.write')) return false;
    if (row.finalStatus !== combineCoverage(...human)) return false;
  }
  if (row.ownerUserId !== null && !activeMember(db, row.organizationId, row.ownerUserId)) {
    return false;
  }
  return true;
}

function acceptPlan(
  db: FixtureDb,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  const row = next as unknown as CsrdActionPlan;
  if (!periodOfOrg(db, row.organizationId, row.reportingPeriodId)) return false;
  if (!keysUnchanged(existing, next, ['reportingPeriodId', 'assessmentId'])) return false;
  // 評価は同じ組織の行だけ（複合外部キーと同じ）
  const assessment = db.csrdAssessments.find((a) => a.id === row.assessmentId);
  if (!assessment || assessment.organizationId !== row.organizationId) return false;
  if (!writerCan(next, can, 'enterprise.disclosure.write')) return false;
  if (
    !oneOf(SSBJ_GAP_KINDS, row.gapKind) ||
    !oneOf(SSBJ_ACTION_TYPES, row.actionType) ||
    !oneOf(SSBJ_PRIORITIES, row.priority) ||
    !oneOf(SSBJ_ACTION_STATUSES, row.status) ||
    !isString(row.title) ||
    row.title.trim() === '' ||
    !isString(row.detail) ||
    !isString(row.department) ||
    !isOptionalString(row.dueDate) ||
    !isOptionalString(row.linkedMetricCode)
  ) {
    return false;
  }
  if (row.assigneeUserId !== null && !activeMember(db, row.organizationId, row.assigneeUserId)) {
    return false;
  }
  return true;
}

function acceptDraft(
  db: FixtureDb,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  const row = next as unknown as CsrdDisclosureDraft;
  if (!periodOfOrg(db, row.organizationId, row.reportingPeriodId)) return false;
  if (!oneOf(CSRD_SECTIONS, row.section)) return false;
  if (!keysUnchanged(existing, next, ['reportingPeriodId', 'section'])) return false;
  if (
    !unique(
      db.csrdDisclosureDrafts,
      next,
      (r) =>
        r.organizationId === row.organizationId &&
        r.reportingPeriodId === row.reportingPeriodId &&
        r.section === row.section,
    )
  ) {
    return false;
  }
  if (!writerCan(next, can, 'enterprise.disclosure.write')) return false;
  if (
    !isString(row.body) ||
    row.body.length > CSRD_DRAFT_BODY_MAX ||
    !isString(row.aiBody) ||
    !isStringArray(row.coveredItemCodes) ||
    !isStringArray(row.aiWarnings) ||
    !Array.isArray(row.gaps) ||
    !row.gaps.every(
      (g) => g !== null && typeof g === 'object' && isString(g.itemCode) && isString(g.reason),
    ) ||
    !optionalTimestamp(row.aiGeneratedAt) ||
    !(
      row.aiConfidence === null ||
      (typeof row.aiConfidence === 'number' && row.aiConfidence >= 0 && row.aiConfidence <= 1)
    )
  ) {
    return false;
  }
  if (!aiRunOfOrg(db, row.organizationId, row.aiRunId)) return false;
  // 確定は本文があり、確定した人が編集権限を持つときだけ（AI では確定しない）
  if ((row.confirmedAt === null) !== (row.confirmedBy === null)) return false;
  if (row.confirmedAt !== null) {
    if (!isTimestamp(row.confirmedAt) || row.body.trim() === '') return false;
    if (!can(row.organizationId, row.confirmedBy, 'enterprise.disclosure.write')) return false;
    if (!actorIsWriter(next, row.confirmedBy)) return false;
  }
  return true;
}

/**
 * CSRD の収集項目（指標 × 拠点 × 期間の割当）。指標・拠点・期間は同じ組織のもので、
 * 同じ組み合わせの割当は 1 つだけ。作った人は指標の管理権限を持つ（collection-item.ts の呼び出し側と同じ）
 */
function acceptMetricAssignment(
  db: FixtureDb,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  const row = next as unknown as MetricAssignment;
  if (!periodOfOrg(db, row.organizationId, row.reportingPeriodId)) return false;
  if (!keysUnchanged(existing, next, ['reportingPeriodId', 'metricId', 'unitId'])) return false;
  if (!db.metrics.some((m) => m.id === row.metricId && m.organizationId === row.organizationId)) {
    return false;
  }
  if (!db.units.some((u) => u.id === row.unitId && u.organizationId === row.organizationId)) {
    return false;
  }
  if (
    !unique(
      db.metricAssignments,
      next,
      (r) =>
        r.metricId === row.metricId &&
        r.unitId === row.unitId &&
        r.reportingPeriodId === row.reportingPeriodId,
    )
  ) {
    return false;
  }
  if (!writerCan(next, can, 'enterprise.metric.manage')) return false;
  if (!isString(row.dueDate) || !/^\d{4}-\d{2}-\d{2}$/.test(row.dueDate)) return false;
  if (row.ownerUserId !== null && !activeMember(db, row.organizationId, row.ownerUserId)) {
    return false;
  }
  return row.reviewerUserId === null || activeMember(db, row.organizationId, row.reviewerUserId);
}

const CHECKS: Readonly<
  Record<
    string,
    (db: FixtureDb, existing: Row | undefined, next: Row, can: PermissionCheck) => boolean
  >
> = {
  csrdAnalysisSettings: acceptSettings,
  csrdDmaMatters: acceptMatter,
  csrdDmaIros: acceptIro,
  csrdAssessments: acceptAssessment,
  csrdActionPlans: acceptPlan,
  csrdDisclosureDrafts: acceptDraft,
  metricAssignments: acceptMetricAssignment,
};

/** この表の行を CSRD の規則で検査するか */
export function isCsrdCheckedTable(table: string): boolean {
  return table in CHECKS;
}

/**
 * Cookie から戻す CSRD の行（と割当）を検査する。受け付けるなら true。
 * 分析条件は、条件を満たさない DMA の確定を next から外して受け付けることがある
 */
export function acceptCsrdEdit(
  db: FixtureDb,
  table: string,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  const check = CHECKS[table];
  if (!check) return true;
  if (!isString(next.id) || !isString(next.organizationId)) return false;
  return check(db, existing, next, can);
}
