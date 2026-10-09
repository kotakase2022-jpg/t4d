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
  type QuantitativeImportConfirmedRow,
  type QuantitativeImportConflict,
  type QuantitativeImportPreview,
  type QuantitativeImportSource,
  type ValidateQuantitativeImportInput,
} from '@/lib/services/quantitative-import';
import { QUANTITATIVE_IMPORT_DIFF_KINDS } from '@/types/domain';

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

type SourceReadResult =
  | { ok: true; input: ValidateQuantitativeImportInput }
  | { ok: false; kind: 'invalid'; message: string };

/**
 * 画面から届いた元の入力（CSV ファイル・貼り付け・手入力）を取り出す。検証と確定で同じ取り出し方をする
 * （確定では、検証したインスタンスと別のインスタンスに届いたときに検証し直すため、同じ入力を送り直す）
 */
async function readSource(formData: FormData): Promise<SourceReadResult> {
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
  return { ok: true, input: { reportingPeriodId, source, numberNotation } };
}

export async function validateStandardImportAction(
  formData: FormData,
): Promise<StandardValidateActionResult> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const read = await readSource(formData);
  if (!read.ok) return read;

  try {
    const preview = await validateQuantitativeImport(db, ctx, read.input);
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

/**
 * 画面が確認した差分の行（競合の説明にだけ使う）。形の合わない行は捨てる。信用しない値なので、
 * 検証し直した結果と違う行を示すためだけに使い、書き込みには使わない
 */
function readConfirmedRows(raw: string): QuantitativeImportConfirmedRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const statuses = ['not_started', 'draft', 'submitted', 'in_review', 'returned', 'approved'];
  return parsed.slice(0, 5000).flatMap((entry): QuantitativeImportConfirmedRow[] => {
    if (!entry || typeof entry !== 'object') return [];
    const r = entry as Record<string, unknown>;
    if (typeof r.rowNo !== 'number' || !Number.isInteger(r.rowNo)) return [];
    if (!(QUANTITATIVE_IMPORT_DIFF_KINDS as readonly unknown[]).includes(r.diffKind)) return [];
    return [
      {
        rowNo: r.rowNo,
        diffKind: r.diffKind as QuantitativeImportConfirmedRow['diffKind'],
        previousVersionNo:
          typeof r.previousVersionNo === 'number' && Number.isInteger(r.previousVersionNo)
            ? r.previousVersionNo
            : null,
        previousStatus: statuses.includes(r.previousStatus as string)
          ? (r.previousStatus as QuantitativeImportConfirmedRow['previousStatus'])
          : null,
        previousDisplay:
          typeof r.previousDisplay === 'string' ? r.previousDisplay.slice(0, 100) : '—',
      },
    ];
  });
}

/**
 * 登録を確定する。画面は検証したときと同じ元の入力（ファイル・貼り付け・手入力）と、確認した差分の
 * ハッシュ・確定キーを送る。検証結果がこのインスタンスに無ければ（Demo Mode で別のインスタンスが検証した）、
 * Service が元の入力から検証し直し、ハッシュが一致するときだけ確定する
 */
export async function commitStandardImportAction(
  formData: FormData,
): Promise<StandardCommitActionResult> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();

  // 画面から届く値は形だけ確かめる。中身（行・値）はサーバーの検証結果（または検証し直し）から読む
  const mode: QuantitativeImportCommitMode =
    text(formData, 'mode') === 'valid_only' ? 'valid_only' : 'all';
  const read = await readSource(formData);

  try {
    const result = await commitQuantitativeImport(db, ctx, {
      batchId: text(formData, 'batchId'),
      previewHash: text(formData, 'previewHash'),
      idempotencyKey: text(formData, 'idempotencyKey'),
      mode,
      correctionReason: text(formData, 'correctionReason'),
      source: read.ok ? read.input : undefined,
      confirmedRows: readConfirmedRows(text(formData, 'confirmedRows')),
      // 過年度確定値として登録する（既定はしない。対象の行と経路はサービスが確かめる）
      priorYearFinal: text(formData, 'priorYearFinal') === 'on',
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
