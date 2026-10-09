import 'server-only';

import { NotFoundError, assertCan, assertEnterpriseWorkspace, can } from '@/lib/authorization/can';
import { collectRefs } from '@/lib/domain/disclosure-block';
import { BLOCK_STATUS_LABELS } from '@/lib/domain/disclosure-status';
import { listSharedDataPoints } from '@/lib/services/data-room-sync';
import { computeBlockFreshness, detectFileUpdates } from '@/lib/services/disclosure-recheck';
import type { DbClient } from '@/lib/repositories/types';
import { isUuid } from '@/lib/validation/uuid';
import type {
  AuthorizationContext,
  BlockStatus,
  DisclosureBlock,
  DisclosureBlockVersion,
  DisclosureProject,
  IsoDateTime,
  ReportSnapshot,
  ReportSnapshotKind,
  Uuid,
} from '@/types/domain';

/**
 * 変更の影響先の一覧と、保存しない通知（トライアル対応 NF-16。読むだけ）。
 *
 *  - listDataPointUsage: その Data Point のいずれかの版を引用する節（現在の版・作業本文・承認済みの版の別）、
 *    固定したスナップショット（保証側へ共有中か）、Data Room で共有中の案件（NF-22 の導出）
 *  - listFileUsage: 資料の引用位置を経由して引用している節・定性情報・スナップショット
 *  - listDerivedAttention: 自分が担当の節・最終承認者であるプロジェクトの節のうち、上流の新版・根拠失効・
 *    承認後の変更・資料の新版があるもの。**通知の行は作らず毎回導く**（Demo の Cookie を増やさない。K7）
 *
 * どれも書き込まない。別組織の行は返さない（ID の有無も漏らさない）。
 */

export type BlockUsageKind = 'current' | 'working' | 'approved';

export const BLOCK_USAGE_LABELS: Readonly<Record<BlockUsageKind, string>> = {
  current: '現在の版',
  working: '作業中の本文',
  approved: '承認済みの版',
};

export interface BlockUsage {
  blockId: Uuid;
  projectId: Uuid;
  projectName: string;
  frameworkVersionId: Uuid;
  title: string;
  status: BlockStatus;
  statusLabel: string;
  /** どの本文が引用しているか（現在の版・作業本文・承認済みの版） */
  usage: BlockUsageKind[];
  /** 引用中の版（Data Point なら data_point_versions.id、資料なら source_anchors.id） */
  citedRefIds: Uuid[];
  /** 引用中の版が現在の版か（資料の使用では資料の最新版を引用しているか） */
  upToDate: boolean;
}

export interface SnapshotUsage {
  snapshotId: Uuid;
  projectId: Uuid;
  label: string;
  snapshotNo: number;
  snapshotKind: ReportSnapshotKind;
  createdAt: IsoDateTime;
  /** 保証側へ共有中の案件（取り下げたものを除く） */
  sharedEngagementIds: Uuid[];
}

export interface UsageCounts {
  blocks: number;
  /** 承認済み（approved）のスナップショット */
  approvedReports: number;
  /** 保証側へ共有中の案件（共有レポート・Data Room のいずれか。重複を除く） */
  sharedWithAssurance: number;
}

export interface DataPointUsage {
  dataPointId: Uuid;
  currentVersionId: Uuid | null;
  /** 開示の閲覧権限が無い人には節・スナップショットを出さない（件数も 0。hidden で区別する） */
  disclosureHidden: boolean;
  blocks: BlockUsage[];
  snapshots: SnapshotUsage[];
  /** Data Room（許諾と承認からの導出）で共有中の案件 */
  dataRoomEngagementIds: Uuid[];
  counts: UsageCounts;
}

interface OrgDisclosureState {
  projects: Map<Uuid, DisclosureProject>;
  blocks: DisclosureBlock[];
  versionsById: Map<Uuid, DisclosureBlockVersion>;
}

async function loadOrgDisclosure(db: DbClient, organizationId: Uuid): Promise<OrgDisclosureState> {
  const [projects, blocks, versions] = await Promise.all([
    db.select('disclosureProjects', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('disclosureBlocks', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('disclosureBlockVersions', { where: { organizationId } }),
  ]);
  const projectMap = new Map(projects.map((p) => [p.id, p]));
  return {
    projects: projectMap,
    // 削除したプロジェクトの節は影響先に数えない
    blocks: blocks.filter((b) => projectMap.has(b.projectId)),
    versionsById: new Map(versions.map((v) => [v.id, v])),
  };
}

type RefPicker = (refs: ReturnType<typeof collectRefs>) => Uuid[];

function blockUsagesOf(
  state: OrgDisclosureState,
  pick: RefPicker,
  matches: ReadonlySet<Uuid>,
  upToDate: (cited: Uuid[]) => boolean,
): BlockUsage[] {
  const out: BlockUsage[] = [];
  for (const block of state.blocks) {
    const usage: BlockUsageKind[] = [];
    const cited = new Set<Uuid>();
    const scan = (kind: BlockUsageKind, refs: Uuid[]) => {
      const hit = refs.filter((r) => matches.has(r));
      if (hit.length === 0) return;
      if (!usage.includes(kind)) usage.push(kind);
      for (const r of hit) cited.add(r);
    };
    const current = block.currentVersionId ? state.versionsById.get(block.currentVersionId) : null;
    if (current) scan('current', pick(collectRefs(current.body)));
    if (block.workingBody) scan('working', pick(collectRefs(block.workingBody)));
    const approved = block.approvedVersionId
      ? state.versionsById.get(block.approvedVersionId)
      : null;
    if (approved) scan('approved', pick(collectRefs(approved.body)));
    if (usage.length === 0) continue;
    const project = state.projects.get(block.projectId)!;
    const citedIds = [...cited].sort();
    out.push({
      blockId: block.id,
      projectId: block.projectId,
      projectName: project.name,
      frameworkVersionId: block.frameworkVersionId,
      title: block.title,
      status: block.status,
      statusLabel: BLOCK_STATUS_LABELS[block.status],
      usage,
      citedRefIds: citedIds,
      upToDate: upToDate(citedIds),
    });
  }
  return out.sort(
    (a, b) =>
      a.projectName.localeCompare(b.projectName, 'ja') ||
      a.title.localeCompare(b.title, 'ja') ||
      (a.blockId < b.blockId ? -1 : 1),
  );
}

async function snapshotUsagesOf(
  db: DbClient,
  organizationId: Uuid,
  snapshots: ReportSnapshot[],
): Promise<SnapshotUsage[]> {
  if (snapshots.length === 0) return [];
  const copies = await db.select('sharedReportCopies', {
    where: {
      clientOrganizationId: organizationId,
      snapshotId: { in: snapshots.map((s) => s.id) },
      withdrawnAt: { isNull: true },
    },
  });
  return snapshots
    .map((s) => ({
      snapshotId: s.id,
      projectId: s.projectId,
      label: s.label,
      snapshotNo: s.snapshotNo,
      snapshotKind: s.snapshotKind,
      createdAt: s.createdAt,
      sharedEngagementIds: [
        ...new Set(copies.filter((c) => c.snapshotId === s.id).map((c) => c.engagementId)),
      ].sort(),
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

function countsOf(
  blocks: BlockUsage[],
  snapshots: SnapshotUsage[],
  dataRoomEngagementIds: Uuid[],
): UsageCounts {
  const shared = new Set<Uuid>(dataRoomEngagementIds);
  for (const s of snapshots) for (const id of s.sharedEngagementIds) shared.add(id);
  return {
    blocks: blocks.length,
    approvedReports: snapshots.filter((s) => s.snapshotKind === 'approved').length,
    sharedWithAssurance: shared.size,
  };
}

/** Data Point の影響先（データの詳細・承認済みの値を修正する確認ダイアログで使う） */
export async function listDataPointUsage(
  db: DbClient,
  ctx: AuthorizationContext,
  dataPointId: Uuid,
): Promise<DataPointUsage> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.read');
  const organizationId = ctx.workspace.organizationId;
  const dp = isUuid(dataPointId) ? await db.findById('dataPoints', dataPointId) : null;
  if (!dp || dp.organizationId !== organizationId || dp.deletedAt) {
    throw new NotFoundError('Data Point が見つかりません。');
  }
  const versions = await db.select('dataPointVersions', { where: { dataPointId: dp.id } });
  const versionIds = new Set(versions.map((v) => v.id));

  // Data Room（許諾と承認からの導出）。自社がクライアントの案件だけ
  const engagements = await db.select('engagements', {
    where: { clientOrganizationId: organizationId },
  });
  const dataRoomEngagementIds: Uuid[] = [];
  for (const e of engagements) {
    const shared = await listSharedDataPoints(db, e.id);
    if (shared.some((s) => s.dataPoint.id === dp.id)) dataRoomEngagementIds.push(e.id);
  }
  dataRoomEngagementIds.sort();

  if (!can(ctx, 'enterprise.disclosure.read')) {
    return {
      dataPointId: dp.id,
      currentVersionId: dp.currentVersionId,
      disclosureHidden: true,
      blocks: [],
      snapshots: [],
      dataRoomEngagementIds,
      counts: countsOf([], [], dataRoomEngagementIds),
    };
  }

  const state = await loadOrgDisclosure(db, organizationId);
  const blocks = blockUsagesOf(
    state,
    (refs) => refs.metricVersionIds,
    versionIds,
    (cited) => cited.length > 0 && cited.every((id) => id === dp.currentVersionId),
  );
  const snapshotRows = (await db.select('reportSnapshots', { where: { organizationId } })).filter(
    (s) => state.projects.has(s.projectId) && s.metricValues.some((m) => m.dataPointId === dp.id),
  );
  const snapshots = await snapshotUsagesOf(db, organizationId, snapshotRows);
  return {
    dataPointId: dp.id,
    currentVersionId: dp.currentVersionId,
    disclosureHidden: false,
    blocks,
    snapshots,
    dataRoomEngagementIds,
    counts: countsOf(blocks, snapshots, dataRoomEngagementIds),
  };
}

export interface NarrativeUsage {
  narrativeRecordId: Uuid;
  narrativeVersionId: Uuid;
  title: string;
  /** その定性情報の現在の版か */
  isCurrent: boolean;
}

export interface FileUsage {
  fileId: Uuid;
  disclosureHidden: boolean;
  /** 引用位置（source_anchors）の件数 */
  anchorCount: number;
  blocks: BlockUsage[];
  narratives: NarrativeUsage[];
  snapshots: SnapshotUsage[];
  counts: UsageCounts;
}

/** 資料の影響先（引用位置を経由して引用している節・定性情報・スナップショット） */
export async function listFileUsage(
  db: DbClient,
  ctx: AuthorizationContext,
  fileId: Uuid,
): Promise<FileUsage> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.evidence.read');
  const organizationId = ctx.workspace.organizationId;
  const file = isUuid(fileId) ? await db.findById('files', fileId) : null;
  if (!file || file.organizationId !== organizationId || file.deletedAt) {
    throw new NotFoundError('資料が見つかりません。');
  }
  const fileVersions = await db.select('fileVersions', {
    where: { organizationId, fileId: file.id },
  });
  const fileVersionIds = new Set(fileVersions.map((v) => v.id));
  const latestVersionId =
    fileVersions.reduce<(typeof fileVersions)[number] | null>(
      (a, v) => (!a || v.versionNo > a.versionNo ? v : a),
      null,
    )?.id ?? null;
  const anchors = (await db.select('sourceAnchors', { where: { organizationId } })).filter((a) =>
    fileVersionIds.has(a.fileVersionId),
  );
  const anchorIds = new Set(anchors.map((a) => a.id));
  const anchorVersion = new Map(anchors.map((a) => [a.id, a.fileVersionId]));

  if (!can(ctx, 'enterprise.disclosure.read')) {
    return {
      fileId: file.id,
      disclosureHidden: true,
      anchorCount: anchors.length,
      blocks: [],
      narratives: [],
      snapshots: [],
      counts: countsOf([], [], []),
    };
  }

  const state = await loadOrgDisclosure(db, organizationId);
  const blocks = blockUsagesOf(
    state,
    (refs) => refs.anchorIds,
    anchorIds,
    (cited) => cited.every((id) => anchorVersion.get(id) === latestVersionId),
  );
  const [narrativeVersions, records] = await Promise.all([
    db.select('narrativeVersions', { where: { organizationId } }),
    db.select('narrativeRecords', { where: { organizationId, deletedAt: { isNull: true } } }),
  ]);
  const recordById = new Map(records.map((r) => [r.id, r]));
  const narratives: NarrativeUsage[] = narrativeVersions
    .filter((v) => recordById.has(v.narrativeRecordId))
    .filter((v) => v.sourceAnchorIds.some((id) => anchorIds.has(id)))
    .map((v) => {
      const record = recordById.get(v.narrativeRecordId)!;
      return {
        narrativeRecordId: record.id,
        narrativeVersionId: v.id,
        title: record.title,
        isCurrent: record.currentVersionId === v.id,
      };
    })
    .sort(
      (a, b) =>
        a.title.localeCompare(b.title, 'ja') ||
        (a.narrativeVersionId < b.narrativeVersionId ? -1 : 1),
    );
  const snapshotRows = (await db.select('reportSnapshots', { where: { organizationId } })).filter(
    (s) =>
      state.projects.has(s.projectId) && s.anchors.some((a) => fileVersionIds.has(a.fileVersionId)),
  );
  const snapshots = await snapshotUsagesOf(db, organizationId, snapshotRows);
  return {
    fileId: file.id,
    disclosureHidden: false,
    anchorCount: anchors.length,
    blocks,
    narratives,
    snapshots,
    counts: countsOf(blocks, snapshots, []),
  };
}

// ======================================================================
// 保存しない通知（要再確認）
// ======================================================================

export const ATTENTION_REASONS = [
  'upstream_updated',
  'evidence_invalid',
  'changed_after_approval',
  'file_updated',
] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

export const ATTENTION_REASON_LABELS: Readonly<Record<AttentionReason, string>> = {
  upstream_updated: '上流に新版あり',
  evidence_invalid: '根拠失効',
  changed_after_approval: '承認後に変更あり',
  file_updated: '上流に新版あり（資料）',
};

export type AttentionRole = 'owner' | 'final_approver';

export const ATTENTION_ROLE_LABELS: Readonly<Record<AttentionRole, string>> = {
  owner: '節の担当',
  final_approver: '最終承認者',
};

export interface DerivedAttention {
  blockId: Uuid;
  projectId: Uuid;
  projectName: string;
  title: string;
  status: BlockStatus;
  reasons: AttentionReason[];
  /** 自分がどの立場で受け取るか（担当と最終承認者を兼ねても 1 件にまとめる） */
  roles: AttentionRole[];
}

/**
 * 自分宛ての「要再確認」（担当の節・最終承認者であるプロジェクトの節）。保存しない。
 * 開示の閲覧権限が無ければ空
 */
export async function listDerivedAttention(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<DerivedAttention[]> {
  if (ctx.workspace.organizationType !== 'enterprise') return [];
  if (!can(ctx, 'enterprise.disclosure.read')) return [];
  const organizationId = ctx.workspace.organizationId;
  const state = await loadOrgDisclosure(db, organizationId);
  const out: DerivedAttention[] = [];
  for (const block of state.blocks) {
    const project = state.projects.get(block.projectId)!;
    const roles: AttentionRole[] = [];
    if (block.ownerUserId === ctx.userId) roles.push('owner');
    if (project.finalApproverUserId === ctx.userId) roles.push('final_approver');
    if (roles.length === 0) continue;
    const reasons: AttentionReason[] = [];
    const freshness = await computeBlockFreshness(db, ctx, block);
    if (freshness.status === 'upstream_updated') reasons.push('upstream_updated');
    if (freshness.status === 'evidence_invalid') reasons.push('evidence_invalid');
    if (
      block.approvedVersionId !== null &&
      block.status !== 'approved' &&
      block.currentVersionId !== block.approvedVersionId
    ) {
      reasons.push('changed_after_approval');
    }
    if ((await detectFileUpdates(db, ctx, block)).length > 0) reasons.push('file_updated');
    if (reasons.length === 0) continue;
    out.push({
      blockId: block.id,
      projectId: project.id,
      projectName: project.name,
      title: block.title,
      status: block.status,
      reasons,
      roles,
    });
  }
  return out.sort(
    (a, b) =>
      a.projectName.localeCompare(b.projectName, 'ja') ||
      a.title.localeCompare(b.title, 'ja') ||
      (a.blockId < b.blockId ? -1 : 1),
  );
}
