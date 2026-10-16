'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { runPreservingAction } from '@/lib/errors/form-action';
import { formValuesOf, type FormActionState } from '@/lib/errors/form-action-state';
import { ValidationError, withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import { judgeScenario, recordScenarioRun } from '@/lib/services/trial-evaluation';
import {
  recordReverification,
  submitFeedback,
  triageFeedback,
} from '@/lib/services/trial-feedback';
import {
  PLANNED_KEYS,
  saveTrialProgram,
  type PlannedKey,
  type TrialProgramPatch,
} from '@/lib/services/trial-program';
import { recordTaskTiming } from '@/lib/services/trial-timing';
import { TRIAL_AGREEMENT_KEYS, type GhgActivityKind, type GhgScope } from '@/types/domain';
import { FEEDBACK_FIELDS, type FeedbackFormState } from './_lib/feedback-state';

/**
 * トライアルの評価の Server Actions（NF-32〜NF-35）。入力の取り出しと再検証・遷移だけを行う。
 * 権限（計画・判定・改善管理表の更新は enterprise.org.manage、記録は組織の有効なメンバー本人）・
 * 入力の検査・監査ログはサービスが行う。断られたときは入力を残して理由を示す（PreservingForm）。
 */

const BASE = '/enterprise/trial';

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

function fields(formData: FormData, name: string): string[] {
  return formData.getAll(name).filter((v): v is string => typeof v === 'string');
}

/** 数値の欄（空は null。数値でなければ利用者向けのエラー） */
function numberField(formData: FormData, name: string, label: string): number | null {
  const raw = field(formData, name).trim().replace(/,/g, '');
  if (raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ValidationError(`${label}は数値で入力してください。`);
  return value;
}

function done(tab: string, flash: string, extra: Record<string, string> = {}): never {
  revalidatePath(BASE);
  const params = new URLSearchParams({ tab, flash, ...extra });
  redirect(`${BASE}?${params.toString()}`);
}

// ----------------------------------------------------------------------
// 計画（NF-32）
// ----------------------------------------------------------------------

const PLANNED_FIELD_LABELS: Readonly<Record<PlannedKey, string>> = {
  plannedMembers: '利用者（ID）の計画値',
  plannedSites: '対象拠点の計画値',
  plannedQuantitativeMetrics: '定量指標の計画値',
  plannedNarrativeBlocks: '定性情報の計画値',
  plannedRequirements: '要求事項の計画値',
  plannedFiscalYears: '年度の計画値',
  plannedFiles: '資料の計画値',
  plannedApprovalLevels: '承認段階の計画値',
};

export async function saveTrialPlanAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  let created = false;
  const failure = await runPreservingAction(formData, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const planned: Partial<Record<PlannedKey, number | null>> = {};
    for (const key of PLANNED_KEYS) {
      planned[key] = numberField(formData, key, PLANNED_FIELD_LABELS[key]);
    }
    const targetMin = numberField(formData, 'targetMin', '短縮の目標（下限）');
    const targetMax = numberField(formData, 'targetMax', '短縮の目標（上限）');
    if ((targetMin === null) !== (targetMax === null)) {
      throw new ValidationError(
        '短縮の目標は下限と上限の両方を入力してください（未設定は両方空）。',
      );
    }
    const cdp = field(formData, 'cdpPlanned');
    const patch: TrialProgramPatch = {
      name: field(formData, 'name'),
      phase: field(formData, 'phase'),
      startsOn: field(formData, 'startsOn'),
      endsOn: field(formData, 'endsOn'),
      projectId: field(formData, 'projectId'),
      includedUnitIds: fields(formData, 'includedUnitIds'),
      targetDataNote: field(formData, 'targetDataNote'),
      planned,
      cdpPlanned: cdp === 'yes' ? true : cdp === 'no' ? false : null,
      reductionTarget:
        targetMin === null || targetMax === null
          ? null
          : { minPercent: targetMin, maxPercent: targetMax },
      // 算定の検証範囲・将来の展開対象・無償の範囲の目安（値の検査はサービス）
      ghgVerification: {
        periodId: field(formData, 'ghgPeriodId') || null,
        unitIds: fields(formData, 'ghgUnitIds'),
        scopes: fields(formData, 'ghgScopes') as GhgScope[],
        activityKinds: fields(formData, 'ghgActivityKinds') as GhgActivityKind[],
      },
      rollout: {
        totalSites: numberField(formData, 'rolloutTotalSites', '将来の展開対象の拠点数'),
        note: field(formData, 'rolloutNote'),
      },
      freeScope: {
        pdfFiles: numberField(formData, 'freeScopePdfFiles', 'PDF 等の一次データの目安'),
      },
    };
    created = (await saveTrialProgram(db, ctx, patch)).created;
  });
  if (failure) return failure;
  done('overview', created ? 'trialPlanCreated' : 'trialPlanSaved');
}

export async function saveTrialCasesAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const requirementIds = fields(formData, 'requirementIds');
  const metricIds = fields(formData, 'metricIds');
  const failure = await runPreservingAction(formData, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await saveTrialProgram(db, ctx, {
      selectedRequirementItemIds: requirementIds,
      selectedMetricIds: metricIds,
    });
  });
  if (failure) return failure;
  done('overview', 'trialCasesSaved', {
    count: String(new Set(requirementIds).size),
    metrics: String(new Set(metricIds).size),
  });
}

export async function saveTrialDecisionAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const failure = await runPreservingAction(formData, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const agreements: NonNullable<TrialProgramPatch['agreements']> = {};
    for (const key of TRIAL_AGREEMENT_KEYS) {
      agreements[key] = {
        agreedOn: field(formData, `agreement.${key}.agreedOn`),
        note: field(formData, `agreement.${key}.note`),
      };
    }
    await saveTrialProgram(db, ctx, {
      agreements,
      endDisposition: field(formData, 'endDisposition'),
      endAgreedOn: field(formData, 'endAgreedOn'),
      disposal: { plannedOn: field(formData, 'disposalPlannedOn') || null },
      decision: field(formData, 'decision'),
      decisionConditions: field(formData, 'decisionConditions'),
      decidedByLabel: field(formData, 'decidedByLabel'),
    });
  });
  if (failure) return failure;
  done('overview', 'trialDecisionSaved');
}

// ----------------------------------------------------------------------
// シナリオ（NF-33）
// ----------------------------------------------------------------------

export async function recordScenarioRunAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  let code = '';
  const failure = await runPreservingAction(formData, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const run = await recordScenarioRun(db, ctx, {
      scenarioId: field(formData, 'scenarioId'),
      completion: field(formData, 'completion'),
      minutes: numberField(formData, 'minutes', '所要時間'),
      helpCount: numberField(formData, 'helpCount', '問い合わせ回数'),
      easeRating: numberField(formData, 'easeRating', '分かりやすさ'),
      comment: field(formData, 'comment'),
      evidenceUrl: field(formData, 'evidenceUrl'),
      supersedesRunId: field(formData, 'supersedesRunId') || null,
    });
    const scenario = await db.findById('trialScenarios', run.scenarioId);
    code = scenario?.code ?? '';
  });
  if (failure) return failure;
  done('scenarios', 'trialRunRecorded', { code });
}

/** 評価者の判定（確認ダイアログ・取り消せない）。断られたら ?error= でシナリオのタブへ戻す */
export async function judgeScenarioAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  let code = '';
  await withUserFacingError(`${BASE}?tab=scenarios`, async () => {
    const judgement = await judgeScenario(db, ctx, {
      scenarioId: field(formData, 'scenarioId'),
      judgement: field(formData, 'judgement'),
      reason: field(formData, 'reason'),
      measuredValue: field(formData, 'measuredValue'),
    });
    const scenario = await db.findById('trialScenarios', judgement.scenarioId);
    code = scenario?.code ?? '';
  });
  done('scenarios', 'trialJudged', { code });
}

// ----------------------------------------------------------------------
// フィードバック・改善管理表（NF-34）
// ----------------------------------------------------------------------

/**
 * ヘッダー・改善管理表の「ご意見・不具合」（組織の有効なメンバー本人）。どの画面からでも送れるため、
 * 画面を移らずにダイアログの中で結果を返す。画面はパターンにして記録する（検索条件・ID は捨てる）
 */
export async function submitFeedbackAction(
  previous: FeedbackFormState,
  formData: FormData,
): Promise<FeedbackFormState> {
  let title = '';
  const failure = await runPreservingAction(formData, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const item = await submitFeedback(db, ctx, {
      kind: field(formData, FEEDBACK_FIELDS.kind),
      title: field(formData, FEEDBACK_FIELDS.title),
      body: field(formData, FEEDBACK_FIELDS.body),
      severity: field(formData, FEEDBACK_FIELDS.severity),
      scenarioId: field(formData, FEEDBACK_FIELDS.scenarioId),
      route: field(formData, FEEDBACK_FIELDS.route),
    });
    title = item.title;
  });
  if (failure) {
    return {
      status: 'error',
      message: failure.message,
      values: failure.values ?? formValuesOf(formData),
      sentTitle: null,
      nonce: previous.nonce,
    };
  }
  revalidatePath(BASE);
  return {
    status: 'sent',
    message: null,
    values: null,
    sentTitle: title,
    nonce: previous.nonce + 1,
  };
}

/** 定例会・メール・電話の論点を改善管理表に記録する（enterprise.org.manage） */
export async function recordMeetingFeedbackAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const failure = await runPreservingAction(formData, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await submitFeedback(db, ctx, {
      kind: field(formData, 'kind'),
      title: field(formData, 'title'),
      body: field(formData, 'body'),
      severity: field(formData, 'severity'),
      scenarioId: field(formData, 'scenarioId'),
      channel: field(formData, 'channel'),
      mandatoryRequirement: formData.get('mandatoryRequirement') === 'on',
    });
  });
  if (failure) return failure;
  done('feedback', 'trialFeedbackRecorded');
}

export async function triageFeedbackAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const failure = await runPreservingAction(formData, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await triageFeedback(db, ctx, {
      itemId: field(formData, 'itemId'),
      status: field(formData, 'status'),
      costClass: field(formData, 'costClass'),
      responsePolicy: field(formData, 'responsePolicy'),
      ownerLabel: field(formData, 'ownerLabel'),
      dueOn: field(formData, 'dueOn'),
      mandatoryRequirement: formData.get('mandatoryRequirement') === 'on',
      severity: formData.has('severity') ? field(formData, 'severity') : undefined,
      resolvedInVersion: field(formData, 'resolvedInVersion'),
      agreed: formData.get('agreed') === 'on',
      // 別途協議の区分（費用区分が別途協議のときだけ必須。検査はサービス）
      scopeKind: formData.has('scopeKind') ? field(formData, 'scopeKind') : undefined,
    });
  });
  if (failure) return failure;
  done('feedback', 'trialFeedbackTriaged');
}

export async function recordReverificationAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const result = field(formData, 'result');
  const failure = await runPreservingAction(formData, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await recordReverification(db, ctx, {
      itemId: field(formData, 'itemId'),
      result,
      version: field(formData, 'version'),
    });
  });
  if (failure) return failure;
  done('feedback', 'trialReverified', { result });
}

// ----------------------------------------------------------------------
// 作業時間（NF-35）
// ----------------------------------------------------------------------

export async function recordTaskTimingAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const failure = await runPreservingAction(formData, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    await recordTaskTiming(db, ctx, {
      taskKey: field(formData, 'taskKey'),
      mode: field(formData, 'mode'),
      method: field(formData, 'method'),
      minutes: numberField(formData, 'minutes', '所要時間'),
      quantity: numberField(formData, 'quantity', '数量'),
      unitLabel: field(formData, 'unitLabel'),
      department: field(formData, 'department'),
      measuredOn: field(formData, 'measuredOn'),
      note: field(formData, 'note'),
      supersedesId: field(formData, 'supersedesId') || null,
    });
  });
  if (failure) return failure;
  done('timing', 'trialTimingRecorded');
}
