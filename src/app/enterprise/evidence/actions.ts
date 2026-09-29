'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { ValidationError, withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import {
  addManualExcerpt,
  registerEvidenceDocument,
  type ExtractionOutcome,
} from '@/lib/services/source-anchor';

/**
 * 資料・証跡の Server Actions（§6.4 の 2 つ目の入口「定性情報の資料を登録」を含む）。
 * 入力の取り出しだけを行い、検証・抽出・権限は Service（source-anchor.ts）に置く。
 */

const BASE = '/enterprise/evidence';

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '');
}

/** 資料を登録する。テキストを抽出できない資料は、その旨を結果に載せて手動抜粋へ誘導する */
export async function uploadEvidenceDocumentAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const kind = str(formData, 'kind') === 'qualitative' ? 'qualitative' : 'evidence';
  const back = kind === 'qualitative' ? `${BASE}?purpose=qualitative` : BASE;

  let fileId = '';
  let extraction: ExtractionOutcome | null = null;
  await withUserFacingError(back, async () => {
    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) {
      throw new ValidationError('ファイルを選択してください。');
    }
    const result = await registerEvidenceDocument(db, ctx, {
      kind,
      fileName: file.name,
      mimeType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
      title: str(formData, 'title'),
      reportingPeriodId: str(formData, 'reportingPeriodId') || null,
      editionLabel: str(formData, 'editionLabel') || null,
      issuedOn: str(formData, 'issuedOn') || null,
      documentType: str(formData, 'documentType') || null,
      confidentiality: str(formData, 'confidentiality') || null,
      usagePurpose: str(formData, 'usagePurpose') || null,
    });
    fileId = result.file.id;
    extraction = result.extraction;
  });

  revalidatePath(BASE);
  const outcome = extraction as ExtractionOutcome | null;
  const params = new URLSearchParams({ flash: 'documentRegistered' });
  if (outcome) {
    params.set('extraction', outcome.status);
    params.set('count', String(outcome.fragmentCount));
  }
  // 抽出できなかった資料は、一覧に手動抜粋への案内を出す（登録した資料を指す）
  if (outcome?.status === 'needs_manual') params.set('file', fileId);
  redirect(`${back}${back.includes('?') ? '&' : '?'}${params.toString()}`);
}

/** 手動抜粋（テキスト抽出できないページの代替）。抽出結果として残り、引用に使える */
export async function addManualExcerptAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const fileId = str(formData, 'fileId');
  const back = `${BASE}/${fileId}`;
  await withUserFacingError(back, async () => {
    const pageRaw = str(formData, 'page').trim();
    const page = pageRaw === '' ? null : Number(pageRaw);
    if (page !== null && !Number.isInteger(page)) {
      throw new ValidationError('ページは 1 以上の整数で入力してください。');
    }
    await addManualExcerpt(db, ctx, {
      fileId,
      page,
      locator: str(formData, 'locator'),
      text: str(formData, 'text'),
    });
  });
  revalidatePath(back);
  redirect(`${back}?flash=manualExcerptAdded#extracted`);
}
