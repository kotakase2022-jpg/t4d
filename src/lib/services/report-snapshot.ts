import 'server-only';

import { randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import {
  AuthorizationError,
  NotFoundError,
  assertCan,
  assertEnterpriseWorkspace,
  can,
} from '@/lib/authorization/can';
import { canonicalJson, hasBodyContent, isOldRefKept } from '@/lib/domain/disclosure-block';
import {
  asSnapshotDetail,
  computeSnapshotContentHash,
  isDraftStandard,
  namesMentionedIn,
  snapshotAnchorOf,
  snapshotApprovalOf,
  snapshotBlockOf,
  snapshotCommentOf,
  snapshotFrameworkOf,
  snapshotMetricValueOf,
  csrdRequirementDigest,
  snapshotRequirementStateOf,
  ssbjRequirementDigest,
  snapshotRequirementsOf,
  unresolvedCommentsInOrder,
  type ReportSnapshotDetail,
  type SnapshotAnchor,
  type SnapshotRequirementState,
  type SnapshotBlock,
  type SnapshotFramework,
  type SnapshotIssue,
  type SnapshotIssueCode,
  type SnapshotMetricValue,
  type SnapshotRequirement,
} from '@/lib/domain/report-snapshot-content';
import {
  APPLICABILITY_STATUS_LABELS,
  AVAILABILITY_STATUS_LABELS,
  BLOCK_STATUS_LABELS,
  DISCLOSURE_LANGUAGE_LABELS,
  FRAMEWORK_COVERAGE_STATUS_LABELS,
  REPORT_SNAPSHOT_KIND_LABELS,
  VALUE_KIND_LABELS,
  applicabilityDecisionChangedSince,
  evaluateBlockBlockers,
} from '@/lib/domain/disclosure-status';
import { assessNarrativeFields, notQuantifiedNote } from '@/lib/domain/narrative-template';
import { ValidationError } from '@/lib/errors/user-facing';
import {
  APPLICABILITY_RECHECK_MESSAGE,
  SCOPE_RECHECK_MESSAGE,
} from '@/lib/services/disclosure-block';
import type { DbClient, Row, TableName, Where } from '@/lib/repositories/types';
import { isUuid } from '@/lib/validation/uuid';
import type {
  ApplicabilityStatus,
  AuthorizationContext,
  BlockBody,
  DataPoint,
  DataPointVersion,
  DisclosureBlock,
  DisclosureBlockVersion,
  DisclosureFramework,
  DisclosureLanguage,
  DisclosureProject,
  DisclosurePurpose,
  IsoDateTime,
  NarrativeTheme,
  ProjectFramework,
  ReportSnapshot,
  ReportSnapshotKind,
  Uuid,
} from '@/types/domain';

/**
 * レポートのスナップショット（docs/disclosure-first.md §3 0038・§5「レポート確定」、指示書 §6.10・§10.2・§10.3）。
 *
 * 出力（DOCX / XLSX / CSV）は必ずここで固定した内容から作る。ライブの最新値から組み立て直すと、
 * 同じ「承認済みレポート」を 2 回出力したときに中身が変わりうるうえ、何を出したかを後から示せないため。
 *
 * - レビュー用草稿（review_draft）はいつでも作れる。保存済みの版（current_version）だけを固定し、
 *   自動保存中の作業本文（working_body）は含めない（業務上の版ではないため）。
 *   未承認の節・不足情報は節ごとの issues に書き、出力で明示する。
 * - 社内承認済み版（approved）は、適用する基準の全節が承認済みで阻害条件が無く、
 *   確定者が承認権限を持ち、かつ全節の唯一の作成者ではないときだけ作る（サーバーで毎回再検証する）。
 *   草案の基準（ESRS-40a 公開草案など）による準備は、その区分のまま社内で確定できるが、
 *   ラベルは「草案基準による準備」で、法定準拠の確定としては扱わない。
 * - スナップショットは追記専用。作成後に上流（数値・定性情報・節）が変わっても内容は変えず、
 *   画面で「上流に変更あり」を注意情報として示すだけにする。
 *
 * スナップショットの jsonb には、出力に要る写し（ファイル名・版番号・期間・要求事項コードなど）を
 * 型（src/types/domain.ts）の基本項目に加えて持たせる。出力時にライブの行を引き直すと、
 * 固定した内容と出力が食い違うため（ファイル名の変更・指標名の変更など）。
 */

// スナップショットの型・内容ハッシュ・写しの作り方は domain に置く（Demo Mode で Cookie の目録から
// 写しを組み立て直すとき（demo-compact.ts）も同じ規則を使うため）
export {
  SNAPSHOT_HASH_VERSION,
  SNAPSHOT_HASH_VERSION_V1,
  asSnapshotDetail,
  computeSnapshotContentHash,
  isSnapshotV2,
} from '@/lib/domain/report-snapshot-content';
export type {
  ReportSnapshotDetail,
  SnapshotAnchor,
  SnapshotBlock,
  SnapshotBlockApproval,
  SnapshotRequirementState,
  SnapshotComment,
  SnapshotFramework,
  SnapshotIssue,
  SnapshotIssueCode,
  SnapshotMetricValue,
  SnapshotRequirement,
} from '@/lib/domain/report-snapshot-content';

/**
 * 画面・出力で使うスナップショット種別の表示（社内承認を保証と取り違えさせない）。
 * 表記はドメインのラベルが唯一の出所。ここで別の文字列を持つと画面と出力で食い違う
 */
export const SNAPSHOT_KIND_DISPLAY: Record<ReportSnapshotKind, string> =
  REPORT_SNAPSHOT_KIND_LABELS;

/**
 * 保存された内容が作成時のハッシュと一致するか（出力の直前に確かめる）。
 * 規則の版は写しから決まる（v2 の項目を持つ写しは v2、持たない以前の写しは v1 の規則で検査する）
 */
export function verifySnapshotIntegrity(snapshot: ReportSnapshot): boolean {
  return computeSnapshotContentHash(snapshot) === snapshot.contentHash;
}

// ======================================================================
// 共通の読み込み
// ======================================================================

/** id の一覧で引く。空なら問い合わせない（PostgREST の in.() に空を渡さない） */
async function selectByIds<K extends TableName>(
  db: DbClient,
  table: K,
  ids: readonly Uuid[],
  extra?: Where<Row<K>>,
): Promise<Row<K>[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  return db.select(table, {
    where: { ...(extra ?? {}), id: { in: unique } } as Where<Row<K>>,
  });
}

/** 企業ワークスペースの自組織のプロジェクトを引く。他テナント・削除済みは存在を秘匿する */
export async function loadOwnedProject(
  db: DbClient,
  ctx: AuthorizationContext,
  projectId: Uuid,
): Promise<DisclosureProject> {
  assertEnterpriseWorkspace(ctx);
  const project = isUuid(projectId) ? await db.findById('disclosureProjects', projectId) : null;
  if (!project || project.organizationId !== ctx.workspace.organizationId || project.deletedAt) {
    throw new NotFoundError('開示プロジェクトが見つかりません。');
  }
  return project;
}

/** 自組織のスナップショットを引く。他テナントの ID は「見つからない」として扱う（A29） */
export async function loadOwnedSnapshot(
  db: DbClient,
  ctx: AuthorizationContext,
  snapshotId: Uuid,
): Promise<ReportSnapshotDetail> {
  assertEnterpriseWorkspace(ctx);
  // UUID でない ID は Supabase Mode で 22P02 → 500 になるため、先に「見つからない」とする
  const row = isUuid(snapshotId) ? await db.findById('reportSnapshots', snapshotId) : null;
  if (!row || row.organizationId !== ctx.workspace.organizationId) {
    // デモではスナップショットはインスタンスのメモリにしか無い（docs/known-limitations.md D-3）。
    // 別インスタンスで開くとここに来るため、存在の有無を区別せず同じ文言にする
    throw new NotFoundError('スナップショットが見つかりません。');
  }
  return asSnapshotDetail(row);
}

// ======================================================================
// 組み立て（草稿・確定で共通。確定前の検証も同じ関数で行う）
// ======================================================================

export interface ReportFrameworkSummary {
  frameworkVersionId: Uuid;
  label: string;
  purpose: DisclosurePurpose;
  applicabilityStatus: ApplicabilityStatus;
  decided: boolean;
  draftStandardPrep: boolean;
  /** 対象外と判断した基準の節は出力に含めない */
  included: boolean;
  blockCount: number;
}

export interface ReportBlocker {
  code: SnapshotIssueCode | 'framework_applicability_unconfirmed' | 'no_blocks';
  message: string;
  blockId?: Uuid;
}

interface Assembly {
  project: DisclosureProject;
  frameworks: SnapshotFramework[];
  frameworkSummaries: ReportFrameworkSummary[];
  decisionIds: Uuid[];
  blocks: SnapshotBlock[];
  metricValues: SnapshotMetricValue[];
  narrativeVersionIds: Uuid[];
  anchors: SnapshotAnchor[];
  policyVersion: string | null;
  /** 確定を止める条件（草稿では注意として出すだけ） */
  blockers: ReportBlocker[];
  draftStandardPrep: boolean;
  /** 固定した版ごとの本文を書いた人（作成者と自動保存した人。職務分離の判定に使う） */
  versionWriters: Uuid[][];
  /** 固定時点（作成日時に使う）。この時点までの判断・承認の記録を写しに固定した */
  asOf: IsoDateTime;
}

/** 適用判断が確定しているか（判断の記録があり、適用・任意適用のいずれか） */
function isApplicabilityConfirmed(pf: ProjectFramework): boolean {
  return (
    pf.currentDecisionId !== null &&
    (pf.applicabilityStatus === 'applicable' || pf.applicabilityStatus === 'voluntary')
  );
}

/**
 * 定性情報の未記入項目と、未記入の代わりに示す注記。開示ホーム・原稿一覧と同じ判定
 * （domain/narrative-template.ts の assessNarrativeFields）を通す（以前はここだけ財務的影響の数え方が違った）
 */
function narrativeGaps(
  theme: NarrativeTheme,
  fields: Readonly<Record<string, string>>,
): { missing: string[]; note: string | null } {
  const assessed = assessNarrativeFields(theme, fields);
  return {
    missing: assessed.missing.map((f) => f.label),
    note: assessed.notQuantifiedReason ? notQuantifiedNote(assessed.notQuantifiedReason) : null,
  };
}

function formatMetricLabel(
  mv: Pick<SnapshotMetricValue, 'metricName' | 'unitName' | 'periodCode'>,
) {
  return `${mv.metricName}（${mv.unitName}・${mv.periodCode}）`;
}

/**
 * 固定時点の要求事項の状態（v2）。判断の履歴・対象外の申請と承認は追記専用の記録の ID で固定し、
 * 可変の評価行（SSBJ の評価・CSRD の DMA と評価）は値のダイジェストだけを持つ（行そのものは写さない）。
 * 出力の「固定後の変更」（disclosure-export.ts の requirementStateChanges）も、今の状態をこの関数で読んで比べる
 * （同じ読み方・同じダイジェストで、固定と比較が食い違わないように）
 */
export async function loadRequirementState(
  db: DbClient,
  organizationId: Uuid,
  project: DisclosureProject,
  pf: ProjectFramework,
  frameworkKey: DisclosureFramework['key'] | null,
  asOf: IsoDateTime,
): Promise<SnapshotRequirementState> {
  const [exclusionEvents, assessmentEvents, items] = await Promise.all([
    db.select('requirementExclusionEvents', {
      where: {
        organizationId,
        reportingPeriodId: project.reportingPeriodId,
        frameworkVersionId: pf.frameworkVersionId,
      },
    }),
    db.select('projectRequirementAssessmentEvents', {
      where: { organizationId, projectFrameworkId: pf.id },
    }),
    db.select('disclosureItems', { where: { frameworkVersionId: pf.frameworkVersionId } }),
  ]);
  // SSBJ の評価・CSRD の DMA の申請は基準の版と期間で、プロジェクトの判断の申請はプロジェクトの基準で引く
  const ownExclusions = exclusionEvents.filter(
    (e) => e.projectFrameworkId === null || e.projectFrameworkId === pf.id,
  );
  let assessmentDigest: string | null = null;
  const itemIds = items.map((i) => i.id);
  if (frameworkKey === 'ssbj') {
    const rows = await db.select('ssbjAssessments', {
      where: { organizationId, reportingPeriodId: project.reportingPeriodId },
    });
    assessmentDigest = ssbjRequirementDigest(itemIds, rows);
  } else if (frameworkKey === 'csrd') {
    const [matters, settings, assessments] = await Promise.all([
      db.select('csrdDmaMatters', {
        where: { organizationId, reportingPeriodId: project.reportingPeriodId },
      }),
      db.select('csrdAnalysisSettings', {
        where: { organizationId, reportingPeriodId: project.reportingPeriodId },
      }),
      db.select('csrdAssessments', {
        where: { organizationId, reportingPeriodId: project.reportingPeriodId },
      }),
    ]);
    assessmentDigest = csrdRequirementDigest(
      itemIds,
      matters,
      settings[0]?.dmaConfirmedAt ?? null,
      assessments,
    );
  }
  return snapshotRequirementStateOf({
    assessmentEvents,
    exclusionEvents: ownExclusions,
    assessmentDigest,
    asOf,
  });
}

async function assemble(
  db: DbClient,
  ctx: AuthorizationContext,
  project: DisclosureProject,
  kind: ReportSnapshotKind,
  /** 固定時点（作成日時）。この時点までの判断・承認の記録を写しに固定する */
  asOf: IsoDateTime = new Date().toISOString(),
): Promise<Assembly> {
  const organizationId = ctx.workspace.organizationId;

  // --- 基準 -----------------------------------------------------------------
  const projectFrameworks = (
    await db.select('projectFrameworks', { where: { organizationId, projectId: project.id } })
  ).sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
  );
  const versionRows = await selectByIds(
    db,
    'frameworkVersions',
    projectFrameworks.map((pf) => pf.frameworkVersionId),
  );
  const frameworkRows = await selectByIds(
    db,
    'frameworks',
    versionRows.map((v) => v.frameworkId),
  );
  const versionById = new Map(versionRows.map((v) => [v.id, v]));
  const frameworkById = new Map<Uuid, DisclosureFramework>(frameworkRows.map((f) => [f.id, f]));
  // 基準の現在の適用判断（依頼の後に判断が変わったかを、最終承認と同じ規則で見るため）
  const currentDecisions = await selectByIds(
    db,
    'projectFrameworkDecisions',
    projectFrameworks.flatMap((pf) => (pf.currentDecisionId ? [pf.currentDecisionId] : [])),
    { organizationId },
  );
  const decisionById = new Map(currentDecisions.map((d) => [d.id, d]));

  // --- 節 ---------------------------------------------------------------------
  const allBlocks = await db.select('disclosureBlocks', {
    where: { organizationId, projectId: project.id, deletedAt: { isNull: true } },
  });
  const frameworkOrder = new Map(projectFrameworks.map((pf, i) => [pf.frameworkVersionId, i]));
  const includedFrameworkIds = new Set(
    projectFrameworks
      .filter((pf) => pf.applicabilityStatus !== 'not_applicable')
      .map((pf) => pf.frameworkVersionId),
  );
  // 対象外と判断した基準・プロジェクトに登録されていない基準の節は含めない
  const blocks = allBlocks
    .filter((b) => includedFrameworkIds.has(b.frameworkVersionId))
    .sort((a, b) => {
      const fa = frameworkOrder.get(a.frameworkVersionId) ?? 0;
      const fb = frameworkOrder.get(b.frameworkVersionId) ?? 0;
      if (fa !== fb) return fa - fb;
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.id < b.id ? -1 : 1;
    });

  const chosenVersionId = (block: DisclosureBlock): Uuid | null =>
    kind === 'approved' ? block.approvedVersionId : block.currentVersionId;

  const blockVersions = await selectByIds(
    db,
    'disclosureBlockVersions',
    blocks.map(chosenVersionId).filter((id): id is Uuid => id !== null),
    { organizationId },
  );
  const blockVersionById = new Map<Uuid, DisclosureBlockVersion>(
    blockVersions.map((v) => [v.id, v]),
  );

  // --- 本文が参照している版 ------------------------------------------------------
  const metricVersionIds: Uuid[] = [];
  const narrativeVersionIds: Uuid[] = [];
  const anchorIds: Uuid[] = [];
  for (const block of blocks) {
    const versionId = chosenVersionId(block);
    const version = versionId ? blockVersionById.get(versionId) : undefined;
    if (!version) continue;
    for (const paragraph of version.body.paragraphs) {
      for (const inline of paragraph.children) {
        if (inline.t === 'metric' && !metricVersionIds.includes(inline.dataPointVersionId)) {
          metricVersionIds.push(inline.dataPointVersionId);
        } else if (
          inline.t === 'narrative' &&
          !narrativeVersionIds.includes(inline.narrativeVersionId)
        ) {
          narrativeVersionIds.push(inline.narrativeVersionId);
        } else if (inline.t === 'cite' && !anchorIds.includes(inline.sourceAnchorId)) {
          anchorIds.push(inline.sourceAnchorId);
        }
      }
    }
  }

  const blockIds = blocks.map((b) => b.id);
  const [
    dpVersions,
    narrativeVersions,
    anchors,
    comments,
    rechecks,
    requirementItems,
    approvedRequests,
  ] = await Promise.all([
    selectByIds(db, 'dataPointVersions', metricVersionIds, { organizationId }),
    selectByIds(db, 'narrativeVersions', narrativeVersionIds, { organizationId }),
    selectByIds(db, 'sourceAnchors', anchorIds, { organizationId }),
    blockIds.length === 0
      ? Promise.resolve([])
      : db.select('reviewComments', { where: { organizationId, blockId: { in: blockIds } } }),
    blockIds.length === 0
      ? Promise.resolve([])
      : db.select('recheckDecisions', { where: { organizationId, blockId: { in: blockIds } } }),
    selectByIds(
      db,
      'disclosureItems',
      blocks.flatMap((b) => b.requirementItemIds),
    ),
    blockIds.length === 0
      ? Promise.resolve([])
      : db.select('reviewRequests', {
          where: { organizationId, targetId: { in: blockIds }, status: 'approved' },
        }),
  ]);

  const dataPointIds = [...new Set(dpVersions.map((v) => v.dataPointId))];
  const [dataPoints, approvals, narrativeRecords, fileVersions] = await Promise.all([
    selectByIds(db, 'dataPoints', dataPointIds, { organizationId }),
    dataPointIds.length === 0
      ? Promise.resolve([])
      : db.select('approvals', {
          where: {
            organizationId,
            targetType: 'data_point',
            targetId: { in: dataPointIds },
            decision: 'approved',
          },
        }),
    selectByIds(
      db,
      'narrativeRecords',
      narrativeVersions.map((v) => v.narrativeRecordId),
      { organizationId },
    ),
    selectByIds(
      db,
      'fileVersions',
      anchors.map((a) => a.fileVersionId),
      { organizationId },
    ),
  ]);
  const [files, currentDpVersions, organizationFiles] = await Promise.all([
    selectByIds(
      db,
      'files',
      fileVersions.map((v) => v.fileId),
      { organizationId },
    ),
    // 引用した数値の現在の版（再確認の「維持」が、新しい版の承認より前の判断かを見るため）
    selectByIds(
      db,
      'dataPointVersions',
      dataPoints.flatMap((d) => (d.currentVersionId ? [d.currentVersionId] : [])),
      { organizationId },
    ),
    // 対外用の出力で伏せる資料名を固定するため、固定時点の非公開資料の名前を集める
    db.select('files', { where: { organizationId } }),
  ]);
  const nonPublicNames = [
    ...new Set(
      organizationFiles
        .filter((f) => f.confidentiality !== 'public')
        .map((f) => f.originalName.trim())
        // 短すぎる名前で本文の普通の語を伏せない（出力の externalMaskedNames と同じ下限）
        .filter((n) => n.length >= 3),
    ),
  ].sort();
  const [metrics, units, periods, approvalEvents, evidenceLinks] = await Promise.all([
    selectByIds(
      db,
      'metrics',
      dataPoints.map((d) => d.metricId),
      { organizationId },
    ),
    selectByIds(
      db,
      'units',
      dataPoints.map((d) => d.unitId),
      { organizationId },
    ),
    selectByIds(
      db,
      'periods',
      dataPoints.map((d) => d.reportingPeriodId),
      { organizationId },
    ),
    // 節の版の承認の記録（v2: 誰がいつ承認したかを写しに固定する）
    approvedRequests.length === 0
      ? Promise.resolve([])
      : db.select('reviewEvents', {
          where: { organizationId, reviewRequestId: { in: approvedRequests.map((r) => r.id) } },
        }),
    // 引用した数値の根拠資料（v2: 固定時点に紐付いていた資料の版）
    dataPointIds.length === 0
      ? Promise.resolve([])
      : db.select('evidenceLinks', {
          where: { organizationId, targetType: 'data_point', targetId: { in: dataPointIds } },
        }),
  ]);
  const evidenceByDataPoint = new Map<Uuid, Uuid[]>();
  for (const link of evidenceLinks) {
    const list = evidenceByDataPoint.get(link.targetId) ?? [];
    list.push(link.fileVersionId);
    evidenceByDataPoint.set(link.targetId, list);
  }

  const dpById = new Map<Uuid, DataPoint>(dataPoints.map((d) => [d.id, d]));
  const metricById = new Map(metrics.map((m) => [m.id, m]));
  const unitById = new Map(units.map((u) => [u.id, u]));
  const periodById = new Map(periods.map((p) => [p.id, p]));
  const narrativeVersionById = new Map(narrativeVersions.map((v) => [v.id, v]));
  const narrativeRecordById = new Map(narrativeRecords.map((r) => [r.id, r]));
  const anchorById = new Map(anchors.map((a) => [a.id, a]));
  const fileVersionById = new Map(fileVersions.map((v) => [v.id, v]));
  const fileById = new Map(files.map((f) => [f.id, f]));
  const itemById = new Map(requirementItems.map((i) => [i.id, i]));
  const approvedVersionIds = new Set(
    approvals.map((a) => a.targetVersionId).filter((id): id is Uuid => id !== null),
  );

  const currentDpVersionById = new Map(currentDpVersions.map((v) => [v.id, v]));
  /** Data Point の現在の版が承認済みか（disclosure-block.ts の isVersionApproved と同じ規則） */
  const currentVersionApproved = (dp: DataPoint): boolean => {
    if (!dp.currentVersionId) return false;
    if (dp.status === 'approved' || approvedVersionIds.has(dp.currentVersionId)) return true;
    return currentDpVersionById.get(dp.currentVersionId)?.status === 'approved';
  };

  // --- 数値の写し ---------------------------------------------------------------
  const versionApproved = (v: DataPointVersion): boolean => {
    const dp = dpById.get(v.dataPointId);
    return (
      approvedVersionIds.has(v.id) ||
      v.status === 'approved' ||
      (dp?.status === 'approved' && dp.currentVersionId === v.id)
    );
  };

  const metricValues: SnapshotMetricValue[] = dpVersions
    .map((v): SnapshotMetricValue | null => {
      const dp = dpById.get(v.dataPointId);
      if (!dp) return null;
      const metric = metricById.get(dp.metricId);
      const unit = unitById.get(dp.unitId);
      const period = periodById.get(dp.reportingPeriodId);
      const approved = versionApproved(v);
      return snapshotMetricValueOf(
        v,
        dp,
        { metric, unit, period },
        {
          status: approved ? 'approved' : dp.currentVersionId === v.id ? dp.status : v.status,
          versionApproved: approved,
        },
        { evidenceFileVersionIds: evidenceByDataPoint.get(dp.id) ?? [] },
      );
    })
    .filter((mv): mv is SnapshotMetricValue => mv !== null)
    .sort((a, b) =>
      canonicalJson([a.metricCode, a.unitName, a.periodCode, a.versionNo]) <
      canonicalJson([b.metricCode, b.unitName, b.periodCode, b.versionNo])
        ? -1
        : 1,
    );
  const metricValueByVersionId = new Map(metricValues.map((mv) => [mv.dataPointVersionId, mv]));

  // --- 引用位置の写し -------------------------------------------------------------
  const snapshotAnchors: SnapshotAnchor[] = anchorIds
    .map((id): SnapshotAnchor | null => {
      const anchor = anchorById.get(id);
      if (!anchor) return null;
      const fileVersion = fileVersionById.get(anchor.fileVersionId);
      const file = fileVersion ? fileById.get(fileVersion.fileId) : undefined;
      return snapshotAnchorOf(anchor, fileVersion, file);
    })
    .filter((a): a is SnapshotAnchor => a !== null);

  // --- 基準の写し ---------------------------------------------------------------
  const blockCountByFramework = new Map<Uuid, number>();
  for (const block of blocks) {
    blockCountByFramework.set(
      block.frameworkVersionId,
      (blockCountByFramework.get(block.frameworkVersionId) ?? 0) + 1,
    );
  }

  const frameworkSummaries: ReportFrameworkSummary[] = [];
  const frameworks: SnapshotFramework[] = [];
  const blockers: ReportBlocker[] = [];
  for (const pf of projectFrameworks) {
    const version = versionById.get(pf.frameworkVersionId) ?? null;
    const framework = version ? (frameworkById.get(version.frameworkId) ?? null) : null;
    const draftStandardPrep = isDraftStandard(version, pf.purpose);
    const label = version?.label ?? '（基準の版が見つかりません）';
    const included = pf.applicabilityStatus !== 'not_applicable';
    frameworkSummaries.push({
      frameworkVersionId: pf.frameworkVersionId,
      label,
      purpose: pf.purpose,
      applicabilityStatus: pf.applicabilityStatus,
      decided: pf.currentDecisionId !== null,
      draftStandardPrep,
      included,
      blockCount: blockCountByFramework.get(pf.frameworkVersionId) ?? 0,
    });
    if (!included) continue;

    frameworks.push(
      snapshotFrameworkOf(pf, version, framework, project, {
        requirementState: await loadRequirementState(
          db,
          organizationId,
          project,
          pf,
          framework?.key ?? null,
          asOf,
        ),
      }),
    );

    // 法定・任意適用の基準は、適用判断が確定していなければ確定させない。
    // 草案の基準による準備は、その区分のまま社内で確定できる（§10.4）。未判定だけは止める
    if (!draftStandardPrep && !isApplicabilityConfirmed(pf)) {
      blockers.push({
        code: 'framework_applicability_unconfirmed',
        message: `${label}: 適用判断が確定していません（${APPLICABILITY_STATUS_LABELS[pf.applicabilityStatus]}）。`,
      });
    } else if (draftStandardPrep && pf.applicabilityStatus === 'not_assessed') {
      blockers.push({
        code: 'framework_applicability_unconfirmed',
        message: `${label}: 適用判断が未判定です。`,
      });
    }
    if ((blockCountByFramework.get(pf.frameworkVersionId) ?? 0) === 0) {
      blockers.push({ code: 'no_blocks', message: `${label}: 原稿の節がありません。` });
    }
  }
  if (frameworks.length === 0) {
    blockers.push({ code: 'no_blocks', message: '出力の対象となる基準がありません。' });
  }
  const frameworkEntryById = new Map(frameworks.map((f) => [f.frameworkVersionId, f]));

  // --- 節の写しと、節ごとの注意・阻害条件 ---------------------------------------------
  const snapshotBlocks: SnapshotBlock[] = [];
  const versionWriters: Uuid[][] = [];
  for (const block of blocks) {
    const versionId = chosenVersionId(block);
    const version = versionId ? (blockVersionById.get(versionId) ?? null) : null;
    if (version) versionWriters.push([version.createdBy, ...(version.contributorUserIds ?? [])]);
    const body: BlockBody = version?.body ?? { paragraphs: [] };
    const issues: SnapshotIssue[] = [];

    // 状態（承認済みの版を固定したか）
    const isApprovedVersion =
      version !== null && block.approvedVersionId === version.id && block.status === 'approved';
    if (versionId !== null && version === null) {
      // 版を指しているのに読めない。「未承認（承認済み）」のような矛盾した理由を出さない
      issues.push({
        code: 'version_missing',
        message:
          kind === 'approved'
            ? '承認済みの版を読み込めません（デモ環境では、別のサーバーで作成された版を参照できない場合があります）。画面を開き直してから確定してください。'
            : '保存済みの版を読み込めません（デモ環境では、別のサーバーで作成された版を参照できない場合があります）。',
      });
    } else if (!isApprovedVersion) {
      issues.push({
        code: 'not_approved',
        message:
          block.approvedVersionId && block.approvedVersionId !== block.currentVersionId
            ? `未承認（${BLOCK_STATUS_LABELS[block.status]}。承認済みの版の後に修正中）`
            : `未承認（${BLOCK_STATUS_LABELS[block.status]}）`,
      });
    }
    // 報告範囲の変更より前の依頼で承認された版（指示書 §10.3: 範囲の変更は再確認が必要）
    if (isApprovedVersion && version) {
      const approvedIn = approvedRequests.filter(
        (r) => r.targetId === block.id && r.targetVersionId === version.id,
      );
      const revision = Math.max(...approvedIn.map((r) => r.projectScopeRevision ?? 0), -1);
      if ((project.scopeRevision ?? 0) > 0 && revision < (project.scopeRevision ?? 0)) {
        issues.push({ code: 'scope_changed', message: SCOPE_RECHECK_MESSAGE });
      }
      // 承認した依頼が固定した適用判断の後に、節の基準の判断を確定し直した（§10.1・§10.3）
      const pf = projectFrameworks.find((p) => p.frameworkVersionId === block.frameworkVersionId);
      if (
        pf &&
        approvedIn.length > 0 &&
        approvedIn.every((r) =>
          applicabilityDecisionChangedSince(
            r,
            pf.currentDecisionId,
            pf.currentDecisionId ? (decisionById.get(pf.currentDecisionId) ?? null) : null,
          ),
        )
      ) {
        issues.push({ code: 'applicability_changed', message: APPLICABILITY_RECHECK_MESSAGE });
      }
    }
    // 確定で承認済みの版が無い節は「未承認」だけを示す（本文の有無は承認済みの版の話ではない）
    const evaluateBody = version !== null || kind === 'review_draft';

    // 引用した数値・定性情報の再確認。原稿編集・レビュー依頼（disclosure-recheck.ts）と
    // 同じ規則（domain/disclosure-block.ts の isOldRefKept）で判定する: 節単位で、
    // その組み合わせの最後の判断が「引用中の版を維持」なら再確認済み
    // 新しい版が未承認のときの「維持」は、その版が承認されたら無効（原稿画面と同じ）
    const keptOld = (
      refKind: 'metric' | 'narrative',
      oldRefId: Uuid,
      newRefId: Uuid | null,
      newApproved: boolean,
    ) =>
      version !== null &&
      newRefId !== null &&
      isOldRefKept(rechecks, { blockId: block.id, refKind, oldRefId, newRefId, newApproved });

    const metricRefs = body.paragraphs.flatMap((p) =>
      p.children.flatMap((inline) => {
        if (inline.t !== 'metric') return [];
        const dp = dpById.get(inline.dataPointId);
        const current = dp?.currentVersionId ?? null;
        const mv = metricValueByVersionId.get(inline.dataPointVersionId);
        return [
          {
            dataPointId: inline.dataPointId,
            dataPointVersionId: inline.dataPointVersionId,
            currentVersionId: keptOld(
              'metric',
              inline.dataPointVersionId,
              current,
              dp ? currentVersionApproved(dp) : false,
            )
              ? inline.dataPointVersionId
              : current,
            label: mv ? formatMetricLabel(mv) : undefined,
          },
        ];
      }),
    );

    const blockComments = comments.filter((c) => c.blockId === block.id);
    const frameworkEntry = frameworkEntryById.get(block.frameworkVersionId);
    const bodyBlockers = evaluateBody
      ? evaluateBlockBlockers({
          body: version ? body : null,
          // 未採用の AI 候補は作業本文側の話で、固定する版（人が保存した版）には含まれない
          pendingAiCandidateCount: 0,
          comments: blockComments,
          metricRefs,
          frameworks: frameworkEntry
            ? [
                {
                  frameworkVersionId: frameworkEntry.frameworkVersionId,
                  label: frameworkEntry.label,
                  applicabilityStatus: frameworkEntry.applicabilityStatus,
                },
              ]
            : [],
        })
      : [];
    for (const blocker of bodyBlockers) {
      issues.push({ code: blocker.code, message: blocker.message });
    }

    for (const ref of metricRefs) {
      const mv = metricValueByVersionId.get(ref.dataPointVersionId);
      if (!mv) {
        issues.push({ code: 'metric_missing', message: '引用した数値の版が見つかりません。' });
        continue;
      }
      if (!mv.versionApproved) {
        issues.push({
          code: 'metric_not_approved',
          message: `引用した数値が承認済みではありません（${formatMetricLabel(mv)} 版 ${mv.versionNo}）。`,
        });
      }
      if (mv.valueKind === 'estimate' || mv.valueKind === 'target') {
        issues.push({
          code: 'metric_not_actual',
          message: `${VALUE_KIND_LABELS[mv.valueKind]}の数値を引用しています（${formatMetricLabel(mv)} 版 ${mv.versionNo}）。本文・出力では「${VALUE_KIND_LABELS[mv.valueKind]}」と添えて表示します。`,
        });
      }
      if (mv.availabilityStatus !== 'value_present') {
        issues.push({
          code: 'metric_value_absent',
          message: `引用した数値に値がありません（${formatMetricLabel(mv)}: ${AVAILABILITY_STATUS_LABELS[mv.availabilityStatus]}）。`,
        });
      }
    }

    for (const paragraph of body.paragraphs) {
      for (const inline of paragraph.children) {
        if (inline.t === 'narrative') {
          const nv = narrativeVersionById.get(inline.narrativeVersionId);
          const record = nv ? narrativeRecordById.get(nv.narrativeRecordId) : undefined;
          if (!nv || !record) continue;
          if (
            record.currentVersionId !== null &&
            record.currentVersionId !== nv.id &&
            !keptOld(
              'narrative',
              nv.id,
              record.currentVersionId,
              record.confirmedVersionId === record.currentVersionId,
            )
          ) {
            issues.push({
              code: 'stale_narrative_refs',
              message: `引用した定性情報に新しい版があります（${record.title}）。再確認してください。`,
            });
          }
          const gaps = narrativeGaps(record.theme, nv.fields);
          if (gaps.missing.length > 0) {
            issues.push({
              code: 'narrative_missing_fields',
              message: `不足情報: ${record.title} — ${gaps.missing.join('、')}`,
            });
          }
          if (gaps.note) {
            issues.push({
              code: 'narrative_not_quantified',
              message: `${record.title} — ${gaps.note}`,
            });
          }
        } else if (inline.t === 'cite') {
          const anchor = snapshotAnchors.find((a) => a.sourceAnchorId === inline.sourceAnchorId);
          const file = anchor?.fileId ? fileById.get(anchor.fileId) : undefined;
          if (!anchor || !file || file.deletedAt) {
            issues.push({
              code: 'anchor_missing',
              message: '出典の資料が見つかりません（削除された資料を引用しています）。',
            });
          }
        }
      }
    }

    const requirements: SnapshotRequirement[] = snapshotRequirementsOf(
      block.requirementItemIds,
      itemById,
    );

    snapshotBlocks.push(
      snapshotBlockOf(
        block,
        version,
        {
          status: block.status,
          approvedVersionId: block.approvedVersionId,
          isApprovedVersion,
          requirements,
          issues: dedupeIssues(issues),
          internalComments: unresolvedCommentsInOrder(blockComments).map(snapshotCommentOf),
          maskedFileNames: namesMentionedIn(body, nonPublicNames),
        },
        {
          // 固定した版が承認済みの版なら、その承認の記録（誰がいつ承認したか）を固定する。確定版は
          // 固定時点の報告範囲で承認された依頼に限る（DB の verify_report_snapshot と同じ条件）
          approval:
            isApprovedVersion && version
              ? snapshotApprovalOf(
                  block.id,
                  version.id,
                  approvedRequests,
                  approvalEvents,
                  kind === 'approved' ? (project.scopeRevision ?? 0) : 0,
                )
              : null,
        },
      ),
    );
  }

  // 必須言語（プロジェクトの言語）と翻訳の鮮度（指示書 §10.4「必須言語の未確認」）。
  // 翻訳元の節ごとに、プロジェクトの各言語の節が要る。翻訳版は、翻訳元の承認済みの版より前に
  // 承認された版のままなら、翻訳元の修正を反映していないおそれがあるため確定させない
  const projectLanguages: DisclosureLanguage[] = project.languages?.length
    ? project.languages
    : ['ja'];
  const snapshotById = new Map(snapshotBlocks.map((b) => [b.blockId, b]));
  for (const source of blocks.filter((b) => b.translationOfBlockId === null)) {
    for (const language of projectLanguages) {
      if (language === source.language) continue;
      const translations = blocks.filter(
        (b) => b.translationOfBlockId === source.id && b.language === language,
      );
      if (translations.length === 0) {
        blockers.push({
          code: 'translation_missing',
          message: `${source.title}: 必須言語（${DISCLOSURE_LANGUAGE_LABELS[language]}）の節がありません。`,
          blockId: source.id,
        });
      }
    }
  }
  for (const translation of blocks.filter((b) => b.translationOfBlockId !== null)) {
    const source = blocks.find((b) => b.id === translation.translationOfBlockId);
    const entry = snapshotById.get(translation.id);
    const sourceEntry = source ? snapshotById.get(source.id) : undefined;
    if (!entry?.versionCreatedAt || !sourceEntry?.versionCreatedAt) continue;
    if (entry.versionCreatedAt < sourceEntry.versionCreatedAt) {
      entry.issues.push({
        code: 'translation_stale',
        message: `翻訳元「${sourceEntry.title}」の版 ${sourceEntry.versionNo ?? '—'} より前の版を訳したままです。翻訳を見直し、版として保存して再承認してください（直す必要が無ければ本文を変えずに版を作れます）。`,
      });
    }
  }

  // 確定を止める条件: 版の欠落・未承認・阻害条件・引用の不整合・証跡の欠落。
  // 定性情報の未記入項目は注意として出すだけ（人が承認した本文の判断を上書きしない）
  const INFO_ONLY: ReadonlySet<SnapshotIssueCode> = new Set([
    'narrative_missing_fields',
    'narrative_not_quantified',
    'metric_not_actual',
  ]);
  for (const block of snapshotBlocks) {
    for (const issue of block.issues) {
      if (INFO_ONLY.has(issue.code)) continue;
      blockers.push({
        code: issue.code,
        message: `${block.title}: ${issue.message}`,
        blockId: block.blockId,
      });
    }
  }

  const decisionIds = frameworks.map((f) => f.decisionId).filter((id): id is Uuid => id !== null);
  const policyVersions = [
    ...new Set(
      approvedRequests
        .filter((r) => snapshotBlocks.some((b) => b.blockId === r.targetId))
        .map((r) => r.policyVersion),
    ),
  ].sort();

  return {
    project,
    frameworks,
    frameworkSummaries,
    decisionIds,
    blocks: snapshotBlocks,
    metricValues,
    narrativeVersionIds,
    anchors: snapshotAnchors,
    policyVersion: policyVersions.length > 0 ? policyVersions.join(',') : null,
    blockers,
    draftStandardPrep: frameworks.some((f) => f.draftStandardPrep),
    versionWriters,
    asOf,
  };
}

function dedupeIssues(issues: SnapshotIssue[]): SnapshotIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ======================================================================
// 確定の可否（画面の表示とサーバーの再検証で同じ関数を使う）
// ======================================================================

export interface ReportReadiness {
  project: DisclosureProject;
  frameworks: ReportFrameworkSummary[];
  /** 内容の阻害条件（未承認・再確認・適用判断など） */
  blockers: ReportBlocker[];
  /** 操作者に起因する阻害条件（権限・職務分離・指定承認者） */
  actorBlockers: string[];
  /** 草案基準による準備を含む（確定しても法定準拠の確定にはならない） */
  draftStandardPrep: boolean;
  canConfirm: boolean;
  blockCount: number;
}

function actorBlockersFor(
  ctx: AuthorizationContext,
  project: DisclosureProject,
  versionWriters: ReadonlyArray<readonly Uuid[]>,
): string[] {
  const reasons: string[] = [];
  if (!can(ctx, 'enterprise.disclosure.approve')) {
    reasons.push('レポートの確定には最終承認の権限（開示の承認）が必要です。');
  }
  if (project.finalApproverUserId !== null && project.finalApproverUserId !== ctx.userId) {
    reasons.push('このプロジェクトの最終承認者として指定された人だけが確定できます。');
  }
  // 自分が書いた節だけのレポートを自分で確定させない（職務分離）。
  // 版の作成者だけでなく、自動保存で本文を書いた人も「書いた人」に数える（DB のトリガと同じ規則）
  if (
    versionWriters.length > 0 &&
    versionWriters.every((writers) => writers.includes(ctx.userId))
  ) {
    reasons.push('すべての節の本文を書いた本人は、レポートを確定できません（職務分離）。');
  }
  return reasons;
}

/** 社内承認済み版を確定できるか。確定の操作でも同じ判定をサーバーで必ずやり直す */
export async function evaluateReportReadiness(
  db: DbClient,
  ctx: AuthorizationContext,
  projectId: Uuid,
): Promise<ReportReadiness> {
  const project = await loadOwnedProject(db, ctx, projectId);
  assertCan(ctx, 'enterprise.disclosure.read');
  const assembly = await assemble(db, ctx, project, 'approved');
  const actorBlockers = actorBlockersFor(ctx, project, assembly.versionWriters);
  return {
    project,
    frameworks: assembly.frameworkSummaries,
    blockers: assembly.blockers,
    actorBlockers,
    draftStandardPrep: assembly.draftStandardPrep,
    canConfirm: assembly.blockers.length === 0 && actorBlockers.length === 0,
    blockCount: assembly.blocks.length,
  };
}

// ======================================================================
// 作成
// ======================================================================

function labelFor(kind: ReportSnapshotKind, assembly: Assembly): string {
  if (kind === 'approved') {
    return assembly.draftStandardPrep
      ? `${SNAPSHOT_KIND_DISPLAY.approved}（草案基準による準備を含む）`
      : SNAPSHOT_KIND_DISPLAY.approved;
  }
  const hasIssues = assembly.blocks.some((b) => b.issues.length > 0);
  return hasIssues
    ? `${SNAPSHOT_KIND_DISPLAY.review_draft}（未承認箇所・不足情報あり）`
    : SNAPSHOT_KIND_DISPLAY.review_draft;
}

async function insertSnapshot(
  db: DbClient,
  ctx: AuthorizationContext,
  kind: ReportSnapshotKind,
  assembly: Assembly,
): Promise<ReportSnapshotDetail> {
  const existing = await db.select('reportSnapshots', {
    where: {
      organizationId: ctx.workspace.organizationId,
      projectId: assembly.project.id,
      snapshotKind: kind,
    },
  });
  // 番号は (project, kind) ごとの通し番号。同時作成は DB の一意制約（report_snapshots_unique）が止める
  const snapshotNo = existing.reduce((max, s) => Math.max(max, s.snapshotNo), 0) + 1;

  const content = {
    projectId: assembly.project.id,
    snapshotKind: kind,
    label: labelFor(kind, assembly),
    frameworkVersions: assembly.frameworks,
    decisionIds: assembly.decisionIds,
    blocks: assembly.blocks,
    metricValues: assembly.metricValues,
    narrativeVersionIds: assembly.narrativeVersionIds,
    anchors: assembly.anchors,
    policyVersion: assembly.policyVersion,
  };
  const snapshot: ReportSnapshotDetail = {
    id: randomUUID(),
    organizationId: ctx.workspace.organizationId,
    snapshotNo,
    ...content,
    contentHash: computeSnapshotContentHash(content),
    // 写しに固定した判断・承認の記録は、この日時までのもの（組み立て直しも同じ日時で切る）
    createdAt: assembly.asOf,
    // RLS は created_by = auth.uid() を求める（クライアントから受け取った値は使わない）
    createdBy: ctx.userId,
  };
  const [inserted] = await db.insert('reportSnapshots', [snapshot]);

  const issueCount = assembly.blocks.reduce((sum, b) => sum + b.issues.length, 0);
  await recordAuditEvent(db, ctx, {
    eventType: 'report_snapshot_created',
    resourceType: 'report_snapshot',
    resourceId: snapshot.id,
    afterSummary: `${assembly.project.name} ${snapshot.label} No.${snapshotNo}（節 ${assembly.blocks.length} 件・数値 ${assembly.metricValues.length} 件${kind === 'review_draft' ? `・注意 ${issueCount} 件` : ''}）`,
    metadata: {
      projectId: assembly.project.id,
      snapshotKind: kind,
      snapshotNo,
      contentHash: snapshot.contentHash,
    },
  });

  return asSnapshotDetail(inserted ?? snapshot);
}

/**
 * レビュー用草稿のスナップショットを作る（阻害条件があっても作れる）。
 * 保存済みの版だけを固定し、未承認の節・不足情報は issues として残す。
 */
export async function createReviewDraftSnapshot(
  db: DbClient,
  ctx: AuthorizationContext,
  projectId: Uuid,
): Promise<ReportSnapshotDetail> {
  const project = await loadOwnedProject(db, ctx, projectId);
  // RLS（report_snapshots_insert）と同じ条件: 下書き編集者か出力担当
  if (!can(ctx, 'enterprise.disclosure.write') && !can(ctx, 'enterprise.export.run')) {
    throw new AuthorizationError(
      'レビュー用草稿の作成には、開示の編集または出力の権限が必要です。',
    );
  }
  const assembly = await assemble(db, ctx, project, 'review_draft');
  if (assembly.blocks.length === 0) {
    throw new ValidationError('原稿の節が無いため、草稿を作成できません。');
  }
  return insertSnapshot(db, ctx, 'review_draft', assembly);
}

/**
 * レポートを確定し、社内承認済み版のスナップショットを作る（§5「レポート確定」）。
 * 画面のボタンを無効にするだけでなく、ここで阻害条件・権限・職務分離を必ず再検証する。
 * 確定は社内の承認であり、第三者保証でも開示先への提出でもない。
 */
export async function confirmReport(
  db: DbClient,
  ctx: AuthorizationContext,
  projectId: Uuid,
): Promise<ReportSnapshotDetail> {
  const project = await loadOwnedProject(db, ctx, projectId);
  assertCan(ctx, 'enterprise.disclosure.approve');

  const assembly = await assemble(db, ctx, project, 'approved');
  const actorBlockers = actorBlockersFor(ctx, project, assembly.versionWriters);
  if (actorBlockers.length > 0) {
    throw new AuthorizationError(actorBlockers.join(' '));
  }
  if (assembly.blockers.length > 0) {
    const shown = assembly.blockers.slice(0, 3).map((b) => b.message);
    const rest = assembly.blockers.length - shown.length;
    throw new ValidationError(
      `レポートを確定できません: ${shown.join(' ／ ')}${rest > 0 ? ` ほか ${rest} 件` : ''}`,
    );
  }
  return insertSnapshot(db, ctx, 'approved', assembly);
}

// ======================================================================
// 一覧・上流の変更（§10.3: 過去のスナップショットは変えず、注意情報として示す）
// ======================================================================

export interface UpstreamChange {
  kind: 'metric' | 'narrative' | 'block' | 'decision' | 'scope';
  label: string;
  detail: string;
}

/**
 * スナップショット作成後に上流が変わったか。スナップショット自体は変えない
 * （旧出力を最新版と誤認させないための注意情報）。
 */
export async function detectUpstreamChanges(
  db: DbClient,
  ctx: AuthorizationContext,
  snapshot: ReportSnapshotDetail,
): Promise<UpstreamChange[]> {
  const organizationId = ctx.workspace.organizationId;
  const [dataPoints, narrativeVersions, blocks, projectFrameworks, project] = await Promise.all([
    selectByIds(
      db,
      'dataPoints',
      snapshot.metricValues.map((m) => m.dataPointId),
      { organizationId },
    ),
    selectByIds(db, 'narrativeVersions', snapshot.narrativeVersionIds, { organizationId }),
    selectByIds(
      db,
      'disclosureBlocks',
      snapshot.blocks.map((b) => b.blockId),
      { organizationId },
    ),
    db.select('projectFrameworks', { where: { organizationId, projectId: snapshot.projectId } }),
    db.findById('disclosureProjects', snapshot.projectId),
  ]);
  const narrativeRecords = await selectByIds(
    db,
    'narrativeRecords',
    narrativeVersions.map((v) => v.narrativeRecordId),
    { organizationId },
  );
  const currentDpVersionIds = dataPoints
    .map((d) => d.currentVersionId)
    .filter((id): id is Uuid => id !== null);
  const currentDpVersions = await selectByIds(db, 'dataPointVersions', currentDpVersionIds, {
    organizationId,
  });
  const dpById = new Map(dataPoints.map((d) => [d.id, d]));
  const dpVersionById = new Map(currentDpVersions.map((v) => [v.id, v]));

  const changes: UpstreamChange[] = [];
  // 報告範囲（報告主体・期間・対象範囲）: 固定した改訂番号より後に範囲を変えた。
  // 改訂番号を持たない古いスナップショットは、表紙に固定した報告主体・期間と比べる
  if (project && project.organizationId === organizationId) {
    const fixed = snapshot.frameworkVersions[0];
    const revisionChanged = snapshot.frameworkVersions.some(
      (f) => f.scopeRevision !== null && f.scopeRevision < (project.scopeRevision ?? 0),
    );
    const fieldsChanged =
      fixed !== undefined &&
      fixed.scopeRevision === null &&
      (fixed.reportingEntity !== project.reportingEntity ||
        fixed.periodStart !== project.periodStart ||
        fixed.periodEnd !== project.periodEnd);
    if (revisionChanged || fieldsChanged) {
      changes.push({
        kind: 'scope',
        label: '報告範囲',
        detail: '固定した後に報告範囲（報告主体・期間・対象範囲）が変更されています',
      });
    }
  }
  for (const mv of snapshot.metricValues) {
    const dp = dpById.get(mv.dataPointId);
    if (!dp || dp.currentVersionId === null || dp.currentVersionId === mv.dataPointVersionId) {
      continue;
    }
    const current = dpVersionById.get(dp.currentVersionId);
    changes.push({
      kind: 'metric',
      label: formatMetricLabel(mv),
      detail: `固定した版 ${mv.versionNo} → 現在の版 ${current?.versionNo ?? '—'}${current?.changeReason ? `（変更理由: ${current.changeReason}）` : ''}`,
    });
  }
  for (const nv of narrativeVersions) {
    const record = narrativeRecords.find((r) => r.id === nv.narrativeRecordId);
    if (!record || record.currentVersionId === null || record.currentVersionId === nv.id) continue;
    changes.push({
      kind: 'narrative',
      label: record.title,
      detail: `固定した版 ${nv.versionNo} の後に新しい版があります`,
    });
  }
  for (const sb of snapshot.blocks) {
    const block = blocks.find((b) => b.id === sb.blockId);
    if (!block) continue;
    const reference =
      snapshot.snapshotKind === 'approved' ? block.approvedVersionId : block.currentVersionId;
    if (block.deletedAt) {
      changes.push({ kind: 'block', label: sb.title, detail: '節が削除されています' });
    } else if (reference !== sb.versionId) {
      changes.push({
        kind: 'block',
        label: sb.title,
        detail:
          snapshot.snapshotKind === 'approved'
            ? '承認済みの版が変わっています'
            : `固定した版 ${sb.versionNo ?? '—'} の後に保存された版があります`,
      });
    }
  }
  for (const f of snapshot.frameworkVersions) {
    const pf = projectFrameworks.find((p) => p.frameworkVersionId === f.frameworkVersionId);
    if (pf && pf.currentDecisionId !== f.decisionId) {
      changes.push({
        kind: 'decision',
        label: f.label,
        detail: `適用判断が更新されています（現在: ${APPLICABILITY_STATUS_LABELS[pf.applicabilityStatus]}）`,
      });
    }
  }
  return changes;
}

export interface SnapshotListEntry {
  snapshot: ReportSnapshotDetail;
  createdByName: string;
  upstreamChanges: UpstreamChange[];
  integrityOk: boolean;
}

/** プロジェクトのスナップショット一覧（新しい順） */
export async function listProjectSnapshots(
  db: DbClient,
  ctx: AuthorizationContext,
  projectId: Uuid,
): Promise<SnapshotListEntry[]> {
  const project = await loadOwnedProject(db, ctx, projectId);
  assertCan(ctx, 'enterprise.disclosure.read');
  const rows = await db.select('reportSnapshots', {
    where: { organizationId: ctx.workspace.organizationId, projectId: project.id },
    orderBy: [
      { column: 'createdAt', dir: 'desc' },
      { column: 'id', dir: 'desc' },
    ],
  });
  const profiles = await selectByIds(
    db,
    'profiles',
    rows.map((r) => r.createdBy),
  );
  return Promise.all(
    rows.map(async (row) => {
      const snapshot = asSnapshotDetail(row);
      return {
        snapshot,
        createdByName: profiles.find((p) => p.id === row.createdBy)?.displayName ?? '—',
        upstreamChanges: await detectUpstreamChanges(db, ctx, snapshot),
        integrityOk: verifySnapshotIntegrity(row),
      };
    }),
  );
}

export interface OrganizationSnapshotOption {
  id: Uuid;
  projectId: Uuid;
  projectName: string;
  snapshotKind: ReportSnapshotKind;
  snapshotNo: number;
  label: string;
  createdAt: IsoDateTime;
}

/**
 * 組織のスナップショットの選択肢（ESG 経営の照合モード用）。プロジェクト名・スナップショットの
 * 一覧は開示の情報なので、プロジェクトの出力タブ（listProjectSnapshots）と同じく開示の閲覧権限を求める
 */
export async function listOrganizationSnapshots(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<OrganizationSnapshotOption[]> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.disclosure.read');
  const organizationId = ctx.workspace.organizationId;
  const [rows, projects] = await Promise.all([
    db.select('reportSnapshots', {
      where: { organizationId },
      orderBy: [
        { column: 'createdAt', dir: 'desc' },
        { column: 'id', dir: 'desc' },
      ],
    }),
    db.select('disclosureProjects', { where: { organizationId } }),
  ]);
  return rows.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    projectName: projects.find((p) => p.id === row.projectId)?.name ?? '（プロジェクト不明）',
    snapshotKind: row.snapshotKind,
    snapshotNo: row.snapshotNo,
    label: row.label,
    createdAt: row.createdAt,
  }));
}

/**
 * スナップショットに固定した「対外用で伏せる資料名」。固定する前に作ったスナップショットでは null
 * （出力時の資料一覧から集めるしかない）
 */
export function frozenMaskedFileNames(snapshot: ReportSnapshotDetail): string[] | null {
  if (snapshot.blocks.length === 0) return [];
  if (snapshot.blocks.some((b) => b.maskedFileNames === null)) return null;
  return [...new Set(snapshot.blocks.flatMap((b) => b.maskedFileNames ?? []))];
}

/** 表示用: 基準の収録状況の注記（要求事項が未収録の草案など） */
export function frameworkCoverageNote(framework: SnapshotFramework): string | null {
  if (framework.coverageStatus === 'not_loaded' || framework.coverageStatus === 'sample') {
    return FRAMEWORK_COVERAGE_STATUS_LABELS[framework.coverageStatus];
  }
  return null;
}

/** 草稿で固定した節に本文があるか（出力で「本文なし」を明示するため） */
export function snapshotBlockHasBody(block: SnapshotBlock): boolean {
  return hasBodyContent(block.body);
}
