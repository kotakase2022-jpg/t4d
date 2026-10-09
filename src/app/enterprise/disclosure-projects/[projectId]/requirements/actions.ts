'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { recordAiDecision } from '@/lib/ai';
import { recordAiFeedback, rejectionReasonOf } from '@/lib/ai/feedback';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { NotFoundError } from '@/lib/authorization/can';
import { runPreservingAction } from '@/lib/errors/form-action';
import type { FormActionState } from '@/lib/errors/form-action-state';
import { withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import { loadCrosswalkSuggestion } from '@/lib/services/crosswalk';
import { saveProjectRequirementAssessment } from '@/lib/services/project-requirement-assessment';
import {
  decideExclusion,
  requestExclusion,
  withdrawExclusion,
  type ExclusionTargetInput,
} from '@/lib/services/requirement-exclusion';
import { suggestRequirementMappings } from '@/lib/services/requirement-mapping-ai';
import { isUuid } from '@/lib/validation/uuid';

/**
 * 要求事項の判断・対象外の申請と承認・横断対応の AI 候補の Server Action（トライアル対応 NF-01・02・09・11。T1）。
 * 入力の取り出しと再検証だけを行い、判断はサービス（project-requirement-assessment・requirement-exclusion）が持つ。
 * 戻り先は画面の種類（returnTo）からサーバーで組み立てる（任意の URL へ戻さない）。
 */

const PROJECTS = '/enterprise/disclosure-projects';

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

function safeId(value: string): string {
  return isUuid(value) ? value : '';
}

function detailPath(projectId: string, itemId: string): string {
  return `${PROJECTS}/${safeId(projectId)}/requirements/${safeId(itemId)}`;
}

/** 操作した画面へ戻す（要求事項の詳細・要求事項タブ・SSBJ 要求事項の詳細） */
function returnPath(formData: FormData): string {
  const projectId = safeId(field(formData, 'projectId'));
  const itemId = safeId(field(formData, 'itemId'));
  const returnTo = field(formData, 'returnTo');
  if (returnTo === 'ssbj') {
    const period = safeId(field(formData, 'reportingPeriodId'));
    return `/enterprise/disclosures/ssbj/requirements/${itemId}${period ? `?period=${period}` : ''}`;
  }
  if (returnTo === 'requirements' && projectId) {
    const params = new URLSearchParams({ tab: 'requirements' });
    const fw = field(formData, 'fw');
    if (fw === 'all' || isUuid(fw)) params.set('fw', fw);
    return `${PROJECTS}/${projectId}?${params.toString()}`;
  }
  return detailPath(projectId, itemId);
}

function withFlash(path: string, flash: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}flash=${flash}`;
}

function targetOf(formData: FormData): ExclusionTargetInput {
  const itemId = field(formData, 'itemId');
  if (field(formData, 'source') === 'ssbj_assessment') {
    return {
      source: 'ssbj_assessment',
      itemId,
      reportingPeriodId: field(formData, 'reportingPeriodId'),
    };
  }
  return {
    source: 'project_assessment',
    itemId,
    projectFrameworkId: field(formData, 'projectFrameworkId'),
  };
}

function revalidateRequirement(formData: FormData): void {
  const projectId = safeId(field(formData, 'projectId'));
  if (projectId) revalidatePath(`${PROJECTS}/${projectId}`, 'layout');
  revalidatePath('/enterprise/disclosures/ssbj', 'layout');
  revalidatePath('/enterprise/dashboard');
}

/** 要求事項の判断と 3 観点の評価を記録する（断られたら入力を残して理由を示す） */
export async function saveRequirementAssessmentAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const optional = (name: string) => {
    const value = field(formData, name).trim();
    return value === '' ? null : value;
  };
  let exclusionChanged = false;
  let changed = false;
  const failure = await runPreservingAction(formData, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const result = await saveProjectRequirementAssessment(db, ctx, {
      projectFrameworkId: field(formData, 'projectFrameworkId'),
      itemId: field(formData, 'itemId'),
      applicability: field(formData, 'applicability'),
      applicabilityReason: field(formData, 'applicabilityReason'),
      ruleRef: field(formData, 'ruleRef'),
      disclosureCoverage: optional('disclosureCoverage'),
      dataCoverage: optional('dataCoverage'),
      processCoverage: optional('processCoverage'),
      missingInformation: field(formData, 'missingInformation'),
      ownerUserId: optional('ownerUserId'),
      dueOn: optional('dueOn'),
      actionNote: field(formData, 'actionNote'),
      changeReason: field(formData, 'changeReason'),
    });
    changed = result.changed;
    exclusionChanged = result.exclusionChanged;
  });
  if (failure) return failure;
  revalidateRequirement(formData);
  const back = detailPath(field(formData, 'projectId'), field(formData, 'itemId'));
  redirect(
    withFlash(
      back,
      !changed
        ? 'requirementAssessmentUnchanged'
        : exclusionChanged
          ? 'requirementAssessedExclusion'
          : 'requirementAssessed',
    ),
  );
}

/** 対象外・非重要として申請する */
export async function requestExclusionAction(formData: FormData): Promise<void> {
  const back = returnPath(formData);
  await withUserFacingError(back, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await requestExclusion(db, ctx, targetOf(formData));
  });
  revalidateRequirement(formData);
  redirect(withFlash(back, 'exclusionRequested'));
}

/** 対象外を承認する（取り消せない。確認ダイアログを通す） */
export async function approveExclusionAction(formData: FormData): Promise<void> {
  const back = returnPath(formData);
  await withUserFacingError(back, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await decideExclusion(db, ctx, { ...targetOf(formData), decision: 'approved' });
  });
  revalidateRequirement(formData);
  redirect(withFlash(back, 'exclusionApproved'));
}

/** 対象外の申請を差し戻す（理由必須） */
export async function returnExclusionAction(formData: FormData): Promise<void> {
  const back = returnPath(formData);
  await withUserFacingError(back, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await decideExclusion(db, ctx, {
      ...targetOf(formData),
      decision: 'returned',
      note: field(formData, 'note'),
    });
  });
  revalidateRequirement(formData);
  redirect(withFlash(back, 'exclusionReturned'));
}

/** 対象外の申請を取り下げる */
export async function withdrawExclusionAction(formData: FormData): Promise<void> {
  const back = returnPath(formData);
  await withUserFacingError(back, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await withdrawExclusion(db, ctx, targetOf(formData));
  });
  revalidateRequirement(formData);
  redirect(withFlash(back, 'exclusionWithdrawn'));
}

// ----------------------------------------------------------------------
// 横断対応表: AI の対応候補（表示のみ。横断のマスターには書かない）
// ----------------------------------------------------------------------

function crosswalkPath(projectId: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ tab: 'crosswalk', ...extra });
  return `${PROJECTS}/${safeId(projectId)}?${params.toString()}`;
}

/** SSBJ の要求事項 1 件について、プロジェクトの他の基準の要求事項から対応の候補を AI に出させる */
export async function suggestCrosswalkCandidatesAction(formData: FormData): Promise<void> {
  const projectId = field(formData, 'projectId');
  const back = crosswalkPath(projectId, { ai: '1' });
  let runId = '';
  let provider = 'mock';
  await withUserFacingError(back, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const versions = formData
      .getAll('frameworkVersionId')
      .filter((v): v is string => typeof v === 'string' && isUuid(v));
    const result = await suggestRequirementMappings(db, ctx, {
      target: { kind: 'requirement_item', id: field(formData, 'itemId') },
      frameworkVersionIds: versions,
    });
    runId = result.run.id;
    provider = result.run.provider;
  });
  revalidatePath(`${PROJECTS}/${safeId(projectId)}`);
  redirect(
    `${crosswalkPath(projectId, { run: runId })}&flash=crosswalkCandidatesReady&ai=${provider === 'mock' ? 'mock' : 'openai'}`,
  );
}

/** 横断の候補を採用しない（理由は任意。AI の改善の検討に使う） */
export async function rejectCrosswalkCandidatesAction(formData: FormData): Promise<void> {
  const projectId = field(formData, 'projectId');
  const runId = field(formData, 'runId');
  const back = crosswalkPath(projectId, { run: runId });
  await withUserFacingError(back, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    // 自社の・このプロジェクトの基準の候補であることを確かめてから記録する
    const suggestion = await loadCrosswalkSuggestion(db, ctx, { projectId, runId });
    if (!suggestion) throw new NotFoundError('AI の候補が見つかりません。');
    await recordAiDecision(db, ctx, suggestion.run.id, 'rejected', null);
    await recordAiFeedback(db, ctx, {
      aiRunId: suggestion.run.id,
      decision: 'rejected',
      comment: rejectionReasonOf(formData),
    });
  });
  revalidatePath(`${PROJECTS}/${safeId(projectId)}`);
  redirect(`${crosswalkPath(projectId)}&flash=crosswalkCandidatesRejected`);
}
