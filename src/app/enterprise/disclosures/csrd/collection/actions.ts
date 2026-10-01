'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { runPreservingAction } from '@/lib/errors/form-action';
import type { FormActionState } from '@/lib/errors/form-action-state';
import { getDb } from '@/lib/repositories';
import {
  createCsrdCollectionItem,
  type CreateCsrdCollectionItemResult,
} from '@/lib/services/csrd/plans';

/**
 * CSRD データ収集の Server Actions（docs/disclosure-first.md §9.4）。
 * 入力の取り出しと再検証・遷移だけを行う。計画・拠点・担当者が自組織のものか、
 * 権限（disclosure.write ＋ metric.manage）、期限の形は Service が確かめる。
 * 断られたとき（入力の誤り・計画が変わったなど）は、選んだ計画・指標・拠点・担当・期限を残して理由を示す。
 */

const BASE = '/enterprise/disclosures/csrd/collection';

/** 収集項目は指標マスター・データ一覧・CSRD の各画面・分析（規制対応度）に出る */
function revalidateCsrd(): void {
  revalidatePath('/enterprise/disclosures/csrd', 'layout');
  revalidatePath('/enterprise/analysis', 'layout');
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * 計画から収集項目（指標 × 拠点 × 期間の担当・期限）を作る。
 * 結果（割当を作ったか・既存の割当を使ったか、計画の状況が変わったか）をフラッシュの文言に渡す
 */
export async function createCsrdCollectionItemAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  let result: CreateCsrdCollectionItemResult | null = null;
  const failure = await runPreservingAction(formData, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    result = await createCsrdCollectionItem(db, ctx, {
      planId: field(formData, 'planId'),
      metricCode: field(formData, 'metricCode'),
      metricName: field(formData, 'metricName'),
      unit: field(formData, 'unit'),
      unitId: field(formData, 'unitId'),
      ownerUserId: field(formData, 'ownerUserId') || null,
      dueDate: field(formData, 'dueDate'),
      requiresEvidence: formData.get('requiresEvidence') === 'on',
      department: field(formData, 'department'),
    });
  });
  if (failure) return failure;
  revalidateCsrd();
  const done = result as CreateCsrdCollectionItemResult | null;
  const params = new URLSearchParams({
    flash: done?.assignmentCreated === false ? 'csrdCollectionLinked' : 'csrdCollectionCreated',
    code: done?.metricCode ?? '',
    plan: done?.planStatusChanged ? 'in_progress' : 'unchanged',
  });
  redirect(`${BASE}?${params.toString()}#csrd-collection-plan-rows`);
}
