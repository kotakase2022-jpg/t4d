import 'server-only';

import { recordAiDecision, runAi } from '@/lib/ai';
import { recordAuditEvent } from '@/lib/audit/logger';
import {
  consolidationFactor,
  isActualValue,
  isCountedInTotals,
  sumValues,
} from '@/lib/services/aggregation';
import { assertCan, AuthorizationError, can, NotFoundError } from '@/lib/authorization/can';
import { RETURN_REASON_MAX_LENGTH, RETURN_REASON_PREFIX } from '@/lib/domain/comment-limits';
import { ValidationError } from '@/lib/errors/user-facing';
import { statusLabel } from '@/lib/ui/status/registry';
import { contentHash, fid } from '@/lib/fixtures/ids';
import { addComment, assertValidCommentBody } from '@/lib/services/comments';
import {
  assertFrameworkAvailable,
  assertItemAvailable,
  evidenceEntriesForRow,
  frameworkKeyOfItem,
  listResponseAssignees,
  versionForPeriod,
} from '@/lib/services/disclosure';
import { RESPONSE_AUTHOR_APPROVAL_REASON } from '@/lib/ui/state-actions';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AiSourceReference,
  AuthorizationContext,
  DataPoint,
  DisclosureItem,
  DisclosureMapping,
  DisclosureResponse,
  DisclosureResponseVersion,
  FrameworkKey,
  ResponseContentLink,
  ResponseContentTargetKind,
  ResponseEvidenceLink,
  ResponseStatus,
  Uuid,
} from '@/types/domain';

/**
 * 開示回答の更新系（AI ドラフト生成 / 保存 / 状態遷移 / 担当 / 対応付け / 根拠）。
 *
 * Server Action からも Integration テストからも同じ経路を通すため、
 * 業務ロジックはここに置く（Action は入力の取り出しと revalidate だけを行う）。
 *
 * CDP の質問は組織に CDP 対応オプションの契約が無ければ書けない（トライアル対応 NF-38）。
 * 回答画面は CDP と CSRD で共用なので、**項目の基準**で判定する（assertItemAvailable）。
 */

/** 回答を持つ基準（SSBJ は節ごとの開示ドラフトで書き、要求事項ごとの回答を持たない） */
const RESPONSE_FRAMEWORKS: readonly FrameworkKey[] = ['cdp', 'csrd'];

/** 回答の AI 草案に渡す T4D の情報の上限（Prompt を際限なく大きくしない） */
const DRAFT_INPUT_LIMITS = { narratives: 5, blocks: 5, anchors: 10, requirements: 10, text: 1500 };

export interface GenerateDraftResult {
  aiRunId: Uuid;
  version: DisclosureResponseVersion;
  provider: 'openai' | 'mock';
  confidence: number;
  missingInformation: string[];
}

function clip(text: string, max = DRAFT_INPUT_LIMITS.text): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function ownedResponse(
  db: DbClient,
  ctx: AuthorizationContext,
  responseId: Uuid,
): Promise<DisclosureResponse> {
  const response = responseId ? await db.findById('disclosureResponses', responseId) : null;
  if (!response || response.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('回答が見つかりません。');
  }
  return response;
}

async function itemOf(db: DbClient, itemId: Uuid): Promise<DisclosureItem> {
  const item = itemId ? await db.findById('disclosureItems', itemId) : null;
  if (!item) throw new NotFoundError('質問が見つかりません。');
  return item;
}

// ----------------------------------------------------------------------
// AI の回答草案（NF-41: 対応付けた定性情報・承認済みの原稿・根拠の引用位置を入力に足す）
// ----------------------------------------------------------------------

interface DraftContent {
  narratives: Array<{ title: string; versionNo: number; periodLabel: string | null; body: string }>;
  approvedBlocks: Array<{ title: string; versionNo: number; text: string }>;
  requirements: Array<{ code: string; title: string }>;
  evidenceQuotes: Array<{ label: string; locator: string | null; quote: string }>;
  sources: AiSourceReference[];
  referenceIds: Uuid[];
}

/**
 * 回答に対応付けた T4D の情報（人が確定したものだけ）から、AI に渡す材料を作る。
 *  - 定性情報は確認済みの版、原稿は承認済みの版だけ（下書きを根拠にさせない）
 *  - 資料の引用位置は、資料の閲覧権限がある人の実行で、同じ組織の削除されていない資料だけ
 *    （権限外の資料の文言を Prompt に入れない。取得時に止める）
 */
async function draftContentFor(
  db: DbClient,
  ctx: AuthorizationContext,
  item: DisclosureItem,
): Promise<DraftContent> {
  const organizationId = ctx.workspace.organizationId;
  const out: DraftContent = {
    narratives: [],
    approvedBlocks: [],
    requirements: [],
    evidenceQuotes: [],
    sources: [],
    referenceIds: [],
  };
  const links = await db.select('responseContentLinks', {
    where: { organizationId, itemId: item.id, deletedAt: { isNull: true } },
    orderBy: { column: 'confirmedAt' },
  });
  const periods = await db.select('periods', { where: { organizationId } });
  const periodById = new Map(periods.map((p) => [p.id, p]));
  const anchorIds: Uuid[] = [];

  for (const link of links) {
    if (
      link.targetKind === 'narrative_record' &&
      out.narratives.length < DRAFT_INPUT_LIMITS.narratives
    ) {
      const record = await db.findById('narrativeRecords', link.targetId);
      if (!record || record.organizationId !== organizationId || record.deletedAt) continue;
      const version = record.confirmedVersionId
        ? await db.findById('narrativeVersions', record.confirmedVersionId)
        : null;
      if (!version || version.organizationId !== organizationId) continue;
      const period = periodById.get(version.reportingPeriodId);
      out.narratives.push({
        title: record.title,
        versionNo: version.versionNo,
        periodLabel: period?.label ?? null,
        body: clip(version.body),
      });
      out.sources.push({
        kind: 'narrative_version',
        id: version.id,
        label: `${record.title}（確認済みの版 ${version.versionNo}）`,
        locator: null,
        periodLabel: period?.code ?? null,
      });
      out.referenceIds.push(version.id);
      anchorIds.push(...version.sourceAnchorIds);
    } else if (
      link.targetKind === 'disclosure_block' &&
      out.approvedBlocks.length < DRAFT_INPUT_LIMITS.blocks
    ) {
      const block = await db.findById('disclosureBlocks', link.targetId);
      if (!block || block.organizationId !== organizationId || block.deletedAt) continue;
      const version = block.approvedVersionId
        ? await db.findById('disclosureBlockVersions', block.approvedVersionId)
        : null;
      if (!version || version.organizationId !== organizationId) continue;
      out.approvedBlocks.push({
        title: block.title,
        versionNo: version.versionNo,
        text: clip(version.plainText),
      });
      out.sources.push({
        kind: 'prior_block',
        id: version.id,
        label: `承認済みの原稿「${block.title}」（版 ${version.versionNo}）`,
        locator: null,
        periodLabel: null,
      });
      out.referenceIds.push(version.id);
      anchorIds.push(...version.anchorRefs);
    } else if (
      link.targetKind === 'requirement_item' &&
      out.requirements.length < DRAFT_INPUT_LIMITS.requirements
    ) {
      const requirement = await db.findById('disclosureItems', link.targetId);
      if (!requirement) continue;
      out.requirements.push({ code: requirement.code, title: requirement.questionText });
      out.sources.push({
        kind: 'requirement',
        id: requirement.id,
        label: `SSBJ ${requirement.code}`,
        locator: null,
        periodLabel: null,
      });
    }
  }

  if (anchorIds.length > 0 && can(ctx, 'enterprise.evidence.read')) {
    for (const anchorId of [...new Set(anchorIds)]) {
      if (out.evidenceQuotes.length >= DRAFT_INPUT_LIMITS.anchors) break;
      const anchor = await db.findById('sourceAnchors', anchorId);
      if (!anchor || anchor.organizationId !== organizationId) continue;
      const fileVersion = await db.findById('fileVersions', anchor.fileVersionId);
      const file = fileVersion ? await db.findById('files', fileVersion.fileId) : null;
      if (!file || file.organizationId !== organizationId || file.deletedAt) continue;
      const label = `${file.originalName}${anchor.locator ? ` ${anchor.locator}` : ''}`;
      out.evidenceQuotes.push({ label, locator: anchor.locator, quote: clip(anchor.quoteText) });
      out.sources.push({
        kind: 'source_anchor',
        id: anchor.id,
        label,
        locator: anchor.locator,
        periodLabel: null,
      });
      out.referenceIds.push(anchor.id);
    }
  }
  return out;
}

/**
 * 承認済みデータ・前年回答と、対応付けた定性情報（確認済みの版）・承認済みの原稿・根拠の引用位置を
 * 根拠に AI 下書きを生成し、`draft` バージョンとして保存する。**承認はしない**（AI 自動確定の禁止）。
 */
export async function generateDisclosureDraft(
  db: DbClient,
  ctx: AuthorizationContext,
  responseId: Uuid,
): Promise<GenerateDraftResult> {
  assertCan(ctx, 'enterprise.ai.run');

  const response = await ownedResponse(db, ctx, responseId);
  const item = await itemOf(db, response.itemId);
  await assertItemAvailable(db, ctx, item);

  const period = await db.findById('periods', response.reportingPeriodId);
  const mappings = await db.select('disclosureMappings', {
    where: {
      organizationId: response.organizationId,
      itemId: item.id,
      confirmedAt: { isNull: false },
    },
  });

  const metricValues: Array<{ label: string; value: number; unit: string; periodLabel: string }> =
    [];
  const sources: AiSourceReference[] = [];
  const units = await db.select('units', { where: { organizationId: response.organizationId } });
  const unitById = new Map(units.map((u) => [u.id, u]));
  // 連結値と同じ係数（持分法・対象外の組織は 0、比例連結は持分割合）で足す
  const factorOf = (dp: DataPoint) => {
    const unit = unitById.get(dp.unitId);
    return unit ? consolidationFactor(unit) : 1;
  };

  for (const mapping of mappings) {
    const metric = await db.findById('metrics', mapping.metricId);
    if (!metric) continue;
    // 承認済みの値だけを AI へ渡す（未承認値を根拠にさせない）
    const dataPoints = await db.select('dataPoints', {
      where: {
        organizationId: response.organizationId,
        metricId: mapping.metricId,
        reportingPeriodId: response.reportingPeriodId,
        status: 'approved',
        deletedAt: { isNull: true },
      },
    });
    // 実績の値がある行だけを足す。値の無い行（未入力・対象外など）を 0 として、目標・推計を実績として
    // AI に渡さない（SSBJ ギャップ分析の W0 O4 と同じ規則）。足せる行が無ければ根拠にしない
    const counted = dataPoints.filter(
      (dp) => isCountedInTotals(dp) && isActualValue(dp) && factorOf(dp) > 0,
    );
    const { total } = sumValues(counted, 'actual', factorOf);
    if (total === null) continue;
    metricValues.push({
      label: metric.name,
      value: Math.round(total * 100) / 100,
      unit: metric.unit,
      periodLabel: period?.label ?? '',
    });
    for (const dp of counted) {
      sources.push({
        kind: 'data_point',
        id: dp.id,
        label: `${metric.name}（承認済み）`,
        locator: null,
        periodLabel: period?.code ?? null,
      });
    }
  }

  const previous = response.previousResponseId
    ? await db.findById('disclosureResponses', response.previousResponseId)
    : null;
  if (previous && previous.organizationId === response.organizationId) {
    sources.push({
      kind: 'previous_response',
      id: previous.id,
      label: `前年度回答 ${item.code}`,
      locator: null,
      periodLabel: null,
    });
  }
  const previousAnswer =
    previous && previous.organizationId === response.organizationId ? previous : null;

  const content = await draftContentFor(db, ctx, item);
  sources.push(...content.sources);

  const { run, output } = await runAi({
    db,
    ctx,
    idempotencyKey: `cdpDraft:${responseId}:${Date.now()}`,
    sources,
    invocation: {
      feature: 'cdpDraftGeneration',
      context: {
        organizationName: ctx.workspace.organizationName,
        reportingPeriodLabel: period?.label ?? '',
      },
      // 先頭は回答 ID（一覧の「不足」が直近の草案を回答ごとに引く）
      inputReferenceIds: [responseId, item.id, ...content.referenceIds],
      input: {
        itemCode: item.code,
        questionText: item.questionText,
        guidance: item.guidance,
        answerType: item.answerType,
        options: item.options,
        previousAnswer: previousAnswer?.answerText ?? null,
        previousNumeric: previousAnswer?.answerNumeric ?? null,
        metricValues,
        // 人が回答に対応付けた T4D の情報（確認済み・承認済みの版だけ）
        narratives: content.narratives,
        approvedBlocks: content.approvedBlocks,
        requirements: content.requirements,
        evidenceQuotes: content.evidenceQuotes,
      },
    },
  });

  const version = await appendResponseVersion(db, ctx, {
    responseId,
    organizationId: response.organizationId,
    answerText: output.draftText,
    answerNumeric: output.draftNumeric,
    answerChoice: output.draftChoice,
    originatedFromAiRunId: run.id,
    changeReason: output.changeSummary,
  });

  return {
    aiRunId: run.id,
    version,
    provider: run.provider,
    confidence: run.confidence,
    missingInformation: output.missingInformation,
  };
}

interface AppendVersionInput {
  responseId: Uuid;
  organizationId: Uuid;
  answerText: string | null;
  answerNumeric: number | null;
  answerChoice: string[];
  originatedFromAiRunId: Uuid | null;
  changeReason: string | null;
  carryForwardDecision?: 'reuse' | 'update' | 'new' | null;
}

async function appendResponseVersion(
  db: DbClient,
  ctx: AuthorizationContext,
  input: AppendVersionInput,
): Promise<DisclosureResponseVersion> {
  const now = new Date().toISOString();
  const existing = await db.select('disclosureResponseVersions', {
    where: { responseId: input.responseId },
    orderBy: { column: 'versionNo', dir: 'desc' },
    limit: 1,
  });
  const versionNo = (existing[0]?.versionNo ?? 0) + 1;

  const version: DisclosureResponseVersion = {
    id: fid('disclosure_response_version', `${input.responseId}/v${versionNo}`),
    responseId: input.responseId,
    organizationId: input.organizationId,
    versionNo,
    answerText: input.answerText,
    answerNumeric: input.answerNumeric,
    answerChoice: input.answerChoice,
    status: 'draft',
    originatedFromAiRunId: input.originatedFromAiRunId,
    changeReason: input.changeReason,
    contentHash: contentHash(`${input.responseId}|${versionNo}|${input.answerText ?? ''}`),
    createdAt: now,
    createdBy: ctx.userId,
  };

  await db.insert('disclosureResponseVersions', [version]);
  await db.update('disclosureResponses', input.responseId, {
    status: 'draft',
    currentVersionId: version.id,
    answerText: input.answerText,
    answerNumeric: input.answerNumeric,
    answerChoice: input.answerChoice,
    ...(input.carryForwardDecision !== undefined
      ? { carryForwardDecision: input.carryForwardDecision }
      : {}),
    updatedAt: now,
    updatedBy: ctx.userId,
  });

  return version;
}

export interface SaveResponseInput {
  responseId: Uuid;
  answerText: string | null;
  answerNumeric: number | null;
  answerChoice: string[];
  aiRunId: Uuid | null;
  editedFromAi: boolean;
  carryForwardDecision?: 'reuse' | 'update' | 'new' | null;
}

/**
 * 人が編集した回答を保存する。
 * 保存時点で AI 由来フラグを外す（＝人が内容を確認したことを意味する）。
 */
export async function saveDisclosureResponse(
  db: DbClient,
  ctx: AuthorizationContext,
  input: SaveResponseInput,
): Promise<DisclosureResponseVersion> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const response = await ownedResponse(db, ctx, input.responseId);
  await assertItemAvailable(db, ctx, await itemOf(db, response.itemId));

  const version = await appendResponseVersion(db, ctx, {
    responseId: input.responseId,
    organizationId: response.organizationId,
    answerText: input.answerText,
    answerNumeric: input.answerNumeric,
    answerChoice: input.answerChoice,
    originatedFromAiRunId: null,
    changeReason: input.editedFromAi ? 'AI 下書きを人が編集' : '画面からの編集',
    carryForwardDecision: input.carryForwardDecision ?? null,
  });

  if (input.aiRunId) {
    await recordAiDecision(
      db,
      ctx,
      input.aiRunId,
      input.editedFromAi ? 'edited_accepted' : 'accepted',
      null,
    );
  }

  return version;
}

/**
 * 開示回答の状態遷移。
 * **AI が生成したままの版は承認できない**（指示書 14 章 / DoD 19）。
 * Supabase Mode では DB トリガ `forbid_ai_auto_approval` でも二重に禁止している。
 *
 * **現在の版を作った人は承認できない**（職務分離。NF-39 C-07。CDP・CSRD の回答で共通）。
 * Supabase Mode では DB トリガ `disclosure_response_approval_sod`（0057）でも禁止している。
 */
export async function transitionDisclosureResponse(
  db: DbClient,
  ctx: AuthorizationContext,
  responseId: Uuid,
  to: ResponseStatus,
): Promise<DisclosureResponse> {
  const response = await ownedResponse(db, ctx, responseId);

  if (to === 'approved') {
    assertCan(ctx, 'enterprise.disclosure.approve');
    const current = response.currentVersionId
      ? await db.findById('disclosureResponseVersions', response.currentVersionId)
      : null;
    if (!current) {
      throw new AuthorizationError('回答が作成されていません。');
    }
    if (current.originatedFromAiRunId) {
      throw new AuthorizationError(
        'AI が生成したままの回答は承認できません。内容を確認し、編集して保存してから承認してください。',
      );
    }
    if (current.createdBy === ctx.userId) {
      throw new AuthorizationError(RESPONSE_AUTHOR_APPROVAL_REASON);
    }
  } else {
    assertCan(ctx, 'enterprise.disclosure.write');
  }
  await assertItemAvailable(db, ctx, await itemOf(db, response.itemId));

  const now = new Date().toISOString();
  const updated = await db.update('disclosureResponses', responseId, {
    status: to,
    approvedAt: to === 'approved' ? now : null,
    approvedBy: to === 'approved' ? ctx.userId : null,
    updatedAt: now,
    updatedBy: ctx.userId,
  });

  await recordAuditEvent(db, ctx, {
    eventType: to === 'approved' ? 'data_approved' : 'data_updated',
    resourceType: 'disclosure_response',
    resourceId: responseId,
    beforeSummary: `状態「${statusLabel('response', response.status)}」`,
    afterSummary: `状態「${statusLabel('response', to)}」`,
  });

  return updated;
}

/**
 * 回答の差戻し（理由必須）。状態を「差戻し」にし、理由をこの回答のコメントとして残す。
 *
 * 以前は画面が状態遷移とコメントの追加を別々の Server Action で順に呼んでいたため、
 * 2 つ目（コメント）が失敗すると（理由が長すぎる・通信の切断など）、回答は差戻しなのに理由が
 * どこにも残らなかった。理由の検証と権限の確認を**状態を書き換える前**に済ませ、1 つの操作にする。
 *
 * @param href コメントのメンション通知の遷移先（この回答の画面。呼び出し側がサーバーで組み立てる）
 */
export async function returnDisclosureResponse(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { responseId: Uuid; reason: string; href: string },
): Promise<DisclosureResponse> {
  const reason = input.reason.trim();
  if (!reason) throw new ValidationError('差戻し理由を入力してください。');
  if (reason.length > RETURN_REASON_MAX_LENGTH) {
    throw new ValidationError(
      `差戻し理由は ${RETURN_REASON_MAX_LENGTH} 文字以内で入力してください。`,
    );
  }
  const body = assertValidCommentBody(`${RETURN_REASON_PREFIX}${reason}`);
  // コメントの追加が求める権限（開示の閲覧）も先に確かめる。遷移のあとで断られると理由が残らない
  assertCan(ctx, 'enterprise.disclosure.read');

  const updated = await transitionDisclosureResponse(db, ctx, input.responseId, 'returned');
  await addComment(db, ctx, {
    targetType: 'disclosure_response',
    targetId: input.responseId,
    body,
    href: input.href,
  });
  return updated;
}

// ----------------------------------------------------------------------
// 回答の開始（NF-39 C-02）。読込では作らず、最初の保存・AI 草案・担当の割当の時に作る
// ----------------------------------------------------------------------

/** 前の期間で、同じ基準の同じ質問（改番なら前の版の項番）への回答 */
async function previousResponseFor(
  db: DbClient,
  organizationId: Uuid,
  item: DisclosureItem,
  frameworkKey: FrameworkKey,
  periodStart: string,
): Promise<DisclosureResponse | null> {
  const periods = await db.select('periods', { where: { organizationId } });
  const previousPeriod = periods
    .filter((p) => p.startDate < periodStart)
    .sort((a, b) => (a.startDate < b.startDate ? 1 : -1))[0];
  if (!previousPeriod) return null;
  const responses = await db.select('disclosureResponses', {
    where: { organizationId, reportingPeriodId: previousPeriod.id },
  });
  const code = item.previousItemCode ?? item.code;
  for (const candidate of responses) {
    const previousItem = await db.findById('disclosureItems', candidate.itemId);
    if (!previousItem || previousItem.code !== code) continue;
    if ((await frameworkKeyOfItem(db, previousItem)) === frameworkKey) return candidate;
  }
  return null;
}

/**
 * 質問への回答の行を返す（無ければ作る）。新しい年度の質問に回答の行が無いと画面から回答を
 * 始められなかった（以前は Fixture が事前に作っていた）。作るのは書く操作の中だけ
 */
export async function ensureDisclosureResponse(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { itemId: Uuid; periodId: Uuid },
): Promise<DisclosureResponse> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const organizationId = ctx.workspace.organizationId;
  const period = input.periodId ? await db.findById('periods', input.periodId) : null;
  if (!period || period.organizationId !== organizationId) {
    throw new NotFoundError('報告期間が見つかりません。');
  }
  const item = await itemOf(db, input.itemId);
  const frameworkKey = await frameworkKeyOfItem(db, item);
  if (!frameworkKey) throw new NotFoundError('質問が見つかりません。');
  if (!RESPONSE_FRAMEWORKS.includes(frameworkKey)) {
    throw new ValidationError('この基準は質問ごとの回答を持ちません（節ごとの本文で作成します）。');
  }
  await assertFrameworkAvailable(db, ctx, frameworkKey);

  const existing = await db.select('disclosureResponses', {
    where: { organizationId, itemId: item.id, reportingPeriodId: period.id },
    limit: 1,
  });
  if (existing[0]) return existing[0];

  // 新しく始める回答は、期間に対応する版の質問に限る（過年度の版の質問へ当年度の回答を作らない。C-09）
  const version = await db.findById('frameworkVersions', item.frameworkVersionId);
  const versions = version
    ? await db.select('frameworkVersions', { where: { frameworkId: version.frameworkId } })
    : [];
  const periodVersion = versionForPeriod(versions, period);
  if (!periodVersion || periodVersion.id !== item.frameworkVersionId) {
    throw new ValidationError(
      `この質問は ${period.label} の質問書（${periodVersion?.label ?? '期間の版'}）に含まれないため、回答を始められません。`,
    );
  }

  const previous = await previousResponseFor(
    db,
    organizationId,
    item,
    frameworkKey,
    period.startDate,
  );
  const now = new Date().toISOString();
  const response: DisclosureResponse = {
    id: fid('disclosure_response', `${organizationId}/${item.id}/${period.id}`),
    organizationId,
    itemId: item.id,
    reportingPeriodId: period.id,
    status: 'not_started',
    currentVersionId: null,
    answerText: null,
    answerNumeric: null,
    answerChoice: [],
    ownerUserId: null,
    reviewerUserId: null,
    approvedAt: null,
    approvedBy: null,
    previousResponseId: previous?.id ?? null,
    carryForwardDecision: null,
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  };
  await db.insert('disclosureResponses', [response]);
  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'disclosure_response',
    resourceId: response.id,
    afterSummary: `回答を開始: ${item.code}（${period.code}）`,
  });
  return response;
}

/** 回答の行を作ってから保存する（回答の行が無い質問の最初の保存） */
export async function startDisclosureResponse(
  db: DbClient,
  ctx: AuthorizationContext,
  input: Omit<SaveResponseInput, 'responseId'> & { itemId: Uuid; periodId: Uuid },
): Promise<DisclosureResponseVersion> {
  const response = await ensureDisclosureResponse(db, ctx, input);
  return saveDisclosureResponse(db, ctx, { ...input, responseId: response.id });
}

/** 回答の行を作ってから AI 草案を作る（回答の行が無い質問の最初の AI 草案） */
export async function startDisclosureDraft(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { itemId: Uuid; periodId: Uuid },
): Promise<GenerateDraftResult> {
  // 権限が無い人の操作で回答の行だけが残らないよう、AI の実行権限を先に確かめる
  assertCan(ctx, 'enterprise.ai.run');
  const response = await ensureDisclosureResponse(db, ctx, input);
  return generateDisclosureDraft(db, ctx, response.id);
}

// ----------------------------------------------------------------------
// 担当（NF-39 C-01）
// ----------------------------------------------------------------------

/** 一度に割り当てられる回答の数（一括の上限） */
export const ASSIGN_MAX = 200;

export interface AssignInput {
  /** undefined は変更しない、null は担当を外す */
  ownerUserId?: Uuid | null;
  reviewerUserId?: Uuid | null;
}

/**
 * 回答の作成担当・レビュー担当を割り当てる（既存の列 owner_user_id・reviewer_user_id）。
 * 担当に選べるのは組織の有効なメンバーで、作成担当は開示の編集、レビュー担当は編集か承認ができる人。
 * 作成担当とレビュー担当を同じ人にしない。すべて検査してから書く（途中まで書いて止めない）
 */
export async function assignDisclosureResponses(
  db: DbClient,
  ctx: AuthorizationContext,
  input: AssignInput & { responseIds: Uuid[] },
): Promise<DisclosureResponse[]> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const responseIds = [...new Set(input.responseIds.filter(Boolean))];
  if (responseIds.length === 0) throw new ValidationError('回答を 1 件以上選んでください。');
  if (responseIds.length > ASSIGN_MAX) {
    throw new ValidationError(`一度に割り当てられるのは ${ASSIGN_MAX} 件までです。`);
  }
  if (input.ownerUserId === undefined && input.reviewerUserId === undefined) {
    throw new ValidationError('作成担当かレビュー担当を選んでください。');
  }

  const assignees = await listResponseAssignees(db, ctx);
  if (input.ownerUserId && !assignees.owners.some((m) => m.userId === input.ownerUserId)) {
    throw new ValidationError('作成担当には、開示を編集できる組織のメンバーを選んでください。');
  }
  if (input.reviewerUserId && !assignees.reviewers.some((m) => m.userId === input.reviewerUserId)) {
    throw new ValidationError(
      'レビュー担当には、開示を編集または承認できる組織のメンバーを選んでください。',
    );
  }

  const responses: DisclosureResponse[] = [];
  const checkedVersions = new Set<Uuid>();
  for (const id of responseIds) {
    const response = await ownedResponse(db, ctx, id);
    const item = await itemOf(db, response.itemId);
    if (!checkedVersions.has(item.frameworkVersionId)) {
      await assertItemAvailable(db, ctx, item);
      checkedVersions.add(item.frameworkVersionId);
    }
    const owner = input.ownerUserId !== undefined ? input.ownerUserId : response.ownerUserId;
    const reviewer =
      input.reviewerUserId !== undefined ? input.reviewerUserId : response.reviewerUserId;
    if (owner && reviewer && owner === reviewer) {
      throw new ValidationError('作成担当とレビュー担当は別の人にしてください。');
    }
    responses.push(response);
  }

  const now = new Date().toISOString();
  const updated: DisclosureResponse[] = [];
  for (const response of responses) {
    const patch: Partial<DisclosureResponse> = { updatedAt: now, updatedBy: ctx.userId };
    if (input.ownerUserId !== undefined) patch.ownerUserId = input.ownerUserId;
    if (input.reviewerUserId !== undefined) patch.reviewerUserId = input.reviewerUserId;
    updated.push(await db.update('disclosureResponses', response.id, patch));
  }
  const nameOf = (id: Uuid | null | undefined) =>
    id ? (assignees.nameById.get(id) ?? '—') : '未割当';
  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'disclosure_response',
    resourceId: responses.length === 1 ? (responses[0]?.id ?? null) : null,
    afterSummary: [
      `担当を割当: ${responses.length} 件`,
      input.ownerUserId !== undefined ? `作成担当=${nameOf(input.ownerUserId)}` : null,
      input.reviewerUserId !== undefined ? `レビュー担当=${nameOf(input.reviewerUserId)}` : null,
    ]
      .filter(Boolean)
      .join('・'),
  });
  return updated;
}

/** 質問を選んで担当を割り当てる（回答の行が無い質問は行を作ってから。一覧の一括割当） */
export async function assignDisclosureItems(
  db: DbClient,
  ctx: AuthorizationContext,
  input: AssignInput & { periodId: Uuid; itemIds: Uuid[] },
): Promise<DisclosureResponse[]> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const itemIds = [...new Set(input.itemIds.filter(Boolean))];
  if (itemIds.length === 0) throw new ValidationError('質問を 1 件以上選んでください。');
  if (itemIds.length > ASSIGN_MAX) {
    throw new ValidationError(`一度に割り当てられるのは ${ASSIGN_MAX} 件までです。`);
  }
  const responseIds: Uuid[] = [];
  for (const itemId of itemIds) {
    responseIds.push(
      (await ensureDisclosureResponse(db, ctx, { itemId, periodId: input.periodId })).id,
    );
  }
  return assignDisclosureResponses(db, ctx, { ...input, responseIds });
}

// ----------------------------------------------------------------------
// 指標の対応付け（NF-39 C-03・不具合 B-3）。確定は人。外すときは確定を外す（行は残る）
// ----------------------------------------------------------------------

/**
 * 指標の対応付けを変えられる基準。CSRD・SSBJ の対応付けはそれぞれの画面・マスターの扱い
 * （T8・Fixture）で、ここからは変えない
 */
async function assertMappingEditable(
  db: DbClient,
  ctx: AuthorizationContext,
  item: DisclosureItem,
): Promise<void> {
  const key = await frameworkKeyOfItem(db, item);
  if (key !== 'cdp') {
    throw new ValidationError('この基準の指標の対応付けは、この画面では変更できません。');
  }
  await assertFrameworkAvailable(db, ctx, key);
}

async function upsertMapping(
  db: DbClient,
  ctx: AuthorizationContext,
  item: DisclosureItem,
  metricId: Uuid,
  source: { mappingSource: DisclosureMapping['mappingSource']; aiRunId: Uuid | null },
): Promise<DisclosureMapping> {
  const organizationId = ctx.workspace.organizationId;
  const metric = await db.findById('metrics', metricId);
  if (!metric || metric.organizationId !== organizationId || metric.deletedAt) {
    throw new NotFoundError('指標が見つかりません。');
  }
  const now = new Date().toISOString();
  // 1 組織 × 質問 × 指標（組織単位なし）で 1 行（DB の一意制約）。確定を外した行があれば確定し直す
  const existing = (
    await db.select('disclosureMappings', {
      where: { organizationId, itemId: item.id, metricId: metric.id, unitId: { isNull: true } },
      limit: 1,
    })
  )[0];
  let mapping: DisclosureMapping;
  if (existing) {
    if (existing.confirmedAt) throw new ValidationError('この指標は既に対応付けています。');
    mapping = await db.update('disclosureMappings', existing.id, {
      mappingSource: source.mappingSource,
      aiRunId: source.aiRunId,
      confirmedBy: ctx.userId,
      confirmedAt: now,
      updatedAt: now,
      updatedBy: ctx.userId,
    });
  } else {
    mapping = {
      id: fid('disclosure_mapping', `${organizationId}/${item.id}/${metric.id}`),
      organizationId,
      itemId: item.id,
      metricId: metric.id,
      unitId: null,
      transform: null,
      mappingSource: source.mappingSource,
      aiRunId: source.aiRunId,
      confirmedBy: ctx.userId,
      confirmedAt: now,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    };
    await db.insert('disclosureMappings', [mapping]);
  }
  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'disclosure_mapping',
    resourceId: mapping.id,
    afterSummary: `${item.code} ↔ ${metric.name}（${
      source.mappingSource === 'ai_suggested' ? 'AI の候補を確定' : '手動'
    }）`,
  });
  return mapping;
}

/**
 * AI の質問マッピングの候補を 1 件確定する。候補に無い組み合わせは受け付けない（AI の出力の外の
 * 対応付けをこの経路で作らせない）。確定は人の操作で、AI の実行の採否とは別に記録する
 */
export async function confirmQuestionMappingCandidate(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { aiRunId: Uuid; itemCode: string; metricCode: string },
): Promise<DisclosureMapping> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const organizationId = ctx.workspace.organizationId;
  const run = input.aiRunId ? await db.findById('aiRuns', input.aiRunId) : null;
  if (!run || run.organizationId !== organizationId || run.featureType !== 'cdpQuestionMapping') {
    throw new NotFoundError('AI の候補が見つかりません。');
  }
  const candidates = Array.isArray(run.outputJson.mappings)
    ? (run.outputJson.mappings as Array<{ itemCode?: unknown; metricCode?: unknown }>)
    : [];
  if (
    !input.metricCode ||
    !candidates.some((c) => c.itemCode === input.itemCode && c.metricCode === input.metricCode)
  ) {
    throw new ValidationError('この組み合わせは AI の候補にありません。');
  }
  // 候補の対象は、その実行に渡した質問（inputReferenceIds）に限る
  let item: DisclosureItem | null = null;
  for (const id of run.inputReferenceIds) {
    const candidate = await db.findById('disclosureItems', id);
    if (candidate?.code === input.itemCode) {
      item = candidate;
      break;
    }
  }
  if (!item) throw new NotFoundError('質問が見つかりません。');
  await assertMappingEditable(db, ctx, item);
  const metric = (
    await db.select('metrics', {
      where: { organizationId, code: input.metricCode, deletedAt: { isNull: true } },
      limit: 1,
    })
  )[0];
  if (!metric) throw new NotFoundError('指標が見つかりません。');
  return upsertMapping(db, ctx, item, metric.id, {
    mappingSource: 'ai_suggested',
    aiRunId: run.id,
  });
}

/** 指標を手動で対応付ける */
export async function addDisclosureMapping(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { itemId: Uuid; metricId: Uuid },
): Promise<DisclosureMapping> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const item = await itemOf(db, input.itemId);
  await assertMappingEditable(db, ctx, item);
  return upsertMapping(db, ctx, item, input.metricId, { mappingSource: 'manual', aiRunId: null });
}

/**
 * 指標の対応付けを外す。行は消さずに確定を外す（物理削除をしない。外した後は一覧・AI の材料に使わない）
 */
export async function removeDisclosureMapping(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { mappingId: Uuid },
): Promise<DisclosureMapping> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const mapping = input.mappingId ? await db.findById('disclosureMappings', input.mappingId) : null;
  if (!mapping || mapping.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('対応付けが見つかりません。');
  }
  if (!mapping.confirmedAt) throw new ValidationError('この対応付けは既に外れています。');
  const item = await itemOf(db, mapping.itemId);
  await assertMappingEditable(db, ctx, item);
  const now = new Date().toISOString();
  const updated = await db.update('disclosureMappings', mapping.id, {
    confirmedBy: null,
    confirmedAt: null,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  const metric = await db.findById('metrics', mapping.metricId);
  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'disclosure_mapping',
    resourceId: mapping.id,
    afterSummary: `${item.code} ↔ ${metric?.name ?? '指標'} の対応付けを外した`,
  });
  return updated;
}

// ----------------------------------------------------------------------
// 回答と T4D の情報の対応付け（NF-39 C-03。0057 response_content_links）
// ----------------------------------------------------------------------

const CONTENT_LABEL: Record<ResponseContentTargetKind, string> = {
  narrative_record: '定性情報',
  disclosure_block: '原稿の節',
  requirement_item: 'SSBJ の要求事項',
};

/**
 * 回答（組織 × 質問）と、確認済みの定性情報・承認済みの原稿の節・SSBJ の要求事項を対応付ける。
 * 下書きの定性情報・未承認の原稿は対応付けない（AI の材料・保証側の確認に使うのは確定した版だけ）
 */
export async function addResponseContentLink(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { itemId: Uuid; targetKind: ResponseContentTargetKind; targetId: Uuid },
): Promise<ResponseContentLink> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const organizationId = ctx.workspace.organizationId;
  const item = await itemOf(db, input.itemId);
  const frameworkKey = await frameworkKeyOfItem(db, item);
  if (!frameworkKey || !RESPONSE_FRAMEWORKS.includes(frameworkKey)) {
    throw new ValidationError('この基準の項目には T4D の情報を対応付けられません。');
  }
  await assertFrameworkAvailable(db, ctx, frameworkKey);

  let label: string;
  switch (input.targetKind) {
    case 'narrative_record': {
      const record = input.targetId ? await db.findById('narrativeRecords', input.targetId) : null;
      if (!record || record.organizationId !== organizationId || record.deletedAt) {
        throw new NotFoundError('定性情報が見つかりません。');
      }
      if (!record.confirmedVersionId) {
        throw new ValidationError('確認済みの版がある定性情報だけを対応付けられます。');
      }
      label = record.title;
      break;
    }
    case 'disclosure_block': {
      const block = input.targetId ? await db.findById('disclosureBlocks', input.targetId) : null;
      if (!block || block.organizationId !== organizationId || block.deletedAt) {
        throw new NotFoundError('原稿の節が見つかりません。');
      }
      if (!block.approvedVersionId) {
        throw new ValidationError('承認済みの原稿の節だけを対応付けられます。');
      }
      label = block.title;
      break;
    }
    case 'requirement_item': {
      const requirement = input.targetId
        ? await db.findById('disclosureItems', input.targetId)
        : null;
      if (!requirement || (await frameworkKeyOfItem(db, requirement)) !== 'ssbj') {
        throw new NotFoundError('SSBJ の要求事項が見つかりません。');
      }
      label = requirement.code;
      break;
    }
    default:
      throw new ValidationError('対応付ける情報の種類が正しくありません。');
  }

  const duplicate = await db.select('responseContentLinks', {
    where: {
      organizationId,
      itemId: item.id,
      targetKind: input.targetKind,
      targetId: input.targetId,
      deletedAt: { isNull: true },
    },
    limit: 1,
  });
  if (duplicate[0]) throw new ValidationError('この情報は既に対応付けています。');

  const now = new Date().toISOString();
  const link: ResponseContentLink = {
    id: fid(
      'response_content_link',
      `${organizationId}/${item.id}/${input.targetKind}/${input.targetId}/${now}`,
    ),
    organizationId,
    itemId: item.id,
    targetKind: input.targetKind,
    targetId: input.targetId,
    linkSource: 'manual',
    aiRunId: null,
    confirmedBy: ctx.userId,
    confirmedAt: now,
    deletedAt: null,
    deletedBy: null,
  };
  await db.insert('responseContentLinks', [link]);
  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'response_content_link',
    resourceId: link.id,
    afterSummary: `${item.code} ↔ ${CONTENT_LABEL[input.targetKind]}「${label}」`,
  });
  return link;
}

/** 対応付けを外す（deleted_at・deleted_by を入れる。物理削除しない） */
export async function removeResponseContentLink(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { linkId: Uuid },
): Promise<ResponseContentLink> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const link = input.linkId ? await db.findById('responseContentLinks', input.linkId) : null;
  if (!link || link.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('対応付けが見つかりません。');
  }
  if (link.deletedAt) throw new ValidationError('この対応付けは既に外れています。');
  await assertItemAvailable(db, ctx, await itemOf(db, link.itemId));
  const now = new Date().toISOString();
  const updated = await db.update('responseContentLinks', link.id, {
    deletedAt: now,
    deletedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'response_content_link',
    resourceId: link.id,
    afterSummary: `${CONTENT_LABEL[link.targetKind]}との対応付けを外した`,
  });
  return updated;
}

// ----------------------------------------------------------------------
// 根拠の再利用（NF-39 C-04。response_evidence_links）
// ----------------------------------------------------------------------

/**
 * 対応付けた指標の承認済みデータに付いた根拠を、回答の根拠として紐付ける（人が候補から選ぶ）。
 * 候補の外の根拠・資料の閲覧権限が無い人の操作は受け付けない。紐付けは外さない（追記だけ）
 */
export async function linkResponseEvidence(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { responseId: Uuid; evidenceLinkId: Uuid },
): Promise<ResponseEvidenceLink> {
  assertCan(ctx, 'enterprise.disclosure.write');
  assertCan(ctx, 'enterprise.evidence.read');
  const organizationId = ctx.workspace.organizationId;
  const response = await ownedResponse(db, ctx, input.responseId);
  const item = await itemOf(db, response.itemId);
  await assertItemAvailable(db, ctx, item);
  const period = await db.findById('periods', response.reportingPeriodId);
  if (!period) throw new NotFoundError('報告期間が見つかりません。');

  const mappings = await db.select('disclosureMappings', {
    where: { organizationId, itemId: item.id, confirmedAt: { isNull: false } },
  });
  const metrics = (
    await Promise.all(mappings.map((m) => db.findById('metrics', m.metricId)))
  ).filter((m): m is NonNullable<typeof m> => Boolean(m && m.organizationId === organizationId));
  const candidates = await evidenceEntriesForRow(
    db,
    organizationId,
    { mappedMetrics: metrics },
    period,
  );
  const candidate = candidates.find((c) => c.evidenceLinkId === input.evidenceLinkId);
  if (!candidate) {
    throw new ValidationError('対応付けた指標の承認済みデータに付いた根拠だけを紐付けられます。');
  }
  const existing = await db.select('responseEvidenceLinks', {
    where: { organizationId, responseId: response.id, evidenceLinkId: input.evidenceLinkId },
    limit: 1,
  });
  if (existing[0]) throw new ValidationError('この根拠は既に紐付けています。');

  const now = new Date().toISOString();
  const link: ResponseEvidenceLink = {
    id: fid('response_evidence_link', `${response.id}/${input.evidenceLinkId}`),
    organizationId,
    responseId: response.id,
    evidenceLinkId: input.evidenceLinkId,
    createdAt: now,
  };
  await db.insert('responseEvidenceLinks', [link]);
  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'response_evidence_link',
    resourceId: link.id,
    afterSummary: `${item.code} の根拠に「${candidate.fileName}」を紐付け`,
  });
  return link;
}
