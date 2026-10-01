'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import {
  confirmCsrdDma,
  decideCsrdDmaMatter,
  deleteCsrdDmaIro,
  saveCsrdBoundary,
  saveCsrdMethod,
  upsertCsrdDmaIro,
} from '@/lib/services/csrd/settings';
import {
  CSRD_SETTINGS_PATH,
  matterPath,
  parseBoundaryForm,
  parseIroForm,
  parseMatterDecisionForm,
  parseMethodForm,
  safeTopic,
} from './form-input';

/**
 * CSRD 設定（報告範囲・評価方法と閾値・ダブル・マテリアリティ評価）の Server Action
 * （docs/disclosure-first.md §9.4）。入力の取り出しと再検証だけを行い、業務の規則はサービスが持つ。
 *
 * 成功したら同じ画面へ `?flash=` 付きで戻り、利用者向けのエラーは `?error=` で戻す
 * （withUserFacingError）。DMA の確定を外す書込の結果もフラッシュの文面で伝える。
 */

/** CSRD の画面すべてと分析（規制対応度）が DMA・評価の結果を表示するため、まとめて再検証する */
function revalidateCsrd(): void {
  revalidatePath('/enterprise/disclosures/csrd', 'layout');
  revalidatePath('/enterprise/analysis', 'layout');
}

/** ①報告範囲を保存する */
export async function saveCsrdBoundaryAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  await withUserFacingError(CSRD_SETTINGS_PATH, async () => {
    await saveCsrdBoundary(db, ctx, parseBoundaryForm(formData));
  });
  revalidateCsrd();
  redirect(`${CSRD_SETTINGS_PATH}?flash=csrdBoundarySaved`);
}

/** ②評価方法・閾値・ステークホルダー関与を保存する */
export async function saveCsrdMethodAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  await withUserFacingError(CSRD_SETTINGS_PATH, async () => {
    await saveCsrdMethod(db, ctx, parseMethodForm(formData));
  });
  revalidateCsrd();
  redirect(`${CSRD_SETTINGS_PATH}?flash=csrdMethodSaved`);
}

/** DMA を確定する（人の操作。条件が揃わなければサービスが理由を返す） */
export async function confirmCsrdDmaAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  await withUserFacingError(CSRD_SETTINGS_PATH, async () => {
    await confirmCsrdDma(db, ctx, String(formData.get('reportingPeriodId') ?? ''));
  });
  revalidateCsrd();
  redirect(`${CSRD_SETTINGS_PATH}?flash=csrdDmaConfirmed`);
}

/** IRO を追加・更新する */
export async function upsertCsrdDmaIroAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const back = matterPath(safeTopic(formData.get('topic')));
  await withUserFacingError(back, async () => {
    await upsertCsrdDmaIro(db, ctx, parseIroForm(formData));
  });
  revalidateCsrd();
  redirect(`${back}?flash=csrdIroSaved`);
}

/** IRO を論理削除する */
export async function deleteCsrdDmaIroAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const back = matterPath(safeTopic(formData.get('topic')));
  await withUserFacingError(back, async () => {
    await deleteCsrdDmaIro(db, ctx, String(formData.get('iroId') ?? ''));
  });
  revalidateCsrd();
  redirect(`${back}?flash=csrdIroDeleted`);
}

/** 事項の 2 軸（インパクト・財務）を人が判断する */
export async function decideCsrdDmaMatterAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const back = matterPath(safeTopic(formData.get('topic')));
  await withUserFacingError(back, async () => {
    await decideCsrdDmaMatter(db, ctx, parseMatterDecisionForm(formData));
  });
  revalidateCsrd();
  redirect(`${back}?flash=csrdMatterDecided`);
}
