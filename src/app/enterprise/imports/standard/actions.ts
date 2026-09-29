'use server';

import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { isUserFacingError } from '@/lib/errors/user-facing';
import {
  MAX_STANDARD_CSV_BYTES,
  NUMBER_NOTATIONS,
  type NumberNotation,
} from '@/lib/imports/standard-csv';
import { getDb } from '@/lib/repositories';
import {
  commitQuantitativeImport,
  QuantitativeImportConflictError,
  QuantitativeImportExpiredError,
  QuantitativeImportPartialError,
  validateQuantitativeImport,
  type QuantitativeImportCommitMode,
  type QuantitativeImportCommitResult,
  type QuantitativeImportConflict,
  type QuantitativeImportPreview,
  type QuantitativeImportSource,
} from '@/lib/services/quantitative-import';

/**
 * 数値を登録（標準 CSV・貼り付け・手入力）の Server Actions。
 *
 * 入力の取り出しと revalidate だけを行い、検証・確定の判断は Service に任せる。
 * 画面が入力を保持したまま結果を出し分けられるよう、例外ではなく結果の型で返す
 * （保存失敗のときに入力が消えると、利用者は同じ内容を打ち直すことになる: A35）。
 */

const FAILURE_MESSAGE =
  '保存失敗: サーバーで処理できませんでした。入力内容は画面に残しています。時間をおいてもう一度お試しください。';

export type StandardValidateActionResult =
  | { ok: true; preview: QuantitativeImportPreview }
  | { ok: false; kind: 'invalid' | 'failure'; message: string };

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

export async function validateStandardImportAction(
  formData: FormData,
): Promise<StandardValidateActionResult> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();

  const reportingPeriodId = text(formData, 'reportingPeriodId');
  const notationRaw = text(formData, 'numberNotation');
  const numberNotation: NumberNotation = (NUMBER_NOTATIONS as readonly string[]).includes(
    notationRaw,
  )
    ? (notationRaw as NumberNotation)
    : 'auto';

  let source: QuantitativeImportSource;
  const kind = text(formData, 'source');
  if (kind === 'file') {
    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false, kind: 'invalid', message: 'ファイルが選択されていません。' };
    }
    if (!/\.(csv|tsv|txt)$/i.test(file.name)) {
      return {
        ok: false,
        kind: 'invalid',
        message:
          'CSV（.csv / .tsv / .txt）を選択してください。Excel のファイルは「名前を付けて保存」で CSV にしてから登録してください。',
      };
    }
    if (file.size > MAX_STANDARD_CSV_BYTES) {
      return {
        ok: false,
        kind: 'invalid',
        message: `ファイルが大きすぎます（上限 ${Math.round(MAX_STANDARD_CSV_BYTES / 1024 / 1024)}MB）。ファイルを分けてください。`,
      };
    }
    source = {
      kind: 'file',
      fileName: file.name.slice(0, 200),
      bytes: new Uint8Array(await file.arrayBuffer()),
    };
  } else if (kind === 'text') {
    const pasted = text(formData, 'text');
    if (!pasted.trim()) {
      return { ok: false, kind: 'invalid', message: '貼り付ける内容が空です。' };
    }
    if (new TextEncoder().encode(pasted).byteLength > MAX_STANDARD_CSV_BYTES) {
      return {
        ok: false,
        kind: 'invalid',
        message: '貼り付けた内容が大きすぎます。分けてください。',
      };
    }
    source = { kind: 'text', fileName: '貼り付け', text: pasted };
  } else if (kind === 'manual') {
    source = {
      kind: 'manual',
      entry: {
        metricCode: text(formData, 'metricCode'),
        entityCode: text(formData, 'entityCode'),
        reportingPeriodId,
        boundaryCode: text(formData, 'boundaryCode'),
        value: text(formData, 'value'),
        unit: text(formData, 'unit'),
        valueKind: text(formData, 'valueKind'),
        availabilityStatus: text(formData, 'availabilityStatus'),
        absenceReason: text(formData, 'absenceReason'),
        methodologyCode: text(formData, 'methodologyCode'),
        sourceReference: text(formData, 'sourceReference'),
      },
    };
  } else {
    return { ok: false, kind: 'invalid', message: '登録のしかたを選んでください。' };
  }

  try {
    const preview = await validateQuantitativeImport(db, ctx, {
      reportingPeriodId,
      source,
      numberNotation,
    });
    return { ok: true, preview };
  } catch (error) {
    // ログイン切れ・ワークスペースの切替による redirect() は、失敗として握りつぶさずに Next.js へ返す
    unstable_rethrow(error);
    if (isUserFacingError(error)) return { ok: false, kind: 'invalid', message: error.message };
    console.error('[standard-import] validate failed', error);
    return { ok: false, kind: 'failure', message: FAILURE_MESSAGE };
  }
}

export type StandardCommitActionResult =
  | { ok: true; result: QuantitativeImportCommitResult }
  | {
      ok: false;
      kind: 'expired' | 'conflict' | 'partial' | 'invalid' | 'failure';
      message: string;
      conflicts?: QuantitativeImportConflict[];
    };

export interface StandardCommitActionInput {
  batchId: string;
  previewHash: string;
  idempotencyKey: string;
  mode: string;
  correctionReason: string;
}

export async function commitStandardImportAction(
  input: StandardCommitActionInput,
): Promise<StandardCommitActionResult> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();

  // 画面から届く値は形だけ確かめる。中身（行・値）はサーバーの検証結果から読み直す
  const str = (value: unknown) => (typeof value === 'string' ? value : '');
  const mode: QuantitativeImportCommitMode = input?.mode === 'valid_only' ? 'valid_only' : 'all';

  try {
    const result = await commitQuantitativeImport(db, ctx, {
      batchId: str(input?.batchId),
      previewHash: str(input?.previewHash),
      idempotencyKey: str(input?.idempotencyKey),
      mode,
      correctionReason: str(input?.correctionReason),
    });
    revalidatePath('/enterprise/imports/standard');
    revalidatePath('/enterprise/data');
    revalidatePath('/enterprise/dashboard');
    return { ok: true, result };
  } catch (error) {
    // ログイン切れ・ワークスペースの切替による redirect() は、失敗として握りつぶさずに Next.js へ返す
    unstable_rethrow(error);
    if (error instanceof QuantitativeImportExpiredError) {
      return { ok: false, kind: 'expired', message: error.message };
    }
    if (error instanceof QuantitativeImportConflictError) {
      return { ok: false, kind: 'conflict', message: error.message, conflicts: error.conflicts };
    }
    if (error instanceof QuantitativeImportPartialError) {
      revalidatePath('/enterprise/data');
      return { ok: false, kind: 'partial', message: error.message };
    }
    if (isUserFacingError(error)) return { ok: false, kind: 'invalid', message: error.message };
    console.error('[standard-import] commit failed', error);
    return { ok: false, kind: 'failure', message: FAILURE_MESSAGE };
  }
}
