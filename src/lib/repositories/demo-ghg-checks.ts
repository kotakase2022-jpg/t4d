import {
  attribute,
  attributionLinesFrom,
  RECONCILIATION_CHECKER_VERSION,
} from '@/lib/domain/ghg/attribution';
import { GHG_ENGINE_VERSION, calculateRun } from '@/lib/domain/ghg/calculate';
import { inputsForRecordedRun, type GhgSourceRows } from '@/lib/domain/ghg/select-inputs';
import { GHG_FIXTURE_IDS } from '@/lib/fixtures/ghg-verification';
import type { FixtureDb } from '@/lib/fixtures/store';
import {
  BASELINE_GRANULARITIES,
  CARRIER_KINDS,
  EMISSION_BASES,
  FACTOR_ACTIVITY_KINDS,
  FACTOR_SET_ORIGINS,
  FACTOR_SET_STATUSES,
  FUEL_ECONOMY_CLASSES,
  GHG_ACTIVITY_KINDS,
  GHG_BATCH_KINDS,
  GHG_BATCH_SOURCES,
  GHG_BATCH_STATUSES,
  GHG_CAUSES,
  GHG_RULE_STATUSES,
  GHG_SCOPES,
  ROUNDING_METHODS,
  ROUNDING_STAGES,
  VEHICLE_USES,
  type GhgCalculationLine,
  type GhgCalculationRun,
  type GhgReconciliation,
  type PermissionKey,
} from '@/types/domain';
import type { TableName } from './types';

/**
 * Cookie から戻す Scope1・2 の算定と照合（0061〜0065）の行の検査（plan §2.7。demo-trial-checks.ts と同じ方針）。
 *
 * Fixture DB はインスタンスの全利用者で共有される。偽の Cookie で、別の組織の行・権限の無い人の名義の行・
 * 職務分離を通らない承認・有効にしたセットの係数の書き換え・大きすぎる行を全員の画面に出させない。
 * DB の RLS・CHECK・複合外部キー・ガードトリガと同じ規則を通す。追記専用の表は既にある行を書き換えない。
 *
 * 導出を優先し、Cookie へは小さい行だけを載せる（plan K11）:
 *  - 算定の記録は目録（要約を落とす）。戻すときに記録した入力（方針・バッチ・規則・セットの ID とその時点の割当）
 *    から同じ純関数で作り直し、入力ハッシュとエンジンの版を照合する。違えば要約を null（「入力が変わった」）にする
 *  - 算定行は持ち回さない（記録を戻したときに作り直してメモリに足す。ID は決定論）
 *  - 照合は目録（結果を落とす）。戻すときに作り直し、照合の規則の版を照合する
 * 上限はサービスの入力検査と同じ値（DEMO_GHG_LIMITS）を使う。
 */

/** Demo Mode の上限（サービスの入力検査もこの値を使う。plan §2.7） */
export const DEMO_GHG_LIMITS = {
  /** 利用者が作る係数のセット（Fixture の 2 つを除く） */
  userFactorSets: 2,
  /** 1 セットの係数の行 */
  factorsPerSet: 40,
  /**
   * 1 つの係数の params（改良トンキロ法の式・見なし積載率の原単位表）の JSON の文字数。
   * 公的参照プリセットの軽油の原単位表（告示 別表第3。約 2,300 字）が入る大きさ
   */
  factorParamsChars: 3000,
  /** 係数の割当（Fixture の行を含む全体） */
  assignments: 60,
  /** 算定方針の版（期間ごと） */
  policyVersions: 5,
  /** 算定方針の JSON（丸め・換算・改良トンキロ法の設定）の文字数 */
  policyJsonChars: 1000,
  /** 区分規則（Fixture の行を含む全体） */
  rules: 6,
  /** 区分規則の根拠・開示の注記の文字数 */
  ruleText: 300,
  /** 利用者が作る活動量のバッチ（Fixture のバッチを除く） */
  userBatches: 2,
  /** 1 バッチの行 */
  linesPerBatch: 60,
  /** 利用者が作る算定の記録 */
  userRuns: 5,
  /** 利用者が作る既存結果 */
  userBaselines: 2,
  /** 既存結果の行 */
  baselineRows: 80,
  /** 利用者が作る照合 */
  userReconciliations: 5,
  /** 原因の確認の記録 */
  notes: 20,
  /** 原因の確認の記録のコメントの文字数 */
  noteComment: 200,
} as const;

/** 持ち回す GHG の表（PERSISTED_TABLES に入れる）。算定行は持ち回さない（作り直す） */
export const GHG_PERSISTED_TABLES = [
  'emissionFactorSets',
  'emissionFactors',
  'emissionFactorAssignments',
  'ghgCalculationPolicies',
  'ghgClassificationRules',
  'ghgActivityBatches',
  'ghgActivityLines',
  'ghgCalculationRuns',
  'ghgBaselineResults',
  'ghgReconciliations',
  'ghgReconciliationNotes',
] as const satisfies readonly TableName[];

/** 追記専用（DB では forbid_mutation）。既にある行は Cookie から書き換えない */
export const GHG_APPEND_ONLY_TABLES = [
  'ghgCalculationPolicies',
  'ghgActivityLines',
  'ghgCalculationRuns',
  'ghgBaselineResults',
  'ghgReconciliations',
  'ghgReconciliationNotes',
] as const satisfies readonly TableName[];

/**
 * 戻す順番（demo-edit-codec.ts の DEFERRED_ORDER に足す。小さいほど先）:
 * セット → 係数 → 割当、方針・規則・バッチ → 行 → 算定の記録 → 既存結果 → 照合 → 確認の記録
 */
export const GHG_DEFERRED_ORDER: Readonly<Record<string, number>> = {
  emissionFactorSets: 5,
  ghgCalculationPolicies: 5,
  ghgClassificationRules: 5,
  ghgActivityBatches: 5,
  emissionFactors: 6,
  ghgActivityLines: 6,
  emissionFactorAssignments: 7,
  ghgCalculationRuns: 8,
  ghgBaselineResults: 8,
  ghgReconciliations: 9,
  ghgReconciliationNotes: 10,
};

export type PermissionCheck = (
  organizationId: unknown,
  userId: unknown,
  permission: PermissionKey,
) => boolean;

type Row = Record<string, unknown>;

const isString = (v: unknown): v is string => typeof v === 'string';
const isNonEmpty = (v: unknown): v is string => isString(v) && v.trim() !== '';
const within = (v: unknown, max: number) => isString(v) && v.length <= max;
const oneOf = (values: readonly string[], v: unknown) => isString(v) && values.includes(v);
const optionalOneOf = (values: readonly string[], v: unknown) => v === null || oneOf(values, v);
const isTimestamp = (v: unknown) => isString(v) && Number.isFinite(Date.parse(v));
const optionalTimestamp = (v: unknown) => v === null || isTimestamp(v);
const isDate = (v: unknown) => isString(v) && /^\d{4}-\d{2}-\d{2}$/.test(v);
const optionalDate = (v: unknown) => v === null || isDate(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const optionalNumber = (v: unknown) => v === null || isFiniteNumber(v);
const isPlainObject = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');
const smallJson = (v: unknown, max = 2000) => JSON.stringify(v ?? null).length <= max;
const isCountry = (v: unknown) => v === null || (isString(v) && /^[A-Z]{2}$/.test(v));
const isSha = (v: unknown) => isString(v) && /^[0-9a-f]{64}$/.test(v);

function keysUnchanged(existing: Row | undefined, next: Row, keys: readonly string[]): boolean {
  if (!existing) return true;
  return ['id', ...keys].every(
    (k) => JSON.stringify(existing[k] ?? null) === JSON.stringify(next[k] ?? null),
  );
}

function onlyChanged(existing: Row, next: Row, allowed: readonly string[]): boolean {
  const keys = new Set([...Object.keys(existing), ...Object.keys(next)]);
  for (const key of keys) {
    if (allowed.includes(key)) continue;
    if (JSON.stringify(existing[key] ?? null) !== JSON.stringify(next[key] ?? null)) return false;
  }
  return true;
}

function periodOf(db: FixtureDb, organizationId: unknown, periodId: unknown) {
  return db.periods.find((p) => p.id === periodId && p.organizationId === organizationId);
}

function unitOfOrg(db: FixtureDb, organizationId: unknown, unitId: unknown): boolean {
  return db.units.some((u) => u.id === unitId && u.organizationId === organizationId);
}

/** 利用者の担当拠点か（membership の unitScopeIds。空は全社） */
function unitInScope(
  db: FixtureDb,
  organizationId: unknown,
  userId: unknown,
  unitId: unknown,
): boolean {
  const memberships = db.memberships.filter(
    (m) => m.organizationId === organizationId && m.userId === userId && m.status === 'active',
  );
  return memberships.some(
    (m) => m.unitScopeIds.length === 0 || m.unitScopeIds.includes(unitId as string),
  );
}

const FIXTURE_SET_IDS = new Set<string>(Object.values(GHG_FIXTURE_IDS.sets));

/** Fixture の算定の記録・既存結果・照合・係数のセットの ID（Demo の上限は利用者が作った行だけを数える） */
export const GHG_FIXTURE_ROW_IDS: ReadonlySet<string> = new Set<string>([
  ...FIXTURE_SET_IDS,
  GHG_FIXTURE_IDS.run,
  GHG_FIXTURE_IDS.baseline,
  GHG_FIXTURE_IDS.reconciliation,
]);

// ----------------------------------------------------------------------
// 係数のセット・係数・割当（0061）
// ----------------------------------------------------------------------

const SET_STATE_COLUMNS = ['status', 'retiredBy', 'retiredAt', 'notes', 'updatedAt', 'updatedBy'];

function acceptFactorSet(
  db: FixtureDb,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  if (!keysUnchanged(existing, next, ['organizationId', 'createdAt', 'createdBy'])) return false;
  if (!db.organizations.some((o) => o.id === next.organizationId)) return false;
  const writer = next.updatedBy ?? next.createdBy;
  if (!can(next.organizationId, writer, 'enterprise.metric.manage')) return false;
  if (
    !isNonEmpty(next.code) ||
    !within(next.code, 40) ||
    !isNonEmpty(next.name) ||
    !within(next.name, 200)
  ) {
    return false;
  }
  if (!oneOf(FACTOR_SET_ORIGINS, next.origin) || !oneOf(FACTOR_SET_STATUSES, next.status))
    return false;
  if (!within(next.sourceLabel, 300) || !within(next.versionLabel, 100) || !within(next.notes, 300))
    return false;
  if (!optionalDate(next.publishedOn)) return false;
  if (
    next.referenceYear !== null &&
    !(
      Number.isInteger(next.referenceYear) &&
      (next.referenceYear as number) >= 1990 &&
      (next.referenceYear as number) <= 2100
    )
  ) {
    return false;
  }
  if ((next.activatedAt === null) !== (next.activatedBy === null)) return false;
  if ((next.retiredAt === null) !== (next.retiredBy === null)) return false;
  if (!optionalTimestamp(next.activatedAt) || !optionalTimestamp(next.retiredAt)) return false;
  const consistent =
    (next.status === 'draft' && next.activatedAt === null && next.retiredAt === null) ||
    (next.status === 'active' && next.activatedAt !== null && next.retiredAt === null) ||
    (next.status === 'retired' && next.activatedAt !== null && next.retiredAt !== null);
  if (!consistent) return false;
  if (
    next.activatedBy !== null &&
    !can(next.organizationId, next.activatedBy, 'enterprise.metric.manage')
  ) {
    return false;
  }
  if (
    next.retiredBy !== null &&
    !can(next.organizationId, next.retiredBy, 'enterprise.metric.manage')
  ) {
    return false;
  }
  if (existing) {
    if (existing.status === 'draft') {
      if (next.status === 'retired' && existing.activatedAt === null && next.activatedAt === null)
        return false;
    } else {
      // 有効にしたセットは、状態・取り下げの記録・メモ以外を変えない。取り下げたセットは戻さない
      if (!onlyChanged(existing, next, SET_STATE_COLUMNS)) return false;
      if (existing.status === 'retired' && next.status !== 'retired') return false;
      if (existing.status === 'active' && next.status === 'draft') return false;
    }
  }
  const sameCode = db.emissionFactorSets.some(
    (s) => s.id !== next.id && s.organizationId === next.organizationId && s.code === next.code,
  );
  if (sameCode) return false;
  if (!existing) {
    const userSets = db.emissionFactorSets.filter(
      (s) => s.organizationId === next.organizationId && !FIXTURE_SET_IDS.has(s.id),
    );
    if (userSets.length >= DEMO_GHG_LIMITS.userFactorSets) return false;
  }
  return true;
}

function acceptFactor(
  db: FixtureDb,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  // Cookie から戻すのはセットに属する係数だけ（Cat.1 の係数はアプリから書かない）
  if (!keysUnchanged(existing, next, ['organizationId', 'factorSetId', 'createdAt'])) return false;
  const set = db.emissionFactorSets.find((s) => s.id === next.factorSetId);
  if (!set || set.organizationId !== next.organizationId) return false;
  if (!can(set.organizationId, set.updatedBy ?? set.createdBy, 'enterprise.metric.manage'))
    return false;
  // セットが下書きのときだけ。Cookie はセットの最後の状態だけを持つため、有効にしたセットでは
  // 有効にする前に作った係数（作成日時が有効化より前）だけを受け付ける
  if (set.status !== 'draft') {
    if (existing) return false;
    if (
      !isTimestamp(next.createdAt) ||
      !set.activatedAt ||
      (next.createdAt as string) > set.activatedAt
    ) {
      return false;
    }
  }
  if (
    !isNonEmpty(next.code) ||
    !within(next.code, 80) ||
    !isNonEmpty(next.name) ||
    !within(next.name, 200)
  ) {
    return false;
  }
  if (!within(next.category, 60) || !within(next.factorUnit, 30) || !within(next.activityUnit, 20))
    return false;
  if (!within(next.factorSource, 300)) return false;
  if (!isFiniteNumber(next.factorValue) || !Number.isInteger(next.factorYear)) return false;
  if (
    !oneOf(FACTOR_ACTIVITY_KINDS, next.activityKind) ||
    !isNonEmpty(next.activityCode) ||
    !within(next.activityCode, 60)
  ) {
    return false;
  }
  if (!optionalOneOf(EMISSION_BASES, next.basis) || !isCountry(next.countryCode)) return false;
  if (next.regionLabel !== null && !within(next.regionLabel, 100)) return false;
  if (!oneOf(['co2e', 'co2'], next.gas)) return false;
  if (!optionalNumber(next.calorificValue) || !optionalNumber(next.carbonFactor)) return false;
  if ((next.calorificValue === null) !== (next.carbonFactor === null)) return false;
  if (!optionalDate(next.validFrom) || !optionalDate(next.validTo)) return false;
  if (!isPlainObject(next.params) || !smallJson(next.params, DEMO_GHG_LIMITS.factorParamsChars)) {
    return false;
  }
  const siblings = db.emissionFactors.filter(
    (f) => f.factorSetId === next.factorSetId && f.id !== next.id,
  );
  if (!existing && siblings.length >= DEMO_GHG_LIMITS.factorsPerSet) return false;
  return !siblings.some((f) => f.code === next.code && f.factorYear === next.factorYear);
}

function acceptAssignment(
  db: FixtureDb,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  if (
    !keysUnchanged(existing, next, [
      'organizationId',
      'reportingPeriodId',
      'createdAt',
      'createdBy',
    ])
  )
    return false;
  const writer = next.updatedBy ?? next.createdBy;
  if (!can(next.organizationId, writer, 'enterprise.metric.manage')) return false;
  const period = periodOf(db, next.organizationId, next.reportingPeriodId);
  if (!period || period.status === 'closed') return false;
  if (next.unitId !== null && !unitOfOrg(db, next.organizationId, next.unitId)) return false;
  if (!isCountry(next.countryCode)) return false;
  if (next.unitId !== null && next.countryCode !== null) return false;
  if (
    !oneOf(FACTOR_ACTIVITY_KINDS, next.activityKind) ||
    !isNonEmpty(next.activityCode) ||
    !within(next.activityCode, 60)
  ) {
    return false;
  }
  if (!optionalOneOf(EMISSION_BASES, next.basis) || !within(next.reason, 300)) return false;
  const factor = db.emissionFactors.find((f) => f.id === next.factorId);
  if (!factor || factor.organizationId !== next.organizationId || !factor.factorSetId) return false;
  const set = db.emissionFactorSets.find((s) => s.id === factor.factorSetId);
  // 割当てたときに有効だったセット（後で取り下げても、既にある割当は残る）
  if (!set || set.status === 'draft' || factor.activityKind !== next.activityKind) return false;
  const duplicate = db.emissionFactorAssignments.some(
    (a) =>
      a.id !== next.id &&
      a.organizationId === next.organizationId &&
      a.reportingPeriodId === next.reportingPeriodId &&
      (a.unitId ?? null) === (next.unitId ?? null) &&
      (a.countryCode ?? null) === (next.countryCode ?? null) &&
      a.activityKind === next.activityKind &&
      a.activityCode === next.activityCode &&
      (a.basis ?? null) === (next.basis ?? null),
  );
  if (duplicate) return false;
  if (!existing) {
    const count = db.emissionFactorAssignments.filter(
      (a) => a.organizationId === next.organizationId,
    ).length;
    if (count >= DEMO_GHG_LIMITS.assignments) return false;
  }
  return true;
}

// ----------------------------------------------------------------------
// 算定方針・区分規則（0062）
// ----------------------------------------------------------------------

function roundingRulesOk(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.length <= ROUNDING_STAGES.length &&
    v.every(
      (r) =>
        isPlainObject(r) &&
        oneOf(ROUNDING_STAGES, r.stage) &&
        Number.isInteger(r.digits) &&
        Math.abs(r.digits as number) <= 12 &&
        oneOf(['kg', 't'], r.unit) &&
        oneOf(ROUNDING_METHODS, r.method),
    ) &&
    new Set(v.map((r) => (r as Row).stage)).size === v.length
  );
}

function conversionsOk(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.length <= 20 &&
    v.every(
      (c) =>
        isPlainObject(c) &&
        isNonEmpty(c.from) &&
        isNonEmpty(c.to) &&
        isFiniteNumber(c.multiplier) &&
        (c.multiplier as number) > 0 &&
        within(c.source, 100),
    )
  );
}

function tonkmOk(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  const range = v.payloadRangeKg;
  const rounding = v.intensityRounding;
  return (
    oneOf(['kokuji', 'log'], v.shape) &&
    isFiniteNumber(v.minLoadPct) &&
    (v.minLoadPct as number) >= 0 &&
    (v.minLoadPct as number) <= 100 &&
    oneOf(['error', 'cap'], v.over100) &&
    isPlainObject(range) &&
    optionalNumber(range.min) &&
    optionalNumber(range.max) &&
    oneOf(['warn', 'error'], v.payloadOutOfRange) &&
    oneOf(['warn', 'block'], v.overseas) &&
    (rounding === null ||
      (isPlainObject(rounding) &&
        Number.isInteger(rounding.significant) &&
        (rounding.significant as number) >= 1 &&
        (rounding.significant as number) <= 10 &&
        oneOf(ROUNDING_METHODS, rounding.method)))
  );
}

function acceptPolicy(
  db: FixtureDb,
  _existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  if (!can(next.organizationId, next.createdBy, 'enterprise.metric.manage')) return false;
  if (!periodOf(db, next.organizationId, next.reportingPeriodId)) return false;
  if (!Number.isInteger(next.versionNo) || (next.versionNo as number) < 1) return false;
  const versions = db.ghgCalculationPolicies.filter(
    (p) =>
      p.organizationId === next.organizationId && p.reportingPeriodId === next.reportingPeriodId,
  );
  if (versions.some((p) => p.versionNo >= (next.versionNo as number))) return false;
  if (versions.length >= DEMO_GHG_LIMITS.policyVersions) return false;
  if (!roundingRulesOk(next.rounding) || !conversionsOk(next.conversions) || !tonkmOk(next.tonkm))
    return false;
  if (
    JSON.stringify([next.rounding, next.conversions, next.tonkm]).length >
    DEMO_GHG_LIMITS.policyJsonChars
  ) {
    return false;
  }
  return within(next.notes, 300) && isTimestamp(next.createdAt);
}

const RULE_CONTENT = [
  'organizationId',
  'code',
  'name',
  'match',
  'protocolScope',
  'reportedScope',
  'rationale',
  'disclosureNote',
  'effectiveFromPeriodId',
  'effectiveToPeriodId',
  'proposedBy',
  'createdAt',
];

function matchOk(v: unknown): boolean {
  if (!isPlainObject(v) || !smallJson(v, 1000)) return false;
  const lists: Array<[string, readonly string[] | null]> = [
    ['activityKinds', GHG_ACTIVITY_KINDS],
    ['carrierKinds', CARRIER_KINDS],
    ['cargoKinds', null],
    ['unitIds', null],
  ];
  for (const [key, allowed] of lists) {
    const list = v[key];
    if (list === undefined) continue;
    if (!isStringArray(list) || list.length > 50) return false;
    if (allowed && !list.every((x) => allowed.includes(x))) return false;
  }
  return Object.keys(v).every((k) => lists.some(([key]) => key === k));
}

function acceptRule(
  db: FixtureDb,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  if (!keysUnchanged(existing, next, RULE_CONTENT)) return false;
  if (!can(next.organizationId, next.proposedBy, 'enterprise.metric.manage')) return false;
  if (
    !isNonEmpty(next.code) ||
    !within(next.code, 40) ||
    !isNonEmpty(next.name) ||
    !within(next.name, 200)
  ) {
    return false;
  }
  if (!matchOk(next.match)) return false;
  if (!oneOf(GHG_SCOPES, next.protocolScope) || !oneOf(GHG_SCOPES, next.reportedScope))
    return false;
  if (next.protocolScope === next.reportedScope) return false;
  if (!isNonEmpty(next.rationale) || !within(next.rationale, DEMO_GHG_LIMITS.ruleText))
    return false;
  if (!within(next.disclosureNote, DEMO_GHG_LIMITS.ruleText)) return false;
  for (const key of ['effectiveFromPeriodId', 'effectiveToPeriodId']) {
    if (next[key] !== null && !periodOf(db, next.organizationId, next[key])) return false;
  }
  if (!oneOf(GHG_RULE_STATUSES, next.status)) return false;
  if ((next.approvedBy === null) !== (next.approvedAt === null)) return false;
  if ((next.withdrawnBy === null) !== (next.withdrawnAt === null)) return false;
  if (!optionalTimestamp(next.approvedAt) || !optionalTimestamp(next.withdrawnAt)) return false;
  const consistent =
    (next.status === 'proposed' && next.approvedBy === null && next.withdrawnBy === null) ||
    (next.status === 'approved' && next.approvedBy !== null && next.withdrawnBy === null) ||
    (next.status === 'withdrawn' && next.withdrawnBy !== null);
  if (!consistent) return false;
  // 職務分離: 提案者は承認者になれない。承認者は承認の権限、取り下げた人は方針か承認の権限を持つ
  if (next.approvedBy !== null) {
    if (next.approvedBy === next.proposedBy) return false;
    if (!can(next.organizationId, next.approvedBy, 'enterprise.data.approve')) return false;
  }
  if (
    next.withdrawnBy !== null &&
    !can(next.organizationId, next.withdrawnBy, 'enterprise.metric.manage') &&
    !can(next.organizationId, next.withdrawnBy, 'enterprise.data.approve')
  ) {
    return false;
  }
  if (existing) {
    if (existing.status === 'withdrawn' && next.status !== 'withdrawn') return false;
    if (existing.status === 'approved' && next.status === 'proposed') return false;
    if (existing.approvedBy !== null && existing.approvedBy !== next.approvedBy) return false;
  } else {
    const count = db.ghgClassificationRules.filter(
      (r) => r.organizationId === next.organizationId,
    ).length;
    if (count >= DEMO_GHG_LIMITS.rules) return false;
  }
  if (next.status !== 'withdrawn') {
    const sameCode = db.ghgClassificationRules.some(
      (r) =>
        r.id !== next.id &&
        r.organizationId === next.organizationId &&
        r.code === next.code &&
        r.status !== 'withdrawn',
    );
    if (sameCode) return false;
  }
  return true;
}

// ----------------------------------------------------------------------
// 活動量（0063）
// ----------------------------------------------------------------------

const BATCH_FIXED = [
  'organizationId',
  'reportingPeriodId',
  'unitId',
  'kind',
  'source',
  'fileName',
  'fileSha256',
  'rowCount',
  'supersedesBatchId',
  'createdAt',
  'createdBy',
];

function acceptBatch(
  db: FixtureDb,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  if (!keysUnchanged(existing, next, BATCH_FIXED)) return false;
  if (!periodOf(db, next.organizationId, next.reportingPeriodId)) return false;
  if (!unitOfOrg(db, next.organizationId, next.unitId)) return false;
  // 取込（作成）は取込とデータ入力の権限を持つ担当拠点の利用者
  if (
    !can(next.organizationId, next.createdBy, 'enterprise.import.run') ||
    !can(next.organizationId, next.createdBy, 'enterprise.data.write') ||
    !unitInScope(db, next.organizationId, next.createdBy, next.unitId)
  ) {
    return false;
  }
  if (!oneOf(GHG_BATCH_KINDS, next.kind) || !oneOf(GHG_BATCH_SOURCES, next.source)) return false;
  if (!oneOf(GHG_BATCH_STATUSES, next.status)) return false;
  if (!within(next.fileName, 255) || !(next.fileSha256 === null || isSha(next.fileSha256)))
    return false;
  if (
    !Number.isInteger(next.rowCount) ||
    (next.rowCount as number) < 0 ||
    (next.rowCount as number) > DEMO_GHG_LIMITS.linesPerBatch
  ) {
    return false;
  }
  if ((next.confirmedBy === null) !== (next.confirmedAt === null)) return false;
  if (!optionalTimestamp(next.confirmedAt)) return false;
  if ((next.status === 'confirmed' || next.status === 'superseded') && next.confirmedAt === null)
    return false;
  if (next.status === 'discarded' && next.confirmedAt !== null) return false;
  if (next.confirmedBy !== null) {
    if (!can(next.organizationId, next.confirmedBy, 'enterprise.data.write')) return false;
    if (!unitInScope(db, next.organizationId, next.confirmedBy, next.unitId)) return false;
  }
  if (next.supersedesBatchId !== null) {
    const previous = db.ghgActivityBatches.find((b) => b.id === next.supersedesBatchId);
    if (
      !previous ||
      previous.organizationId !== next.organizationId ||
      previous.unitId !== next.unitId ||
      previous.reportingPeriodId !== next.reportingPeriodId ||
      previous.kind !== next.kind
    ) {
      return false;
    }
  }
  if (existing) {
    const allowed: Record<string, readonly string[]> = {
      draft: ['draft', 'confirmed', 'discarded'],
      confirmed: ['confirmed', 'superseded'],
      superseded: ['superseded'],
      discarded: ['discarded'],
    };
    if (!allowed[existing.status as string]?.includes(next.status as string)) return false;
    // 差し替え済みにできるのは、差し替える確定済みのバッチがあるときだけ
    if (existing.status === 'confirmed' && next.status === 'superseded') {
      const successor = db.ghgActivityBatches.some(
        (b) => b.supersedesBatchId === next.id && b.status === 'confirmed',
      );
      if (!successor) return false;
    }
  } else {
    const userBatches = db.ghgActivityBatches.filter(
      (b) => b.organizationId === next.organizationId && b.source !== 'fixture',
    );
    if (userBatches.length >= DEMO_GHG_LIMITS.userBatches) return false;
    if (next.source === 'fixture') return false;
  }
  return true;
}

function acceptActivityLine(db: FixtureDb, _existing: Row | undefined, next: Row): boolean {
  const batch = db.ghgActivityBatches.find((b) => b.id === next.batchId);
  if (!batch || batch.organizationId !== next.organizationId) return false;
  // 行は下書きのバッチにだけ足す。Cookie はバッチの最後の状態だけを持つため、確定・破棄したバッチでは
  // 確定・破棄より前に作った行だけを受け付ける
  if (batch.status !== 'draft') {
    const closedAt = batch.confirmedAt ?? batch.updatedAt;
    if (!isTimestamp(next.createdAt) || (next.createdAt as string) > closedAt) return false;
  }
  const siblings = db.ghgActivityLines.filter((l) => l.batchId === next.batchId);
  if (siblings.length >= DEMO_GHG_LIMITS.linesPerBatch) return false;
  if (!Number.isInteger(next.lineNo) || (next.lineNo as number) < 1) return false;
  if (siblings.some((l) => l.lineNo === next.lineNo)) return false;
  if (!isString(next.month) || !/^\d{4}-\d{2}-01$/.test(next.month)) return false;
  if (
    !oneOf(GHG_ACTIVITY_KINDS, next.activityKind) ||
    !isNonEmpty(next.activityCode) ||
    !within(next.activityCode, 60)
  ) {
    return false;
  }
  for (const key of [
    'amount',
    'cargoWeightT',
    'distanceKm',
    'tonKm',
    'maxPayloadKg',
    'loadFactorPct',
  ]) {
    const v = next[key];
    if (v !== null && !(isFiniteNumber(v) && v >= 0)) return false;
  }
  for (const [key, max] of [
    ['unit', 20],
    ['contractCode', 40],
    ['shipmentRef', 60],
    ['fuelCode', 40],
    ['cargoKind', 40],
  ] as const) {
    if (next[key] !== null && !within(next[key], max)) return false;
  }
  if (
    !optionalOneOf(VEHICLE_USES, next.vehicleUse) ||
    !optionalOneOf(FUEL_ECONOMY_CLASSES, next.fuelEconomyClass)
  ) {
    return false;
  }
  if (!optionalOneOf(CARRIER_KINDS, next.carrierKind)) return false;
  if (
    !isPlainObject(next.attributes) ||
    !smallJson(next.attributes, 300) ||
    !within(next.note, 300)
  )
    return false;
  const hasAmount = next.amount !== null && isNonEmpty(next.unit);
  if (next.activityKind === 'transport') {
    const hasTonKm =
      next.tonKm !== null || (next.cargoWeightT !== null && next.distanceKm !== null);
    if (!hasTonKm && !hasAmount) return false;
  } else if (!hasAmount) {
    return false;
  }
  return isTimestamp(next.createdAt);
}

// ----------------------------------------------------------------------
// 算定の記録・既存結果・照合・確認の記録（0064・0065）
// ----------------------------------------------------------------------

function userRowsOf<T extends { organizationId: string; id: string }>(
  rows: readonly T[],
  organizationId: unknown,
  fixtureIds: ReadonlySet<string>,
) {
  return rows.filter((r) => r.organizationId === organizationId && !fixtureIds.has(r.id));
}

function acceptRun(
  db: FixtureDb,
  _existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  if (!can(next.organizationId, next.createdBy, 'enterprise.data.write')) return false;
  if (!periodOf(db, next.organizationId, next.reportingPeriodId)) return false;
  if (!isStringArray(next.unitIds) || next.unitIds.length === 0 || next.unitIds.length > 100)
    return false;
  if (
    !next.unitIds.every(
      (u) =>
        unitOfOrg(db, next.organizationId, u) &&
        unitInScope(db, next.organizationId, next.createdBy, u),
    )
  ) {
    return false;
  }
  const policy = db.ghgCalculationPolicies.find((p) => p.id === next.policyId);
  if (!policy || policy.organizationId !== next.organizationId) return false;
  if (!isSha(next.inputHash) || !within(next.engineVersion, 60)) return false;
  if (!Number.isInteger(next.lineCount) || (next.lineCount as number) < 0) return false;
  if (!isTimestamp(next.createdAt)) return false;
  const fixtureIds = new Set<string>([GHG_FIXTURE_IDS.run]);
  return (
    userRowsOf(db.ghgCalculationRuns, next.organizationId, fixtureIds).length <
    DEMO_GHG_LIMITS.userRuns
  );
}

function baselineRowOk(r: unknown): boolean {
  if (!isPlainObject(r)) return false;
  return (
    Number.isInteger(r.rowNo) &&
    within(r.siteCode, 40) &&
    (r.unitId === null || isString(r.unitId)) &&
    oneOf(GHG_SCOPES, r.scope) &&
    optionalOneOf(GHG_ACTIVITY_KINDS, r.activityKind) &&
    (r.activityCode === null || within(r.activityCode, 60)) &&
    (r.month === null || (isString(r.month) && /^\d{4}-\d{2}-01$/.test(r.month))) &&
    (r.shipmentRef === null || within(r.shipmentRef, 60)) &&
    optionalNumber(r.activityAmount) &&
    optionalNumber(r.convertedAmount) &&
    optionalNumber(r.factorValue) &&
    (r.factorYear === null || Number.isInteger(r.factorYear)) &&
    (r.activityUnit === null || within(r.activityUnit, 20)) &&
    (r.convertedUnit === null || within(r.convertedUnit, 20)) &&
    (r.factorUnit === null || within(r.factorUnit, 30)) &&
    (r.method === null || within(r.method, 40)) &&
    isFiniteNumber(r.emissions) &&
    within(r.emissionsUnit, 20) &&
    within(r.roundingNote, 100) &&
    (r.rounding === null ||
      (isPlainObject(r.rounding) &&
        oneOf(ROUNDING_STAGES, r.rounding.stage) &&
        oneOf(['kg', 't'], r.rounding.unit) &&
        Number.isInteger(r.rounding.digits) &&
        oneOf(ROUNDING_METHODS, r.rounding.method)))
  );
}

function acceptBaseline(
  db: FixtureDb,
  _existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  if (
    !can(next.organizationId, next.createdBy, 'enterprise.data.write') ||
    !can(next.organizationId, next.createdBy, 'enterprise.import.run')
  ) {
    return false;
  }
  if (!periodOf(db, next.organizationId, next.reportingPeriodId)) return false;
  if (!isNonEmpty(next.label) || !within(next.label, 100) || !within(next.fileName, 255))
    return false;
  if (!isSha(next.fileSha256) || !oneOf(BASELINE_GRANULARITIES, next.granularity)) return false;
  if (!Array.isArray(next.rows) || next.rows.length > DEMO_GHG_LIMITS.baselineRows) return false;
  if (next.rowCount !== next.rows.length || !next.rows.every(baselineRowOk)) return false;
  if (!isPlainObject(next.unitMapping)) return false;
  for (const unitId of Object.values(next.unitMapping)) {
    if (!unitOfOrg(db, next.organizationId, unitId)) return false;
  }
  if (
    !(next.rows as Row[]).every(
      (r) => r.unitId === null || unitOfOrg(db, next.organizationId, r.unitId),
    )
  ) {
    return false;
  }
  if (next.supersedesId !== null) {
    const previous = db.ghgBaselineResults.find((b) => b.id === next.supersedesId);
    if (!previous || previous.organizationId !== next.organizationId) return false;
  }
  if (!isTimestamp(next.createdAt)) return false;
  const fixtureIds = new Set<string>([GHG_FIXTURE_IDS.baseline]);
  return (
    userRowsOf(db.ghgBaselineResults, next.organizationId, fixtureIds).length <
    DEMO_GHG_LIMITS.userBaselines
  );
}

function toleranceOk(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  return Object.entries(v).every(
    ([scope, t]) =>
      oneOf(GHG_SCOPES, scope) &&
      isPlainObject(t) &&
      optionalNumber(t.absoluteT) &&
      optionalNumber(t.relativePct) &&
      ((t.absoluteT as number | null) ?? 0) >= 0 &&
      ((t.relativePct as number | null) ?? 0) >= 0,
  );
}

function acceptReconciliation(
  db: FixtureDb,
  _existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  if (!can(next.organizationId, next.createdBy, 'enterprise.data.write')) return false;
  const run = db.ghgCalculationRuns.find((r) => r.id === next.runId);
  const baseline = db.ghgBaselineResults.find((b) => b.id === next.baselineId);
  if (!run || !baseline) return false;
  if (run.organizationId !== next.organizationId || baseline.organizationId !== next.organizationId)
    return false;
  if (run.reportingPeriodId !== baseline.reportingPeriodId) return false;
  if (!toleranceOk(next.tolerance)) return false;
  if (
    !isStringArray(next.attributionOrder) ||
    !next.attributionOrder.every((c) => oneOf(GHG_CAUSES, c) && c !== 'other') ||
    new Set(next.attributionOrder).size !== next.attributionOrder.length
  ) {
    return false;
  }
  if (!within(next.checkerVersion, 60) || !isTimestamp(next.createdAt)) return false;
  const fixtureIds = new Set<string>([GHG_FIXTURE_IDS.reconciliation]);
  return (
    userRowsOf(db.ghgReconciliations, next.organizationId, fixtureIds).length <
    DEMO_GHG_LIMITS.userReconciliations
  );
}

function acceptNote(
  db: FixtureDb,
  _existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  const recon = db.ghgReconciliations.find((r) => r.id === next.reconciliationId);
  if (!recon || recon.organizationId !== next.organizationId) return false;
  if (!can(next.organizationId, next.decidedBy, 'enterprise.data.review')) return false;
  if (!isNonEmpty(next.itemKey) || !within(next.itemKey, 300)) return false;
  if (!oneOf(GHG_CAUSES, next.confirmedCause)) return false;
  if (!within(next.comment, DEMO_GHG_LIMITS.noteComment)) return false;
  if (next.confirmedCause === 'other' && !isNonEmpty(next.comment)) return false;
  if (!isTimestamp(next.decidedAt)) return false;
  if (next.supersedesId !== null) {
    const previous = db.ghgReconciliationNotes.find((n) => n.id === next.supersedesId);
    if (
      !previous ||
      previous.reconciliationId !== next.reconciliationId ||
      previous.itemKey !== next.itemKey
    ) {
      return false;
    }
  }
  return (
    db.ghgReconciliationNotes.filter((n) => n.organizationId === next.organizationId).length <
    DEMO_GHG_LIMITS.notes
  );
}

// ----------------------------------------------------------------------
// 作り直し（demo-compact.ts から呼ぶ）
// ----------------------------------------------------------------------

/** FixtureDb から算定の入力の元（組織・期間ごと） */
export function ghgSourceRowsFromDb(
  db: FixtureDb,
  organizationId: string,
  periodId: string,
): GhgSourceRows | null {
  const organization = db.organizations.find((o) => o.id === organizationId);
  const period = db.periods.find((p) => p.id === periodId && p.organizationId === organizationId);
  if (!organization || !period) return null;
  return {
    organization: { id: organization.id, countryCode: organization.countryCode },
    period,
    periods: db.periods.filter((p) => p.organizationId === organizationId),
    units: db.units.filter((u) => u.organizationId === organizationId),
    policies: db.ghgCalculationPolicies.filter((p) => p.organizationId === organizationId),
    sets: db.emissionFactorSets.filter((s) => s.organizationId === organizationId),
    factors: db.emissionFactors.filter((f) => f.organizationId === organizationId),
    assignments: db.emissionFactorAssignments.filter((a) => a.organizationId === organizationId),
    rules: db.ghgClassificationRules.filter((r) => r.organizationId === organizationId),
    batches: db.ghgActivityBatches.filter((b) => b.organizationId === organizationId),
    lines: db.ghgActivityLines.filter((l) => l.organizationId === organizationId),
  };
}

/**
 * 記録した算定を作り直す（要約と算定行）。入力ハッシュ・エンジンの版が記録と違えば null
 * （「入力が変わった」。数値を出さない）
 */
export function rebuildRun(
  db: FixtureDb,
  run: Pick<
    GhgCalculationRun,
    | 'id'
    | 'organizationId'
    | 'reportingPeriodId'
    | 'unitIds'
    | 'policyId'
    | 'factorSetIds'
    | 'ruleIds'
    | 'activityBatchIds'
    | 'inputHash'
    | 'engineVersion'
    | 'createdAt'
    | 'lineCount'
  >,
): { summary: NonNullable<GhgCalculationRun['summary']>; lines: GhgCalculationLine[] } | null {
  if (run.engineVersion !== GHG_ENGINE_VERSION) return null;
  const source = ghgSourceRowsFromDb(db, run.organizationId, run.reportingPeriodId);
  if (!source) return null;
  const inputs = inputsForRecordedRun(source, run);
  if (!inputs) return null;
  const out = calculateRun(inputs, { runId: run.id, createdAt: run.createdAt });
  if (
    out.inputHash !== run.inputHash ||
    out.errors.length > 0 ||
    out.lines.length !== run.lineCount
  ) {
    return null;
  }
  return { summary: out.summary, lines: out.lines };
}

/** 記録した照合の結果を作り直す（照合の規則の版が違う・算定の記録が作り直せないなら null） */
export function rebuildReconciliation(
  db: FixtureDb,
  recon: Pick<
    GhgReconciliation,
    'runId' | 'baselineId' | 'tolerance' | 'attributionOrder' | 'checkerVersion'
  >,
): GhgReconciliation['result'] {
  if (recon.checkerVersion !== RECONCILIATION_CHECKER_VERSION) return null;
  const run = db.ghgCalculationRuns.find((r) => r.id === recon.runId);
  const baseline = db.ghgBaselineResults.find((b) => b.id === recon.baselineId);
  if (!run || !run.summary || !baseline) return null;
  const policy = db.ghgCalculationPolicies.find((p) => p.id === run.policyId);
  if (!policy) return null;
  const lines = db.ghgCalculationLines.filter((l) => l.runId === run.id);
  if (lines.length !== run.lineCount) return null;
  const shipmentOf = new Map(db.ghgActivityLines.map((l) => [l.id, l.shipmentRef]));
  return attribute(
    attributionLinesFrom(lines, (id) => shipmentOf.get(id) ?? null),
    baseline.rows,
    { t4dRounding: policy.rounding, tolerance: recon.tolerance, order: recon.attributionOrder },
  );
}

// ----------------------------------------------------------------------
// 入口
// ----------------------------------------------------------------------

type Check = (db: FixtureDb, existing: Row | undefined, next: Row, can: PermissionCheck) => boolean;

const CHECKS: Readonly<Record<string, Check>> = {
  emissionFactorSets: acceptFactorSet,
  emissionFactors: acceptFactor,
  emissionFactorAssignments: acceptAssignment,
  ghgCalculationPolicies: acceptPolicy,
  ghgClassificationRules: acceptRule,
  ghgActivityBatches: acceptBatch,
  ghgActivityLines: (db, existing, next) => acceptActivityLine(db, existing, next),
  ghgCalculationRuns: acceptRun,
  ghgBaselineResults: acceptBaseline,
  ghgReconciliations: acceptReconciliation,
  ghgReconciliationNotes: acceptNote,
};

export function isGhgCheckedTable(table: string): boolean {
  return table in CHECKS;
}

/** Cookie から戻す GHG の行を検査する。受け付けるなら true */
export function acceptGhgEdit(
  db: FixtureDb,
  table: string,
  existing: Row | undefined,
  next: Row,
  can: PermissionCheck,
): boolean {
  if (!isString(next.id) || !isString(next.organizationId)) return false;
  const check = CHECKS[table];
  return check ? check(db, existing, next, can) : true;
}

/**
 * 戻した算定の記録の算定行をメモリへ足す（持ち回さない表。demo-edit-codec.ts が記録を戻した直後に呼ぶ）。
 * 要約が作り直せなかった記録（入力が変わった）は行を足さない
 */
export function restoreRunLines(db: FixtureDb, run: GhgCalculationRun): void {
  if (!run.summary) return;
  if (db.ghgCalculationLines.some((l) => l.runId === run.id)) return;
  const rebuilt = rebuildRun(db, run);
  if (rebuilt) db.ghgCalculationLines.push(...rebuilt.lines);
}
