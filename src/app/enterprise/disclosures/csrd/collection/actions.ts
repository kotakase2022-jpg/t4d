'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import { createCsrdCollectionItem } from '@/lib/services/csrd/plans';

/**
 * CSRD データ収集の Server Actions（docs/disclosure-first.md §9.4）。
 * 入力の取り出しと再検証・遷移だけを行う。計画・拠点・担当者が自組織のものか、
 * 権限（disclosure.write ＋ metric.manage）、期限の形は Service が確かめる。
 */

const BASE = '/enterprise/disclosures/csrd/collection';

/** 収集項目は指標マスター・データ一覧・CSRD の各画面・分析（規制対応度）に出る */
function revalidateCsrd(): void {
  revalidatePath('/enterprise/disclosures/csrd', 'layout');
  revalidatePath('/enterprise/analysis', 'layout');
}

/** 計画から収集項目（指標 × 拠点 × 期間の担当・期限）を作る */
export async function createCsrdCollectionItemAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  let metricCode = '';
  await withUserFacingError(BASE, async () => {
    const result = await createCsrdCollectionItem(db, ctx, {
      planId: String(formData.get('planId') ?? ''),
      metricCode: String(formData.get('metricCode') ?? ''),
      metricName: String(formData.get('metricName') ?? ''),
      unit: String(formData.get('unit') ?? ''),
      unitId: String(formData.get('unitId') ?? ''),
      ownerUserId: String(formData.get('ownerUserId') ?? '') || null,
      dueDate: String(formData.get('dueDate') ?? ''),
      requiresEvidence: formData.get('requiresEvidence') === 'on',
      department: String(formData.get('department') ?? ''),
    });
    metricCode = result.metricCode;
  });
  revalidateCsrd();
  const params = new URLSearchParams({ flash: 'csrdCollectionCreated', code: metricCode });
  redirect(`${BASE}?${params.toString()}#csrd-collection-plan-rows`);
}
