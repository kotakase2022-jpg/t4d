import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan } from '@/lib/authorization/can';
import { getOpenAiConfig } from '@/lib/config';
import { fid } from '@/lib/fixtures/ids';
import type { DbClient } from '@/lib/repositories/types';
import type { AiRun, AiSourceReference, AuthorizationContext, Uuid } from '@/types/domain';
import { MockAIProvider } from './mock-provider';
import { PROMPT_VERSIONS, type AiFeature, type AiOutputOf } from './schemas';
import { AiProviderError, type AiInvocation, type AiProvider } from './types';

export * from './schemas';
export type { AiProvider, AiInvocation, AiResult } from './types';
export { AiProviderError } from './types';

let cachedProvider: AiProvider | null = null;

/**
 * 実行環境に応じた Provider を返す。
 * OPENAI_API_KEY が無ければ決定論的 Mock を使う（画面には Mock バッジを出す）。
 */
export async function getAiProvider(): Promise<AiProvider> {
  if (cachedProvider) return cachedProvider;
  const { apiKey } = getOpenAiConfig();
  if (!apiKey) {
    cachedProvider = new MockAIProvider();
    return cachedProvider;
  }
  const { OpenAIProvider } = await import('./openai-provider');
  cachedProvider = new OpenAIProvider();
  return cachedProvider;
}

/** テスト用に Provider を差し替える。 */
export function setAiProviderForTesting(provider: AiProvider | null): void {
  cachedProvider = provider;
}

// ----------------------------------------------------------------------
// Rate Limit（指示書 21 章「AI Call に Timeout、Retry、Rate Limit、Idempotency」）
// ----------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
/**
 * importMapping は「一括アップロード」という 1 ユーザー操作がファイル数分の
 * 呼び出しへ展開される（機能追加要望 ①: 50 ファイル一括取込）。
 * 既定の 30 回/分ではバッチそのものが失敗するため、この機能だけ上限を分ける。
 * 無制限にはしない（コストの暴走を防ぐ）。
 */
const RATE_LIMIT_MAX_BY_FEATURE: Partial<Record<AiFeature, number>> = {
  importMapping: 300,
};
const rateLimitBuckets = new Map<string, number[]>();

function checkRateLimit(organizationId: Uuid, feature: AiFeature): void {
  const now = Date.now();
  const key = `${organizationId}:${feature}`;
  const max = RATE_LIMIT_MAX_BY_FEATURE[feature] ?? RATE_LIMIT_MAX;
  const bucket = (rateLimitBuckets.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (bucket.length >= max) {
    throw new Error('AI 実行のレート制限に達しました。しばらく待ってから再試行してください。');
  }
  bucket.push(now);
  rateLimitBuckets.set(key, bucket);
}

// ----------------------------------------------------------------------
// Idempotency（同一入力の連続実行を抑止する）
// ----------------------------------------------------------------------

const inflight = new Map<string, Promise<unknown>>();

export interface RunAiOptions<F extends AiFeature> {
  db: DbClient;
  ctx: AuthorizationContext;
  invocation: AiInvocation<F>;
  sources: AiSourceReference[];
  engagementId?: Uuid | null;
  /** 同一キーの同時実行を 1 本にまとめる */
  idempotencyKey: string;
}

export interface RunAiResult<F extends AiFeature> {
  run: AiRun;
  output: AiOutputOf<F>;
}

/**
 * AI を実行し、Provenance（参照元・確信度・トークン・コスト・採否）を ai_runs へ記録する。
 *
 * 出力は「候補」であり、この関数は業務データを一切確定しない。
 */
export async function runAi<F extends AiFeature>(
  options: RunAiOptions<F>,
): Promise<RunAiResult<F>> {
  const { db, ctx, invocation, sources, idempotencyKey } = options;
  const organizationId = ctx.workspace.organizationId;

  const existing = inflight.get(idempotencyKey);
  if (existing) return (await existing) as RunAiResult<F>;

  const promise = (async (): Promise<RunAiResult<F>> => {
    checkRateLimit(organizationId, invocation.feature);
    const provider = await getAiProvider();
    const runId = fid('ai_run', `${idempotencyKey}|${Date.now()}`);
    const startedAt = new Date().toISOString();

    await recordAuditEvent(db, ctx, {
      eventType: 'ai_run_started',
      resourceType: 'ai_run',
      resourceId: runId,
      engagementId: options.engagementId ?? null,
      metadata: { feature: invocation.feature, provider: provider.kind },
    });

    try {
      const result = await provider.run(invocation);

      const run: AiRun = {
        id: runId,
        organizationId,
        jobId: null,
        featureType: invocation.feature,
        provider: result.provider,
        model: result.model,
        promptVersion: result.promptVersion,
        inputReferenceIds: invocation.inputReferenceIds,
        outputJson: result.output as unknown as Record<string, unknown>,
        sourceReferences: sources,
        confidence: (result.output as { confidence?: number }).confidence ?? 0,
        warnings: (result.output as { warnings?: string[] }).warnings ?? [],
        latencyMs: result.latencyMs,
        tokenUsage: result.tokenUsage,
        estimatedCostUsd: result.estimatedCostUsd,
        status: 'succeeded',
        errorMessage: null,
        engagementId: options.engagementId ?? null,
        reviewedBy: null,
        acceptedAt: null,
        rejectedAt: null,
        createdAt: startedAt,
        createdBy: ctx.userId,
      };

      await db.insert('aiRuns', [run]);
      await recordAuditEvent(db, ctx, {
        eventType: 'ai_run_completed',
        resourceType: 'ai_run',
        resourceId: runId,
        engagementId: options.engagementId ?? null,
        metadata: {
          feature: invocation.feature,
          provider: result.provider,
          confidence: run.confidence,
          latencyMs: result.latencyMs,
        },
      });

      return { run, output: result.output };
    } catch (error) {
      const message =
        error instanceof AiProviderError
          ? error.message
          : 'AI の実行に失敗しました。時間をおいて再試行してください。';

      await db.insert('aiRuns', [
        {
          id: runId,
          organizationId,
          jobId: null,
          featureType: invocation.feature,
          provider: provider.kind,
          model: provider.model,
          promptVersion: PROMPT_VERSIONS[invocation.feature],
          inputReferenceIds: invocation.inputReferenceIds,
          outputJson: {},
          sourceReferences: sources,
          confidence: 0,
          warnings: [],
          latencyMs: 0,
          tokenUsage: { input: 0, output: 0, total: 0 },
          estimatedCostUsd: 0,
          status: 'failed',
          errorMessage: message,
          engagementId: options.engagementId ?? null,
          reviewedBy: null,
          acceptedAt: null,
          rejectedAt: null,
          createdAt: startedAt,
          createdBy: ctx.userId,
        },
      ]);
      throw new Error(message, { cause: error });
    } finally {
      inflight.delete(idempotencyKey);
    }
  })();

  inflight.set(idempotencyKey, promise);
  return promise;
}

/** AI 出力の採否を記録する（採用・編集して採用・却下）。 */
export async function recordAiDecision(
  db: DbClient,
  ctx: AuthorizationContext,
  aiRunId: Uuid,
  decision: 'accepted' | 'edited_accepted' | 'rejected',
  comment: string | null,
): Promise<void> {
  // Server Action から渡る aiRunId は信頼しない。自組織の run 以外は 404 相当で拒否する
  // （Demo Mode の DbClient に行レベル防御は無く、ここが唯一の防御になる）。
  const target = await db.findById('aiRuns', aiRunId);
  if (!target || target.organizationId !== ctx.workspace.organizationId) {
    throw new Error('AI 実行が見つかりません。');
  }

  // 採否は「誰がいつ AI 下書きを採用しなかったか」という監査証跡になる。
  // 生成と同じ権限を要求する（CLAUDE.md §6「AI 出力は人の操作で確定する」の
  // 「人」を定義しないと、閲覧しかできないロールが証跡を確定できてしまう）。
  assertCan(
    ctx,
    target.featureType.startsWith('assurance') ? 'assurance.ai.run' : 'enterprise.ai.run',
  );

  const now = new Date().toISOString();
  await db.update('aiRuns', aiRunId, {
    status: decision === 'rejected' ? 'rejected' : 'accepted',
    reviewedBy: ctx.userId,
    acceptedAt: decision === 'rejected' ? null : now,
    rejectedAt: decision === 'rejected' ? now : null,
  });

  if (decision !== 'rejected') {
    await recordAuditEvent(db, ctx, {
      eventType: 'ai_output_accepted',
      resourceType: 'ai_run',
      resourceId: aiRunId,
      metadata: { decision, comment: comment ? 'あり' : 'なし' },
    });
  }
}
