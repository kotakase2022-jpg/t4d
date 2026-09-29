'use server';

import { revalidatePath } from 'next/cache';
import { redirect, unstable_rethrow } from 'next/navigation';
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
  ProjectFrameworkConflictError,
  type ChangeImpact,
  type DecisionStatus,
  type ProjectConflictField,
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
  status: 'idle' | 'error' | 'needs_confirmation' | 'unchanged' | 'conflict';
  message: string | null;
  fieldErrors: Record<string, string>;
  impact: ChangeImpact | null;
  changedFields: string[];
  values: ProjectFormValues | null;
  /** 競合のとき: 上書きになる項目（最新の値とあなたの入力） */
  conflictFields?: ProjectConflictField[];
  /**
   * 次の保存で使う土台の更新時刻。競合を見たうえで「このまま上書き保存」するときは最新の時刻を渡す
   * （画面を開いたときの時刻のままでは、何度押しても競合になる）
   */
  baseUpdatedAt?: string;
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
    // ログイン切れ・ワークスペースの切替による redirect() は、失敗として握りつぶさずに Next.js へ返す
    unstable_rethrow(error);
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
        ...(strOrNull(formData, 'baseUpdatedAt')
          ? { baseUpdatedAt: str(formData, 'baseUpdatedAt') }
          : {}),
      },
      { confirmImpact: str(formData, 'confirmImpact') === '1' },
    );
  } catch (error) {
    // ログイン切れ・ワークスペースの切替による redirect() は、失敗として握りつぶさずに Next.js へ返す
    unstable_rethrow(error);
    return errorState(error, formData);
  }

  if (result.status === 'conflict') {
    return {
      status: 'conflict',
      message: `この画面を開いた後に、${result.updatedByName} さんがプロジェクト情報を保存しました。上書きせずに止めました（あなたの入力は残っています）。下の項目は、保存すると最新の値を上書きします。最新の値を読み込んで確認するか、このまま上書き保存してください。`,
      fieldErrors: {},
      impact: null,
      changedFields: result.fields.map((f) => f.key),
      values: valuesOf(formData),
      conflictFields: result.fields,
      baseUpdatedAt: result.currentUpdatedAt,
    };
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

export interface FrameworkConditionsFormState {
  status: 'idle' | 'error' | 'conflict';
  message: string | null;
  /** 競合を見たうえで上書き保存するときの土台の更新時刻 */
  baseUpdatedAt?: string;
  /** 項目ごとのエラー（name をキーにする。例: condition.euNetTurnoverLatestFy） */
  fieldErrors: Record<string, string>;
  /** 入力した値（失敗しても消さない） */
  values: Record<string, string>;
}

/**
 * 「保存して準備を始める」（フォームの状態を返す版）。入力を読めないときはリダイレクトせず、
 * 入力した値と項目ごとの理由を返す（リダイレクトすると、その回に入力した条件がすべて保存前の値へ戻っていた）
 */
export async function saveProjectFrameworkFormAction(
  _previous: FrameworkConditionsFormState,
  formData: FormData,
): Promise<FrameworkConditionsFormState> {
  const projectId = str(formData, 'projectId');
  const projectFrameworkId = str(formData, 'projectFrameworkId');
  const values: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (
      typeof value === 'string' &&
      (key.startsWith('condition.') || key === 'preparationStatus')
    ) {
      values[key] = value;
    }
  }
  try {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
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
      ...(strOrNull(formData, 'baseUpdatedAt')
        ? { baseUpdatedAt: str(formData, 'baseUpdatedAt') }
        : {}),
    });
  } catch (error) {
    // ログイン切れ・ワークスペースの切替による redirect() は、失敗として握りつぶさずに Next.js へ返す
    unstable_rethrow(error);
    if (error instanceof ProjectFrameworkConflictError) {
      return {
        status: 'conflict',
        message: error.message,
        fieldErrors: {},
        values,
        baseUpdatedAt: error.currentUpdatedAt,
      };
    }
    if (error instanceof FieldValidationError) {
      return { status: 'error', message: error.message, fieldErrors: error.fieldErrors, values };
    }
    if (isUserFacingError(error)) {
      return { status: 'error', message: error.message, fieldErrors: {}, values };
    }
    console.error('[project framework]', error);
    return {
      status: 'error',
      message: '保存に失敗しました。入力は残っています。時間をおいて再試行してください。',
      fieldErrors: {},
      values,
    };
  }
  revalidatePath(`${BASE}/${projectId}`);
  redirect(`${settingsPath(projectId)}&flash=frameworkSaved#pf-${projectFrameworkId}`);
}

/** 「適用判断を確定」: 理由・参照規則・確認日を必須にして判断を追記する */
/** 適用判断の確定フォームの入力値（失敗しても消さない） */
export interface ApplicabilityDecisionValues {
  applicabilityStatus: string;
  reason: string;
  ruleRef: string;
  confirmedOn: string;
  transitionalNote: string;
}

export interface ApplicabilityDecisionFormState {
  status: 'idle' | 'error';
  message: string | null;
  values: ApplicabilityDecisionValues | null;
}

/**
 * 適用判断を確定する（フォームの状態を返す版）。理由が空白だけ等で断られたときはリダイレクトせず、
 * 入力した理由・経過措置の注記を返す（リダイレクトすると、書いた理由が消えていた）
 */
export async function confirmApplicabilityFormAction(
  _previous: ApplicabilityDecisionFormState,
  formData: FormData,
): Promise<ApplicabilityDecisionFormState> {
  const projectId = str(formData, 'projectId');
  const projectFrameworkId = str(formData, 'projectFrameworkId');
  const values: ApplicabilityDecisionValues = {
    applicabilityStatus: str(formData, 'applicabilityStatus'),
    reason: str(formData, 'reason'),
    ruleRef: str(formData, 'ruleRef'),
    confirmedOn: str(formData, 'confirmedOn'),
    transitionalNote: str(formData, 'transitionalNote'),
  };
  let decisionNo: number;
  try {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    // 区分の妥当性（未判定は確定できない等）は Service が検証する
    const decision = await confirmApplicability(db, ctx, {
      projectFrameworkId,
      applicabilityStatus: values.applicabilityStatus as DecisionStatus,
      reason: values.reason,
      ruleRef: values.ruleRef,
      confirmedOn: values.confirmedOn,
      transitionalNote: strOrNull(formData, 'transitionalNote'),
    });
    decisionNo = decision.decisionNo;
  } catch (error) {
    // ログイン切れ・ワークスペースの切替による redirect() は、失敗として握りつぶさずに Next.js へ返す
    unstable_rethrow(error);
    if (isUserFacingError(error)) return { status: 'error', message: error.message, values };
    console.error('[confirm applicability]', error);
    return {
      status: 'error',
      message: '適用判断を確定できませんでした。時間をおいて再試行してください。',
      values,
    };
  }
  revalidatePath(`${BASE}/${projectId}`);
  redirect(
    `${settingsPath(projectId)}&flash=applicabilityConfirmed&no=${decisionNo}#pf-${projectFrameworkId}`,
  );
}

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
