import 'server-only';

import { assertCan, NotFoundError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { DEMO_TEXT_LIMITS } from '@/lib/repositories/demo-trial-checks';
import type { DbClient } from '@/lib/repositories/types';
import { isUuid } from '@/lib/validation/uuid';
import type { AiFeedback, AuthorizationContext, Uuid } from '@/types/domain';
import { randomUUID } from 'node:crypto';

/**
 * AI の候補への人の評価（採否と、不採用の理由）を ai_feedback に 1 行追記する（トライアル対応 NF-34・GT-25）。
 *
 *  - 候補の採否そのもの（ai_runs の状態）は recordAiDecision・各機能の確定の操作が決める。ここは
 *    「なぜ採用しなかったか」を残すだけ（任意。理由が空なら行を作らない）
 *  - 本人名義（RLS: user_id = auth.uid()）。自組織の AI 実行だけ。生成と同じ権限を求める
 *  - 理由は Demo Mode で 300 字まで（Cookie の容量。plan 付録 B）。Supabase Mode は 2,000 字
 *  - 改善管理表の「AI に関する意見」はこの行から集計する（保存しない）
 */

export const AI_FEEDBACK_REASON_MAX_DEMO = DEMO_TEXT_LIMITS.trialText;
export const AI_FEEDBACK_REASON_MAX = 2000;

/** CandidateDecision の不採用の理由欄の name（画面と Server Action で同じ名前を使う） */
export const REJECTION_REASON_FIELD = 'rejectionReason';

export async function recordAiFeedback(
  db: DbClient,
  ctx: AuthorizationContext,
  input: {
    aiRunId: Uuid;
    decision: AiFeedback['decision'];
    comment?: string | null;
  },
): Promise<AiFeedback | null> {
  const run = isUuid(input.aiRunId) ? await db.findById('aiRuns', input.aiRunId) : null;
  if (!run || run.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('AI 実行が見つかりません。');
  }
  assertCan(
    ctx,
    run.featureType.startsWith('assurance') ? 'assurance.ai.run' : 'enterprise.ai.run',
  );
  const comment = (input.comment ?? '').trim();
  if (comment === '') return null;
  const limit = ctx.demo ? AI_FEEDBACK_REASON_MAX_DEMO : AI_FEEDBACK_REASON_MAX;
  if (comment.length > limit) {
    throw new ValidationError(`理由は ${limit} 字以内で入力してください。`);
  }
  const row: AiFeedback = {
    id: randomUUID(),
    aiRunId: run.id,
    organizationId: ctx.workspace.organizationId,
    userId: ctx.userId,
    decision: input.decision,
    comment,
    createdAt: new Date().toISOString(),
  };
  const [inserted] = await db.insert('aiFeedback', [row]);
  return inserted ?? row;
}

/** フォームから不採用の理由を取り出す（無ければ null） */
export function rejectionReasonOf(formData: FormData): string | null {
  const value = formData.get(REJECTION_REASON_FIELD);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
