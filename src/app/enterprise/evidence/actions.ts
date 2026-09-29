'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { isUserFacingError, ValidationError, withUserFacingError } from '@/lib/errors/user-facing';
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

/** 資料の登録フォームの入力値（ファイル以外。ファイルは選び直しが要る） */
export interface EvidenceUploadValues {
  title: string;
  reportingPeriodId: string;
  editionLabel: string;
  issuedOn: string;
  documentType: string;
  confidentiality: string;
  usagePurpose: string;
}

export interface EvidenceUploadFormState {
  status: 'idle' | 'error';
  message: string | null;
  values: EvidenceUploadValues | null;
}

function evidenceUploadValues(formData: FormData): EvidenceUploadValues {
  return {
    title: str(formData, 'title'),
    reportingPeriodId: str(formData, 'reportingPeriodId'),
    editionLabel: str(formData, 'editionLabel'),
    issuedOn: str(formData, 'issuedOn'),
    documentType: str(formData, 'documentType'),
    confidentiality: str(formData, 'confidentiality'),
    usagePurpose: str(formData, 'usagePurpose'),
  };
}

/**
 * 資料を登録する（フォームの状態を返す版）。失敗したときはリダイレクトせず、入力した値と理由を返す
 * （リダイレクトするとフォームが作り直され、資料名・版・発行日・利用目的の入力が消えていた）
 */
export async function uploadEvidenceDocumentFormAction(
  _previous: EvidenceUploadFormState,
  formData: FormData,
): Promise<EvidenceUploadFormState> {
  const kind = str(formData, 'kind') === 'qualitative' ? 'qualitative' : 'evidence';
  const back = kind === 'qualitative' ? `${BASE}?purpose=qualitative` : BASE;
  const values = evidenceUploadValues(formData);
  let registered: Awaited<ReturnType<typeof registerEvidenceDocument>>;
  try {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) {
      throw new ValidationError('ファイルを選択してください。');
    }
    registered = await registerEvidenceDocument(db, ctx, {
      kind,
      fileName: file.name,
      mimeType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
      title: values.title,
      reportingPeriodId: values.reportingPeriodId || null,
      editionLabel: values.editionLabel || null,
      issuedOn: values.issuedOn || null,
      documentType: values.documentType || null,
      confidentiality: values.confidentiality || null,
      usagePurpose: values.usagePurpose || null,
    });
  } catch (error) {
    if (isUserFacingError(error)) return { status: 'error', message: error.message, values };
    console.error('[evidence upload]', error);
    return {
      status: 'error',
      message: '登録に失敗しました。時間をおいて再試行してください。',
      values,
    };
  }

  revalidatePath(BASE);
  const outcome: ExtractionOutcome | null = registered.extraction;
  const params = new URLSearchParams({ flash: 'documentRegistered' });
  if (outcome) {
    params.set('extraction', outcome.status);
    params.set('count', String(outcome.fragmentCount));
  }
  // 抽出できなかった資料は、一覧に手動抜粋への案内を出す（登録した資料を指す）
  if (outcome?.status === 'needs_manual') params.set('file', registered.file.id);
  redirect(`${back}${back.includes('?') ? '&' : '?'}${params.toString()}`);
}

export interface ManualExcerptFormState {
  status: 'idle' | 'error';
  message: string | null;
  /** 入力した値（失敗しても手で写した文言を消さない） */
  values: { page: string; locator: string; text: string };
}

/**
 * 手動抜粋（フォームの状態を返す版）。失敗したときはリダイレクトせず、入力した値と理由を返す
 * （リダイレクトするとフォームが作り直され、手で写した長い文言が消えていた）
 */
export async function addManualExcerptFormAction(
  _previous: ManualExcerptFormState,
  formData: FormData,
): Promise<ManualExcerptFormState> {
  const fileId = str(formData, 'fileId');
  const values = {
    page: str(formData, 'page'),
    locator: str(formData, 'locator'),
    text: str(formData, 'text'),
  };
  const back = `${BASE}/${fileId}`;
  try {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const pageRaw = values.page.trim();
    const page = pageRaw === '' ? null : Number(pageRaw);
    if (page !== null && !Number.isInteger(page)) {
      throw new ValidationError('ページは 1 以上の整数で入力してください。');
    }
    await addManualExcerpt(db, ctx, { fileId, page, locator: values.locator, text: values.text });
  } catch (error) {
    if (isUserFacingError(error)) return { status: 'error', message: error.message, values };
    console.error('[manual excerpt]', error);
    return {
      status: 'error',
      message: '保存に失敗しました。入力は残っています。時間をおいて再試行してください。',
      values,
    };
  }
  revalidatePath(back);
  redirect(`${back}?flash=manualExcerptAdded#extracted`);
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
