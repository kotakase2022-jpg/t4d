'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { runPreservingAction } from '@/lib/errors/form-action';
import type { FormActionState } from '@/lib/errors/form-action-state';
import { redirectWithUserError, withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import { saveApprovalRoute, type RouteStageInput } from '@/lib/services/approval-route';
import { recordDataTermsVersion } from '@/lib/services/data-terms';
import { setDisclosureFirst } from '@/lib/services/feature-settings';
import { updateMembership } from '@/lib/services/identity';
import {
  APPROVAL_ROUTE_PURPOSES,
  MAX_APPROVAL_STAGES,
  SUBPROCESSOR_CATEGORIES,
  type ApprovalRoutePurpose,
  type RoleKey,
} from '@/types/domain';

const SETTINGS = '/enterprise/settings';

/**
 * 開示優先モードの切替（企業管理者のみ。権限は Service と RLS の両方で検査する）。
 * 切り替えるとメニューとホームの構成が変わるため、Layout ごと読み直す。
 */
export async function setDisclosureFirstAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();

  // 業務エラーは「機能設定」タブへ戻す（?tab= が無いと既定のメンバーのタブに理由だけが出る）
  const backTo = '/enterprise/settings?tab=features';
  const raw = String(formData.get('disclosureFirst') ?? '');
  if (raw !== 'on' && raw !== 'off') {
    await redirectWithUserError(backTo, '開示優先モードの有効・無効を選んでから保存してください。');
  }

  await withUserFacingError(backTo, async () => {
    await setDisclosureFirst(db, ctx, raw === 'on');
    revalidatePath('/enterprise', 'layout');
    redirect(`/enterprise/settings?flash=disclosureFirstChanged&state=${raw}`);
  });
}

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

/**
 * 承認ルートの保存（トライアル対応 NF-24・NF-44）。段階は 1〜MAX 行の入力（空の段階名の行は使わない）。
 * 保存は既存の saveApprovalRoute（enterprise.org.manage。進行中のデータは写しを持つので経路は変わらない）。
 * 断られたとき（同じ名前・権限・入力の誤り）は、入力（ひな形から入れた名称・段階を含む）を残したまま
 * 理由を編集の欄に示す（PreservingForm）
 */
export async function saveApprovalRouteAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const routeId = text(formData, 'routeId').trim();
  const rawPurpose = text(formData, 'purpose');
  const purpose: ApprovalRoutePurpose = (APPROVAL_ROUTE_PURPOSES as readonly string[]).includes(
    rawPurpose,
  )
    ? (rawPurpose as ApprovalRoutePurpose)
    : 'default';
  const stages: RouteStageInput[] = Array.from({ length: MAX_APPROVAL_STAGES }, (_, index) => ({
    name: text(formData, `stageName${index + 1}`),
    approverRole: text(formData, `stageRole${index + 1}`),
    approverUserId: null,
    department: text(formData, `stageDepartment${index + 1}`),
  }));
  let saved = 0;
  const failure = await runPreservingAction(formData, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const result = await saveApprovalRoute(db, ctx, {
      ...(routeId ? { routeId } : {}),
      name: text(formData, 'name'),
      description: text(formData, 'description'),
      isDefault: text(formData, 'isDefault') === 'on',
      purpose,
      stages,
    });
    saved = result.stages.length;
  });
  if (failure) return failure;
  revalidatePath(SETTINGS);
  redirect(`${SETTINGS}?tab=approval&flash=approvalRouteSaved&stages=${saved}`);
}

/**
 * メンバーの役割・担当拠点の変更（トライアル対応 NF-25。enterprise.member.manage）。
 * 最後の管理者・Demo のログイン利用者の保護はサービスが判定する
 */
export async function updateMembershipAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const membershipId = text(formData, 'membershipId');
  const backTo = `${SETTINGS}?tab=members&edit=${encodeURIComponent(membershipId)}`;
  await withUserFacingError(backTo, async () => {
    await updateMembership(db, ctx, {
      membershipId,
      roleKeys: formData.getAll('roleKeys').map(String) as RoleKey[],
      unitScopeIds: formData.getAll('unitScopeIds').map(String),
    });
  });
  revalidatePath(SETTINGS);
  redirect(`${SETTINGS}?tab=members&flash=membershipUpdated`);
}

/**
 * 利用の停止・再開（トライアル対応 NF-25）。停止の結果の通知に「元に戻す」（＝再開）を出すため、
 * 対象のメンバーシップ ID（内部 ID。氏名・メールは URL に載せない）を通知の引数に付ける
 */
export async function setMembershipStatusAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const membershipId = text(formData, 'membershipId');
  const status = text(formData, 'status') === 'active' ? 'active' : 'suspended';
  await withUserFacingError(`${SETTINGS}?tab=members`, async () => {
    await updateMembership(db, ctx, { membershipId, status });
  });
  revalidatePath(SETTINGS);
  redirect(
    status === 'suspended'
      ? `${SETTINGS}?tab=members&flash=membershipSuspended&member=${encodeURIComponent(membershipId)}`
      : `${SETTINGS}?tab=members&flash=membershipResumed`,
  );
}

/**
 * データ取扱条件の版の記録（トライアル対応 NF-28。追記。enterprise.org.manage）。断ったとき（文字数の上限・
 * 残存期間の範囲など）はリダイレクトせず理由を返し、入れた全部の欄をフォームに残す（PreservingForm）
 */
export async function recordDataTermsAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  let versionNo = 0;
  const failure = await runPreservingAction(formData, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const terms = await recordDataTermsVersion(db, ctx, {
      ndaStatus: text(formData, 'ndaStatus'),
      processingTermsRef: text(formData, 'processingTermsRef'),
      storageLocation: text(formData, 'storageLocation'),
      retentionPolicy: text(formData, 'retentionPolicy'),
      aiTrainingUse: text(formData, 'aiTrainingUse'),
      aiProviderStorage: text(formData, 'aiProviderStorage'),
      // 処理を委ねる先は区分ごとの欄（業務委託先・クラウド・AI・その他）。以前の 1 欄の入力も受ける
      subprocessorsText: text(formData, 'subprocessors'),
      subprocessorsByCategory: Object.fromEntries(
        SUBPROCESSOR_CATEGORIES.map((category) => [
          category,
          text(formData, `subprocessors.${category}`),
        ]),
      ),
      returnMethod: text(formData, 'returnMethod'),
      deletionMethod: text(formData, 'deletionMethod'),
      backupResidualDays: formData.has('backupResidualDays')
        ? text(formData, 'backupResidualDays')
        : undefined,
      agreedOn: text(formData, 'agreedOn'),
      agreedByLabel: text(formData, 'agreedByLabel'),
      note: text(formData, 'note'),
    });
    versionNo = terms.versionNo;
  });
  if (failure) return failure;
  revalidatePath(SETTINGS);
  redirect(`${SETTINGS}?tab=data-handling&flash=dataTermsRecorded&version=${versionNo}`);
}
