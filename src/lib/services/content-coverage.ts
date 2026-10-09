import 'server-only';

import { assertCan, can, NotFoundError } from '@/lib/authorization/can';
import { missingTemplateFields } from '@/lib/domain/narrative-template';
import {
  REQUIREMENT_COVERAGE_CATEGORIES,
  REQUIREMENT_GAP_LABELS,
  countByCategory,
  type RequirementCoverageCategory,
} from '@/lib/domain/requirement-coverage';
import { BLOCK_STATUS_LABELS } from '@/lib/domain/disclosure-status';
import { diffFrameworkItems, type FrameworkDiff } from '@/lib/domain/framework-diff';
import {
  buildRequirementRows,
  getProject,
  type ProjectDetail,
  type ProjectFrameworkView,
  type RequirementRow,
} from '@/lib/services/disclosure-project';
import { statusLabel } from '@/lib/ui/status/registry';
import { isUuid } from '@/lib/validation/uuid';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  DisclosureBlockVersion,
  DisclosureProject,
  FrameworkKey,
  NarrativeRecord,
  NarrativeRequirementLink,
  NarrativeVersion,
  Uuid,
} from '@/types/domain';

/**
 * 共通本文（定性情報）の基準別の対応状況（トライアル対応 NF-06。スライド 5「同じ本文を複数の要求事項に参照」）。
 *
 * 定性情報 → それを引用している原稿の節（現在の版・承認済みの版）と、直接の対応付け
 * （narrative_requirement_links。原稿が無くても不足を出すため）→ 要求事項 → 基準ごとの 5 区分。
 *
 * 守っていること:
 *  - 区分は要求事項タブ・対応表と**同じ行**（buildRequirementRows → classifyRequirement）から取る。
 *    ここで区分を計算し直さない（画面ごとに件数を食い違わせない）。保存もしない
 *  - 書き込まない（読込で行を作らない。Demo の Cookie を増やさない）
 *  - 対象のプロジェクトは、定性情報の現在の版の年度のプロジェクト（過年度の引用を今年の状況に混ぜない）。
 *    現在の版が無い定性情報は、引用しているプロジェクト
 *  - 公開草案・サンプルの基準は充足確認済みにならない（K6。classifyRequirement が上限を決める）
 *  - 権限: enterprise.disclosure.read（編集権限でも可。getProject と同じ）
 */

/** 基準の短い名前（一覧の列「基準別の状況」に使う） */
export const COVERAGE_FRAMEWORK_SHORT_LABELS: Readonly<Record<FrameworkKey, string>> = {
  ssbj: 'SSBJ',
  esrs_40a: 'CSRD 域外',
  csrd: 'CSRD',
  cdp: 'CDP',
  msci: 'MSCI',
  ftse: 'FTSE',
};

/** 区分の短い名前（一覧の列。正式な名前は状態の登録簿 requirementCoverage） */
export const COVERAGE_CATEGORY_SHORT_LABELS: Readonly<Record<RequirementCoverageCategory, string>> =
  {
    confirmed: '充足',
    needs_check: '追加確認',
    not_addressed: '未対応',
    undetermined: '未判定',
    excluded: '対象外',
  };

/** 一覧の絞り込み ?coverage=（区分＋「要求事項との対応なし」） */
export const CONTENT_COVERAGE_FILTERS = [...REQUIREMENT_COVERAGE_CATEGORIES, 'unmapped'] as const;
export type ContentCoverageFilter = (typeof CONTENT_COVERAGE_FILTERS)[number];

export const CONTENT_COVERAGE_FILTER_LABELS: Readonly<Record<ContentCoverageFilter, string>> = {
  confirmed: '充足確認済みあり',
  needs_check: '追加確認が必要あり',
  not_addressed: '未対応あり',
  undetermined: '未判定あり',
  excluded: '対象外あり',
  unmapped: '要求事項との対応なし',
};

export function isContentCoverageFilter(value: unknown): value is ContentCoverageFilter {
  return (
    typeof value === 'string' && (CONTENT_COVERAGE_FILTERS as readonly string[]).includes(value)
  );
}

export type CoverageVia = 'block' | 'link';

export interface ContentCoverageRow {
  itemId: Uuid;
  code: string;
  section: string;
  title: string;
  category: RequirementCoverageCategory;
  categoryLabel: string;
  gapLabels: string[];
  reasons: string[];
  /** 節の引用経由か、直接の対応付けか（両方あり得る） */
  via: CoverageVia[];
  /** この定性情報を引用している節（この要求事項に対応するもの） */
  blocks: Array<{ id: Uuid; title: string; statusLabel: string }>;
  /** 直接の対応付けの ID（外す操作に使う。無ければ null） */
  linkId: Uuid | null;
  /** 要求事項の詳細（SSBJ は SSBJ 要求事項の詳細、それ以外はプロジェクトの要求事項の詳細） */
  requirementHref: string;
}

export interface ContentCoverageGroup {
  key: string;
  projectId: Uuid;
  projectName: string;
  frameworkVersionId: Uuid;
  frameworkKey: FrameworkKey;
  frameworkLabel: string;
  shortLabel: string;
  /** 版の位置付け（公表済み・公開草案に基づく準備・サンプル（架空）など） */
  positioning: string;
  isSample: boolean;
  /** 公開草案・サンプルなど、正式な準拠の根拠にできない版（充足確認済みにならない） */
  isPreparationOnly: boolean;
  total: number;
  counts: Record<RequirementCoverageCategory, number>;
  rows: ContentCoverageRow[];
}

export interface ContentCoverage {
  record: NarrativeRecord;
  currentVersion: NarrativeVersion | null;
  /** 対象にしたプロジェクト（年度が同じもの） */
  projects: Array<{ id: Uuid; name: string }>;
  groups: ContentCoverageGroup[];
  /** 有効な直接の対応付け */
  links: NarrativeRequirementLink[];
  /** 定性情報そのものの不足（未記入の項目・当年度の根拠なし）。要求事項の区分とは別に示す */
  narrativeGaps: string[];
}

export interface ContentCoverageSummary {
  frameworks: Array<{
    key: string;
    shortLabel: string;
    total: number;
    counts: Record<RequirementCoverageCategory, number>;
  }>;
  /** いずれかの基準でその区分の要求事項がある */
  categories: Set<RequirementCoverageCategory>;
  /** 要求事項との対応（引用・直接）が 1 件も無い */
  unmapped: boolean;
}

function assertCanRead(ctx: AuthorizationContext): void {
  if (!can(ctx, 'enterprise.disclosure.read') && !can(ctx, 'enterprise.disclosure.write')) {
    assertCan(ctx, 'enterprise.disclosure.read');
  }
}

/** 要求事項の詳細の行き先 */
export function requirementHrefOf(
  frameworkKey: FrameworkKey,
  project: Pick<DisclosureProject, 'id' | 'reportingPeriodId'>,
  itemId: Uuid,
): string {
  return frameworkKey === 'ssbj'
    ? `/enterprise/disclosures/ssbj/requirements/${itemId}?period=${project.reportingPeriodId}`
    : `/enterprise/disclosure-projects/${project.id}/requirements/${itemId}`;
}

/** 1 回の読込で使い回す材料（一覧で全定性情報を数えるときも同じ計算を 1 回だけ行う） */
interface CoverageMaterial {
  projects: DisclosureProject[];
  details: Map<Uuid, ProjectDetail>;
  /** projectFrameworkId → 行 */
  rowsByPf: Map<Uuid, { view: ProjectFrameworkView; rows: RequirementRow[] }>;
  blockVersions: Map<Uuid, DisclosureBlockVersion>;
  narrativeVersions: NarrativeVersion[];
  links: NarrativeRequirementLink[];
}

async function loadMaterial(
  db: DbClient,
  ctx: AuthorizationContext,
  projectIds: readonly Uuid[],
): Promise<CoverageMaterial> {
  const organizationId = ctx.workspace.organizationId;
  const [allProjects, narrativeVersions, links] = await Promise.all([
    db.select('disclosureProjects', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('narrativeVersions', { where: { organizationId } }),
    db.select('narrativeRequirementLinks', {
      where: { organizationId, deletedAt: { isNull: true } },
    }),
  ]);
  const projects = allProjects.filter((p) => projectIds.includes(p.id));
  const details = new Map<Uuid, ProjectDetail>();
  const rowsByPf = new Map<Uuid, { view: ProjectFrameworkView; rows: RequirementRow[] }>();
  const versionIds = new Set<Uuid>();
  for (const project of projects) {
    const detail = await getProject(db, ctx, project.id);
    details.set(project.id, detail);
    for (const block of detail.blocks) {
      if (block.currentVersionId) versionIds.add(block.currentVersionId);
      if (block.approvedVersionId) versionIds.add(block.approvedVersionId);
    }
    for (const view of detail.frameworks) {
      const result = await buildRequirementRows(db, ctx, detail, view);
      rowsByPf.set(view.projectFramework.id, { view, rows: result.rows });
    }
  }
  const blockVersions = new Map<Uuid, DisclosureBlockVersion>();
  if (versionIds.size > 0) {
    const versions = await db.select('disclosureBlockVersions', {
      where: { organizationId, id: { in: [...versionIds] } },
    });
    for (const v of versions) blockVersions.set(v.id, v);
  }
  return { projects, details, rowsByPf, blockVersions, narrativeVersions, links };
}

/** 対象のプロジェクト: 現在の版の年度のもの。現在の版が無ければ、引用しているもの */
function scopeProjectsFor(
  record: NarrativeRecord,
  current: NarrativeVersion | null,
  projects: readonly DisclosureProject[],
  citingProjectIds: ReadonlySet<Uuid>,
): DisclosureProject[] {
  if (current) return projects.filter((p) => p.reportingPeriodId === current.reportingPeriodId);
  return projects.filter(
    (p) => citingProjectIds.has(p.id) && p.organizationId === record.organizationId,
  );
}

function groupsFor(
  record: NarrativeRecord,
  scope: readonly DisclosureProject[],
  material: CoverageMaterial,
): ContentCoverageGroup[] {
  const versionIdsOfRecord = new Set(
    material.narrativeVersions.filter((v) => v.narrativeRecordId === record.id).map((v) => v.id),
  );
  const links = material.links.filter((l) => l.narrativeRecordId === record.id);
  const groups: ContentCoverageGroup[] = [];

  for (const project of scope) {
    const detail = material.details.get(project.id);
    if (!detail) continue;
    // この定性情報を引用している節（現在の版か承認済みの版の本文が引用している）
    const citing = detail.blocks.filter((block) =>
      [block.currentVersionId, block.approvedVersionId].some((versionId) => {
        if (!versionId) return false;
        const version = material.blockVersions.get(versionId);
        return version?.narrativeRefs.some((ref) => versionIdsOfRecord.has(ref)) ?? false;
      }),
    );
    for (const view of detail.frameworks) {
      const entry = material.rowsByPf.get(view.projectFramework.id);
      if (!entry) continue;
      const blocksOfFramework = citing.filter((b) => b.frameworkVersionId === view.version.id);
      const linksOfFramework = links.filter((l) => l.frameworkVersionId === view.version.id);
      const itemIds = new Set<Uuid>([
        ...blocksOfFramework.flatMap((b) => b.requirementItemIds),
        ...linksOfFramework.map((l) => l.itemId),
      ]);
      if (itemIds.size === 0) continue;
      const rows: ContentCoverageRow[] = entry.rows
        .filter((row) => itemIds.has(row.item.id))
        .map((row) => {
          const viaBlocks = blocksOfFramework.filter((b) =>
            b.requirementItemIds.includes(row.item.id),
          );
          const link = linksOfFramework.find((l) => l.itemId === row.item.id) ?? null;
          const via: CoverageVia[] = [];
          if (viaBlocks.length > 0) via.push('block');
          if (link) via.push('link');
          return {
            itemId: row.item.id,
            code: row.item.code,
            section: row.item.section,
            title: row.item.questionText,
            category: row.coverage.category,
            categoryLabel: statusLabel('requirementCoverage', row.coverage.category),
            gapLabels: row.coverage.gaps.map((g) => REQUIREMENT_GAP_LABELS[g]),
            reasons: row.coverage.reasons,
            via,
            blocks: viaBlocks.map((b) => ({
              id: b.id,
              title: b.title,
              statusLabel: BLOCK_STATUS_LABELS[b.status],
            })),
            linkId: link?.id ?? null,
            requirementHref: requirementHrefOf(view.frameworkKey, project, row.item.id),
          };
        });
      if (rows.length === 0) continue;
      groups.push({
        key: `${project.id}:${view.projectFramework.id}`,
        projectId: project.id,
        projectName: project.name,
        frameworkVersionId: view.version.id,
        frameworkKey: view.frameworkKey,
        frameworkLabel: view.label,
        shortLabel: COVERAGE_FRAMEWORK_SHORT_LABELS[view.frameworkKey],
        positioning: view.legal.label,
        isSample: view.legal.isSample,
        isPreparationOnly: view.legal.isPreparationOnly,
        total: rows.length,
        counts: countByCategory(rows.map((r) => r.category)),
        rows,
      });
    }
  }
  return groups;
}

/** 引用しているプロジェクト（現在の版が無い定性情報の対象を決めるため） */
function citingProjectIdsOf(record: NarrativeRecord, material: CoverageMaterial): Set<Uuid> {
  const ids = new Set(
    material.narrativeVersions.filter((v) => v.narrativeRecordId === record.id).map((v) => v.id),
  );
  const out = new Set<Uuid>();
  for (const detail of material.details.values()) {
    for (const block of detail.blocks) {
      for (const versionId of [block.currentVersionId, block.approvedVersionId]) {
        const version = versionId ? material.blockVersions.get(versionId) : undefined;
        if (version?.narrativeRefs.some((ref) => ids.has(ref))) out.add(detail.project.id);
      }
    }
  }
  return out;
}

/** 定性情報そのものの不足（区分とは別に示す） */
async function narrativeGapsOf(
  db: DbClient,
  record: NarrativeRecord,
  current: NarrativeVersion | null,
): Promise<string[]> {
  if (!current) return ['現在の版がありません。'];
  const gaps: string[] = [];
  const missing = missingTemplateFields(record.theme, current.fields);
  if (missing.length > 0) gaps.push(`未記入の項目 ${missing.length} 件`);
  if (current.sourceAnchorIds.length === 0) {
    gaps.push('根拠（引用位置）なし');
  } else {
    const anchors = await db.select('sourceAnchors', {
      where: { id: { in: current.sourceAnchorIds } },
    });
    const fileVersions = anchors.length
      ? await db.select('fileVersions', {
          where: { id: { in: [...new Set(anchors.map((a) => a.fileVersionId))] } },
        })
      : [];
    const files = fileVersions.length
      ? await db.select('files', {
          where: { id: { in: [...new Set(fileVersions.map((v) => v.fileId))] } },
        })
      : [];
    const currentFact = files.some((f) => !f.deletedAt && f.usagePurpose === 'current_fact');
    if (!currentFact) gaps.push('当年度の根拠なし（過年度・参考の資料だけ）');
  }
  return gaps;
}

/**
 * 1 件の定性情報の基準別の対応状況（編集画面の「基準別の対応状況」）。書き込まない
 */
export async function loadContentCoverage(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { narrativeRecordId: Uuid },
): Promise<ContentCoverage> {
  assertCanRead(ctx);
  const organizationId = ctx.workspace.organizationId;
  const record = isUuid(input.narrativeRecordId)
    ? await db.findById('narrativeRecords', input.narrativeRecordId)
    : null;
  if (!record || record.deletedAt || record.organizationId !== organizationId) {
    throw new NotFoundError('定性情報が見つかりません。');
  }
  const current = record.currentVersionId
    ? await db.findById('narrativeVersions', record.currentVersionId)
    : null;
  const allProjects = await db.select('disclosureProjects', {
    where: { organizationId, deletedAt: { isNull: true } },
    orderBy: [{ column: 'periodStart', dir: 'desc' }, { column: 'id' }],
  });
  // 現在の版の年度のプロジェクトだけを読む。現在の版が無ければ全件から引用元を探す
  const candidateIds = current
    ? allProjects.filter((p) => p.reportingPeriodId === current.reportingPeriodId).map((p) => p.id)
    : allProjects.map((p) => p.id);
  const material = await loadMaterial(db, ctx, candidateIds);
  const scope = scopeProjectsFor(
    record,
    current,
    material.projects,
    citingProjectIdsOf(record, material),
  );
  return {
    record,
    currentVersion: current,
    projects: scope.map((p) => ({ id: p.id, name: p.name })),
    groups: groupsFor(record, scope, material),
    links: material.links.filter((l) => l.narrativeRecordId === record.id),
    narrativeGaps: await narrativeGapsOf(db, record, current),
  };
}

/**
 * 定性情報の一覧の列「基準別の状況」と絞り込み ?coverage= のための要約（全件を 1 回の計算で）。書き込まない
 */
export async function loadContentCoverageSummaries(
  db: DbClient,
  ctx: AuthorizationContext,
  records: readonly NarrativeRecord[],
): Promise<Map<Uuid, ContentCoverageSummary>> {
  assertCanRead(ctx);
  const out = new Map<Uuid, ContentCoverageSummary>();
  if (records.length === 0) return out;
  const organizationId = ctx.workspace.organizationId;
  const projects = await db.select('disclosureProjects', {
    where: { organizationId, deletedAt: { isNull: true } },
  });
  const material = await loadMaterial(
    db,
    ctx,
    projects.map((p) => p.id),
  );
  const versionById = new Map(material.narrativeVersions.map((v) => [v.id, v]));
  for (const record of records) {
    if (record.organizationId !== organizationId) continue;
    const current = record.currentVersionId
      ? (versionById.get(record.currentVersionId) ?? null)
      : null;
    const scope = scopeProjectsFor(
      record,
      current,
      material.projects,
      citingProjectIdsOf(record, material),
    );
    const groups = groupsFor(record, scope, material);
    const categories = new Set<RequirementCoverageCategory>();
    for (const group of groups) {
      for (const category of REQUIREMENT_COVERAGE_CATEGORIES) {
        if (group.counts[category] > 0) categories.add(category);
      }
    }
    out.set(record.id, {
      frameworks: groups.map((g) => ({
        key: g.key,
        shortLabel: g.shortLabel,
        total: g.total,
        counts: g.counts,
      })),
      categories,
      unmapped: groups.length === 0,
    });
  }
  return out;
}

/** 一覧の列の文言（例「SSBJ 充足 3・追加確認 1／CSRD 域外 追加確認 1」）。0 件の区分は出さない */
export function coverageSummaryText(summary: ContentCoverageSummary | undefined): string {
  if (!summary || summary.frameworks.length === 0) return '要求事項との対応なし';
  return summary.frameworks
    .map((f) => {
      const parts = REQUIREMENT_COVERAGE_CATEGORIES.filter((c) => f.counts[c] > 0).map(
        (c) => `${COVERAGE_CATEGORY_SHORT_LABELS[c]} ${f.counts[c]}`,
      );
      return `${f.shortLabel} ${parts.join('・')}`;
    })
    .join('／');
}

/** 絞り込み ?coverage= に当たるか */
export function matchesCoverageFilter(
  summary: ContentCoverageSummary | undefined,
  filter: ContentCoverageFilter,
): boolean {
  if (filter === 'unmapped') return !summary || summary.unmapped;
  return summary?.categories.has(filter) ?? false;
}

// ======================================================================
// 基準の新しい版の影響先（トライアル対応 NF-08。プロジェクト設定タブの「新しい版の追加と影響の確認」）
// ======================================================================

export type MigrationImpactKind = 'block' | 'narrative_link' | 'crosswalk' | 'exclusion';

export const MIGRATION_IMPACT_KIND_LABELS: Readonly<Record<MigrationImpactKind, string>> = {
  block: '原稿の節',
  narrative_link: '定性情報の直接の対応付け',
  crosswalk: '横断対応表の行',
  exclusion: '対象外の判断',
};

export interface MigrationImpactTarget {
  kind: MigrationImpactKind;
  label: string;
  /** 関係する旧版の要求事項コード */
  codes: string[];
  href: string | null;
}

export interface VersionMigrationImpact {
  /** 新しい版の要求事項が未収録（公開草案など）。差分・影響は算定しない */
  notLoaded: boolean;
  diff: FrameworkDiff | null;
  /** 文言の変更・改番・削除のあった旧版の要求事項に結び付いたもの（要再確認） */
  targets: MigrationImpactTarget[];
}

/**
 * 新しい版へ移すときに再確認が要るもの。差分（domain/framework-diff.ts。改番は前の版の項番で対応を取る）で
 * 文言の変更・改番・削除になった旧版の要求事項に結び付いた節・定性情報の直接の対応付け・横断対応表の行・
 * 対象外の判断を並べる。引継ぎは自動では行わない（人が確認する）。書き込まない
 */
export async function loadVersionMigrationImpact(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { projectId: Uuid; projectFrameworkId: Uuid; toVersionId: Uuid },
): Promise<VersionMigrationImpact> {
  const detail = await getProject(db, ctx, input.projectId);
  const view = detail.frameworks.find((f) => f.projectFramework.id === input.projectFrameworkId);
  if (!view) throw new NotFoundError('基準が見つかりません。');
  const organizationId = detail.project.organizationId;
  const [fromItems, toItems, toVersion] = await Promise.all([
    db.select('disclosureItems', { where: { frameworkVersionId: view.version.id } }),
    db.select('disclosureItems', { where: { frameworkVersionId: input.toVersionId } }),
    db.findById('frameworkVersions', input.toVersionId),
  ]);
  if (!toVersion || toVersion.frameworkId !== view.version.frameworkId) {
    throw new NotFoundError('新しい版が見つかりません。');
  }
  if (toItems.length === 0) return { notLoaded: true, diff: null, targets: [] };

  const diff = diffFrameworkItems(fromItems, toItems);
  const affected = new Map<Uuid, string>();
  for (const entry of diff.entries) {
    if (
      (entry.kind === 'removed' || entry.kind === 'changed' || entry.kind === 'renumbered') &&
      entry.fromItemId
    ) {
      affected.set(entry.fromItemId, entry.fromCode ?? '');
    }
  }
  if (affected.size === 0) return { notLoaded: false, diff, targets: [] };
  const codesOf = (ids: readonly Uuid[]) =>
    [...new Set(ids.filter((id) => affected.has(id)).map((id) => affected.get(id)!))].sort();

  const affectedIds = [...affected.keys()];
  const [links, records, crosswalks, assessments, exclusionEvents] = await Promise.all([
    db.select('narrativeRequirementLinks', {
      where: { organizationId, deletedAt: { isNull: true }, itemId: { in: affectedIds } },
    }),
    db.select('narrativeRecords', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('requirementCrosswalks'),
    db.select('projectRequirementAssessments', {
      where: { organizationId, projectFrameworkId: view.projectFramework.id },
    }),
    db.select('requirementExclusionEvents', {
      where: {
        organizationId,
        reportingPeriodId: detail.project.reportingPeriodId,
        itemId: { in: affectedIds },
      },
    }),
  ]);

  const targets: MigrationImpactTarget[] = [];
  for (const block of detail.blocks) {
    if (block.frameworkVersionId !== view.version.id) continue;
    const codes = codesOf(block.requirementItemIds);
    if (codes.length === 0) continue;
    targets.push({
      kind: 'block',
      label: `${block.title}（${BLOCK_STATUS_LABELS[block.status]}）`,
      codes,
      href: `/enterprise/disclosure-projects/${detail.project.id}/blocks/${block.id}`,
    });
  }
  const recordById = new Map(records.map((r) => [r.id, r]));
  for (const recordId of [...new Set(links.map((l) => l.narrativeRecordId))]) {
    const record = recordById.get(recordId);
    if (!record) continue;
    targets.push({
      kind: 'narrative_link',
      label: record.title,
      codes: codesOf(links.filter((l) => l.narrativeRecordId === recordId).map((l) => l.itemId)),
      href: `/enterprise/narratives/${record.id}#nv-coverage`,
    });
  }
  const crossRows = crosswalks.filter(
    (c) => affected.has(c.fromItemId) || (c.toItemId !== null && affected.has(c.toItemId)),
  );
  if (crossRows.length > 0) {
    targets.push({
      kind: 'crosswalk',
      label: `横断対応表 ${crossRows.length} 行`,
      codes: codesOf(crossRows.flatMap((c) => [c.fromItemId, ...(c.toItemId ? [c.toItemId] : [])])),
      href: `/enterprise/disclosure-projects/${detail.project.id}?tab=crosswalk`,
    });
  }
  const excludedItemIds = [
    ...assessments
      .filter(
        (a) =>
          affected.has(a.itemId) &&
          (a.applicability === 'not_applicable' || a.applicability === 'not_material'),
      )
      .map((a) => a.itemId),
    ...exclusionEvents.map((e) => e.itemId),
  ];
  const excludedCodes = codesOf(excludedItemIds);
  if (excludedCodes.length > 0) {
    targets.push({
      kind: 'exclusion',
      label: `対象外・非重要の判断 ${excludedCodes.length} 件`,
      codes: excludedCodes,
      href: `/enterprise/disclosure-projects/${detail.project.id}?tab=requirements&fw=${view.projectFramework.id}`,
    });
  }
  return { notLoaded: false, diff, targets };
}
