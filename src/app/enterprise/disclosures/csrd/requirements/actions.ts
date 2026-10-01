'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { runPreservingAction } from '@/lib/errors/form-action';
import type { FormActionState } from '@/lib/errors/form-action-state';
import { withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import { createCsrdActionPlan } from '@/lib/services/csrd/plans';
import {
  reviewCsrdAssessment,
  runCsrdGapAnalysis,
  saveCsrdAssessment,
} from '@/lib/services/csrd/requirements';
import {
  parseAssessmentForm,
  parsePlanForm,
  parseReviewForm,
  requirementDetailPath,
} from './form-input';

/**
 * CSRD 要求事項の Server Action（docs/disclosure-first.md §9.4）。
 * 入力の取り出しと再検証だけを行う。AI は候補（ai_*）だけを書き、最終判定は
 * 「候補を採用」「修正して確定」「担当者の入力」という人の操作でだけ入る（サービスが保証する）。
 *
 * 成功したら要求事項の詳細へ `?flash=` 付きで戻る。利用者向けのエラーは、入力を伴う確定
 * （修正して確定・担当者の入力）では入力を残したまま理由を返し、それ以外は `?error=` で戻す。
 */

function revalidateCsrd(): void {
  revalidatePath('/enterprise/disclosures/csrd', 'layout');
  revalidatePath('/enterprise/analysis', 'layout');
}

/** 担当者が 3 観点を入力して確定する（断られたら入力を残して理由を示す） */
export async function saveCsrdAssessmentAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const back = requirementDetailPath(formData.get('itemId'));
  const failure = await runPreservingAction(formData, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await saveCsrdAssessment(db, ctx, parseAssessmentForm(formData));
  });
  if (failure) return failure;
  revalidateCsrd();
  redirect(`${back}?flash=csrdAssessmentSaved`);
}

/** AI ギャップ分析（1 件ずつ。結果は候補） */
export async function runCsrdGapAnalysisAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const back = requirementDetailPath(formData.get('itemId'));
  let provider = 'mock';
  await withUserFacingError(back, async () => {
    const { runId } = await runCsrdGapAnalysis(db, ctx, {
      reportingPeriodId: String(formData.get('reportingPeriodId') ?? ''),
      itemId: String(formData.get('itemId') ?? ''),
    });
    provider = (await db.findById('aiRuns', runId))?.provider ?? 'mock';
  });
  revalidateCsrd();
  revalidatePath('/enterprise/ai');
  // 実行した提供元でフラッシュの文言を分ける（Mock は「デモ生成」）
  redirect(`${back}?flash=csrdGapAnalyzed&ai=${provider === 'mock' ? 'mock' : 'openai'}`);
}

/** 担当者の確認: 候補を採用（表示した候補の実行日時を送り、変わっていれば断る） */
export async function reviewCsrdAssessmentAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const back = requirementDetailPath(formData.get('itemId'));
  const input = parseReviewForm(formData);
  await withUserFacingError(back, async () => {
    await reviewCsrdAssessment(db, ctx, input);
  });
  revalidateCsrd();
  redirect(
    `${back}?flash=csrdReviewSaved&decision=${input.decision === 'modified' ? 'modified' : 'approved'}`,
  );
}

/** 担当者の確認: 修正して確定（理由が無いなどで断られたら、選んだ値と理由を残して理由を示す） */
export async function reviewCsrdAssessmentFormAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const back = requirementDetailPath(formData.get('itemId'));
  const input = parseReviewForm(formData);
  const failure = await runPreservingAction(formData, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await reviewCsrdAssessment(db, ctx, input);
  });
  if (failure) return failure;
  revalidateCsrd();
  redirect(
    `${back}?flash=csrdReviewSaved&decision=${input.decision === 'modified' ? 'modified' : 'approved'}`,
  );
}

/** 対応計画を追加する（評価対象の要求事項のみ） */
export async function createCsrdActionPlanAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const back = requirementDetailPath(formData.get('itemId'));
  await withUserFacingError(back, async () => {
    await createCsrdActionPlan(db, ctx, parsePlanForm(formData));
  });
  revalidateCsrd();
  redirect(`${back}?flash=csrdPlanCreated`);
}
