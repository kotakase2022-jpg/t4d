import 'server-only';

import { runAi } from '@/lib/ai';
import type { InsightDiscoveryOutput } from '@/lib/ai/schemas';
import { safeAppLinkOrNull } from '@/lib/security/safe-link';
import { assertCan } from '@/lib/authorization/can';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AiRun,
  AiSourceReference,
  AuthorizationContext,
  ReportingPeriod,
  Uuid,
} from '@/types/domain';
import { collectOrgSnapshot } from './org-snapshot';

/**
 * AI Copilot インサイト（機能追加要望 ④）。
 *
 * 目的は「ユーザーが気づいていない・到達できない洞察の提供」。
 * 単一画面では見えない関係（拠点別の逆行トレンド、承認済みデータと開示回答の食い違い、
 * 締切と未完了作業の衝突など）を、組織全体のデータを横断して AI に発見させる。
 *
 * AI は洞察の**提示のみ**を行う。データ・回答・承認状態は一切書き換えない。
 * 結果は `ai_runs.output_json` に残り、`?insight=<runId>` で読み直せる。
 */

export type Insight = InsightDiscoveryOutput['insights'][number];

export interface InsightResult {
  run: AiRun;
  insights: Insight[];
}

export async function runInsightDiscovery(
  db: DbClient,
  ctx: AuthorizationContext,
  current: ReportingPeriod,
  periods: ReportingPeriod[],
): Promise<InsightResult> {
  assertCan(ctx, 'enterprise.ai.run');
  const organizationId = ctx.workspace.organizationId;

  // 組織横断スナップショット（Copilot 対話と共通。同じ事実に基づいて答える）
  const snapshot = await collectOrgSnapshot(db, ctx, current, periods);
  const { metricYoY } = snapshot;

  const sources: AiSourceReference[] = metricYoY.slice(0, 8).map((m) => ({
    kind: 'data_point',
    id: null,
    label: `${m.metricName}（承認済み集計）`,
    locator: null,
    periodLabel: current.code,
  }));

  const { run, output } = await runAi({
    db,
    ctx,
    // 同一期間の二重送信は 1 実行へ合流させる（実行完了後の再実行は新しい run になる）
    idempotencyKey: `insightDiscovery:${organizationId}:${current.id}`,
    sources,
    invocation: {
      feature: 'insightDiscovery',
      context: {
        organizationName: ctx.workspace.organizationName,
        reportingPeriodLabel: current.label,
      },
      inputReferenceIds: [current.id],
      input: { ...snapshot },
    },
  });

  return { run, insights: sanitizeInsights(output.insights) };
}

/**
 * AI 出力の link はアプリ内パスのみ許可する。
 * 実 Provider（LLM）が外部 URL や javascript: を返しても画面に描画させない。
 */
function sanitizeInsights(insights: Insight[]): Insight[] {
  return insights.map((insight) => ({
    ...insight,
    link: safeAppLinkOrNull(insight.link),
  }));
}

/** 過去に実行したインサイトを読み直す。他組織・別 feature の runId は読めない。 */
export async function loadInsightResult(
  db: DbClient,
  ctx: AuthorizationContext,
  runId: Uuid,
): Promise<InsightResult | null> {
  const run = await db.findById('aiRuns', runId);
  if (
    !run ||
    run.organizationId !== ctx.workspace.organizationId ||
    run.featureType !== 'insightDiscovery'
  ) {
    return null;
  }
  return { run, insights: sanitizeInsights((run.outputJson.insights ?? []) as Insight[]) };
}
