import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import {
  AuthorizationError,
  assertCan,
  assertEnterpriseWorkspace,
  assertUnitInScope,
  can,
  isUnitInScope,
} from '@/lib/authorization/can';
import { isCountedInTotals } from '@/lib/domain/boundaries';
import { ACTIVITY_KIND_LABELS, GHG_SCOPE_LABELS } from '@/lib/domain/ghg/calculate';
import { cleanFloat } from '@/lib/domain/ghg/rounding';
import { ValidationError } from '@/lib/errors/user-facing';
import { contentHash, fid } from '@/lib/fixtures/ids';
import type { DbClient } from '@/lib/repositories/types';
import { recomputePeriodValidations } from '@/lib/services/validation-store';
import type {
  AuthorizationContext,
  CalculationInput,
  DataPoint,
  DataPointCalculation,
  DataPointStatus,
  DataPointVersion,
  GhgActivityKind,
  GhgCalculationRun,
  MetricDefinition,
  OrganizationUnit,
  ReportingPeriod,
  Uuid,
} from '@/types/domain';
import { loadRun, type RunInputState } from './calculation';

/**
 * 算定の記録から Data Point への下書き反映（plan §2.3 post-to-data-points.ts・CR-10・K4）。
 *
 * 算定は Data Point を直接確定しない。拠点 ×（scope1・scope2・scope2_location）の Data Point に、報告区分の
 * 値（算定方針の拠点×区分の段の丸め後）を「下書きの新しい版」（出所 calculation）として積み、算定内訳
 * （data_point_calculations）に「Σ 算定行（記録 #短縮 ID）」の要約を残す。確定は既存の承認フローで人が行う
 * （ここでは承認しない）。
 *
 *  - 権限: enterprise.data.write ＋ 記録の全拠点が担当拠点（算定の実行と同じ。RLS の拠点スコープと対）
 *  - 承認済みの値の上書き: 既存の確認と同じくレビュー権限（data.review か data.approve）が要り、さらに画面の
 *    確認（承認済みの値を下書きへ戻すこと）を求める。値の変更は承認後の変更（changedAfterApproval）として残す
 *  - 反映しないもの（理由を返す）: 入力が変わった記録・締め済みの期間・審査中（提出済み・レビュー中）の
 *    Data Point・同じ指標・拠点・期間に Data Point が 2 つ以上あるもの・指標マスターに無い指標
 *  - 同じ値なら新しい版を作らない（反映を繰り返しても版が増えない）
 *  - Scope3 カテゴリ4（既定区分の参考）は反映しない（Scope3 は本社の指標で集める。Scope1・2 の検証の範囲外）
 *  - 監査ログは既存の種類（下書き反映＝data_updated。Data Point ごと）
 */

/** 反映する区分（指標コードと同じ値）。Scope2 の 2 基準は別の指標のまま足さない */
export const POSTED_SCOPES = ['scope1', 'scope2', 'scope2_location'] as const;
export type PostedScope = (typeof POSTED_SCOPES)[number];

/** 反映の扱い（下見の表・確認ダイアログの内訳・結果の件数に同じ語を使う） */
export const POSTING_ACTIONS = [
  'create',
  'new_version',
  'approved_overwrite',
  'unchanged',
  'skip_in_review',
  'skip_ambiguous',
  'skip_no_metric',
] as const;
export type PostingAction = (typeof POSTING_ACTIONS)[number];

export const POSTING_ACTION_LABELS: Readonly<Record<PostingAction, string>> = {
  create: '新規作成',
  new_version: '新しい版',
  approved_overwrite: '承認済みの上書き（下書きに戻す）',
  unchanged: '変更なし',
  skip_in_review: '反映しない（審査中）',
  skip_ambiguous: '反映しない（Data Point が複数）',
  skip_no_metric: '反映しない（指標なし）',
};

/** 書き込む扱い */
const WRITING_ACTIONS: ReadonlySet<PostingAction> = new Set([
  'create',
  'new_version',
  'approved_overwrite',
]);

const EMISSION_UNIT = 't-CO2e';

/** 記録の短縮 ID（画面・算定内訳・版の出所に同じものを出す） */
export function runShortId(runId: Uuid): string {
  return runId.slice(0, 8);
}

export interface PostingTarget {
  unitId: Uuid;
  unitName: string;
  unitCode: string;
  scope: PostedScope;
  metricId: Uuid | null;
  metricName: string;
  /** 反映する値（報告区分・拠点×区分の段の丸め後。t-CO2e） */
  value: number;
  /** 同じ値の未丸め（t-CO2e） */
  unrounded: number;
  /** 反映先の Data Point（無ければ新規） */
  dataPoint: Pick<DataPoint, 'id' | 'status' | 'value' | 'unitOfMeasure' | 'boundary'> | null;
  action: PostingAction;
  /** 反映しない理由（skip_* のとき） */
  reason: string | null;
}

export interface RunPostingPlan {
  run: GhgCalculationRun;
  period: ReportingPeriod;
  inputState: RunInputState;
  targets: PostingTarget[];
  counts: Record<PostingAction, number>;
  /** 書き込む件数（新規・新しい版・承認済みの上書き） */
  postable: number;
  /** 記録の全体として反映できない理由（入力が変わった・締め済み）。null なら反映できる */
  blockedReason: string | null;
  /** 閲覧者が反映できない理由（権限・担当拠点）。null なら反映できる */
  permissionReason: string | null;
  /** 承認済みの値を上書きする権限（既存の確認: レビュー権限）があるか */
  canOverwriteApproved: boolean;
}

export interface RunPostingResult {
  runId: Uuid;
  created: number;
  updated: number;
  approvedOverwritten: number;
  unchanged: number;
  skipped: number;
  dataPointIds: Uuid[];
}

function emptyCounts(): Record<PostingAction, number> {
  return Object.fromEntries(POSTING_ACTIONS.map((a) => [a, 0])) as Record<PostingAction, number>;
}

/** 数値の登録と同じ境界の規則（全部連結の拠点は「連結」、それ以外は「単体」） */
function boundaryOf(unit: Pick<OrganizationUnit, 'consolidationMethod'>): string {
  return unit.consolidationMethod === 'full' ? '連結' : '単体';
}

function canEditApproved(ctx: AuthorizationContext): boolean {
  // data-point-workflow.ts の updateDataPointValue と DB の t4d.enforce_data_point_transition と同じ判定
  return can(ctx, 'enterprise.data.review') || can(ctx, 'enterprise.data.approve');
}

/** 閲覧者が記録を反映できない理由（画面の disabledReason。サービスの検査と同じ順） */
function permissionReasonFor(
  ctx: AuthorizationContext,
  units: readonly Pick<OrganizationUnit, 'id' | 'name'>[],
): string | null {
  if (ctx.workspace.organizationType !== 'enterprise')
    return '企業ワークスペースでのみ反映できます。';
  if (!can(ctx, 'enterprise.data.write')) {
    return 'Data Point への反映には、データを入力する権限が必要です。';
  }
  const outside = units.filter((u) => !isUnitInScope(ctx, u.id));
  if (outside.length > 0) {
    return `担当外の拠点（${outside.map((u) => u.name).join('・')}）を含む記録のため反映できません。`;
  }
  return null;
}

function decide(
  dp: DataPoint | null,
  candidates: number,
  value: number,
): { action: PostingAction; reason: string | null } {
  if (candidates > 1) {
    return {
      action: 'skip_ambiguous',
      reason:
        '同じ指標・拠点・期間の Data Point が 2 つ以上あります（どれに反映するかを決めません）。',
    };
  }
  if (!dp) return { action: 'create', reason: null };
  if (dp.status === 'submitted' || dp.status === 'in_review') {
    return {
      action: 'skip_in_review',
      reason:
        '審査中（提出済み・レビュー中）のため反映しません。差し戻されてから反映してください。',
    };
  }
  if (
    dp.value === value &&
    dp.unitOfMeasure === EMISSION_UNIT &&
    dp.availabilityStatus === 'value_present'
  ) {
    return { action: 'unchanged', reason: null };
  }
  if (dp.status === 'approved') return { action: 'approved_overwrite', reason: null };
  return { action: 'new_version', reason: null };
}

interface PlanInternals {
  plan: RunPostingPlan;
  metrics: Map<PostedScope, MetricDefinition>;
  units: Map<Uuid, OrganizationUnit>;
  dataPoints: Map<string, DataPoint>;
  lineCounts: Map<string, number>;
}

async function buildPlan(
  db: DbClient,
  ctx: AuthorizationContext,
  runId: Uuid,
): Promise<PlanInternals> {
  // 閲覧は企業のメンバー（enterprise.data.read）。他社・存在しない記録は「見つからない」
  const loaded = await loadRun(db, ctx, runId);
  const { run, inputState } = loaded;
  const organizationId = ctx.workspace.organizationId;
  const [period, metricRows, unitRows] = await Promise.all([
    db.findById('periods', run.reportingPeriodId),
    db.select('metrics', {
      where: { organizationId, code: { in: [...POSTED_SCOPES] }, deletedAt: { isNull: true } },
    }),
    db.select('units', { where: { organizationId, id: { in: run.unitIds } } }),
  ]);
  if (!period || period.organizationId !== organizationId) {
    throw new ValidationError('算定の記録の期間が見つかりません。');
  }
  const metrics = new Map<PostedScope, MetricDefinition>();
  for (const m of metricRows) {
    if ((POSTED_SCOPES as readonly string[]).includes(m.code))
      metrics.set(m.code as PostedScope, m);
  }
  const units = new Map(unitRows.map((u) => [u.id, u]));
  const metricIds = [...metrics.values()].map((m) => m.id);
  const existing =
    metricIds.length > 0
      ? await db.select('dataPoints', {
          where: {
            organizationId,
            reportingPeriodId: period.id,
            unitId: { in: run.unitIds },
            metricId: { in: metricIds },
            deletedAt: { isNull: true },
          },
        })
      : [];

  // 算定行の数（算定内訳の注記）。行は記録から読み直した値（Demo では作り直した行）
  const lineCounts = new Map<string, number>();
  for (const line of loaded.lines) {
    const key = `${line.unitId}|${line.reportedScope}|${line.activityKind}`;
    lineCounts.set(key, (lineCounts.get(key) ?? 0) + 1);
  }

  const blockedReason =
    !run.summary || inputState === 'input_changed'
      ? '入力が変わったため、この記録の数値を作り直せません。算定をやり直してから反映してください。'
      : inputState === 'stale'
        ? 'この記録の後に入力（係数・算定ルール・活動量）が変わりました。算定をやり直してから反映してください。'
        : period.status === 'closed'
          ? `締め済みの期間（${period.label}）には反映しません。`
          : null;

  const targets: PostingTarget[] = [];
  const dataPoints = new Map<string, DataPoint>();
  const sites = run.summary?.reported.sites ?? [];
  for (const unitId of run.unitIds) {
    const unit = units.get(unitId);
    if (!unit) continue;
    for (const scope of POSTED_SCOPES) {
      const site = sites.find((s) => s.unitId === unitId && s.scope === scope);
      // 算定行の無い区分は反映しない（0 として書かない。未入力と排出ゼロを混ぜない）
      if (!site) continue;
      const metric = metrics.get(scope) ?? null;
      if (!metric) {
        targets.push({
          unitId,
          unitName: unit.name,
          unitCode: unit.code,
          scope,
          metricId: null,
          metricName: GHG_SCOPE_LABELS[scope],
          value: site.rounded,
          unrounded: site.unrounded,
          dataPoint: null,
          action: 'skip_no_metric',
          reason: `指標マスターに ${scope} がありません。`,
        });
        continue;
      }
      const candidates = existing.filter(
        (dp) => dp.metricId === metric.id && dp.unitId === unitId && isCountedInTotals(dp),
      );
      const dp = candidates.length === 1 ? candidates[0]! : null;
      const decision = decide(dp, candidates.length, site.rounded);
      if (dp) dataPoints.set(`${unitId}|${scope}`, dp);
      targets.push({
        unitId,
        unitName: unit.name,
        unitCode: unit.code,
        scope,
        metricId: metric.id,
        metricName: metric.name,
        value: site.rounded,
        unrounded: site.unrounded,
        dataPoint: dp
          ? {
              id: dp.id,
              status: dp.status,
              value: dp.value,
              unitOfMeasure: dp.unitOfMeasure,
              boundary: dp.boundary,
            }
          : null,
        action: decision.action,
        reason: decision.reason,
      });
    }
  }
  const counts = emptyCounts();
  for (const t of targets) counts[t.action] += 1;
  const postable = targets.filter((t) => WRITING_ACTIONS.has(t.action)).length;
  return {
    plan: {
      run,
      period,
      inputState,
      targets,
      counts,
      postable,
      blockedReason,
      permissionReason: permissionReasonFor(ctx, [...units.values()]),
      canOverwriteApproved: canEditApproved(ctx),
    },
    metrics,
    units,
    dataPoints,
    lineCounts,
  };
}

/** 反映の範囲の下見（確認ダイアログの件数・画面の表。書き込まない） */
export async function planRunPosting(
  db: DbClient,
  ctx: AuthorizationContext,
  runId: Uuid,
): Promise<RunPostingPlan> {
  return (await buildPlan(db, ctx, runId)).plan;
}

function calculationInputs(
  run: GhgCalculationRun,
  unitId: Uuid,
  scope: PostedScope,
  lineCounts: Map<string, number>,
): CalculationInput[] {
  const short = runShortId(run.id);
  return (run.summary?.reported.siteActivities ?? [])
    .filter((s) => s.unitId === unitId && s.scope === scope)
    .map((s) => {
      const lines = lineCounts.get(`${unitId}|${scope}|${s.activityKind}`) ?? 0;
      return {
        label: `${ACTIVITY_KIND_LABELS[s.activityKind as GhgActivityKind]}（${GHG_SCOPE_LABELS[scope]}）`,
        value: s.rounded,
        unit: EMISSION_UNIT,
        sourceType: 'constant' as const,
        sourceId: null,
        note: `算定の記録 #${short}・算定行 ${lines} 行の合計（未丸め ${cleanFloat(s.unrounded)} ${EMISSION_UNIT}）`,
        activityAmount: null,
        activityUnit: null,
        dataClass: 'activity_based' as const,
      };
    });
}

/**
 * 算定の記録の報告区分の値を Data Point へ下書きとして反映する（承認しない）。
 * 承認済みの値を上書きするときは acknowledgeApprovedOverwrite（画面の確認）が要る
 */
export async function postRunToDataPoints(
  db: DbClient,
  ctx: AuthorizationContext,
  runId: Uuid,
  options: { view: 'reported'; acknowledgeApprovedOverwrite?: boolean },
): Promise<RunPostingResult> {
  assertEnterpriseWorkspace(ctx);
  // 既定区分（GHG プロトコル）は参考の値。報告に使うのは組織の算定ルールによる報告区分だけ
  if (options.view !== 'reported') {
    throw new ValidationError('Data Point へは報告区分の値だけを反映します。');
  }
  assertCan(ctx, 'enterprise.data.write');
  const internals = await buildPlan(db, ctx, runId);
  const { plan } = internals;
  for (const unitId of plan.run.unitIds) assertUnitInScope(ctx, unitId);
  if (plan.blockedReason) throw new ValidationError(plan.blockedReason);
  if (plan.counts.approved_overwrite > 0) {
    if (!canEditApproved(ctx)) {
      throw new AuthorizationError(
        '承認済みデータの変更にはレビュー権限が必要です。レビュー担当へ差戻しを依頼してください。',
      );
    }
    if (!options.acknowledgeApprovedOverwrite) {
      throw new ValidationError(
        `承認済みの値 ${plan.counts.approved_overwrite} 件を下書きに戻して反映します。確認の欄に印を付けてから反映してください。`,
      );
    }
  }
  if (plan.postable === 0) {
    throw new ValidationError(
      '反映する値がありません（すべて Data Point と同じ値か、反映できない状態です）。',
    );
  }

  const { run, period } = plan;
  const short = runShortId(run.id);
  const organizationId = ctx.workspace.organizationId;
  const result: RunPostingResult = {
    runId: run.id,
    created: 0,
    updated: 0,
    approvedOverwritten: 0,
    unchanged: plan.counts.unchanged,
    skipped: plan.counts.skip_in_review + plan.counts.skip_ambiguous + plan.counts.skip_no_metric,
    dataPointIds: [],
  };
  const sourceReference = `Scope1・2 の算定の記録 #${short}（${period.code}・報告区分）`;
  const methodology = `活動量 × 排出係数（Scope1・2 の算定の記録 #${short}・報告区分。値は算定方針の拠点×区分の段の丸め後）`;
  const changeReason = `算定の記録 #${short} からの下書き反映`;

  for (const target of plan.targets) {
    if (!WRITING_ACTIONS.has(target.action)) continue;
    const metric = internals.metrics.get(target.scope)!;
    const unit = internals.units.get(target.unitId)!;
    const now = new Date().toISOString();
    let dataPoint: DataPoint;
    let version: DataPointVersion;
    if (target.action === 'create') {
      const boundary = boundaryOf(unit);
      // ID は業務キー＋記録から作る（業務キーだけにすると、削除済みの行・Demo のリセットで消えた行の
      // 算定内訳が、同じ ID の新しい行に付いて見えてしまう）。同じ業務キーの行の有無は上で確かめている
      const dataPointId = fid(
        'data_point',
        `${organizationId}/${period.code}/${unit.code}/${metric.code}/${boundary}/${run.id}`,
      );
      const versionId = fid('data_point_version', `${dataPointId}/v1`);
      // Supabase Mode は呼び出しごとに別トランザクション。版より先に親を作り、ポインタは後で付ける
      await db.insert('dataPoints', [
        {
          id: dataPointId,
          organizationId,
          metricId: metric.id,
          unitId: unit.id,
          reportingPeriodId: period.id,
          boundary,
          status: 'draft',
          currentVersionId: null,
          value: target.value,
          textValue: null,
          unitOfMeasure: EMISSION_UNIT,
          methodology,
          ownerUserId: ctx.userId,
          reviewerUserId: null,
          approvedAt: null,
          approvedBy: null,
          changedAfterApproval: false,
          valueKind: 'actual',
          availabilityStatus: 'value_present',
          absenceReason: null,
          createdAt: now,
          updatedAt: now,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
          deletedAt: null,
        },
      ]);
      version = {
        id: versionId,
        dataPointId,
        organizationId,
        versionNo: 1,
        value: target.value,
        textValue: null,
        unitOfMeasure: EMISSION_UNIT,
        status: 'draft',
        valueKind: 'actual',
        availabilityStatus: 'value_present',
        absenceReason: null,
        sourceType: 'calculation',
        sourceReference,
        changeReason: null,
        contentHash: contentHash(`${dataPointId}|1|${target.value}|${EMISSION_UNIT}`),
        createdAt: now,
        createdBy: ctx.userId,
      };
      await db.insert('dataPointVersions', [version]);
      dataPoint = await db.update('dataPoints', dataPointId, { currentVersionId: versionId });
      result.created += 1;
    } else {
      const dp = internals.dataPoints.get(`${target.unitId}|${target.scope}`)!;
      const latest = await db.select('dataPointVersions', {
        where: { dataPointId: dp.id },
        orderBy: { column: 'versionNo', dir: 'desc' },
        limit: 1,
      });
      const versionNo = (latest[0]?.versionNo ?? 0) + 1;
      // 承認済み・未着手の値を変えたら下書きへ（承認はしない）。それ以外（下書き・差戻し）は状態を保つ
      const nextStatus: DataPointStatus =
        dp.status === 'approved' || dp.status === 'not_started' ? 'draft' : dp.status;
      version = {
        id: fid('data_point_version', `${dp.id}/v${versionNo}`),
        dataPointId: dp.id,
        organizationId: dp.organizationId,
        versionNo,
        value: target.value,
        textValue: null,
        unitOfMeasure: EMISSION_UNIT,
        status: nextStatus,
        valueKind: 'actual',
        availabilityStatus: 'value_present',
        absenceReason: null,
        sourceType: 'calculation',
        sourceReference,
        changeReason,
        contentHash: contentHash(`${dp.id}|${versionNo}|${target.value}|${EMISSION_UNIT}`),
        createdAt: now,
        createdBy: ctx.userId,
      };
      await db.insert('dataPointVersions', [version]);
      dataPoint = await db.update('dataPoints', dp.id, {
        value: target.value,
        textValue: null,
        unitOfMeasure: EMISSION_UNIT,
        valueKind: 'actual',
        availabilityStatus: 'value_present',
        absenceReason: null,
        methodology,
        currentVersionId: version.id,
        status: nextStatus,
        changedAfterApproval: dp.status === 'approved' ? true : dp.changedAfterApproval,
        updatedAt: now,
        updatedBy: ctx.userId,
      });
      if (target.action === 'approved_overwrite') result.approvedOverwritten += 1;
      else result.updated += 1;
    }

    const calculation: DataPointCalculation = {
      id: fid('calculation', `${dataPoint.id}/${contentHash(`${now}|${run.id}|${version.id}`)}`),
      dataPointId: dataPoint.id,
      organizationId,
      formula: `Σ 算定行（記録 #${short}）`,
      inputs: calculationInputs(run, target.unitId, target.scope, internals.lineCounts),
      result: target.value,
      resultUnit: EMISSION_UNIT,
      calculatedAt: now,
      calculatedBy: ctx.userId,
    };
    await db.insert('calculations', [calculation]);
    await recordAuditEvent(db, ctx, {
      eventType: 'data_updated',
      resourceType: 'data_point',
      resourceId: dataPoint.id,
      beforeSummary: target.dataPoint
        ? `${target.dataPoint.value ?? '—'} ${target.dataPoint.unitOfMeasure}`
        : null,
      afterSummary: `${target.value} ${EMISSION_UNIT}（v${version.versionNo}・${unit.name}・${metric.name}。算定の記録 #${short} から下書き反映）`,
      metadata: { runId: run.id, sourceType: 'calculation', action: target.action },
    });
    result.dataPointIds.push(dataPoint.id);
  }

  // 値の変更で検証結果（前年比・単位・Evidence の有無）が変わる。期間をまとめて 1 回だけ再計算する
  await recomputePeriodValidations(db, ctx, period);
  return result;
}
