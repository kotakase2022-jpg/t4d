import 'server-only';

import { runAi } from '@/lib/ai';
import type { InconsistencyCheckOutput } from '@/lib/ai/schemas';
import { assertCan, NotFoundError } from '@/lib/authorization/can';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AiRun,
  AiSourceReference,
  AuthorizationContext,
  FrameworkKey,
  ReportingPeriod,
  Uuid,
} from '@/types/domain';
import { loadDisclosureWorkspace, type DisclosureWorkspace } from './disclosure';

export type InconsistencyIssue = InconsistencyCheckOutput['issues'][number];

/**
 * 開示回答の整合チェック（CDP-P0-006）。
 *
 * 不足情報 / Evidence 不足 / 年度不一致 / 古い記述 / 回答間の矛盾を AI に検出させる。
 * **AI は指摘を出すだけ**で、回答の修正も承認も行わない（`docs/ai-safety.md`）。
 * 結果は `ai_runs.output_json` に残るため、後から同じ画面で読み直せる。
 */

export interface ConsistencyCheckResult {
  run: AiRun;
  issues: InconsistencyIssue[];
}

export async function runDisclosureConsistencyCheck(
  db: DbClient,
  ctx: AuthorizationContext,
  frameworkKey: FrameworkKey,
  period: ReportingPeriod,
  periods: ReportingPeriod[],
): Promise<ConsistencyCheckResult> {
  assertCan(ctx, 'enterprise.ai.run');

  const workspace = await loadDisclosureWorkspace(db, ctx, frameworkKey, period, periods, []);
  if (!workspace) throw new NotFoundError('開示フレームワークが見つかりません。');

  const { input, sources } = buildCheckInput(workspace);
  if (input.answers.length === 0) {
    throw new Error('チェック対象の回答がありません。先に回答を作成してください。');
  }

  const { run, output } = await runAi({
    db,
    ctx,
    // 二重送信は 1 実行へ合流させる（完了後の再実行は新しい run として記録される）
    idempotencyKey: `inconsistencyCheck:${ctx.workspace.organizationId}:${frameworkKey}:${period.id}`,
    sources,
    invocation: {
      feature: 'inconsistencyCheck',
      context: {
        organizationName: ctx.workspace.organizationName,
        reportingPeriodLabel: period.label,
      },
      inputReferenceIds: input.answers.map((a) => a.responseId).filter((id): id is Uuid => !!id),
      input,
    },
  });

  return { run, issues: output.issues };
}

/** 過去に実行した整合チェックの結果を読み直す。 */
export async function loadConsistencyCheck(
  db: DbClient,
  ctx: AuthorizationContext,
  runId: Uuid,
): Promise<ConsistencyCheckResult | null> {
  const run = await db.findById('aiRuns', runId);
  // 他組織の実行結果を runId 指定で覗けないようにする（Demo Mode には行レベル防御が無い）
  if (
    !run ||
    run.organizationId !== ctx.workspace.organizationId ||
    run.featureType !== 'inconsistencyCheck'
  ) {
    return null;
  }
  const issues = (run.outputJson.issues ?? []) as InconsistencyIssue[];
  return { run, issues };
}

interface CheckAnswer {
  responseId: Uuid | null;
  itemCode: string;
  questionText: string;
  section: string;
  status: string;
  answer: string | null;
  previousAnswer: string | null;
  currentValue: number | null;
  previousValue: number | null;
  evidenceCount: number;
  required: boolean;
  changeType: string;
}

function buildCheckInput(workspace: DisclosureWorkspace): {
  input: { periodLabel: string; previousPeriodLabel: string | null; answers: CheckAnswer[] };
  sources: AiSourceReference[];
} {
  const sources: AiSourceReference[] = [];
  const answers: CheckAnswer[] = [];

  for (const row of workspace.rows) {
    // 未着手かつ前年回答も無い質問はチェックしても指摘が出ないので送らない（Token の節約）
    if (!row.response && !row.previousResponse) continue;

    answers.push({
      responseId: row.response?.id ?? null,
      itemCode: row.item.code,
      questionText: row.item.questionText,
      section: row.item.section,
      status: row.response?.status ?? 'not_started',
      answer: row.response?.answerText ?? null,
      previousAnswer: row.previousResponse?.answerText ?? null,
      currentValue: row.currentValue,
      previousValue: row.previousValue,
      evidenceCount: row.evidenceCount,
      required: row.item.required,
      changeType: row.item.changeType,
    });

    if (row.response) {
      sources.push({
        kind: 'disclosure_response',
        id: row.response.id,
        label: `${row.item.code} 現在の回答`,
        locator: null,
        periodLabel: workspace.period.code,
      });
    }
    if (row.previousResponse) {
      sources.push({
        kind: 'previous_response',
        id: row.previousResponse.id,
        label: `${row.item.code} 前年度回答`,
        locator: null,
        periodLabel: workspace.previousPeriod?.code ?? null,
      });
    }
  }

  return {
    input: {
      periodLabel: workspace.period.label,
      previousPeriodLabel: workspace.previousPeriod?.label ?? null,
      answers,
    },
    sources,
  };
}
