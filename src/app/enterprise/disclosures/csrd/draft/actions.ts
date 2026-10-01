'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import { findCsrdPeriod } from '@/lib/services/csrd/core';
import {
  adoptCsrdDraft,
  confirmCsrdDraft,
  generateCsrdDraft,
  saveCsrdDraftBody,
} from '@/lib/services/csrd/draft';
import { CSRD_SECTIONS, type CsrdSection } from '@/types/domain';

/**
 * CSRD 開示ドラフトの Server Actions（docs/disclosure-first.md §9.4）。
 * 入力の取り出しと再検証・遷移だけを行う。
 *
 * AI は草案（ai_body）だけを作る。本文への採用・保存・確定は、それぞれ人の操作として別の Action にする
 * （AI の出力が人の操作なしに本文・確定へ進む経路を作らない。CLAUDE.md §0.4）。
 * 期間は画面に表示していたものを受け取り、自組織の期間かを Service で確かめる（別タブで期間を
 * 切り替えても、見ていた期間の節に書く）。
 */

const BASE = '/enterprise/disclosures/csrd/draft';

/** 節の草案・確定は対応状況（ドラフトの件数）と分析にも出る */
function revalidateCsrd(): void {
  revalidatePath('/enterprise/disclosures/csrd', 'layout');
  revalidatePath('/enterprise/analysis', 'layout');
}

/** 遷移先の節の位置。CSRD_SECTIONS 以外はページの先頭へ戻す（URL に任意の文字列を載せない） */
function sectionAnchor(value: FormDataEntryValue | null): string {
  const section = String(value ?? '');
  return (CSRD_SECTIONS as readonly string[]).includes(section) ? `#csrd-draft-${section}` : '';
}

/** 節の AI 草案を作る（ai_body だけ。本文は変えない） */
export async function generateCsrdDraftAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  await withUserFacingError(BASE, async () => {
    const period = await findCsrdPeriod(db, ctx, String(formData.get('reportingPeriodId') ?? ''));
    await generateCsrdDraft(db, ctx, period, String(formData.get('section') ?? '') as CsrdSection);
  });
  revalidateCsrd();
  redirect(`${BASE}?flash=csrdDraftGenerated${sectionAnchor(formData.get('section'))}`);
}

/** AI 草案を本文に採用する（人の操作。確定はしない） */
export async function adoptCsrdDraftAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  await withUserFacingError(BASE, async () => {
    await adoptCsrdDraft(db, ctx, String(formData.get('draftId') ?? ''));
  });
  revalidateCsrd();
  redirect(`${BASE}?flash=csrdDraftAdopted${sectionAnchor(formData.get('section'))}`);
}

/** 本文を保存する（確定していた場合は確定を外す） */
export async function saveCsrdDraftBodyAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  await withUserFacingError(BASE, async () => {
    await saveCsrdDraftBody(
      db,
      ctx,
      String(formData.get('draftId') ?? ''),
      String(formData.get('body') ?? ''),
    );
  });
  revalidateCsrd();
  redirect(`${BASE}?flash=csrdDraftSaved${sectionAnchor(formData.get('section'))}`);
}

/** 保存済みの本文で節を確定する（人の操作。DMA の確定後・本文ありのときだけ） */
export async function confirmCsrdDraftAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  await withUserFacingError(BASE, async () => {
    await confirmCsrdDraft(db, ctx, String(formData.get('draftId') ?? ''));
  });
  revalidateCsrd();
  redirect(`${BASE}?flash=csrdDraftConfirmed${sectionAnchor(formData.get('section'))}`);
}
