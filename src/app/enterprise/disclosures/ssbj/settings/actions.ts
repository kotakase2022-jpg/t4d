'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import { pinSsbjFrameworkVersion } from '@/lib/services/ssbj-settings';

/**
 * SSBJ の設定の Server Action（トライアル対応 NF-12）。入力の取り出しと revalidate だけ。
 * 既存の保存・確定の Action は src/app/enterprise/actions.ts のまま（ここでは基準の版の切り替えだけを足す）
 */

const SETTINGS = '/enterprise/disclosures/ssbj/settings';

/** この年度の SSBJ の基準の版を切り替える（人の明示の操作。設定の確定は外れる） */
export async function pinSsbjVersionAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  await withUserFacingError(SETTINGS, async () => {
    await pinSsbjFrameworkVersion(db, ctx, {
      reportingPeriodId: String(formData.get('reportingPeriodId') ?? ''),
      frameworkVersionId: String(formData.get('frameworkVersionId') ?? ''),
    });
  });
  for (const path of [
    '/enterprise/disclosures/ssbj',
    SETTINGS,
    '/enterprise/disclosures/ssbj/requirements',
    '/enterprise/disclosures/ssbj/draft',
  ]) {
    revalidatePath(path);
  }
  redirect(`${SETTINGS}?flash=ssbjVersionPinned#ssbj-settings-version`);
}
