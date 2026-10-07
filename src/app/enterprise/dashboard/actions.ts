'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { redirectWithUserError, withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import { resetDisclosureDemoData } from '@/lib/services/disclosure-demo-reset';

/**
 * 開示デモのリセット（Demo Mode 専用。範囲の確認チェックを必須にする）。
 * 範囲と Demo Mode の判定は Service（resetDisclosureDemoData）が改めて行う。
 */
export async function resetDisclosureDemoAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();

  if (formData.get('confirmScope') !== 'on') {
    await redirectWithUserError(
      '/enterprise/dashboard',
      'リセットする範囲を確認のうえ、チェックを入れてから実行してください。',
    );
  }

  await withUserFacingError('/enterprise/dashboard', async () => {
    const result = await resetDisclosureDemoData(db, ctx, {
      includeDataPoints: formData.get('includeDataPoints') === 'on',
    });
    // メニュー（ヘッダーのプロジェクト表示）も含めて読み直す
    revalidatePath('/enterprise', 'layout');
    redirect(
      `/enterprise/dashboard?flash=disclosureDemoReset&removed=${result.removedRows}&restored=${result.restoredRows}`,
    );
  });
}
