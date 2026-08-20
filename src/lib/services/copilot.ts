import 'server-only';

import { runAi } from '@/lib/ai';
import type { CopilotChatOutput } from '@/lib/ai/schemas';
import { safeAppLinkOrNull } from '@/lib/security/safe-link';
import { assertCan } from '@/lib/authorization/can';
import { fid } from '@/lib/fixtures/ids';
import type { DbClient } from '@/lib/repositories/types';
import { collectOrgSnapshot } from '@/lib/services/org-snapshot';
import type { AiRun, AuthorizationContext, ReportingPeriod, Uuid } from '@/types/domain';

/**
 * AI Copilot 対話（AI-P0-001）。
 *
 * - 根拠は組織スナップショット（承認済みデータ・収集状況・開示状況）**のみ**。
 *   質問者の権限内情報に限定され、他社データや外部知識では答えない。
 * - AI は回答するだけで、承認・提出・確定などの操作は一切行わない。
 * - 各ターンは ai_runs に記録され（Provenance）、会話は conversationId で連結する。
 *   質問と conversationId は実行後に outputJson へメタデータとして書き足す
 *   （ai_runs は Provider 出力のみを保持する設計のため）。
 */

export interface CopilotTurn {
  runId: Uuid;
  question: string;
  answer: string;
  references: Array<{ label: string; link: string | null }>;
  suggestedQuestions: string[];
  provider: 'openai' | 'mock';
  confidence: number;
  createdAt: string;
}

export interface CopilotConversation {
  conversationId: Uuid;
  turns: CopilotTurn[];
}

function sanitizeReferences(
  refs: Array<{ label: string; link: string | null }>,
): Array<{ label: string; link: string | null }> {
  return refs.map((r) => ({ ...r, link: safeAppLinkOrNull(r.link) }));
}

export async function askCopilot(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { question: string; conversationId: Uuid | null },
  current: ReportingPeriod,
  periods: ReportingPeriod[],
): Promise<{ conversationId: Uuid; turn: CopilotTurn }> {
  assertCan(ctx, 'enterprise.ai.run');
  const question = input.question.trim();
  if (!question) throw new Error('質問を入力してください。');
  if (question.length > 1000) throw new Error('質問は 1000 文字以内で入力してください。');

  // 会話履歴（同一会話の過去ターン）を文脈として渡す
  const conversation = input.conversationId
    ? await loadConversation(db, ctx, input.conversationId)
    : null;
  const conversationId =
    conversation?.conversationId ??
    fid('copilot_conversation', `${ctx.workspace.organizationId}/${ctx.userId}/${question}`);
  const history = (conversation?.turns ?? []).slice(-5).map((t) => ({
    question: t.question,
    answer: t.answer,
  }));

  const snapshot = await collectOrgSnapshot(db, ctx, current, periods);

  const { run, output } = await runAi({
    db,
    ctx,
    idempotencyKey: `copilotChat:${conversationId}:${history.length}:${question}`,
    sources: [
      {
        kind: 'data_point',
        id: null,
        label: '組織スナップショット（承認済み集計）',
        locator: null,
        periodLabel: current.code,
      },
    ],
    invocation: {
      feature: 'copilotChat',
      context: {
        organizationName: ctx.workspace.organizationName,
        reportingPeriodLabel: current.label,
      },
      inputReferenceIds: [current.id],
      input: { question, history, snapshot: { ...snapshot } },
    },
  });

  // 会話の再構成に必要なメタデータ（質問・会話 ID）を Provenance へ書き足す
  await db.update('aiRuns', run.id, {
    outputJson: { ...run.outputJson, question, conversationId },
  });

  return { conversationId, turn: toTurn(run, question, output) };
}

function toTurn(run: AiRun, question: string, output: CopilotChatOutput): CopilotTurn {
  return {
    runId: run.id,
    question,
    answer: output.answer,
    references: sanitizeReferences(output.references),
    suggestedQuestions: output.suggestedQuestions,
    provider: run.provider,
    confidence: run.confidence,
    createdAt: run.createdAt,
  };
}

/** 会話を読み直す。自組織かつ**自分が実行した**ターンのみ（他人・他社の対話は覗けない）。 */
export async function loadConversation(
  db: DbClient,
  ctx: AuthorizationContext,
  conversationId: Uuid,
): Promise<CopilotConversation | null> {
  const runs = await db.select('aiRuns', {
    where: { organizationId: ctx.workspace.organizationId, featureType: 'copilotChat' },
    orderBy: { column: 'createdAt' },
  });
  const matched = runs.filter(
    (r) =>
      (r.outputJson as { conversationId?: string }).conversationId === conversationId &&
      r.createdBy === ctx.userId,
  );
  if (matched.length === 0) return null;

  return {
    conversationId,
    turns: matched.map((r) => {
      const out = r.outputJson as unknown as CopilotChatOutput & { question?: string };
      return {
        runId: r.id,
        question: out.question ?? '',
        answer: out.answer,
        references: sanitizeReferences(out.references ?? []),
        suggestedQuestions: out.suggestedQuestions ?? [],
        provider: r.provider,
        confidence: r.confidence,
        createdAt: r.createdAt,
      };
    }),
  };
}
