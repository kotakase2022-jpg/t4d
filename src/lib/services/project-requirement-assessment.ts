import 'server-only';

import { randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import { NotFoundError, assertCan, assertEnterpriseWorkspace } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { DEMO_TEXT_LIMITS } from '@/lib/repositories/demo-trial-checks';
import type { DbClient } from '@/lib/repositories/types';
import {
  getProject,
  type ProjectDetail,
  type ProjectFrameworkView,
} from '@/lib/services/disclosure-project';
import { loadExclusionStatus, type ExclusionStatus } from '@/lib/services/requirement-exclusion';
import {
  loadRequirementMatrix,
  type RequirementMatrixFramework,
  type RequirementMatrixRow,
} from '@/lib/services/requirement-matrix';
import { isUuid } from '@/lib/validation/uuid';
import {
  REQUIREMENT_APPLICABILITIES,
  SSBJ_COVERAGE_STATUSES,
  type AuthorizationContext,
  type DisclosureItem,
  type IsoDate,
  type ProjectRequirementAssessment,
  type ProjectRequirementAssessmentEvent,
  type RequirementApplicability,
  type SsbjCoverageStatus,
  type Uuid,
} from '@/types/domain';

/**
 * 開示プロジェクトの要求事項の判断と 3 観点の評価の保存（トライアル対応 NF-01 の画面・保存。T1）。
 *
 * SSBJ（ssbj_assessments）と CSRD（ダブル・マテリアリティ評価から導出）以外の基準（ESRS-40a など）の判断を
 * project_requirement_assessments に持つ。読み分けは requirement-decisions.ts（Stage A）が行う。
 *
 *  - **表示では行を作らない**。保存の操作でだけ作る（ssbj_assessments の一括作成の問題を持ち込まない）
 *  - 保存のたびに追記専用の履歴（project_requirement_assessment_events）に前後の値（要約）を足す
 *  - 対象外・非重要は理由が必須。理由・区分を変えると、それまでの対象外の承認は無効になる（理由のダイジェスト）
 *  - 権限: enterprise.disclosure.write。ID の検索より先に確かめ、他の組織は「見つかりません」
 *  - Demo Mode の本文は 400 字まで（Cookie の容量。plan 付録 B。Supabase Mode は 2,000 字）
 */

export const COVERAGE_ASPECTS = ['disclosure', 'data', 'process'] as const;
export type CoverageAspect = (typeof COVERAGE_ASPECTS)[number];

export const COVERAGE_ASPECT_LABELS: Readonly<Record<CoverageAspect, string>> = {
  disclosure: '開示',
  data: 'データ',
  process: '業務プロセス',
};

export const APPLICABILITY_LABELS: Readonly<Record<RequirementApplicability, string>> = {
  applicable: '適用',
  not_applicable: '対象外',
  not_material: '非重要',
  not_assessed: '未判定',
};

/** 判断の本文の上限 */
export function assessmentTextLimit(ctx: AuthorizationContext): number {
  return ctx.demo ? DEMO_TEXT_LIMITS.note : 2000;
}

/** 判断を記録できる基準か（SSBJ・CSRD は別の画面で判断する） */
export type DecisionHome = 'ssbj' | 'csrd' | 'project';

export function decisionHomeOf(view: Pick<ProjectFrameworkView, 'frameworkKey'>): DecisionHome {
  if (view.frameworkKey === 'ssbj') return 'ssbj';
  if (view.frameworkKey === 'csrd') return 'csrd';
  return 'project';
}

export interface SaveProjectRequirementAssessmentInput {
  projectFrameworkId: Uuid;
  itemId: Uuid;
  applicability: string;
  applicabilityReason: string;
  ruleRef: string;
  disclosureCoverage: string | null;
  dataCoverage: string | null;
  processCoverage: string | null;
  missingInformation: string;
  ownerUserId: Uuid | null;
  dueOn: string | null;
  actionNote: string;
  /** 履歴に残す変更の理由（任意） */
  changeReason?: string;
}

export interface SaveProjectRequirementAssessmentResult {
  assessment: ProjectRequirementAssessment;
  /** 変更が無ければ false（行も履歴も書かない） */
  changed: boolean;
  /** 対象外・非重要の区分・理由が変わった（承認済み・申請中なら申請し直しになる） */
  exclusionChanged: boolean;
}

function coverageOf(value: string | null, label: string): SsbjCoverageStatus | null {
  if (value === null || value === '') return null;
  if (!(SSBJ_COVERAGE_STATUSES as readonly string[]).includes(value)) {
    throw new ValidationError(`${label}の評価の値が正しくありません。`);
  }
  return value as SsbjCoverageStatus;
}

/** 履歴に残す要約（Cookie の容量を抑えるため、メモ類は入れない） */
function summaryOf(a: ProjectRequirementAssessment): Record<string, unknown> {
  return {
    applicability: a.applicability,
    applicabilityReason: a.applicabilityReason,
    disclosureCoverage: a.disclosureCoverage,
    dataCoverage: a.dataCoverage,
    processCoverage: a.processCoverage,
    ownerUserId: a.ownerUserId,
    dueOn: a.dueOn,
  };
}

const COMPARED_KEYS = [
  'applicability',
  'applicabilityReason',
  'ruleRef',
  'disclosureCoverage',
  'dataCoverage',
  'processCoverage',
  'missingInformation',
  'ownerUserId',
  'dueOn',
  'actionNote',
] as const satisfies ReadonlyArray<keyof ProjectRequirementAssessment>;

export async function saveProjectRequirementAssessment(
  db: DbClient,
  ctx: AuthorizationContext,
  input: SaveProjectRequirementAssessmentInput,
): Promise<SaveProjectRequirementAssessmentResult> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.write');
  const organizationId = ctx.workspace.organizationId;

  const pf = isUuid(input.projectFrameworkId)
    ? await db.findById('projectFrameworks', input.projectFrameworkId)
    : null;
  if (!pf || pf.organizationId !== organizationId) {
    throw new NotFoundError('プロジェクトの基準が見つかりません。');
  }
  const project = await db.findById('disclosureProjects', pf.projectId);
  if (!project || project.deletedAt || project.organizationId !== organizationId) {
    throw new NotFoundError('開示プロジェクトが見つかりません。');
  }
  const item = isUuid(input.itemId) ? await db.findById('disclosureItems', input.itemId) : null;
  if (!item || item.frameworkVersionId !== pf.frameworkVersionId) {
    throw new NotFoundError('要求事項が見つかりません。');
  }
  const version = await db.findById('frameworkVersions', pf.frameworkVersionId);
  const framework = version ? await db.findById('frameworks', version.frameworkId) : null;
  if (framework?.key === 'ssbj') {
    throw new ValidationError('SSBJ の要求事項の判断は、SSBJ の要求事項の詳細で記録します。');
  }
  if (framework?.key === 'csrd') {
    throw new ValidationError(
      'CSRD の要求事項の判断は、ダブル・マテリアリティ評価（CSRD の設定）で行います。',
    );
  }

  if (!(REQUIREMENT_APPLICABILITIES as readonly string[]).includes(input.applicability)) {
    throw new ValidationError('適用区分を選んでください。');
  }
  const applicability = input.applicability as RequirementApplicability;
  const limit = assessmentTextLimit(ctx);
  const text = (value: string | undefined, label: string) => {
    const trimmed = (value ?? '').trim();
    if (trimmed.length > limit) {
      throw new ValidationError(`${label}は ${limit} 字以内で入力してください。`);
    }
    return trimmed;
  };
  const applicabilityReason = text(input.applicabilityReason, '理由');
  if (
    (applicability === 'not_applicable' || applicability === 'not_material') &&
    applicabilityReason === ''
  ) {
    throw new ValidationError(
      `${APPLICABILITY_LABELS[applicability]}とする理由を入力してください（理由の無い除外は記録できません）。`,
    );
  }
  const ruleRef = text(input.ruleRef, '参照した規則');
  const missingInformation = text(input.missingInformation, '不足情報');
  const actionNote = text(input.actionNote, '対応メモ');
  const changeReason = text(input.changeReason, '変更の理由');
  const disclosureCoverage = coverageOf(input.disclosureCoverage, '開示');
  const dataCoverage = coverageOf(input.dataCoverage, 'データ');
  const processCoverage = coverageOf(input.processCoverage, '業務プロセス');

  let ownerUserId: Uuid | null = null;
  if (input.ownerUserId) {
    const [membership] = await db.select('memberships', {
      where: { organizationId, userId: input.ownerUserId, status: 'active' },
    });
    if (!membership) throw new ValidationError('担当者は組織のメンバーから選んでください。');
    ownerUserId = input.ownerUserId;
  }
  const dueOn = input.dueOn && input.dueOn.trim() !== '' ? input.dueOn.trim() : null;
  if (dueOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) {
    throw new ValidationError('期限は日付（YYYY-MM-DD）で入力してください。');
  }

  const [existing] = await db.select('projectRequirementAssessments', {
    where: { organizationId, projectFrameworkId: pf.id, itemId: item.id },
  });
  const now = new Date().toISOString();
  const values = {
    applicability,
    applicabilityReason,
    ruleRef,
    disclosureCoverage,
    dataCoverage,
    processCoverage,
    missingInformation,
    ownerUserId,
    dueOn: dueOn as IsoDate | null,
    actionNote,
  };

  if (existing && COMPARED_KEYS.every((key) => existing[key] === values[key])) {
    return { assessment: existing, changed: false, exclusionChanged: false };
  }
  // 適用区分・理由が変わったら、判断した人と日時を記録し直す（名義は本人だけ）
  const decisionChanged =
    !existing ||
    existing.applicability !== applicability ||
    existing.applicabilityReason !== applicabilityReason;
  const decided =
    applicability === 'not_assessed'
      ? { decidedBy: null, decidedAt: null }
      : decisionChanged
        ? { decidedBy: ctx.userId, decidedAt: now }
        : { decidedBy: existing!.decidedBy, decidedAt: existing!.decidedAt };
  const exclusionChanged =
    decisionChanged &&
    (existing?.applicability === 'not_applicable' ||
      existing?.applicability === 'not_material' ||
      applicability === 'not_applicable' ||
      applicability === 'not_material');

  let assessment: ProjectRequirementAssessment;
  if (existing) {
    assessment = await db.update('projectRequirementAssessments', existing.id, {
      ...values,
      ...decided,
      updatedAt: now,
      updatedBy: ctx.userId,
    });
  } else {
    const row: ProjectRequirementAssessment = {
      id: randomUUID(),
      organizationId,
      projectFrameworkId: pf.id,
      itemId: item.id,
      ...values,
      ...decided,
      reviewedBy: null,
      reviewedAt: null,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    };
    const [inserted] = await db.insert('projectRequirementAssessments', [row]);
    assessment = inserted ?? row;
  }

  const event: ProjectRequirementAssessmentEvent = {
    id: randomUUID(),
    organizationId,
    assessmentId: assessment.id,
    projectFrameworkId: pf.id,
    itemId: item.id,
    before: existing ? summaryOf(existing) : null,
    after: summaryOf(assessment),
    reason: changeReason,
    actorUserId: ctx.userId,
    createdAt: now,
  };
  await db.insert('projectRequirementAssessmentEvents', [event]);
  await recordAuditEvent(db, ctx, {
    eventType: 'requirement_assessed',
    resourceType: 'project_requirement_assessment',
    resourceId: assessment.id,
    beforeSummary: existing
      ? `${item.code}: ${APPLICABILITY_LABELS[existing.applicability]}`
      : undefined,
    afterSummary: `${item.code}: ${APPLICABILITY_LABELS[applicability]}${
      applicabilityReason ? `（${applicabilityReason.slice(0, 60)}）` : ''
    }`,
    metadata: { projectId: project.id, projectFrameworkId: pf.id, itemId: item.id },
  });
  return { assessment, changed: true, exclusionChanged };
}

// ======================================================================
// 要求事項の詳細（プロジェクト）の読み込み
// ======================================================================

export interface ProjectRequirementDetail {
  detail: ProjectDetail;
  framework: ProjectFrameworkView;
  matrixFramework: RequirementMatrixFramework | null;
  item: DisclosureItem;
  /** 対応表と同じ行（区分・不足・担当期限・節・数値・根拠・横断対応） */
  row: RequirementMatrixRow;
  home: DecisionHome;
  /** プロジェクトの判断（SSBJ・CSRD 以外の基準。記録が無ければ null） */
  assessment: ProjectRequirementAssessment | null;
  /** 判断の履歴（新しい順） */
  assessmentEvents: ProjectRequirementAssessmentEvent[];
  /** 対象外・非重要の申請と承認（CSRD は DMA の確定を承認として扱うため null） */
  exclusion: ExclusionStatus | null;
}

/** 要求事項の詳細（プロジェクト）。読むだけ（行を作らない） */
export async function loadProjectRequirementDetail(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { projectId: Uuid; itemId: Uuid },
): Promise<ProjectRequirementDetail> {
  const detail = await getProject(db, ctx, input.projectId);
  const item = isUuid(input.itemId) ? await db.findById('disclosureItems', input.itemId) : null;
  const framework = item
    ? detail.frameworks.find((f) => f.version.id === item.frameworkVersionId)
    : undefined;
  if (!item || !framework) throw new NotFoundError('要求事項が見つかりません。');

  const matrix = await loadRequirementMatrix(db, ctx, {
    projectId: detail.project.id,
    frameworkVersionIds: [framework.version.id],
  });
  const row = matrix.rows.find((r) => r.itemId === item.id);
  if (!row) throw new NotFoundError('要求事項が見つかりません。');
  const home = decisionHomeOf(framework);
  const organizationId = detail.project.organizationId;

  let assessment: ProjectRequirementAssessment | null = null;
  let assessmentEvents: ProjectRequirementAssessmentEvent[] = [];
  if (home === 'project') {
    const [found] = await db.select('projectRequirementAssessments', {
      where: { organizationId, projectFrameworkId: framework.projectFramework.id, itemId: item.id },
    });
    assessment = found ?? null;
    assessmentEvents = assessment
      ? (
          await db.select('projectRequirementAssessmentEvents', {
            where: { organizationId, assessmentId: assessment.id },
          })
        ).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      : [];
  }

  let exclusion: ExclusionStatus | null = null;
  if (home === 'project') {
    exclusion = await loadExclusionStatus(db, ctx, {
      source: 'project_assessment',
      itemId: item.id,
      projectFrameworkId: framework.projectFramework.id,
    });
  } else if (home === 'ssbj') {
    exclusion = await loadExclusionStatus(db, ctx, {
      source: 'ssbj_assessment',
      itemId: item.id,
      reportingPeriodId: detail.project.reportingPeriodId,
    }).catch((error: unknown) => {
      // SSBJ の評価の行がまだ無い（SSBJ の画面で一度も開いていない）ときは、申請の対象が無い
      if (error instanceof NotFoundError) return null;
      throw error;
    });
  }

  return {
    detail,
    framework,
    matrixFramework: matrix.frameworks[0] ?? null,
    item,
    row,
    home,
    assessment,
    assessmentEvents,
    exclusion,
  };
}
