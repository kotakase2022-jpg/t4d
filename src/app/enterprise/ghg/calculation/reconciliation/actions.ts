'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { NotFoundError } from '@/lib/authorization/can';
import { runPreservingAction } from '@/lib/errors/form-action';
import type { FormActionState } from '@/lib/errors/form-action-state';
import { isUserFacingError, ValidationError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import {
  baselineSettingsFromForm,
  confirmBaselineImport,
  previewBaselineImport,
  type BaselinePreview,
} from '@/lib/services/ghg/baseline-import';
import { reconcile } from '@/lib/services/ghg/reconciliation';
import { recordCause } from '@/lib/services/ghg/reconciliation-notes';
import { isUuid } from '@/lib/validation/uuid';
import { GHG_SCOPES, type ReconciliationTolerance } from '@/types/domain';
import {
  ATTRIBUTION_ORDER_PRESETS,
  isOrderPreset,
  parseToleranceInput,
  RECONCILIATION_BASE_PATH,
  reconciliationDetailHref,
  reconciliationListHref,
} from './_components/reconcile-options';

/**
 * 既存の算定結果との照合（P97・P98）の Server Action。入力の取り出しと revalidate だけを行い、
 * 業務の検査はサービス（src/lib/services/ghg/{baseline-import,reconciliation,reconciliation-notes}.ts）が行う。
 */

export type BaselineImportState =
  | { status: 'idle' }
  | { status: 'ok'; preview: BaselinePreview }
  | { status: 'error'; message: string };

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function uploaded(formData: FormData): File | null {
  const file = formData.get('file');
  return file instanceof File && file.size > 0 ? file : null;
}

/** 取込の検証（ファイル → 列の対応と拠点の対応付け → 検証）。書き込まない */
export async function previewBaselineImportAction(
  _previous: BaselineImportState,
  formData: FormData,
): Promise<BaselineImportState> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const file = uploaded(formData);
  if (!file) return { status: 'error', message: 'ファイルを選んでください。' };
  try {
    const preview = await previewBaselineImport(db, ctx, {
      periodId: text(formData, 'periodId'),
      fileName: file.name,
      buffer: new Uint8Array(await file.arrayBuffer()),
      // 最初にファイルを選んだときは見出しから既定値を出す。以降は利用者が選んだ設定で検証する
      ...(text(formData, 'step') === 'inspect'
        ? {}
        : { settings: baselineSettingsFromForm(formData) }),
    });
    return { status: 'ok', preview };
  } catch (error) {
    if (isUserFacingError(error)) return { status: 'error', message: error.message };
    throw error;
  }
}

/** 取込の確定（同じファイルを送り直し、サーバーが読み直して検証してから追記する） */
export async function confirmBaselineImportAction(
  _previous: BaselineImportState,
  formData: FormData,
): Promise<BaselineImportState> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const file = uploaded(formData);
  if (!file) return { status: 'error', message: 'ファイルを選んでください。' };
  const periodId = text(formData, 'periodId');
  let rows: number;
  try {
    const row = await confirmBaselineImport(db, ctx, {
      periodId,
      fileName: file.name,
      buffer: new Uint8Array(await file.arrayBuffer()),
      settings: baselineSettingsFromForm(formData),
      label: text(formData, 'label'),
      expectedSha256: text(formData, 'sha256'),
      supersedesId: text(formData, 'supersedesId') || null,
    });
    rows = row.rowCount;
  } catch (error) {
    if (isUserFacingError(error)) return { status: 'error', message: error.message };
    throw error;
  }
  revalidatePath(RECONCILIATION_BASE_PATH);
  redirect(reconciliationListHref(periodId, { flash: 'ghgBaselineImported', rows: String(rows) }));
}

/**
 * 照合する（許容差は利用者が入れる。既定値を置かない）。断ったとき（許容差の無い区分・読めない値・上限）は
 * リダイレクトせず理由を返し、入れた許容差と順序をフォームに残す（PreservingForm）
 */
export async function reconcileAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const periodId = text(formData, 'periodId');
  const runId = text(formData, 'runId');
  const baselineId = text(formData, 'baselineId');
  const done: { id: string; items: number; outside: number } = { id: '', items: 0, outside: 0 };
  const failure = await runPreservingAction(formData, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    if (!isUuid(runId)) throw new NotFoundError('算定の記録が見つかりません。');
    if (!isUuid(baselineId)) throw new NotFoundError('既存の算定結果が見つかりません。');
    const tolerance: ReconciliationTolerance = {};
    for (const scope of GHG_SCOPES) {
      const absoluteT = parseToleranceInput(formData.get(`tol:${scope}:abs`));
      const relativePct = parseToleranceInput(formData.get(`tol:${scope}:rel`));
      if (absoluteT === 'invalid' || relativePct === 'invalid') {
        throw new ValidationError('許容差は 0 以上の数で入れてください（例 0.05）。');
      }
      if (absoluteT === null && relativePct === null) continue;
      tolerance[scope] = { absoluteT, relativePct };
    }
    const preset = text(formData, 'order');
    const row = await reconcile(db, ctx, {
      runId,
      baselineId,
      tolerance,
      order: ATTRIBUTION_ORDER_PRESETS[isOrderPreset(preset) ? preset : 'default'],
    });
    const items = row.result?.items ?? [];
    done.id = row.id;
    done.items = items.length;
    done.outside = items.filter((i) => !i.withinTolerance).length;
  });
  if (failure) return failure;
  revalidatePath(RECONCILIATION_BASE_PATH);
  redirect(
    reconciliationDetailHref(done.id, periodId || null, {
      flash: 'ghgReconciled',
      items: String(done.items),
      outside: String(done.outside),
    }),
  );
}

/**
 * 項目の差異の原因を記録する（確認者の名義・追記）。断ったとき（原因を選んでいない・「その他」でコメントが無い）は
 * リダイレクトせず理由を返し、選んだ原因と書いたコメントをフォームに残す（PreservingForm）
 */
export async function recordCauseAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const reconciliationId = text(formData, 'reconciliationId');
  const itemKey = text(formData, 'itemKey');
  const periodId = text(formData, 'periodId') || null;
  const detail = isUuid(reconciliationId) ? reconciliationId : 'unknown';
  const failure = await runPreservingAction(formData, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await recordCause(db, ctx, {
      reconciliationId,
      itemKey,
      cause: text(formData, 'cause'),
      comment: text(formData, 'comment'),
    });
  });
  if (failure) return failure;
  revalidatePath(`${RECONCILIATION_BASE_PATH}/${detail}`);
  redirect(reconciliationDetailHref(detail, periodId, { flash: 'ghgCauseRecorded' }));
}
