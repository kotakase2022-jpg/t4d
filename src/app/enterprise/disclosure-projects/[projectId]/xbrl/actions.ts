'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { runPreservingAction } from '@/lib/errors/form-action';
import type { FormActionState } from '@/lib/errors/form-action-state';
import { ValidationError, withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import {
  confirmMappings,
  deleteMapping,
  excludeMapping,
  parsePeriodRole,
  restoreMapping,
  saveFilingIdentifier,
  saveMapping,
  setFrameworkTaxonomy,
  suggestMappings,
} from '@/lib/services/xbrl-tagging';

/**
 * 開示プロジェクトの「XBRL」タブの Server Actions（トライアル対応 NF-42）。入力の取り出しと再検証だけを行い、
 * 業務の判定（権限・職務分離・対象・概念の検査）は src/lib/services/xbrl-tagging.ts が行う。
 *
 * 成功したら XBRL タブへ結果の符号（xbrlResult）付きで戻す（タブが文言を出す）。利用者向けのエラーは、
 * 入力を伴うフォーム（対応付けの保存・識別子）は入力を残して理由を返し、それ以外は ?error= で戻す。
 * 表示中のスナップショット・基準（snapshot・fw）は戻り先に引き継ぐ。
 */

function str(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function xbrlPath(formData: FormData, params: Record<string, string> = {}): string {
  const projectId = str(formData, 'projectId');
  const query = new URLSearchParams({ tab: 'xbrl' });
  const snapshot = str(formData, 'snapshot');
  const fw = str(formData, 'fw');
  if (snapshot) query.set('snapshot', snapshot);
  if (fw) query.set('fw', fw);
  for (const [key, value] of Object.entries(params)) query.set(key, value);
  return `/enterprise/disclosure-projects/${encodeURIComponent(projectId)}?${query.toString()}`;
}

function revalidateProject(formData: FormData): void {
  revalidatePath(`/enterprise/disclosure-projects/${str(formData, 'projectId')}`);
}

/** 精度（decimals）。空は未設定（検証が V05 で知らせる）。数でなければ断る */
function parseDecimals(value: string): number | null {
  const text = value.trim();
  if (text === '') return null;
  const n = Number(text);
  if (!Number.isInteger(n)) {
    throw new ValidationError('精度（decimals）は整数で入力してください。');
  }
  return n;
}

/** 軸の選択（dim:<軸の名前> = メンバーの名前） */
function parseDimensions(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith('dim:') && typeof value === 'string' && value !== '') {
      out[key.slice(4)] = value;
    }
  }
  return out;
}

/** 対応付けを作る・変える（候補として保存。確定済みの内容を変えると候補に戻る） */
export async function saveXbrlMappingAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const mappingId = str(formData, 'mappingId');
  const failure = await runPreservingAction(formData, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await saveMapping(db, ctx, {
      projectId: str(formData, 'projectId'),
      mappingId: mappingId || null,
      packageId: str(formData, 'packageId'),
      conceptId: str(formData, 'conceptId'),
      targetKey: str(formData, 'targetKey'),
      disclosureItemId: str(formData, 'disclosureItemId') || null,
      periodRole: parsePeriodRole(str(formData, 'periodRole')),
      decimals: parseDecimals(str(formData, 'decimals')),
      dimensions: parseDimensions(formData),
    });
  });
  if (failure) return failure;
  revalidateProject(formData);
  redirect(xbrlPath(formData, { xbrlResult: mappingId ? 'updated' : 'saved' }));
}

/** 選んだ候補を確定する（行の「確定…」・一括の「選択した対応付けを確定」） */
export async function confirmXbrlMappingsAction(formData: FormData): Promise<void> {
  const ids = [
    ...formData.getAll('selected').filter((v): v is string => typeof v === 'string'),
    str(formData, 'mappingId'),
  ].filter((v) => v !== '');
  let confirmed = 0;
  let skipped = 0;
  await withUserFacingError(xbrlPath(formData), async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const result = await confirmMappings(db, ctx, { mappingIds: ids });
    confirmed = result.confirmed.length;
    skipped = result.skipped.length;
  });
  revalidateProject(formData);
  redirect(
    xbrlPath(formData, { xbrlResult: 'confirmed', n: String(confirmed), skipped: String(skipped) }),
  );
}

/** 対象外にする（理由必須） */
export async function excludeXbrlMappingAction(formData: FormData): Promise<void> {
  await withUserFacingError(xbrlPath(formData), async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await excludeMapping(db, ctx, {
      mappingId: str(formData, 'mappingId'),
      reason: str(formData, 'reason'),
    });
  });
  revalidateProject(formData);
  redirect(xbrlPath(formData, { xbrlResult: 'excluded' }));
}

/** 対象外を取り消す（候補に戻す） */
export async function restoreXbrlMappingAction(formData: FormData): Promise<void> {
  await withUserFacingError(xbrlPath(formData), async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await restoreMapping(db, ctx, { mappingId: str(formData, 'mappingId') });
  });
  revalidateProject(formData);
  redirect(xbrlPath(formData, { xbrlResult: 'restored' }));
}

/** 対応付けを削除する（論理削除。履歴は残る） */
export async function deleteXbrlMappingAction(formData: FormData): Promise<void> {
  await withUserFacingError(xbrlPath(formData), async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await deleteMapping(db, ctx, { mappingId: str(formData, 'mappingId') });
  });
  revalidateProject(formData);
  redirect(xbrlPath(formData, { xbrlResult: 'deleted' }));
}

/** AI に未対応付けの対象の候補を出させる（候補の行として入る。確定は承認権限者） */
export async function suggestXbrlMappingsAction(formData: FormData): Promise<void> {
  let created = 0;
  let provider = 'mock';
  await withUserFacingError(xbrlPath(formData), async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const result = await suggestMappings(db, ctx, {
      projectId: str(formData, 'projectId'),
      snapshotId: str(formData, 'snapshot') || null,
      frameworkVersionId: str(formData, 'fw') || null,
    });
    created = result.created.length;
    provider = result.provider;
  });
  revalidateProject(formData);
  revalidatePath('/enterprise/ai');
  redirect(
    xbrlPath(formData, {
      xbrlResult: 'suggested',
      n: String(created),
      ai: provider === 'mock' ? 'mock' : 'openai',
    }),
  );
}

/** 基準の XBRL のタクソノミを設定する・外す */
export async function setXbrlTaxonomyAction(formData: FormData): Promise<void> {
  await withUserFacingError(xbrlPath(formData), async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await setFrameworkTaxonomy(db, ctx, {
      projectId: str(formData, 'projectId'),
      projectFrameworkId: str(formData, 'projectFrameworkId'),
      packageId: str(formData, 'packageId') || null,
    });
  });
  revalidateProject(formData);
  redirect(xbrlPath(formData, { xbrlResult: 'taxonomy' }));
}

/** 提出者の識別子を保存する（企業の管理者。デモは架空の sample だけ） */
export async function saveFilingIdentifierAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const failure = await runPreservingAction(formData, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await saveFilingIdentifier(db, ctx, {
      scheme: str(formData, 'scheme'),
      value: str(formData, 'value'),
    });
  });
  if (failure) return failure;
  revalidateProject(formData);
  redirect(xbrlPath(formData, { xbrlResult: 'identifier' }));
}
