import 'server-only';

import { assertCan, assertEnterpriseWorkspace, NotFoundError } from '@/lib/authorization/can';
import { computeInputHash, type GhgCalculationInputs } from '@/lib/domain/ghg/calculate';
import { selectCalculationInputs, type GhgSourceRows } from '@/lib/domain/ghg/select-inputs';
import { parseTrialOptions } from '@/lib/domain/trial-options';
import type { DbClient } from '@/lib/repositories/types';
import type { AuthorizationContext, ReportingPeriod, TrialProgram, Uuid } from '@/types/domain';

/**
 * 算定の入力を読む（plan §2.3 inputs.ts。読むだけ）。
 *
 * 有効な係数のセット・割当・算定方針の最新の版・承認済みの区分規則・確定済みの活動量のバッチと行を、
 * 純関数（src/lib/domain/ghg/select-inputs.ts）と同じ規則で選ぶ。入力ハッシュは並べ替えた正規 JSON の sha256。
 * 閲覧は enterprise.data.read（算定の記録・照合の画面と同じ）。
 */

/** 組織の算定の入力の元（期間を決めて読む） */
export async function loadGhgSource(
  db: DbClient,
  ctx: AuthorizationContext,
  periodId: Uuid,
): Promise<GhgSourceRows> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.read');
  const organizationId = ctx.workspace.organizationId;
  const [organization, periods, units, policies, sets, factors, assignments, rules, batches] =
    await Promise.all([
      db.findById('organizations', organizationId),
      db.select('periods', { where: { organizationId } }),
      db.select('units', { where: { organizationId, deletedAt: { isNull: true } } }),
      db.select('ghgCalculationPolicies', {
        where: { organizationId, reportingPeriodId: periodId },
      }),
      db.select('emissionFactorSets', { where: { organizationId } }),
      db.select('emissionFactors', { where: { organizationId, factorSetId: { isNull: false } } }),
      db.select('emissionFactorAssignments', {
        where: { organizationId, reportingPeriodId: periodId },
      }),
      db.select('ghgClassificationRules', { where: { organizationId } }),
      db.select('ghgActivityBatches', { where: { organizationId, reportingPeriodId: periodId } }),
    ]);
  const period = periods.find((p) => p.id === periodId);
  if (!organization || !period) throw new NotFoundError('報告期間が見つかりません。');
  const batchIds = batches.map((b) => b.id);
  const lines =
    batchIds.length > 0
      ? await db.select('ghgActivityLines', {
          where: { organizationId, batchId: { in: batchIds } },
          orderBy: [{ column: 'batchId' }, { column: 'lineNo' }],
        })
      : [];
  return {
    organization: { id: organization.id, countryCode: organization.countryCode },
    period,
    periods,
    units,
    policies,
    sets,
    factors,
    assignments,
    rules,
    batches,
    lines,
  };
}

export interface GhgInputsResult {
  source: GhgSourceRows;
  /** いまの入力（算定方針が無ければ null） */
  inputs: GhgCalculationInputs | null;
  /** いまの入力の入力ハッシュ（算定方針が無ければ null） */
  inputHash: string | null;
}

/** いまの入力と入力ハッシュ（拠点を指定して） */
export async function loadGhgInputs(
  db: DbClient,
  ctx: AuthorizationContext,
  options: { periodId: Uuid; unitIds: readonly Uuid[] },
): Promise<GhgInputsResult> {
  const source = await loadGhgSource(db, ctx, options.periodId);
  const known = new Set(source.units.map((u) => u.id));
  const unitIds = options.unitIds.filter((id) => known.has(id));
  const inputs = selectCalculationInputs(source, unitIds);
  return { source, inputs, inputHash: inputs ? computeInputHash(inputs) : null };
}

/**
 * 算定の画面の期間。`?period=`（組織の期間）→ トライアルの算定の検証期間 → 画面共通の現在の期間 の順
 */
export function resolveGhgPeriod(
  shell: { periods: readonly ReportingPeriod[]; currentPeriod: ReportingPeriod },
  trialProgram: Pick<TrialProgram, 'options'> | null,
  searchParams: Record<string, string | string[] | undefined>,
): ReportingPeriod {
  const requested = typeof searchParams.period === 'string' ? searchParams.period : null;
  const byQuery = requested ? shell.periods.find((p) => p.id === requested) : undefined;
  if (byQuery) return byQuery;
  const trialPeriodId = trialProgram
    ? parseTrialOptions(trialProgram.options).ghgVerification?.periodId
    : null;
  const byTrial = trialPeriodId ? shell.periods.find((p) => p.id === trialPeriodId) : undefined;
  return byTrial ?? shell.currentPeriod;
}

/** トライアルの算定の検証拠点（設定が無ければ計画の対象拠点。どちらも無ければ空） */
export function ghgVerificationUnitIds(
  trialProgram: Pick<TrialProgram, 'options' | 'includedUnitIds'> | null,
): Uuid[] {
  if (!trialProgram) return [];
  const own = parseTrialOptions(trialProgram.options).ghgVerification?.unitIds ?? [];
  return own.length > 0 ? own : [...trialProgram.includedUnitIds];
}
