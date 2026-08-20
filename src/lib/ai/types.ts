import type { AiFeature, AiOutputOf } from './schemas';

/**
 * AI Provider Interface（指示書 14 章）。
 *
 * `OpenAIProvider` と `MockAIProvider` は同一契約を実装する。
 * 呼び出し側（Service / UI）は具象を知らない。
 */

export interface AiRequestContext {
  /** 権限内の情報だけを渡すこと。Secret / API Key を Prompt に含めない。 */
  organizationName: string;
  reportingPeriodLabel: string;
  /** 監査法人の場合のみ */
  engagementLabel?: string;
}

export interface AiInvocation<F extends AiFeature> {
  feature: F;
  context: AiRequestContext;
  /** モデルへ渡す構造化入力。PII や Secret を含めない。 */
  input: Record<string, unknown>;
  /** 参照した DB レコードの ID（監査証跡用） */
  inputReferenceIds: string[];
}

export interface AiResult<F extends AiFeature> {
  output: AiOutputOf<F>;
  provider: 'openai' | 'mock';
  model: string;
  promptVersion: string;
  latencyMs: number;
  tokenUsage: { input: number; output: number; total: number };
  estimatedCostUsd: number;
}

export interface AiProvider {
  readonly kind: 'openai' | 'mock';
  readonly model: string;
  run<F extends AiFeature>(invocation: AiInvocation<F>): Promise<AiResult<F>>;
}

export class AiProviderError extends Error {
  readonly feature: AiFeature;

  constructor(message: string, feature: AiFeature, cause?: unknown) {
    super(message, { cause });
    this.name = 'AiProviderError';
    this.feature = feature;
  }
}
