'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { isUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import { parseKpiTargetForm, registerKpiTarget } from '@/lib/services/kpi';
import type { KpiTargetFormState } from './target-form-state';

/**
 * ESG 経営の Server Actions。入力の取り出しと再検証だけを行う
 * （権限 enterprise.metric.manage・入力の検査・版の採番は registerKpiTarget）。
 *
 * 失敗したときは入力値を返し、フォームが入力を失わないようにする（保存に失敗したのに
 * 入力が消えると、利用者は何を直せばよいか分からなくなる）。
 */
export async function registerKpiTargetAction(
  previous: KpiTargetFormState,
  formData: FormData,
): Promise<KpiTargetFormState> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const get = (key: string) => String(formData.get(key) ?? '');

  let saved: { targetKey: string; versionNo: number };
  try {
    saved = await registerKpiTarget(db, ctx, parseKpiTargetForm(get));
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    const values: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value === 'string' && !key.startsWith('$')) values[key] = value;
    }
    return { attempt: previous.attempt + 1, message: error.message, values };
  }
  revalidatePath('/enterprise/esg');
  revalidatePath('/enterprise/esg/targets');
  redirect(
    `/enterprise/esg/targets?saved=${encodeURIComponent(saved.targetKey)}&version=${saved.versionNo}`,
  );
}
