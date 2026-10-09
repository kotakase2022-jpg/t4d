import 'server-only';

import {
  runAi,
  type RequirementMappingSuggestionOutput,
  type RequirementMappingTargetKind,
} from '@/lib/ai';
import { NotFoundError, assertCan, assertEnterpriseWorkspace } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { stableHash } from '@/lib/fixtures/ids';
import type { DbClient } from '@/lib/repositories/types';
import { isUuid } from '@/lib/validation/uuid';
import type { AiRun, AuthorizationContext, DisclosureItem, Uuid } from '@/types/domain';

/**
 * 要求事項の対応付けの候補を AI に出させる（トライアル対応 NF-11）。
 *
 *  - 権限: enterprise.ai.run と enterprise.disclosure.write（候補を採用するのは開示の編集者のため）
 *  - Prompt に入れるのは、対象の本文と、自社の開示プロジェクトに付けた基準の版の要求事項（コード・題名）だけ。
 *    他社のプロジェクトだけが使う版・資料の本文・Secret は入れない
 *  - 結果は ai_runs にだけ残す（候補）。節の対応付け・定性情報の直接対応・横断の対応表には書かない。
 *    採用は人の操作（T1・T8 の画面の CandidateDecision）で行う。横断のマスターには書かない
 *  - AI が入力に無い要求事項を返したら捨てる（候補の一覧と照らす）
 */

export type RequirementMappingTarget =
  | { kind: 'narrative_version'; id: Uuid }
  | { kind: 'disclosure_block'; id: Uuid }
  | { kind: 'requirement_item'; id: Uuid };

/** Prompt に入れる候補の上限（題名は 200 字まで） */
export const MAPPING_CANDIDATE_LIMIT = 300;
const TITLE_CHARS = 200;
const TARGET_TEXT_CHARS = 4000;

export interface RequirementMappingCandidate {
  itemId: Uuid;
  itemCode: string;
  frameworkVersionId: Uuid;
  title: string;
  relation: 'equivalent' | 'partial' | 'related' | null;
  rationale: string;
  confidence: number;
}

export interface RequirementMappingSuggestion {
  run: AiRun;
  targetKind: RequirementMappingTargetKind;
  candidates: RequirementMappingCandidate[];
  warnings: string[];
  /** 入力に無い要求事項として捨てた候補の数 */
  discarded: number;
}

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** 自社の開示プロジェクトに付けた基準の版（削除したプロジェクトを除く） */
async function attachedVersionIds(db: DbClient, organizationId: Uuid): Promise<Set<Uuid>> {
  const [projects, frameworks] = await Promise.all([
    db.select('disclosureProjects', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('projectFrameworks', { where: { organizationId } }),
  ]);
  const live = new Set(projects.map((p) => p.id));
  return new Set(frameworks.filter((f) => live.has(f.projectId)).map((f) => f.frameworkVersionId));
}

async function targetTextOf(
  db: DbClient,
  ctx: AuthorizationContext,
  target: RequirementMappingTarget,
  attached: ReadonlySet<Uuid>,
): Promise<{ text: string; excludeVersionId: Uuid | null; label: string }> {
  const organizationId = ctx.workspace.organizationId;
  if (!isUuid(target.id)) throw new NotFoundError('対象が見つかりません。');
  if (target.kind === 'narrative_version') {
    const version = await db.findById('narrativeVersions', target.id);
    const record = version
      ? await db.findById('narrativeRecords', version.narrativeRecordId)
      : null;
    if (!version || version.organizationId !== organizationId || !record || record.deletedAt) {
      throw new NotFoundError('定性情報が見つかりません。');
    }
    return { text: version.body, excludeVersionId: null, label: record.title };
  }
  if (target.kind === 'disclosure_block') {
    const block = await db.findById('disclosureBlocks', target.id);
    if (!block || block.organizationId !== organizationId || block.deletedAt) {
      throw new NotFoundError('節が見つかりません。');
    }
    const version = block.currentVersionId
      ? await db.findById('disclosureBlockVersions', block.currentVersionId)
      : null;
    if (!version || version.organizationId !== organizationId) {
      throw new ValidationError('節に保存済みの版が無いため、候補を出せません。');
    }
    return { text: version.plainText, excludeVersionId: null, label: block.title };
  }
  const item = await db.findById('disclosureItems', target.id);
  // 自社のプロジェクトに付けた版の要求事項だけを対象にできる
  if (!item || !attached.has(item.frameworkVersionId)) {
    throw new NotFoundError('要求事項が見つかりません。');
  }
  return {
    text: [item.questionText, item.guidance].filter((t) => t && t.trim() !== '').join('\n'),
    // 要求事項どうしの対応は、別の基準の版の要求事項を候補にする
    excludeVersionId: item.frameworkVersionId,
    label: item.code,
  };
}

export async function suggestRequirementMappings(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { target: RequirementMappingTarget; frameworkVersionIds?: readonly Uuid[] | null },
): Promise<RequirementMappingSuggestion> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.ai.run');
  assertCan(ctx, 'enterprise.disclosure.write');
  const organizationId = ctx.workspace.organizationId;
  const attached = await attachedVersionIds(db, organizationId);
  const target = await targetTextOf(db, ctx, input.target, attached);
  if (target.text.trim() === '') {
    throw new ValidationError('対象に本文が無いため、候補を出せません。');
  }

  // 候補にする版: 自社のプロジェクトに付けた版（指定があればその中だけ）
  const wanted = input.frameworkVersionIds?.length
    ? [...attached].filter((id) => input.frameworkVersionIds!.includes(id))
    : [...attached];
  const versionIds = wanted.filter((id) => id !== target.excludeVersionId);
  if (versionIds.length === 0) {
    throw new ValidationError(
      '候補にできる基準の版がありません（プロジェクトに基準を追加してください）。',
    );
  }
  const [items, versions] = await Promise.all([
    db.select('disclosureItems', {
      where: { frameworkVersionId: { in: versionIds } },
      orderBy: [{ column: 'sortOrder' }, { column: 'code' }],
    }),
    db.select('frameworkVersions', { where: { id: { in: versionIds } } }),
  ]);
  const sampleVersion = new Set(
    versions.filter((v) => v.isFixture || v.coverageStatus === 'sample').map((v) => v.id),
  );
  const pool: DisclosureItem[] = items.slice(0, MAPPING_CANDIDATE_LIMIT);
  const byId = new Map(pool.map((i) => [i.id, i]));

  const aiInput = {
    targetKind: input.target.kind,
    targetText: truncate(target.text, TARGET_TEXT_CHARS),
    candidates: pool.map((i) => ({
      itemId: i.id,
      itemCode: i.code,
      title: truncate(i.questionText, TITLE_CHARS),
      sample: sampleVersion.has(i.frameworkVersionId),
    })),
  };
  const { run, output } = await runAi({
    db,
    ctx,
    invocation: {
      feature: 'requirementMappingSuggestion',
      context: {
        organizationName: ctx.workspace.organizationName,
        reportingPeriodLabel: '',
      },
      inputReferenceIds: [input.target.id, ...pool.map((i) => i.id)].slice(0, 50),
      input: aiInput,
    },
    sources: [],
    idempotencyKey: `requirementMappingSuggestion|${organizationId}|${input.target.kind}|${input.target.id}|${stableHash(JSON.stringify(aiInput))}`,
  });

  const result = output as RequirementMappingSuggestionOutput;
  const candidates: RequirementMappingCandidate[] = [];
  let discarded = 0;
  for (const c of result.candidates) {
    const item = byId.get(c.itemId);
    if (!item) {
      discarded += 1;
      continue;
    }
    candidates.push({
      itemId: item.id,
      itemCode: item.code,
      frameworkVersionId: item.frameworkVersionId,
      title: item.questionText,
      relation: input.target.kind === 'requirement_item' ? c.relation : null,
      rationale: c.rationale,
      confidence: c.confidence,
    });
  }
  const warnings = [...result.warnings];
  if (discarded > 0) {
    warnings.push(`候補の一覧に無い要求事項 ${discarded} 件を除きました。`);
  }
  if (items.length > MAPPING_CANDIDATE_LIMIT) {
    warnings.push(
      `候補にできる要求事項が多いため、先頭の ${MAPPING_CANDIDATE_LIMIT} 件だけを AI に渡しました。基準を絞って実行してください。`,
    );
  }
  return { run, targetKind: input.target.kind, candidates, warnings, discarded };
}
