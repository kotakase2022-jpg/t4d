import 'server-only';

import { randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import { NotFoundError } from '@/lib/authorization/can';
import { getBuildInfo } from '@/lib/build-info';
import {
  isUnresolved,
  openIssueSummary,
  VERIFICATION_RESULTS,
  type OpenIssueSummary,
  type VerificationResult,
} from '@/lib/domain/trial-metrics';
import { routePatternOf } from '@/lib/errors/access-denied';
import { ValidationError } from '@/lib/errors/user-facing';
import type { DbClient } from '@/lib/repositories/types';
import {
  assertActiveMember,
  assertTrialManager,
  assertTrialReader,
  checkedDate,
  checkedText,
  trialTextLimits,
} from '@/lib/services/trial-program';
import { statusLabel } from '@/lib/ui/status/registry';
import { isUuid } from '@/lib/validation/uuid';
import {
  COST_CLASSES,
  FEEDBACK_CHANNELS,
  FEEDBACK_KINDS,
  FEEDBACK_SEVERITIES,
  FEEDBACK_STATUSES,
  type AuthorizationContext,
  type CostClass,
  type FeedbackChannel,
  type FeedbackKind,
  type FeedbackSeverity,
  type FeedbackStatus,
  type TrialFeedbackItem,
  type Uuid,
} from '@/types/domain';

/**
 * フィードバックと改善管理表（トライアル対応 NF-34。本導入の条件「必須要件に重大な未解決事項がない」）。
 *
 *  - 投稿は組織の有効なメンバー本人（ヘッダーの「ご意見・不具合」・改善管理表の定例会の論点）
 *  - 画面はルートのパターンだけを記録する（URL の検索条件・ID は記録しない）。環境の版を自動で添える
 *  - トリアージ（状態・対応方針・費用区分・担当・期限・必須要件・合意）と再検証は enterprise.org.manage。
 *    投稿の内容（種類・件名・本文・画面）は書き換えない（DB のガードトリガ・Cookie の検査と同じ）
 *  - 履歴は監査ログ（data_updated・resource_type trial_feedback）。改善管理表の表は件数を集計して見出しに出す
 *  - AI の候補の不採用の理由（ai_feedback）は「AI に関する意見」として件数と本文を読むだけ（書き込まない）
 */

function oneOf<T extends string>(values: readonly T[], value: unknown, message: string): T {
  if (typeof value === 'string' && (values as readonly string[]).includes(value)) return value as T;
  throw new ValidationError(message);
}

export interface FeedbackInput {
  kind: string;
  title: string;
  body: string;
  /** 不具合のときだけ */
  severity?: string | null;
  scenarioId?: string | null;
  /** 開いていた画面のパス（パターンにしてから記録する。検索条件・ID は捨てる） */
  route?: string | null;
  /** 既定はアプリ内。定例会・メールなどの論点は管理者が改善管理表から記録する */
  channel?: string | null;
  /** 必須要件に関わるか（管理者が記録するときだけ） */
  mandatoryRequirement?: boolean;
}

/** 記録する画面（ルートのパターン。アプリ内のパスでなければ空） */
export function feedbackRouteOf(route: string | null | undefined): string {
  const raw = (route ?? '').trim();
  if (raw === '') return '';
  const pattern = routePatternOf(raw);
  return pattern === '(不明)' ? '' : pattern.slice(0, 300);
}

async function checkedScenarioId(
  db: DbClient,
  ctx: AuthorizationContext,
  scenarioId: string | null | undefined,
): Promise<Uuid | null> {
  const id = (scenarioId ?? '').trim();
  if (id === '') return null;
  const rows = isUuid(id)
    ? await db.select('trialScenarios', {
        where: { id, organizationId: ctx.workspace.organizationId, deletedAt: { isNull: true } },
        limit: 1,
      })
    : [];
  if (rows.length === 0) throw new NotFoundError('関連するシナリオが見つかりません。');
  return id;
}

/**
 * フィードバックを投稿する（組織の有効なメンバー本人）。監査ログ data_created（trial_feedback）。
 * アプリ内以外の経路（定例会・メール・電話）と必須要件の印は enterprise.org.manage だけが付けられる
 */
export async function submitFeedback(
  db: DbClient,
  ctx: AuthorizationContext,
  input: FeedbackInput,
): Promise<TrialFeedbackItem> {
  await assertActiveMember(db, ctx);
  const limits = trialTextLimits(db, ctx);
  const kind = oneOf<FeedbackKind>(FEEDBACK_KINDS, input.kind, '種類を選んでください。');
  const title = checkedText(input.title, '件名', limits.title, { required: true });
  const body = checkedText(input.body, '内容', limits.text);
  const rawSeverity = (input.severity ?? '').trim();
  let severity: FeedbackSeverity | null = null;
  if (kind === 'defect') {
    severity =
      rawSeverity === ''
        ? null
        : oneOf<FeedbackSeverity>(FEEDBACK_SEVERITIES, rawSeverity, '重大度を選んでください。');
  }
  const channel: FeedbackChannel =
    input.channel && input.channel !== ''
      ? oneOf<FeedbackChannel>(FEEDBACK_CHANNELS, input.channel, '経路を選んでください。')
      : 'in_app';
  const mandatory = input.mandatoryRequirement === true;
  if (channel !== 'in_app' || mandatory) assertTrialManager(ctx);
  const scenarioId = await checkedScenarioId(db, ctx, input.scenarioId);
  const now = new Date().toISOString();
  const row: TrialFeedbackItem = {
    id: randomUUID(),
    organizationId: ctx.workspace.organizationId,
    kind,
    channel,
    title,
    body,
    routePattern: feedbackRouteOf(input.route),
    scenarioId,
    severity,
    mandatoryRequirement: mandatory,
    status: 'open',
    responsePolicy: '',
    costClass: 'undecided',
    ownerLabel: '',
    dueOn: null,
    resolvedInVersion: '',
    verificationResult: '',
    verifiedBy: null,
    verifiedAt: null,
    agreed: false,
    environmentVersion: getBuildInfo().commit,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  };
  const [inserted] = await db.insert('trialFeedbackItems', [row]);
  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'trial_feedback',
    resourceId: row.id,
    afterSummary: `フィードバックを登録（${statusLabel('feedbackKind', kind)}）`,
    metadata: { channel, route: row.routePattern, environment: row.environmentVersion },
  });
  return inserted ?? row;
}

async function loadItem(
  db: DbClient,
  ctx: AuthorizationContext,
  itemId: string,
): Promise<TrialFeedbackItem> {
  const item = isUuid(itemId) ? await db.findById('trialFeedbackItems', itemId) : null;
  if (!item || item.organizationId !== ctx.workspace.organizationId || item.deletedAt) {
    throw new NotFoundError('改善管理表の項目が見つかりません。');
  }
  return item;
}

export interface TriageInput {
  itemId: string;
  status: string;
  costClass: string;
  responsePolicy: string;
  ownerLabel: string;
  dueOn: string | null;
  mandatoryRequirement: boolean;
  /** 不具合のときだけ（それ以外は無視する） */
  severity?: string | null;
  resolvedInVersion: string;
  agreed: boolean;
}

/** トリアージ（改善管理の列だけを変える。org.manage）。監査ログ data_updated（trial_feedback） */
export async function triageFeedback(
  db: DbClient,
  ctx: AuthorizationContext,
  input: TriageInput,
): Promise<TrialFeedbackItem> {
  assertTrialManager(ctx);
  const limits = trialTextLimits(db, ctx);
  const item = await loadItem(db, ctx, input.itemId);
  const status = oneOf<FeedbackStatus>(FEEDBACK_STATUSES, input.status, '状態を選んでください。');
  if (status === 'verified' && item.verificationResult !== 'pass') {
    throw new ValidationError(
      '「再検証済み」にするには、先に再検証の結果（解消を確認）を記録してください。',
    );
  }
  const costClass = oneOf<CostClass>(COST_CLASSES, input.costClass, '費用区分を選んでください。');
  const patch: Partial<TrialFeedbackItem> = {
    status,
    costClass,
    responsePolicy: checkedText(input.responsePolicy, '対応方針', limits.text),
    ownerLabel: checkedText(input.ownerLabel, '担当', limits.title),
    dueOn: checkedDate(input.dueOn, '期限'),
    mandatoryRequirement: input.mandatoryRequirement,
    resolvedInVersion: checkedText(input.resolvedInVersion, '反映した版', limits.title),
    agreed: input.agreed,
    updatedAt: new Date().toISOString(),
    updatedBy: ctx.userId,
  };
  if (item.kind === 'defect' && input.severity !== undefined) {
    const raw = (input.severity ?? '').trim();
    patch.severity =
      raw === ''
        ? null
        : oneOf<FeedbackSeverity>(FEEDBACK_SEVERITIES, raw, '重大度を選んでください。');
  }
  const updated = await db.update('trialFeedbackItems', item.id, patch);
  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'trial_feedback',
    resourceId: item.id,
    beforeSummary: `状態: ${statusLabel('feedbackStatus', item.status)}・費用区分: ${statusLabel('costClass', item.costClass)}`,
    afterSummary: `状態: ${statusLabel('feedbackStatus', updated.status)}・費用区分: ${statusLabel('costClass', updated.costClass)}`,
  });
  return updated;
}

export interface ReverificationInput {
  itemId: string;
  result: string;
  /** 再検証した環境の版（省略時はこの環境の版） */
  version?: string | null;
}

/**
 * 再検証の結果を記録する（org.manage・本人名義）。解消を確認したら「再検証済み」、解消していなければ「対応中」に戻す。
 * 監査ログ data_updated（trial_feedback）
 */
export async function recordReverification(
  db: DbClient,
  ctx: AuthorizationContext,
  input: ReverificationInput,
): Promise<TrialFeedbackItem> {
  assertTrialManager(ctx);
  const limits = trialTextLimits(db, ctx);
  const item = await loadItem(db, ctx, input.itemId);
  const result = oneOf<VerificationResult>(
    VERIFICATION_RESULTS,
    input.result,
    '再検証の結果（解消を確認・解消せず）を選んでください。',
  );
  const version =
    checkedText(input.version, '反映した版', limits.title) ||
    item.resolvedInVersion ||
    getBuildInfo().commit;
  const updated = await db.update('trialFeedbackItems', item.id, {
    verificationResult: result,
    verifiedBy: ctx.userId,
    verifiedAt: new Date().toISOString(),
    status: result === 'pass' ? 'verified' : 'in_progress',
    resolvedInVersion: version,
    updatedAt: new Date().toISOString(),
    updatedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'trial_feedback',
    resourceId: item.id,
    beforeSummary: `状態: ${statusLabel('feedbackStatus', item.status)}`,
    afterSummary: `再検証: ${result === 'pass' ? '解消を確認' : '解消せず'}（版 ${version}）`,
  });
  return updated;
}

export interface FeedbackListRow extends TrialFeedbackItem {
  unresolved: boolean;
  scenarioCode: string | null;
}

/** 改善管理表（閲覧は組織メンバー）。新しい順 */
export async function listFeedback(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<FeedbackListRow[]> {
  assertTrialReader(ctx);
  const organizationId = ctx.workspace.organizationId;
  const [items, scenarios] = await Promise.all([
    db.select('trialFeedbackItems', {
      where: { organizationId, deletedAt: { isNull: true } },
      orderBy: [
        { column: 'createdAt', dir: 'desc' },
        { column: 'id', dir: 'asc' },
      ],
    }),
    db.select('trialScenarios', { where: { organizationId } }),
  ]);
  return items.map((item) => ({
    ...item,
    unresolved: item.kind !== 'positive' && isUnresolved(item),
    scenarioCode: scenarios.find((s) => s.id === item.scenarioId)?.code ?? null,
  }));
}

export interface AiOpinion {
  id: Uuid;
  comment: string;
  createdAt: string;
}

export interface FeedbackOverview {
  items: FeedbackListRow[];
  summary: OpenIssueSummary;
  /** AI の候補の不採用の理由（AI に関する意見。ai_feedback から読むだけ） */
  aiOpinions: AiOpinion[];
}

/** 改善管理表と見出しの件数（必須要件 × 重大 × 未解決）、AI に関する意見 */
export async function summarizeOpenIssues(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<FeedbackOverview> {
  const items = await listFeedback(db, ctx);
  const ai = await db.select('aiFeedback', {
    where: { organizationId: ctx.workspace.organizationId, decision: 'rejected' },
    orderBy: { column: 'createdAt', dir: 'desc' },
  });
  return {
    items,
    summary: openIssueSummary(items),
    aiOpinions: ai
      .filter((row) => (row.comment ?? '').trim() !== '')
      .map((row) => ({ id: row.id, comment: row.comment ?? '', createdAt: row.createdAt })),
  };
}
