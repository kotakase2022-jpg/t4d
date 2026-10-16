'use server';

import { revalidatePath } from 'next/cache';
import { redirect, unstable_rethrow } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { DECIMAL_SEPARATORS, type DecimalSeparator } from '@/lib/domain/ghg/number-format';
import { isUserFacingError, withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import {
  confirmActivityImport,
  createActivityBatch,
  discardActivityBatch,
  previewActivityImport,
  type ActivityImportRequest,
} from '@/lib/services/ghg/activity-import';
import { GHG_BATCH_KINDS, type GhgBatchKind } from '@/types/domain';
import { parseMappingSelection } from './_lib/activity-mapping';
import type { ActivityImportActionResult, ActivityPreviewActionResult } from './_lib/action-types';

/**
 * 活動量の取込の Server Actions（P94・P95）。入力の取り出しと再検証・遷移だけを行い、権限・検証・
 * 監査ログはサービス（src/lib/services/ghg/activity-import.ts）が行う。
 * 検証と取込は画面の入力（選んだファイル・列の対応）を消さないよう、例外でなく結果の型で返す。
 * 取込はファイルを送り直してサーバーが検証し直す（検証の結果をどこにも残さない）。
 */

const BASE = '/enterprise/ghg/calculation/activity';
const CALC_BASE = '/enterprise/ghg/calculation';

const FAILURE_MESSAGE =
  'サーバーで処理できませんでした。選んだファイルと列の対応は画面に残しています。時間をおいてもう一度お試しください。';

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

async function readRequest(
  formData: FormData,
): Promise<{ ok: true; request: ActivityImportRequest } | { ok: false; message: string }> {
  const kind = text(formData, 'kind');
  if (!(GHG_BATCH_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, message: '取り込む種類（エネルギー／輸送実績）を選んでください。' };
  }
  const unitId = text(formData, 'unitId');
  if (!unitId) return { ok: false, message: '拠点を選んでください。' };
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: 'ファイルを選んでください。' };
  }
  const separator = text(formData, 'decimalSeparator');
  const mappingRaw = text(formData, 'mapping');
  return {
    ok: true,
    request: {
      periodId: text(formData, 'periodId'),
      unitId,
      kind: kind as GhgBatchKind,
      replaceBatchId: text(formData, 'replaceBatchId') || null,
      file: { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) },
      // 空は「列名から提案する」（最初の検証）
      mapping: mappingRaw === '' ? null : parseMappingSelection(mappingRaw),
      decimalSeparator: (DECIMAL_SEPARATORS as readonly string[]).includes(separator)
        ? (separator as DecimalSeparator)
        : null,
    },
  };
}

function failure(error: unknown): { ok: false; message: string } {
  // ログイン切れ・ワークスペースの切替による redirect() は、失敗として握りつぶさずに Next.js へ返す
  unstable_rethrow(error);
  if (isUserFacingError(error)) return { ok: false, message: error.message };
  console.error('[ghg-activity] 取込の処理に失敗しました', error);
  return { ok: false, message: FAILURE_MESSAGE };
}

/** 検証（書き込み 0） */
export async function previewActivityImportAction(
  formData: FormData,
): Promise<ActivityPreviewActionResult> {
  try {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const read = await readRequest(formData);
    if (!read.ok) return read;
    return { ok: true, preview: await previewActivityImport(db, ctx, read.request) };
  } catch (error) {
    return failure(error);
  }
}

/** 取込（確認中のバッチとして保存）。成功したらバッチの詳細へ移る行き先を返す */
export async function importActivityFileAction(
  formData: FormData,
): Promise<ActivityImportActionResult> {
  let href: string;
  try {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const read = await readRequest(formData);
    if (!read.ok) return read;
    const batch = await createActivityBatch(db, ctx, {
      ...read.request,
      expectedSha256: text(formData, 'expectedSha256'),
    });
    const params = new URLSearchParams({
      flash: 'ghgActivityImported',
      rows: String(batch.rowCount),
    });
    href = `${BASE}/${encodeURIComponent(batch.id)}?${params.toString()}`;
  } catch (error) {
    return failure(error);
  }
  revalidatePath(CALC_BASE, 'layout');
  return { ok: true, href };
}

/** 取込の確定（確認中 → 確定。差し替えなら元のバッチを差し替え済みに） */
export async function confirmActivityBatchAction(formData: FormData): Promise<void> {
  const batchId = text(formData, 'batchId');
  const detail = `${BASE}/${encodeURIComponent(batchId)}`;
  let flash = '';
  await withUserFacingError(detail, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const { batch, superseded } = await confirmActivityImport(db, ctx, batchId);
    const params = new URLSearchParams({
      flash: 'ghgActivityConfirmed',
      rows: String(batch.rowCount),
      ...(superseded ? { superseded: '1' } : {}),
    });
    flash = params.toString();
  });
  revalidatePath(CALC_BASE, 'layout');
  redirect(`${detail}?${flash}`);
}

/** 確認中の取込の破棄 */
export async function discardActivityBatchAction(formData: FormData): Promise<void> {
  const batchId = text(formData, 'batchId');
  const detail = `${BASE}/${encodeURIComponent(batchId)}`;
  await withUserFacingError(detail, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await discardActivityBatch(db, ctx, batchId);
  });
  revalidatePath(CALC_BASE, 'layout');
  redirect(`${detail}?flash=ghgActivityDiscarded`);
}
