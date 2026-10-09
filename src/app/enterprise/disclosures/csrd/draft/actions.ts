'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { runPreservingAction } from '@/lib/errors/form-action';
import type { FormActionState } from '@/lib/errors/form-action-state';
import { withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import { findCsrdPeriod } from '@/lib/services/csrd/core';
import {
  adoptCsrdDraft,
  confirmCsrdDraft,
  generateCsrdDraft,
  saveCsrdDraftBody,
} from '@/lib/services/csrd/draft';
import { importDraftToProject } from '@/lib/services/draft-import';
import { CSRD_SECTIONS, type CsrdSection } from '@/types/domain';

/**
 * CSRD 開示ドラフトの Server Actions（docs/disclosure-first.md §9.4）。
 * 入力の取り出しと再検証・遷移だけを行う。
 *
 * AI は草案（ai_body）だけを作る。本文への採用・保存・確定は、それぞれ人の操作として別の Action にする
 * （AI の出力が人の操作なしに本文・確定へ進む経路を作らない。CLAUDE.md §0.4）。
 * 期間は画面に表示していたものを受け取り、自組織の期間かを Service で確かめる（別タブで期間を
 * 切り替えても、見ていた期間の節に書く）。採用・保存・確定は画面が表示したときの版（baseUpdatedAt）も
 * 送り、別の操作で変わっていれば Service が断る。
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

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/** 実行した AI の提供元（フラッシュの文言を「デモ生成」と「AI 生成」で分ける） */
function providerParam(provider: string): string {
  return provider === 'mock' ? 'mock' : 'openai';
}

/** 節の AI 草案を作る（ai_body だけ。本文は変えない） */
export async function generateCsrdDraftAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  let provider = 'mock';
  await withUserFacingError(BASE, async () => {
    const period = await findCsrdPeriod(db, ctx, field(formData, 'reportingPeriodId'));
    const draft = await generateCsrdDraft(
      db,
      ctx,
      period,
      field(formData, 'section') as CsrdSection,
    );
    const run = draft.aiRunId ? await db.findById('aiRuns', draft.aiRunId) : null;
    provider = run?.provider ?? 'mock';
  });
  revalidateCsrd();
  revalidatePath('/enterprise/ai');
  redirect(
    `${BASE}?flash=csrdDraftGenerated&ai=${providerParam(provider)}${sectionAnchor(formData.get('section'))}`,
  );
}

/** AI 草案を本文に採用する（人の操作。確定はしない） */
export async function adoptCsrdDraftAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  await withUserFacingError(BASE, async () => {
    await adoptCsrdDraft(db, ctx, {
      draftId: field(formData, 'draftId'),
      baseUpdatedAt: field(formData, 'baseUpdatedAt'),
    });
  });
  revalidateCsrd();
  redirect(`${BASE}?flash=csrdDraftAdopted${sectionAnchor(formData.get('section'))}`);
}

/**
 * 本文を保存する（確定していた場合は確定を外す）。草案の行が無い節は、ここで行を作る。
 * 断られたとき（別の操作で更新済み・上限超過など）は、書いた本文を残したまま理由を示す
 */
export async function saveCsrdDraftBodyAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const failure = await runPreservingAction(formData, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const draftId = field(formData, 'draftId');
    await saveCsrdDraftBody(db, ctx, {
      draftId: draftId === '' ? null : draftId,
      reportingPeriodId: field(formData, 'reportingPeriodId'),
      section: field(formData, 'section') as CsrdSection,
      body: field(formData, 'body'),
      baseUpdatedAt: field(formData, 'baseUpdatedAt') || null,
    });
  });
  if (failure) return failure;
  revalidateCsrd();
  redirect(`${BASE}?flash=csrdDraftSaved${sectionAnchor(formData.get('section'))}`);
}

/** 保存済みの本文で節を確定する（人の操作。DMA の確定後・本文ありのときだけ） */
export async function confirmCsrdDraftAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  await withUserFacingError(BASE, async () => {
    await confirmCsrdDraft(db, ctx, {
      draftId: field(formData, 'draftId'),
      baseUpdatedAt: field(formData, 'baseUpdatedAt'),
    });
  });
  revalidateCsrd();
  redirect(`${BASE}?flash=csrdDraftConfirmed${sectionAnchor(formData.get('section'))}`);
}

/**
 * 確定本文を開示プロジェクトの原稿の節へ取り込む（トライアル対応 NF-19）。新しい版は下書きで、
 * 承認は原稿のレビュー・最終承認で行う。CSRD を基準に持つ同じ年度のプロジェクトだけ（40a には入れない）
 */
export async function importCsrdDraftToProjectAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const projectId = String(formData.get('projectId') ?? '');
  let target = '';
  await withUserFacingError(BASE, async () => {
    const result = await importDraftToProject(db, ctx, {
      source: 'csrd',
      draftId: String(formData.get('draftId') ?? ''),
      projectId,
    });
    target = `/enterprise/disclosure-projects/${result.block.projectId}/blocks/${result.block.id}?flash=draftImported&ai=${result.aiParagraphs}`;
  });
  revalidatePath(BASE);
  revalidatePath(`/enterprise/disclosure-projects/${projectId}`);
  redirect(target);
}
