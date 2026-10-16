import 'server-only';

import { randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import {
  assertCan,
  assertEnterpriseWorkspace,
  assertUnitInScope,
  NotFoundError,
} from '@/lib/authorization/can';
import {
  DEFAULT_ATTRIBUTION_ORDER,
  RECONCILIATION_CHECKER_VERSION,
  attribute,
  attributionLinesFrom,
  itemVerdict,
  rebuildReconciliationResult,
} from '@/lib/domain/ghg/attribution';
import { GHG_SCOPE_LABELS } from '@/lib/domain/ghg/calculate';
import { ValidationError } from '@/lib/errors/user-facing';
import { DEMO_GHG_LIMITS, GHG_FIXTURE_ROW_IDS } from '@/lib/repositories/demo-ghg-checks';
import type { DbClient } from '@/lib/repositories/types';
import { isUuid } from '@/lib/validation/uuid';
import { trustedRun } from './calculation';
import { loadGhgSource } from './inputs';
import {
  GHG_CAUSES,
  GHG_SCOPES,
  type AuthorizationContext,
  type GhgAttributionCause,
  type GhgBaselineResult,
  type GhgCalculationLine,
  type GhgCalculationRun,
  type GhgReconciliation,
  type GhgReconciliationNote,
  type GhgReconVerdict,
  type GhgScope,
  type ReconciliationItem,
  type ReconciliationTolerance,
  type Uuid,
} from '@/types/domain';

/**
 * 既存の算定結果との照合（plan §2.3 reconciliation.ts・CR-12）。決定論（AI を使わない）。
 *
 *  - 照合は enterprise.data.write かつ記録の拠点がすべて担当拠点（算定の実行と同じ。RLS 0066 と対）。
 *    算定の記録と既存結果は同じ組織・同じ期間
 *  - Supabase Mode の記録・照合の行は利用者の JWT で書かれるため、要約・算定行・結果は記録した入力から作り直した
 *    値を使う（calculation.ts の trustedRun・この trustedReconciliation）
 *  - 許容差（区分ごとの絶対値 t・相対 %）は利用者が入れる。**照合に出てくる区分の許容差が無ければ拒否**（既定値を置かない）
 *  - 照合の規則の版（checker_version）を残す。既存結果のファイルの sha256 は既存結果の行にある
 *  - 判定は確認の記録を反映する（人が原因を記録した項目は「原因を確認済み」）。判定の語に「一致」を使わない
 * 監査ログは既存の種類（照合の記録＝data_created）。
 */

export interface ReconcileInput {
  runId: Uuid;
  baselineId: Uuid;
  tolerance: ReconciliationTolerance;
  /** 原因を揃える順序（既定: 区分→対象範囲→活動量→単位換算→係数→算定方法→丸め） */
  order?: readonly GhgAttributionCause[];
}

function checkTolerance(tolerance: ReconciliationTolerance, scopes: ReadonlySet<GhgScope>): void {
  for (const [scope, t] of Object.entries(tolerance)) {
    if (!(GHG_SCOPES as readonly string[]).includes(scope) || !t) {
      throw new ValidationError('許容差の区分が不正です。');
    }
    for (const value of [t.absoluteT, t.relativePct]) {
      if (value !== null && !(Number.isFinite(value) && value >= 0)) {
        throw new ValidationError('許容差は 0 以上の数で入れてください。');
      }
    }
    if (t.absoluteT === null && t.relativePct === null) {
      throw new ValidationError(
        '許容差は絶対値（t）か相対値（%）の少なくとも一方を入れてください。',
      );
    }
  }
  const missing = [...scopes].filter((scope) => !tolerance[scope]);
  if (missing.length > 0) {
    throw new ValidationError(
      `許容差が入っていない区分があります（${missing.map((scope) => GHG_SCOPE_LABELS[scope]).join('・')}）。許容差は既定値を置かず、利用者が入れます。`,
    );
  }
}

function checkOrder(order: readonly GhgAttributionCause[]): void {
  const allowed = GHG_CAUSES.filter((c) => c !== 'other');
  if (
    order.length === 0 ||
    new Set(order).size !== order.length ||
    !order.every((c) => (allowed as readonly string[]).includes(c))
  ) {
    throw new ValidationError('原因を揃える順序が不正です。');
  }
}

async function loadPair(
  db: DbClient,
  ctx: AuthorizationContext,
  runId: Uuid,
  baselineId: Uuid,
): Promise<{
  run: GhgCalculationRun;
  baseline: GhgBaselineResult;
  /** 作り直した算定行（Supabase Mode）。Demo Mode は null（保存した行を読む） */
  rebuiltLines: GhgCalculationLine[] | null;
}> {
  const organizationId = ctx.workspace.organizationId;
  // UUID でない ID は DB に問い合わせない（Supabase Mode では 22P02 の例外＝500 になるため。見つからない扱い）
  if (!isUuid(runId)) throw new NotFoundError('算定の記録が見つかりません。');
  if (!isUuid(baselineId)) throw new NotFoundError('既存の算定結果が見つかりません。');
  const [run, baseline] = await Promise.all([
    db.findById('ghgCalculationRuns', runId),
    db.findById('ghgBaselineResults', baselineId),
  ]);
  if (!run || run.organizationId !== organizationId)
    throw new NotFoundError('算定の記録が見つかりません。');
  if (!baseline || baseline.organizationId !== organizationId) {
    throw new NotFoundError('既存の算定結果が見つかりません。');
  }
  if (run.reportingPeriodId !== baseline.reportingPeriodId) {
    throw new ValidationError('算定の記録と既存の算定結果は同じ期間のものだけを照合できます。');
  }
  // Demo Mode は記録を作り直して照合済み（入力の元を読まない）
  if (db.mode === 'demo') return { run, baseline, rebuiltLines: null };
  const source = await loadGhgSource(db, ctx, run.reportingPeriodId);
  const trusted = trustedRun(db, source, run);
  return { run: trusted.run, baseline, rebuiltLines: trusted.lines };
}

/**
 * 照合の記録の結果を、画面・判定に使える形にする。Demo Mode は Cookie から戻すときに作り直して照合済み。
 * Supabase Mode は記録の算定行（作り直した行）・既存結果・記録の許容差と原因の順序から作り直した結果を使う
 * （利用者の JWT で書かれた結果を信じない。記録が作り直せなければ結果は null）
 */
export async function trustedReconciliation(
  db: DbClient,
  reconciliation: GhgReconciliation,
  run: GhgCalculationRun,
  baseline: GhgBaselineResult,
  rebuiltLines: readonly GhgCalculationLine[] | null,
): Promise<GhgReconciliation> {
  if (db.mode === 'demo') return reconciliation;
  if (!run.summary || !rebuiltLines) return { ...reconciliation, result: null };
  const [policy, activityLines] = await Promise.all([
    db.findById('ghgCalculationPolicies', run.policyId),
    run.activityBatchIds.length > 0
      ? db.select('ghgActivityLines', {
          where: { organizationId: run.organizationId, batchId: { in: run.activityBatchIds } },
        })
      : Promise.resolve([]),
  ]);
  if (!policy) return { ...reconciliation, result: null };
  return {
    ...reconciliation,
    result: rebuildReconciliationResult(
      reconciliation,
      rebuiltLines,
      activityLines,
      baseline.rows,
      policy.rounding,
    ),
  };
}

/** 照合する（結果を記録する） */
export async function reconcile(
  db: DbClient,
  ctx: AuthorizationContext,
  input: ReconcileInput,
): Promise<GhgReconciliation> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.write');
  const { run, baseline, rebuiltLines } = await loadPair(db, ctx, input.runId, input.baselineId);
  // 照合の記録は拠点ごとの状況（照合済み・要確認）とホームの要対応を決める。担当外の拠点を含む記録は照合しない
  for (const unitId of run.unitIds) assertUnitInScope(ctx, unitId);
  if (!run.summary) {
    throw new ValidationError(
      'この算定の記録は入力が変わったため照合できません。算定し直してから照合してください。',
    );
  }
  const order = input.order ?? DEFAULT_ATTRIBUTION_ORDER;
  checkOrder(order);
  const [lines, policy, activityLines] = await Promise.all([
    rebuiltLines
      ? Promise.resolve(rebuiltLines)
      : db.select('ghgCalculationLines', {
          where: { organizationId: run.organizationId, runId: run.id },
        }),
    db.findById('ghgCalculationPolicies', run.policyId),
    db.select('ghgActivityLines', {
      where: { organizationId: run.organizationId, batchId: { in: run.activityBatchIds } },
    }),
  ]);
  if (!policy) throw new NotFoundError('算定方針が見つかりません。');
  const scopes = new Set<GhgScope>([
    ...lines.map((l) => l.reportedScope),
    ...baseline.rows.map((r) => r.scope),
  ]);
  checkTolerance(input.tolerance, scopes);
  if (db.mode === 'demo') {
    const existing = await db.select('ghgReconciliations', {
      where: { organizationId: ctx.workspace.organizationId },
    });
    if (
      existing.filter((r) => !GHG_FIXTURE_ROW_IDS.has(r.id)).length >=
      DEMO_GHG_LIMITS.userReconciliations
    ) {
      throw new ValidationError(
        `デモでは照合の記録は ${DEMO_GHG_LIMITS.userReconciliations} 件までです。開示デモを初期状態に戻してから照合してください。`,
      );
    }
  }
  const shipmentOf = new Map(activityLines.map((l) => [l.id, l.shipmentRef]));
  const result = attribute(
    attributionLinesFrom(lines, (id) => shipmentOf.get(id) ?? null),
    baseline.rows,
    { t4dRounding: policy.rounding, tolerance: input.tolerance, order },
  );
  const row: GhgReconciliation = {
    id: randomUUID(),
    organizationId: ctx.workspace.organizationId,
    runId: run.id,
    baselineId: baseline.id,
    tolerance: input.tolerance,
    attributionOrder: [...order],
    result,
    checkerVersion: RECONCILIATION_CHECKER_VERSION,
    createdAt: new Date().toISOString(),
    createdBy: ctx.userId,
  };
  const [inserted] = await db.insert('ghgReconciliations', [row]);
  const needsReview = result.items.filter((i) => itemVerdict(i, []) !== 'within_tolerance').length;
  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'ghg_reconciliation',
    resourceId: row.id,
    afterSummary: `算定の記録と既存の算定結果「${baseline.label}」を照合（項目 ${result.items.length} 件・許容差の外 ${needsReview} 件）`,
    metadata: {
      runId: run.id,
      baselineId: baseline.id,
      baselineSha256: baseline.fileSha256,
      checkerVersion: RECONCILIATION_CHECKER_VERSION,
    },
  });
  return inserted ?? row;
}

export interface ReconciliationItemView extends ReconciliationItem {
  verdict: GhgReconVerdict;
  /** 最新の確認の記録（差し替えられていないもの） */
  latestNote: GhgReconciliationNote | null;
  /** 確認の記録の履歴（古い順） */
  notes: GhgReconciliationNote[];
}

export interface LoadedReconciliation {
  reconciliation: GhgReconciliation;
  run: GhgCalculationRun;
  baseline: GhgBaselineResult;
  /** 結果を作り直せない（照合の規則の版が違う・入力が変わった）ときは null */
  items: ReconciliationItemView[] | null;
  counts: Record<GhgReconVerdict, number>;
}

/** 照合の記録（確認の記録を反映した判定） */
export async function loadReconciliation(
  db: DbClient,
  ctx: AuthorizationContext,
  reconciliationId: Uuid,
): Promise<LoadedReconciliation> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.read');
  if (!isUuid(reconciliationId)) throw new NotFoundError('照合の記録が見つかりません。');
  const stored = await db.findById('ghgReconciliations', reconciliationId);
  if (!stored || stored.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('照合の記録が見つかりません。');
  }
  const { run, baseline, rebuiltLines } = await loadPair(db, ctx, stored.runId, stored.baselineId);
  const reconciliation = await trustedReconciliation(db, stored, run, baseline, rebuiltLines);
  const notes = await db.select('ghgReconciliationNotes', {
    where: { organizationId: reconciliation.organizationId, reconciliationId: reconciliation.id },
    orderBy: [{ column: 'decidedAt' }, { column: 'id' }],
  });
  const counts: Record<GhgReconVerdict, number> = {
    within_tolerance: 0,
    needs_review: 0,
    cause_confirmed: 0,
    unexplained: 0,
    one_sided: 0,
  };
  if (!reconciliation.result) return { reconciliation, run, baseline, items: null, counts };
  const superseded = new Set(notes.map((n) => n.supersedesId).filter(Boolean));
  const items = reconciliation.result.items.map((item) => {
    const own = notes.filter((n) => n.itemKey === item.key);
    const verdict = itemVerdict(item, own);
    counts[verdict] += 1;
    return {
      ...item,
      verdict,
      latestNote: [...own].reverse().find((n) => !superseded.has(n.id)) ?? null,
      notes: own,
    };
  });
  return { reconciliation, run, baseline, items, counts };
}

/** 期間の照合の記録（新しい順） */
export async function listReconciliations(
  db: DbClient,
  ctx: AuthorizationContext,
  options: { periodId: Uuid },
): Promise<GhgReconciliation[]> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.read');
  const runs = await db.select('ghgCalculationRuns', {
    where: { organizationId: ctx.workspace.organizationId, reportingPeriodId: options.periodId },
  });
  if (runs.length === 0) return [];
  return db.select('ghgReconciliations', {
    where: { organizationId: ctx.workspace.organizationId, runId: { in: runs.map((r) => r.id) } },
    orderBy: [
      { column: 'createdAt', dir: 'desc' },
      { column: 'id', dir: 'desc' },
    ],
  });
}
