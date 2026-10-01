import 'server-only';

import { runAi } from '@/lib/ai';
import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, can, NotFoundError } from '@/lib/authorization/can';
import {
  CSRD_DRAFT_BODY_MAX,
  CSRD_SECTION_LABEL,
  csrdSectionOfItem,
  deriveCsrdApplicability,
  isCsrdInScope,
  type CsrdApplicability,
} from '@/lib/domain/csrd';
import { csrdRowIds } from '@/lib/domain/csrd-ids';
import { IRO_TYPE_LABEL, iroFinancialScore, iroImpactScore } from '@/lib/domain/dma';
import { ValidationError } from '@/lib/errors/user-facing';
import { hasUsableValue } from '@/lib/services/aggregation';
import type { DbClient } from '@/lib/repositories/types';
import {
  CSRD_SECTIONS,
  type AiSourceReference,
  type AuthorizationContext,
  type CsrdDisclosureDraft,
  type CsrdSection,
  type ReportingPeriod,
  type SsbjCoverageStatus,
  type Uuid,
} from '@/types/domain';
import {
  assertCsrdWrite,
  displayNameOf,
  findCsrdPeriod,
  loadCsrdContext,
  type CsrdContext,
  type CsrdMatterState,
} from './core';

/**
 * CSRD 開示ドラフトの節（docs/disclosure-first.md §9.4）。
 *
 * 流れ: AI 草案（デモ生成）→「本文に採用」（人）→ 本文の編集・保存（人）→ 確定（人）。
 *  - AI は ai_body 等の候補の列だけを書く（本文 body は変えない。CLAUDE.md §0.4）
 *  - 草案を作れるのは評価対象（常に適用・重要と判断した事項）の節だけ。確定済みの節は作り直せない
 *  - 本文を直すと確定は外れる。確定は DMA の確定後・本文ありのときだけ
 *  - 読込関数は書かない
 */

export interface CsrdDraftItemView {
  /** 要求事項の詳細（/csrd/requirements/{itemId}）へリンクするため */
  itemId: Uuid;
  code: string;
  title: string;
  finalStatus: SsbjCoverageStatus | null;
  reviewed: boolean;
}

export interface CsrdDraftSectionView {
  section: CsrdSection;
  label: string;
  applicability: CsrdApplicability;
  inScope: boolean;
  items: CsrdDraftItemView[];
  draft: CsrdDisclosureDraft | null;
  /** AI 草案を本文に採用し、人が手を入れたか */
  edited: boolean;
  /** AI 草案を作れるか（評価対象・未確定・権限あり） */
  generatable: boolean;
  /** 作れない理由（作れるなら null） */
  generateBlockedReason: string | null;
  /** 確定できるか */
  confirmable: boolean;
  confirmBlockedReason: string | null;
  confirmedByName: string | null;
}

export interface CsrdDraftOverview {
  period: ReportingPeriod;
  dmaConfirmed: boolean;
  /** マスターに要求事項がある節だけ（ESRS2・E1・E3・E5・S1・G1） */
  sections: CsrdDraftSectionView[];
  confirmedCount: number;
  canWrite: boolean;
  canRunAi: boolean;
}

function sectionApplicability(context: CsrdContext, section: CsrdSection): CsrdApplicability {
  if (section === 'ESRS2') return deriveCsrdApplicability('ESRS2', null, context.dmaConfirmed);
  const matter = context.matters.find((m) => m.topic === section)?.matter ?? null;
  return deriveCsrdApplicability(section, matter, context.dmaConfirmed);
}

/** マスターに要求事項がある節（CSRD_SECTIONS の順） */
function sectionsWithItems(context: CsrdContext): CsrdSection[] {
  const present = new Set(
    context.items.map((i) => csrdSectionOfItem(i)).filter((s): s is CsrdSection => s !== null),
  );
  return CSRD_SECTIONS.filter((s) => present.has(s));
}

function generateBlockedReason(
  applicability: CsrdApplicability,
  draft: CsrdDisclosureDraft | null,
): string | null {
  if (applicability.kind === 'not_material') {
    return '重要でないと判断した事項の節のため、草案は作れません（対象外）。';
  }
  if (applicability.kind === 'undetermined') {
    return '事項の重要性が未評価のため、草案は作れません（ダブル・マテリアリティ評価で判断してください）。';
  }
  if (draft?.confirmedAt) {
    return '確定済みの節は作り直せません（本文を保存し直すと確定が外れます）。';
  }
  return null;
}

function confirmBlockedReason(
  context: CsrdContext,
  applicability: CsrdApplicability,
  draft: CsrdDisclosureDraft | null,
): string | null {
  if (!isCsrdInScope(applicability)) return '評価対象でない節は確定できません。';
  if (!context.dmaConfirmed)
    return 'ダブル・マテリアリティ評価（DMA）を確定してから確定してください。';
  if (!draft || draft.body.trim() === '') return '本文が空のままでは確定できません。';
  if (draft.confirmedAt) return '確定済みです。';
  return null;
}

/** 開示ドラフトの画面。書かない。CSRD のマスターが無ければ null */
export async function loadCsrdDrafts(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
): Promise<CsrdDraftOverview | null> {
  const context = await loadCsrdContext(db, ctx, period);
  if (!context) return null;
  const drafts = await db.select('csrdDisclosureDrafts', {
    where: { organizationId: ctx.workspace.organizationId, reportingPeriodId: period.id },
  });
  const bySection = new Map(drafts.map((d) => [d.section, d]));
  const assessmentByItem = new Map(context.assessments.map((a) => [a.itemId, a]));
  const canWrite = can(ctx, 'enterprise.disclosure.write');
  const canRunAi = canWrite && can(ctx, 'enterprise.ai.run');

  const sections: CsrdDraftSectionView[] = [];
  for (const section of sectionsWithItems(context)) {
    const applicability = sectionApplicability(context, section);
    const draft = bySection.get(section) ?? null;
    const blocked = generateBlockedReason(applicability, draft);
    const confirmBlocked = confirmBlockedReason(context, applicability, draft);
    sections.push({
      section,
      label: CSRD_SECTION_LABEL[section],
      applicability,
      inScope: isCsrdInScope(applicability),
      items: context.items
        .filter((i) => csrdSectionOfItem(i) === section)
        .map((i) => {
          const a = assessmentByItem.get(i.id);
          return {
            itemId: i.id,
            code: i.code,
            title: i.questionText,
            finalStatus: a?.finalStatus ?? null,
            reviewed: (a?.reviewedAt ?? null) !== null,
          };
        }),
      draft,
      edited:
        draft !== null && draft.aiBody !== '' && draft.body !== '' && draft.body !== draft.aiBody,
      generatable: canRunAi && blocked === null,
      generateBlockedReason: blocked,
      confirmable: canWrite && confirmBlocked === null,
      confirmBlockedReason: confirmBlocked,
      confirmedByName: await displayNameOf(db, draft?.confirmedBy ?? null),
    });
  }
  return {
    period,
    dmaConfirmed: context.dmaConfirmed,
    sections,
    confirmedCount: drafts.filter((d) => d.confirmedAt !== null).length,
    canWrite,
    canRunAi,
  };
}

function topicIros(state: CsrdMatterState | undefined) {
  if (!state) return [];
  return state.iros.slice(0, 4).map((iro) => ({
    id: iro.id,
    typeLabel: IRO_TYPE_LABEL[iro.iroType],
    description: iro.description,
    score: iro.iroType === 'impact' ? iroImpactScore(iro) : iroFinancialScore(iro),
  }));
}

/**
 * 節の AI 草案を作る（デモ生成）。評価対象の節だけ・確定済みの節は不可。
 * ai_body・根拠の要求事項・書けなかった箇所・AI の実行情報だけを書き、本文（body）は変えない
 */
export async function generateCsrdDraft(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  section: CsrdSection,
): Promise<CsrdDisclosureDraft> {
  assertCsrdWrite(ctx);
  assertCan(ctx, 'enterprise.ai.run');
  const ownPeriod = await findCsrdPeriod(db, ctx, period.id);
  if (!(CSRD_SECTIONS as readonly string[]).includes(section)) {
    throw new NotFoundError('開示ドラフトの節が見つかりません。');
  }
  const context = await loadCsrdContext(db, ctx, ownPeriod);
  if (!context) throw new NotFoundError('CSRD の要求事項マスターが見つかりません。');
  const organizationId = ctx.workspace.organizationId;
  const sectionItems = context.items.filter((i) => csrdSectionOfItem(i) === section);
  if (sectionItems.length === 0) {
    throw new ValidationError(`「${CSRD_SECTION_LABEL[section]}」には要求事項がありません。`);
  }
  const applicability = sectionApplicability(context, section);
  const existingRows = await db.select('csrdDisclosureDrafts', {
    where: { organizationId, reportingPeriodId: ownPeriod.id, section },
    limit: 1,
  });
  const current = existingRows[0] ?? null;
  const blocked = generateBlockedReason(applicability, current);
  if (blocked) throw new ValidationError(blocked);

  const assessmentByItem = new Map(context.assessments.map((a) => [a.itemId, a]));
  const requirements = sectionItems.map((item) => {
    const a = assessmentByItem.get(item.id);
    return {
      code: item.code,
      title: item.questionText.slice(0, 60),
      finalStatus: a?.finalStatus ?? null,
      reviewed: (a?.reviewedAt ?? null) !== null,
    };
  });

  // 承認済みの数値だけを根拠にする（節の要求事項に対応付いた指標）
  const metricIds = new Set(
    sectionItems.flatMap((i) => (context.metricsByItem.get(i.id) ?? []).map((m) => m.id)),
  );
  const metricById = new Map(
    sectionItems.flatMap((i) => (context.metricsByItem.get(i.id) ?? []).map((m) => [m.id, m])),
  );
  const [approved, units] = await Promise.all([
    db.select('dataPoints', {
      where: {
        organizationId,
        reportingPeriodId: ownPeriod.id,
        status: 'approved',
        deletedAt: { isNull: true },
      },
    }),
    db.select('units', { where: { organizationId, deletedAt: { isNull: true } } }),
  ]);
  const unitName = new Map(units.map((u) => [u.id, u.name]));
  const values = approved
    .filter((dp) => metricIds.has(dp.metricId) && hasUsableValue(dp))
    .slice(0, 10);
  const metricValues = values.map((dp) => ({
    label: `${metricById.get(dp.metricId)?.name ?? '指標'}（${unitName.get(dp.unitId) ?? '—'}）`,
    value: dp.value as number,
    unit: dp.unitOfMeasure,
  }));
  const matterState =
    section === 'ESRS2' ? undefined : context.matters.find((m) => m.topic === section);
  const iros = topicIros(matterState);

  const sources: AiSourceReference[] = [
    ...values.map((dp) => ({
      kind: 'data_point' as const,
      id: dp.id,
      label: `${metricById.get(dp.metricId)?.name ?? '指標'}（${unitName.get(dp.unitId) ?? '—'}）`,
      locator: null,
      periodLabel: ownPeriod.label,
    })),
    ...(matterState?.persisted
      ? [
          {
            kind: 'dma_matter' as const,
            id: matterState.matter.id,
            label: CSRD_SECTION_LABEL[section],
            locator: null,
            periodLabel: ownPeriod.label,
          },
        ]
      : []),
    ...iros.map((iro) => ({
      kind: 'dma_iro' as const,
      id: iro.id,
      label: iro.description,
      locator: null,
      periodLabel: ownPeriod.label,
    })),
  ];

  const { run, output } = await runAi({
    db,
    ctx,
    idempotencyKey: `csrdDisclosureDraft:${organizationId}:${ownPeriod.id}:${section}`,
    sources,
    invocation: {
      feature: 'csrdDisclosureDraft',
      context: {
        organizationName: ctx.workspace.organizationName,
        reportingPeriodLabel: ownPeriod.label,
      },
      inputReferenceIds: [
        ...sectionItems.map((i) => i.id),
        ...(matterState ? [matterState.matter.id] : []),
      ],
      input: {
        section,
        sectionLabel: CSRD_SECTION_LABEL[section],
        organizationName: ctx.workspace.organizationName,
        periodLabel: ownPeriod.label,
        applicabilityKind: applicability.kind,
        perspectives: applicability.perspectives,
        provisional: applicability.provisional,
        topic: matterState
          ? {
              iros: iros.map(({ typeLabel, description, score }) => ({
                typeLabel,
                description,
                score,
              })),
            }
          : null,
        requirements,
        metricValues,
        sources,
      },
    },
  });

  const now = new Date().toISOString();
  const patch = {
    aiBody: output.body,
    coveredItemCodes: output.coveredItemCodes,
    gaps: output.gaps,
    aiRunId: run.id,
    // numeric(4,3) にそろえる（Demo と Supabase で値を変えない）
    aiConfidence: Math.round(output.confidence * 1000) / 1000,
    aiWarnings: output.warnings,
    aiGeneratedAt: now,
    updatedAt: now,
    updatedBy: ctx.userId,
  };
  let saved: CsrdDisclosureDraft;
  if (current) {
    saved = await db.update('csrdDisclosureDrafts', current.id, patch);
  } else {
    saved = {
      id: csrdRowIds.draft(organizationId, ownPeriod.id, section),
      organizationId,
      reportingPeriodId: ownPeriod.id,
      section,
      body: '',
      confirmedAt: null,
      confirmedBy: null,
      ...patch,
      createdAt: now,
      createdBy: ctx.userId,
    };
    await db.insert('csrdDisclosureDrafts', [saved]);
  }
  await recordAuditEvent(db, ctx, {
    eventType: current ? 'data_updated' : 'data_created',
    resourceType: 'csrd_disclosure_draft',
    resourceId: saved.id,
    afterSummary: `「${CSRD_SECTION_LABEL[section]}」の AI 草案を作成（本文には未採用）`,
    metadata: { aiRunId: run.id },
  });
  return saved;
}

async function findDraft(
  db: DbClient,
  ctx: AuthorizationContext,
  draftId: Uuid,
): Promise<CsrdDisclosureDraft> {
  const draft = await db.findById('csrdDisclosureDrafts', draftId);
  if (!draft || draft.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('開示ドラフトが見つかりません。');
  }
  return draft;
}

/** AI 草案を本文に採用する（人の操作）。本文が変わるので確定は外れる */
export async function adoptCsrdDraft(
  db: DbClient,
  ctx: AuthorizationContext,
  draftId: Uuid,
): Promise<CsrdDisclosureDraft> {
  assertCsrdWrite(ctx);
  const draft = await findDraft(db, ctx, draftId);
  if (draft.aiBody.trim() === '') {
    throw new ValidationError('採用できる AI 草案がありません。先に草案を作成してください。');
  }
  const now = new Date().toISOString();
  const updated = await db.update('csrdDisclosureDrafts', draft.id, {
    body: draft.aiBody,
    confirmedAt: null,
    confirmedBy: null,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'csrd_disclosure_draft',
    resourceId: draft.id,
    afterSummary: `「${CSRD_SECTION_LABEL[draft.section]}」の AI 草案を本文に採用（人の操作。確定はしていない）`,
  });
  if (draft.aiRunId) {
    // 採否の記録（ai_runs の状態）。他の実行の記録には触れない
    const run = await db.findById('aiRuns', draft.aiRunId);
    if (run && run.organizationId === ctx.workspace.organizationId && run.status === 'succeeded') {
      await db.update('aiRuns', run.id, {
        status: 'accepted',
        reviewedBy: ctx.userId,
        acceptedAt: now,
      });
    }
  }
  return updated;
}

/** 本文を人が保存する。保存すると確定は外れる */
export async function saveCsrdDraftBody(
  db: DbClient,
  ctx: AuthorizationContext,
  draftId: Uuid,
  body: string,
): Promise<CsrdDisclosureDraft> {
  assertCsrdWrite(ctx);
  const draft = await findDraft(db, ctx, draftId);
  if (typeof body !== 'string' || body.length > CSRD_DRAFT_BODY_MAX) {
    throw new ValidationError(`本文は ${CSRD_DRAFT_BODY_MAX} 字以内で入力してください。`);
  }
  const now = new Date().toISOString();
  const updated = await db.update('csrdDisclosureDrafts', draft.id, {
    body,
    confirmedAt: null,
    confirmedBy: null,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'csrd_disclosure_draft',
    resourceId: draft.id,
    afterSummary: `「${CSRD_SECTION_LABEL[draft.section]}」の本文を保存${draft.confirmedAt ? '（確定は取り消し）' : ''}`,
  });
  return updated;
}

/** 節を確定する（人の操作）。DMA の確定後・評価対象の節・本文ありのときだけ */
export async function confirmCsrdDraft(
  db: DbClient,
  ctx: AuthorizationContext,
  draftId: Uuid,
): Promise<CsrdDisclosureDraft> {
  assertCsrdWrite(ctx);
  const draft = await findDraft(db, ctx, draftId);
  const period = await findCsrdPeriod(db, ctx, draft.reportingPeriodId);
  const context = await loadCsrdContext(db, ctx, period);
  if (!context) throw new NotFoundError('CSRD の要求事項マスターが見つかりません。');
  const blocked = confirmBlockedReason(
    context,
    sectionApplicability(context, draft.section),
    draft,
  );
  if (blocked) throw new ValidationError(blocked);
  const now = new Date().toISOString();
  const updated = await db.update('csrdDisclosureDrafts', draft.id, {
    confirmedAt: now,
    confirmedBy: ctx.userId,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'csrd_disclosure_draft',
    resourceId: draft.id,
    afterSummary: `「${CSRD_SECTION_LABEL[draft.section]}」の本文を確定`,
  });
  return updated;
}
