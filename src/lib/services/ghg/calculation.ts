import 'server-only';

import { randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import {
  AuthorizationError,
  assertCan,
  assertEnterpriseWorkspace,
  assertUnitInScope,
  NotFoundError,
} from '@/lib/authorization/can';
import {
  calculateRun,
  computeInputHash,
  recalculate,
  type GhgCalcError,
  type GhgCalculationOutput,
  type GhgSubstitutions,
} from '@/lib/domain/ghg/calculate';
import { dualView, type DualView } from '@/lib/domain/ghg/classification';
import { inputsForRecordedRun, selectCalculationInputs } from '@/lib/domain/ghg/select-inputs';
import { ValidationError } from '@/lib/errors/user-facing';
import { DEMO_GHG_LIMITS, GHG_FIXTURE_ROW_IDS } from '@/lib/repositories/demo-ghg-checks';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  GhgCalculationLine,
  GhgCalculationRun,
  Uuid,
} from '@/types/domain';
import { loadGhgSource } from './inputs';

/**
 * 算定の実行と記録（plan §2.3 calculation.ts・CR-08）。
 *
 *  - 実行は enterprise.data.write かつ拠点がすべて担当拠点（RLS の t4d.all_units_in_scope と同じ）
 *  - 係数が解決できない・単位の次元が合わない・区分規則が衝突する行が 1 つでもあれば、記録を作らずにエラーの一覧を返す
 *    （代わりを使わない。plan K6）
 *  - 記録（追記専用）と算定行（追記専用）を書く。Data Point は直接確定しない（下書きの反映は S3 の
 *    post-to-data-points.ts）
 *  - 仮説の再計算（computeWhatIf）は保存しない（書き込み 0）
 * 監査ログは既存の種類（算定の記録＝data_created）。
 */

/** 算定の記録の入力の状態（最新＝いまの入力と同じ・入力が変わった・作り直せない〔Demo の Cookie から戻した記録〕） */
export type RunInputState = 'current' | 'stale' | 'input_changed';

export interface RunListEntry {
  run: GhgCalculationRun;
  inputState: RunInputState;
}

export type RunCalculationResult =
  | { ok: true; run: GhgCalculationRun; lines: GhgCalculationLine[] }
  | { ok: false; errors: GhgCalcError[] };

/** Supabase へ算定行をまとめて書く件数 */
const LINE_CHUNK = 500;

function assertCanCalculate(ctx: AuthorizationContext, unitIds: readonly Uuid[]): void {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.write');
  for (const unitId of unitIds) assertUnitInScope(ctx, unitId);
}

/** 算定を実行して記録する */
export async function runCalculation(
  db: DbClient,
  ctx: AuthorizationContext,
  options: { periodId: Uuid; unitIds: readonly Uuid[] },
): Promise<RunCalculationResult> {
  const unitIds = [...new Set(options.unitIds)];
  if (unitIds.length === 0) throw new ValidationError('算定する拠点を選んでください。');
  assertCanCalculate(ctx, unitIds);
  const source = await loadGhgSource(db, ctx, options.periodId);
  const known = new Set(source.units.map((u) => u.id));
  if (!unitIds.every((id) => known.has(id))) throw new NotFoundError('拠点が見つかりません。');
  const inputs = selectCalculationInputs(source, unitIds);
  if (!inputs) {
    throw new ValidationError(
      'この期間の算定方針（丸め・換算・改良トンキロ法の設定）がありません。算定ルールの画面で保存してから実行してください。',
    );
  }
  if (inputs.lines.length === 0) {
    throw new ValidationError(
      '確定済みの活動量がありません。活動量を取り込んで確定してから実行してください。',
    );
  }
  if (db.mode === 'demo') {
    // Demo Mode の上限（Cookie の容量。Fixture の記録は数えない）
    const runs = await db.select('ghgCalculationRuns', {
      where: { organizationId: ctx.workspace.organizationId },
    });
    const own = runs.filter((r) => !GHG_FIXTURE_ROW_IDS.has(r.id));
    if (own.length >= DEMO_GHG_LIMITS.userRuns) {
      throw new ValidationError(
        `デモでは算定の記録は ${DEMO_GHG_LIMITS.userRuns} 件までです。開示デモを初期状態に戻してから実行してください。`,
      );
    }
  }
  const runId = randomUUID();
  const createdAt = new Date().toISOString();
  const output = calculateRun(inputs, { runId, createdAt });
  if (output.errors.length > 0) return { ok: false, errors: output.errors };

  const run: GhgCalculationRun = {
    id: runId,
    organizationId: ctx.workspace.organizationId,
    reportingPeriodId: source.period.id,
    unitIds,
    policyId: inputs.policy.id,
    factorSetIds: output.factorSetIds,
    ruleIds: output.ruleIds,
    activityBatchIds: output.activityBatchIds,
    inputHash: output.inputHash,
    engineVersion: output.engineVersion,
    summary: output.summary,
    lineCount: output.lines.length,
    createdAt,
    createdBy: ctx.userId,
  };
  const [inserted] = await db.insert('ghgCalculationRuns', [run]);
  for (let i = 0; i < output.lines.length; i += LINE_CHUNK) {
    await db.insert('ghgCalculationLines', output.lines.slice(i, i + LINE_CHUNK));
  }
  const unitNames = source.units.filter((u) => unitIds.includes(u.id)).map((u) => u.name);
  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'ghg_calculation_run',
    resourceId: run.id,
    afterSummary: `${source.period.label} の Scope1・2 を算定（${unitNames.join('・')}・算定行 ${run.lineCount} 行）`,
    metadata: {
      periodId: run.reportingPeriodId,
      unitIds,
      inputHash: run.inputHash,
      engineVersion: run.engineVersion,
      ruleIds: run.ruleIds,
    },
  });
  return { ok: true, run: inserted ?? run, lines: output.lines };
}

/** 期間の算定の記録（新しい順。入力の状態付き） */
export async function listRuns(
  db: DbClient,
  ctx: AuthorizationContext,
  options: { periodId: Uuid },
): Promise<RunListEntry[]> {
  const source = await loadGhgSource(db, ctx, options.periodId);
  const runs = await db.select('ghgCalculationRuns', {
    where: { organizationId: ctx.workspace.organizationId, reportingPeriodId: options.periodId },
    orderBy: [
      { column: 'createdAt', dir: 'desc' },
      { column: 'id', dir: 'desc' },
    ],
  });
  return runs.map((run) => ({ run, inputState: inputStateOf(source, run) }));
}

function inputStateOf(
  source: Awaited<ReturnType<typeof loadGhgSource>>,
  run: GhgCalculationRun,
): RunInputState {
  if (!run.summary) return 'input_changed';
  const inputs = selectCalculationInputs(source, run.unitIds);
  return inputs && computeInputHash(inputs) === run.inputHash ? 'current' : 'stale';
}

export interface LoadedRun {
  run: GhgCalculationRun;
  inputState: RunInputState;
  lines: GhgCalculationLine[];
  /** 報告区分と既定区分の未丸めの合計（全拠点）。要約が無い（入力が変わった）ときは null */
  dual: DualView | null;
}

/** 算定の記録と算定行・二重表示 */
export async function loadRun(
  db: DbClient,
  ctx: AuthorizationContext,
  runId: Uuid,
): Promise<LoadedRun> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.read');
  const run = await db.findById('ghgCalculationRuns', runId);
  if (!run || run.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('算定の記録が見つかりません。');
  }
  const source = await loadGhgSource(db, ctx, run.reportingPeriodId);
  const inputState = inputStateOf(source, run);
  if (!run.summary) return { run, inputState, lines: [], dual: null };
  const lines = await db.select('ghgCalculationLines', {
    where: { organizationId: run.organizationId, runId: run.id },
  });
  lines.sort((a, b) => {
    const order = run.unitIds.indexOf(a.unitId) - run.unitIds.indexOf(b.unitId);
    if (order !== 0) return order;
    if (a.month !== b.month) return a.month < b.month ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
  return {
    run,
    inputState,
    lines,
    dual: dualView(
      lines.map((l) => ({
        protocolScope: l.protocolScope,
        reportedScope: l.reportedScope,
        classificationRuleId: l.classificationRuleId,
        emissions: l.emissionsUnrounded,
      })),
    ),
  };
}

/**
 * 仮説の再計算（保存しない。CR-14）。記録した入力（方針・バッチ・規則・セット）から、置き換え（別の係数セット・
 * 丸め・区分規則なし・式の形・換算なし）を当てて算定し直す。書き込みは 0
 */
export async function computeWhatIf(
  db: DbClient,
  ctx: AuthorizationContext,
  runId: Uuid,
  alternative: GhgSubstitutions,
): Promise<GhgCalculationOutput> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.read');
  const run = await db.findById('ghgCalculationRuns', runId);
  if (!run || run.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('算定の記録が見つかりません。');
  }
  if (alternative.factorSetId) {
    const set = await db.findById('emissionFactorSets', alternative.factorSetId);
    if (!set || set.organizationId !== run.organizationId) {
      throw new NotFoundError('係数のセットが見つかりません。');
    }
    if (set.status === 'draft') {
      throw new ValidationError(
        '下書きの係数のセットでは仮説の再計算をしません（有効にしてから）。',
      );
    }
  }
  const source = await loadGhgSource(db, ctx, run.reportingPeriodId);
  const inputs = inputsForRecordedRun(source, run);
  if (!inputs) {
    throw new ValidationError(
      '記録した算定の入力を読み込めません（入力が変わった可能性があります）。',
    );
  }
  return recalculate(inputs, alternative, {
    runId: `${run.id}#whatif`,
    createdAt: run.createdAt,
  });
}

/** 画面の操作の可否（行の操作・見出しの操作の disabledReason に使う） */
export function calculationPermissionReason(ctx: AuthorizationContext): string | null {
  try {
    assertEnterpriseWorkspace(ctx);
    assertCan(ctx, 'enterprise.data.write');
    return null;
  } catch (error) {
    return error instanceof AuthorizationError ? error.message : '算定を実行する権限がありません。';
  }
}
