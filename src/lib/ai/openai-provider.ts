import 'server-only';

import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { getOpenAiConfig } from '@/lib/config';
import { AI_FEATURE_INSTRUCTIONS, AI_SYSTEM_PROMPT } from './prompt';
import { AI_SCHEMAS, PROMPT_VERSIONS, type AiFeature, type AiOutputOf } from './schemas';
import { AiProviderError, type AiInvocation, type AiProvider, type AiResult } from './types';

/**
 * OpenAI Provider（公式 SDK / Responses API / 構造化出力）。
 *
 * 制約（指示書 14 章）:
 *  - Server Side のみ。API Key を Client Component へ渡さない。
 *  - Model 名は環境変数で差し替え可能にし、コードへ固定しすぎない。
 *  - Timeout / Retry / 構造化出力を必須にする。
 *  - Prompt へ Client Secret・API Key・権限外 Evidence を含めない
 *    （呼び出し側が権限内の情報だけを `input` に詰める責務を負う）。
 */

/**
 * 概算コスト（USD / 1M tokens）。実請求額とは異なる目安。
 *
 * ここに無い Model は**推測しない**。以前は未登録 Model に gpt-4.1-mini の単価を
 * 当てていたが、それでは `ai_runs.estimated_cost_usd` に**誤った金額**が残る。
 * 未登録なら 0（＝未算定）を記録し、画面は「—」と表示する。
 * 新しい Model を使うときは、公式の価格表を確認してからここへ追記すること。
 */
const COST_PER_MTOK: Record<string, { input: number; output: number }> = {
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
};

function estimateCost(model: string, input: number, output: number): number {
  const rate = COST_PER_MTOK[model];
  if (!rate) return 0;
  return Number(((input / 1_000_000) * rate.input + (output / 1_000_000) * rate.output).toFixed(6));
}

export class OpenAIProvider implements AiProvider {
  readonly kind = 'openai' as const;
  readonly model: string;
  private readonly client: OpenAI;

  constructor() {
    const config = getOpenAiConfig();
    if (!config.apiKey) {
      throw new AiProviderError(
        'OPENAI_API_KEY が設定されていません。MockAIProvider を使用してください。',
        'importMapping',
      );
    }
    this.model = config.model;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      timeout: config.timeoutMs,
      maxRetries: config.maxRetries,
    });
  }

  async run<F extends AiFeature>(invocation: AiInvocation<F>): Promise<AiResult<F>> {
    const schema = AI_SCHEMAS[invocation.feature];
    const startedAt = Date.now();

    const userContent = [
      `# 依頼`,
      AI_FEATURE_INSTRUCTIONS[invocation.feature],
      '',
      `# コンテキスト`,
      `- 組織: ${invocation.context.organizationName}`,
      `- 対象期間: ${invocation.context.reportingPeriodLabel}`,
      ...(invocation.context.engagementLabel
        ? [`- 保証案件: ${invocation.context.engagementLabel}`]
        : []),
      '',
      `# 入力データ（この範囲の情報だけを使うこと）`,
      '```json',
      JSON.stringify(invocation.input, null, 2),
      '```',
    ].join('\n');

    try {
      const response = await this.client.responses.parse({
        model: this.model,
        input: [
          { role: 'system', content: AI_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        text: { format: zodTextFormat(schema, invocation.feature) },
      });

      const parsed = response.output_parsed;
      if (!parsed) {
        throw new AiProviderError('構造化出力を取得できませんでした。', invocation.feature);
      }

      const validated = schema.safeParse(parsed);
      if (!validated.success) {
        throw new AiProviderError(
          `出力がスキーマに適合しませんでした: ${validated.error.message}`,
          invocation.feature,
        );
      }

      const inputTokens = response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;

      return {
        output: validated.data as AiOutputOf<F>,
        provider: 'openai',
        model: this.model,
        promptVersion: PROMPT_VERSIONS[invocation.feature],
        latencyMs: Date.now() - startedAt,
        tokenUsage: {
          input: inputTokens,
          output: outputTokens,
          total: inputTokens + outputTokens,
        },
        estimatedCostUsd: estimateCost(this.model, inputTokens, outputTokens),
      };
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      // エラーメッセージに API Key やスタックを載せない
      throw new AiProviderError(
        `OpenAI 呼び出しに失敗しました（${invocation.feature}）。時間をおいて再試行してください。`,
        invocation.feature,
        error,
      );
    }
  }
}
