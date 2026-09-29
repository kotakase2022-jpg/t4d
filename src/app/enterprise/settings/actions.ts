'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import { setDisclosureFirst } from '@/lib/services/feature-settings';

/**
 * 開示優先モードの切替（企業管理者のみ。権限は Service と RLS の両方で検査する）。
 * 切り替えるとメニューとホームの構成が変わるため、Layout ごと読み直す。
 */
export async function setDisclosureFirstAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();

  const raw = String(formData.get('disclosureFirst') ?? '');
  if (raw !== 'on' && raw !== 'off') {
    redirect(
      `/enterprise/settings?error=${encodeURIComponent('開示優先モードの有効・無効を選んでから保存してください。')}`,
    );
  }

  await withUserFacingError('/enterprise/settings', async () => {
    await setDisclosureFirst(db, ctx, raw === 'on');
    revalidatePath('/enterprise', 'layout');
    redirect(`/enterprise/settings?flash=disclosureFirstChanged&state=${raw}`);
  });
}
