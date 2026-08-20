import 'server-only';

import { recordAiDecision, runAi } from '@/lib/ai';
import { recordAuditEvent } from '@/lib/audit/logger';
import { isCountedInTotals } from '@/lib/services/aggregation';
import { assertCan, AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { contentHash, fid } from '@/lib/fixtures/ids';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AiSourceReference,
  AuthorizationContext,
  DisclosureResponse,
  DisclosureResponseVersion,
  ResponseStatus,
  Uuid,
} from '@/types/domain';

/**
 * 開示回答の更新系（AI ドラフト生成 / 保存 / 状態遷移）。
 *
 * Server Action からも Integration テストからも同じ経路を通すため、
 * 業務ロジックはここに置く（Action は入力の取り出しと revalidate だけを行う）。
 */

export interface GenerateDraftResult {
  aiRunId: Uuid;
  version: DisclosureResponseVersion;
  provider: 'openai' | 'mock';
  confidence: number;
  missingInformation: string[];
}

/**
 * 承認済みデータ・前年回答を根拠に AI 下書きを生成し、`draft` バージョンとして保存する。
 * **承認はしない**（AI 自動確定の禁止）。
 */
export async function generateDisclosureDraft(
  db: DbClient,
  ctx: AuthorizationContext,
  responseId: Uuid,
): Promise<GenerateDraftResult> {
  assertCan(ctx, 'enterprise.ai.run');

  const response = await db.findById('disclosureResponses', responseId);
  if (!response || response.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('回答が見つかりません。');
  }
  const item = await db.findById('disclosureItems', response.itemId);
  if (!item) throw new NotFoundError('質問が見つかりません。');

  const period = await db.findById('periods', response.reportingPeriodId);
  const mappings = await db.select('disclosureMappings', {
    where: { organizationId: response.organizationId, itemId: item.id },
  });

  const metricValues: Array<{ label: string; value: number; unit: string; periodLabel: string }> =
    [];
  const sources: AiSourceReference[] = [];

  for (const mapping of mappings) {
    const metric = await db.findById('metrics', mapping.metricId);
    if (!metric) continue;
    // 承認済みの値だけを AI へ渡す（未承認値を根拠にさせない）
    const dataPoints = await db.select('dataPoints', {
      where: {
        organizationId: response.organizationId,
        metricId: mapping.metricId,
        reportingPeriodId: response.reportingPeriodId,
        status: 'approved',
        deletedAt: { isNull: true },
      },
    });
    if (dataPoints.length === 0) continue;
    metricValues.push({
      label: metric.name,
      value:
        Math.round(
          dataPoints.filter(isCountedInTotals).reduce((s, dp) => s + (dp.value ?? 0), 0) * 100,
        ) / 100,
      unit: metric.unit,
      periodLabel: period?.label ?? '',
    });
    for (const dp of dataPoints) {
      sources.push({
        kind: 'data_point',
        id: dp.id,
        label: `${metric.name}（承認済み）`,
        locator: null,
        periodLabel: period?.code ?? null,
      });
    }
  }

  const previous = response.previousResponseId
    ? await db.findById('disclosureResponses', response.previousResponseId)
    : null;
  if (previous) {
    sources.push({
      kind: 'previous_response',
      id: previous.id,
      label: `前年度回答 ${item.code}`,
      locator: null,
      periodLabel: null,
    });
  }

  const { run, output } = await runAi({
    db,
    ctx,
    idempotencyKey: `cdpDraft:${responseId}:${Date.now()}`,
    sources,
    invocation: {
      feature: 'cdpDraftGeneration',
      context: {
        organizationName: ctx.workspace.organizationName,
        reportingPeriodLabel: period?.label ?? '',
      },
      inputReferenceIds: [responseId, item.id],
      input: {
        itemCode: item.code,
        questionText: item.questionText,
        guidance: item.guidance,
        answerType: item.answerType,
        options: item.options,
        previousAnswer: previous?.answerText ?? null,
        previousNumeric: previous?.answerNumeric ?? null,
        metricValues,
      },
    },
  });

  const version = await appendResponseVersion(db, ctx, {
    responseId,
    organizationId: response.organizationId,
    answerText: output.draftText,
    answerNumeric: output.draftNumeric,
    answerChoice: output.draftChoice,
    originatedFromAiRunId: run.id,
    changeReason: output.changeSummary,
  });

  return {
    aiRunId: run.id,
    version,
    provider: run.provider,
    confidence: run.confidence,
    missingInformation: output.missingInformation,
  };
}

interface AppendVersionInput {
  responseId: Uuid;
  organizationId: Uuid;
  answerText: string | null;
  answerNumeric: number | null;
  answerChoice: string[];
  originatedFromAiRunId: Uuid | null;
  changeReason: string | null;
  carryForwardDecision?: 'reuse' | 'update' | 'new' | null;
}

async function appendResponseVersion(
  db: DbClient,
  ctx: AuthorizationContext,
  input: AppendVersionInput,
): Promise<DisclosureResponseVersion> {
  const now = new Date().toISOString();
  const existing = await db.select('disclosureResponseVersions', {
    where: { responseId: input.responseId },
    orderBy: { column: 'versionNo', dir: 'desc' },
    limit: 1,
  });
  const versionNo = (existing[0]?.versionNo ?? 0) + 1;

  const version: DisclosureResponseVersion = {
    id: fid('disclosure_response_version', `${input.responseId}/v${versionNo}`),
    responseId: input.responseId,
    organizationId: input.organizationId,
    versionNo,
    answerText: input.answerText,
    answerNumeric: input.answerNumeric,
    answerChoice: input.answerChoice,
    status: 'draft',
    originatedFromAiRunId: input.originatedFromAiRunId,
    changeReason: input.changeReason,
    contentHash: contentHash(`${input.responseId}|${versionNo}|${input.answerText ?? ''}`),
    createdAt: now,
    createdBy: ctx.userId,
  };

  await db.insert('disclosureResponseVersions', [version]);
  await db.update('disclosureResponses', input.responseId, {
    status: 'draft',
    currentVersionId: version.id,
    answerText: input.answerText,
    answerNumeric: input.answerNumeric,
    answerChoice: input.answerChoice,
    ...(input.carryForwardDecision !== undefined
      ? { carryForwardDecision: input.carryForwardDecision }
      : {}),
    updatedAt: now,
    updatedBy: ctx.userId,
  });

  return version;
}

export interface SaveResponseInput {
  responseId: Uuid;
  answerText: string | null;
  answerNumeric: number | null;
  answerChoice: string[];
  aiRunId: Uuid | null;
  editedFromAi: boolean;
  carryForwardDecision?: 'reuse' | 'update' | 'new' | null;
}

/**
 * 人が編集した回答を保存する。
 * 保存時点で AI 由来フラグを外す（＝人が内容を確認したことを意味する）。
 */
export async function saveDisclosureResponse(
  db: DbClient,
  ctx: AuthorizationContext,
  input: SaveResponseInput,
): Promise<DisclosureResponseVersion> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const response = await db.findById('disclosureResponses', input.responseId);
  if (!response || response.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('回答が見つかりません。');
  }

  const version = await appendResponseVersion(db, ctx, {
    responseId: input.responseId,
    organizationId: response.organizationId,
    answerText: input.answerText,
    answerNumeric: input.answerNumeric,
    answerChoice: input.answerChoice,
    originatedFromAiRunId: null,
    changeReason: input.editedFromAi ? 'AI 下書きを人が編集' : '画面からの編集',
    carryForwardDecision: input.carryForwardDecision ?? null,
  });

  if (input.aiRunId) {
    await recordAiDecision(
      db,
      ctx,
      input.aiRunId,
      input.editedFromAi ? 'edited_accepted' : 'accepted',
      null,
    );
  }

  return version;
}

/**
 * 開示回答の状態遷移。
 * **AI が生成したままの版は承認できない**（指示書 14 章 / DoD 19）。
 * Supabase Mode では DB トリガ `forbid_ai_auto_approval` でも二重に禁止している。
 */
export async function transitionDisclosureResponse(
  db: DbClient,
  ctx: AuthorizationContext,
  responseId: Uuid,
  to: ResponseStatus,
): Promise<DisclosureResponse> {
  const response = await db.findById('disclosureResponses', responseId);
  if (!response || response.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('回答が見つかりません。');
  }

  if (to === 'approved') {
    assertCan(ctx, 'enterprise.disclosure.approve');
    const current = response.currentVersionId
      ? await db.findById('disclosureResponseVersions', response.currentVersionId)
      : null;
    if (!current) {
      throw new AuthorizationError('回答が作成されていません。');
    }
    if (current.originatedFromAiRunId) {
      throw new AuthorizationError(
        'AI が生成したままの回答は承認できません。内容を確認し、編集して保存してから承認してください。',
      );
    }
  } else {
    assertCan(ctx, 'enterprise.disclosure.write');
  }

  const now = new Date().toISOString();
  const updated = await db.update('disclosureResponses', responseId, {
    status: to,
    approvedAt: to === 'approved' ? now : null,
    approvedBy: to === 'approved' ? ctx.userId : null,
    updatedAt: now,
    updatedBy: ctx.userId,
  });

  await recordAuditEvent(db, ctx, {
    eventType: to === 'approved' ? 'data_approved' : 'data_updated',
    resourceType: 'disclosure_response',
    resourceId: responseId,
    beforeSummary: `status=${response.status}`,
    afterSummary: `status=${to}`,
  });

  return updated;
}
