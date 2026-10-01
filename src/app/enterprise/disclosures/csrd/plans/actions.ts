'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import { updateCsrdActionPlan } from '@/lib/services/csrd/plans';
import type { SsbjActionStatus, SsbjPriority } from '@/types/domain';

/**
 * CSRD 対応計画の Server Actions（docs/disclosure-first.md §9.4）。
 * 入力の取り出しと再検証・遷移だけを行う。値の検査（状態・優先度・担当者が自組織か・期限の形）と
 * 計画が自組織のものかは Service が確かめる（画面の hidden の値を信用しない）。
 */

const BASE = '/enterprise/disclosures/csrd/plans';

/** CSRD の計画は対応状況・要求事項・収集・分析（規制対応度）にも出る */
function revalidateCsrd(): void {
  revalidatePath('/enterprise/disclosures/csrd', 'layout');
  revalidatePath('/enterprise/analysis', 'layout');
}

/**
 * 対応計画の更新（担当者・対応状況。期限・担当部署・優先度は表示中の値をそのまま送る）。
 * 表示したときの版（baseUpdatedAt）も送り、別の操作で変わっていれば古い値で上書きしない
 */
export async function updateCsrdActionPlanAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const planId = String(formData.get('planId') ?? '');
  const dueDate = String(formData.get('dueDate') ?? '');
  await withUserFacingError(BASE, async () => {
    await updateCsrdActionPlan(db, ctx, {
      planId,
      status: String(formData.get('status') ?? '') as SsbjActionStatus,
      department: String(formData.get('department') ?? ''),
      assigneeUserId: String(formData.get('assigneeUserId') ?? '') || null,
      dueDate: dueDate === '' ? null : dueDate,
      priority: String(formData.get('priority') ?? '') as SsbjPriority,
      baseUpdatedAt: String(formData.get('baseUpdatedAt') ?? ''),
    });
  });
  revalidateCsrd();
  redirect(`${BASE}?flash=csrdPlanUpdated#csrd-plan-${encodeURIComponent(planId)}`);
}
