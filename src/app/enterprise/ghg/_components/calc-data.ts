import 'server-only';

import { can } from '@/lib/authorization/can';
import { ruleEffectiveIn } from '@/lib/domain/ghg/classification';
import { latestPolicy } from '@/lib/domain/ghg/select-inputs';
import type { DbClient } from '@/lib/repositories/types';
import { ghgVerificationUnitIds, resolveGhgPeriod } from '@/lib/services/ghg/inputs';
import { loadGhgVerificationStatus, type GhgVerificationStatus } from '@/lib/services/ghg/status';
import type { EnterpriseShell } from '@/lib/services/shell';
import { loadTrialProgram } from '@/lib/services/trial-program';
import type {
  AuthorizationContext,
  EmissionFactorSet,
  GhgCalculationPolicy,
  GhgCalculationRun,
  GhgClassificationRule,
  ReportingPeriod,
  Uuid,
} from '@/types/domain';

/**
 * Scope1・2 の算定の結果の画面（P90・P96・GHG サマリー）と算定明細 CSV（E18）が読む、表示のための付帯情報。
 * 読むだけ（閲覧は組織のメンバー。RLS も同じ）。
 *
 *  - 効いた区分規則（再分類があった規則）と承認者の氏名 → 固定文 N1
 *  - 承認待ちの区分規則（期間に効くもの） → 固定文 N2
 *  - 記録の算定方針（丸めの段の桁）・使った係数のセット（出所のバッジ）
 */

export interface AppliedRule {
  rule: GhgClassificationRule;
  approverName: string;
}

export interface RunViewContext {
  /** 記録の算定方針（記録が無ければ期間の最新の版） */
  policy: GhgCalculationPolicy | null;
  /** 組織の区分規則（名前の引き当て） */
  rules: GhgClassificationRule[];
  /** 記録で報告区分を変えた（再分類があった）承認済みの規則 */
  appliedRules: AppliedRule[];
  /** 承認待ちで、期間に効く区分規則 */
  pendingRules: GhgClassificationRule[];
  /** 記録が使った係数のセット（記録が無ければ有効なセット） */
  sets: EmissionFactorSet[];
}

/**
 * 「組織の算定ルール（GHG プロトコルの標準区分と異なる区分を含みます）」のバッジを出すか。表示している記録が
 * 区分規則で報告区分を実際に変えたときだけ（承認待ちの規則だけなら、数値は既定区分のまま。N2 がそれを示す）。
 * P90・GHG サマリー・算定明細（P96）が同じ規則を使う
 */
export function showsCompanyRuleBadge(view: Pick<RunViewContext, 'appliedRules'>): boolean {
  return view.appliedRules.length > 0;
}

/** 利用者の氏名（見つからなければ「—」） */
export async function loadProfileNames(
  db: DbClient,
  userIds: ReadonlyArray<Uuid | null | undefined>,
): Promise<Map<Uuid, string>> {
  const ids = [...new Set(userIds.filter((id): id is Uuid => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const profiles = await db.select('profiles', { where: { id: { in: ids } } });
  return new Map(profiles.map((p) => [p.id, p.displayName]));
}

export async function loadRunViewContext(
  db: DbClient,
  ctx: AuthorizationContext,
  run: GhgCalculationRun | null,
  period: ReportingPeriod,
  periods: readonly ReportingPeriod[],
): Promise<RunViewContext> {
  const organizationId = ctx.workspace.organizationId;
  const [rules, policies, sets] = await Promise.all([
    db.select('ghgClassificationRules', { where: { organizationId } }),
    db.select('ghgCalculationPolicies', {
      where: { organizationId, reportingPeriodId: period.id },
    }),
    db.select('emissionFactorSets', { where: { organizationId } }),
  ]);
  const policy = run
    ? (policies.find((p) => p.id === run.policyId) ?? null)
    : latestPolicy(policies, period.id);
  const movedRuleIds = new Set((run?.summary?.reclassified ?? []).map((r) => r.ruleId));
  const applied = rules.filter((r) => movedRuleIds.has(r.id));
  const names = await loadProfileNames(
    db,
    applied.map((r) => r.approvedBy),
  );
  const usedSets = run
    ? sets.filter((s) => run.factorSetIds.includes(s.id))
    : sets.filter((s) => s.status === 'active');
  return {
    policy,
    rules,
    appliedRules: applied.map((rule) => ({
      rule,
      approverName: (rule.approvedBy && names.get(rule.approvedBy)) || '—',
    })),
    pendingRules: rules.filter(
      (r) => r.status === 'proposed' && ruleEffectiveIn(r, period, periods),
    ),
    sets: usedSets,
  };
}

export interface GhgCalcSummaryData {
  /** 算定の検証期間（トライアルの設定 → 画面共通の現在の期間） */
  period: ReportingPeriod;
  status: GhgVerificationStatus;
  view: RunViewContext;
  organizationCountryCode: string;
}

/**
 * GHG 算定サマリーの「Scope1・2 の算定と照合」の要約（トライアル概要・概要 P90 と同じ status.ts の数え方）。
 * 閲覧の権限が無い役割には出さない（null）
 */
export async function loadGhgCalcSummary(
  shell: EnterpriseShell,
): Promise<GhgCalcSummaryData | null> {
  const { db, ctx } = shell;
  if (ctx.workspace.organizationType !== 'enterprise' || !can(ctx, 'enterprise.data.read')) {
    return null;
  }
  const trialProgram = await loadTrialProgram(db, ctx);
  const period = resolveGhgPeriod(shell, trialProgram, {});
  const status = await loadGhgVerificationStatus(db, ctx, {
    periodId: period.id,
    unitIds: ghgVerificationUnitIds(trialProgram),
  });
  const [view, organization] = await Promise.all([
    loadRunViewContext(db, ctx, status.latestRun, period, shell.periods),
    db.findById('organizations', ctx.workspace.organizationId),
  ]);
  return {
    period,
    status,
    view,
    organizationCountryCode: organization?.countryCode ?? 'JP',
  };
}

/**
 * Scope3 の内訳の入力の名前（二重計上の警告に使う）。期間の Scope3 の指標の Data Point の、最新の算定内訳の行の名前
 */
export async function loadScope3InputLabels(
  db: DbClient,
  ctx: AuthorizationContext,
  periodId: Uuid,
): Promise<Array<{ label: string }>> {
  const organizationId = ctx.workspace.organizationId;
  const metrics = await db.select('metrics', {
    where: { organizationId, deletedAt: { isNull: true } },
  });
  const scope3Ids = metrics.filter((m) => m.code.startsWith('scope3_')).map((m) => m.id);
  if (scope3Ids.length === 0) return [];
  const dataPoints = await db.select('dataPoints', {
    where: {
      organizationId,
      reportingPeriodId: periodId,
      metricId: { in: scope3Ids },
      deletedAt: { isNull: true },
    },
  });
  if (dataPoints.length === 0) return [];
  const calculations = await db.select('calculations', {
    where: { organizationId, dataPointId: { in: dataPoints.map((dp) => dp.id) } },
  });
  const latestByDataPoint = new Map<Uuid, (typeof calculations)[number]>();
  for (const calc of calculations) {
    const current = latestByDataPoint.get(calc.dataPointId);
    if (!current || current.calculatedAt < calc.calculatedAt) {
      latestByDataPoint.set(calc.dataPointId, calc);
    }
  }
  return [...latestByDataPoint.values()].flatMap((calc) =>
    calc.inputs.map((input) => ({ label: input.label })),
  );
}
