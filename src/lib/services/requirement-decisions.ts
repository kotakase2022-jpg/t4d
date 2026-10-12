import 'server-only';

import { deriveCsrdApplicability, csrdSectionOfItem } from '@/lib/domain/csrd';
import { exclusionReasonDigest } from '@/lib/domain/exclusion-digest';
import {
  exclusionStateOf,
  type ExclusionStateResult,
  type RequirementHumanCoverage,
} from '@/lib/domain/requirement-coverage';
import { COVERAGE_LABEL } from '@/lib/domain/ssbj';
import type { MemberEntry } from '@/lib/services/identity';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  CsrdAssessment,
  DisclosureItem,
  DisclosureProject,
  ExclusionDecision,
  FrameworkKey,
  IsoDate,
  IsoDateTime,
  ProjectFramework,
  ProjectRequirementAssessment,
  RequirementExclusionEvent,
  SsbjAssessment,
  SsbjCoverageStatus,
  Uuid,
} from '@/types/domain';

/**
 * 要求事項の判断を基準ごとに読み分ける（トライアル対応 NF-01 の中核。書き込みはしない）。
 *
 * これまで開示プロジェクトの要求事項タブは、どの基準でも SSBJ の評価（ssbj_assessments）を読んでいた。
 * CSRD をプロジェクトに足すと全件「未判定」になり（不具合 B-5）、ESRS-40a は判断を持てなかった。
 *  - SSBJ … ssbj_assessments（今のまま）
 *  - CSRD … ダブル・マテリアリティ（DMA）の人の判断から導く（csrd_analysis_settings・csrd_dma_matters）と
 *           csrd_assessments の 3 観点
 *  - それ以外（ESRS-40a など）… project_requirement_assessments（保存の操作でだけ作る。表示では作らない）
 *
 * 対象外・非重要は、理由があり、別の人の承認（requirement_exclusion_events。理由のダイジェストに結び付く）が
 * あるときだけ「対象外」として分母から外す（NF-02・NF-03）。承認待ち・未申請・差戻し・理由を変えた後は
 * 未判定のまま分母に残す。CSRD の非重要は DMA の確定記録（確定者）を承認の記録として扱う（判断事項 D9 の既定）。
 */

// ======================================================================
// 型（disclosure-project.ts が再公開する）
// ======================================================================

/** 要求事項の適用判断（内容評価・原稿状態とは別の属性） */
export type RequirementDecisionKind =
  'material' | 'not_applicable' | 'not_material' | 'not_assessed';

export const REQUIREMENT_DECISION_SOURCES = [
  'ssbj_assessment',
  'csrd_dma',
  'project_assessment',
  'none',
] as const;
/** 判断の出所（要求事項タブの「適用判断」列に小さく併記する） */
export type RequirementDecisionSource = (typeof REQUIREMENT_DECISION_SOURCES)[number];

export const REQUIREMENT_DECISION_SOURCE_LABELS: Readonly<
  Record<RequirementDecisionSource, string>
> = {
  ssbj_assessment: 'SSBJ の評価',
  csrd_dma: 'ダブル・マテリアリティ評価',
  project_assessment: '判断の記録',
  none: '判断なし',
};

export interface RequirementDecision {
  kind: RequirementDecisionKind;
  label: string;
  reason: string | null;
  decidedBy: Uuid | null;
  decidedByName: string | null;
  /** 対象外・非重要のように、分母から外す確定判断か（理由と別の人の承認があるときだけ） */
  excluded: boolean;
  note: string | null;
  /** 判断の出所 */
  source: RequirementDecisionSource;
  /**
   * 対象外・非重要の判断（理由あり）の承認の状態。対象外・非重要でなければ null。
   * 承認済みのときだけ excluded が true になる
   */
  exclusion: ExclusionStateResult | null;
  /**
   * 理由の付いた対象外・非重要の判断の区分（承認待ち・差戻しで kind が「未判定」になっても区分が分かる）。
   * 対象外・非重要でなければ null
   */
  exclusionDecision: ExclusionDecision | null;
  /** 対象外・非重要の承認者（CSRD は DMA の確定者） */
  approvedBy: Uuid | null;
  approvedByName: string | null;
  approvedAt: IsoDateTime | null;
}

export interface ContentEvaluation {
  /** human = 担当者の確認済み判定／ai_candidate = AI の候補（未確認）／none = 評価なし */
  source: 'human' | 'ai_candidate' | 'none';
  status: SsbjCoverageStatus | null;
  label: string;
}

/** 担当・期限の出所の候補（対応計画） */
export interface RequirementPlanRef {
  title: string;
  assigneeUserId: Uuid | null;
  department: string;
  dueDate: IsoDate | null;
  done: boolean;
}

/** 1 つの要求事項の判断と、区分・担当期限の算定に要る材料 */
export interface RequirementDecisionDetail {
  itemId: Uuid;
  decision: RequirementDecision;
  contentEvaluation: ContentEvaluation;
  /** 人の 3 観点の評価（未評価は null） */
  human: RequirementHumanCoverage | null;
  /** 評価が AI の候補だけ */
  aiOnly: boolean;
  /** 評価の担当（部署・担当者）と期限（プロジェクトの判断の期限） */
  assessmentOwner: {
    ownerUserId: Uuid | null;
    ownerDepartment: string;
    dueDate: IsoDate | null;
  } | null;
  plans: RequirementPlanRef[];
  /** 不足情報（人の記録・AI の候補） */
  missingInformation: string[];
  /** プロジェクトの判断の行（SSBJ・CSRD 以外の基準） */
  projectAssessment: ProjectRequirementAssessment | null;
}

// ======================================================================
// 小道具
// ======================================================================

function nameOf(members: readonly MemberEntry[], userId: Uuid | null): string | null {
  if (!userId) return null;
  return members.find((m) => m.userId === userId)?.displayName ?? null;
}

function clean(value: string | null | undefined): string {
  return (value ?? '').trim();
}

const NOT_ASSESSED_BASE = {
  kind: 'not_assessed' as const,
  label: '未判定',
  reason: null,
  decidedBy: null,
  decidedByName: null,
  excluded: false,
  exclusion: null,
  exclusionDecision: null,
  approvedBy: null,
  approvedByName: null,
  approvedAt: null,
};

const EXCLUSION_LABEL: Readonly<Record<ExclusionDecision, string>> = {
  not_applicable: '対象外',
  not_material: '非重要',
};

/** 対象外・非重要（理由あり）の判断を、承認の状態に合わせて決める */
function exclusionDecision(input: {
  decisionKind: ExclusionDecision;
  reason: string;
  decidedBy: Uuid | null;
  events: readonly RequirementExclusionEvent[];
  members: readonly MemberEntry[];
  source: RequirementDecisionSource;
}): RequirementDecision {
  const label = EXCLUSION_LABEL[input.decisionKind];
  const exclusion = exclusionStateOf(input.events, {
    decision: input.decisionKind,
    reasonDigest: exclusionReasonDigest(input.decisionKind, input.reason),
  });
  const base = {
    reason: input.reason,
    decidedBy: input.decidedBy,
    decidedByName: nameOf(input.members, input.decidedBy),
    source: input.source,
    exclusion,
    exclusionDecision: input.decisionKind,
  };
  if (exclusion.state === 'approved') {
    return {
      ...base,
      kind: input.decisionKind,
      label: `${label}と判断`,
      excluded: true,
      note: null,
      approvedBy: exclusion.decidedBy,
      approvedByName: nameOf(input.members, exclusion.decidedBy),
      approvedAt: exclusion.decidedAt,
    };
  }
  const pending: Record<Exclude<typeof exclusion.state, 'approved'>, [string, string]> = {
    not_requested: [
      `${label}（未申請）`,
      `${label}として申請し、別の人が承認すると分母から外れます（それまでは未判定として数えます）。`,
    ],
    requested: [
      `${label}（承認待ち）`,
      '別の人の承認を待っています（承認されるまで分母から外しません）。',
    ],
    returned: [
      `${label}（差戻し）`,
      `${label}の申請が差し戻されました${exclusion.returnNote ? `（${exclusion.returnNote}）` : ''}。`,
    ],
    reapproval_required: [
      `${label}（再承認が必要）`,
      '承認の後に区分・理由が変わったため、承認し直しが必要です。',
    ],
  };
  const [pendingLabel, note] = pending[exclusion.state];
  return {
    ...base,
    kind: 'not_assessed',
    label: pendingLabel,
    excluded: false,
    note,
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
  };
}

function contentEvaluationOf(
  final: { status: SsbjCoverageStatus | null; reviewed: boolean },
  ai: SsbjCoverageStatus | null,
): ContentEvaluation {
  if (final.status && final.reviewed) {
    return { source: 'human', status: final.status, label: COVERAGE_LABEL[final.status] };
  }
  if (ai) return { source: 'ai_candidate', status: ai, label: `候補: ${COVERAGE_LABEL[ai]}` };
  return { source: 'none', status: null, label: '評価なし' };
}

function eventsByItem(
  events: readonly RequirementExclusionEvent[],
): Map<Uuid, RequirementExclusionEvent[]> {
  const out = new Map<Uuid, RequirementExclusionEvent[]>();
  for (const e of events) {
    const list = out.get(e.itemId) ?? [];
    list.push(e);
    out.set(e.itemId, list);
  }
  return out;
}

// ======================================================================
// 基準ごとの読み分け
// ======================================================================

/**
 * SSBJ の評価で適用区分・重要性とその理由を記録した人（対象外・非重要の承認者になれない人。0059 の
 * reason_recorded_by。以前の行は最後に更新した人で代える）
 */
export function ssbjReasonRecorderOf(
  assessment: Pick<SsbjAssessment, 'reasonRecordedBy' | 'updatedBy' | 'createdBy'>,
): Uuid | null {
  return assessment.reasonRecordedBy ?? assessment.updatedBy ?? assessment.createdBy ?? null;
}

/** SSBJ の評価行（ssbj_assessments）から判断を読む（既存の規則に、対象外の承認を足したもの） */
export function ssbjDecisionOf(
  assessment: SsbjAssessment | undefined,
  events: readonly RequirementExclusionEvent[],
  members: readonly MemberEntry[],
): RequirementDecision {
  if (!assessment) {
    return { ...NOT_ASSESSED_BASE, source: 'none', note: '評価の行がありません。' };
  }
  const decider = ssbjReasonRecorderOf(assessment);
  if (assessment.applicability === 'not_applicable') {
    const reason = clean(assessment.applicabilityReason);
    if (!reason) {
      return {
        ...NOT_ASSESSED_BASE,
        source: 'ssbj_assessment',
        note: '対象外の理由が記録されていないため、判断済みとして扱いません。',
      };
    }
    return exclusionDecision({
      decisionKind: 'not_applicable',
      reason: assessment.applicabilityReason,
      decidedBy: decider,
      events,
      members,
      source: 'ssbj_assessment',
    });
  }
  if (assessment.materiality === 'not_material') {
    const reason = clean(assessment.materialityReason);
    if (!reason) {
      return {
        ...NOT_ASSESSED_BASE,
        source: 'ssbj_assessment',
        note: '非重要の理由が記録されていないため、判断済みとして扱いません。',
      };
    }
    return exclusionDecision({
      decisionKind: 'not_material',
      reason: assessment.materialityReason,
      decidedBy: decider,
      events,
      members,
      source: 'ssbj_assessment',
    });
  }
  if (assessment.materiality === 'material') {
    return {
      kind: 'material',
      label: '適用（重要）',
      reason: clean(assessment.materialityReason) || null,
      decidedBy: decider,
      decidedByName: nameOf(members, decider),
      excluded: false,
      note: null,
      source: 'ssbj_assessment',
      exclusion: null,
      exclusionDecision: null,
      approvedBy: null,
      approvedByName: null,
      approvedAt: null,
    };
  }
  return {
    ...NOT_ASSESSED_BASE,
    source: 'ssbj_assessment',
    note: '重要性が未判定です（対象の既定値は判断として扱いません）。',
  };
}

/** プロジェクトの判断の行（ESRS-40a など）から判断を読む */
export function projectDecisionOf(
  assessment: ProjectRequirementAssessment | undefined,
  events: readonly RequirementExclusionEvent[],
  members: readonly MemberEntry[],
): RequirementDecision {
  if (!assessment || assessment.applicability === 'not_assessed') {
    return {
      ...NOT_ASSESSED_BASE,
      source: assessment ? 'project_assessment' : 'none',
      note: assessment ? '適用の判断がまだ記録されていません。' : '判断の記録がありません。',
    };
  }
  const decider = assessment.decidedBy ?? assessment.updatedBy ?? assessment.createdBy;
  if (
    assessment.applicability === 'not_applicable' ||
    assessment.applicability === 'not_material'
  ) {
    if (!clean(assessment.applicabilityReason)) {
      return {
        ...NOT_ASSESSED_BASE,
        source: 'project_assessment',
        note: '理由が記録されていないため、判断済みとして扱いません。',
      };
    }
    return exclusionDecision({
      decisionKind: assessment.applicability,
      reason: assessment.applicabilityReason,
      decidedBy: decider,
      events,
      members,
      source: 'project_assessment',
    });
  }
  return {
    kind: 'material',
    label: '適用',
    reason: clean(assessment.applicabilityReason) || null,
    decidedBy: decider,
    decidedByName: nameOf(members, decider),
    excluded: false,
    note: null,
    source: 'project_assessment',
    exclusion: null,
    exclusionDecision: null,
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
  };
}

export interface RequirementDecisionsInput {
  project: DisclosureProject;
  projectFramework: ProjectFramework;
  frameworkKey: FrameworkKey;
  items: readonly DisclosureItem[];
  members: readonly MemberEntry[];
}

/**
 * 基準ごとに要求事項の判断を読む（書き込みはしない）。呼び出し側はプロジェクトの閲覧権限を確かめ済みで、
 * 項目はプロジェクトの基準の版のものを渡す
 */
export async function requirementDecisionsFor(
  db: DbClient,
  _ctx: AuthorizationContext,
  input: RequirementDecisionsInput,
): Promise<Map<Uuid, RequirementDecisionDetail>> {
  const { project, projectFramework, frameworkKey, items, members } = input;
  const organizationId = project.organizationId;
  const itemIds = items.map((i) => i.id);
  const out = new Map<Uuid, RequirementDecisionDetail>();
  if (itemIds.length === 0) return out;

  const exclusionEvents = await db.select('requirementExclusionEvents', {
    where: {
      organizationId,
      reportingPeriodId: project.reportingPeriodId,
      frameworkVersionId: projectFramework.frameworkVersionId,
    },
  });

  if (frameworkKey === 'ssbj') {
    const [assessments, plans] = await Promise.all([
      db.select('ssbjAssessments', {
        where: {
          organizationId,
          reportingPeriodId: project.reportingPeriodId,
          itemId: { in: itemIds },
        },
      }),
      db.select('ssbjActionPlans', {
        where: { organizationId, reportingPeriodId: project.reportingPeriodId },
      }),
    ]);
    const byItem = new Map(assessments.map((a) => [a.itemId, a]));
    const events = eventsByItem(exclusionEvents.filter((e) => e.source === 'ssbj_assessment'));
    for (const item of items) {
      const assessment = byItem.get(item.id);
      const reviewed = assessment?.reviewedAt != null && assessment.finalStatus !== null;
      out.set(item.id, {
        itemId: item.id,
        decision: ssbjDecisionOf(assessment, events.get(item.id) ?? [], members),
        contentEvaluation: contentEvaluationOf(
          { status: assessment?.finalStatus ?? null, reviewed },
          assessment?.aiStatus ?? null,
        ),
        human:
          assessment && reviewed
            ? {
                disclosure: assessment.disclosureStatus,
                data: assessment.dataStatus,
                process: assessment.processStatus,
              }
            : null,
        aiOnly: !reviewed && assessment?.aiStatus != null,
        assessmentOwner: assessment
          ? {
              ownerUserId: assessment.ownerUserId,
              ownerDepartment: assessment.ownerDepartment,
              dueDate: null,
            }
          : null,
        plans: assessment
          ? plans
              .filter((p) => p.assessmentId === assessment.id)
              .map((p) => ({
                title: p.title,
                assigneeUserId: p.assigneeUserId,
                department: p.department,
                dueDate: p.dueDate,
                done: p.status === 'done',
              }))
          : [],
        missingInformation: assessment && !reviewed ? assessment.aiMissingInfo : [],
        projectAssessment: null,
      });
    }
    return out;
  }

  if (frameworkKey === 'csrd') {
    const [settingsRows, matters, assessments, plans] = await Promise.all([
      db.select('csrdAnalysisSettings', {
        where: { organizationId, reportingPeriodId: project.reportingPeriodId },
      }),
      db.select('csrdDmaMatters', {
        where: { organizationId, reportingPeriodId: project.reportingPeriodId },
      }),
      db.select('csrdAssessments', {
        where: { organizationId, reportingPeriodId: project.reportingPeriodId },
      }),
      db.select('csrdActionPlans', {
        where: { organizationId, reportingPeriodId: project.reportingPeriodId },
      }),
    ]);
    const settings = settingsRows[0] ?? null;
    const dmaConfirmed = settings?.dmaConfirmedAt != null;
    const assessmentByItem = new Map<Uuid, CsrdAssessment>(assessments.map((a) => [a.itemId, a]));
    for (const item of items) {
      const section = csrdSectionOfItem(item);
      const matter = section ? (matters.find((m) => m.esrsTopic === section) ?? null) : null;
      const applicability = deriveCsrdApplicability(section, matter, dmaConfirmed);
      const assessment = assessmentByItem.get(item.id);
      const reviewed = assessment?.reviewedAt != null && assessment.finalStatus !== null;
      let decision: RequirementDecision;
      if (applicability.kind === 'always' || applicability.kind === 'material') {
        decision = {
          kind: 'material',
          label: applicability.kind === 'always' ? '適用（常に適用）' : '適用（重要）',
          reason: applicability.reason,
          decidedBy: matter?.decidedBy ?? null,
          decidedByName: nameOf(members, matter?.decidedBy ?? null),
          excluded: false,
          note: applicability.provisional ? 'ダブル・マテリアリティ評価は未確定です。' : null,
          source: 'csrd_dma',
          exclusion: null,
          exclusionDecision: null,
          approvedBy: null,
          approvedByName: null,
          approvedAt: null,
        };
      } else if (applicability.kind === 'not_material') {
        // DMA の確定（確定者の記録）を、非重要の承認の記録として扱う（判断事項 D9 の既定）
        decision = dmaConfirmed
          ? {
              kind: 'not_material',
              label: '非重要と判断',
              reason: applicability.reason,
              decidedBy: matter?.decidedBy ?? null,
              decidedByName: nameOf(members, matter?.decidedBy ?? null),
              excluded: true,
              note: 'ダブル・マテリアリティ評価の確定を承認の記録として扱います。',
              source: 'csrd_dma',
              exclusion: {
                state: 'approved',
                requestedBy: matter?.decidedBy ?? null,
                requestedAt: matter?.decidedAt ?? null,
                decidedBy: settings?.dmaConfirmedBy ?? null,
                decidedAt: settings?.dmaConfirmedAt ?? null,
                returnNote: null,
              },
              exclusionDecision: 'not_material',
              approvedBy: settings?.dmaConfirmedBy ?? null,
              approvedByName: nameOf(members, settings?.dmaConfirmedBy ?? null),
              approvedAt: settings?.dmaConfirmedAt ?? null,
            }
          : {
              ...NOT_ASSESSED_BASE,
              exclusionDecision: 'not_material',
              label: '非重要（DMA 未確定）',
              reason: applicability.reason,
              decidedBy: matter?.decidedBy ?? null,
              decidedByName: nameOf(members, matter?.decidedBy ?? null),
              source: 'csrd_dma',
              note: 'ダブル・マテリアリティ評価が確定するまで分母から外しません。',
            };
      } else {
        decision = {
          ...NOT_ASSESSED_BASE,
          source: 'csrd_dma',
          note: applicability.reason,
        };
      }
      out.set(item.id, {
        itemId: item.id,
        decision,
        contentEvaluation: contentEvaluationOf(
          { status: assessment?.finalStatus ?? null, reviewed },
          assessment?.aiStatus ?? null,
        ),
        human:
          assessment && reviewed
            ? {
                disclosure: assessment.disclosureStatus,
                data: assessment.dataStatus,
                process: assessment.processStatus,
              }
            : null,
        aiOnly: !reviewed && assessment?.aiStatus != null,
        assessmentOwner: assessment
          ? {
              ownerUserId: assessment.ownerUserId,
              ownerDepartment: assessment.ownerDepartment,
              dueDate: null,
            }
          : null,
        plans: assessment
          ? plans
              .filter((p) => p.assessmentId === assessment.id)
              .map((p) => ({
                title: p.title,
                assigneeUserId: p.assigneeUserId,
                department: p.department,
                dueDate: p.dueDate,
                done: p.status === 'done',
              }))
          : [],
        missingInformation: assessment && !reviewed ? assessment.aiMissingInfo : [],
        projectAssessment: null,
      });
    }
    return out;
  }

  // それ以外の基準（ESRS-40a など）: プロジェクトの判断の行
  const projectAssessments = await db.select('projectRequirementAssessments', {
    where: { organizationId, projectFrameworkId: projectFramework.id },
  });
  const byItem = new Map(projectAssessments.map((a) => [a.itemId, a]));
  const events = eventsByItem(
    exclusionEvents.filter(
      (e) => e.source === 'project_assessment' && e.projectFrameworkId === projectFramework.id,
    ),
  );
  for (const item of items) {
    const assessment = byItem.get(item.id);
    const human =
      assessment &&
      (assessment.disclosureCoverage !== null ||
        assessment.dataCoverage !== null ||
        assessment.processCoverage !== null)
        ? {
            disclosure: assessment.disclosureCoverage,
            data: assessment.dataCoverage,
            process: assessment.processCoverage,
          }
        : null;
    const worst = [human?.disclosure, human?.data, human?.process].filter(
      (s): s is SsbjCoverageStatus => s != null,
    );
    out.set(item.id, {
      itemId: item.id,
      decision: projectDecisionOf(assessment, events.get(item.id) ?? [], members),
      contentEvaluation:
        human && worst.length === 3
          ? contentEvaluationOf(
              {
                status: worst.includes('not_covered')
                  ? 'not_covered'
                  : worst.includes('unconfirmed')
                    ? 'unconfirmed'
                    : worst.includes('partial')
                      ? 'partial'
                      : worst.includes('mostly_covered')
                        ? 'mostly_covered'
                        : 'covered',
                reviewed: true,
              },
              null,
            )
          : contentEvaluationOf({ status: null, reviewed: false }, null),
      human,
      aiOnly: false,
      assessmentOwner: assessment
        ? { ownerUserId: assessment.ownerUserId, ownerDepartment: '', dueDate: assessment.dueOn }
        : null,
      plans: [],
      missingInformation: assessment?.missingInformation ? [assessment.missingInformation] : [],
      projectAssessment: assessment ?? null,
    });
  }
  return out;
}
