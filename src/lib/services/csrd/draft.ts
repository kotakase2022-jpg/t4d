import 'server-only';

import { runAi } from '@/lib/ai';
import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, can, NotFoundError } from '@/lib/authorization/can';
import {
  CSRD_DRAFT_AI_BODY_TARGET,
  CSRD_DRAFT_BODY_MAX,
  CSRD_SECTION_LABEL,
  csrdSectionOfItem,
  isCsrdInScope,
  type CsrdApplicability,
} from '@/lib/domain/csrd';
import { csrdRowIds } from '@/lib/domain/csrd-ids';
import { IRO_TYPE_LABEL, iroFinancialScore, iroImpactScore } from '@/lib/domain/dma';
import { ValidationError } from '@/lib/errors/user-facing';
import { hasUsableValue, valueKindOf } from '@/lib/services/aggregation';
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
  assertSameBase,
  countsAsConfirmedDraft,
  csrdSectionApplicability,
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
 *  - 採用・保存・確定は、画面が表示したときの版（updatedAt）を受け取り、別のタブ・別の利用者の操作で
 *    変わっていれば断る（見ていない AI 草案・本文を、採用・上書き・確定しない）
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
  /**
   * 本文を手で書けるか（編集権限あり、かつ草案の行がある・または評価対象の節）。
   * AI の実行権限が無い編集者も、草案の行が無い評価対象の節に本文を書ける
   */
  canWriteBody: boolean;
  /** 確定できるか */
  confirmable: boolean;
  confirmBlockedReason: string | null;
  confirmedByName: string | null;
  /**
   * 確定済みのまま、事項の判断が変わって対象外・未判定になった節（以前のデータ）。
   * 確定の条件を満たさないため、確定済みの数には入れず、画面で再確認を促す
   */
  staleConfirmation: boolean;
}

export interface CsrdDraftOverview {
  period: ReportingPeriod;
  dmaConfirmed: boolean;
  /** マスターに要求事項がある節だけ（ESRS2・E1・E3・E5・S1・G1） */
  sections: CsrdDraftSectionView[];
  /** 確定済みの節（評価対象の節だけを数える） */
  confirmedCount: number;
  canWrite: boolean;
  canRunAi: boolean;
}

/** マスターに要求事項がある節（CSRD_SECTIONS の順） */
function sectionsWithItems(context: CsrdContext): CsrdSection[] {
  const present = new Set(
    context.items.map((i) => csrdSectionOfItem(i)).filter((s): s is CsrdSection => s !== null),
  );
  return CSRD_SECTIONS.filter((s) => present.has(s));
}

function isCsrdSection(value: unknown): value is CsrdSection {
  return typeof value === 'string' && (CSRD_SECTIONS as readonly string[]).includes(value);
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
    const applicability = csrdSectionApplicability(context, section);
    const inScope = isCsrdInScope(applicability);
    const draft = bySection.get(section) ?? null;
    const blocked = generateBlockedReason(applicability, draft);
    const confirmBlocked = confirmBlockedReason(context, applicability, draft);
    sections.push({
      section,
      label: CSRD_SECTION_LABEL[section],
      applicability,
      inScope,
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
      canWriteBody: canWrite && (draft !== null || inScope),
      confirmable: canWrite && confirmBlocked === null,
      confirmBlockedReason: confirmBlocked,
      confirmedByName: await displayNameOf(db, draft?.confirmedBy ?? null),
      staleConfirmation: draft !== null && draft.confirmedAt !== null && !inScope,
    });
  }
  return {
    period,
    dmaConfirmed: context.dmaConfirmed,
    sections,
    confirmedCount: drafts.filter((d) => countsAsConfirmedDraft(context, d)).length,
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
  if (!isCsrdSection(section)) {
    throw new NotFoundError('開示ドラフトの節が見つかりません。');
  }
  const context = await loadCsrdContext(db, ctx, ownPeriod);
  if (!context) throw new NotFoundError('CSRD の要求事項マスターが見つかりません。');
  const organizationId = ctx.workspace.organizationId;
  const sectionItems = context.items.filter((i) => csrdSectionOfItem(i) === section);
  if (sectionItems.length === 0) {
    throw new ValidationError(`「${CSRD_SECTION_LABEL[section]}」には要求事項がありません。`);
  }
  const applicability = csrdSectionApplicability(context, section);
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
  // 推計は推計のまま渡す（AI が実績のように書かないよう、値ごとに区分を付ける）
  const metricValues = values.map((dp) => ({
    label: `${metricById.get(dp.metricId)?.name ?? '指標'}（${unitName.get(dp.unitId) ?? '—'}）`,
    value: dp.value as number,
    unit: dp.unitOfMeasure,
    kind: valueKindOf(dp) === 'estimate' ? ('estimate' as const) : ('actual' as const),
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

  // AI の出力はスキーマの形だけを満たしている。保存する前に、この節の規則で確かめる
  // （別の節の文章・節の外の要求事項・担当者が確定していない要求事項を「根拠」として出さない）
  if (output.section !== section) {
    throw new ValidationError(
      `AI の出力が別の節（${output.section}）を指していたため、草案を保存しませんでした。もう一度作成してください。`,
    );
  }
  if (output.body.length > CSRD_DRAFT_BODY_MAX) {
    throw new ValidationError(
      `AI の草案が本文の上限（${CSRD_DRAFT_BODY_MAX} 字）を超えたため、保存しませんでした。もう一度作成してください。`,
    );
  }
  const sectionCodes = new Set(sectionItems.map((i) => i.code));
  const writableCodes = new Set(
    requirements
      .filter(
        (r) => r.reviewed && (r.finalStatus === 'covered' || r.finalStatus === 'mostly_covered'),
      )
      .map((r) => r.code),
  );
  const coveredItemCodes = [...new Set(output.coveredItemCodes)].filter((c) =>
    writableCodes.has(c),
  );
  const droppedCovered = [...new Set(output.coveredItemCodes)].filter((c) => !writableCodes.has(c));
  const seenGaps = new Set<string>();
  const gaps = output.gaps.filter((gap) => {
    if (!sectionCodes.has(gap.itemCode) || seenGaps.has(gap.itemCode)) return false;
    seenGaps.add(gap.itemCode);
    return true;
  });
  const droppedGaps = output.gaps.filter((gap) => !sectionCodes.has(gap.itemCode));
  const warnings = [
    ...output.warnings,
    ...(droppedCovered.length > 0
      ? [
          `AI が根拠に挙げた要求事項のうち、この節の担当者確認済み（対応済み・おおむね対応）でないもの（${droppedCovered.join('、')}）は根拠から外しました。本文に該当する記述が無いか確認してください。`,
        ]
      : []),
    ...(droppedGaps.length > 0
      ? [
          `この節の要求事項ではないコード（${[...new Set(droppedGaps.map((g) => g.itemCode))].join('、')}）を「書けなかった箇所」から外しました。`,
        ]
      : []),
    ...(output.body.length > CSRD_DRAFT_AI_BODY_TARGET
      ? [
          `草案が目安の ${CSRD_DRAFT_AI_BODY_TARGET} 字を超えています。採用する前に長さを確認してください。`,
        ]
      : []),
  ];

  const now = new Date().toISOString();
  const patch = {
    aiBody: output.body,
    coveredItemCodes,
    gaps,
    aiRunId: run.id,
    // numeric(4,3) にそろえる（Demo と Supabase で値を変えない）
    aiConfidence: Math.round(output.confidence * 1000) / 1000,
    aiWarnings: warnings,
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
  draftId: unknown,
): Promise<CsrdDisclosureDraft> {
  const draft =
    typeof draftId === 'string' ? await db.findById('csrdDisclosureDrafts', draftId) : null;
  if (!draft || draft.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('開示ドラフトが見つかりません。');
  }
  return draft;
}

export interface CsrdDraftOperationInput {
  draftId: Uuid;
  /** 画面が表示したときの節の updatedAt（別の操作で変わっていれば断る） */
  baseUpdatedAt: string;
}

/**
 * AI 草案を本文に採用する（人の操作）。本文が変わるので確定は外れる。
 * 画面が表示した草案（updatedAt）のままのときだけ採用する（作り直された見ていない草案を本文に入れない）。
 * AI の実行の採否（ai_runs）は、AI の実行権限を持つ人の採用だけを記録する（recordAiDecision と同じ規則。
 * 0023 の RLS も ai.run を求める）。権限が無い編集者の採用は、監査ログの「本文に採用」だけに残す。
 * 権限の判定は書込の前に行い、途中で失敗して本文だけが変わる状態を作らない
 */
export async function adoptCsrdDraft(
  db: DbClient,
  ctx: AuthorizationContext,
  input: CsrdDraftOperationInput,
): Promise<CsrdDisclosureDraft> {
  assertCsrdWrite(ctx);
  const draft = await findDraft(db, ctx, input.draftId);
  assertSameBase(draft.updatedAt, input.baseUpdatedAt);
  if (draft.aiBody.trim() === '') {
    throw new ValidationError('採用できる AI 草案がありません。先に草案を作成してください。');
  }
  if (draft.aiBody.length > CSRD_DRAFT_BODY_MAX) {
    throw new ValidationError(
      `AI 草案が本文の上限（${CSRD_DRAFT_BODY_MAX} 字）を超えているため、採用できません。草案を作り直してください。`,
    );
  }
  const run =
    draft.aiRunId && can(ctx, 'enterprise.ai.run')
      ? await db.findById('aiRuns', draft.aiRunId)
      : null;
  const recordRun =
    run !== null &&
    run.organizationId === ctx.workspace.organizationId &&
    run.status === 'succeeded';

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
    metadata: { aiRunId: draft.aiRunId, aiDecisionRecorded: recordRun },
  });
  if (recordRun && run) {
    // 採否の記録（ai_runs の状態）。他の実行の記録には触れない
    await db.update('aiRuns', run.id, {
      status: 'accepted',
      reviewedBy: ctx.userId,
      acceptedAt: now,
    });
  }
  return updated;
}

export interface SaveCsrdDraftBodyInput {
  /** 草案の行。行の無い節に初めて書くときは null（reportingPeriodId と section で節を指す） */
  draftId: Uuid | null;
  reportingPeriodId?: Uuid;
  section?: CsrdSection;
  body: string;
  /** 画面が表示したときの updatedAt。行の無い節に書くときは null */
  baseUpdatedAt: string | null;
}

/**
 * 本文を人が保存する。保存すると確定は外れる。
 * 画面が表示した版のままのときだけ上書きする（別のタブ・別の利用者の保存・採用を黙って消さない）。
 * 草案の行が無い評価対象の節は、ここで行を作る（AI の実行権限の無い編集者も本文を書ける）
 */
export async function saveCsrdDraftBody(
  db: DbClient,
  ctx: AuthorizationContext,
  input: SaveCsrdDraftBodyInput,
): Promise<CsrdDisclosureDraft> {
  assertCsrdWrite(ctx);
  const body = input.body;
  if (typeof body !== 'string' || body.length > CSRD_DRAFT_BODY_MAX) {
    throw new ValidationError(`本文は ${CSRD_DRAFT_BODY_MAX} 字以内で入力してください。`);
  }
  const now = new Date().toISOString();

  if (input.draftId) {
    const draft = await findDraft(db, ctx, input.draftId);
    assertSameBase(draft.updatedAt, input.baseUpdatedAt);
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

  // 行の無い節に初めて書く
  if (!isCsrdSection(input.section)) {
    throw new NotFoundError('開示ドラフトの節が見つかりません。');
  }
  const section = input.section;
  const period = await findCsrdPeriod(db, ctx, input.reportingPeriodId ?? '');
  const context = await loadCsrdContext(db, ctx, period);
  if (!context) throw new NotFoundError('CSRD の要求事項マスターが見つかりません。');
  if (!context.items.some((i) => csrdSectionOfItem(i) === section)) {
    throw new ValidationError(`「${CSRD_SECTION_LABEL[section]}」には要求事項がありません。`);
  }
  const applicability = csrdSectionApplicability(context, section);
  if (!isCsrdInScope(applicability)) {
    throw new ValidationError(
      applicability.kind === 'not_material'
        ? '重要でないと判断した事項の節のため、本文は書けません（対象外）。'
        : '事項の重要性が未評価のため、本文は書けません（ダブル・マテリアリティ評価で判断してください）。',
    );
  }
  const organizationId = ctx.workspace.organizationId;
  const existing = await db.select('csrdDisclosureDrafts', {
    where: { organizationId, reportingPeriodId: period.id, section },
    limit: 1,
  });
  if (existing.length > 0) {
    // 画面を表示した後に、別の操作で行ができた（その内容を見ずに上書きしない）
    assertSameBase(existing[0]!.updatedAt, input.baseUpdatedAt);
  }
  if (body.trim() === '') {
    throw new ValidationError('本文を入力してください。');
  }
  const row: CsrdDisclosureDraft = {
    id: csrdRowIds.draft(organizationId, period.id, section),
    organizationId,
    reportingPeriodId: period.id,
    section,
    body,
    aiBody: '',
    coveredItemCodes: [],
    gaps: [],
    aiRunId: null,
    aiConfidence: null,
    aiWarnings: [],
    aiGeneratedAt: null,
    confirmedAt: null,
    confirmedBy: null,
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  };
  await db.insert('csrdDisclosureDrafts', [row]);
  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'csrd_disclosure_draft',
    resourceId: row.id,
    afterSummary: `「${CSRD_SECTION_LABEL[section]}」の本文を担当者が書いて保存（AI 草案なし）`,
  });
  return row;
}

/**
 * 節を確定する（人の操作）。DMA の確定後・評価対象の節・本文ありのときだけ。
 * 画面が表示した本文（updatedAt）のままのときだけ確定する（見ていない本文を確定しない）
 */
export async function confirmCsrdDraft(
  db: DbClient,
  ctx: AuthorizationContext,
  input: CsrdDraftOperationInput,
): Promise<CsrdDisclosureDraft> {
  assertCsrdWrite(ctx);
  const draft = await findDraft(db, ctx, input.draftId);
  assertSameBase(draft.updatedAt, input.baseUpdatedAt);
  const period = await findCsrdPeriod(db, ctx, draft.reportingPeriodId);
  const context = await loadCsrdContext(db, ctx, period);
  if (!context) throw new NotFoundError('CSRD の要求事項マスターが見つかりません。');
  const blocked = confirmBlockedReason(
    context,
    csrdSectionApplicability(context, draft.section),
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
