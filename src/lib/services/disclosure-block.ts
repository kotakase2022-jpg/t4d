import 'server-only';

import { z } from 'zod';
import { previousComparablePeriod } from '@/lib/domain/period-comparability';
import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, can, NotFoundError, permissionsFor } from '@/lib/authorization/can';
import {
  collectRefs,
  contentHashOf,
  detectHandwrittenNumbers,
  diffParagraphs,
  emptyBody,
  formatMetricDisplay,
  hasBodyContent,
  paragraphText,
  plainTextOf,
  workingBodyInEffect,
  type ParagraphDiff,
} from '@/lib/domain/disclosure-block';
import {
  BLOCK_STATUS_LABELS,
  BLOCK_VERSION_ORIGIN_LABELS,
  DISCLOSURE_LANGUAGE_LABELS,
  EVIDENCE_USAGE_PURPOSE_LABELS,
  FRAMEWORK_COVERAGE_STATUS_LABELS,
  FRAMEWORK_LEGAL_STATUS_LABELS,
  NARRATIVE_STATUS_LABELS,
  NARRATIVE_THEME_LABELS,
  REVIEW_COMMENT_SEVERITY_LABELS,
  REVIEW_EVENT_TYPE_LABELS,
  REVIEW_REQUEST_STATUS_LABELS,
  REVIEW_STAGE_LABELS,
  applicabilityDecisionChangedSince,
  evaluateBlockBlockers,
  hasUnresolvedRequiredInfo,
  isChangedAfterApproval,
  transitionBlock,
  type BlockBlocker,
} from '@/lib/domain/disclosure-status';
import {
  assessNarrativeFields,
  notQuantifiedNote,
  unresolvedNarrativeFields,
} from '@/lib/domain/narrative-template';
import { ValidationError } from '@/lib/errors/user-facing';
import { fid } from '@/lib/fixtures/ids';
import { listMembers } from '@/lib/services/identity';
import {
  computeBlockFreshness,
  detectFileUpdates,
  type BlockFreshness,
} from '@/lib/services/disclosure-recheck';
import type { DbClient } from '@/lib/repositories/types';
import { isUuid } from '@/lib/validation/uuid';
import type {
  AuthorizationContext,
  BlockBody,
  BlockInline,
  BlockParagraph,
  BlockStatus,
  DataPoint,
  DataPointVersion,
  DisclosureBlock,
  DisclosureBlockVersion,
  DisclosureLanguage,
  DisclosureProject,
  EvidenceUsagePurpose,
  IsoDate,
  IsoDateTime,
  PermissionKey,
  ReviewEvent,
  ReviewRequest,
  Uuid,
} from '@/types/domain';

/**
 * 開示本文（節）の編集（docs/disclosure-first.md §4・§5、指示書 §6.7・§6.8）。
 *
 *  - 自動保存（working_body）と業務上の版（disclosure_block_versions）を分ける。
 *    キー入力のたびに承認対象の版を作らない。版は「版として保存」「レビュー依頼」「引用先の新版の採用」で作る
 *  - 版の保存は base_version = current_version のときだけ。違えば上書きせず、両方の本文を返して競合を知らせる
 *  - 本文の参照（数値・定性情報・出典印）はサーバーで検証する。別組織・存在しない版・表示の改ざんは保存させない
 *  - Supabase Mode では 1 呼び出し = 1 トランザクション。版を先に追記し、節のポインタを後から更新する
 *    （節の行はポインタが null でも成り立つ。途中で失敗しても孤立した版が残るだけで、節は前の版を指したまま）
 */

// ======================================================================
// エラー
// ======================================================================

/**
 * 競合の種類。
 *  - version … ほかの人（別のタブ）が先に版を保存した
 *  - working … ほかの人が自動保存した作業本文があり、この画面はそれを読み込んでいない
 */
export type BlockConflictKind = 'version' | 'working';

export const CONFLICT_MESSAGES: Record<BlockConflictKind, string> = {
  version:
    'ほかの操作で先に新しい版が保存されています。上書きせずに止めました。差分を確認して取り込み直してください。',
  working:
    'ほかの人が自動保存した作業中の本文があります。上書き・破棄せずに止めました。最新の本文を開いて取り込み直してください。',
};

/** 版の競合。両方の本文を返し、上書きしない */
export class BlockConflictError extends ValidationError {
  readonly code = 'CONFLICT';
  constructor(
    readonly currentVersionId: Uuid | null,
    readonly currentBody: BlockBody,
    readonly yourBody: BlockBody,
    readonly kind: BlockConflictKind = 'version',
  ) {
    super(CONFLICT_MESSAGES[kind]);
    this.name = 'BlockConflictError';
  }
}

/**
 * ほかの人が自動保存した作業本文を、この画面が読み込まないまま上書き・破棄しようとしているか。
 *
 * 版の土台（base_version）が同じでも、別の人の自動保存は版にならないため、版の比較だけでは
 * 気付けない（指示書 §10.2「競合時は上書きせず差分確認」）。画面は読み込んだ時点の
 * working_saved_at を持ち回し、それ以後に別の人が保存していれば競合として止める。
 * 自分の自動保存（別のタブ・別のインスタンスの古い本文）は競合にしない
 * （Demo Mode では作業本文がインスタンスのメモリにしか無く、古い自分の本文で誤検知するため）。
 */
export function isForeignWorkingBody(
  block: Pick<DisclosureBlock, 'status' | 'workingBody' | 'workingSavedAt' | 'workingUpdatedBy'>,
  actorId: Uuid,
  knownWorkingSavedAt: IsoDateTime | null | undefined,
): boolean {
  // レビュー中・承認済みの節に残った作業本文は画面に出さない（workingBodyInEffect）ため、競合にも数えない
  if (!workingBodyInEffect(block)) return false;
  const writer = block.workingUpdatedBy ?? null;
  if (writer === null || writer === actorId) return false;
  return (block.workingSavedAt ?? null) !== (knownWorkingSavedAt ?? null);
}

/** 作業本文を書いた人に自分を足す（既に書いた人は外さない。DB のトリガと同じ規則） */
export function contributorsWith(
  block: Pick<DisclosureBlock, 'workingContributorIds'>,
  actorId: Uuid,
): Uuid[] {
  const current = block.workingContributorIds ?? [];
  return current.includes(actorId) ? [...current] : [...current, actorId];
}

/** 作業本文を版へ取り込んだ（または捨てた）後の列。書いた人の記録も版へ移したので空にする */
export const CLEARED_WORKING_COLUMNS = {
  workingBody: null,
  workingBaseVersionId: null,
  workingSavedAt: null,
  workingUpdatedBy: null,
  workingContributorIds: [] as Uuid[],
} satisfies Partial<DisclosureBlock>;

export interface RefValidationIssue {
  paragraphId: string;
  kind: 'metric' | 'narrative' | 'cite' | 'ai_run';
  refId: string;
  message: string;
}

/** 本文の参照が不正（別組織・存在しない版・表示の不一致）。項目ごとの理由を持つ */
export class BlockRefValidationError extends ValidationError {
  constructor(readonly issues: RefValidationIssue[]) {
    super(
      issues.length === 1
        ? `本文の参照を保存できません: ${issues[0]?.message ?? ''}`
        : `本文の参照を保存できません（${issues.length} 件）: ${issues[0]?.message ?? ''} ほか`,
    );
    this.name = 'BlockRefValidationError';
  }
}

// ======================================================================
// 本文 AST の入力検査（クライアントから来た JSON を信用しない）
// ======================================================================

const idSchema = z.string().min(1).max(80);
const paragraphIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/, '段落 ID に使えない文字が含まれています。');

const inlineSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('text'), text: z.string().max(20_000) }),
  z.object({
    t: z.literal('metric'),
    dataPointId: idSchema,
    dataPointVersionId: idSchema,
    display: z.string().max(200),
  }),
  z.object({
    t: z.literal('narrative'),
    narrativeVersionId: idSchema,
    quote: z.string().min(1).max(20_000),
  }),
  z.object({ t: z.literal('cite'), sourceAnchorId: idSchema }),
]);

const paragraphSchema = z.object({
  id: paragraphIdSchema,
  kind: z.enum(['paragraph', 'heading']),
  children: z.array(inlineSchema).max(400),
  aiRunId: idSchema.optional(),
});

const bodySchema = z.object({ paragraphs: z.array(paragraphSchema).max(500) });

/** 本文 AST を検査して、余計なキーを落とした値を返す（段落 ID の重複も拒否する） */
export function parseBlockBody(raw: unknown): BlockBody {
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      `本文の形式が正しくありません（${parsed.error.issues[0]?.message ?? '不明な形式'}）。`,
    );
  }
  const seen = new Set<string>();
  for (const p of parsed.data.paragraphs) {
    if (seen.has(p.id)) throw new ValidationError(`段落 ID「${p.id}」が重複しています。`);
    seen.add(p.id);
  }
  // 隣り合う text を 1 つにまとめる（同じ内容の本文が別のハッシュにならないように）
  const paragraphs: BlockParagraph[] = parsed.data.paragraphs.map((p) => {
    const children: BlockInline[] = [];
    for (const child of p.children) {
      const last = children[children.length - 1];
      if (child.t === 'text') {
        if (child.text.length === 0) continue;
        if (last && last.t === 'text') {
          last.text += child.text;
          continue;
        }
      }
      children.push({ ...child } as BlockInline);
    }
    const paragraph: BlockParagraph = { id: p.id, kind: p.kind, children };
    if (p.aiRunId) paragraph.aiRunId = p.aiRunId;
    return paragraph;
  });
  return { paragraphs };
}

// ======================================================================
// 読み込み（組織と権限をここで確かめる）
// ======================================================================

export async function loadBlock(
  db: DbClient,
  ctx: AuthorizationContext,
  blockId: Uuid,
): Promise<DisclosureBlock> {
  assertCan(ctx, 'enterprise.disclosure.read');
  const block = isUuid(blockId) ? await db.findById('disclosureBlocks', blockId) : null;
  // 別組織の節は「無い」として扱う（存在を漏らさない）
  if (!block || block.organizationId !== ctx.workspace.organizationId || block.deletedAt) {
    throw new NotFoundError('節が見つかりません。');
  }
  return block;
}

export async function loadProject(
  db: DbClient,
  ctx: AuthorizationContext,
  projectId: Uuid,
): Promise<DisclosureProject> {
  assertCan(ctx, 'enterprise.disclosure.read');
  const project = isUuid(projectId) ? await db.findById('disclosureProjects', projectId) : null;
  if (!project || project.organizationId !== ctx.workspace.organizationId || project.deletedAt) {
    throw new NotFoundError('開示プロジェクトが見つかりません。');
  }
  return project;
}

/**
 * 版を読む。Demo Mode では版は同じインスタンスのメモリにしか無い（docs/disclosure-first.md §2-6）。
 * 別インスタンスで見つからない場合も「見つからない」として安全に失敗させる。
 */
export async function loadBlockVersion(
  db: DbClient,
  ctx: AuthorizationContext,
  versionId: Uuid,
): Promise<DisclosureBlockVersion> {
  const version = isUuid(versionId)
    ? await db.findById('disclosureBlockVersions', versionId)
    : null;
  if (!version || version.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError(
      '本文の版が見つかりません。デモ環境では、別のサーバーで保存した版を参照できない場合があります。',
    );
  }
  return version;
}

export async function listBlockVersions(
  db: DbClient,
  ctx: AuthorizationContext,
  blockId: Uuid,
): Promise<DisclosureBlockVersion[]> {
  return db.select('disclosureBlockVersions', {
    where: { organizationId: ctx.workspace.organizationId, blockId },
    orderBy: [{ column: 'versionNo', dir: 'asc' }],
  });
}

/**
 * 節は版を指しているのに、その版を読めないときの説明。
 * Demo Mode では版がインスタンスのメモリにしか無く（docs/disclosure-first.md §2-6）、
 * 別のサーバーで保存した版は見えない。空の本文を土台に編集・保存させないため、読み取り専用にする。
 */
export const VERSION_UNAVAILABLE_MESSAGE =
  'この節の現在の版を読み込めません（デモ環境では、別のサーバーで保存した版を参照できない場合があります）。上書きを防ぐため編集を止めています。';

/** 現在の版の本文（版が無ければ空） */
export async function currentVersionBody(
  db: DbClient,
  ctx: AuthorizationContext,
  block: DisclosureBlock,
): Promise<{ version: DisclosureBlockVersion | null; body: BlockBody }> {
  if (!block.currentVersionId) return { version: null, body: emptyBody() };
  const version = await db.findById('disclosureBlockVersions', block.currentVersionId);
  if (!version || version.organizationId !== ctx.workspace.organizationId) {
    return { version: null, body: emptyBody() };
  }
  return { version, body: version.body };
}

/**
 * 作業中の本文。自動保存が現在の版を土台にしていればそれを、無ければ現在の版の本文を返す。
 * 自動保存の土台が現在の版と違う（別の人が版を保存した）場合も作業本文は捨てない（画面が競合として扱う）。
 * レビュー中・承認済みの節は、作業本文が残っていても現在の版（審査・承認した版）を返す。
 */
export async function editingBodyOf(
  db: DbClient,
  ctx: AuthorizationContext,
  block: DisclosureBlock,
): Promise<{ body: BlockBody; fromWorking: boolean; version: DisclosureBlockVersion | null }> {
  const current = await currentVersionBody(db, ctx, block);
  if (workingBodyInEffect(block)) {
    return { body: block.workingBody, fromWorking: true, version: current.version };
  }
  return { body: current.body, fromWorking: false, version: current.version };
}

// ======================================================================
// 数値参照の表示・承認状態
// ======================================================================

/**
 * 数値参照の表示用文字列。挿入時にこの値を本文へ写す（Fixture の metricInline と同じ規則）。
 * 推計・目標の値には区分を添える（本文で実績と読ませない）
 */
export function metricDisplay(
  version: Pick<DataPointVersion, 'value' | 'textValue' | 'unitOfMeasure'> & {
    valueKind?: DataPointVersion['valueKind'] | null;
  },
): string {
  return formatMetricDisplay(version);
}

/**
 * その版が承認済みか。版の行の状態は作成時点のまま（例: 承認後の訂正版は draft で作られる）なので、
 * Data Point がその版を現在値として承認済みであれば承認済みとみなす。
 */
export function isVersionApproved(
  version: Pick<DataPointVersion, 'id' | 'status'>,
  dataPoint: Pick<DataPoint, 'currentVersionId' | 'status'> | null,
  approvedVersionIds: ReadonlySet<Uuid> = new Set(),
): boolean {
  if (version.status === 'approved') return true;
  if (approvedVersionIds.has(version.id)) return true;
  return dataPoint?.currentVersionId === version.id && dataPoint.status === 'approved';
}

/** 承認記録（approvals）が指している Data Point の版 */
export async function approvedDataPointVersionIds(
  db: DbClient,
  ctx: AuthorizationContext,
  dataPointIds: readonly Uuid[],
): Promise<Set<Uuid>> {
  if (dataPointIds.length === 0) return new Set();
  const approvals = await db.select('approvals', {
    where: {
      organizationId: ctx.workspace.organizationId,
      targetType: 'data_point',
      targetId: { in: [...dataPointIds] },
      decision: 'approved',
    },
  });
  return new Set(
    approvals.map((a) => a.targetVersionId).filter((id): id is Uuid => typeof id === 'string'),
  );
}

// ======================================================================
// 参照の検証（保存時。別組織・存在しない版・表示の改ざんを拒否する）
// ======================================================================

export const AI_RUN_UNAVAILABLE_MESSAGE =
  'AI 候補の実行記録をこのサーバーで読み込めません（デモ環境では、別のサーバーで記録した実行を参照できない場合があります）。段落はそのまま残っています。時間をおいて保存し直すか、段落を手で書き直してください。';

/**
 * 作業本文に新しく入れた参照のうち、この組織の行として読めないもの（自動保存・AI 候補の採用で使う）。
 *
 * 別組織の行と、存在しない行は**同じ結果・同じ文言**で断る。別組織の行だけを断ると、
 * Demo Mode（findById が全テナントの行を返す）では「他社にその ID の行があるか」を
 * 応答の違いから調べられてしまう（A29）。Supabase Mode では RLS で他社の行が見えず、
 * もともと両者は区別できない。
 *
 * 既に現在の版・作業本文にある参照は調べ直さない（入れた時点で確かめている）。
 * 新しく入れた参照は、画面がこのサーバーで読める行から挿入したものに限られる。
 * デモ環境で別のサーバーが作った行を挿入した直後に限り、ここで一度断られることがあるため、
 * 本文を残したまま保存し直せる旨を示す。
 */
export const UNRESOLVABLE_REF_MESSAGE =
  '引用先のデータをこのサーバーで読み込めません（別の組織のデータ、またはデモ環境で別のサーバーに保存したデータは引用できません）。本文はそのまま残っています。時間をおいて保存し直すか、引用を挿入し直してください。';

export async function findUnresolvableRefs(
  db: DbClient,
  ctx: AuthorizationContext,
  body: BlockBody,
  knownBodies: ReadonlyArray<BlockBody | null | undefined>,
): Promise<RefValidationIssue[]> {
  const organizationId = ctx.workspace.organizationId;
  const issues: RefValidationIssue[] = [];
  const own = (row: { organizationId: Uuid } | null) =>
    row !== null && row.organizationId === organizationId;
  const known = new Set<string>();
  for (const b of knownBodies) {
    if (!b) continue;
    for (const paragraph of b.paragraphs) {
      if (paragraph.aiRunId) known.add(`ai_run:${paragraph.aiRunId}`);
      for (const inline of paragraph.children) {
        if (inline.t === 'metric')
          known.add(`metric:${inline.dataPointVersionId}:${inline.dataPointId}`);
        else if (inline.t === 'narrative') known.add(`narrative:${inline.narrativeVersionId}`);
        else if (inline.t === 'cite') known.add(`cite:${inline.sourceAnchorId}`);
      }
    }
  }
  const seen = new Set<string>();
  for (const paragraph of body.paragraphs) {
    const check = async (
      kind: RefValidationIssue['kind'],
      key: string,
      refId: string,
      resolvable: () => Promise<boolean>,
    ) => {
      if (known.has(key) || seen.has(key)) return;
      seen.add(key);
      if (await resolvable()) return;
      issues.push({ paragraphId: paragraph.id, kind, refId, message: UNRESOLVABLE_REF_MESSAGE });
    };
    if (paragraph.aiRunId) {
      const runId = paragraph.aiRunId;
      await check('ai_run', `ai_run:${runId}`, runId, async () =>
        own(await db.findById('aiRuns', runId)),
      );
    }
    for (const inline of paragraph.children) {
      if (inline.t === 'metric') {
        await check(
          'metric',
          `metric:${inline.dataPointVersionId}:${inline.dataPointId}`,
          inline.dataPointVersionId,
          async () =>
            own(await db.findById('dataPointVersions', inline.dataPointVersionId)) &&
            own(await db.findById('dataPoints', inline.dataPointId)),
        );
      } else if (inline.t === 'narrative') {
        await check(
          'narrative',
          `narrative:${inline.narrativeVersionId}`,
          inline.narrativeVersionId,
          async () => own(await db.findById('narrativeVersions', inline.narrativeVersionId)),
        );
      } else if (inline.t === 'cite') {
        await check('cite', `cite:${inline.sourceAnchorId}`, inline.sourceAnchorId, async () =>
          own(await db.findById('sourceAnchors', inline.sourceAnchorId)),
        );
      }
    }
  }
  return issues;
}

export async function validateBodyRefs(
  db: DbClient,
  ctx: AuthorizationContext,
  blockId: Uuid,
  body: BlockBody,
): Promise<RefValidationIssue[]> {
  const organizationId = ctx.workspace.organizationId;
  const issues: RefValidationIssue[] = [];
  const cache = new Map<string, unknown>();
  const cached = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) cache.set(key, await load());
    return cache.get(key) as T;
  };

  for (const paragraph of body.paragraphs) {
    if (paragraph.aiRunId) {
      const runId = paragraph.aiRunId;
      const run = await cached(`run:${runId}`, () => db.findById('aiRuns', runId));
      if (!run || run.organizationId !== organizationId) {
        // 見つからないだけ（Demo Mode で別のサーバーが記録した実行・Cookie から押し出された実行）を
        // 改ざんと同じ文言で責めない。保存は止めるが、理由と取れる手を示す。
        // 別組織の実行も同じ文言にする（文言の違いから他社の実行の有無を調べさせない。A29）
        issues.push({
          paragraphId: paragraph.id,
          kind: 'ai_run',
          refId: runId,
          message: AI_RUN_UNAVAILABLE_MESSAGE,
        });
      } else if (
        run.featureType !== 'disclosureBlockDraft' ||
        !run.inputReferenceIds.includes(`block:${blockId}`)
      ) {
        issues.push({
          paragraphId: paragraph.id,
          kind: 'ai_run',
          refId: runId,
          message: 'この節の AI 候補ではない実行 ID が段落に付いています。',
        });
      }
    }
    for (const inline of paragraph.children) {
      if (inline.t === 'metric') {
        const version = await cached(`dpv:${inline.dataPointVersionId}`, () =>
          db.findById('dataPointVersions', inline.dataPointVersionId),
        );
        const dp = await cached(`dp:${inline.dataPointId}`, () =>
          db.findById('dataPoints', inline.dataPointId),
        );
        if (
          !version ||
          version.organizationId !== organizationId ||
          !dp ||
          dp.organizationId !== organizationId ||
          dp.deletedAt ||
          version.dataPointId !== dp.id
        ) {
          issues.push({
            paragraphId: paragraph.id,
            kind: 'metric',
            refId: inline.dataPointVersionId,
            message: '引用した数値の版が見つかりません（別の組織・存在しない版は引用できません）。',
          });
          continue;
        }
        if (inline.display !== metricDisplay(version)) {
          issues.push({
            paragraphId: paragraph.id,
            kind: 'metric',
            refId: inline.dataPointVersionId,
            message: `数値の表示「${inline.display}」が引用した版の値「${metricDisplay(version)}」と一致しません。`,
          });
        }
      } else if (inline.t === 'narrative') {
        const version = await cached(`nv:${inline.narrativeVersionId}`, () =>
          db.findById('narrativeVersions', inline.narrativeVersionId),
        );
        if (!version || version.organizationId !== organizationId) {
          issues.push({
            paragraphId: paragraph.id,
            kind: 'narrative',
            refId: inline.narrativeVersionId,
            message: '引用した定性情報の版が見つかりません。',
          });
          continue;
        }
        // 一部の引用は許すが、版の本文に無い文言を「引用」として保存させない
        if (!version.body.includes(inline.quote)) {
          issues.push({
            paragraphId: paragraph.id,
            kind: 'narrative',
            refId: inline.narrativeVersionId,
            message: '定性情報の引用文が、引用した版の本文と一致しません。',
          });
        }
      } else if (inline.t === 'cite') {
        const anchor = await cached(`sa:${inline.sourceAnchorId}`, () =>
          db.findById('sourceAnchors', inline.sourceAnchorId),
        );
        if (!anchor || anchor.organizationId !== organizationId) {
          issues.push({
            paragraphId: paragraph.id,
            kind: 'cite',
            refId: inline.sourceAnchorId,
            message: '出典印の引用位置が見つかりません。',
          });
        }
      }
    }
  }
  return issues;
}

// ======================================================================
// 版の追記（Service 内部の共通処理。レビュー依頼・再確認からも使う）
// ======================================================================

export interface AppendVersionOptions {
  changeReason: string | null;
  baseVersionId: Uuid | null;
}

/** 版の本文を書いた人（作成者と、自動保存・前の版から引き継いだ人） */
export function versionAuthors(
  version: Pick<DisclosureBlockVersion, 'createdBy' | 'contributorUserIds'>,
): Uuid[] {
  return [version.createdBy, ...(version.contributorUserIds ?? [])];
}

/**
 * 新しい版の本文を書いた人（作成者を除く）。
 * 節の作業本文を自動保存した人に加えて、土台にした版（と節の現在の版）の作成者・書いた人を引き継ぐ。
 * 引き継がないと、承認者が書いた段落を別の人が 1 文字直した版（再確認の「新しい版を採用」を含む）で
 * 承認者の記録が消え、承認者が自分の段落を最終承認できてしまう。
 * DB のトリガ t4d.merge_block_version_contributors（0042）も同じ規則で補う。
 */
export function inheritedContributors(
  block: Pick<DisclosureBlock, 'workingContributorIds'>,
  baseVersions: ReadonlyArray<Pick<DisclosureBlockVersion, 'createdBy' | 'contributorUserIds'>>,
  creatorId: Uuid,
): Uuid[] {
  return [
    ...new Set([...(block.workingContributorIds ?? []), ...baseVersions.flatMap(versionAuthors)]),
  ].filter((id) => id !== creatorId);
}

/** 版を 1 行追記する。節のポインタは呼び出し側が更新する（版を先に作る順序を守るため） */
export async function appendBlockVersion(
  db: DbClient,
  ctx: AuthorizationContext,
  block: DisclosureBlock,
  body: BlockBody,
  options: AppendVersionOptions,
): Promise<DisclosureBlockVersion> {
  const existing = await listBlockVersions(db, ctx, block.id);
  const versionNo = existing.reduce((max, v) => Math.max(max, v.versionNo), 0) + 1;
  const now = new Date().toISOString();
  const refs = collectRefs(body);
  const aiRunIds = [
    ...new Set(body.paragraphs.map((p) => p.aiRunId).filter((id): id is Uuid => Boolean(id))),
  ];
  const version: DisclosureBlockVersion = {
    // 時刻を含める: Demo Mode では版がインスタンスのメモリにしか無く、別インスタンスで同じ版番号を
    // 作りうる。ID まで同じだと、Cookie で持ち回したポインタが別の本文を指してしまう
    id: fid('disclosure_block_version', `${block.id}/v${versionNo}/${now}`),
    organizationId: ctx.workspace.organizationId,
    blockId: block.id,
    versionNo,
    baseVersionId: options.baseVersionId,
    body,
    plainText: plainTextOf(body),
    metricRefs: refs.metricVersionIds,
    narrativeRefs: refs.narrativeVersionIds,
    anchorRefs: refs.anchorIds,
    changeReason: options.changeReason,
    // AI の候補を採用した段落を含む版も、版を作るのは人（AI が版を確定する経路は無い）
    origin: aiRunIds.length > 0 ? 'human_adopted_ai' : 'human',
    originatedFromAiRunId: aiRunIds[0] ?? null,
    contentHash: contentHashOf(body),
    createdAt: now,
    createdBy: ctx.userId,
    // 作業本文を自動保存した人と、土台の版を書いた人（作成者以外）を版に残す。
    // 職務分離では作成者と同じ扱いにする（DB のトリガ t4d.merge_block_version_contributors も同じ規則で補う）
    contributorUserIds: inheritedContributors(
      block,
      existing.filter((v) => v.id === options.baseVersionId || v.id === block.currentVersionId),
      ctx.userId,
    ),
  };
  await db.insert('disclosureBlockVersions', [version]);
  await recordAuditEvent(db, ctx, {
    eventType: 'block_version_created',
    resourceType: 'disclosure_block',
    resourceId: block.id,
    afterSummary: `${block.title} 版 ${versionNo}`,
    metadata: {
      versionId: version.id,
      versionNo,
      origin: version.origin,
      changeReason: options.changeReason ? 'あり' : 'なし',
    },
  });
  return version;
}

/**
 * 節の阻害条件（本文・未採用の AI 候補・未解決の要対応コメント・引用版の鮮度・適用判断）。
 * 原稿画面・原稿一覧・レビュー依頼が同じ判定を使う（画面の表示とサーバーの拒否を食い違わせない）。
 */
export async function evaluateBlockBlockersFor(
  db: DbClient,
  ctx: AuthorizationContext,
  block: DisclosureBlock,
  body: BlockBody,
): Promise<BlockBlocker[]> {
  const organizationId = ctx.workspace.organizationId;
  const [comments, pendingRuns, projectFrameworks, frameworkVersion, freshness] = await Promise.all(
    [
      db.select('reviewComments', { where: { organizationId, blockId: block.id } }),
      db.select('aiRuns', {
        where: {
          organizationId,
          featureType: 'disclosureBlockDraft',
          status: 'succeeded',
          inputReferenceIds: { contains: `block:${block.id}` },
        },
      }),
      db.select('projectFrameworks', { where: { organizationId, projectId: block.projectId } }),
      db.findById('frameworkVersions', block.frameworkVersionId),
      computeBlockFreshness(db, ctx, block, body),
    ],
  );
  const pendingAiCandidateCount = pendingRuns.reduce((sum, run) => {
    const blocks = (run.outputJson as { draftBlocks?: unknown[] }).draftBlocks;
    return sum + (Array.isArray(blocks) ? blocks.length : 0);
  }, 0);
  const pf = projectFrameworks.find((p) => p.frameworkVersionId === block.frameworkVersionId);

  // 数値の鮮度は、理由付きで「維持」と判断した組み合わせを古い参照として数えない
  const metricItems = freshness.items.filter((i) => i.refKind === 'metric');
  const blockers = evaluateBlockBlockers({
    body,
    pendingAiCandidateCount,
    comments,
    metricRefs: metricItems.map((i) => ({
      dataPointId: i.oldRefId,
      dataPointVersionId: i.oldRefId,
      currentVersionId: i.keptOld ? i.oldRefId : i.newRefId,
      label: i.label,
    })),
    frameworks: pf
      ? [
          {
            frameworkVersionId: pf.frameworkVersionId,
            label: frameworkVersion?.label ?? '基準',
            applicabilityStatus: pf.applicabilityStatus,
          },
        ]
      : [],
  });
  const staleNarratives = freshness.items.filter((i) => i.refKind === 'narrative' && !i.keptOld);
  if (staleNarratives.length > 0) {
    blockers.push({
      code: 'stale_metric_refs',
      message: `引用した定性情報に新しい版があります（${staleNarratives.map((i) => i.label).join('、')}）。再確認してください。`,
    });
  }
  const invalid = freshness.items.filter((i) => i.refKind === 'evidence');
  if (invalid.length > 0) {
    blockers.push({
      code: 'stale_metric_refs',
      message: `根拠が失効しています（${invalid.map((i) => i.label).join('、')}）。`,
    });
  }
  return blockers;
}

// ======================================================================
// 自動保存
// ======================================================================

export interface AutosaveInput {
  blockId: Uuid;
  /** 編集を始めたときの現在の版（無ければ null） */
  baseVersionId: Uuid | null;
  body: unknown;
  /**
   * この画面が最後に読み込んだ・保存した作業本文の保存時刻（working_saved_at）。
   * 別の人がそれ以後に自動保存していれば、上書きせず競合として返す。
   * 省略時（サーバー内の呼び出し）は検査しない
   */
  knownWorkingSavedAt?: IsoDateTime | null;
}

export type AutosaveResult =
  | { status: 'saved'; savedAt: IsoDateTime; baseVersionId: Uuid | null }
  | {
      status: 'conflict';
      kind: BlockConflictKind;
      message: string;
      currentVersionId: Uuid | null;
      currentBody: BlockBody;
    };

/** 作業本文を自動保存する（版は作らない）。下書き・差戻しの節だけ */
export async function autosaveWorkingBody(
  db: DbClient,
  ctx: AuthorizationContext,
  input: AutosaveInput,
): Promise<AutosaveResult> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const block = await loadBlock(db, ctx, input.blockId);
  const transition = transitionBlock('autosave', block.status);
  if (!transition.ok) throw new ValidationError(transition.reason);
  const body = parseBlockBody(input.body);
  if (block.currentVersionId && !(await currentVersionBody(db, ctx, block)).version) {
    throw new NotFoundError(VERSION_UNAVAILABLE_MESSAGE);
  }
  // 読めない参照（別組織・存在しない行）は作業本文にも入れない（鮮度・一覧の表示から他社の情報が漏れる）。
  // 別組織と存在しないを同じ結果にする（A29）
  const unresolvable = await findUnresolvableRefs(db, ctx, body, [
    (await currentVersionBody(db, ctx, block)).version?.body,
    block.workingBody,
  ]);
  if (unresolvable.length > 0) throw new BlockRefValidationError(unresolvable);

  if ((input.baseVersionId ?? null) !== (block.currentVersionId ?? null)) {
    const current = await currentVersionBody(db, ctx, block);
    return {
      status: 'conflict',
      kind: 'version',
      message: CONFLICT_MESSAGES.version,
      currentVersionId: block.currentVersionId,
      currentBody: current.body,
    };
  }
  if (
    input.knownWorkingSavedAt !== undefined &&
    isForeignWorkingBody(block, ctx.userId, input.knownWorkingSavedAt)
  ) {
    return {
      status: 'conflict',
      kind: 'working',
      message: CONFLICT_MESSAGES.working,
      currentVersionId: block.currentVersionId,
      currentBody: block.workingBody ?? emptyBody(),
    };
  }

  const savedAt = new Date().toISOString();
  await db.update('disclosureBlocks', block.id, {
    workingBody: body,
    workingBaseVersionId: block.currentVersionId,
    workingSavedAt: savedAt,
    workingUpdatedBy: ctx.userId,
    workingContributorIds: contributorsWith(block, ctx.userId),
    updatedAt: savedAt,
    updatedBy: ctx.userId,
  });
  return { status: 'saved', savedAt, baseVersionId: block.currentVersionId };
}

// ======================================================================
// 版として保存（承認後の修正を含む）
// ======================================================================

export interface SaveBlockVersionInput {
  blockId: Uuid;
  baseVersionId: Uuid | null;
  body: unknown;
  changeReason: string | null;
  /** 自動保存と同じ。別の人の作業本文を読み込まずに版へ取り込み・破棄しない */
  knownWorkingSavedAt?: IsoDateTime | null;
}

/**
 * 承認済みの版が、報告範囲の変更より前の依頼で承認されたか（指示書 §10.3「報告範囲」の変更は再確認が必要）。
 * 承認した依頼の範囲の改訂番号が、プロジェクトの現在の番号より小さければ再確認が必要。
 */
export async function scopeRecheckNeeded(
  db: DbClient,
  ctx: AuthorizationContext,
  block: Pick<DisclosureBlock, 'id' | 'approvedVersionId'>,
  project: Pick<DisclosureProject, 'scopeRevision'>,
): Promise<boolean> {
  if (!block.approvedVersionId) return false;
  const projectRevision = project.scopeRevision ?? 0;
  if (projectRevision === 0) return false;
  const requests = await db.select('reviewRequests', {
    where: {
      organizationId: ctx.workspace.organizationId,
      targetType: 'disclosure_block',
      targetId: block.id,
      targetVersionId: block.approvedVersionId,
      status: 'approved',
    },
  });
  const approvedAt = Math.max(...requests.map((r) => r.projectScopeRevision ?? 0), -1);
  return approvedAt < projectRevision;
}

export const SCOPE_RECHECK_MESSAGE =
  '報告範囲（報告主体・期間・対象範囲）の変更より前に承認された節です。範囲の変更を踏まえて本文を確認し、再承認を受けてください。';

export const APPLICABILITY_RECHECK_MESSAGE =
  '最終承認の後に適用判断が更新されました。更新後の判断で本文を確認し、再承認を受けてください。';

/**
 * 承認済みの版が、節の基準の適用判断を確定し直す前の依頼で承認されたか（§10.1・§10.3）。
 * 判断の比較規則は domain の applicabilityDecisionChangedSince（確定前の検査・最終承認と同じ）。
 */
export async function applicabilityRecheckNeeded(
  db: DbClient,
  ctx: AuthorizationContext,
  block: Pick<DisclosureBlock, 'id' | 'approvedVersionId' | 'projectId' | 'frameworkVersionId'>,
): Promise<boolean> {
  if (!block.approvedVersionId) return false;
  const organizationId = ctx.workspace.organizationId;
  const [pf] = await db.select('projectFrameworks', {
    where: {
      organizationId,
      projectId: block.projectId,
      frameworkVersionId: block.frameworkVersionId,
    },
  });
  if (!pf?.currentDecisionId) return false;
  const requests = await db.select('reviewRequests', {
    where: {
      organizationId,
      targetType: 'disclosure_block',
      targetId: block.id,
      targetVersionId: block.approvedVersionId,
      status: 'approved',
    },
  });
  if (requests.length === 0) return false;
  const decision = await db.findById('projectFrameworkDecisions', pf.currentDecisionId);
  const current = decision && decision.organizationId === organizationId ? decision : null;
  return requests.every((r) => applicabilityDecisionChangedSince(r, pf.currentDecisionId, current));
}

/**
 * 翻訳版が、翻訳元の現在の版より前に作った版のままか（翻訳の要確認）。
 * 原稿の画面・確定前の検査と同じく、版を作った時刻で比べる。翻訳元の修正を翻訳へ黙って反映しない。
 * 翻訳を見直して変える必要が無くても、同じ本文で版を作り直せば「翻訳元の版 N を確認した」記録になる。
 */
export async function translationRecheckNeeded(
  db: DbClient,
  ctx: AuthorizationContext,
  block: Pick<DisclosureBlock, 'translationOfBlockId' | 'currentVersionId'>,
  currentVersion: Pick<DisclosureBlockVersion, 'createdAt'> | null,
): Promise<boolean> {
  if (!block.translationOfBlockId) return false;
  const source = await db.findById('disclosureBlocks', block.translationOfBlockId);
  if (
    !source ||
    source.organizationId !== ctx.workspace.organizationId ||
    source.deletedAt ||
    !source.currentVersionId
  ) {
    return false;
  }
  const sourceVersion = await db.findById('disclosureBlockVersions', source.currentVersionId);
  if (!sourceVersion) return false;
  // 確定前の検査（report-snapshot.ts の translation_stale）と同じ向きの比較にする
  return !currentVersion || currentVersion.createdAt < sourceVersion.createdAt;
}

/**
 * 本文を変えずに版を作り直してよいか。承認済みの節の範囲・適用判断の再確認と、
 * 翻訳元の修正に対する翻訳の再確認（承認前・承認後とも）に限る
 */
async function recheckWithoutTextChangeAllowed(
  db: DbClient,
  ctx: AuthorizationContext,
  block: DisclosureBlock,
  action: 'revise_after_approval' | 'save_version',
  currentVersion: DisclosureBlockVersion,
): Promise<boolean> {
  if (await translationRecheckNeeded(db, ctx, block, currentVersion)) return true;
  if (action !== 'revise_after_approval') return false;
  const project = await loadProject(db, ctx, block.projectId);
  return (
    (await scopeRecheckNeeded(db, ctx, block, project)) ||
    (await applicabilityRecheckNeeded(db, ctx, block))
  );
}

export async function saveBlockVersion(
  db: DbClient,
  ctx: AuthorizationContext,
  input: SaveBlockVersionInput,
): Promise<{ block: DisclosureBlock; version: DisclosureBlockVersion }> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const block = await loadBlock(db, ctx, input.blockId);
  const body = parseBlockBody(input.body);
  const reason = input.changeReason?.trim() || null;

  // 承認済みの節の修正は「承認後に修正」: 承認済みの版は残し、新しい版を作って下書きへ戻す
  const action = block.status === 'approved' ? 'revise_after_approval' : 'save_version';
  const transition = transitionBlock(action, block.status);
  if (!transition.ok) {
    throw new ValidationError(
      block.status === 'review_requested' || block.status === 'approval_pending'
        ? 'レビュー中の節は編集できません。依頼を取り下げてから編集してください（レビュー中の版は変わりません）。'
        : transition.reason,
    );
  }
  if (action === 'revise_after_approval' && !reason) {
    throw new ValidationError('承認後に修正する場合は、変更理由を入力してください。');
  }
  if (block.currentVersionId && !reason) {
    throw new ValidationError('版として保存するときは、変更理由を入力してください。');
  }

  const current = await currentVersionBody(db, ctx, block);
  if (block.currentVersionId && !current.version) {
    // 現在の版を読めない（Demo Mode で別インスタンスが作った版など）。空の本文を土台に上書きさせない
    throw new NotFoundError(VERSION_UNAVAILABLE_MESSAGE);
  }
  if ((input.baseVersionId ?? null) !== (block.currentVersionId ?? null)) {
    throw new BlockConflictError(block.currentVersionId, current.body, body);
  }
  if (
    input.knownWorkingSavedAt !== undefined &&
    isForeignWorkingBody(block, ctx.userId, input.knownWorkingSavedAt)
  ) {
    // 別の人の自動保存を読み込まないまま版を作ると、その人の作業本文を黙って捨ててしまう
    throw new BlockConflictError(
      block.currentVersionId,
      block.workingBody ?? emptyBody(),
      body,
      'working',
    );
  }
  if (!hasBodyContent(body) && !block.currentVersionId) {
    throw new ValidationError('本文が空のため、版を作れません。');
  }
  if (current.version && current.version.contentHash === contentHashOf(body)) {
    // 上流の前提（報告範囲・適用判断・翻訳元）の変更後の再確認は、本文が同じでも新しい版として
    // 再承認に回せる（本文を変えずに「変更を確認した」ことを承認の記録として残すため。
    // これが無いと、確定を止める再確認は無意味な文言の変更でしか解消できない）
    if (!(await recheckWithoutTextChangeAllowed(db, ctx, block, action, current.version))) {
      throw new ValidationError('前の版から本文が変わっていません。');
    }
  }

  const issues = await validateBodyRefs(db, ctx, block.id, body);
  if (issues.length > 0) throw new BlockRefValidationError(issues);

  const version = await appendBlockVersion(db, ctx, block, body, {
    changeReason: reason ?? (block.currentVersionId ? null : '初版'),
    baseVersionId: block.currentVersionId,
  });

  const now = new Date().toISOString();
  const updated = await db.update('disclosureBlocks', block.id, {
    currentVersionId: version.id,
    status: transition.to,
    // 作業本文と書いた人の記録はこの版に取り込んだので空にする（次の自動保存はこの版を土台にする）
    ...CLEARED_WORKING_COLUMNS,
    updatedAt: now,
    updatedBy: ctx.userId,
  });
  return { block: updated, version };
}

// ======================================================================
// 節の追加（新しい節・翻訳版）
// ======================================================================

export interface CreateBlockInput {
  projectId: Uuid;
  frameworkVersionId: Uuid;
  sectionKey: string;
  title: string;
  language: DisclosureLanguage;
  translationOfBlockId?: Uuid | null;
  requirementItemIds?: Uuid[];
  ownerUserId?: Uuid | null;
  dueDate?: IsoDate | null;
}

export async function createBlock(
  db: DbClient,
  ctx: AuthorizationContext,
  input: CreateBlockInput,
): Promise<DisclosureBlock> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const organizationId = ctx.workspace.organizationId;
  const project = await loadProject(db, ctx, input.projectId);

  const sectionKey = input.sectionKey.trim();
  const title = input.title.trim();
  if (!/^[a-z0-9_-]{1,60}$/.test(sectionKey)) {
    throw new ValidationError(
      '節のキーは半角英小文字・数字・_・- の 60 文字以内で入力してください。',
    );
  }
  if (!title) throw new ValidationError('節の題名を入力してください。');
  if (input.language !== 'ja' && input.language !== 'en') {
    throw new ValidationError('言語が正しくありません。');
  }

  // 節の基準は、プロジェクトに登録した基準の版に限る（DB の外部キー相当の規則と同じ）
  const attached = await db.select('projectFrameworks', {
    where: { organizationId, projectId: project.id, frameworkVersionId: input.frameworkVersionId },
  });
  if (attached.length === 0) {
    throw new ValidationError('プロジェクトに登録していない基準の版には節を作れません。');
  }

  const siblings = await db.select('disclosureBlocks', {
    where: { organizationId, projectId: project.id, deletedAt: { isNull: true } },
  });

  let translationOf: DisclosureBlock | null = null;
  if (input.translationOfBlockId) {
    translationOf = siblings.find((b) => b.id === input.translationOfBlockId) ?? null;
    if (!translationOf) throw new ValidationError('翻訳元の節が同じプロジェクトにありません。');
    if (translationOf.language === input.language) {
      throw new ValidationError('翻訳版は翻訳元と別の言語にしてください。');
    }
  }
  if (siblings.some((b) => b.sectionKey === sectionKey && b.language === input.language)) {
    throw new ValidationError('同じ節のキー・言語の節が既にあります。');
  }

  const requirementItemIds = [...new Set(input.requirementItemIds ?? [])];
  if (requirementItemIds.length > 0) {
    const items = await db.select('disclosureItems', {
      where: { id: { in: requirementItemIds }, frameworkVersionId: input.frameworkVersionId },
    });
    if (items.length !== requirementItemIds.length) {
      throw new ValidationError('選択した基準の版に無い要求事項が含まれています。');
    }
  }

  const now = new Date().toISOString();
  const block: DisclosureBlock = {
    id: fid('disclosure_block', `${project.id}/${sectionKey}/${input.language}/${now}`),
    organizationId,
    projectId: project.id,
    frameworkVersionId: input.frameworkVersionId,
    sectionKey,
    title,
    sortOrder:
      (translationOf?.sortOrder ?? siblings.reduce((max, b) => Math.max(max, b.sortOrder), 0)) +
      (translationOf ? 1 : 10),
    language: input.language,
    translationOfBlockId: translationOf?.id ?? null,
    requirementItemIds: requirementItemIds.length
      ? requirementItemIds
      : (translationOf?.requirementItemIds ?? []),
    ownerUserId: input.ownerUserId ?? ctx.userId,
    dueDate: input.dueDate ?? translationOf?.dueDate ?? project.dueDate,
    status: 'draft',
    // 版はまだ無い（ポインタは null で作り、版を作ったときに更新する）
    currentVersionId: null,
    submittedVersionId: null,
    approvedVersionId: null,
    ...CLEARED_WORKING_COLUMNS,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  };
  await db.insert('disclosureBlocks', [block]);
  await recordAuditEvent(db, ctx, {
    eventType: 'project_updated',
    resourceType: 'disclosure_project',
    resourceId: project.id,
    afterSummary: `節を追加: ${title}（${DISCLOSURE_LANGUAGE_LABELS[input.language]}）`,
    metadata: { blockId: block.id, translationOf: translationOf?.id ?? null },
  });
  return block;
}

// ======================================================================
// 参照の挿入（サーバーで表示文字列を決め、クライアントはそのまま差し込む）
// ======================================================================

/** 数値参照の要素を作る。表示は版の値から作り、クライアントの文字列を使わない */
export async function buildMetricInline(
  db: DbClient,
  ctx: AuthorizationContext,
  dataPointVersionId: Uuid,
): Promise<Extract<BlockInline, { t: 'metric' }>> {
  assertCan(ctx, 'enterprise.disclosure.read');
  const version = await db.findById('dataPointVersions', dataPointVersionId);
  if (!version || version.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('数値の版が見つかりません。');
  }
  if (version.availabilityStatus !== 'value_present') {
    throw new ValidationError('値が無い数値（未入力・対象外など）は本文へ引用できません。');
  }
  return {
    t: 'metric',
    dataPointId: version.dataPointId,
    dataPointVersionId: version.id,
    display: metricDisplay(version),
  };
}

/** 定性情報の引用要素を作る。版の ID と、採用時点の本文（または一部）を持つ */
export async function buildNarrativeInline(
  db: DbClient,
  ctx: AuthorizationContext,
  narrativeVersionId: Uuid,
  quote?: string,
): Promise<Extract<BlockInline, { t: 'narrative' }>> {
  assertCan(ctx, 'enterprise.disclosure.read');
  const version = await db.findById('narrativeVersions', narrativeVersionId);
  if (!version || version.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('定性情報の版が見つかりません。');
  }
  const text = quote?.trim() || version.body;
  if (!version.body.includes(text)) {
    throw new ValidationError('引用文が定性情報の版の本文に含まれていません。');
  }
  return { t: 'narrative', narrativeVersionId: version.id, quote: text };
}

// ======================================================================
// 画面用のデータ（原稿編集）
// ======================================================================

export interface EditorMember {
  userId: Uuid;
  displayName: string;
  permissions: PermissionKey[];
}

export async function loadMembers(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<Map<Uuid, EditorMember>> {
  const members = await listMembers(db, ctx);
  return new Map(
    members.map((m) => [
      m.userId,
      {
        userId: m.userId,
        displayName: m.displayName,
        permissions: [...permissionsFor(m.roleKeys)],
      },
    ]),
  );
}

const EVENT_ORDER: Record<ReviewEvent['eventType'], number> = {
  requested: 0,
  review_completed: 1,
  returned: 2,
  approved: 3,
  withdrawn: 4,
};

/** レビューの記録を起きた順に並べる（同じ時刻なら手続の順） */
export function sortReviewEvents<T extends Pick<ReviewEvent, 'createdAt' | 'eventType' | 'id'>>(
  events: readonly T[],
): T[] {
  return [...events].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      EVENT_ORDER[a.eventType] - EVENT_ORDER[b.eventType] ||
      a.id.localeCompare(b.id),
  );
}

export function nameOf(members: Map<Uuid, EditorMember>, userId: Uuid | null | undefined): string {
  if (!userId) return '未割当';
  return members.get(userId)?.displayName ?? '（組織外または退職）';
}

export interface EditorVersion {
  id: Uuid;
  versionNo: number;
  createdAt: IsoDateTime;
  createdByName: string;
  changeReason: string | null;
  originLabel: string;
  isCurrent: boolean;
  isApproved: boolean;
  isSubmitted: boolean;
}

export interface EditorMetricRef {
  dataPointId: Uuid;
  dataPointVersionId: Uuid;
  metricName: string;
  unitName: string;
  periodLabel: string;
  boundary: string;
  unitOfMeasure: string;
  methodology: string | null;
  referenced: {
    versionNo: number;
    display: string;
    approved: boolean;
    valueKindLabel: string;
    sourceReference: string | null;
  } | null;
  current: {
    versionId: Uuid;
    versionNo: number;
    display: string;
    approved: boolean;
    changeReason: string | null;
  } | null;
  stale: boolean;
  evidenceCount: number;
  paragraphIds: string[];
}

export interface EditorMetricCandidate {
  key: string;
  metricName: string;
  unitName: string;
  boundary: string;
  periodLabel: string;
  versionNo: number;
  display: string;
  approved: boolean;
  inline: Extract<BlockInline, { t: 'metric' }>;
  value: number | null;
  unitOfMeasure: string;
}

export interface EditorNarrative {
  recordId: Uuid;
  versionId: Uuid;
  title: string;
  themeLabel: string;
  statusLabel: string;
  versionNo: number;
  periodLabel: string;
  body: string;
  /** 確認済みの版か（record.confirmedVersionId と一致） */
  confirmed: boolean;
  /** 台帳の現在の版（これより古い版の引用は「古い参照」） */
  currentVersionId: Uuid | null;
  missingFieldLabels: string[];
  /** 財務的影響を定量化しない理由（未記入の代わりに示す） */
  notQuantifiedNote: string | null;
  paragraphIds: string[];
}

export interface EditorAnchor {
  id: Uuid;
  fileName: string;
  editionLabel: string | null;
  usagePurpose: EvidenceUsagePurpose | null;
  usageLabel: string;
  locator: string | null;
  quoteText: string;
  fileDeleted: boolean;
  fileId: Uuid | null;
  paragraphIds: string[];
}

export interface EditorRequirement {
  id: Uuid;
  code: string;
  section: string;
  text: string;
  required: boolean;
}

export interface EditorComment {
  id: Uuid;
  paragraphId: string | null;
  body: string;
  severity: 'info' | 'major';
  severityLabel: string;
  versionNo: number | null;
  authorName: string;
  createdAt: IsoDateTime;
  resolved: boolean;
  resolvedByName: string | null;
  resolvedAt: IsoDateTime | null;
  resolutionNote: string | null;
}

export interface EditorHandwrittenWarning {
  paragraphId: string;
  text: string;
  candidates: Array<{ label: string; display: string; sameValue: boolean }>;
}

export interface EditorStatusItem {
  count: number;
  paragraphIds: string[];
}

export interface EditorReviewEvent {
  id: Uuid;
  label: string;
  stageLabel: string;
  actorName: string;
  createdAt: IsoDateTime;
  reason: string | null;
  paragraphId: string | null;
}

export interface EditorReviewRequest {
  id: Uuid;
  status: ReviewRequest['status'];
  statusLabel: string;
  targetVersionId: Uuid;
  targetVersionNo: number | null;
  requestedByName: string;
  reviewerName: string;
  approverName: string;
  policyVersion: string;
  createdAt: IsoDateTime;
  events: EditorReviewEvent[];
}

export interface EditorPriorYear {
  projectName: string;
  periodLabel: string;
  blockTitle: string;
  versionNo: number;
  approved: boolean;
  body: BlockBody;
  paragraphDiff: ParagraphDiff[];
  metadata: Array<{ label: string; prior: string; current: string; changed: boolean }>;
}

export interface EditorSibling {
  id: Uuid;
  title: string;
  statusLabel: string;
  status: BlockStatus;
  language: DisclosureLanguage;
  freshness: BlockFreshness['status'];
}

export interface BlockEditorData {
  project: {
    id: Uuid;
    name: string;
    periodStart: IsoDate;
    periodEnd: IsoDate;
    periodLabel: string;
    reportingEntity: string;
  };
  block: {
    id: Uuid;
    title: string;
    sectionKey: string;
    status: BlockStatus;
    statusLabel: string;
    language: DisclosureLanguage;
    languageLabel: string;
    translationOfTitle: string | null;
    /** 翻訳元の節に、この翻訳版より後の版がある（翻訳の要確認） */
    translationNeedsCheck: boolean;
    ownerName: string;
    ownerUserId: Uuid | null;
    dueDate: IsoDate | null;
    currentVersionId: Uuid | null;
    approvedVersionId: Uuid | null;
    submittedVersionId: Uuid | null;
    /** 画面が読み込んだ作業本文の保存時刻。自動保存・版の保存で送り返し、別の人の保存との競合を検出する */
    workingSavedAt: IsoDateTime | null;
    /** 作業本文を最後に自動保存したのが別の人なら、その人の名前（画面で知らせる） */
    workingUpdatedByOtherName: string | null;
    /**
     * 作業本文を最後に自動保存したのが、画面を開いた本人か。作業本文そのものは Demo Mode では別のサーバーに
     * 無いことがあるが、この記録（working_updated_by）は Cookie でも持ち回し、版の保存・レビュー依頼・
     * 開示デモのリセットで消える。画面はこれが真のときだけ、タブに控えた自動保存の本文を戻す
     * （リセットや版の保存の後に古い控えを戻さない）
     */
    workingSavedByViewer: boolean;
    /** 報告範囲の変更より前に承認された（再確認・再承認が必要） */
    scopeRecheckNeeded: boolean;
    /** 適用判断を確定し直す前に承認された（再確認・再承認が必要。本文を変えずに版を作れる） */
    applicabilityRecheckNeeded: boolean;
  };
  framework: {
    versionId: Uuid;
    label: string;
    legalStatusLabel: string | null;
    coverageLabel: string | null;
    isDraftStandard: boolean;
  };
  /** 編集の土台（作業本文があればそれ） */
  body: BlockBody;
  bodyFromWorking: boolean;
  /** 作業本文の土台が現在の版と違う（別の人が先に版を保存した） */
  workingConflict: boolean;
  currentVersionBody: BlockBody;
  versions: EditorVersion[];
  siblings: EditorSibling[];
  requirements: EditorRequirement[];
  metricRefs: EditorMetricRef[];
  metricCandidates: EditorMetricCandidate[];
  narratives: EditorNarrative[];
  anchors: EditorAnchor[];
  canReadEvidence: boolean;
  comments: EditorComment[];
  priorYear: EditorPriorYear | null;
  handwrittenWarnings: EditorHandwrittenWarning[];
  statusBar: {
    unresolvedComments: EditorStatusItem;
    staleRefs: EditorStatusItem;
    unapprovedMetrics: EditorStatusItem;
    unverifiedClaims: EditorStatusItem;
  };
  blockers: BlockBlocker[];
  freshness: BlockFreshness;
  activeRequest: EditorReviewRequest | null;
  reviewHistory: EditorReviewRequest[];
  permissions: {
    canWrite: boolean;
    canApprove: boolean;
    canRunAi: boolean;
    /** 自動保存・版の保存ができる状態か */
    editable: boolean;
    /** 承認済み: 保存すると新しい版になり、下書きへ戻る */
    reviseAfterApproval: boolean;
    readOnlyReason: string | null;
  };
}

function normalizeUnit(unit: string): string {
  return unit
    .replace(/CO₂/g, 'CO2')
    .replace(/^tCO2e$/, 't-CO2e')
    .replace(/^千tCO2e$/, '千t-CO2e')
    .replace(/％/g, '%')
    .replace(/^名$/, '人')
    .trim();
}

/** 前の報告期間の同じ節（同じ節のキー・言語）。承認済みの版を優先する */
export async function findPriorYearBlock(
  db: DbClient,
  ctx: AuthorizationContext,
  project: DisclosureProject,
  block: DisclosureBlock,
): Promise<{
  project: DisclosureProject;
  block: DisclosureBlock;
  version: DisclosureBlockVersion;
  periodLabel: string;
} | null> {
  const organizationId = ctx.workspace.organizationId;
  const periods = await db.select('periods', { where: { organizationId } });
  const current = periods.find((p) => p.id === project.reportingPeriodId);
  const currentStart = current?.startDate ?? project.periodStart;
  // 前年は決算日が同じ期間（暦年の期間を年度の前年にしない。plan K10）
  const previous = current
    ? previousComparablePeriod(current, periods, 'end')
    : periods
        .filter((p) => p.endDate < currentStart)
        .sort((a, b) => (a.endDate < b.endDate ? 1 : -1))[0];
  if (!previous) return null;

  const projects = await db.select('disclosureProjects', {
    where: { organizationId, reportingPeriodId: previous.id, deletedAt: { isNull: true } },
    orderBy: [{ column: 'createdAt', dir: 'desc' }],
  });
  for (const candidate of projects) {
    const blocks = await db.select('disclosureBlocks', {
      where: {
        organizationId,
        projectId: candidate.id,
        sectionKey: block.sectionKey,
        language: block.language,
        deletedAt: { isNull: true },
      },
    });
    for (const priorBlock of blocks) {
      const versionId = priorBlock.approvedVersionId ?? priorBlock.currentVersionId;
      if (!versionId) continue;
      const version = await db.findById('disclosureBlockVersions', versionId);
      if (version && version.organizationId === organizationId) {
        return { project: candidate, block: priorBlock, version, periodLabel: previous.label };
      }
    }
  }
  return null;
}

function paragraphsCiting(body: BlockBody, match: (inline: BlockInline) => boolean): string[] {
  return body.paragraphs.filter((p) => p.children.some(match)).map((p) => p.id);
}

export async function getBlockEditorData(
  db: DbClient,
  ctx: AuthorizationContext,
  projectId: Uuid,
  blockId: Uuid,
): Promise<BlockEditorData> {
  const organizationId = ctx.workspace.organizationId;
  const block = await loadBlock(db, ctx, blockId);
  if (block.projectId !== projectId) throw new NotFoundError('節が見つかりません。');
  const project = await loadProject(db, ctx, projectId);

  const [
    members,
    versions,
    periods,
    frameworkVersion,
    siblingsRaw,
    requirementItems,
    commentsRaw,
    requests,
  ] = await Promise.all([
    loadMembers(db, ctx),
    listBlockVersions(db, ctx, block.id),
    db.select('periods', { where: { organizationId } }),
    db.findById('frameworkVersions', block.frameworkVersionId),
    db.select('disclosureBlocks', {
      where: { organizationId, projectId, deletedAt: { isNull: true } },
      orderBy: [{ column: 'sortOrder' }, { column: 'id' }],
    }),
    block.requirementItemIds.length
      ? db.select('disclosureItems', { where: { id: { in: block.requirementItemIds } } })
      : Promise.resolve([]),
    db.select('reviewComments', {
      where: { organizationId, blockId: block.id },
      orderBy: [{ column: 'createdAt' }, { column: 'id' }],
    }),
    db.select('reviewRequests', {
      where: { organizationId, targetType: 'disclosure_block', targetId: block.id },
      orderBy: [{ column: 'createdAt', dir: 'desc' }, { column: 'id' }],
    }),
  ]);

  const periodLabel = (id: Uuid) => periods.find((p) => p.id === id)?.label ?? '—';
  const versionById = new Map(versions.map((v) => [v.id, v]));
  const editing = await editingBodyOf(db, ctx, block);
  const body = editing.body;
  const currentBody = editing.version?.body ?? emptyBody();
  const refs = collectRefs(body);

  // --- 数値（引用中・挿入候補） -----------------------------------------------
  const [metrics, units, projectDataPoints] = await Promise.all([
    db.select('metrics', { where: { organizationId } }),
    db.select('units', { where: { organizationId } }),
    db.select('dataPoints', {
      where: {
        organizationId,
        reportingPeriodId: project.reportingPeriodId,
        deletedAt: { isNull: true },
      },
    }),
  ]);
  const metricById = new Map(metrics.map((m) => [m.id, m]));
  const unitById = new Map(units.map((u) => [u.id, u]));

  const citedVersions = (
    await Promise.all(refs.metricVersionIds.map((id) => db.findById('dataPointVersions', id)))
  ).filter((v): v is DataPointVersion => v !== null && v.organizationId === organizationId);
  const citedDpIds = [...new Set(citedVersions.map((v) => v.dataPointId))];
  const citedDataPoints = (
    await Promise.all(citedDpIds.map((id) => db.findById('dataPoints', id)))
  ).filter((d): d is DataPoint => d !== null && d.organizationId === organizationId);
  const dpById = new Map([...projectDataPoints, ...citedDataPoints].map((d) => [d.id, d]));
  const currentVersionIds = [...dpById.values()]
    .map((d) => d.currentVersionId)
    .filter((id): id is Uuid => Boolean(id));
  const currentVersions = currentVersionIds.length
    ? await db.select('dataPointVersions', { where: { id: { in: currentVersionIds } } })
    : [];
  const dpvById = new Map([...citedVersions, ...currentVersions].map((v) => [v.id, v]));
  const approvedIds = await approvedDataPointVersionIds(db, ctx, [...dpById.keys()]);
  const evidenceLinks = citedDpIds.length
    ? await db.select('evidenceLinks', {
        where: { organizationId, targetType: 'data_point', targetId: { in: citedDpIds } },
      })
    : [];

  const metricLabel = (dp: DataPoint) => metricById.get(dp.metricId)?.name ?? '指標';
  const unitLabel = (dp: DataPoint) => unitById.get(dp.unitId)?.name ?? '—';

  const metricRefs: EditorMetricRef[] = refs.metricVersionIds.flatMap((versionId) => {
    const version = dpvById.get(versionId);
    if (!version) return [];
    const dp = dpById.get(version.dataPointId);
    if (!dp) return [];
    const current = dp.currentVersionId ? dpvById.get(dp.currentVersionId) : undefined;
    return [
      {
        dataPointId: dp.id,
        dataPointVersionId: version.id,
        metricName: metricLabel(dp),
        unitName: unitLabel(dp),
        periodLabel: periodLabel(dp.reportingPeriodId),
        boundary: dp.boundary,
        unitOfMeasure: version.unitOfMeasure,
        methodology: dp.methodology,
        referenced: {
          versionNo: version.versionNo,
          display: metricDisplay(version),
          approved: isVersionApproved(version, dp, approvedIds),
          valueKindLabel:
            version.valueKind === 'estimate'
              ? '推計'
              : version.valueKind === 'target'
                ? '目標'
                : '実績',
          sourceReference: version.sourceReference,
        },
        current: current
          ? {
              versionId: current.id,
              versionNo: current.versionNo,
              display: metricDisplay(current),
              approved: isVersionApproved(current, dp, approvedIds),
              changeReason: current.changeReason,
            }
          : null,
        stale: Boolean(dp.currentVersionId && dp.currentVersionId !== version.id),
        evidenceCount: evidenceLinks.filter((l) => l.targetId === dp.id).length,
        paragraphIds: paragraphsCiting(
          body,
          (i) => i.t === 'metric' && i.dataPointVersionId === version.id,
        ),
      },
    ];
  });

  const metricCandidates: EditorMetricCandidate[] = projectDataPoints
    .flatMap((dp) => {
      const version = dp.currentVersionId ? dpvById.get(dp.currentVersionId) : undefined;
      if (!version || version.availabilityStatus !== 'value_present') return [];
      return [
        {
          key: version.id,
          metricName: metricLabel(dp),
          unitName: unitLabel(dp),
          boundary: dp.boundary,
          periodLabel: periodLabel(dp.reportingPeriodId),
          versionNo: version.versionNo,
          display: metricDisplay(version),
          approved: isVersionApproved(version, dp, approvedIds),
          inline: {
            t: 'metric' as const,
            dataPointId: dp.id,
            dataPointVersionId: version.id,
            display: metricDisplay(version),
          },
          value: version.value,
          unitOfMeasure: version.unitOfMeasure,
        },
      ];
    })
    .sort(
      (a, b) =>
        Number(b.approved) - Number(a.approved) ||
        a.metricName.localeCompare(b.metricName, 'ja') ||
        a.unitName.localeCompare(b.unitName, 'ja'),
    );

  // --- 定性情報 ---------------------------------------------------------------
  const records = await db.select('narrativeRecords', {
    where: { organizationId, deletedAt: { isNull: true } },
    orderBy: [{ column: 'title' }],
  });
  const recordIds = records.map((r) => r.id);
  const narrativeVersions = recordIds.length
    ? await db.select('narrativeVersions', {
        where: { organizationId, narrativeRecordId: { in: recordIds } },
      })
    : [];
  const nvById = new Map(narrativeVersions.map((v) => [v.id, v]));
  const recordById = new Map(records.map((r) => [r.id, r]));
  const narrativeView = (versionId: Uuid): EditorNarrative | null => {
    const version = nvById.get(versionId);
    if (!version) return null;
    const record = recordById.get(version.narrativeRecordId);
    if (!record) return null;
    return {
      recordId: record.id,
      versionId: version.id,
      title: record.title,
      themeLabel: NARRATIVE_THEME_LABELS[record.theme],
      statusLabel: NARRATIVE_STATUS_LABELS[record.status],
      versionNo: version.versionNo,
      periodLabel: periodLabel(version.reportingPeriodId),
      body: version.body,
      confirmed: record.confirmedVersionId === version.id,
      currentVersionId: record.currentVersionId,
      ...(() => {
        // 原稿一覧・スナップショットと同じ判定（domain/narrative-template.ts）
        const assessed = assessNarrativeFields(record.theme, version.fields);
        return {
          missingFieldLabels: assessed.missing.map((f) => f.label),
          notQuantifiedNote: assessed.notQuantifiedReason
            ? notQuantifiedNote(assessed.notQuantifiedReason)
            : null,
        };
      })(),
      paragraphIds: paragraphsCiting(
        body,
        (i) => i.t === 'narrative' && i.narrativeVersionId === version.id,
      ),
    };
  };
  const narrativeIds = new Set<Uuid>([
    ...refs.narrativeVersionIds,
    ...records.map((r) => r.currentVersionId).filter((id): id is Uuid => Boolean(id)),
  ]);
  const narratives = [...narrativeIds]
    .map(narrativeView)
    .filter((n): n is EditorNarrative => n !== null);

  // --- 根拠資料（引用位置）。資料の閲覧権限が無ければ出さない（A30） --------------------
  const canReadEvidence = can(ctx, 'enterprise.evidence.read');
  let anchors: EditorAnchor[] = [];
  if (canReadEvidence) {
    const anchorRows = await db.select('sourceAnchors', {
      where: { organizationId },
      orderBy: [{ column: 'createdAt' }, { column: 'id' }],
    });
    const fileVersionIds = [...new Set(anchorRows.map((a) => a.fileVersionId))];
    const fileVersions = fileVersionIds.length
      ? await db.select('fileVersions', { where: { id: { in: fileVersionIds } } })
      : [];
    const fileIds = [...new Set(fileVersions.map((v) => v.fileId))];
    const files = fileIds.length
      ? await db.select('files', { where: { id: { in: fileIds } } })
      : [];
    const fileByVersion = new Map(
      fileVersions.map((v) => [v.id, files.find((f) => f.id === v.fileId) ?? null]),
    );
    anchors = anchorRows.map((a) => {
      const file = fileByVersion.get(a.fileVersionId) ?? null;
      return {
        id: a.id,
        fileName: file?.originalName ?? '（資料が見つかりません）',
        editionLabel: file?.editionLabel ?? null,
        usagePurpose: file?.usagePurpose ?? null,
        usageLabel: file?.usagePurpose
          ? EVIDENCE_USAGE_PURPOSE_LABELS[file.usagePurpose]
          : '利用目的が未設定',
        locator: a.locator,
        quoteText: a.quoteText,
        fileDeleted: !file || file.deletedAt !== null,
        fileId: file?.id ?? null,
        paragraphIds: paragraphsCiting(body, (i) => i.t === 'cite' && i.sourceAnchorId === a.id),
      };
    });
  }

  // --- コメント -----------------------------------------------------------------
  const comments: EditorComment[] = commentsRaw.map((c) => ({
    id: c.id,
    paragraphId: c.paragraphId,
    body: c.body,
    severity: c.severity,
    severityLabel: REVIEW_COMMENT_SEVERITY_LABELS[c.severity],
    versionNo: versionById.get(c.blockVersionId)?.versionNo ?? null,
    authorName: nameOf(members, c.createdBy),
    createdAt: c.createdAt,
    resolved: c.resolvedAt !== null,
    resolvedByName: c.resolvedBy ? nameOf(members, c.resolvedBy) : null,
    resolvedAt: c.resolvedAt,
    resolutionNote: c.resolutionNote,
  }));

  // --- 前年 ---------------------------------------------------------------------
  let priorYear: EditorPriorYear | null = null;
  const prior = await findPriorYearBlock(db, ctx, project, block);
  if (prior) {
    const priorRefs = collectRefs(prior.version.body);
    const priorMetricVersions = (
      await Promise.all(
        priorRefs.metricVersionIds.map((id) => db.findById('dataPointVersions', id)),
      )
    ).filter((v): v is DataPointVersion => v !== null && v.organizationId === organizationId);
    const priorDps = (
      await Promise.all(priorMetricVersions.map((v) => db.findById('dataPoints', v.dataPointId)))
    ).filter((d): d is DataPoint => d !== null);
    const describeMetrics = (
      list: Array<{ version: DataPointVersion; dp: DataPoint | undefined }>,
    ): string =>
      list.length === 0
        ? 'なし'
        : list
            .map(({ version, dp }) =>
              dp
                ? `${metricLabel(dp)}（${unitLabel(dp)}・${dp.boundary}・${periodLabel(dp.reportingPeriodId)}）: ${metricDisplay(version)}`
                : metricDisplay(version),
            )
            .join(' ／ ');
    const priorFramework = await db.findById('frameworkVersions', prior.block.frameworkVersionId);
    const priorRequirementCodes = prior.block.requirementItemIds.length
      ? (
          await db.select('disclosureItems', {
            where: { id: { in: prior.block.requirementItemIds } },
          })
        ).map((i) => i.code)
      : [];
    const narrativeTitles = (ids: Uuid[]) =>
      ids.length === 0
        ? 'なし'
        : ids
            .map((id) => {
              const v = nvById.get(id);
              const r = v ? recordById.get(v.narrativeRecordId) : undefined;
              return r && v
                ? `${r.title}（版 ${v.versionNo}・${periodLabel(v.reportingPeriodId)}）`
                : '（不明な版）';
            })
            .join(' ／ ');
    const rows: Array<[string, string, string]> = [
      ['基準・版', priorFramework?.label ?? '—', frameworkVersion?.label ?? '—'],
      [
        '対象期間',
        `${prior.project.periodStart} 〜 ${prior.project.periodEnd}`,
        `${project.periodStart} 〜 ${project.periodEnd}`,
      ],
      ['報告主体', prior.project.reportingEntity, project.reportingEntity],
      ['対象範囲（組織）', prior.project.scopeOrgNote, project.scopeOrgNote],
      ['連結の範囲', prior.project.scopeConsolidationNote, project.scopeConsolidationNote],
      ['GHG の算定範囲・方法', prior.project.scopeGhgBoundaryNote, project.scopeGhgBoundaryNote],
      ['バリューチェーンの範囲', prior.project.scopeValueChainNote, project.scopeValueChainNote],
      [
        '要求事項',
        priorRequirementCodes.join('、') || 'なし',
        requirementItems.map((i) => i.code).join('、') || 'なし',
      ],
      [
        '引用した数値',
        describeMetrics(
          priorMetricVersions.map((version) => ({
            version,
            dp: priorDps.find((d) => d.id === version.dataPointId),
          })),
        ),
        describeMetrics(
          citedVersions.map((version) => ({ version, dp: dpById.get(version.dataPointId) })),
        ),
      ],
      [
        '引用した定性情報',
        narrativeTitles(priorRefs.narrativeVersionIds),
        narrativeTitles(refs.narrativeVersionIds),
      ],
    ];
    priorYear = {
      projectName: prior.project.name,
      periodLabel: prior.periodLabel,
      blockTitle: prior.block.title,
      versionNo: prior.version.versionNo,
      approved: prior.block.approvedVersionId === prior.version.id,
      body: prior.version.body,
      paragraphDiff: diffParagraphs(prior.version.body, body),
      metadata: rows.map(([label, before, after]) => ({
        label,
        prior: before || '—',
        current: after || '—',
        changed: (before || '') !== (after || ''),
      })),
    };
  }

  // --- 手書き数値の警告（同じ単位の参照可能な指標値があるときだけ） ---------------------------
  const handwrittenWarnings: EditorHandwrittenWarning[] = detectHandwrittenNumbers(body).flatMap(
    (found) => {
      const candidates = metricCandidates
        .filter((c) => normalizeUnit(c.unitOfMeasure) === found.unit)
        .slice(0, 5)
        .map((c) => ({
          label: `${c.metricName}（${c.unitName}・${c.boundary}）`,
          display: c.display,
          sameValue: c.value === found.value,
        }));
      if (candidates.length === 0) return [];
      return [{ paragraphId: found.paragraphId, text: found.text, candidates }];
    },
  );

  // --- 状態バー ---------------------------------------------------------------------
  const unique = (ids: string[]) => [...new Set(ids)];
  const unresolved = comments.filter((c) => !c.resolved);
  const staleNarratives = narratives.filter(
    (n) =>
      n.paragraphIds.length > 0 &&
      n.currentVersionId !== null &&
      n.currentVersionId !== n.versionId,
  );
  const staleParagraphs = unique([
    ...metricRefs.filter((m) => m.stale).flatMap((m) => m.paragraphIds),
    ...staleNarratives.flatMap((n) => n.paragraphIds),
  ]);
  const unapprovedParagraphs = unique(
    metricRefs.filter((m) => m.referenced && !m.referenced.approved).flatMap((m) => m.paragraphIds),
  );
  const unverifiedParagraphs = unique([
    ...narratives
      .filter((n) => n.paragraphIds.length > 0 && !n.confirmed)
      .flatMap((n) => n.paragraphIds),
    // AI の候補を採用したが、数値・定性情報・出典のどれも付いていない段落
    ...body.paragraphs
      .filter(
        (p) =>
          p.kind === 'paragraph' &&
          p.aiRunId &&
          paragraphText(p).trim() &&
          !p.children.some((i) => i.t !== 'text'),
      )
      .map((p) => p.id),
    ...handwrittenWarnings.map((w) => w.paragraphId),
  ]);

  // --- 阻害条件・鮮度（レビュー依頼と同じ判定） --------------------------------------
  const blockers = await evaluateBlockBlockersFor(db, ctx, block, body);
  const freshness = await computeBlockFreshness(db, ctx, block);

  // --- レビュー ---------------------------------------------------------------------
  const requestIds = requests.map((r) => r.id);
  const events = requestIds.length
    ? sortReviewEvents(
        await db.select('reviewEvents', {
          where: { organizationId, reviewRequestId: { in: requestIds } },
        }),
      )
    : [];
  const requestView = (r: ReviewRequest): EditorReviewRequest => ({
    id: r.id,
    status: r.status,
    statusLabel: REVIEW_REQUEST_STATUS_LABELS[r.status],
    targetVersionId: r.targetVersionId,
    targetVersionNo: versionById.get(r.targetVersionId)?.versionNo ?? null,
    requestedByName: nameOf(members, r.requestedBy),
    reviewerName: nameOf(members, r.reviewerUserId),
    approverName: nameOf(members, r.approverUserId),
    policyVersion: r.policyVersion,
    createdAt: r.createdAt,
    events: events
      .filter((e) => e.reviewRequestId === r.id)
      .map((e) => ({
        id: e.id,
        label: REVIEW_EVENT_TYPE_LABELS[e.eventType],
        stageLabel: REVIEW_STAGE_LABELS[e.stage],
        actorName: nameOf(members, e.actorUserId),
        createdAt: e.createdAt,
        reason: e.reason,
        paragraphId: e.paragraphId,
      })),
  });
  const active = requests.find((r) => r.status === 'open' || r.status === 'reviewed') ?? null;

  // --- 権限と編集可否 ---------------------------------------------------------------
  const canWrite = can(ctx, 'enterprise.disclosure.write');
  const versionUnavailable = Boolean(block.currentVersionId) && !editing.version;
  const editableStatus =
    !versionUnavailable && (block.status === 'draft' || block.status === 'returned');
  const reviseAfterApproval = !versionUnavailable && block.status === 'approved';
  const readOnlyReason = !canWrite
    ? '閲覧のみの権限です。本文の編集には開示の編集権限が必要です。'
    : versionUnavailable
      ? VERSION_UNAVAILABLE_MESSAGE
      : block.status === 'review_requested' || block.status === 'approval_pending'
        ? 'レビュー中のため編集できません。依頼を取り下げると編集できます（レビュー中の版は変わりません）。'
        : null;

  const translationOf = block.translationOfBlockId
    ? siblingsRaw.find((b) => b.id === block.translationOfBlockId)
    : undefined;
  // 翻訳元が後から修正されていれば「翻訳の要確認」（元の修正を翻訳へ黙って反映しない）。
  // 版の保存（本文が同じでも作り直せる条件）と同じ関数で判定する
  const translationNeedsCheck = await translationRecheckNeeded(db, ctx, block, editing.version);

  const siblings: EditorSibling[] = [];
  for (const sibling of siblingsRaw) {
    siblings.push({
      id: sibling.id,
      title: sibling.title,
      status: sibling.status,
      statusLabel: BLOCK_STATUS_LABELS[sibling.status],
      language: sibling.language,
      freshness:
        sibling.id === block.id
          ? freshness.status
          : (await computeBlockFreshness(db, ctx, sibling)).status,
    });
  }

  return {
    project: {
      id: project.id,
      name: project.name,
      periodStart: project.periodStart,
      periodEnd: project.periodEnd,
      periodLabel: periodLabel(project.reportingPeriodId),
      reportingEntity: project.reportingEntity,
    },
    block: {
      id: block.id,
      title: block.title,
      sectionKey: block.sectionKey,
      status: block.status,
      statusLabel: BLOCK_STATUS_LABELS[block.status],
      language: block.language,
      languageLabel: DISCLOSURE_LANGUAGE_LABELS[block.language],
      translationOfTitle: translationOf?.title ?? null,
      translationNeedsCheck,
      ownerName: nameOf(members, block.ownerUserId),
      ownerUserId: block.ownerUserId,
      dueDate: block.dueDate,
      currentVersionId: block.currentVersionId,
      approvedVersionId: block.approvedVersionId,
      submittedVersionId: block.submittedVersionId,
      workingSavedAt: workingBodyInEffect(block) ? block.workingSavedAt : null,
      workingUpdatedByOtherName:
        workingBodyInEffect(block) &&
        block.workingUpdatedBy &&
        block.workingUpdatedBy !== ctx.userId
          ? nameOf(members, block.workingUpdatedBy)
          : null,
      workingSavedByViewer: (block.workingUpdatedBy ?? null) === ctx.userId,
      scopeRecheckNeeded: await scopeRecheckNeeded(db, ctx, block, project),
      applicabilityRecheckNeeded: await applicabilityRecheckNeeded(db, ctx, block),
    },
    framework: {
      versionId: block.frameworkVersionId,
      label: frameworkVersion?.label ?? '（基準の版が見つかりません）',
      legalStatusLabel: frameworkVersion?.legalStatus
        ? FRAMEWORK_LEGAL_STATUS_LABELS[frameworkVersion.legalStatus]
        : null,
      coverageLabel: frameworkVersion?.coverageStatus
        ? FRAMEWORK_COVERAGE_STATUS_LABELS[frameworkVersion.coverageStatus]
        : null,
      isDraftStandard: frameworkVersion?.legalStatus === 'draft',
    },
    body,
    bodyFromWorking: editing.fromWorking,
    workingConflict:
      editing.fromWorking &&
      (block.workingBaseVersionId ?? null) !== (block.currentVersionId ?? null),
    currentVersionBody: currentBody,
    versions: versions.map((v) => ({
      id: v.id,
      versionNo: v.versionNo,
      createdAt: v.createdAt,
      createdByName: nameOf(members, v.createdBy),
      changeReason: v.changeReason,
      originLabel: BLOCK_VERSION_ORIGIN_LABELS[v.origin],
      isCurrent: v.id === block.currentVersionId,
      isApproved: v.id === block.approvedVersionId,
      isSubmitted: v.id === block.submittedVersionId,
    })),
    siblings,
    requirements: requirementItems
      .map((i) => ({
        id: i.id,
        code: i.code,
        section: i.section,
        text: i.questionText,
        required: i.required,
      }))
      .sort((a, b) => a.code.localeCompare(b.code, 'ja')),
    metricRefs,
    metricCandidates,
    narratives,
    anchors,
    canReadEvidence,
    comments,
    priorYear,
    handwrittenWarnings,
    statusBar: {
      unresolvedComments: {
        count: unresolved.length,
        paragraphIds: unique(
          unresolved.map((c) => c.paragraphId).filter((id): id is string => !!id),
        ),
      },
      staleRefs: { count: staleParagraphs.length, paragraphIds: staleParagraphs },
      unapprovedMetrics: { count: unapprovedParagraphs.length, paragraphIds: unapprovedParagraphs },
      unverifiedClaims: { count: unverifiedParagraphs.length, paragraphIds: unverifiedParagraphs },
    },
    blockers,
    freshness,
    activeRequest: active ? requestView(active) : null,
    reviewHistory: requests.map(requestView),
    permissions: {
      canWrite,
      canApprove: can(ctx, 'enterprise.disclosure.approve'),
      canRunAi: can(ctx, 'enterprise.ai.run') && canWrite,
      editable: canWrite && editableStatus,
      reviseAfterApproval: canWrite && reviseAfterApproval,
      readOnlyReason,
    },
  };
}

// ======================================================================
// プロジェクトの原稿一覧（原稿タブ）
// ======================================================================

/**
 * 原稿一覧の絞り込み。unresolved・changed_after_approval は開示ホームのカード
 * （未解決の必須情報・承認後に変更が発生）の遷移先で、カードと同じ判定
 * （domain/disclosure-status.ts）で絞る。カードの件数と一覧の件数を食い違わせない（指示書 §6.1）
 */
export const MANUSCRIPT_FILTERS = [
  'missing',
  'unresolved',
  'review',
  'returned',
  'recheck',
  'upstream',
  'changed_after_approval',
  'mine',
] as const;
export type ManuscriptFilter = (typeof MANUSCRIPT_FILTERS)[number];

export const MANUSCRIPT_FILTER_LABELS: Record<ManuscriptFilter, string> = {
  missing: '本文なし',
  unresolved: '未解決の必須情報',
  review: 'レビュー中',
  returned: '差戻し',
  recheck: '再確認が必要',
  upstream: '上流の変更（資料の新版を含む）',
  changed_after_approval: '承認後に変更が発生',
  mine: '自分の担当',
};

export interface ManuscriptRow {
  id: Uuid;
  title: string;
  sectionKey: string;
  language: DisclosureLanguage;
  languageLabel: string;
  translationOfTitle: string | null;
  frameworkLabel: string;
  frameworkIsDraft: boolean;
  status: BlockStatus;
  statusLabel: string;
  currentVersionNo: number | null;
  approvedVersionNo: number | null;
  hasBody: boolean;
  /** 未解決の必須情報がある（開示ホームのカードと同じ判定） */
  unresolvedRequired: boolean;
  /** 承認後に変更が発生した（開示ホームのカードと同じ判定） */
  changedAfterApproval: boolean;
  /** 引用した定性情報の未記入項目（「未解決の必須情報」の理由として一覧に出す） */
  narrativeGaps: Array<{ title: string; fields: string[] }>;
  /** 引用した定性情報の補足（財務的影響を定量化しない理由など。不足ではないが本文の判断材料として示す） */
  narrativeNotes: Array<{ title: string; note: string }>;
  freshness: BlockFreshness['status'];
  freshnessLabel: string;
  /** 引用した資料に新しい版がある（数値・定性情報の新版とは別に数える。NF-16） */
  fileUpdated: boolean;
  blockers: BlockBlocker[];
  ownerUserId: Uuid | null;
  ownerName: string;
  dueDate: IsoDate | null;
  unresolvedComments: number;
}

export interface ManuscriptList {
  rows: ManuscriptRow[];
  total: number;
  counts: Record<ManuscriptFilter, number>;
  frameworks: Array<{ versionId: Uuid; label: string }>;
  canWrite: boolean;
}

function matchesFilter(row: ManuscriptRow, filter: ManuscriptFilter, userId: Uuid): boolean {
  switch (filter) {
    case 'missing':
      return !row.hasBody;
    case 'unresolved':
      return row.unresolvedRequired;
    case 'changed_after_approval':
      return row.changedAfterApproval;
    case 'review':
      return row.status === 'review_requested' || row.status === 'approval_pending';
    case 'returned':
      return row.status === 'returned';
    case 'recheck':
      return row.freshness === 'upstream_updated' || row.freshness === 'evidence_invalid';
    case 'upstream':
      // 概要の「上流の変更で再確認が必要な節」と同じ集合（数値・定性情報の新版・根拠の失効・資料の新版）
      return (
        row.freshness === 'upstream_updated' ||
        row.freshness === 'evidence_invalid' ||
        row.fileUpdated
      );
    case 'mine':
      return row.ownerUserId === userId;
  }
}

/**
 * 本文が引用した定性情報のうち、テンプレートの項目に未記入があるもの（開示ホームと同じ数え方）と、
 * 未記入の代わりに示す補足（財務的影響を定量化しない理由）
 */
async function narrativeGapsOf(
  db: DbClient,
  ctx: AuthorizationContext,
  body: BlockBody,
): Promise<Pick<ManuscriptRow, 'narrativeGaps' | 'narrativeNotes'>> {
  const gaps: ManuscriptRow['narrativeGaps'] = [];
  const notes: ManuscriptRow['narrativeNotes'] = [];
  for (const id of collectRefs(body).narrativeVersionIds) {
    const version = await db.findById('narrativeVersions', id);
    if (!version || version.organizationId !== ctx.workspace.organizationId) continue;
    const record = await db.findById('narrativeRecords', version.narrativeRecordId);
    if (!record || record.organizationId !== ctx.workspace.organizationId) continue;
    const fields = unresolvedNarrativeFields(record.theme, version.fields);
    if (fields.length > 0) gaps.push({ title: record.title, fields });
    const reason = assessNarrativeFields(record.theme, version.fields).notQuantifiedReason;
    if (reason) notes.push({ title: record.title, note: notQuantifiedNote(reason) });
  }
  return { narrativeGaps: gaps, narrativeNotes: notes };
}

export async function listProjectBlocks(
  db: DbClient,
  ctx: AuthorizationContext,
  projectId: Uuid,
  filter: ManuscriptFilter | null = null,
): Promise<ManuscriptList> {
  const organizationId = ctx.workspace.organizationId;
  const project = await loadProject(db, ctx, projectId);
  const [blocks, members, projectFrameworks, comments] = await Promise.all([
    db.select('disclosureBlocks', {
      where: { organizationId, projectId: project.id, deletedAt: { isNull: true } },
      orderBy: [{ column: 'sortOrder' }, { column: 'id' }],
    }),
    loadMembers(db, ctx),
    db.select('projectFrameworks', { where: { organizationId, projectId: project.id } }),
    db.select('reviewComments', { where: { organizationId } }),
  ]);
  const frameworkVersions = projectFrameworks.length
    ? await db.select('frameworkVersions', {
        where: { id: { in: projectFrameworks.map((pf) => pf.frameworkVersionId) } },
      })
    : [];

  const rows: ManuscriptRow[] = [];
  for (const block of blocks) {
    const editing = await editingBodyOf(db, ctx, block);
    const approved = block.approvedVersionId
      ? await db.findById('disclosureBlockVersions', block.approvedVersionId)
      : null;
    const freshness = await computeBlockFreshness(db, ctx, block);
    // 資料の新版（引用位置の版より新しい版がある。NF-16）。読めなければ数えない
    const fileUpdated = await detectFileUpdates(db, ctx, block)
      .then((items) => items.length > 0)
      .catch(() => false);
    const blockComments = comments.filter((c) => c.blockId === block.id);
    const fv = frameworkVersions.find((v) => v.id === block.frameworkVersionId);
    const blockers = await evaluateBlockBlockersFor(db, ctx, block, editing.body);
    // 開示ホームのカードと同じ判定に渡す材料（版が読めない・定性情報の未記入・承認済みの版の鮮度）
    const versionMissing =
      !editing.fromWorking && block.currentVersionId !== null && editing.version === null;
    const { narrativeGaps, narrativeNotes } = await narrativeGapsOf(db, ctx, editing.body);
    const approvedFreshness = approved
      ? await computeBlockFreshness(db, ctx, block, approved.body)
      : null;
    const translationOf = block.translationOfBlockId
      ? blocks.find((b) => b.id === block.translationOfBlockId)
      : undefined;
    rows.push({
      id: block.id,
      title: block.title,
      sectionKey: block.sectionKey,
      language: block.language,
      languageLabel: DISCLOSURE_LANGUAGE_LABELS[block.language],
      translationOfTitle: translationOf?.title ?? null,
      frameworkLabel: fv?.label ?? '—',
      frameworkIsDraft: fv?.legalStatus === 'draft',
      status: block.status,
      statusLabel: BLOCK_STATUS_LABELS[block.status],
      currentVersionNo: editing.version?.versionNo ?? null,
      approvedVersionNo: approved?.versionNo ?? null,
      hasBody: hasBodyContent(editing.body),
      unresolvedRequired: hasUnresolvedRequiredInfo({
        status: block.status,
        versionMissing,
        narrativeGapCount: narrativeGaps.length,
        blockers,
      }),
      narrativeGaps,
      narrativeNotes,
      changedAfterApproval: isChangedAfterApproval({
        approvedVersionId: block.approvedVersionId,
        currentVersionId: block.currentVersionId,
        // 数値・定性情報の新しい版だけを見る（維持と判断済みの組み合わせは除く。ホームと同じ）
        approvedVersionHasStaleRefs:
          approvedFreshness?.items.some(
            (i) => (i.refKind === 'metric' || i.refKind === 'narrative') && !i.keptOld,
          ) ?? false,
      }),
      freshness: freshness.status,
      freshnessLabel: freshness.label,
      fileUpdated,
      blockers,
      ownerUserId: block.ownerUserId,
      ownerName: nameOf(members, block.ownerUserId),
      dueDate: block.dueDate,
      unresolvedComments: blockComments.filter((c) => c.resolvedAt === null).length,
    });
  }

  const counts = Object.fromEntries(
    MANUSCRIPT_FILTERS.map((f) => [f, rows.filter((r) => matchesFilter(r, f, ctx.userId)).length]),
  ) as Record<ManuscriptFilter, number>;

  return {
    rows: filter ? rows.filter((r) => matchesFilter(r, filter, ctx.userId)) : rows,
    total: rows.length,
    counts,
    frameworks: projectFrameworks.map((pf) => ({
      versionId: pf.frameworkVersionId,
      label: frameworkVersions.find((v) => v.id === pf.frameworkVersionId)?.label ?? '—',
    })),
    canWrite: can(ctx, 'enterprise.disclosure.write'),
  };
}
