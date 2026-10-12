import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, NotFoundError } from '@/lib/authorization/can';
import { CSRD_SECTION_LABEL } from '@/lib/domain/csrd';
import { BLOCK_STATUS_LABELS } from '@/lib/domain/disclosure-status';
import { AREA_LABEL } from '@/lib/domain/ssbj';
import { ValidationError } from '@/lib/errors/user-facing';
import {
  BlockConflictError,
  createBlock,
  isForeignWorkingBody,
  saveBlockVersion,
} from '@/lib/services/disclosure-block';
import { isUuid } from '@/lib/validation/uuid';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  BlockBody,
  BlockParagraph,
  BlockStatus,
  CsrdDisclosureDraft,
  DisclosureBlock,
  DisclosureBlockVersion,
  DisclosureProject,
  FrameworkKey,
  IsoDateTime,
  SsbjDisclosureDraft,
  Uuid,
} from '@/types/domain';

/**
 * SSBJ 開示ドラフト・CSRD 節ドラフトの確定本文を、開示プロジェクトの原稿の節へ取り込む
 * （トライアル対応 NF-19。原稿の系統を 1 つにし、レビュー・スナップショット・トレース・突合の対象にする）。
 *
 * 守っていること:
 *  - 取り込むのは**人が確定した本文**だけ（未確定の草案・AI の草案そのものは取り込まない）
 *  - 取り込みは人の操作。節の新しい版は**下書き**になり、承認は引き継がない（原稿のレビュー・承認を通す）
 *  - 同じ年度のプロジェクトで、その基準（SSBJ／CSRD）を扱うものだけ。CSRD 域外（ESRS-40a）には取り込まない
 *    （EU 法人向けの通常 ESRS のサンプルと 40a を混ぜない。NF-12）
 *  - 節はドラフトの領域ごとの専用の節（キー ssbj_draft_<領域>／csrd_draft_<節>）。無ければ作り、あれば新しい版を足す
 *    （既存の手書きの節を黙って置き換えない）。要求事項はドラフトの「根拠にした要求事項」（covered_item_codes）から
 *  - AI 由来の段落の印を保つ: AI の草案の段落と同じ段落は段落 ID を `draft-ai-` で始め、版の変更理由に件数を書く。
 *    段落の aiRunId は原稿の AI 下書き（disclosureBlockDraft）専用の検査があるため付けない
 *  - 権限: enterprise.disclosure.write（節の作成・版の保存と同じ）
 *  - 取り込み先の節は、確認ダイアログで見せた版（baseVersionId）と自動保存の時刻（knownWorkingSavedAt）を
 *    持ち回し、その後に別の版が保存された・別の人が自動保存した節には取り込まない（原稿エディタと同じ
 *    競合の規則。見ていない版を置き換えず、別の人の作業中の本文を黙って消さない）
 */

export type DraftImportSource = 'ssbj' | 'csrd';

export const DRAFT_SOURCE_LABELS: Readonly<Record<DraftImportSource, string>> = {
  ssbj: 'SSBJ 開示ドラフト',
  csrd: 'CSRD 節ドラフト',
};

/** ドラフトの基準と、取り込み先の基準のキー */
const SOURCE_FRAMEWORK_KEY: Readonly<Record<DraftImportSource, FrameworkKey>> = {
  ssbj: 'ssbj',
  csrd: 'csrd',
};

/** AI の草案に由来する段落の ID の接頭辞（印） */
export const DRAFT_AI_PARAGRAPH_PREFIX = 'draft-ai-';
/** 人が書いた段落の ID の接頭辞 */
export const DRAFT_HUMAN_PARAGRAPH_PREFIX = 'draft-p-';

/** 取り込み先の画面のための説明（ドラフト画面の注記。折りたたまない） */
export const DRAFT_IMPORT_NOTE =
  '定性情報の引用・承認・Word 出力は開示プロジェクトの原稿で行います。確定した本文は「その他」から原稿の節へ取り込めます。';

export interface DraftImportTarget {
  projectId: Uuid;
  projectName: string;
  frameworkVersionId: Uuid;
  frameworkLabel: string;
  sectionKey: string;
  blockTitle: string;
  /** 既にある取り込み先の節（無ければ新しく作る） */
  existingBlock: {
    id: Uuid;
    status: BlockStatus;
    statusLabel: string;
    versionNo: number | null;
    /** 確認した時点の版（取り込みの操作に持ち回し、その後の版の保存を競合として止める） */
    currentVersionId: Uuid | null;
    /** 確認した時点の自動保存の時刻（別の人の自動保存を競合として止める） */
    workingSavedAt: IsoDateTime | null;
  } | null;
  /** 取り込めない理由（取り込めるなら null） */
  blockedReason: string | null;
}

export interface DraftImportOption {
  source: DraftImportSource;
  draftId: Uuid;
  /** 領域・節の名前 */
  label: string;
  confirmed: boolean;
  targets: DraftImportTarget[];
}

type AnyDraft =
  { source: 'ssbj'; draft: SsbjDisclosureDraft } | { source: 'csrd'; draft: CsrdDisclosureDraft };

function sectionKeyOf(d: AnyDraft): string {
  return d.source === 'ssbj'
    ? `ssbj_draft_${d.draft.area}`
    : `csrd_draft_${d.draft.section.toLowerCase()}`;
}

function labelOf(d: AnyDraft): string {
  return d.source === 'ssbj' ? AREA_LABEL[d.draft.area] : CSRD_SECTION_LABEL[d.draft.section];
}

function blockTitleOf(d: AnyDraft): string {
  return `${labelOf(d)}（${DRAFT_SOURCE_LABELS[d.source]}から取り込み）`;
}

async function loadDraft(
  db: DbClient,
  ctx: AuthorizationContext,
  source: DraftImportSource,
  draftId: Uuid,
): Promise<AnyDraft> {
  if (!isUuid(draftId)) throw new NotFoundError('ドラフトが見つかりません。');
  if (source === 'ssbj') {
    const draft = await db.findById('ssbjDisclosureDrafts', draftId);
    if (!draft || draft.organizationId !== ctx.workspace.organizationId) {
      throw new NotFoundError('ドラフトが見つかりません。');
    }
    return { source, draft };
  }
  const draft = await db.findById('csrdDisclosureDrafts', draftId);
  if (!draft || draft.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('ドラフトが見つかりません。');
  }
  return { source, draft };
}

/** 本文を段落に分ける（空行で区切る。空行が無ければ改行で区切る） */
export function splitDraftParagraphs(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (normalized === '') return [];
  const byBlank = normalized.split(/\n\s*\n/);
  const parts = byBlank.length > 1 ? byBlank : normalized.split('\n');
  return parts.map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter((p) => p !== '');
}

/**
 * 確定本文を節の本文（AST）にする。AI の草案の段落と同じ段落は AI 由来の印（段落 ID）を付ける
 */
export function draftBodyToBlockBody(
  body: string,
  aiBody: string,
  hasAiRun: boolean,
): { body: BlockBody; aiParagraphs: number } {
  const aiParagraphs = new Set(hasAiRun ? splitDraftParagraphs(aiBody) : []);
  let ai = 0;
  const paragraphs: BlockParagraph[] = splitDraftParagraphs(body).map((text, index) => {
    const fromAi = aiParagraphs.has(text);
    if (fromAi) ai += 1;
    return {
      id: `${fromAi ? DRAFT_AI_PARAGRAPH_PREFIX : DRAFT_HUMAN_PARAGRAPH_PREFIX}${index + 1}`,
      kind: 'paragraph',
      children: [{ t: 'text', text }],
    };
  });
  return { body: { paragraphs }, aiParagraphs: ai };
}

async function targetProjects(
  db: DbClient,
  ctx: AuthorizationContext,
  d: AnyDraft,
): Promise<
  Array<{ project: DisclosureProject; frameworkVersionId: Uuid; frameworkLabel: string }>
> {
  const organizationId = ctx.workspace.organizationId;
  const [projects, pfs, versions, frameworks] = await Promise.all([
    db.select('disclosureProjects', {
      where: {
        organizationId,
        reportingPeriodId: d.draft.reportingPeriodId,
        deletedAt: { isNull: true },
      },
      orderBy: [{ column: 'name' }, { column: 'id' }],
    }),
    db.select('projectFrameworks', { where: { organizationId } }),
    db.select('frameworkVersions'),
    db.select('frameworks'),
  ]);
  const key = SOURCE_FRAMEWORK_KEY[d.source];
  const out: Array<{
    project: DisclosureProject;
    frameworkVersionId: Uuid;
    frameworkLabel: string;
  }> = [];
  for (const project of projects) {
    for (const pf of pfs.filter((f) => f.projectId === project.id)) {
      const version = versions.find((v) => v.id === pf.frameworkVersionId);
      const framework = version ? frameworks.find((f) => f.id === version.frameworkId) : undefined;
      if (!version || framework?.key !== key) continue;
      out.push({ project, frameworkVersionId: version.id, frameworkLabel: version.label });
    }
  }
  return out;
}

async function existingBlockOf(
  db: DbClient,
  ctx: AuthorizationContext,
  projectId: Uuid,
  sectionKey: string,
): Promise<{ block: DisclosureBlock; version: DisclosureBlockVersion | null } | null> {
  const [block] = await db.select('disclosureBlocks', {
    where: {
      organizationId: ctx.workspace.organizationId,
      projectId,
      sectionKey,
      language: 'ja',
      deletedAt: { isNull: true },
    },
    limit: 1,
  });
  if (!block) return null;
  const version = block.currentVersionId
    ? await db.findById('disclosureBlockVersions', block.currentVersionId)
    : null;
  return { block, version };
}

/** 別の人が自動保存した作業中の本文（版になっていない）が取り込み先の節にあるときの理由 */
export const FOREIGN_WORKING_BODY_REASON =
  '取り込み先の節に、ほかの人が自動保存した作業中の本文（版になっていない）があります。原稿で版として保存するか破棄してから取り込んでください（取り込むと、その本文は消えます）。';

function blockedReasonOf(
  d: AnyDraft,
  existing: DisclosureBlock | null,
  actorId: Uuid,
): string | null {
  if (!d.draft.confirmedAt)
    return '確定した本文だけを取り込めます（ドラフトで「確定」してください）。';
  if (d.draft.body.trim() === '') return '本文が空のため取り込めません。';
  if (
    existing &&
    (existing.status === 'review_requested' || existing.status === 'approval_pending')
  ) {
    return '取り込み先の節がレビュー中です。依頼を取り下げてから取り込んでください。';
  }
  // 取り込みは節の新しい版を作り、作業中の本文を空にする（saveBlockVersion）。別の人の自動保存が
  // 残っていれば、確認ダイアログでは見えないその本文を消してしまうため取り込まない
  if (existing && isForeignWorkingBody(existing, actorId, null)) return FOREIGN_WORKING_BODY_REASON;
  return null;
}

/** ドラフト画面の「原稿へ取り込む」の選択肢（取り込み先のプロジェクト・節と、取り込めない理由）。書かない */
export async function listDraftImportOptions(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { source: DraftImportSource; periodId: Uuid },
): Promise<DraftImportOption[]> {
  const organizationId = ctx.workspace.organizationId;
  const drafts: AnyDraft[] =
    input.source === 'ssbj'
      ? (
          await db.select('ssbjDisclosureDrafts', {
            where: { organizationId, reportingPeriodId: input.periodId },
          })
        ).map((draft) => ({ source: 'ssbj' as const, draft }))
      : (
          await db.select('csrdDisclosureDrafts', {
            where: { organizationId, reportingPeriodId: input.periodId },
          })
        ).map((draft) => ({ source: 'csrd' as const, draft }));
  const options: DraftImportOption[] = [];
  for (const d of drafts) {
    const projects = await targetProjects(db, ctx, d);
    const targets: DraftImportTarget[] = [];
    for (const target of projects) {
      const sectionKey = sectionKeyOf(d);
      const existing = await existingBlockOf(db, ctx, target.project.id, sectionKey);
      targets.push({
        projectId: target.project.id,
        projectName: target.project.name,
        frameworkVersionId: target.frameworkVersionId,
        frameworkLabel: target.frameworkLabel,
        sectionKey,
        blockTitle: existing?.block.title ?? blockTitleOf(d),
        existingBlock: existing
          ? {
              id: existing.block.id,
              status: existing.block.status,
              statusLabel: BLOCK_STATUS_LABELS[existing.block.status],
              versionNo: existing.version?.versionNo ?? null,
              currentVersionId: existing.block.currentVersionId,
              workingSavedAt: existing.block.workingSavedAt ?? null,
            }
          : null,
        blockedReason: blockedReasonOf(d, existing?.block ?? null, ctx.userId),
      });
    }
    options.push({
      source: d.source,
      draftId: d.draft.id,
      label: labelOf(d),
      confirmed: d.draft.confirmedAt !== null,
      targets,
    });
  }
  return options;
}

export interface DraftImportResult {
  block: DisclosureBlock;
  version: DisclosureBlockVersion;
  created: boolean;
  aiParagraphs: number;
  skippedCodes: string[];
}

/**
 * 確定本文を、選んだプロジェクトの専用の節の新しい版（下書き）として取り込む
 */
export async function importDraftToProject(
  db: DbClient,
  ctx: AuthorizationContext,
  input: {
    source: DraftImportSource;
    draftId: Uuid;
    projectId: Uuid;
    /** 確認ダイアログで見せた取り込み先の節の版（節が無かった・版が無かったなら null） */
    baseVersionId: Uuid | null;
    /** 確認ダイアログで見せた時点の自動保存の時刻（無ければ null） */
    knownWorkingSavedAt?: IsoDateTime | null;
  },
): Promise<DraftImportResult> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const d = await loadDraft(db, ctx, input.source, input.draftId);
  const targets = await targetProjects(db, ctx, d);
  const target = targets.find((t) => t.project.id === input.projectId);
  if (!target) {
    throw new NotFoundError(
      `取り込み先のプロジェクトが見つかりません（同じ年度で${input.source === 'ssbj' ? ' SSBJ' : ' CSRD'} を基準に持つプロジェクトに限ります）。`,
    );
  }
  const sectionKey = sectionKeyOf(d);
  const existing = await existingBlockOf(db, ctx, target.project.id, sectionKey);
  const blocked = blockedReasonOf(d, existing?.block ?? null, ctx.userId);
  if (blocked) throw new ValidationError(blocked);
  // 確認した後に、取り込み先の節に別の版が保存された（または節が作られた・消えた）。見ていない版を置き換えない
  const baseVersionId = input.baseVersionId ?? null;
  if ((existing?.block.currentVersionId ?? null) !== baseVersionId) {
    throw new BlockConflictError(
      existing?.block.currentVersionId ?? null,
      existing?.version?.body ?? { paragraphs: [] },
      { paragraphs: [] },
    );
  }

  // 要求事項はドラフトの根拠にした要求事項のコードから（取り込み先の版に無いコードは飛ばす）
  const items = await db.select('disclosureItems', {
    where: { frameworkVersionId: target.frameworkVersionId },
  });
  const codes = [...new Set(d.draft.coveredItemCodes)];
  const requirementItemIds = codes
    .map((code) => items.find((i) => i.code === code)?.id)
    .filter((id): id is Uuid => id !== undefined);
  const skippedCodes = codes.filter((code) => !items.some((i) => i.code === code));

  const { body, aiParagraphs } = draftBodyToBlockBody(
    d.draft.body,
    d.draft.aiBody,
    d.draft.aiRunId !== null,
  );
  if (body.paragraphs.length === 0) throw new ValidationError('本文が空のため取り込めません。');

  const block =
    existing?.block ??
    (await createBlock(db, ctx, {
      projectId: target.project.id,
      frameworkVersionId: target.frameworkVersionId,
      sectionKey,
      title: blockTitleOf(d),
      language: 'ja',
      requirementItemIds,
    }));
  const changeReason = `${DRAFT_SOURCE_LABELS[d.source]}（${labelOf(d)}）の確定本文を取り込み${
    aiParagraphs > 0 ? `。AI の草案に由来する段落 ${aiParagraphs} 件を含む（人が確定済み）` : ''
  }`;
  const saved = await saveBlockVersion(db, ctx, {
    blockId: block.id,
    // 確認した版と自動保存の時刻を渡し、版の保存の競合検査（BlockConflictError）を効かせる
    baseVersionId,
    knownWorkingSavedAt: input.knownWorkingSavedAt ?? null,
    body,
    changeReason,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'project_updated',
    resourceType: 'disclosure_block',
    resourceId: block.id,
    afterSummary: `${DRAFT_SOURCE_LABELS[d.source]}（${labelOf(d)}）を原稿「${block.title}」の版 ${saved.version.versionNo}（下書き）へ取り込み`,
    metadata: {
      source: d.source,
      draftId: d.draft.id,
      aiRunId: d.draft.aiRunId,
      aiParagraphs,
      versionId: saved.version.id,
      skippedCodes,
    },
  });
  return {
    block: saved.block,
    version: saved.version,
    created: existing === null,
    aiParagraphs,
    skippedCodes,
  };
}
