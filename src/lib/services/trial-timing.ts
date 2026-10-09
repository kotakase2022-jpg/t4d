import 'server-only';

import { randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import { NotFoundError } from '@/lib/authorization/can';
import {
  effectiveTimings,
  perUnitMinutes,
  reductionTargetOf,
  summarizeTimingsByTask,
  TRIAL_TASK_LABELS,
  type ReductionTarget,
  type TaskReduction,
} from '@/lib/domain/trial-metrics';
import { ValidationError } from '@/lib/errors/user-facing';
import type { DbClient } from '@/lib/repositories/types';
import {
  assertActiveMember,
  assertTrialReader,
  checkedDate,
  checkedText,
  loadTrialProgram,
  trialTextLimits,
} from '@/lib/services/trial-program';
import { isUuid } from '@/lib/validation/uuid';
import {
  TRIAL_TASK_KEYS,
  TRIAL_TIMING_METHODS,
  TRIAL_TIMING_MODES,
  type AuthorizationContext,
  type TrialTaskKey,
  type TrialTaskTiming,
  type TrialTimingMethod,
  type TrialTimingMode,
  type Uuid,
} from '@/types/domain';

/**
 * 作業時間（現行 vs T4D。トライアル対応 NF-35。スライド 10 の評価 #6）。
 *
 *  - 記録は組織の有効なメンバー本人の名義（追記専用。訂正は supersedes で新しい行を足す）
 *  - 作業ごとに 1 単位あたりの分の中央値・件数・測り方を出し、両方 n ≥ 3 のときだけ短縮率を出す
 *  - 「記録からの推定」は待ち時間を含む参考値として印を付ける。目標は計画の値を別に出す（結果と混ぜない）
 */

export interface TimingInput {
  taskKey: string;
  mode: string;
  method: string;
  minutes: number | null;
  quantity: number | null;
  unitLabel: string;
  department: string;
  measuredOn: string | null;
  note: string;
  scenarioRunId?: string | null;
  /** 訂正する自分の前の記録 */
  supersedesId?: string | null;
}

function oneOf<T extends string>(values: readonly T[], value: unknown, message: string): T {
  if (typeof value === 'string' && (values as readonly string[]).includes(value)) return value as T;
  throw new ValidationError(message);
}

/** 作業時間を記録する（本人名義・追記専用）。監査ログ data_created（trial_task_timing） */
export async function recordTaskTiming(
  db: DbClient,
  ctx: AuthorizationContext,
  input: TimingInput,
): Promise<TrialTaskTiming> {
  await assertActiveMember(db, ctx);
  const organizationId = ctx.workspace.organizationId;
  const limits = trialTextLimits(db, ctx);
  const taskKey = oneOf<TrialTaskKey>(TRIAL_TASK_KEYS, input.taskKey, '作業を選んでください。');
  const mode = oneOf<TrialTimingMode>(
    TRIAL_TIMING_MODES,
    input.mode,
    '現行か T4D かを選んでください。',
  );
  const method = oneOf<TrialTimingMethod>(
    TRIAL_TIMING_METHODS,
    input.method,
    '測り方を選んでください。',
  );
  const minutes = input.minutes;
  if (minutes === null || !Number.isFinite(minutes) || minutes < 0 || minutes > 100_000) {
    throw new ValidationError('所要時間（分）を 0〜100,000 の数値で入力してください。');
  }
  const quantity = input.quantity ?? 1;
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100_000) {
    throw new ValidationError('数量は 0 より大きい数値で入力してください。');
  }
  const measuredOn = checkedDate(input.measuredOn, '測定日');
  if (!measuredOn) throw new ValidationError('測定日を入力してください。');

  let scenarioRunId: Uuid | null = null;
  if (input.scenarioRunId) {
    const run = isUuid(input.scenarioRunId)
      ? await db.findById('trialScenarioRuns', input.scenarioRunId)
      : null;
    if (!run || run.organizationId !== organizationId) {
      throw new NotFoundError('関連する実施記録が見つかりません。');
    }
    scenarioRunId = run.id;
  }
  let supersedesId: Uuid | null = null;
  if (input.supersedesId) {
    const previous = isUuid(input.supersedesId)
      ? await db.findById('trialTaskTimings', input.supersedesId)
      : null;
    if (!previous || previous.organizationId !== organizationId) {
      throw new NotFoundError('訂正する記録が見つかりません。');
    }
    if (previous.recordedBy !== ctx.userId) {
      throw new ValidationError('訂正できるのは自分の記録だけです。');
    }
    supersedesId = previous.id;
  }

  const row: TrialTaskTiming = {
    id: randomUUID(),
    organizationId,
    taskKey,
    mode,
    unitLabel: checkedText(input.unitLabel, '単位', limits.title),
    quantity,
    minutes,
    method,
    department: checkedText(input.department, '部署', limits.title),
    measuredOn,
    scenarioRunId,
    supersedesId,
    note: checkedText(input.note, 'メモ', limits.text),
    recordedBy: ctx.userId,
    createdAt: new Date().toISOString(),
  };
  const [inserted] = await db.insert('trialTaskTimings', [row]);
  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'trial_task_timing',
    resourceId: row.id,
    afterSummary: `作業時間を記録（${TRIAL_TASK_LABELS[taskKey]}・${mode === 'baseline' ? '現行' : 'T4D'}）${
      supersedesId ? '（訂正）' : ''
    }`,
  });
  return inserted ?? row;
}

export interface TimingRecordView extends TrialTaskTiming {
  perUnitMinutes: number;
  superseded: boolean;
  recorderName: string;
}

export interface TimingSummary {
  tasks: TaskReduction[];
  records: TimingRecordView[];
  target: ReductionTarget | null;
}

/** 作業時間の集計と記録の一覧（閲覧は組織メンバー） */
export async function summarizeTimings(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<TimingSummary> {
  assertTrialReader(ctx);
  const organizationId = ctx.workspace.organizationId;
  const [rows, program] = await Promise.all([
    db.select('trialTaskTimings', {
      where: { organizationId },
      orderBy: [
        { column: 'measuredOn', dir: 'desc' },
        { column: 'createdAt', dir: 'desc' },
      ],
    }),
    loadTrialProgram(db, ctx),
  ]);
  const recorderIds = [...new Set(rows.map((r) => r.recordedBy))];
  const profiles =
    recorderIds.length > 0
      ? await db.select('profiles', { where: { id: { in: recorderIds } } })
      : [];
  const effective = new Set(effectiveTimings(rows).map((r) => r.id));
  return {
    tasks: summarizeTimingsByTask(rows),
    records: rows.map((row) => ({
      ...row,
      perUnitMinutes: perUnitMinutes(row),
      superseded: !effective.has(row.id),
      recorderName: profiles.find((p) => p.id === row.recordedBy)?.displayName ?? 'メンバー',
    })),
    target: program ? reductionTargetOf(program.options) : null,
  };
}
