'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { isUserFacingError, withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import {
  FieldValidationError,
  PREPARATION_STATUSES,
  attachFrameworkVersion,
  confirmApplicability,
  createProject,
  getProject,
  parseFrameworkConditions,
  saveProjectFramework,
  updateProject,
  type ChangeImpact,
  type DecisionStatus,
  type PreparationStatus,
} from '@/lib/services/disclosure-project';
import {
  DISCLOSURE_LANGUAGES,
  DISCLOSURE_PROJECT_STATUSES,
  DISCLOSURE_PURPOSES,
  type DisclosureLanguage,
  type DisclosureProjectStatus,
  type DisclosurePurpose,
} from '@/types/domain';

/**
 * 開示プロジェクトの Server Actions（入力の取り出しと再検証だけ。業務規則は Service 側）。
 * 認可は Service の assertCan と RLS の二重。組織・実行者はセッションから導出し、フォームの値を信用しない。
 */

const BASE = '/enterprise/disclosure-projects';

/** フォームの値（失敗時に入力を保つため、送信した値をそのまま返す） */
export type ProjectFormValues = Record<string, string | string[]>;

export interface ProjectFormState {
  status: 'idle' | 'error' | 'needs_confirmation' | 'unchanged';
  message: string | null;
  fieldErrors: Record<string, string>;
  impact: ChangeImpact | null;
  changedFields: string[];
  values: ProjectFormValues | null;
}

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '');
}

function strOrNull(formData: FormData, key: string): string | null {
  const value = str(formData, key).trim();
  return value === '' ? null : value;
}

function valuesOf(formData: FormData): ProjectFormValues {
  const values: ProjectFormValues = {};
  for (const key of new Set(formData.keys())) {
    if (key.startsWith('$ACTION')) continue;
    const all = formData.getAll(key).map((v) => (typeof v === 'string' ? v : ''));
    values[key] =
      all.length > 1 || ['purposes', 'languages', 'includedUnitIds'].includes(key)
        ? all
        : (all[0] ?? '');
  }
  return values;
}

function purposesOf(formData: FormData): DisclosurePurpose[] {
  return formData
    .getAll('purposes')
    .map(String)
    .filter((p): p is DisclosurePurpose => (DISCLOSURE_PURPOSES as readonly string[]).includes(p));
}

function languagesOf(formData: FormData): DisclosureLanguage[] {
  return formData
    .getAll('languages')
    .map(String)
    .filter((l): l is DisclosureLanguage =>
      (DISCLOSURE_LANGUAGES as readonly string[]).includes(l),
    );
}

function errorState(error: unknown, formData: FormData): ProjectFormState {
  if (error instanceof FieldValidationError) {
    return {
      status: 'error',
      message: '入力内容を確認してください。',
      fieldErrors: error.fieldErrors,
      impact: null,
      changedFields: [],
      values: valuesOf(formData),
    };
  }
  if (isUserFacingError(error)) {
    return {
      status: 'error',
      message: error.message,
      fieldErrors: {},
      impact: null,
      changedFields: [],
      values: valuesOf(formData),
    };
  }
  throw error;
}

/** 新規作成（3 段階のフォーム）。成功したらプロジェクトの概要へ移る */
export async function createProjectAction(
  _previous: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const purposes = purposesOf(formData);
  const frameworkVersionByPurpose: Partial<Record<DisclosurePurpose, string>> = {};
  for (const purpose of purposes) {
    const versionId = strOrNull(formData, `frameworkVersion.${purpose}`);
    if (versionId) frameworkVersionByPurpose[purpose] = versionId;
  }
  const preparationRaw = str(formData, 'preparationStatus');
  const preparationStatus: PreparationStatus = (PREPARATION_STATUSES as readonly string[]).includes(
    preparationRaw,
  )
    ? (preparationRaw as PreparationStatus)
    : 'candidate';

  let projectId: string;
  try {
    const { project } = await createProject(db, ctx, {
      name: str(formData, 'name'),
      reportingEntity: str(formData, 'reportingEntity'),
      reportingPeriodId: str(formData, 'reportingPeriodId'),
      periodStart: str(formData, 'periodStart'),
      periodEnd: str(formData, 'periodEnd'),
      currency: str(formData, 'currency'),
      ownerUserId: strOrNull(formData, 'ownerUserId'),
      dueDate: strOrNull(formData, 'dueDate'),
      purposes,
      frameworkVersionByPurpose,
      preparationStatus,
      scopeOrgNote: str(formData, 'scopeOrgNote'),
      scopeConsolidationNote: str(formData, 'scopeConsolidationNote'),
      scopeGhgBoundaryNote: str(formData, 'scopeGhgBoundaryNote'),
      scopeValueChainNote: str(formData, 'scopeValueChainNote'),
      includedUnitIds: formData.getAll('includedUnitIds').map(String),
      languages: languagesOf(formData),
      reviewerUserId: strOrNull(formData, 'reviewerUserId'),
      finalApproverUserId: strOrNull(formData, 'finalApproverUserId'),
    });
    projectId = project.id;
  } catch (error) {
    return errorState(error, formData);
  }
  revalidatePath(BASE);
  redirect(`${BASE}/${projectId}?flash=projectCreated`);
}

/** プロジェクト情報の更新。報告範囲を変えるときは影響一覧を返し、確認後に保存する */
export async function updateProjectAction(
  _previous: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const projectId = str(formData, 'projectId');
  const statusRaw = str(formData, 'status');
  let result;
  try {
    result = await updateProject(
      db,
      ctx,
      projectId,
      {
        name: str(formData, 'name'),
        reportingEntity: str(formData, 'reportingEntity'),
        periodStart: str(formData, 'periodStart'),
        periodEnd: str(formData, 'periodEnd'),
        currency: str(formData, 'currency'),
        dueDate: strOrNull(formData, 'dueDate'),
        status: ((DISCLOSURE_PROJECT_STATUSES as readonly string[]).includes(statusRaw)
          ? statusRaw
          : '') as DisclosureProjectStatus,
        ownerUserId: strOrNull(formData, 'ownerUserId'),
        reviewerUserId: strOrNull(formData, 'reviewerUserId'),
        finalApproverUserId: strOrNull(formData, 'finalApproverUserId'),
        languages: languagesOf(formData),
        scopeOrgNote: str(formData, 'scopeOrgNote'),
        scopeConsolidationNote: str(formData, 'scopeConsolidationNote'),
        scopeGhgBoundaryNote: str(formData, 'scopeGhgBoundaryNote'),
        scopeValueChainNote: str(formData, 'scopeValueChainNote'),
        includedUnitIds: formData.getAll('includedUnitIds').map(String),
      },
      { confirmImpact: str(formData, 'confirmImpact') === '1' },
    );
  } catch (error) {
    return errorState(error, formData);
  }

  if (result.status === 'needs_confirmation') {
    return {
      status: 'needs_confirmation',
      message:
        '報告範囲・期間の変更は、次の原稿・数値・承認の前提に影響します。原稿は自動では書き換えません。内容を確認してから保存してください。',
      fieldErrors: {},
      impact: result.impact,
      changedFields: result.changedFields,
      values: valuesOf(formData),
    };
  }
  if (result.status === 'unchanged') {
    return {
      status: 'unchanged',
      message: '変更はありませんでした。',
      fieldErrors: {},
      impact: null,
      changedFields: [],
      values: valuesOf(formData),
    };
  }
  revalidatePath(`${BASE}/${projectId}`);
  revalidatePath(BASE);
  redirect(
    `${BASE}/${projectId}?tab=settings&flash=projectUpdated&impacted=${result.impact.blocks.length}`,
  );
}

function settingsPath(projectId: string): string {
  return `${BASE}/${projectId}?tab=settings`;
}

/** 「保存して準備を始める」: 適用条件と準備の区分の保存（判断は確定しない） */
export async function saveProjectFrameworkAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const projectId = str(formData, 'projectId');
  const projectFrameworkId = str(formData, 'projectFrameworkId');
  const back = settingsPath(projectId);
  await withUserFacingError(back, async () => {
    const detail = await getProject(db, ctx, projectId);
    const view = detail.frameworks.find((f) => f.projectFramework.id === projectFrameworkId);
    if (!view) throw new FieldValidationError({ projectFrameworkId: '基準が見つかりません。' });
    const conditions = parseFrameworkConditions(view.frameworkKey, (key) => str(formData, key));
    const statusRaw = str(formData, 'preparationStatus');
    await saveProjectFramework(db, ctx, {
      projectFrameworkId,
      conditions,
      preparationStatus: (PREPARATION_STATUSES as readonly string[]).includes(statusRaw)
        ? (statusRaw as PreparationStatus)
        : 'candidate',
    });
  });
  revalidatePath(`${BASE}/${projectId}`);
  redirect(`${back}&flash=frameworkSaved#pf-${projectFrameworkId}`);
}

/** 「適用判断を確定」: 理由・参照規則・確認日を必須にして判断を追記する */
export async function confirmApplicabilityAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const projectId = str(formData, 'projectId');
  const projectFrameworkId = str(formData, 'projectFrameworkId');
  const back = settingsPath(projectId);
  const statusRaw = str(formData, 'applicabilityStatus');
  let decisionNo = 0;
  await withUserFacingError(back, async () => {
    // 区分の妥当性（未判定は確定できない等）は Service が検証する
    const decision = await confirmApplicability(db, ctx, {
      projectFrameworkId,
      applicabilityStatus: statusRaw as DecisionStatus,
      reason: str(formData, 'reason'),
      ruleRef: str(formData, 'ruleRef'),
      confirmedOn: str(formData, 'confirmedOn'),
      transitionalNote: strOrNull(formData, 'transitionalNote'),
    });
    decisionNo = decision.decisionNo;
  });
  revalidatePath(`${BASE}/${projectId}`);
  redirect(`${back}&flash=applicabilityConfirmed&no=${decisionNo}#pf-${projectFrameworkId}`);
}

/** 新しい版を追加で登録する（旧版・原稿・判断は残す。影響の確認が必須） */
export async function attachFrameworkVersionAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const projectId = str(formData, 'projectId');
  const back = settingsPath(projectId);
  await withUserFacingError(back, async () => {
    await attachFrameworkVersion(db, ctx, {
      projectFrameworkId: str(formData, 'projectFrameworkId'),
      newVersionId: str(formData, 'newVersionId'),
      acknowledgeImpact: formData.get('acknowledgeImpact') === 'on',
    });
  });
  revalidatePath(`${BASE}/${projectId}`);
  redirect(`${back}&flash=frameworkVersionAttached`);
}
