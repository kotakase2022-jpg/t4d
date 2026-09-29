import 'server-only';

import { AI_TIMEOUT_MESSAGE, runAi } from '@/lib/ai';
import {
  DISCLOSURE_DRAFT_OPERATIONS,
  disclosureBlockDraftSchema,
  type DisclosureBlockDraftOutput,
  type DisclosureDraftOperation,
  type DisclosureDraftSourceKind,
  type DisclosureDraftSourceRef,
} from '@/lib/ai/schemas';
import { changedSinceRun, paragraphHashes } from '@/lib/ai/draft-conflict';
import {
  DRAFT_SOURCE_USAGES,
  isGroundingUsage,
  splitSentences,
  type DraftInvocationInput,
  type DraftSourceInput,
  type DraftSourceUsage,
} from '@/lib/ai/mock-disclosure-draft';
import { recordAuditEvent } from '@/lib/audit/logger';
import { AuthorizationError, assertCan, can, NotFoundError } from '@/lib/authorization/can';
import { canonicalJson, contentHashOf, paragraphText } from '@/lib/domain/disclosure-block';
import { transitionBlock } from '@/lib/domain/disclosure-status';
import { assessNarrativeFields } from '@/lib/domain/narrative-template';
import { ValidationError } from '@/lib/errors/user-facing';
import { fid, stableHash } from '@/lib/fixtures/ids';
import {
  approvedDataPointVersionIds,
  BlockRefValidationError,
  CONFLICT_MESSAGES,
  contributorsWith,
  editingBodyOf,
  findUnresolvableRefs,
  findPriorYearBlock,
  isForeignWorkingBody,
  isVersionApproved,
  loadBlock,
  loadProject,
  metricDisplay,
  parseBlockBody,
} from '@/lib/services/disclosure-block';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AiRun,
  AiSourceReference,
  AuthorizationContext,
  BlockBody,
  BlockInline,
  BlockParagraph,
  DisclosureBlock,
  IsoDateTime,
  Uuid,
} from '@/types/domain';

/**
 * 開示本文の AI 下書き支援（docs/disclosure-first.md §2-3、指示書 §6.7・§9）。
 *
 *  - 操作は 3 つ: 選択した根拠から下書き／前年からの変更案／文章を整える
 *  - AI へ渡すのは、利用者が選んだ・この組織の・閲覧権限のある入力だけ（取得時に権限を掛ける。A30）
 *  - AI が返した参照 ID は入力の許可リストと突き合わせ、無い ID を引いた段落は採用させず不足情報へ回す（A17）
 *  - 過年度の記載・文体の参考だけを根拠にした段落は、当年度の事実として採用させない（A15）
 *  - 候補は ai_runs に残し、人が段落ごとに採用して初めて作業本文に入る。生成中に本文が変わっていれば
 *    自動では反映せず競合を知らせる（A18）。AI が失敗しても手動の編集・保存・レビューは妨げない（A19）
 *  - 二重押下: 実行 ID を「節・版・操作・入力・本文」から決定論的に決め、同じ候補を 2 度作らない
 */

export const DRAFT_OPERATION_LABELS: Record<DisclosureDraftOperation, string> = {
  draft_from_sources: '選択した根拠から下書き',
  update_from_prior_year: '前年からの変更案',
  polish: '文章を整える',
};

/** 利用者が選べる根拠の種類（前年の節・整える段落はサーバーが組み立てる） */
export type SelectableSourceKind = Extract<
  DisclosureDraftSourceKind,
  'narrative_version' | 'source_anchor' | 'metric_version' | 'requirement'
>;

export interface GenerateBlockDraftInput {
  blockId: Uuid;
  operation: DisclosureDraftOperation;
  sources: Array<{ kind: SelectableSourceKind; id: string }>;
  /** 文章を整える段落。省略時は数値・引用を含まない全段落 */
  paragraphIds?: string[];
  /** 画面で編集中の本文（未保存の変更を含む）。生成開始時点の本文として競合の判定に使う */
  workingBody?: unknown;
  /** 同じ入力でも作り直す（前の候補は残し、新しい実行として記録する） */
  regenerate?: boolean;
}

export interface GenerateOptions {
  /** 応答を待つ上限。既定 30 秒 */
  timeoutMs?: number;
}

export const DEFAULT_DRAFT_TIMEOUT_MS = 30_000;

// ======================================================================
// 実行記録（ai_runs.input_reference_ids）への符号化
//
// 生成時の許可リスト・土台の本文・操作をここに残す。候補の検証は保存済みの出力とこの記録から
// 毎回同じ結果に再計算できる（検証済みの出力を別に保存して二重に持たない）。
// ======================================================================

const TOKEN = {
  block: (id: string) => `block:${id}`,
  version: (id: string | null) => `version:${id ?? 'none'}`,
  base: (hash: string) => `base:${hash}`,
  op: (op: DisclosureDraftOperation) => `op:${op}`,
  idem: (key: string) => `idem:${key}`,
  ref: (kind: DisclosureDraftSourceKind, id: string, usage: DraftSourceUsage) =>
    `ref:${kind}:${usage}:${id}`,
  /** 生成開始時の本文の段落数と、段落ごとのハッシュ（競合の判定に使う） */
  paragraphCount: (n: number) => `pcount:${n}`,
  paragraph: (id: string, hash: string) => `p:${id}:${hash}`,
};

interface DecodedRun {
  blockId: string | null;
  baseVersionId: string | null;
  baseHash: string | null;
  operation: DisclosureDraftOperation | null;
  /** kind:id → usage */
  allowlist: Map<string, DraftSourceUsage>;
  /** 段落 ID → 生成開始時のハッシュ。記録の無い古い実行では null */
  paragraphHashes: Record<string, string> | null;
}

function decodeRun(run: Pick<AiRun, 'inputReferenceIds'>): DecodedRun {
  const decoded: DecodedRun = {
    blockId: null,
    baseVersionId: null,
    baseHash: null,
    operation: null,
    allowlist: new Map(),
    paragraphHashes: null,
  };
  for (const token of run.inputReferenceIds) {
    if (token.startsWith('pcount:')) decoded.paragraphHashes ??= {};
    else if (token.startsWith('p:')) {
      const [, id, hash] = token.split(':');
      if (id && hash) {
        decoded.paragraphHashes ??= {};
        decoded.paragraphHashes[id] = hash;
      }
    } else if (token.startsWith('block:')) decoded.blockId = token.slice(6);
    else if (token.startsWith('version:')) {
      const id = token.slice(8);
      decoded.baseVersionId = id === 'none' ? null : id;
    } else if (token.startsWith('base:')) decoded.baseHash = token.slice(5);
    else if (token.startsWith('op:')) {
      const op = token.slice(3) as DisclosureDraftOperation;
      if ((DISCLOSURE_DRAFT_OPERATIONS as readonly string[]).includes(op)) decoded.operation = op;
    } else if (token.startsWith('ref:')) {
      const [, kind, usage, ...rest] = token.split(':');
      const id = rest.join(':');
      if (kind && usage && id && (DRAFT_SOURCE_USAGES as readonly string[]).includes(usage)) {
        decoded.allowlist.set(`${kind}:${id}`, usage as DraftSourceUsage);
      }
    }
  }
  return decoded;
}

// ======================================================================
// 入力の組み立て（組織・権限・存在をここで確かめる）
// ======================================================================

async function buildSources(
  db: DbClient,
  ctx: AuthorizationContext,
  block: DisclosureBlock,
  input: GenerateBlockDraftInput,
  baseBody: BlockBody,
): Promise<{ sources: DraftSourceInput[]; notes: string[] }> {
  const organizationId = ctx.workspace.organizationId;
  const project = await loadProject(db, ctx, block.projectId);
  const periods = await db.select('periods', { where: { organizationId } });
  const periodLabel = (id: Uuid | null) =>
    id ? (periods.find((p) => p.id === id)?.label ?? null) : null;
  const sources: DraftSourceInput[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();

  for (const selected of input.sources) {
    const key = `${selected.kind}:${selected.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (selected.kind === 'narrative_version') {
      const version = await db.findById('narrativeVersions', selected.id);
      const record = version
        ? await db.findById('narrativeRecords', version.narrativeRecordId)
        : null;
      if (!version || version.organizationId !== organizationId || !record || record.deletedAt) {
        throw new NotFoundError('選択した定性情報が見つかりません。');
      }
      sources.push({
        kind: 'narrative_version',
        id: version.id,
        label: `${record.title}（版 ${version.versionNo}）`,
        // 当期の版だけを当年度の事実とする（前年度の版は過年度の記載として扱う）
        usage:
          version.reportingPeriodId === project.reportingPeriodId
            ? 'current_fact'
            : 'prior_year_text',
        periodLabel: periodLabel(version.reportingPeriodId),
        locator: null,
        text: version.body,
        // 画面・スナップショットと同じ判定（財務的影響は、定量化しない理由があっても影響額が無ければ不足）
        missingFields: assessNarrativeFields(record.theme, version.fields).missing.map(
          (f) => f.label,
        ),
        anchorIds: version.sourceAnchorIds,
      });
    } else if (selected.kind === 'source_anchor') {
      // 資料の閲覧権限が無い人の入力に資料の文言を入れない（検索後に隠すのではなく取得時に止める）
      if (!can(ctx, 'enterprise.evidence.read')) {
        throw new AuthorizationError(
          '根拠資料を閲覧する権限がないため、資料を AI の入力にできません。',
        );
      }
      const anchor = await db.findById('sourceAnchors', selected.id);
      const fileVersion = anchor ? await db.findById('fileVersions', anchor.fileVersionId) : null;
      const file = fileVersion ? await db.findById('files', fileVersion.fileId) : null;
      if (
        !anchor ||
        anchor.organizationId !== organizationId ||
        !file ||
        file.organizationId !== organizationId
      ) {
        throw new NotFoundError('選択した資料の引用位置が見つかりません。');
      }
      if (file.deletedAt) {
        notes.push(`削除された資料「${file.originalName}」は入力から外しました。`);
        continue;
      }
      sources.push({
        kind: 'source_anchor',
        id: anchor.id,
        label: `${file.originalName}${anchor.locator ? ` ${anchor.locator}` : ''}`,
        usage: file.usagePurpose ?? 'unclassified',
        periodLabel: periodLabel(file.reportingPeriodId),
        locator: anchor.locator,
        text: anchor.quoteText,
      });
    } else if (selected.kind === 'metric_version') {
      const version = await db.findById('dataPointVersions', selected.id);
      const dp = version ? await db.findById('dataPoints', version.dataPointId) : null;
      if (!version || version.organizationId !== organizationId || !dp || dp.deletedAt) {
        throw new NotFoundError('選択した数値が見つかりません。');
      }
      if (version.availabilityStatus !== 'value_present') {
        notes.push('値の無い数値（未入力・対象外など）は入力から外しました。');
        continue;
      }
      // 目標の値は当年度の事実ではない。承認済みでも「当年度の根拠」として渡さない（§7.1・§10.4）
      if (version.valueKind === 'target') {
        notes.push('目標の値は当年度の実績の根拠にできないため、入力から外しました。');
        continue;
      }
      const metric = await db.findById('metrics', dp.metricId);
      const approved = isVersionApproved(
        version,
        dp,
        await approvedDataPointVersionIds(db, ctx, [dp.id]),
      );
      const name = metric?.name ?? '指標';
      sources.push({
        kind: 'metric_version',
        id: version.id,
        label: `${name}（${dp.boundary}・版 ${version.versionNo}）`,
        usage: !approved
          ? 'unapproved'
          : dp.reportingPeriodId === project.reportingPeriodId
            ? 'current_fact'
            : 'prior_year_text',
        periodLabel: periodLabel(dp.reportingPeriodId),
        locator: null,
        // 表示には推計の区分が入る（例: 1,190.9 t-CO2e（推計））。下書きでも区分を落とさない
        text: `${name}: ${metricDisplay(version)}`,
        metric: {
          name,
          display: metricDisplay(version),
          boundary: dp.boundary,
          approved,
          valueKind: version.valueKind ?? 'actual',
        },
      });
    } else if (selected.kind === 'requirement') {
      const item = await db.findById('disclosureItems', selected.id);
      if (!item || item.frameworkVersionId !== block.frameworkVersionId) {
        throw new NotFoundError('選択した要求事項が、この節の基準の版に見つかりません。');
      }
      sources.push({
        kind: 'requirement',
        id: item.id,
        label: `${item.code} ${item.section}`,
        usage: 'requirement',
        periodLabel: null,
        locator: item.code,
        text: item.questionText,
        requirement: { code: item.code, frameworkVersionId: item.frameworkVersionId },
      });
    } else {
      throw new ValidationError('選択した根拠の種類が正しくありません。');
    }
  }

  if (input.operation === 'update_from_prior_year') {
    const prior = await findPriorYearBlock(db, ctx, project, block);
    if (prior) {
      for (const p of prior.version.body.paragraphs) {
        const text = paragraphText(p).trim();
        if (p.kind !== 'paragraph' || !text) continue;
        sources.push({
          kind: 'prior_block',
          id: prior.version.id,
          label: `${prior.project.name}「${prior.block.title}」版 ${prior.version.versionNo}`,
          usage: 'prior_year_text',
          periodLabel: prior.periodLabel,
          locator: p.id,
          paragraphId: p.id,
          text,
        });
      }
    } else {
      notes.push('前の報告期間に同じ節が見つかりませんでした。');
    }
  }

  if (input.operation === 'polish') {
    const targets = input.paragraphIds?.length ? new Set(input.paragraphIds) : null;
    for (const p of baseBody.paragraphs) {
      if (p.kind !== 'paragraph' || (targets && !targets.has(p.id))) continue;
      // 数値・定性情報の引用を含む段落は整えない（参照を文字列に潰さないため）
      if (p.children.some((i) => i.t === 'metric' || i.t === 'narrative')) {
        notes.push(`段落 ${p.id} は数値・定性情報の引用を含むため、整える対象から外しました。`);
        continue;
      }
      const text = paragraphText(p);
      if (!text.trim()) continue;
      sources.push({
        kind: 'block_paragraph',
        id: p.id,
        label: `現在の本文 段落 ${p.id}`,
        usage: 'current_body',
        periodLabel: null,
        locator: p.id,
        paragraphId: p.id,
        text,
      });
    }
  }

  if (sources.filter((s) => s.kind !== 'requirement').length === 0) {
    if (input.operation === 'draft_from_sources') {
      throw new ValidationError('下書きの根拠を 1 つ以上選択してください。');
    }
    if (input.operation === 'polish') {
      throw new ValidationError('整える段落がありません（数値・引用を含む段落は対象外です）。');
    }
  }
  return { sources, notes };
}

// ======================================================================
// 出力の検証（許可リストとの突き合わせ）と、本文の段落への変換
// ======================================================================

export interface DraftCandidate {
  index: number;
  /** 置き換え候補の段落 ID（新しい段落は null） */
  paragraphId: string | null;
  kind: 'paragraph' | 'heading';
  text: string;
  sourceRefs: DisclosureDraftSourceRef[];
  /** 採用したときに本文へ入る段落（段落 ID は採用時に決める） */
  children: BlockInline[];
}

export interface ValidatedDraft {
  candidates: DraftCandidate[];
  missingInformation: DisclosureBlockDraftOutput['missingInformation'];
  conflicts: DisclosureBlockDraftOutput['conflicts'];
  warnings: string[];
  usedRequirementVersions: DisclosureBlockDraftOutput['usedRequirementVersions'];
  /** 入力に無い参照（採用を拒否したもの） */
  rejectedRefs: DisclosureDraftSourceRef[];
  confidence: number;
}

export interface CandidateResolver {
  narrativeBody(id: string): string | null;
  metric(id: string): { dataPointId: Uuid; display: string } | null;
}

function toChildren(
  text: string,
  kind: 'paragraph' | 'heading',
  refs: DisclosureDraftSourceRef[],
  resolver: CandidateResolver,
): BlockInline[] {
  if (kind === 'heading') return [{ t: 'text', text }];
  // 定性情報の本文そのものなら、版を持った引用として入れる（元情報が変わっても黙って書き換わらない）
  for (const r of refs) {
    if (r.kind !== 'narrative_version') continue;
    const body = resolver.narrativeBody(r.id);
    if (body && body.trim() === text.trim()) {
      return [{ t: 'narrative', narrativeVersionId: r.id, quote: body }, ...citesOf(refs)];
    }
  }
  // 候補が定性情報の文を言い直しの中に含むなら、その文（連続する文のまとまり）を版を持った引用にする。
  // 前置き・出典の注記だけが地の文になり、事実の部分は元の版を指し続ける
  for (const r of refs) {
    if (r.kind !== 'narrative_version') continue;
    const body = resolver.narrativeBody(r.id);
    const quote = body ? longestQuotedRun(body, text) : null;
    if (!quote) continue;
    const at = text.indexOf(quote);
    const children: BlockInline[] = [];
    if (at > 0) children.push({ t: 'text', text: text.slice(0, at) });
    children.push({ t: 'narrative', narrativeVersionId: r.id, quote });
    const rest = text.slice(at + quote.length);
    if (rest) children.push({ t: 'text', text: rest });
    return [...children, ...citesOf(refs)];
  }
  // 数値の表示文字列が本文にあれば、版を持った参照に置き換える
  let children: BlockInline[] = [{ t: 'text', text }];
  for (const r of refs) {
    if (r.kind !== 'metric_version') continue;
    const metric = resolver.metric(r.id);
    if (!metric) continue;
    const next: BlockInline[] = [];
    let replaced = false;
    for (const child of children) {
      if (replaced || child.t !== 'text') {
        next.push(child);
        continue;
      }
      const at = child.text.indexOf(metric.display);
      if (at === -1) {
        next.push(child);
        continue;
      }
      if (at > 0) next.push({ t: 'text', text: child.text.slice(0, at) });
      next.push({
        t: 'metric',
        dataPointId: metric.dataPointId,
        dataPointVersionId: r.id,
        display: metric.display,
      });
      const rest = child.text.slice(at + metric.display.length);
      if (rest) next.push({ t: 'text', text: rest });
      replaced = true;
    }
    children = next;
  }
  return [...children, ...citesOf(refs)];
}

/**
 * 定性情報の本文の文のうち、候補の文にそのまま含まれる最長の連続部分（無ければ null）。
 * 引用文は版の本文の一部でなければならない（validateBodyRefs と同じ条件）ので、本文にも含まれるものに限る
 */
export function longestQuotedRun(body: string, text: string): string | null {
  const sentences = splitSentences(body);
  let best: string | null = null;
  for (let i = 0; i < sentences.length; i += 1) {
    for (let j = i; j < sentences.length; j += 1) {
      const run = sentences.slice(i, j + 1).join('');
      if (!text.includes(run) || !body.includes(run)) break;
      if (!best || run.length > best.length) best = run;
    }
  }
  return best;
}

function citesOf(refs: DisclosureDraftSourceRef[]): BlockInline[] {
  const ids = [...new Set(refs.filter((r) => r.kind === 'source_anchor').map((r) => r.id))];
  return ids.map((id) => ({ t: 'cite' as const, sourceAnchorId: id }));
}

function snippet(text: string, max = 40): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * AI の出力を許可リストと突き合わせる（モデルの自己申告を信用しない）。
 *  - 入力に無い kind:id を 1 つでも引いた段落 → 採用させず不足情報へ（A17）
 *  - 当年度の根拠（当年度の資料・承認済みの数値・整える段落）を 1 つも持たない本文段落 → 不足情報へ（A15）
 *  - 置き換え先の段落 ID が現在の本文に無ければ新しい段落として扱う
 */
export function validateDraftOutput(
  raw: unknown,
  allowlist: ReadonlyMap<string, DraftSourceUsage>,
  currentParagraphIds: ReadonlySet<string>,
  resolver: CandidateResolver,
): ValidatedDraft {
  const parsed = disclosureBlockDraftSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      candidates: [],
      missingInformation: [],
      conflicts: [],
      warnings: ['AI の出力が形式に合わないため、候補を表示できません。'],
      usedRequirementVersions: [],
      rejectedRefs: [],
      confidence: 0,
    };
  }
  const output = parsed.data;
  const allowed = (r: DisclosureDraftSourceRef) => allowlist.has(`${r.kind}:${r.id}`);
  const rejectedRefs: DisclosureDraftSourceRef[] = [];
  const missing = [...output.missingInformation];
  const warnings = [...output.warnings];
  const candidates: DraftCandidate[] = [];

  output.draftBlocks.forEach((block, index) => {
    const unknown = block.sourceRefs.filter((r) => !allowed(r));
    if (unknown.length > 0) {
      rejectedRefs.push(...unknown);
      missing.push({
        item: `「${snippet(block.text)}」`,
        reason: `入力に無い根拠（${unknown.map((r) => `${r.kind} ${r.id}`).join('、')}）を参照していたため、根拠なしとして採用しません。`,
        nextCheck: '該当する資料を確認し、根拠として選択し直してください。',
      });
      return;
    }
    if (block.kind === 'paragraph') {
      const grounded = block.sourceRefs.some((r) => {
        const usage = allowlist.get(`${r.kind}:${r.id}`);
        return usage !== undefined && isGroundingUsage(usage);
      });
      if (!grounded) {
        missing.push({
          item: `「${snippet(block.text)}」`,
          reason:
            block.sourceRefs.length === 0
              ? '根拠が示されていない記述のため、本文の候補にしません。'
              : '過年度の記載・文体の参考・未承認の数値だけを根拠にしているため、当年度の事実として採用しません。',
          nextCheck: '当年度の根拠を選択してください。',
        });
        return;
      }
    }
    candidates.push({
      index,
      paragraphId:
        block.paragraphId && currentParagraphIds.has(block.paragraphId) ? block.paragraphId : null,
      kind: block.kind,
      text: block.text,
      sourceRefs: block.sourceRefs,
      children: toChildren(block.text, block.kind, block.sourceRefs, resolver),
    });
  });

  const conflicts = output.conflicts.map((c) => {
    const refs = c.sourceRefs.filter(allowed);
    rejectedRefs.push(...c.sourceRefs.filter((r) => !allowed(r)));
    return { ...c, sourceRefs: refs };
  });
  if (rejectedRefs.length > 0) {
    warnings.push(`入力に無い根拠の参照 ${rejectedRefs.length} 件を採用しませんでした。`);
  }

  return {
    candidates,
    missingInformation: missing,
    conflicts,
    warnings,
    usedRequirementVersions: output.usedRequirementVersions.filter((u) =>
      allowlist.has(`requirement:${u.requirementId}`),
    ),
    rejectedRefs,
    confidence: output.confidence,
  };
}

async function resolverFor(
  db: DbClient,
  ctx: AuthorizationContext,
  allowlist: ReadonlyMap<string, DraftSourceUsage>,
): Promise<CandidateResolver> {
  const organizationId = ctx.workspace.organizationId;
  const narratives = new Map<string, string>();
  const metrics = new Map<string, { dataPointId: Uuid; display: string }>();
  for (const key of allowlist.keys()) {
    const [kind, ...rest] = key.split(':');
    const id = rest.join(':');
    if (kind === 'narrative_version') {
      const v = await db.findById('narrativeVersions', id);
      if (v && v.organizationId === organizationId) narratives.set(id, v.body);
    } else if (kind === 'metric_version') {
      const v = await db.findById('dataPointVersions', id);
      if (v && v.organizationId === organizationId) {
        metrics.set(id, { dataPointId: v.dataPointId, display: metricDisplay(v) });
      }
    }
  }
  return {
    narrativeBody: (id) => narratives.get(id) ?? null,
    metric: (id) => metrics.get(id) ?? null,
  };
}

// ======================================================================
// 画面用の実行記録
// ======================================================================

export type DraftRunState = 'pending' | 'accepted' | 'rejected' | 'failed' | 'timeout';

export const DRAFT_RUN_STATE_LABELS: Record<DraftRunState, string> = {
  pending: '候補あり（未確認）',
  accepted: '採用済み',
  rejected: '破棄',
  failed: '失敗',
  timeout: 'タイムアウト',
};

export interface DraftRunView {
  runId: Uuid;
  operation: DisclosureDraftOperation | null;
  operationLabel: string;
  state: DraftRunState;
  stateLabel: string;
  /** Mock は「デモ生成（Mock）」と必ず示す（実モデルと混同させない） */
  providerLabel: string;
  isMock: boolean;
  baseHash: string | null;
  /** 生成開始時の段落ごとのハッシュ（画面が採用前に競合を知らせるため） */
  baseParagraphHashes: Record<string, string> | null;
  baseVersionId: string | null;
  candidates: Array<DraftCandidate & { sourceLabels: string[] }>;
  missingInformation: ValidatedDraft['missingInformation'];
  conflicts: Array<{ subject: string; detail: string; sourceLabels: string[] }>;
  warnings: string[];
  usedRequirementCodes: string[];
  rejectedRefCount: number;
  confidence: number;
  /** 生成メタデータ（ai_runs の行から組み立てる。モデルの出力は使わない） */
  metadata: {
    runId: Uuid;
    provider: 'openai' | 'mock';
    model: string;
    promptVersion: string;
    startedAt: IsoDateTime;
    finishedAt: IsoDateTime;
    inputReferenceCount: number;
    failureReason: string | null;
  };
}

function stateOf(run: AiRun): DraftRunState {
  if (run.status === 'failed')
    return run.errorMessage === AI_TIMEOUT_MESSAGE ? 'timeout' : 'failed';
  if (run.status === 'accepted') return 'accepted';
  if (run.status === 'rejected') return 'rejected';
  return 'pending';
}

export async function toDraftRunView(
  db: DbClient,
  ctx: AuthorizationContext,
  run: AiRun,
  currentParagraphIds: ReadonlySet<string>,
): Promise<DraftRunView> {
  const decoded = decodeRun(run);
  const resolver = await resolverFor(db, ctx, decoded.allowlist);
  const state = stateOf(run);
  const validated =
    run.status === 'failed'
      ? null
      : validateDraftOutput(run.outputJson, decoded.allowlist, currentParagraphIds, resolver);
  const labelOf = (r: DisclosureDraftSourceRef) => {
    if (r.kind === 'block_paragraph') return `現在の本文 段落 ${r.id}`;
    const source = run.sourceReferences.find((s) => s.kind === r.kind && s.id === r.id);
    return source ? source.label : `${r.kind} ${r.id}`;
  };
  const startedAt = run.createdAt;
  const finishedAt = new Date(new Date(run.createdAt).getTime() + run.latencyMs).toISOString();
  return {
    runId: run.id,
    operation: decoded.operation,
    operationLabel: decoded.operation ? DRAFT_OPERATION_LABELS[decoded.operation] : '—',
    state,
    stateLabel: DRAFT_RUN_STATE_LABELS[state],
    providerLabel: run.provider === 'mock' ? 'デモ生成（Mock）' : 'AI（外部モデル）',
    isMock: run.provider === 'mock',
    baseHash: decoded.baseHash,
    baseParagraphHashes: decoded.paragraphHashes,
    baseVersionId: decoded.baseVersionId,
    candidates: (validated?.candidates ?? []).map((c) => ({
      ...c,
      sourceLabels: [...new Set(c.sourceRefs.map(labelOf))],
    })),
    missingInformation: validated?.missingInformation ?? [],
    conflicts: (validated?.conflicts ?? []).map((c) => ({
      subject: c.subject,
      detail: c.detail,
      sourceLabels: c.sourceRefs.map(labelOf),
    })),
    warnings: validated?.warnings ?? [],
    usedRequirementCodes: (validated?.usedRequirementVersions ?? []).map((u) => u.code),
    rejectedRefCount: validated?.rejectedRefs.length ?? 0,
    confidence: validated?.confidence ?? 0,
    metadata: {
      runId: run.id,
      provider: run.provider,
      model: run.model,
      promptVersion: run.promptVersion,
      startedAt,
      finishedAt,
      inputReferenceCount: decoded.allowlist.size,
      failureReason: run.errorMessage,
    },
  };
}

async function runsOfBlock(
  db: DbClient,
  ctx: AuthorizationContext,
  blockId: Uuid,
): Promise<AiRun[]> {
  return db.select('aiRuns', {
    where: {
      organizationId: ctx.workspace.organizationId,
      featureType: 'disclosureBlockDraft',
      inputReferenceIds: { contains: TOKEN.block(blockId) },
    },
    orderBy: [{ column: 'createdAt', dir: 'desc' }, { column: 'id' }],
  });
}

/** 節の AI 実行記録（新しい順） */
export async function loadBlockDraftRuns(
  db: DbClient,
  ctx: AuthorizationContext,
  blockId: Uuid,
  limit = 5,
): Promise<DraftRunView[]> {
  const block = await loadBlock(db, ctx, blockId);
  const editing = await editingBodyOf(db, ctx, block);
  const ids = new Set(editing.body.paragraphs.map((p) => p.id));
  const runs = (await runsOfBlock(db, ctx, block.id)).slice(0, limit);
  return Promise.all(runs.map((run) => toDraftRunView(db, ctx, run, ids)));
}

// ======================================================================
// 生成
// ======================================================================

export type GenerateBlockDraftResult =
  | { status: 'succeeded'; run: DraftRunView; reused: boolean; notes: string[] }
  | { status: 'failed' | 'timeout'; message: string; runId: Uuid | null };

export async function generateBlockDraft(
  db: DbClient,
  ctx: AuthorizationContext,
  input: GenerateBlockDraftInput,
  options: GenerateOptions = {},
): Promise<GenerateBlockDraftResult> {
  assertCan(ctx, 'enterprise.ai.run');
  assertCan(ctx, 'enterprise.disclosure.write');
  if (!(DISCLOSURE_DRAFT_OPERATIONS as readonly string[]).includes(input.operation)) {
    throw new ValidationError('AI の操作が正しくありません。');
  }
  const block = await loadBlock(db, ctx, input.blockId);
  const editable = transitionBlock('autosave', block.status);
  if (!editable.ok) {
    throw new ValidationError('AI の下書きは、下書き・差戻しの節でだけ使えます。');
  }
  const project = await loadProject(db, ctx, block.projectId);

  const editing = await editingBodyOf(db, ctx, block);
  const baseBody =
    input.workingBody === undefined ? editing.body : parseBlockBody(input.workingBody);
  const baseHash = contentHashOf(baseBody);
  const { sources, notes } = await buildSources(db, ctx, block, input, baseBody);

  const period = await db.findById('periods', project.reportingPeriodId);
  const invocationInput: DraftInvocationInput = {
    operation: input.operation,
    blockTitle: block.title,
    periodLabel: period?.label.replace(/（.*）$/, '') ?? '当年度',
    sources,
    currentParagraphIds: baseBody.paragraphs.map((p) => p.id),
  };

  // 実行 ID を入力から決める。同じ入力の二重押下は同じ実行になり、候補を 2 度作らない
  const baseKey = stableHash(
    canonicalJson({
      block: block.id,
      version: block.currentVersionId,
      op: input.operation,
      base: baseHash,
      sources: sources.map((s) => [s.kind, s.id, s.paragraphId ?? null]),
    }),
  );
  const previous = (await runsOfBlock(db, ctx, block.id)).filter((r) =>
    r.inputReferenceIds.includes(TOKEN.idem(baseKey)),
  );
  const reusable = previous.find((r) => r.status === 'succeeded' || r.status === 'accepted');
  if (reusable && !input.regenerate) {
    return {
      status: 'succeeded',
      run: await toDraftRunView(db, ctx, reusable, new Set(invocationInput.currentParagraphIds)),
      reused: true,
      notes,
    };
  }
  const attempt = previous.length;
  const runId = fid('ai_run', `disclosureBlockDraft/${baseKey}#${attempt}`);

  const tokens = [
    TOKEN.block(block.id),
    TOKEN.version(block.currentVersionId),
    TOKEN.base(baseHash),
    TOKEN.op(input.operation),
    TOKEN.idem(baseKey),
    ...sources.map((s) => TOKEN.ref(s.kind, s.id, s.usage)),
    TOKEN.paragraphCount(baseBody.paragraphs.length),
    ...Object.entries(paragraphHashes(baseBody)).map(([id, hash]) => TOKEN.paragraph(id, hash)),
  ];
  const aiSources: AiSourceReference[] = sources
    .filter((s) => s.kind !== 'block_paragraph')
    .map((s) => ({
      kind: s.kind as Exclude<DisclosureDraftSourceKind, 'block_paragraph'>,
      id: s.id,
      label: s.label,
      locator: s.locator,
      periodLabel: s.periodLabel,
    }));

  let run: AiRun;
  try {
    const result = await runAi({
      db,
      ctx,
      idempotencyKey: `disclosureBlockDraft:${baseKey}#${attempt}`,
      runId,
      timeoutMs: options.timeoutMs ?? DEFAULT_DRAFT_TIMEOUT_MS,
      sources: aiSources,
      invocation: {
        feature: 'disclosureBlockDraft',
        context: {
          organizationName: ctx.workspace.organizationName,
          reportingPeriodLabel: period?.label ?? '',
        },
        input: invocationInput as unknown as Record<string, unknown>,
        inputReferenceIds: tokens,
      },
    });
    run = result.run;
  } catch (error) {
    // 別のリクエストが同じ実行 ID で先に記録していれば（二重押下）、その結果を返す
    const existing = await db.findById('aiRuns', runId);
    if (existing && existing.status !== 'failed') {
      return {
        status: 'succeeded',
        run: await toDraftRunView(db, ctx, existing, new Set(invocationInput.currentParagraphIds)),
        reused: true,
        notes,
      };
    }
    const message = error instanceof Error ? error.message : 'AI の実行に失敗しました。';
    return {
      status: message === AI_TIMEOUT_MESSAGE ? 'timeout' : 'failed',
      message: `${message} 手動での編集・保存・レビュー依頼はそのまま続けられます。`,
      runId: existing?.id ?? null,
    };
  }

  // 同じ節の未確認の候補は、新しい候補に置き換わったものとして閉じる（採用済みの段落は本文に残る）。
  // 一部でも採用した実行は「採用」として閉じる（破棄と記録すると、承認済みの本文に入った段落の
  // 出所が「破棄した AI 出力」になり、AI の記録と本文が食い違う）
  for (const old of await runsOfBlock(db, ctx, block.id)) {
    if (old.id === run.id || old.status !== 'succeeded') continue;
    await closeRun(db, ctx, old, wasAdopted(old, baseBody) ? 'accepted' : 'rejected');
  }

  return {
    status: 'succeeded',
    run: await toDraftRunView(db, ctx, run, new Set(invocationInput.currentParagraphIds)),
    reused: false,
    notes,
  };
}

// ======================================================================
// 段落ごとの採用
// ======================================================================

export interface AdoptDraftInput {
  blockId: Uuid;
  runId: Uuid;
  candidateIndexes: number[];
  /** 画面で編集中の本文（未保存の変更を含む）。省略時は保存済みの作業本文 */
  workingBody?: unknown;
  baseVersionId: Uuid | null;
  /** 生成中に本文が変わっていても、差分を確認したうえで採用する（置き換えずに直後へ足す） */
  allowOnConflict?: boolean;
  /** 画面が読み込んだ作業本文の保存時刻（別の人の自動保存を黙って上書きしない） */
  knownWorkingSavedAt?: IsoDateTime | null;
}

export type AdoptDraftResult =
  | { status: 'applied'; body: BlockBody; savedAt: IsoDateTime; adopted: number }
  | { status: 'conflict'; body: BlockBody; message: string }
  | { status: 'version_conflict'; currentVersionId: Uuid | null }
  | { status: 'working_conflict'; body: BlockBody; message: string };

/**
 * 実行の候補を 1 つでも本文へ採用したか。
 * 採用時に実行へ印（acceptedAt）を付けておき、本文（画面から送られたもの、無ければ作業本文）にも
 * その実行の段落があれば採用とみなす。Demo Mode では作業本文が別のサーバーに無いことがあるため、
 * 本文だけで判定すると、採用したのに「破棄」と記録してしまう
 */
function wasAdopted(run: Pick<AiRun, 'id' | 'acceptedAt'>, body: BlockBody | null): boolean {
  if (run.acceptedAt) return true;
  return Boolean(body?.paragraphs.some((p) => p.aiRunId === run.id));
}

function adoptedParagraphId(runId: Uuid, index: number): string {
  return `ai-${runId.slice(0, 8)}-${index}`;
}

export async function adoptDraftParagraphs(
  db: DbClient,
  ctx: AuthorizationContext,
  input: AdoptDraftInput,
): Promise<AdoptDraftResult> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const block = await loadBlock(db, ctx, input.blockId);
  const editable = transitionBlock('autosave', block.status);
  if (!editable.ok) throw new ValidationError(editable.reason);
  if ((input.baseVersionId ?? null) !== (block.currentVersionId ?? null)) {
    return { status: 'version_conflict', currentVersionId: block.currentVersionId };
  }

  const run = await db.findById('aiRuns', input.runId);
  if (
    !run ||
    run.organizationId !== ctx.workspace.organizationId ||
    run.featureType !== 'disclosureBlockDraft' ||
    !run.inputReferenceIds.includes(TOKEN.block(block.id))
  ) {
    throw new NotFoundError('AI の候補が見つかりません。');
  }
  if (run.status === 'failed' || run.status === 'rejected') {
    throw new ValidationError('破棄した候補・失敗した実行は採用できません。');
  }

  if (
    input.knownWorkingSavedAt !== undefined &&
    isForeignWorkingBody(block, ctx.userId, input.knownWorkingSavedAt)
  ) {
    return {
      status: 'working_conflict',
      body: block.workingBody ?? { paragraphs: [] },
      message: CONFLICT_MESSAGES.working,
    };
  }
  const editing = await editingBodyOf(db, ctx, block);
  const working =
    input.workingBody === undefined ? editing.body : parseBlockBody(input.workingBody);
  // 読めない参照（別組織・存在しない行）は、作業本文にも入れない（自動保存と同じ。A29）
  const unresolvable = await findUnresolvableRefs(db, ctx, working, [
    editing.version?.body,
    block.workingBody,
  ]);
  if (unresolvable.length > 0) throw new BlockRefValidationError(unresolvable);
  const decoded = decodeRun(run);
  // 同じ実行の候補を採用して変わった段落は、利用者の編集に数えない（続けて採用できるように）
  const conflict = decoded.paragraphHashes
    ? changedSinceRun(decoded.paragraphHashes, working, run.id)
    : decoded.baseHash !== contentHashOf(working);
  if (conflict && !input.allowOnConflict) {
    // 生成を始めた後に本文が変わっている。利用者の編集を上書きしないよう、自動では反映しない（A18）
    return {
      status: 'conflict',
      body: working,
      message:
        'AI の生成中に本文が変更されたため、候補を自動では反映しませんでした。差分を確認して段落ごとに採用してください（置き換えずに直後へ追加します）。',
    };
  }

  const view = await toDraftRunView(db, ctx, run, new Set(working.paragraphs.map((p) => p.id)));
  const indexes = [...new Set(input.candidateIndexes)];
  const paragraphs = [...working.paragraphs];
  let adopted = 0;
  for (const index of indexes) {
    const candidate = view.candidates.find((c) => c.index === index);
    if (!candidate) throw new ValidationError('採用しようとした候補が見つかりません。');
    const newId = adoptedParagraphId(run.id, index);
    if (paragraphs.some((p) => p.id === newId)) continue; // 二重押下で同じ段落を 2 度足さない
    const paragraph: BlockParagraph = {
      id: newId,
      kind: candidate.kind,
      children: candidate.children,
      aiRunId: run.id,
    };
    const at = candidate.paragraphId
      ? paragraphs.findIndex((p) => p.id === candidate.paragraphId)
      : -1;
    if (at >= 0 && !conflict) {
      if (paragraphs[at]?.aiRunId === run.id) continue; // 既に同じ実行の候補で置き換え済み
      // 置き換え: 段落 ID を保つ（コメント・差戻しの紐付けを切らない）
      paragraphs[at] = { ...paragraph, id: candidate.paragraphId as string };
    } else if (at >= 0) {
      // 競合中は置き換えず、元の段落（利用者の編集）の直後へ足す
      paragraphs.splice(at + 1, 0, paragraph);
    } else {
      paragraphs.push(paragraph);
    }
    adopted += 1;
  }
  const body = parseBlockBody({ paragraphs });
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

  // すべての候補を採用したら、この実行の確認は終わり（阻害条件「未採用の AI 候補」から外す）
  const allAdopted = view.candidates.every((c) =>
    body.paragraphs.some(
      (p) =>
        p.aiRunId === run.id &&
        (p.id === adoptedParagraphId(run.id, c.index) || p.id === c.paragraphId),
    ),
  );
  if (allAdopted && run.status === 'succeeded' && can(ctx, 'enterprise.ai.run')) {
    await closeRun(db, ctx, run, 'accepted');
  } else if (
    adopted > 0 &&
    run.status === 'succeeded' &&
    !run.acceptedAt &&
    can(ctx, 'enterprise.ai.run')
  ) {
    // 一部だけ採用した: 実行は確認中のまま、採用した事実を実行に残す（閉じるときに「破棄」にしない）
    await db.update('aiRuns', run.id, { acceptedAt: savedAt, reviewedBy: ctx.userId });
  }
  return { status: 'applied', body, savedAt, adopted };
}

async function closeRun(
  db: DbClient,
  ctx: AuthorizationContext,
  run: AiRun,
  decision: 'accepted' | 'rejected',
): Promise<void> {
  const now = new Date().toISOString();
  await db.update('aiRuns', run.id, {
    status: decision,
    reviewedBy: ctx.userId,
    acceptedAt: decision === 'accepted' ? now : null,
    rejectedAt: decision === 'rejected' ? now : null,
  });
  if (decision === 'accepted') {
    await recordAuditEvent(db, ctx, {
      eventType: 'ai_output_accepted',
      resourceType: 'ai_run',
      resourceId: run.id,
      metadata: { feature: 'disclosureBlockDraft', decision: 'edited_accepted' },
    });
  }
}

/**
 * 候補の確認を終える（残りを破棄する）。一部でも採用していれば「採用」、無ければ「破棄」として記録する。
 * ai_runs の更新は AI 実行権限が必要（0023 の RLS と同じ）。
 */
export async function closeDraftRun(
  db: DbClient,
  ctx: AuthorizationContext,
  input: {
    blockId: Uuid;
    runId: Uuid;
    discard?: boolean;
    /** 画面で編集中の本文。省略時はサーバーの作業本文 */
    workingBody?: unknown;
  },
): Promise<'accepted' | 'rejected'> {
  assertCan(ctx, 'enterprise.disclosure.write');
  assertCan(ctx, 'enterprise.ai.run');
  const block = await loadBlock(db, ctx, input.blockId);
  const run = await db.findById('aiRuns', input.runId);
  if (
    !run ||
    run.organizationId !== ctx.workspace.organizationId ||
    run.featureType !== 'disclosureBlockDraft' ||
    !run.inputReferenceIds.includes(TOKEN.block(block.id))
  ) {
    throw new NotFoundError('AI の候補が見つかりません。');
  }
  if (run.status !== 'succeeded') {
    return run.status === 'accepted' ? 'accepted' : 'rejected';
  }
  const body =
    input.workingBody === undefined
      ? (await editingBodyOf(db, ctx, block)).body
      : parseBlockBody(input.workingBody);
  // 一度でも採用した実行は、残りを破棄しても「採用」として閉じる（本文にその実行の段落が残るため、
  // 「破棄」と記録すると AI の記録と本文の出所が食い違う）。discard は残りの候補を捨てる意味
  const decision = wasAdopted(run, body) ? 'accepted' : 'rejected';
  await closeRun(db, ctx, run, decision);
  return decision;
}
