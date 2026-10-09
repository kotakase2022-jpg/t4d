import 'server-only';

import { randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import { NotFoundError } from '@/lib/authorization/can';
import { roleLabel } from '@/lib/authorization/roles';
import { getBuildInfo } from '@/lib/build-info';
import { asSnapshotDetail } from '@/lib/domain/report-snapshot-content';
import { buildReportTrace } from '@/lib/domain/report-trace';
import {
  completionRate,
  effectiveRuns,
  formatRatePercent,
  inquiryCount,
  judgementStateOf,
  latestJudgement,
  passRate,
  rateOf,
  type InquiryResult,
  type JudgementStateValue,
  type PassRateResult,
  type RateResult,
} from '@/lib/domain/trial-metrics';
import { ValidationError } from '@/lib/errors/user-facing';
import type { DbClient } from '@/lib/repositories/types';
import { loadRequirementMatrix } from '@/lib/services/requirement-matrix';
import {
  assertActiveMember,
  assertTrialManager,
  assertTrialReader,
  checkedText,
  loadTrialProgram,
  trialTextLimits,
} from '@/lib/services/trial-program';
import { isUuid } from '@/lib/validation/uuid';
import {
  TRIAL_COMPLETIONS,
  TRIAL_JUDGEMENTS,
  type AuthorizationContext,
  type TrialCompletion,
  type TrialJudgement,
  type TrialProgram,
  type TrialScenario,
  type TrialScenarioJudgement,
  type TrialScenarioRun,
  type TrialTheme,
  type Uuid,
} from '@/types/domain';

/**
 * 検証シナリオ・実施記録・評価者の判定（トライアル対応 NF-33。スライド 10 の評価 #1〜#6 の記録の器）。
 *
 *  - 実施の記録は組織の有効なメンバー本人の名義（追記専用。訂正は supersedes で新しい記録を足す）
 *  - 判定は enterprise.org.manage（追記専用で取り消せない。理由必須）。測定値の候補はアプリが出すが、
 *    判定は人が決める（候補をそのまま判定にしない）
 *  - 自力完遂率・問い合わせ回数・合格率は件数（n）と一緒に出し、n < 3 では率を出さない（trial-metrics.ts）
 *  - 「業務の完遂状況」は既存の業務記録（取込・レビュー・承認段階）を読むだけ。操作は自動で追跡しない
 *  - 記録には環境の版（ビルド）を自動で添える（NF-31）
 */

export interface ScenarioRunView extends TrialScenarioRun {
  /** 新しい記録で訂正された（数えない） */
  superseded: boolean;
  /** 実施者の表示名（組織メンバーの名前。出力には入れない） */
  performerName: string;
}

export interface ScenarioRow {
  scenario: TrialScenario;
  runs: ScenarioRunView[];
  /** 訂正を除いた実施 */
  effectiveRunCount: number;
  completion: RateResult;
  inquiry: InquiryResult;
  judgements: TrialScenarioJudgement[];
  latest: TrialScenarioJudgement | null;
  state: JudgementStateValue;
}

export interface ScenarioSummary {
  rows: ScenarioRow[];
  /** 全シナリオの自力完遂率（訂正を除く実施すべて） */
  completion: RateResult;
  inquiry: InquiryResult;
  pass: PassRateResult;
  runCount: number;
}

/** シナリオと実施・判定の集計（閲覧は組織メンバー） */
export async function summarizeScenarios(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<ScenarioSummary> {
  assertTrialReader(ctx);
  const organizationId = ctx.workspace.organizationId;
  const [scenarios, runs, judgements] = await Promise.all([
    db.select('trialScenarios', {
      where: { organizationId, deletedAt: { isNull: true } },
      orderBy: [
        { column: 'sortOrder', dir: 'asc' },
        { column: 'code', dir: 'asc' },
      ],
    }),
    db.select('trialScenarioRuns', {
      where: { organizationId },
      orderBy: { column: 'createdAt', dir: 'desc' },
    }),
    db.select('trialScenarioJudgements', {
      where: { organizationId },
      orderBy: { column: 'judgedAt', dir: 'desc' },
    }),
  ]);
  const performerIds = [...new Set(runs.map((r) => r.performedBy))];
  const profiles =
    performerIds.length > 0
      ? await db.select('profiles', { where: { id: { in: performerIds } } })
      : [];
  const effective = effectiveRuns(runs);
  const effectiveIds = new Set(effective.map((r) => r.id));

  const rows: ScenarioRow[] = scenarios.map((scenario) => {
    const own = runs.filter((r) => r.scenarioId === scenario.id);
    const ownEffective = own.filter((r) => effectiveIds.has(r.id));
    const ownJudgements = judgements.filter((j) => j.scenarioId === scenario.id);
    const latest = latestJudgement(ownJudgements, scenario.id);
    return {
      scenario,
      runs: own.map((run) => ({
        ...run,
        superseded: !effectiveIds.has(run.id),
        performerName: profiles.find((p) => p.id === run.performedBy)?.displayName ?? 'メンバー',
      })),
      effectiveRunCount: ownEffective.length,
      completion: completionRate(ownEffective),
      inquiry: inquiryCount(ownEffective),
      judgements: ownJudgements,
      latest,
      state: judgementStateOf(latest),
    };
  });
  const live = effective.filter((r) => scenarios.some((s) => s.id === r.scenarioId));
  return {
    rows,
    completion: completionRate(live),
    inquiry: inquiryCount(live),
    pass: passRate(rows.map((r) => r.state)),
    runCount: live.length,
  };
}

async function loadScenario(
  db: DbClient,
  ctx: AuthorizationContext,
  scenarioId: string,
): Promise<TrialScenario> {
  const rows = isUuid(scenarioId)
    ? await db.select('trialScenarios', {
        where: {
          id: scenarioId,
          organizationId: ctx.workspace.organizationId,
          deletedAt: { isNull: true },
        },
        limit: 1,
      })
    : [];
  const scenario = rows[0];
  if (!scenario) throw new NotFoundError('シナリオが見つかりません。');
  return scenario;
}

/** 証跡の URL（アプリ内の相対パスだけ。外部の URL・スキームは受け付けない） */
export function checkedEvidenceUrl(value: string | null | undefined): string {
  const text = (value ?? '').trim();
  if (text === '') return '';
  if (!text.startsWith('/') || text.startsWith('//') || /[\s\\]/.test(text) || text.length > 200) {
    throw new ValidationError(
      '証跡はアプリ内の画面のパス（/ で始まる 200 字以内。例: /enterprise/data）で入力してください。',
    );
  }
  return text;
}

function optionalInteger(
  value: number | null | undefined,
  label: string,
  min: number,
  max: number,
): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${label}は ${min}〜${max} の整数で入力してください。`);
  }
  return value;
}

export interface ScenarioRunInput {
  scenarioId: string;
  completion: string;
  minutes: number | null;
  helpCount: number | null;
  easeRating: number | null;
  comment: string;
  evidenceUrl: string;
  /** 訂正する自分の前の記録 */
  supersedesRunId?: string | null;
}

/** 実施者の役割名（業務の役割。権限キーではない） */
function performedRoleOf(ctx: AuthorizationContext): string {
  const names = ctx.workspace.roleKeys.map((key) => roleLabel(key));
  return names.join('・').slice(0, 60);
}

/** シナリオの実施を記録する（本人名義・追記専用）。監査ログ data_created（trial_scenario_run） */
export async function recordScenarioRun(
  db: DbClient,
  ctx: AuthorizationContext,
  input: ScenarioRunInput,
): Promise<TrialScenarioRun> {
  await assertActiveMember(db, ctx);
  const limits = trialTextLimits(db, ctx);
  const scenario = await loadScenario(db, ctx, input.scenarioId);
  if (!(TRIAL_COMPLETIONS as readonly string[]).includes(input.completion)) {
    throw new ValidationError('完了の区分を選んでください。');
  }
  const minutes = input.minutes;
  if (minutes !== null && (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440)) {
    throw new ValidationError('所要時間は 0〜1,440 分で入力してください。');
  }
  const helpCount = optionalInteger(input.helpCount, '問い合わせ回数', 0, 99) ?? 0;
  const easeRating = optionalInteger(input.easeRating, '分かりやすさ', 1, 5);
  const comment = checkedText(input.comment, 'コメント', limits.text);
  const evidenceUrl = checkedEvidenceUrl(input.evidenceUrl);

  let supersedesRunId: Uuid | null = null;
  if (input.supersedesRunId) {
    const previous = isUuid(input.supersedesRunId)
      ? await db.findById('trialScenarioRuns', input.supersedesRunId)
      : null;
    if (
      !previous ||
      previous.organizationId !== ctx.workspace.organizationId ||
      previous.scenarioId !== scenario.id
    ) {
      throw new NotFoundError('訂正する記録が見つかりません。');
    }
    if (previous.performedBy !== ctx.userId) {
      throw new ValidationError('訂正できるのは自分の記録だけです。');
    }
    supersedesRunId = previous.id;
  }

  const now = new Date();
  const endedAt = now.toISOString();
  const startedAt =
    minutes !== null ? new Date(now.getTime() - Math.round(minutes * 60_000)).toISOString() : null;
  const row: TrialScenarioRun = {
    id: randomUUID(),
    organizationId: ctx.workspace.organizationId,
    scenarioId: scenario.id,
    performedBy: ctx.userId,
    performedRole: performedRoleOf(ctx),
    startedAt,
    endedAt,
    // DB は小数 1 桁（numeric(8,1)）
    minutes: minutes === null ? null : Math.round(minutes * 10) / 10,
    completion: input.completion as TrialCompletion,
    helpCount,
    easeRating,
    comment,
    evidence: evidenceUrl ? { url: evidenceUrl } : {},
    environmentVersion: getBuildInfo().commit,
    supersedesRunId,
    createdAt: endedAt,
  };
  const [inserted] = await db.insert('trialScenarioRuns', [row]);
  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'trial_scenario_run',
    resourceId: row.id,
    afterSummary: `シナリオ ${scenario.code} の実施を記録${supersedesRunId ? '（訂正）' : ''}`,
  });
  return inserted ?? row;
}

export interface JudgementInput {
  scenarioId: string;
  judgement: string;
  reason: string;
  measuredValue: string;
}

/** 評価者の判定を記録する（org.manage・追記専用・取り消せない）。監査ログ data_created（trial_scenario_judgement） */
export async function judgeScenario(
  db: DbClient,
  ctx: AuthorizationContext,
  input: JudgementInput,
): Promise<TrialScenarioJudgement> {
  assertTrialManager(ctx);
  const limits = trialTextLimits(db, ctx);
  const scenario = await loadScenario(db, ctx, input.scenarioId);
  if (!(TRIAL_JUDGEMENTS as readonly string[]).includes(input.judgement)) {
    throw new ValidationError('判定（合格・不合格・保留）を選んでください。');
  }
  const reason = checkedText(input.reason, '判定の理由', limits.text, { required: true });
  // 測定値は短い表記（例: 追跡率 100%（6 / 6））。Demo の Cookie の上限に合わせる
  const measuredValue = checkedText(input.measuredValue, '測定値', 60);
  const row: TrialScenarioJudgement = {
    id: randomUUID(),
    organizationId: ctx.workspace.organizationId,
    scenarioId: scenario.id,
    judgement: input.judgement as TrialJudgement,
    reason,
    measuredValue,
    judgedBy: ctx.userId,
    judgedAt: new Date().toISOString(),
  };
  const [inserted] = await db.insert('trialScenarioJudgements', [row]);
  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'trial_scenario_judgement',
    resourceId: row.id,
    afterSummary: `シナリオ ${scenario.code} の判定を記録`,
    metadata: { environment: getBuildInfo().commit },
  });
  return inserted ?? row;
}

// ----------------------------------------------------------------------
// 測定値の候補（判定は人。候補は判定の欄に初期値として出すだけ）
// ----------------------------------------------------------------------

export interface MeasuredCandidate {
  /** 判定の欄に入れる短い値（60 字以内） */
  value: string | null;
  /** 何から出したか（1 行） */
  source: string;
}

export type MeasuredCandidates = Partial<Record<TrialTheme, MeasuredCandidate>>;

/** #1 追跡率: 承認済みスナップショット（対象プロジェクトのもの優先）の写しだけから、選定ケースで絞って数える */
async function traceCandidate(
  db: DbClient,
  ctx: AuthorizationContext,
  program: TrialProgram | null,
): Promise<MeasuredCandidate> {
  const organizationId = ctx.workspace.organizationId;
  const snapshots = await db.select('reportSnapshots', {
    where: { organizationId, snapshotKind: 'approved' },
    orderBy: { column: 'createdAt', dir: 'desc' },
  });
  const snapshot =
    snapshots.find((s) => program?.projectId && s.projectId === program.projectId) ??
    snapshots[0] ??
    null;
  if (!snapshot) return { value: null, source: '承認済みのスナップショットがありません' };
  const detail = asSnapshotDetail(snapshot);
  const versions =
    detail.narrativeVersionIds.length > 0
      ? await db.select('narrativeVersions', {
          where: { organizationId, id: { in: detail.narrativeVersionIds } },
        })
      : [];
  const selectedIds = program?.selectedRequirementItemIds ?? [];
  const items =
    selectedIds.length > 0
      ? await db.select('disclosureItems', { where: { id: { in: selectedIds } } })
      : [];
  const selectedCodes = [...new Set(items.map((i) => i.code))];
  const trace = buildReportTrace(
    {
      blocks: detail.blocks,
      metricValues: detail.metricValues,
      narrativeVersionsWithEvidence: new Set(
        versions.filter((v) => v.sourceAnchorIds.length > 0).map((v) => v.id),
      ),
    },
    selectedCodes.length > 0 ? { selectedCodes } : {},
  );
  const scope = selectedCodes.length > 0 ? `選定ケース ${selectedCodes.length} 件` : '全件';
  if (trace.summary.rate === null) {
    return { value: null, source: `「${snapshot.label}」に追跡の単位がありません（${scope}）` };
  }
  const { traceable, total } = trace.summary.all;
  return {
    value: `追跡率 ${formatRatePercent(trace.summary.rate)}（${traceable} / ${total}）`,
    source: `「${snapshot.label}」の写しから（${scope}・${trace.summary.label}）`,
  };
}

/** #4 不一致件数: 最新の突合の記録 */
async function reconciliationCandidate(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<MeasuredCandidate> {
  const rows = await db.select('exportReconciliations', {
    where: { organizationId: ctx.workspace.organizationId },
    orderBy: { column: 'createdAt', dir: 'desc' },
    limit: 1,
  });
  const latest = rows[0];
  if (!latest) return { value: null, source: '出力の突合の記録がありません' };
  return {
    value: `不一致 ${latest.mismatchCount} 件（段落 ${latest.paragraphsChecked}・数値 ${latest.numbersChecked}）`,
    source: '最新の出力の突合の記録から',
  };
}

/** #2 未判定の件数: 対象プロジェクトの要求事項・情報対応表（全件） */
async function undeterminedCandidate(
  db: DbClient,
  ctx: AuthorizationContext,
  program: TrialProgram | null,
): Promise<MeasuredCandidate> {
  if (!program?.projectId) return { value: null, source: '対象プロジェクトが未設定です' };
  const matrix = await loadRequirementMatrix(db, ctx, { projectId: program.projectId });
  const counted = matrix.frameworks.filter((f) => f.mode === 'rows');
  if (counted.length === 0) return { value: null, source: '要求事項を収録した基準がありません' };
  const total = counted.reduce((sum, f) => sum + f.total, 0);
  const undetermined = counted.reduce((sum, f) => sum + f.counts.undetermined, 0);
  return {
    value: `未判定 ${undetermined} 件 / ${total} 件`,
    source: '対象プロジェクトの要求事項・情報対応表から',
  };
}

async function safely(run: () => Promise<MeasuredCandidate>): Promise<MeasuredCandidate> {
  try {
    return await run();
  } catch {
    return { value: null, source: '候補を算出できませんでした（判定は手で入力してください）' };
  }
}

/** 測定値の候補（判定する人だけに出す）。失敗しても画面を止めない */
export async function measuredValueCandidates(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<MeasuredCandidates> {
  assertTrialManager(ctx);
  const program = await loadTrialProgram(db, ctx);
  const [traceability, outputReuse, gapDistinction] = await Promise.all([
    safely(() => traceCandidate(db, ctx, program)),
    safely(() => reconciliationCandidate(db, ctx)),
    safely(() => undeterminedCandidate(db, ctx, program)),
  ]);
  return {
    traceability,
    output_reuse: outputReuse,
    gap_distinction: gapDistinction,
  };
}

// ----------------------------------------------------------------------
// 業務の完遂状況（既存の業務記録から算出。操作の自動追跡はしない）
// ----------------------------------------------------------------------

export interface BusinessCompletion {
  /** データ取込（取込ジョブ）の確定率 */
  ingestion: RateResult;
  /** 標準 CSV の確定率 */
  standardImport: RateResult;
  /** 原稿のレビュー: 差戻しの回数と依頼の件数 */
  review: { returned: number; requests: number; perRequest: number | null; label: string };
  /** データの承認段階の差戻し率 */
  dataReturn: RateResult;
}

export async function businessCompletion(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<BusinessCompletion> {
  assertTrialReader(ctx);
  const organizationId = ctx.workspace.organizationId;
  const [jobs, batches, events, steps] = await Promise.all([
    db.select('ingestionJobs', { where: { organizationId } }),
    db.select('quantitativeImportBatches', { where: { organizationId } }),
    db.select('reviewEvents', { where: { organizationId } }),
    db.select('dataPointApprovalSteps', { where: { organizationId } }),
  ]);
  const liveJobs = jobs.filter((j) => j.status !== 'cancelled');
  const requests = new Set(
    events.filter((e) => e.eventType === 'requested').map((e) => e.reviewRequestId),
  ).size;
  const returned = events.filter((e) => e.eventType === 'returned').length;
  const decidedSteps = steps.filter((s) => s.status === 'approved' || s.status === 'returned');
  const perRequest = requests > 0 ? returned / requests : null;
  return {
    ingestion: rateOf(liveJobs.filter((j) => j.status === 'completed').length, liveJobs.length),
    standardImport: rateOf(batches.filter((b) => b.status === 'committed').length, batches.length),
    review: {
      returned,
      requests,
      perRequest,
      label:
        perRequest === null
          ? '記録なし'
          : `1 依頼あたり ${(Math.round(perRequest * 10) / 10).toFixed(1)} 回（差戻し ${returned} 回 / 依頼 ${requests} 件）`,
    },
    dataReturn: rateOf(
      decidedSteps.filter((s) => s.status === 'returned').length,
      decidedSteps.length,
    ),
  };
}
