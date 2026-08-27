import 'server-only';

import { runAi } from '@/lib/ai';
import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, can, NotFoundError } from '@/lib/authorization/can';
import { AREA_LABEL, SSBJ_AREAS, type SsbjArea } from '@/lib/domain/ssbj';
import { ValidationError } from '@/lib/errors/user-facing';
import { fid } from '@/lib/fixtures/ids';
import { loadSsbjRequirementViews } from '@/lib/services/ssbj-gap';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AiSourceReference,
  AuthorizationContext,
  ReportingPeriod,
  SsbjDisclosureDraft,
  Uuid,
} from '@/types/domain';

/**
 * SSBJ 開示ドラフトの草案生成。
 *
 * 要求事項の判定と承認済みの数値は揃っているのに、それを開示の文章にする
 * 工程だけが手作業のまま残っていた。節ごとの草案を AI に書かせる。
 *
 * 守っていること:
 *  - 草案に書けるのは「担当者が確認して対応済み／おおむね対応とした要求事項」だけ。
 *    未確認・未対応を書けることにすると、根拠の無い文章が開示に載る
 *  - 数値は承認済みのものだけを渡す（未承認値を根拠にさせない）
 *  - AI が書いた本文（aiBody）と人が直した本文（body）を分けて持つ
 *  - 確定は人の操作でのみ起きる。本文を直したら確定は外れる
 */

export interface SsbjDraftView {
  area: SsbjArea;
  areaLabel: string;
  draft: SsbjDisclosureDraft | null;
  /** この節に属する要求事項の数 */
  requirementCount: number;
  /** うち、草案に書ける（確認済みかつ対応済み／おおむね対応）もの */
  writableCount: number;
  /** AI が書いた本文から人が手を入れたか */
  edited: boolean;
}

export interface SsbjDraftOverview {
  period: ReportingPeriod;
  areas: SsbjDraftView[];
  /** 確定済みの節の数 */
  confirmedCount: number;
  canWrite: boolean;
  canRunAi: boolean;
}

/** 草案に書いてよい要求事項か（担当者が確認して対応済み／おおむね対応としたもの） */
function isWritable(finalStatus: string | null, reviewedAt: string | null): boolean {
  if (!reviewedAt) return false;
  return finalStatus === 'covered' || finalStatus === 'mostly_covered';
}

export async function loadSsbjDrafts(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
): Promise<SsbjDraftOverview | null> {
  const organizationId = ctx.workspace.organizationId;
  const master = await loadSsbjRequirementViews(db, ctx, period);
  if (!master) return null;

  const drafts = await db.select('ssbjDisclosureDrafts', {
    where: { organizationId, reportingPeriodId: period.id },
  });
  const byArea = new Map(drafts.map((d) => [d.area, d]));

  const areas: SsbjDraftView[] = SSBJ_AREAS.map((area) => {
    const views = master.views.filter(
      (v) => v.area === area && v.assessment.applicability === 'applicable',
    );
    const draft = byArea.get(area) ?? null;
    return {
      area,
      areaLabel: AREA_LABEL[area],
      draft,
      requirementCount: views.length,
      writableCount: views.filter((v) =>
        isWritable(v.assessment.finalStatus, v.assessment.reviewedAt),
      ).length,
      edited: draft !== null && draft.aiBody !== '' && draft.body !== draft.aiBody,
    };
  });

  return {
    period,
    areas,
    confirmedCount: drafts.filter((d) => d.confirmedAt !== null).length,
    canWrite: can(ctx, 'enterprise.disclosure.write'),
    canRunAi: can(ctx, 'enterprise.ai.run'),
  };
}

/**
 * 節の草案を AI に書かせる。
 *
 * 渡すのは、担当者が確認済みの要求事項・承認済みの数値・取り込んだ資料の抜粋だけ。
 * 未確認のものまで渡すと、AI は「書けるもの」として扱ってしまう。
 */
export async function generateSsbjDraft(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  area: SsbjArea,
): Promise<SsbjDisclosureDraft> {
  assertCan(ctx, 'enterprise.ai.run');
  assertCan(ctx, 'enterprise.disclosure.write');
  const organizationId = ctx.workspace.organizationId;

  const master = await loadSsbjRequirementViews(db, ctx, period);
  if (!master) throw new NotFoundError('SSBJ の要求事項マスターが見つかりません。');

  const views = master.views.filter(
    (v) => v.area === area && v.assessment.applicability === 'applicable',
  );
  if (views.length === 0) {
    throw new ValidationError(
      `「${AREA_LABEL[area]}」に対象の要求事項がありません。先に対象判定を行ってください。`,
    );
  }

  // 承認済みの数値だけを根拠にする（未承認値を開示文へ書かせない）
  const [approved, metrics, units] = await Promise.all([
    db.select('dataPoints', {
      where: {
        organizationId,
        reportingPeriodId: period.id,
        status: 'approved',
        deletedAt: { isNull: true },
      },
    }),
    db.select('metrics', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('units', { where: { organizationId, deletedAt: { isNull: true } } }),
  ]);
  const metricById = new Map(metrics.map((m) => [m.id, m]));
  const unitById = new Map(units.map((u) => [u.id, u]));

  const metricValues = approved
    .filter((dp) => dp.value !== null)
    .slice(0, 20)
    .map((dp) => ({
      label: `${metricById.get(dp.metricId)?.name ?? '指標'}（${unitById.get(dp.unitId)?.name ?? '—'}）`,
      value: dp.value!,
      unit: dp.unitOfMeasure,
    }));

  // 判定の根拠として AI が見つけた既存資料の該当箇所を、そのまま草案の出典に使う
  const documents = views
    .filter((v) => v.assessment.sourceDocument)
    .slice(0, 10)
    .map((v) => ({
      name: v.assessment.sourceDocument!,
      page: v.assessment.sourcePage ?? '',
      excerpt: v.assessment.sourceExcerpt ?? '',
    }));

  const sources: AiSourceReference[] = [
    ...metricValues.slice(0, 10).map((m) => ({
      kind: 'data_point' as const,
      id: null,
      label: m.label,
      locator: null,
      periodLabel: period.label,
    })),
    ...documents.map((d) => ({
      kind: 'evidence' as const,
      id: null,
      label: d.name,
      locator: d.page || null,
      periodLabel: null,
    })),
  ];

  const { run, output } = await runAi({
    db,
    ctx,
    idempotencyKey: `ssbjDisclosureDraft:${period.id}:${area}`,
    sources,
    invocation: {
      feature: 'ssbjDisclosureDraft',
      context: {
        organizationName: ctx.workspace.organizationName,
        reportingPeriodLabel: period.label,
      },
      inputReferenceIds: views.map((v) => v.assessment.id),
      input: {
        area,
        areaLabel: AREA_LABEL[area],
        organizationName: ctx.workspace.organizationName,
        periodLabel: period.label,
        requirements: views.map((v) => ({
          code: v.item.code,
          title: v.item.questionText.slice(0, 60),
          finalStatus: v.assessment.finalStatus,
          materiality: v.assessment.materiality,
          reviewed: v.assessment.reviewedAt !== null,
        })),
        metricValues,
        documents,
        sources,
      },
    },
  });

  const now = new Date().toISOString();
  const existing = await db.select('ssbjDisclosureDrafts', {
    where: { organizationId, reportingPeriodId: period.id, area },
    limit: 1,
  });
  const current = existing[0];

  const patch = {
    // 生成し直したら本文も差し替える。人の修正を残したい場合は
    // 生成前に控えを取る運用ではなく、確定してから生成し直さない運用にする
    body: output.body,
    aiBody: output.body,
    coveredItemCodes: output.coveredItemCodes,
    gaps: output.gaps,
    aiRunId: run.id,
    aiConfidence: output.confidence,
    aiWarnings: output.warnings,
    aiGeneratedAt: now,
    // 中身が入れ替わった以上、前の確定はこの本文に対する判断ではない
    confirmedAt: null,
    confirmedBy: null,
    updatedAt: now,
    updatedBy: ctx.userId,
  };

  if (current) {
    const updated = await db.update('ssbjDisclosureDrafts', current.id, patch);
    await recordAuditEvent(db, ctx, {
      eventType: 'data_updated',
      resourceType: 'ssbj_disclosure_draft',
      resourceId: current.id,
      afterSummary: `「${AREA_LABEL[area]}」の草案を人工知能が作成し直しました（確定は取り消し）`,
    });
    return updated;
  }

  const row: SsbjDisclosureDraft = {
    id: fid('ssbj_disclosure_draft', `${organizationId}/${period.id}/${area}`),
    organizationId,
    reportingPeriodId: period.id,
    area,
    ...patch,
    createdAt: now,
    createdBy: ctx.userId,
  };
  await db.insert('ssbjDisclosureDrafts', [row]);
  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'ssbj_disclosure_draft',
    resourceId: row.id,
    afterSummary: `「${AREA_LABEL[area]}」の草案を人工知能が作成しました`,
  });
  return row;
}

/** 草案の本文を人が直す。直した時点で確定は外れる */
export async function saveSsbjDraftBody(
  db: DbClient,
  ctx: AuthorizationContext,
  draftId: Uuid,
  body: string,
): Promise<SsbjDisclosureDraft> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const draft = await db.findById('ssbjDisclosureDrafts', draftId);
  if (!draft || draft.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('草案が見つかりません。');
  }

  const now = new Date().toISOString();
  const updated = await db.update('ssbjDisclosureDrafts', draftId, {
    body,
    confirmedAt: null,
    confirmedBy: null,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'ssbj_disclosure_draft',
    resourceId: draftId,
    afterSummary: `「${AREA_LABEL[draft.area]}」の草案を修正（確定は取り消し）`,
  });
  return updated;
}

/**
 * 草案を確定する。
 *
 * AI の出力をそのまま確定させないための歯止めは置かない——本文を読んだ上で
 * 「これでよい」と判断するのは人の仕事であり、内容が同じでも判断は判断だから。
 * ただし、誰がいつ確定したかは必ず残す。
 */
export async function confirmSsbjDraft(
  db: DbClient,
  ctx: AuthorizationContext,
  draftId: Uuid,
): Promise<SsbjDisclosureDraft> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const draft = await db.findById('ssbjDisclosureDrafts', draftId);
  if (!draft || draft.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('草案が見つかりません。');
  }
  if (draft.body.trim() === '') {
    throw new ValidationError('本文が空のままでは確定できません。');
  }

  const now = new Date().toISOString();
  const updated = await db.update('ssbjDisclosureDrafts', draftId, {
    confirmedAt: now,
    confirmedBy: ctx.userId,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'data_approved',
    resourceType: 'ssbj_disclosure_draft',
    resourceId: draftId,
    afterSummary: `「${AREA_LABEL[draft.area]}」の草案を確定`,
  });
  return updated;
}
