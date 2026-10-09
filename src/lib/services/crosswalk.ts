import 'server-only';

import type { RequirementMappingSuggestionOutput } from '@/lib/ai/schemas';
import { NotFoundError, assertCan } from '@/lib/authorization/can';
import type { RequirementCoverageCategory } from '@/lib/domain/requirement-coverage';
import type { DbClient } from '@/lib/repositories/types';
import { getProject, type ProjectFrameworkView } from '@/lib/services/disclosure-project';
import {
  loadRequirementMatrix,
  type RequirementMatrixRow,
} from '@/lib/services/requirement-matrix';
import { isUuid } from '@/lib/validation/uuid';
import {
  CROSSWALK_RELATIONS,
  type AiRun,
  type AuthorizationContext,
  type CrosswalkRelation,
  type CrosswalkSource,
  type DisclosureProject,
  type Uuid,
} from '@/types/domain';

/**
 * SSBJ ↔ ESRS／ESRS-40a の横断対応表（トライアル対応 NF-09。読むだけ）。
 *
 *  - 対応はテナント横断のマスター（requirement_crosswalks）。顧客は書き換えない（AI の候補も書かない）
 *  - 各基準の区分は、要求事項タブ・対応表と同じ関数（loadRequirementMatrix → classifyRequirement）で導く
 *    （件数を画面・出力で食い違わせない）
 *  - 「片側だけ充足」: 一方が充足確認済みで、もう一方が充足確認済みでない（対象外を除く）。
 *    もう一方は「追加確認が必要」と案内する（同じ本文を再利用できても、相手の基準を満たすとは限らない）
 *  - 共通本文: 両側の節が同じ定性情報の版を引用している（1 回の確定を両方の基準で使っている）
 *  - サンプル（sample_fixture）の対応は架空の整理で、公表資料に基づくものではない（画面に sample-master を出す）
 */

export interface CrosswalkSide {
  itemId: Uuid | null;
  code: string | null;
  title: string | null;
  frameworkVersionId: Uuid;
  frameworkLabel: string;
  /** この基準がプロジェクトに付いているか（付いていなければ区分は出さない） */
  inProject: boolean;
  /** プロジェクトでの区分（プロジェクトに無い基準・対応先なしは null） */
  category: RequirementCoverageCategory | null;
  blocks: Array<{ blockId: Uuid; title: string; statusLabel: string }>;
}

export interface CrosswalkRow {
  id: Uuid;
  relation: CrosswalkRelation;
  rationale: string;
  source: CrosswalkSource;
  sourceRef: string | null;
  sample: boolean;
  ssbj: CrosswalkSide;
  counterpart: CrosswalkSide;
  /** 一方だけ充足確認済み（もう一方は追加確認が必要） */
  oneSided: boolean;
  /** 両側の節が引用している定性情報（題名と版） */
  sharedNarratives: Array<{ title: string; versionNo: number }>;
}

export interface CrosswalkView {
  project: DisclosureProject;
  /** プロジェクトの SSBJ の基準（無ければ横断対応は作れない） */
  ssbjFramework: ProjectFrameworkView | null;
  /** 対応先にできるプロジェクトの基準（SSBJ 以外） */
  counterpartFrameworks: ProjectFrameworkView[];
  rows: CrosswalkRow[];
  relationCounts: Record<CrosswalkRelation, number>;
  oneSidedCount: number;
}

export const CROSSWALK_FILTER_KEYS = ['relation', 'side'] as const;

function sideOf(
  row: RequirementMatrixRow | undefined,
  fallback: {
    itemId: Uuid | null;
    code: string | null;
    title: string | null;
    frameworkVersionId: Uuid;
    frameworkLabel: string;
  },
): CrosswalkSide {
  if (!row) {
    return { ...fallback, inProject: false, category: null, blocks: [] };
  }
  return {
    itemId: row.itemId,
    code: row.code,
    title: row.title,
    frameworkVersionId: row.frameworkVersionId,
    frameworkLabel: row.frameworkLabel,
    inProject: true,
    category: row.category,
    blocks: row.blocks
      .filter((b) => !b.translation)
      .map((b) => ({ blockId: b.blockId, title: b.title, statusLabel: b.statusLabel })),
  };
}

/** 一方だけが充足確認済み（対象外・対応先なし・プロジェクト外の基準は比べない） */
export function isOneSided(a: CrosswalkSide, b: CrosswalkSide): boolean {
  if (a.category === null || b.category === null) return false;
  if (a.category === 'excluded' || b.category === 'excluded') return false;
  return (a.category === 'confirmed') !== (b.category === 'confirmed');
}

export async function loadCrosswalk(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { projectId: Uuid },
): Promise<CrosswalkView> {
  const detail = await getProject(db, ctx, input.projectId);
  const ssbjFramework = detail.frameworks.find((f) => f.frameworkKey === 'ssbj') ?? null;
  const counterpartFrameworks = detail.frameworks.filter((f) => f.frameworkKey !== 'ssbj');
  const relationCounts = Object.fromEntries(CROSSWALK_RELATIONS.map((r) => [r, 0])) as Record<
    CrosswalkRelation,
    number
  >;
  if (!ssbjFramework) {
    return {
      project: detail.project,
      ssbjFramework,
      counterpartFrameworks,
      rows: [],
      relationCounts,
      oneSidedCount: 0,
    };
  }

  const matrix = await loadRequirementMatrix(db, ctx, { projectId: detail.project.id });
  const byItem = new Map(matrix.rows.map((r) => [r.itemId, r]));
  const ssbjRows = matrix.rows.filter((r) => r.frameworkVersionId === ssbjFramework.version.id);
  const ssbjIds = ssbjRows.map((r) => r.itemId);
  const crosswalks =
    ssbjIds.length > 0
      ? await db.select('requirementCrosswalks', { where: { fromItemId: { in: ssbjIds } } })
      : [];
  const counterpartIds = [
    ...new Set(crosswalks.map((c) => c.toItemId).filter((id): id is Uuid => id !== null)),
  ];
  const [counterpartItems, versions] = await Promise.all([
    counterpartIds.length > 0
      ? db.select('disclosureItems', { where: { id: { in: counterpartIds } } })
      : Promise.resolve([]),
    crosswalks.length > 0
      ? db.select('frameworkVersions', {
          where: { id: { in: [...new Set(crosswalks.map((c) => c.toFrameworkVersionId))] } },
        })
      : Promise.resolve([]),
  ]);
  const versionLabel = (id: Uuid) =>
    detail.frameworks.find((f) => f.version.id === id)?.label ??
    versions.find((v) => v.id === id)?.label ??
    '（基準不明）';

  const rows: CrosswalkRow[] = crosswalks.map((c) => {
    const from = byItem.get(c.fromItemId)!;
    const toItem = c.toItemId ? counterpartItems.find((i) => i.id === c.toItemId) : undefined;
    const toRow = c.toItemId ? byItem.get(c.toItemId) : undefined;
    const ssbj = sideOf(from, {
      itemId: from.itemId,
      code: from.code,
      title: from.title,
      frameworkVersionId: from.frameworkVersionId,
      frameworkLabel: from.frameworkLabel,
    });
    const counterpart = sideOf(toRow, {
      itemId: toItem?.id ?? null,
      code: toItem?.code ?? null,
      title: toItem?.questionText ?? null,
      frameworkVersionId: c.toFrameworkVersionId,
      frameworkLabel: versionLabel(c.toFrameworkVersionId),
    });
    const keyOf = (n: { title: string; versionNo: number }) => `${n.title}#${n.versionNo}`;
    const counterpartNarratives = new Set((toRow?.narratives ?? []).map(keyOf));
    const sharedNarratives = from.narratives.filter((n) => counterpartNarratives.has(keyOf(n)));
    relationCounts[c.relation] += 1;
    return {
      id: c.id,
      relation: c.relation,
      rationale: c.rationale,
      source: c.source,
      sourceRef: c.sourceRef,
      sample: c.source === 'sample_fixture',
      ssbj,
      counterpart,
      oneSided: isOneSided(ssbj, counterpart),
      sharedNarratives: [...new Map(sharedNarratives.map((n) => [keyOf(n), n])).values()],
    };
  });
  rows.sort(
    (a, b) =>
      ssbjRows.findIndex((r) => r.itemId === a.ssbj.itemId) -
        ssbjRows.findIndex((r) => r.itemId === b.ssbj.itemId) ||
      (a.counterpart.code ?? '').localeCompare(b.counterpart.code ?? ''),
  );
  return {
    project: detail.project,
    ssbjFramework,
    counterpartFrameworks,
    rows,
    relationCounts,
    oneSidedCount: rows.filter((r) => r.oneSided).length,
  };
}

/** 絞り込み（関係・片側だけ充足） */
export function filterCrosswalkRows(
  rows: readonly CrosswalkRow[],
  filters: { relation?: string | null; side?: string | null },
): CrosswalkRow[] {
  return rows.filter((row) => {
    if (filters.relation && row.relation !== filters.relation) return false;
    if (filters.side === 'one_sided' && !row.oneSided) return false;
    return true;
  });
}

// ======================================================================
// AI の対応候補（表示のみ。横断のマスターには書かない）
// ======================================================================

export interface CrosswalkSuggestion {
  run: AiRun;
  /** 候補を出した SSBJ の要求事項 */
  source: { itemId: Uuid; code: string; title: string };
  candidates: Array<{
    itemId: Uuid;
    code: string;
    title: string;
    frameworkLabel: string;
    relation: Exclude<CrosswalkRelation, 'no_counterpart'> | null;
    rationale: string;
    confidence: number;
  }>;
  warnings: string[];
  /** 採否を記録済み（採用はしない。不採用の理由だけを記録できる） */
  decided: boolean;
}

/**
 * 横断対応表の「AI に対応候補を出させる」の結果を読み直す（?run=）。自社の実行・要求事項どうしの候補だけ。
 * 候補は「Suslab の確認待ちの候補」として表示するだけで、横断対応のマスターには書かない
 */
export async function loadCrosswalkSuggestion(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { projectId: Uuid; runId: string },
): Promise<CrosswalkSuggestion | null> {
  assertCan(ctx, 'enterprise.disclosure.read');
  const detail = await getProject(db, ctx, input.projectId);
  if (!isUuid(input.runId)) return null;
  const run = await db.findById('aiRuns', input.runId);
  if (
    !run ||
    run.organizationId !== detail.project.organizationId ||
    run.featureType !== 'requirementMappingSuggestion'
  ) {
    throw new NotFoundError('AI の候補が見つかりません。');
  }
  const output = run.outputJson as Partial<RequirementMappingSuggestionOutput>;
  if (output.targetKind !== 'requirement_item' || !Array.isArray(output.candidates)) {
    throw new NotFoundError('AI の候補が見つかりません。');
  }
  const sourceId = run.inputReferenceIds[0];
  const projectVersionIds = new Set(detail.frameworks.map((f) => f.version.id));
  const ids = [sourceId, ...output.candidates.map((c) => c.itemId)].filter(
    (id): id is Uuid => typeof id === 'string' && isUuid(id),
  );
  const items =
    ids.length > 0 ? await db.select('disclosureItems', { where: { id: { in: ids } } }) : [];
  const source = items.find((i) => i.id === sourceId);
  if (!source || !projectVersionIds.has(source.frameworkVersionId)) {
    throw new NotFoundError('AI の候補が見つかりません。');
  }
  const labelOf = (versionId: Uuid) =>
    detail.frameworks.find((f) => f.version.id === versionId)?.label ?? '（基準不明）';
  const candidates: CrosswalkSuggestion['candidates'] = [];
  for (const c of output.candidates) {
    const item = items.find((i) => i.id === c.itemId);
    // プロジェクトの基準の要求事項だけ（入力に無い ID は出さない）
    if (!item || !projectVersionIds.has(item.frameworkVersionId)) continue;
    candidates.push({
      itemId: item.id,
      code: item.code,
      title: item.questionText,
      frameworkLabel: labelOf(item.frameworkVersionId),
      relation: c.relation,
      rationale: c.rationale,
      confidence: c.confidence,
    });
  }
  return {
    run,
    source: { itemId: source.id, code: source.code, title: source.questionText },
    candidates,
    warnings: run.warnings,
    decided: run.status !== 'succeeded',
  };
}
