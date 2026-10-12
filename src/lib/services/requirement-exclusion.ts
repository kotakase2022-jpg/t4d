import 'server-only';

import { randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import { NotFoundError, assertCan, assertEnterpriseWorkspace, can } from '@/lib/authorization/can';
import { exclusionReasonDigest } from '@/lib/domain/exclusion-digest';
import {
  exclusionReasonExcerpt,
  exclusionStateOf,
  type ExclusionStateResult,
} from '@/lib/domain/requirement-coverage';
import { ValidationError } from '@/lib/errors/user-facing';
import { DEMO_TEXT_LIMITS } from '@/lib/repositories/demo-trial-checks';
import type { DbClient } from '@/lib/repositories/types';
import { ssbjReasonRecorderOf } from '@/lib/services/requirement-decisions';
import { isSsbjItemInScope } from '@/lib/services/ssbj-gap';
import { isUuid } from '@/lib/validation/uuid';
import type {
  AuthorizationContext,
  DisclosureItem,
  ExclusionDecision,
  ExclusionSource,
  RequirementExclusionEvent,
  Uuid,
} from '@/types/domain';

/**
 * 対象外・非重要の申請と承認（トライアル対応 NF-02。二者・承認者の記録）。
 *
 *  - 担当者（enterprise.disclosure.write）が理由付きの対象外・非重要を「申請」する
 *  - 別の人（enterprise.disclosure.approve）が「承認」または「差し戻す」（差戻しは理由必須）
 *  - 申請者・理由を記録した人は承認できない（職務分離。DB の t4d.requirement_exclusion_event_guard と同じ規則）。
 *    理由を記録した人は、プロジェクトの判断は決定者（decided_by）、SSBJ の評価は区分・理由を最後に
 *    記録した人（reason_recorded_by。以前の行は最後に更新した人）
 *  - 承認・差戻し・取り下げは、同じ内容の最後の記録が「申請」のときだけ（差し戻した・取り下げた申請は承認できない）
 *  - 承認は理由のダイジェスト（区分＋理由の sha256）に結び付く。理由・区分を変えると承認は無効になり、
 *    承認されるまで分母から外さない（requirement-coverage.ts の exclusionStateOf が導く）
 *  - 記録は追記専用（requirement_exclusion_events）。取り消しは「取り下げ」の行を足す
 *
 * 判断そのもの（区分・理由）は SSBJ は ssbj_assessments、それ以外の基準は project_requirement_assessments に
 * あり、ここは書き換えない。権限は ID の検索より先に確かめ、他の組織の行は「見つかりません」にする。
 */

/** 差戻しの理由の上限（Demo Mode は Cookie の容量に合わせる。DB の CHECK は 2,000 字） */
export function exclusionNoteLimit(ctx: AuthorizationContext): number {
  return ctx.demo ? DEMO_TEXT_LIMITS.note : 2000;
}

/** 申請・承認の対象（SSBJ は報告期間の評価、それ以外はプロジェクトの基準の判断） */
export type ExclusionTargetInput =
  | { source: 'ssbj_assessment'; itemId: Uuid; reportingPeriodId: Uuid }
  | { source: 'project_assessment'; itemId: Uuid; projectFrameworkId: Uuid };

export interface ExclusionTarget {
  source: ExclusionSource;
  organizationId: Uuid;
  frameworkVersionId: Uuid;
  reportingPeriodId: Uuid;
  projectFrameworkId: Uuid | null;
  item: DisclosureItem;
  /** 今の判断（対象外・非重要で理由があるときだけ。それ以外は null） */
  current: { decision: ExclusionDecision; reason: string } | null;
  /**
   * 理由を記録した人（承認できない人）。プロジェクトの判断は決定者、SSBJ の評価は適用区分・重要性と
   * その理由を最後に記録した人（reason_recorded_by。以前の行は最後に更新した人）
   */
  recorder: Uuid | null;
}

export interface ExclusionStatus {
  target: ExclusionTarget;
  state: ExclusionStateResult;
  /** この要求事項の記録（古い順） */
  events: RequirementExclusionEvent[];
}

const DECISION_LABEL: Readonly<Record<ExclusionDecision, string>> = {
  not_applicable: '対象外',
  not_material: '非重要',
};

function byTime(a: RequirementExclusionEvent, b: RequirementExclusionEvent): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/** 今の判断に対する承認の状態（記録とダイジェストから導く。保存しない） */
export function exclusionStateFor(
  events: readonly RequirementExclusionEvent[],
  current: { decision: ExclusionDecision; reason: string } | null,
): ExclusionStateResult {
  return exclusionStateOf(
    events,
    current
      ? {
          decision: current.decision,
          reasonDigest: exclusionReasonDigest(current.decision, current.reason),
        }
      : null,
  );
}

/** 対象を組織の中で解決する（他の組織・別の版の要求事項は「見つかりません」） */
export async function resolveExclusionTarget(
  db: DbClient,
  ctx: AuthorizationContext,
  input: ExclusionTargetInput,
): Promise<ExclusionTarget> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.read');
  const organizationId = ctx.workspace.organizationId;
  if (!isUuid(input.itemId)) throw new NotFoundError('要求事項が見つかりません。');
  const item = await db.findById('disclosureItems', input.itemId);
  if (!item) throw new NotFoundError('要求事項が見つかりません。');

  if (input.source === 'ssbj_assessment') {
    const period = isUuid(input.reportingPeriodId)
      ? await db.findById('periods', input.reportingPeriodId)
      : null;
    if (!period || period.organizationId !== organizationId) {
      throw new NotFoundError('報告期間が見つかりません。');
    }
    const [assessment] = await db.select('ssbjAssessments', {
      where: { organizationId, reportingPeriodId: period.id, itemId: item.id },
    });
    if (!assessment) throw new NotFoundError('要求事項の評価が見つかりません。');
    let current: ExclusionTarget['current'] = null;
    if (assessment.applicability === 'not_applicable') {
      if (assessment.applicabilityReason.trim() !== '') {
        current = { decision: 'not_applicable', reason: assessment.applicabilityReason };
      }
    } else if (
      assessment.materiality === 'not_material' &&
      assessment.materialityReason.trim() !== ''
    ) {
      current = { decision: 'not_material', reason: assessment.materialityReason };
    }
    return {
      source: 'ssbj_assessment',
      organizationId,
      frameworkVersionId: item.frameworkVersionId,
      reportingPeriodId: period.id,
      projectFrameworkId: null,
      item,
      current,
      recorder: ssbjReasonRecorderOf(assessment),
    };
  }

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
  if (item.frameworkVersionId !== pf.frameworkVersionId) {
    throw new NotFoundError('要求事項が見つかりません。');
  }
  const [assessment] = await db.select('projectRequirementAssessments', {
    where: { organizationId, projectFrameworkId: pf.id, itemId: item.id },
  });
  const current =
    assessment &&
    (assessment.applicability === 'not_applicable' ||
      assessment.applicability === 'not_material') &&
    assessment.applicabilityReason.trim() !== ''
      ? { decision: assessment.applicability, reason: assessment.applicabilityReason }
      : null;
  return {
    source: 'project_assessment',
    organizationId,
    frameworkVersionId: pf.frameworkVersionId,
    reportingPeriodId: project.reportingPeriodId,
    projectFrameworkId: pf.id,
    item,
    current,
    recorder: assessment?.decidedBy ?? null,
  };
}

async function eventsOf(db: DbClient, target: ExclusionTarget) {
  const rows = await db.select('requirementExclusionEvents', {
    where: {
      organizationId: target.organizationId,
      itemId: target.item.id,
      reportingPeriodId: target.reportingPeriodId,
      frameworkVersionId: target.frameworkVersionId,
    },
  });
  return rows
    .filter(
      (e) =>
        e.source === target.source &&
        (e.projectFrameworkId ?? null) === (target.projectFrameworkId ?? null),
    )
    .sort(byTime);
}

/** 画面用: 対象・承認の状態・記録 */
export async function loadExclusionStatus(
  db: DbClient,
  ctx: AuthorizationContext,
  input: ExclusionTargetInput,
): Promise<ExclusionStatus> {
  const target = await resolveExclusionTarget(db, ctx, input);
  const events = await eventsOf(db, target);
  return { target, events, state: exclusionStateFor(events, target.current) };
}

/** 理由を記録した人が承認しようとしたときの理由（画面の disabledReason と decideExclusion で同じ文言） */
export const RECORDER_CANNOT_APPROVE = '理由を記録した人は承認できません（職務分離）。';

/**
 * 承認・差戻しの可否と、できない理由（decideExclusion・画面の disabledReason と同じ規則）。
 * 理由を記録した人は承認だけができない（差し戻すことはできる）
 */
export function exclusionDecisionBlocker(
  ctx: AuthorizationContext,
  status: Pick<ExclusionStatus, 'state' | 'target'>,
  decision: 'approved' | 'returned' = 'approved',
): string | null {
  if (!can(ctx, 'enterprise.disclosure.approve')) {
    return '承認・差戻しには開示の承認権限が必要です。';
  }
  if (status.state.state !== 'requested') return '承認待ちの申請がありません。';
  if (status.state.requestedBy === ctx.userId) {
    return '申請した人は承認・差戻しできません（職務分離）。';
  }
  if (decision === 'approved' && status.target.recorder === ctx.userId) {
    return RECORDER_CANNOT_APPROVE;
  }
  return null;
}

/**
 * 記録の時刻。同じミリ秒に続けて記録すると（申請 → 取り下げ）時刻が並び、順序が乱数の ID で決まって
 * 状態の導出（exclusionStateOf は時刻順）が逆転するため、前の記録より必ず後の時刻にする
 */
function nextEventTime(previous: readonly RequirementExclusionEvent[]): string {
  const latest = previous.reduce((max, e) => Math.max(max, Date.parse(e.createdAt) || 0), 0);
  return new Date(Math.max(Date.now(), latest + 1)).toISOString();
}

async function insertEvent(
  db: DbClient,
  ctx: AuthorizationContext,
  target: ExclusionTarget,
  current: NonNullable<ExclusionTarget['current']>,
  event: RequirementExclusionEvent['event'],
  previous: readonly RequirementExclusionEvent[],
  note = '',
): Promise<RequirementExclusionEvent> {
  const row: RequirementExclusionEvent = {
    id: randomUUID(),
    organizationId: target.organizationId,
    frameworkVersionId: target.frameworkVersionId,
    itemId: target.item.id,
    reportingPeriodId: target.reportingPeriodId,
    projectFrameworkId: target.projectFrameworkId,
    source: target.source,
    event,
    decision: current.decision,
    reasonDigest: exclusionReasonDigest(current.decision, current.reason),
    reasonExcerpt: exclusionReasonExcerpt(current.reason),
    note,
    actorUserId: ctx.userId,
    createdAt: nextEventTime(previous),
  };
  const [inserted] = await db.insert('requirementExclusionEvents', [row]);
  return inserted ?? row;
}

/**
 * 対象外・非重要として申請する（enterprise.disclosure.write）。理由の無い判断・申請中・承認済みは申請できない
 */
export async function requestExclusion(
  db: DbClient,
  ctx: AuthorizationContext,
  input: ExclusionTargetInput,
): Promise<RequirementExclusionEvent> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.write');
  const { target, state, events } = await loadExclusionStatus(db, ctx, input);
  const current = target.current;
  if (!current) {
    throw new ValidationError(
      '対象外・非重要の判断と理由を記録してから申請してください（理由の無い除外は申請できません）。',
    );
  }
  if (state.state === 'requested') {
    throw new ValidationError('この内容は既に申請中です（承認者の判断を待っています）。');
  }
  if (state.state === 'approved') {
    throw new ValidationError('この内容は既に承認されています。');
  }
  const row = await insertEvent(db, ctx, target, current, 'requested', events);
  await recordAuditEvent(db, ctx, {
    eventType: 'exclusion_requested',
    resourceType: 'requirement_exclusion',
    resourceId: row.id,
    afterSummary: `${target.item.code} を${DECISION_LABEL[current.decision]}として申請: ${row.reasonExcerpt}`,
    metadata: { itemId: target.item.id, source: target.source, decision: current.decision },
  });
  return row;
}

/**
 * 申請を承認する・差し戻す（enterprise.disclosure.approve）。申請者・理由を記録した人は承認できない。
 * 差戻しは理由が必須。承認は追記で残り、取り消せない（理由を変えると承認し直しになる）
 */
export async function decideExclusion(
  db: DbClient,
  ctx: AuthorizationContext,
  input: ExclusionTargetInput & { decision: 'approved' | 'returned'; note?: string },
): Promise<RequirementExclusionEvent> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.approve');
  const status = await loadExclusionStatus(db, ctx, input);
  const { target, state } = status;
  const current = target.current;
  if (!current || state.state !== 'requested') {
    throw new ValidationError('承認待ちの申請がありません（理由が変わった場合は申請し直しです）。');
  }
  if (state.requestedBy === ctx.userId) {
    throw new ValidationError('申請した人は承認・差戻しできません（職務分離）。');
  }
  if (input.decision === 'approved' && target.recorder && target.recorder === ctx.userId) {
    throw new ValidationError(RECORDER_CANNOT_APPROVE);
  }
  const note = (input.note ?? '').trim();
  if (input.decision === 'returned') {
    if (note === '') throw new ValidationError('差し戻す理由を入力してください。');
    const limit = exclusionNoteLimit(ctx);
    if (note.length > limit) {
      throw new ValidationError(`差し戻す理由は ${limit} 字以内で入力してください。`);
    }
  }
  const row = await insertEvent(
    db,
    ctx,
    target,
    current,
    input.decision,
    status.events,
    input.decision === 'returned' ? note : '',
  );
  await recordAuditEvent(db, ctx, {
    eventType: 'exclusion_decided',
    resourceType: 'requirement_exclusion',
    resourceId: row.id,
    afterSummary:
      input.decision === 'approved'
        ? `${target.item.code} の${DECISION_LABEL[current.decision]}を承認`
        : `${target.item.code} の${DECISION_LABEL[current.decision]}の申請を差戻し: ${note.slice(0, 60)}`,
    metadata: {
      itemId: target.item.id,
      source: target.source,
      decision: input.decision,
      requestedBy: state.requestedBy,
    },
  });
  return row;
}

/** 申請を取り下げる（申請者本人、または開示の編集権限を持つ人） */
export async function withdrawExclusion(
  db: DbClient,
  ctx: AuthorizationContext,
  input: ExclusionTargetInput,
): Promise<RequirementExclusionEvent> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.read');
  const { target, state, events } = await loadExclusionStatus(db, ctx, input);
  const current = target.current;
  if (!current || state.state !== 'requested') {
    throw new ValidationError('取り下げられる申請がありません。');
  }
  if (state.requestedBy !== ctx.userId && !can(ctx, 'enterprise.disclosure.write')) {
    throw new ValidationError('申請を取り下げられるのは、申請した人か開示の編集権限を持つ人です。');
  }
  const row = await insertEvent(db, ctx, target, current, 'withdrawn', events);
  await recordAuditEvent(db, ctx, {
    eventType: 'exclusion_decided',
    resourceType: 'requirement_exclusion',
    resourceId: row.id,
    afterSummary: `${target.item.code} の${DECISION_LABEL[current.decision]}の申請を取り下げ`,
    metadata: { itemId: target.item.id, source: target.source, decision: 'withdrawn' },
  });
  return row;
}

/** 承認待ちの申請（ホームの Attention・通知に使う。保存しない） */
export interface PendingExclusion {
  itemId: Uuid;
  itemCode: string;
  source: ExclusionSource;
  decision: ExclusionDecision;
  requestedBy: Uuid | null;
  requestedAt: string | null;
  /** 承認・差戻しを行う画面（SSBJ は SSBJ 要求事項の詳細、それ以外はプロジェクトの要求事項の詳細） */
  href: string;
}

/**
 * 組織の承認待ちの対象外・非重要の申請（読むだけ）。記録を対象ごとにまとめ、最後の記録が申請のものだけを
 * 今の理由で確かめ直す（理由が変わった申請は承認待ちに数えない）。開示の閲覧権限が無ければ空
 */
export async function listPendingExclusions(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<PendingExclusion[]> {
  if (ctx.workspace.organizationType !== 'enterprise') return [];
  if (!can(ctx, 'enterprise.disclosure.read')) return [];
  const events = await db.select('requirementExclusionEvents', {
    where: { organizationId: ctx.workspace.organizationId },
  });
  const groups = new Map<string, RequirementExclusionEvent[]>();
  for (const event of events) {
    const key = [
      event.source,
      event.itemId,
      event.reportingPeriodId,
      event.frameworkVersionId,
      event.projectFrameworkId ?? '',
    ].join('|');
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  const out: PendingExclusion[] = [];
  const ssbjScope = new Map<string, boolean>();
  for (const list of groups.values()) {
    const last = [...list].sort(byTime).at(-1);
    if (!last || last.event !== 'requested') continue;
    const input: ExclusionTargetInput | null =
      last.source === 'ssbj_assessment'
        ? {
            source: 'ssbj_assessment',
            itemId: last.itemId,
            reportingPeriodId: last.reportingPeriodId,
          }
        : last.projectFrameworkId
          ? {
              source: 'project_assessment',
              itemId: last.itemId,
              projectFrameworkId: last.projectFrameworkId,
            }
          : null;
    if (!input) continue;
    let status: ExclusionStatus;
    try {
      status = await loadExclusionStatus(db, ctx, input);
    } catch (error) {
      // 対象が消えた（版の付け替え・プロジェクトの削除）記録は数えない
      if (error instanceof NotFoundError) continue;
      throw error;
    }
    if (status.state.state !== 'requested' || !status.target.current) continue;
    let href: string;
    if (input.source === 'project_assessment') {
      const pf = await db.findById('projectFrameworks', input.projectFrameworkId);
      if (!pf) continue;
      href = `/enterprise/disclosure-projects/${encodeURIComponent(pf.projectId)}/requirements/${encodeURIComponent(last.itemId)}`;
    } else {
      // 分析条件で適用しない基準の要求事項は SSBJ の一覧・詳細に出ない（詳細は 404）。承認する画面が無いので数えない
      const scopeKey = input.reportingPeriodId;
      let inScope = ssbjScope.get(`${scopeKey}|${last.itemId}`);
      if (inScope === undefined) {
        inScope = await isSsbjItemInScope(
          db,
          ctx.workspace.organizationId,
          input.reportingPeriodId,
          last.itemId,
        );
        ssbjScope.set(`${scopeKey}|${last.itemId}`, inScope);
      }
      if (!inScope) continue;
      // SSBJ の詳細はヘッダーの年度で開くため、申請の年度を明示する（違えば画面が帯で知らせる）
      href = `/enterprise/disclosures/ssbj/requirements/${encodeURIComponent(last.itemId)}?period=${encodeURIComponent(input.reportingPeriodId)}`;
    }
    out.push({
      itemId: last.itemId,
      itemCode: status.target.item.code,
      source: last.source,
      decision: status.target.current.decision,
      requestedBy: status.state.requestedBy,
      requestedAt: status.state.requestedAt,
      href,
    });
  }
  return out.sort(
    (a, b) =>
      (a.requestedAt ?? '').localeCompare(b.requestedAt ?? '') ||
      a.itemCode.localeCompare(b.itemCode, 'ja'),
  );
}
