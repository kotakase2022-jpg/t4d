'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { FACTOR_IMPORT_FIELDS } from '@/lib/domain/ghg/factor-import';
import { runPreservingAction } from '@/lib/errors/form-action';
import type { FormActionState } from '@/lib/errors/form-action-state';
import { isUserFacingError, withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import {
  clearAssignment,
  needLabel,
  saveAssignment,
  type AssignmentLevel,
} from '@/lib/services/ghg/assignments';
import {
  activateFactorSet,
  confirmFactorSetImport,
  parseDecimalSeparator,
  previewFactorSetImport,
  retireFactorSet,
  sanitizeMapping,
  type FactorFileInput,
} from '@/lib/services/ghg/factor-sets';
import { EMISSION_BASES, type EmissionBasis, type FactorActivityKind } from '@/types/domain';
import {
  MAPPING_FIELD_PREFIX,
  type FactorImportConfirmState,
  type FactorImportPreviewState,
} from './_lib/import-state';

/**
 * 排出係数の画面（P91・P92）の Server Actions。入力の取り出しと再検証・遷移だけを行う。
 * 権限（enterprise.metric.manage）・入力の検査・監査ログはサービス（src/lib/services/ghg/*）が行う。
 * 取込のプレビューの結果はサーバーに残さず、確定のときにファイルと列の対応を送り直してもらう（本番の別インスタンス対策）。
 */

const BASE = '/enterprise/ghg/calculation/factors';

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

function revalidateCalculation(): void {
  revalidatePath('/enterprise/ghg/calculation', 'layout');
  revalidatePath('/enterprise/ghg');
}

async function fileInput(formData: FormData): Promise<FactorFileInput | string> {
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return 'ファイルを選んでください。';
  const mappingProvided = field(formData, 'mappingProvided') === '1';
  const raw: Record<string, string> = {};
  for (const name of FACTOR_IMPORT_FIELDS)
    raw[name] = field(formData, `${MAPPING_FIELD_PREFIX}${name}`);
  const yearText = field(formData, 'referenceYear').trim();
  const year = yearText === '' ? null : Number(yearText);
  return {
    fileName: file.name,
    bytes: new Uint8Array(await file.arrayBuffer()),
    mapping: mappingProvided ? sanitizeMapping(raw) : null,
    decimalSeparator: parseDecimalSeparator(field(formData, 'decimalSeparator')),
    referenceYear: year !== null && Number.isInteger(year) ? year : null,
    sourceLabel: field(formData, 'sourceLabel').trim(),
  };
}

/** 取込の検証（書き込みなし。初回は見出しから列の対応の候補を作る） */
export async function previewFactorSetImportAction(
  _previous: FactorImportPreviewState,
  formData: FormData,
): Promise<FactorImportPreviewState> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const input = await fileInput(formData);
  if (typeof input === 'string') return { ok: false, message: input };
  try {
    const preview = await previewFactorSetImport(db, ctx, input);
    return {
      ok: true,
      preview: {
        ...preview,
        referenceYear: field(formData, 'referenceYear').trim(),
        sourceLabel: input.sourceLabel,
      },
    };
  } catch (error) {
    if (isUserFacingError(error)) return { ok: false, message: error.message };
    throw error;
  }
}

/** 取込の確定（下書きのセットと係数を書く）。成功したらセットの詳細へ */
export async function confirmFactorSetImportAction(
  _previous: FactorImportConfirmState,
  formData: FormData,
): Promise<FactorImportConfirmState> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const input = await fileInput(formData);
  if (typeof input === 'string') return { ok: false, message: input };
  let target: string;
  try {
    const { set, factors } = await confirmFactorSetImport(db, ctx, {
      ...input,
      previewToken: field(formData, 'previewToken'),
      meta: {
        code: field(formData, 'code'),
        name: field(formData, 'name'),
        origin: field(formData, 'origin'),
        sourceLabel: field(formData, 'sourceLabel'),
        versionLabel: field(formData, 'versionLabel'),
        publishedOn: field(formData, 'publishedOn'),
        referenceYear: field(formData, 'referenceYear'),
        notes: field(formData, 'notes'),
      },
    });
    target = `${BASE}/${encodeURIComponent(set.id)}?flash=ghgFactorSetImported&count=${factors.length}`;
  } catch (error) {
    if (isUserFacingError(error)) return { ok: false, message: error.message };
    throw error;
  }
  revalidateCalculation();
  redirect(target);
}

/** 有効にする（確認ダイアログから。下書きのセットだけ） */
export async function activateFactorSetAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const setId = field(formData, 'setId');
  const back = `${BASE}/${encodeURIComponent(setId)}`;
  await withUserFacingError(back, async () => {
    await activateFactorSet(db, ctx, setId);
  });
  revalidateCalculation();
  redirect(`${back}?flash=ghgFactorSetActivated`);
}

/** 取り下げる（確認ダイアログから。有効なセットだけ） */
export async function retireFactorSetAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const setId = field(formData, 'setId');
  const back = `${BASE}/${encodeURIComponent(setId)}`;
  await withUserFacingError(back, async () => {
    await retireFactorSet(db, ctx, setId, { reason: field(formData, 'reason') });
  });
  revalidateCalculation();
  redirect(`${back}?flash=ghgFactorSetRetired`);
}

function assignmentsHref(periodId: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ view: 'assignments', period: periodId, ...extra });
  return `${BASE}?${params.toString()}`;
}

/** 割り当てる（PreservingForm。断られたら入力を残して理由を出す） */
export async function saveAssignmentAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const periodId = field(formData, 'periodId');
  let flash: Record<string, string> = {};
  const failure = await runPreservingAction(formData, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    // 種類の検査はサービスが行う（読めない値はそのまま渡して断らせる）
    const activityKind = field(formData, 'activityKind') as FactorActivityKind;
    const basisText = field(formData, 'basis');
    const basis = (EMISSION_BASES as readonly string[]).includes(basisText)
      ? (basisText as EmissionBasis)
      : null;
    const level = field(formData, 'level') as AssignmentLevel;
    const activityCode = field(formData, 'activityCode');
    await saveAssignment(db, ctx, {
      periodId,
      level,
      unitId: level === 'unit' ? field(formData, 'unitId') || null : null,
      countryCode: level === 'country' ? field(formData, 'countryCode') || null : null,
      activityKind,
      activityCode,
      basis,
      factorId: field(formData, 'factorId'),
      reason: field(formData, 'reason'),
    });
    flash = {
      flash: 'ghgAssignmentSaved',
      target: field(formData, `levelLabel:${level}`),
      activity: needLabel(activityKind, activityCode, basis),
    };
  });
  if (failure) return failure;
  revalidateCalculation();
  redirect(assignmentsHref(periodId, flash));
}

/** 割当を外す（確認ダイアログから） */
export async function clearAssignmentAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const periodId = field(formData, 'periodId');
  await withUserFacingError(assignmentsHref(periodId), async () => {
    await clearAssignment(db, ctx, { assignmentId: field(formData, 'assignmentId') });
  });
  revalidateCalculation();
  redirect(assignmentsHref(periodId, { flash: 'ghgAssignmentCleared' }));
}
