'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
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
 * 成功したら要求事項の詳細へ `?flash=` 付きで戻り、利用者向けのエラーは `?error=` で戻す。
 */

function revalidateCsrd(): void {
  revalidatePath('/enterprise/disclosures/csrd', 'layout');
  revalidatePath('/enterprise/analysis', 'layout');
}

/** 担当者が 3 観点を入力して確定する */
export async function saveCsrdAssessmentAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const back = requirementDetailPath(formData.get('itemId'));
  await withUserFacingError(back, async () => {
    await saveCsrdAssessment(db, ctx, parseAssessmentForm(formData));
  });
  revalidateCsrd();
  redirect(`${back}?flash=csrdAssessmentSaved`);
}

/** AI ギャップ分析（1 件ずつ。結果は候補） */
export async function runCsrdGapAnalysisAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const back = requirementDetailPath(formData.get('itemId'));
  await withUserFacingError(back, async () => {
    await runCsrdGapAnalysis(db, ctx, {
      reportingPeriodId: String(formData.get('reportingPeriodId') ?? ''),
      itemId: String(formData.get('itemId') ?? ''),
    });
  });
  revalidateCsrd();
  revalidatePath('/enterprise/ai');
  redirect(`${back}?flash=csrdGapAnalyzed`);
}

/** 担当者の確認（候補を採用／修正して確定） */
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
