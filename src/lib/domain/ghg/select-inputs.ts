import type { GhgCalculationInputs } from './calculate';
import type {
  EmissionFactor,
  EmissionFactorAssignment,
  EmissionFactorSet,
  GhgActivityBatch,
  GhgActivityLine,
  GhgCalculationPolicy,
  GhgCalculationRun,
  GhgClassificationRule,
  OrganizationUnit,
  ReportingPeriod,
} from '@/types/domain';

/**
 * 算定の入力を選ぶ（純関数）。サービス（src/lib/services/ghg/inputs.ts）・Fixture・Demo Mode の作り直しが
 * 同じ規則で選ぶ（入力ハッシュが同じ規則で決まるように）。
 *  - 方針: 期間の最新の版
 *  - 活動量: 期間・拠点の確定済みのバッチ（差し替え済み・破棄・下書きは使わない）と、その行
 *  - 係数・セット・割当・区分規則: 組織の全部（効くかどうかは算定のエンジンが決める）
 */

export interface GhgSourceRows {
  organization: { id: string; countryCode: string };
  period: ReportingPeriod;
  periods: readonly ReportingPeriod[];
  units: readonly OrganizationUnit[];
  policies: readonly GhgCalculationPolicy[];
  sets: readonly EmissionFactorSet[];
  factors: readonly EmissionFactor[];
  assignments: readonly EmissionFactorAssignment[];
  rules: readonly GhgClassificationRule[];
  batches: readonly GhgActivityBatch[];
  lines: readonly GhgActivityLine[];
}

export function latestPolicy(
  policies: readonly GhgCalculationPolicy[],
  periodId: string,
): GhgCalculationPolicy | null {
  return (
    policies
      .filter((p) => p.reportingPeriodId === periodId)
      .sort((a, b) => b.versionNo - a.versionNo)[0] ?? null
  );
}

function baseInputs(
  source: GhgSourceRows,
  unitIds: readonly string[],
  policy: GhgCalculationPolicy,
  batches: readonly GhgActivityBatch[],
  rules: readonly GhgClassificationRule[],
  sets: readonly EmissionFactorSet[],
): GhgCalculationInputs {
  const batchIds = new Set(batches.map((b) => b.id));
  return {
    organizationId: source.organization.id,
    organizationCountryCode: source.organization.countryCode,
    period: source.period,
    periods: source.periods,
    units: source.units.filter((u) => u.organizationId === source.organization.id),
    unitIds: [...unitIds],
    policy,
    factorSets: sets,
    factors: source.factors.filter((f) => f.organizationId === source.organization.id),
    assignments: source.assignments.filter((a) => a.organizationId === source.organization.id),
    rules,
    batches,
    lines: source.lines.filter((l) => batchIds.has(l.batchId)),
  };
}

/** いまの入力（算定の実行・入力ハッシュの比較に使う）。方針が無ければ null */
export function selectCalculationInputs(
  source: GhgSourceRows,
  unitIds: readonly string[],
): GhgCalculationInputs | null {
  const policy = latestPolicy(source.policies, source.period.id);
  if (!policy) return null;
  const units = new Set(unitIds);
  const batches = source.batches.filter(
    (b) =>
      b.organizationId === source.organization.id &&
      b.reportingPeriodId === source.period.id &&
      units.has(b.unitId) &&
      b.status === 'confirmed',
  );
  return baseInputs(
    source,
    unitIds,
    policy,
    batches,
    source.rules.filter((r) => r.organizationId === source.organization.id),
    source.sets.filter((s) => s.organizationId === source.organization.id),
  );
}

/**
 * 記録した算定の入力（Demo Mode で Cookie から戻した記録を作り直すときに使う）。方針・活動量のバッチ・
 * 区分規則・係数のセットは記録した ID で選ぶ（後から差し替え・取り下げられても、その記録の時点の入力として扱う）。
 * 割当だけはいまの行（記録が ID を持たない）。いまの割当が記録の時点と違えば、入力ハッシュが合わず
 * 「入力が変わった」になる。記録の方針・バッチが見つからなければ null
 */
export function inputsForRecordedRun(
  source: GhgSourceRows,
  run: Pick<
    GhgCalculationRun,
    'unitIds' | 'policyId' | 'factorSetIds' | 'ruleIds' | 'activityBatchIds' | 'reportingPeriodId'
  >,
): GhgCalculationInputs | null {
  const policy = source.policies.find((p) => p.id === run.policyId);
  if (!policy || run.reportingPeriodId !== source.period.id) return null;
  const batches = run.activityBatchIds.map((id) => source.batches.find((b) => b.id === id));
  if (batches.some((b) => !b)) return null;
  const rules = run.ruleIds.map((id) => source.rules.find((r) => r.id === id));
  if (rules.some((r) => !r)) return null;
  const recordedSets = new Set(run.factorSetIds);
  const sets = source.sets
    .filter((s) => s.organizationId === source.organization.id)
    .map((s) => (recordedSets.has(s.id) ? { ...s, status: 'active' as const } : s));
  return baseInputs(
    source,
    run.unitIds,
    policy,
    batches as GhgActivityBatch[],
    (rules as GhgClassificationRule[]).map((r) => ({ ...r, status: 'approved' as const })),
    sets,
  );
}
