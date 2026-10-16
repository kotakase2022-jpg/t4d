import 'server-only';

import { computeInputHash } from '@/lib/domain/ghg/calculate';
import {
  RESOLUTION_ERROR_LABELS,
  factorNeedsOfLine,
  resolveFactor,
} from '@/lib/domain/ghg/factor-resolution';
import { selectCalculationInputs } from '@/lib/domain/ghg/select-inputs';
import { monthsBetween, siteStatuses, type SiteStatus } from '@/lib/domain/ghg/verification-status';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  FactorActivityKind,
  GhgActivityLine,
  GhgCalculationRun,
  GhgReconciliation,
  OrganizationUnit,
  ReportingPeriod,
  Uuid,
} from '@/types/domain';
import { needLabel } from './assignments';
import { trustedRun } from './calculation';
import { loadGhgSource } from './inputs';
import { trustedReconciliation } from './reconciliation';

/**
 * 拠点ごとの検証の進み具合（plan §2.3 status.ts・CR-20。読むだけ）。
 * トライアル概要・算定の概要（P90）・ホームの Attention が同じ関数を使う。
 */

export interface GhgVerificationStatus {
  period: ReportingPeriod;
  units: Array<{ unit: OrganizationUnit; status: SiteStatus }>;
  latestRun: GhgCalculationRun | null;
  latestReconciliation: GhgReconciliation | null;
  /** 画面の Attention と NavTabs の件数 */
  attention: {
    /** 係数が解決できない活動量の行（拠点 × 理由） */
    unresolvedLines: number;
    unresolvedReasons: string[];
    /** 承認待ちの区分規則 */
    pendingRules: number;
    /** 確定していない（下書きの）活動量のバッチ */
    draftBatches: number;
    /** 見なし積載率（原単位表）を使う輸送の行・積載率の下限を当てる行（最新の記録） */
    defaultLoadLines: number;
    flooredLoadLines: number;
    /** 照合で要確認の項目（最新の照合。確認の記録を反映） */
    reconciliationNeedsReview: number;
  };
}

/** 活動量の 1 行に要る係数の組と画面の名前（算定のエンジン・割当の一覧と同じ組） */
function needsOf(line: GhgActivityLine): Array<{
  kind: FactorActivityKind;
  code: string;
  basis: 'location' | 'market' | null;
  label: string;
}> {
  return factorNeedsOfLine(line).map((need) => ({
    ...need,
    label: needLabel(need.kind, need.code, need.basis),
  }));
}

export async function loadGhgVerificationStatus(
  db: DbClient,
  ctx: AuthorizationContext,
  options: { periodId: Uuid; unitIds: readonly Uuid[] },
): Promise<GhgVerificationStatus> {
  const source = await loadGhgSource(db, ctx, options.periodId);
  const organizationId = ctx.workspace.organizationId;
  const unitIds = options.unitIds.filter((id) => source.units.some((u) => u.id === id));
  const confirmed = source.batches.filter((b) => b.status === 'confirmed');
  const confirmedIds = new Set(confirmed.map((b) => b.id));
  const batchUnit = new Map(source.batches.map((b) => [b.id, b.unitId]));

  const [runs, baselines, reconciliations] = await Promise.all([
    db.select('ghgCalculationRuns', {
      where: { organizationId, reportingPeriodId: source.period.id },
      orderBy: [
        { column: 'createdAt', dir: 'desc' },
        { column: 'id', dir: 'desc' },
      ],
    }),
    db.select('ghgBaselineResults', {
      where: { organizationId, reportingPeriodId: source.period.id },
    }),
    db.select('ghgReconciliations', {
      where: { organizationId },
      orderBy: [
        { column: 'createdAt', dir: 'desc' },
        { column: 'id', dir: 'desc' },
      ],
    }),
  ]);
  const storedRun =
    runs.find((r) => unitIds.length > 0 && unitIds.some((u) => r.unitIds.includes(u))) ?? null;
  // Supabase Mode の記録・照合は作り直した値を使う（利用者の JWT で書かれた要約・結果を信じない）
  const trusted = storedRun ? trustedRun(db, source, storedRun) : null;
  const latestRun = trusted?.run ?? null;
  const storedReconciliation = latestRun
    ? (reconciliations.find((r) => r.runId === latestRun.id) ?? null)
    : null;
  const reconciledBaseline =
    storedReconciliation && db.mode !== 'demo'
      ? await db.findById('ghgBaselineResults', storedReconciliation.baselineId)
      : null;
  const latestReconciliation =
    !storedReconciliation || !latestRun || db.mode === 'demo'
      ? storedReconciliation
      : reconciledBaseline
        ? await trustedReconciliation(
            db,
            storedReconciliation,
            latestRun,
            reconciledBaseline,
            trusted?.lines ?? null,
          )
        : { ...storedReconciliation, result: null };
  const notes = latestReconciliation
    ? await db.select('ghgReconciliationNotes', {
        where: { organizationId, reconciliationId: latestReconciliation.id },
      })
    : [];
  const currentHash = (() => {
    if (!latestRun) return null;
    const inputs = selectCalculationInputs(source, latestRun.unitIds);
    return inputs ? computeInputHash(inputs) : null;
  })();

  const unresolvedReasons = new Set<string>();
  let unresolvedTotal = 0;
  const sites = unitIds.map((unitId) => {
    const unit = source.units.find((u) => u.id === unitId)!;
    const lines = source.lines.filter(
      (l) => confirmedIds.has(l.batchId) && batchUnit.get(l.batchId) === unitId,
    );
    let unresolved = 0;
    for (const line of lines) {
      for (const need of needsOf(line)) {
        const r = resolveFactor(
          {
            reportingPeriodId: source.period.id,
            unitId,
            unitName: unit.name,
            countryCode: unit.countryCode,
            activityKind: need.kind,
            activityCode: need.code,
            activityLabel: need.label,
            basis: need.basis,
          },
          source.assignments,
          source.factors,
          source.sets,
        );
        if ('error' in r) {
          unresolved += 1;
          unresolvedReasons.add(
            `${unit.name}: ${need.label}（${RESOLUTION_ERROR_LABELS[r.error]}）`,
          );
          break;
        }
      }
    }
    unresolvedTotal += unresolved;
    return {
      unitId,
      monthsWithActivity: lines.map((l) => l.month),
      monthsInPeriod: monthsBetween(source.period.startDate, source.period.endDate),
      unresolvedLines: unresolved,
      hasBaseline: baselines.some((b) => b.rows.some((r) => r.unitId === unitId)),
    };
  });
  const statuses = siteStatuses(sites, latestRun, currentHash, latestReconciliation, notes);
  const latestLines = !latestRun
    ? []
    : trusted?.lines
      ? trusted.lines
      : await db.select('ghgCalculationLines', { where: { organizationId, runId: latestRun.id } });
  return {
    period: source.period,
    units: statuses.map((status) => ({
      unit: source.units.find((u) => u.id === status.unitId)!,
      status,
    })),
    latestRun,
    latestReconciliation,
    attention: {
      unresolvedLines: unresolvedTotal,
      unresolvedReasons: [...unresolvedReasons].slice(0, 10),
      pendingRules: source.rules.filter((r) => r.status === 'proposed').length,
      draftBatches: source.batches.filter((b) => b.status === 'draft' && unitIds.includes(b.unitId))
        .length,
      defaultLoadLines: latestLines.filter((l) => l.warnings.includes('default_load_factor'))
        .length,
      flooredLoadLines: latestLines.filter((l) => l.warnings.includes('load_floored')).length,
      reconciliationNeedsReview: statuses.reduce(
        (sum, s) => sum + (s.reconciliation === 'needs_review' ? 1 : 0),
        0,
      ),
    },
  };
}
