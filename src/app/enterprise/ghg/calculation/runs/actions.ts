'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { ValidationError, withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import { runCalculation } from '@/lib/services/ghg/calculation';
import { postRunToDataPoints } from '@/lib/services/ghg/post-to-data-points';
import { isUuid } from '@/lib/validation/uuid';

/**
 * Scope1・2 の算定の実行と Data Point への下書き反映の Server Actions（plan §2.4 P90・P96、CR-08・CR-10）。
 * 入力の取り出し・再検証・遷移だけを行う。権限（enterprise.data.write＋担当拠点・承認済みの上書きはレビュー権限）・
 * 入力の検査・監査ログはサービス（src/lib/services/ghg/*）が行う。断られたら ?error= で元の画面へ戻す。
 */

const OVERVIEW = '/enterprise/ghg/calculation';

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function runHref(runId: string): string {
  return `${OVERVIEW}/runs/${encodeURIComponent(runId)}`;
}

/** 算定を実行する（P90 の主操作）。記録ができたら算定明細へ移る */
export async function runGhgCalculationAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const periodId = field(formData, 'periodId');
  const unitIds = field(formData, 'unitIds')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => isUuid(id));
  const back = isUuid(periodId) ? `${OVERVIEW}?period=${encodeURIComponent(periodId)}` : OVERVIEW;
  let runId = '';
  let lineCount = 0;
  await withUserFacingError(back, async () => {
    if (!isUuid(periodId)) throw new ValidationError('算定する期間を選んでください。');
    const result = await runCalculation(db, ctx, { periodId, unitIds });
    if (!result.ok) {
      // 係数が解決できない行などが 1 行でもあれば記録を作らない（代わりを使わない。plan K6）。
      // 行の一覧は概要の「係数が解決できない行」と各タブで確かめる
      const first = result.errors[0]?.message ?? '';
      throw new ValidationError(
        `算定の記録を作りませんでした（問題のある行 ${result.errors.length} 行）。${first}`,
      );
    }
    runId = result.run.id;
    lineCount = result.run.lineCount;
  });
  revalidatePath(OVERVIEW);
  redirect(`${runHref(runId)}?flash=ghgRunCreated&lines=${lineCount}`);
}

/** 記録の報告区分の値を Data Point へ下書きとして反映する（P96 の主操作。承認はしない） */
export async function postGhgRunToDataPointsAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const runId = field(formData, 'runId');
  const back = isUuid(runId) ? runHref(runId) : OVERVIEW;
  const counts = { created: 0, updated: 0, approved: 0, unchanged: 0, skipped: 0 };
  await withUserFacingError(back, async () => {
    if (!isUuid(runId)) throw new ValidationError('反映する算定の記録を選んでください。');
    const result = await postRunToDataPoints(db, ctx, runId, {
      view: 'reported',
      acknowledgeApprovedOverwrite: field(formData, 'acknowledgeApprovedOverwrite') === 'on',
    });
    counts.created = result.created;
    counts.updated = result.updated;
    counts.approved = result.approvedOverwritten;
    counts.unchanged = result.unchanged;
    counts.skipped = result.skipped;
  });
  revalidatePath(back);
  revalidatePath('/enterprise/data');
  const params = new URLSearchParams({
    flash: 'ghgRunPosted',
    created: String(counts.created),
    updated: String(counts.updated),
    approved: String(counts.approved),
    unchanged: String(counts.unchanged),
    skipped: String(counts.skipped),
  });
  redirect(`${back}?${params.toString()}`);
}
