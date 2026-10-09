import 'server-only';

import { randomUUID } from 'node:crypto';
import { recordAiDecision, type RequirementMappingSuggestionOutput } from '@/lib/ai';
import { recordAiFeedback } from '@/lib/ai/feedback';
import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, can, NotFoundError } from '@/lib/authorization/can';
import { describeFrameworkVersion } from '@/lib/services/disclosure-project';
import { COVERAGE_FRAMEWORK_SHORT_LABELS } from '@/lib/services/content-coverage';
import { suggestRequirementMappings } from '@/lib/services/requirement-mapping-ai';
import { ValidationError } from '@/lib/errors/user-facing';
import { isUuid } from '@/lib/validation/uuid';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AiRun,
  AuthorizationContext,
  DisclosureItem,
  FrameworkKey,
  NarrativeRecord,
  NarrativeRequirementLink,
  Uuid,
} from '@/types/domain';

/**
 * 定性情報と要求事項の直接の対応付け（トライアル対応 NF-06 の P1・NF-11 の定性情報の候補）。
 *
 *  - 原稿の節が無くても、定性情報を要求事項に結べる（基準別の対応状況で「原稿なし」の不足を出すため）
 *  - 結べる要求事項は、定性情報の年度の開示プロジェクトに付けた基準の版のものだけ（他社・無関係の版を結ばない）
 *  - 外すのは deleted_at（物理削除しない。DB のトリガ・Demo の検査と同じ）。外した記録は監査ログに残す
 *  - AI の候補（requirementMappingSuggestion）は ai_runs にだけあり、人が「候補を採用」したときだけ
 *    対応付けになる。不採用の理由は ai_feedback に残す（改善管理表の「AI に関する意見」）
 *  - 権限: 読込は enterprise.disclosure.read、書込は enterprise.disclosure.write。AI は enterprise.ai.run も
 */

/** 1 回の操作で対応付けられる上限（Demo の Cookie は 1 行 200B 弱。付録 B） */
export const NARRATIVE_LINKS_PER_OPERATION = 10;

export interface LinkableRequirementGroup {
  frameworkVersionId: Uuid;
  label: string;
  shortLabel: string;
  positioning: string;
  isSample: boolean;
  items: Array<{ id: Uuid; code: string; section: string; title: string; linked: boolean }>;
}

export interface NarrativeMappingCandidate {
  itemId: Uuid;
  code: string;
  title: string;
  frameworkShortLabel: string;
  rationale: string;
  confidence: number;
  alreadyLinked: boolean;
}

export interface NarrativeMappingCandidates {
  run: AiRun;
  candidates: NarrativeMappingCandidate[];
  warnings: string[];
  /** 採用・不採用を記録済みか */
  decided: 'accepted' | 'rejected' | null;
}

async function loadRecord(
  db: DbClient,
  ctx: AuthorizationContext,
  narrativeRecordId: Uuid,
): Promise<NarrativeRecord> {
  const record = isUuid(narrativeRecordId)
    ? await db.findById('narrativeRecords', narrativeRecordId)
    : null;
  if (!record || record.deletedAt || record.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('定性情報が見つかりません。');
  }
  return record;
}

/**
 * 結べる基準の版: 定性情報の現在の版の年度の開示プロジェクトに付けた版。現在の版が無ければ、
 * 自社のプロジェクトに付けたすべての版
 */
async function linkableVersionIds(
  db: DbClient,
  ctx: AuthorizationContext,
  record: NarrativeRecord,
): Promise<Uuid[]> {
  const organizationId = ctx.workspace.organizationId;
  const [projects, frameworks, current] = await Promise.all([
    db.select('disclosureProjects', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('projectFrameworks', { where: { organizationId } }),
    record.currentVersionId
      ? db.findById('narrativeVersions', record.currentVersionId)
      : Promise.resolve(null),
  ]);
  const scope = current
    ? projects.filter((p) => p.reportingPeriodId === current.reportingPeriodId)
    : projects;
  const projectIds = new Set(scope.map((p) => p.id));
  return [
    ...new Set(
      frameworks.filter((f) => projectIds.has(f.projectId)).map((f) => f.frameworkVersionId),
    ),
  ];
}

async function frameworkKeyByVersion(db: DbClient, versionIds: readonly Uuid[]) {
  const [versions, frameworks] = await Promise.all([
    versionIds.length > 0
      ? db.select('frameworkVersions', { where: { id: { in: [...versionIds] } } })
      : Promise.resolve([]),
    db.select('frameworks'),
  ]);
  const out = new Map<Uuid, { key: FrameworkKey; version: (typeof versions)[number] }>();
  for (const version of versions) {
    const framework = frameworks.find((f) => f.id === version.frameworkId);
    if (framework) out.set(version.id, { key: framework.key, version });
  }
  return out;
}

export async function listNarrativeRequirementLinks(
  db: DbClient,
  ctx: AuthorizationContext,
  narrativeRecordId: Uuid,
): Promise<NarrativeRequirementLink[]> {
  if (!can(ctx, 'enterprise.disclosure.read') && !can(ctx, 'enterprise.disclosure.write')) {
    assertCan(ctx, 'enterprise.disclosure.read');
  }
  const record = await loadRecord(db, ctx, narrativeRecordId);
  return db.select('narrativeRequirementLinks', {
    where: {
      organizationId: record.organizationId,
      narrativeRecordId: record.id,
      deletedAt: { isNull: true },
    },
    orderBy: [{ column: 'createdAt' }, { column: 'id' }],
  });
}

/** 対応付けの追加フォームの選択肢（基準ごと。既に結んだものは linked） */
export async function listLinkableRequirements(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { narrativeRecordId: Uuid },
): Promise<LinkableRequirementGroup[]> {
  const links = await listNarrativeRequirementLinks(db, ctx, input.narrativeRecordId);
  const record = await loadRecord(db, ctx, input.narrativeRecordId);
  const versionIds = await linkableVersionIds(db, ctx, record);
  if (versionIds.length === 0) return [];
  const [items, keys] = await Promise.all([
    db.select('disclosureItems', {
      where: { frameworkVersionId: { in: versionIds } },
      orderBy: [{ column: 'sortOrder' }, { column: 'code' }],
    }),
    frameworkKeyByVersion(db, versionIds),
  ]);
  const linked = new Set(links.map((l) => l.itemId));
  const groups: LinkableRequirementGroup[] = [];
  for (const versionId of versionIds) {
    const meta = keys.get(versionId);
    if (!meta) continue;
    const own = items.filter((i) => i.frameworkVersionId === versionId);
    if (own.length === 0) continue;
    const legal = describeFrameworkVersion(meta.version);
    groups.push({
      frameworkVersionId: versionId,
      label: meta.version.label,
      shortLabel: COVERAGE_FRAMEWORK_SHORT_LABELS[meta.key],
      positioning: legal.label,
      isSample: legal.isSample,
      items: own.map((i) => ({
        id: i.id,
        code: i.code,
        section: i.section,
        title: i.questionText,
        linked: linked.has(i.id),
      })),
    });
  }
  return groups;
}

/** 渡された要求事項が、結べる版のものか（他社・無関係の版は「見つからない」） */
async function linkableItems(
  db: DbClient,
  ctx: AuthorizationContext,
  record: NarrativeRecord,
  itemIds: readonly Uuid[],
): Promise<DisclosureItem[]> {
  const unique = [...new Set(itemIds.filter((id) => isUuid(id)))];
  if (unique.length === 0 || unique.length !== new Set(itemIds).size) {
    throw new ValidationError('対応付ける要求事項を選んでください。');
  }
  const allowed = new Set(await linkableVersionIds(db, ctx, record));
  const items = await db.select('disclosureItems', { where: { id: { in: unique } } });
  if (items.length !== unique.length || items.some((i) => !allowed.has(i.frameworkVersionId))) {
    throw new NotFoundError(
      '要求事項が見つかりません（定性情報の年度のプロジェクトの基準に限ります）。',
    );
  }
  return items;
}

/**
 * 定性情報を要求事項に直接対応付ける。既に結んだ要求事項は飛ばす（全部が既に結ばれていれば断る）
 */
export async function addNarrativeRequirementLinks(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { narrativeRecordId: Uuid; itemIds: readonly Uuid[]; aiRunId?: Uuid | null },
): Promise<NarrativeRequirementLink[]> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const record = await loadRecord(db, ctx, input.narrativeRecordId);
  if (input.itemIds.length > NARRATIVE_LINKS_PER_OPERATION) {
    throw new ValidationError(
      `一度に対応付けられる要求事項は ${NARRATIVE_LINKS_PER_OPERATION} 件までです。`,
    );
  }
  const items = await linkableItems(db, ctx, record, input.itemIds);
  const existing = await db.select('narrativeRequirementLinks', {
    where: {
      organizationId: record.organizationId,
      narrativeRecordId: record.id,
      deletedAt: { isNull: true },
    },
  });
  const linked = new Set(existing.map((l) => l.itemId));
  const fresh = items.filter((i) => !linked.has(i.id));
  if (fresh.length === 0) throw new ValidationError('選んだ要求事項は既に対応付けています。');

  const now = new Date().toISOString();
  const rows: NarrativeRequirementLink[] = fresh.map((item) => ({
    id: randomUUID(),
    organizationId: record.organizationId,
    narrativeRecordId: record.id,
    frameworkVersionId: item.frameworkVersionId,
    itemId: item.id,
    createdAt: now,
    createdBy: ctx.userId,
    deletedAt: null,
    deletedBy: null,
  }));
  await db.insert('narrativeRequirementLinks', rows);
  await recordAuditEvent(db, ctx, {
    eventType: 'requirement_mapping_changed',
    resourceType: 'narrative_record',
    resourceId: record.id,
    afterSummary: `${record.title}: 要求事項 ${fresh.map((i) => i.code).join('、')} を対応付け${input.aiRunId ? '（AI の候補を採用）' : ''}`,
    metadata: {
      added: fresh.map((i) => i.id),
      aiRunId: input.aiRunId ?? null,
    },
  });
  return rows;
}

/** 直接の対応付けを外す（deleted_at を入れる。物理削除しない） */
export async function removeNarrativeRequirementLink(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { linkId: Uuid },
): Promise<NarrativeRequirementLink> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const link = isUuid(input.linkId)
    ? await db.findById('narrativeRequirementLinks', input.linkId)
    : null;
  if (!link || link.organizationId !== ctx.workspace.organizationId || link.deletedAt !== null) {
    throw new NotFoundError('対応付けが見つかりません。');
  }
  const record = await loadRecord(db, ctx, link.narrativeRecordId);
  const item = await db.findById('disclosureItems', link.itemId);
  const now = new Date().toISOString();
  const updated = await db.update('narrativeRequirementLinks', link.id, {
    deletedAt: now,
    deletedBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'requirement_mapping_changed',
    resourceType: 'narrative_record',
    resourceId: record.id,
    beforeSummary: `${record.title}: 要求事項 ${item?.code ?? '—'} に対応`,
    afterSummary: `${record.title}: 要求事項 ${item?.code ?? '—'} の対応付けを外した`,
    metadata: { removed: [link.itemId] },
  });
  return updated;
}

// ----------------------------------------------------------------------
// AI の候補（NF-11。候補だけ。採用は人）
// ----------------------------------------------------------------------

/** 定性情報の現在の版について、AI に対応付けの候補を出させる（ai_runs にだけ残る） */
export async function suggestNarrativeRequirementMappings(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { narrativeRecordId: Uuid },
): Promise<AiRun> {
  assertCan(ctx, 'enterprise.ai.run');
  assertCan(ctx, 'enterprise.disclosure.write');
  const record = await loadRecord(db, ctx, input.narrativeRecordId);
  if (!record.currentVersionId) {
    throw new ValidationError('定性情報に保存済みの版が無いため、候補を出せません。');
  }
  const versionIds = await linkableVersionIds(db, ctx, record);
  if (versionIds.length === 0) {
    throw new ValidationError(
      'この年度の開示プロジェクトに基準が無いため、候補を出せません（プロジェクトに基準を追加してください）。',
    );
  }
  const suggestion = await suggestRequirementMappings(db, ctx, {
    target: { kind: 'narrative_version', id: record.currentVersionId },
    frameworkVersionIds: versionIds,
  });
  return suggestion.run;
}

/**
 * 保存済みの AI 実行から候補を読み直す（?mappingRun=）。その定性情報の版に対する実行だけ。
 * 結べる版に無い要求事項は捨てる（実行後にプロジェクトの基準が変わっても、無関係の要求事項を出さない）
 */
export async function loadNarrativeMappingCandidates(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { narrativeRecordId: Uuid; runId: Uuid },
): Promise<NarrativeMappingCandidates | null> {
  if (!can(ctx, 'enterprise.disclosure.read') && !can(ctx, 'enterprise.disclosure.write')) {
    assertCan(ctx, 'enterprise.disclosure.read');
  }
  const record = await loadRecord(db, ctx, input.narrativeRecordId);
  const run = isUuid(input.runId) ? await db.findById('aiRuns', input.runId) : null;
  if (
    !run ||
    run.organizationId !== record.organizationId ||
    run.featureType !== 'requirementMappingSuggestion' ||
    run.status === 'failed' ||
    run.status === 'running'
  ) {
    return null;
  }
  const versions = await db.select('narrativeVersions', {
    where: { organizationId: record.organizationId, narrativeRecordId: record.id },
  });
  const ownVersionIds = new Set(versions.map((v) => v.id));
  if (!ownVersionIds.has(run.inputReferenceIds[0] ?? '')) return null;

  const output = run.outputJson as unknown as Partial<RequirementMappingSuggestionOutput>;
  const raw = Array.isArray(output.candidates) ? output.candidates : [];
  const allowed = new Set(await linkableVersionIds(db, ctx, record));
  const itemIds = [...new Set(raw.map((c) => c.itemId).filter((id) => isUuid(id)))];
  const [items, links] = await Promise.all([
    itemIds.length > 0
      ? db.select('disclosureItems', { where: { id: { in: itemIds } } })
      : Promise.resolve([]),
    db.select('narrativeRequirementLinks', {
      where: {
        organizationId: record.organizationId,
        narrativeRecordId: record.id,
        deletedAt: { isNull: true },
      },
    }),
  ]);
  const usable = items.filter((i) => allowed.has(i.frameworkVersionId));
  const keys = await frameworkKeyByVersion(db, [
    ...new Set(usable.map((i) => i.frameworkVersionId)),
  ]);
  const linked = new Set(links.map((l) => l.itemId));
  const candidates: NarrativeMappingCandidate[] = [];
  for (const c of raw) {
    const item = usable.find((i) => i.id === c.itemId);
    if (!item || candidates.some((x) => x.itemId === item.id)) continue;
    const key = keys.get(item.frameworkVersionId)?.key;
    candidates.push({
      itemId: item.id,
      code: item.code,
      title: item.questionText,
      frameworkShortLabel: key ? COVERAGE_FRAMEWORK_SHORT_LABELS[key] : '',
      rationale: typeof c.rationale === 'string' ? c.rationale : '',
      confidence: typeof c.confidence === 'number' ? c.confidence : 0,
      alreadyLinked: linked.has(item.id),
    });
  }
  const warnings = Array.isArray(output.warnings) ? output.warnings.map(String) : [];
  if (candidates.length < raw.length) {
    warnings.push('この定性情報の年度のプロジェクトに無い要求事項の候補を除きました。');
  }
  return {
    run,
    candidates,
    warnings,
    decided: run.status === 'accepted' ? 'accepted' : run.status === 'rejected' ? 'rejected' : null,
  };
}

/** 候補を採用する（選んだ要求事項だけを対応付ける。候補に無い要求事項は採用できない） */
export async function adoptNarrativeMappingCandidates(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { narrativeRecordId: Uuid; runId: Uuid; itemIds: readonly Uuid[] },
): Promise<NarrativeRequirementLink[]> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const loaded = await loadNarrativeMappingCandidates(db, ctx, {
    narrativeRecordId: input.narrativeRecordId,
    runId: input.runId,
  });
  if (!loaded) throw new NotFoundError('AI の候補が見つかりません。');
  if (loaded.decided) throw new ValidationError('この候補は採否を記録済みです。');
  const selectable = new Set(
    loaded.candidates.filter((c) => !c.alreadyLinked).map((c) => c.itemId),
  );
  const chosen = [...new Set(input.itemIds)];
  if (chosen.length === 0) throw new ValidationError('採用する要求事項を選んでください。');
  if (chosen.some((id) => !selectable.has(id))) {
    throw new ValidationError(
      '候補に無い要求事項（または既に対応付けた要求事項）は採用できません。',
    );
  }
  const rows = await addNarrativeRequirementLinks(db, ctx, {
    narrativeRecordId: input.narrativeRecordId,
    itemIds: chosen,
    aiRunId: loaded.run.id,
  });
  await recordAiDecision(
    db,
    ctx,
    loaded.run.id,
    chosen.length === selectable.size ? 'accepted' : 'edited_accepted',
    null,
  );
  return rows;
}

/** 候補を採用しない（理由は任意。ai_feedback に残す） */
export async function rejectNarrativeMappingCandidates(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { narrativeRecordId: Uuid; runId: Uuid; reason: string | null },
): Promise<void> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const loaded = await loadNarrativeMappingCandidates(db, ctx, {
    narrativeRecordId: input.narrativeRecordId,
    runId: input.runId,
  });
  if (!loaded) throw new NotFoundError('AI の候補が見つかりません。');
  if (loaded.decided) throw new ValidationError('この候補は採否を記録済みです。');
  await recordAiFeedback(db, ctx, {
    aiRunId: loaded.run.id,
    decision: 'rejected',
    comment: input.reason,
  });
  await recordAiDecision(db, ctx, loaded.run.id, 'rejected', input.reason);
}
