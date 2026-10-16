import { GHG_ENGINE_VERSION, calculateRun, type GhgCalculationInputs } from './calculate';
import type {
  EmissionFactor,
  EmissionFactorAssignment,
  EmissionFactorSet,
  GhgActivityBatch,
  GhgActivityLine,
  GhgCalculationPolicy,
  GhgCalculationLine,
  GhgCalculationRun,
  GhgClassificationRule,
  GhgRunSummary,
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

/** 時刻の前後（ISO の書き方の違い〔Z と +00:00〕で文字列の比較を誤らない） */
function atOrBefore(a: string | null, b: string): boolean {
  if (a === null) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta <= tb;
}

/**
 * 記録した算定の入力（Demo Mode で Cookie から戻した記録・Supabase Mode の記録の照合・仮説の再計算に使う）。
 * 方針・活動量のバッチ・区分規則・係数のセットは記録した ID で選ぶ（後から差し替え・取り下げられても、その記録の時点の
 * 入力として扱う）。ただし記録の時点で使えたものだけ（方針は記録より前に作った版、バッチは記録より前に確定したもの、
 * 区分規則は記録より前に承認したもの、セットは記録の時点で有効だったもの）。記録の行は Supabase Mode では利用者が
 * 書けるため、下書きのセット・承認前の規則・確定前のバッチを名乗る記録を「有効だった」ことにして作り直さない。
 * 割当だけはいまの行（記録が ID を持たない）。いまの割当が記録の時点と違えば、入力ハッシュが合わず
 * 「入力が変わった」になる。記録の入力が見つからない・記録の時点で使えなかったなら null
 */
export function inputsForRecordedRun(
  source: GhgSourceRows,
  run: Pick<
    GhgCalculationRun,
    | 'unitIds'
    | 'policyId'
    | 'factorSetIds'
    | 'ruleIds'
    | 'activityBatchIds'
    | 'reportingPeriodId'
    | 'createdAt'
  >,
): GhgCalculationInputs | null {
  const policy = source.policies.find((p) => p.id === run.policyId);
  if (!policy || run.reportingPeriodId !== source.period.id) return null;
  if (policy.reportingPeriodId !== source.period.id) return null;
  if (!atOrBefore(policy.createdAt, run.createdAt)) return null;
  const batches = run.activityBatchIds.map((id) => source.batches.find((b) => b.id === id));
  if (
    batches.some(
      (b) =>
        !b ||
        (b.status !== 'confirmed' && b.status !== 'superseded') ||
        !atOrBefore(b.confirmedAt, run.createdAt),
    )
  ) {
    return null;
  }
  const rules = run.ruleIds.map((id) => source.rules.find((r) => r.id === id));
  if (rules.some((r) => !r || r.status === 'proposed' || !atOrBefore(r.approvedAt, run.createdAt)))
    return null;
  const sets = source.sets.filter((s) => s.organizationId === source.organization.id);
  const recordedSets = new Set(run.factorSetIds);
  const activeAtRun = (s: EmissionFactorSet) =>
    s.status !== 'draft' &&
    atOrBefore(s.activatedAt, run.createdAt) &&
    (s.retiredAt === null || !atOrBefore(s.retiredAt, run.createdAt));
  if (run.factorSetIds.some((id) => !sets.some((s) => s.id === id && activeAtRun(s)))) return null;
  return baseInputs(
    source,
    run.unitIds,
    policy,
    batches as GhgActivityBatch[],
    (rules as GhgClassificationRule[]).map((r) => ({ ...r, status: 'approved' as const })),
    sets.map((s) => (recordedSets.has(s.id) ? { ...s, status: 'active' as const } : s)),
  );
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

/**
 * 記録した算定を作り直す（要約と算定行）。エンジンの版・入力ハッシュ・算定行の数・使った入力の ID が記録と
 * 違えば null（「入力が変わった」。数値を出さない）。Demo Mode の Cookie からの戻しと、Supabase Mode の記録の
 * 照合（利用者の JWT で書かれた要約・算定行を信じない）が同じ関数を使う
 */
export function rebuildRecordedRun(
  source: GhgSourceRows,
  run: Pick<
    GhgCalculationRun,
    | 'id'
    | 'unitIds'
    | 'policyId'
    | 'factorSetIds'
    | 'ruleIds'
    | 'activityBatchIds'
    | 'reportingPeriodId'
    | 'inputHash'
    | 'engineVersion'
    | 'createdAt'
    | 'lineCount'
  >,
): { summary: GhgRunSummary; lines: GhgCalculationLine[] } | null {
  if (run.engineVersion !== GHG_ENGINE_VERSION) return null;
  const inputs = inputsForRecordedRun(source, run);
  if (!inputs) return null;
  const out = calculateRun(inputs, { runId: run.id, createdAt: run.createdAt });
  if (
    out.inputHash !== run.inputHash ||
    out.errors.length > 0 ||
    out.lines.length !== run.lineCount ||
    !sameIds(out.factorSetIds, run.factorSetIds) ||
    !sameIds(out.ruleIds, run.ruleIds) ||
    !sameIds(out.activityBatchIds, run.activityBatchIds)
  ) {
    return null;
  }
  return { summary: out.summary, lines: out.lines };
}
