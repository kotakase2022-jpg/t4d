import 'server-only';

import { assertCan } from '@/lib/authorization/can';
import { BLOCK_STATUS_LABELS } from '@/lib/domain/disclosure-status';
import {
  OWNER_DUE_SOURCE_LABELS,
  REQUIREMENT_GAP_LABELS,
  type OwnerDueSource,
  type RequirementCoverageCategory,
} from '@/lib/domain/requirement-coverage';
import { statusLabel } from '@/lib/ui/status/registry';
import {
  buildRequirementRows,
  getProject,
  nameOf,
  type ProjectFrameworkView,
  type RequirementRow,
} from '@/lib/services/disclosure-project';
import { REQUIREMENT_DECISION_SOURCE_LABELS } from '@/lib/services/requirement-decisions';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  CrosswalkRelation,
  DisclosureBlockVersion,
  DisclosureProject,
  IsoDate,
  IsoDateTime,
  Uuid,
} from '@/types/domain';

/**
 * 要求事項・情報対応表（全基準・全件）の中核（トライアル対応 NF-04。スライド 11 の成果物 #01）。
 *
 * 要求事項 1 件＝1 行。対象外・未判定・未対応の行も消さない（分母を減らさない）。
 * 区分・不足・担当期限は要求事項タブと同じ関数（buildRequirementRows → classifyRequirement）で導き、
 * 画面・XLSX・CSV で件数を食い違わせない。書き込みはしない（Demo の Cookie も増やさない）。
 * AI の判定は「候補」として別の列に置く（人の判断・評価と混ぜない）。
 *
 * 権限: enterprise.disclosure.read（プロジェクトの読込で確かめる）。出力（T1 の API）は別に
 * enterprise.export.run を ID より先に確かめる。
 */

/** 本文の抜粋の長さ */
export const MATRIX_EXCERPT_CHARS = 200;

/** 要求事項が未収録の基準の理由（0 として数えない） */
export const MATRIX_NOT_LOADED_REASON = '要求事項未収録のため算定しない';

export interface RequirementMatrixBlockCell {
  blockId: Uuid;
  title: string;
  statusLabel: string;
  versionNo: number | null;
  /** 承認済みの版の番号・承認者・日時（承認済みの版が無ければ null） */
  approvedVersionNo: number | null;
  approvedByName: string | null;
  approvedAt: IsoDateTime | null;
  /** 現在の版の本文の先頭（200 字） */
  excerpt: string;
  translation: boolean;
}

export interface RequirementMatrixMetricCell {
  metricName: string;
  unitName: string;
  periodCode: string;
  boundary: string;
  value: string;
  unitOfMeasure: string;
  versionNo: number;
  approved: boolean;
}

export interface RequirementMatrixEvidenceCell {
  fileName: string;
  fileVersionNo: number | null;
  locator: string;
}

export interface RequirementMatrixCrosswalkCell {
  relation: CrosswalkRelation;
  relationLabel: string;
  counterpartCode: string | null;
  counterpartFramework: string;
  /** サンプル（架空）の対応か */
  sample: boolean;
}

export interface RequirementMatrixRow {
  frameworkVersionId: Uuid;
  frameworkLabel: string;
  /** 基準の位置付け（公表済み・公開草案に基づく準備・サンプル（架空）など） */
  frameworkPositioning: string;
  isSample: boolean;
  itemId: Uuid;
  code: string;
  section: string;
  title: string;
  decisionLabel: string;
  decisionSourceLabel: string;
  /** 対象外・非重要の理由（それ以外は null） */
  exclusionReason: string | null;
  decidedByName: string | null;
  approvedByName: string | null;
  approvedAt: IsoDateTime | null;
  category: RequirementCoverageCategory;
  categoryLabel: string;
  gapLabels: string[];
  reasons: string[];
  blocks: RequirementMatrixBlockCell[];
  metrics: RequirementMatrixMetricCell[];
  evidence: RequirementMatrixEvidenceCell[];
  narratives: Array<{ title: string; versionNo: number }>;
  ownerName: string | null;
  dueDate: IsoDate | null;
  ownerDueSource: OwnerDueSource;
  ownerDueSourceLabel: string;
  actionPlans: string[];
  crosswalk: RequirementMatrixCrosswalkCell[];
  /** 人の評価（AI の候補は含めない） */
  humanEvaluationLabel: string | null;
  /** AI の判定（候補）。人が確認していなければここだけに出す */
  aiCandidateLabel: string | null;
}

export interface RequirementMatrixFramework {
  frameworkVersionId: Uuid;
  label: string;
  positioning: string;
  isSample: boolean;
  mode: 'rows' | 'not_loaded';
  /** 未収録のときの理由（0 件として数えない） */
  notCalculatedReason: string | null;
  total: number;
  counts: Record<RequirementCoverageCategory, number>;
}

export interface RequirementMatrix {
  project: DisclosureProject;
  frameworks: RequirementMatrixFramework[];
  rows: RequirementMatrixRow[];
}

function excerptOf(version: DisclosureBlockVersion | undefined): string {
  if (!version) return '';
  const text = version.plainText.replace(/\s+/g, ' ').trim();
  return text.length > MATRIX_EXCERPT_CHARS ? `${text.slice(0, MATRIX_EXCERPT_CHARS - 1)}…` : text;
}

function displayValue(value: number | null, textValue: string | null): string {
  if (value !== null) return String(value);
  return textValue ?? '';
}

/**
 * 対応表を組み立てる。frameworkVersionIds を渡すとその基準だけ（プロジェクトの基準に無い版は無視）
 */
export async function loadRequirementMatrix(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { projectId: Uuid; frameworkVersionIds?: readonly Uuid[] },
): Promise<RequirementMatrix> {
  const detail = await getProject(db, ctx, input.projectId);
  assertCan(ctx, 'enterprise.disclosure.read');
  const organizationId = detail.project.organizationId;
  const views: ProjectFrameworkView[] = input.frameworkVersionIds
    ? detail.frameworks.filter((f) => input.frameworkVersionIds!.includes(f.version.id))
    : detail.frameworks;

  const results: Array<{
    view: ProjectFrameworkView;
    rows: RequirementRow[];
    mode: 'rows' | 'not_loaded';
  }> = [];
  for (const view of views) {
    const result = await buildRequirementRows(db, ctx, detail, view);
    results.push({ view, rows: result.rows, mode: result.mode });
  }

  // 節の版・承認の記録（抜粋・承認者・日時）
  const blocks = detail.blocks;
  const versionIds = [
    ...new Set(
      blocks.flatMap((b) =>
        [b.currentVersionId, b.approvedVersionId].filter((id): id is Uuid => id !== null),
      ),
    ),
  ];
  const blockIds = blocks.map((b) => b.id);
  const [blockVersions, approvedRequests] = await Promise.all([
    versionIds.length > 0
      ? db.select('disclosureBlockVersions', { where: { organizationId, id: { in: versionIds } } })
      : Promise.resolve([]),
    blockIds.length > 0
      ? db.select('reviewRequests', {
          where: { organizationId, targetId: { in: blockIds }, status: 'approved' },
        })
      : Promise.resolve([]),
  ]);
  const approvalEvents =
    approvedRequests.length > 0
      ? await db.select('reviewEvents', {
          where: {
            organizationId,
            reviewRequestId: { in: approvedRequests.map((r) => r.id) },
            eventType: 'approved',
          },
        })
      : [];
  const versionById = new Map(blockVersions.map((v) => [v.id, v]));

  // 引用した数値・定性情報・引用位置（現在の版）
  const currentVersions = blocks
    .map((b) => (b.currentVersionId ? versionById.get(b.currentVersionId) : undefined))
    .filter((v): v is DisclosureBlockVersion => v !== undefined);
  const metricVersionIds = [...new Set(currentVersions.flatMap((v) => v.metricRefs))];
  const narrativeVersionIds = [...new Set(currentVersions.flatMap((v) => v.narrativeRefs))];
  const [dpVersions, narrativeVersions] = await Promise.all([
    metricVersionIds.length > 0
      ? db.select('dataPointVersions', { where: { organizationId, id: { in: metricVersionIds } } })
      : Promise.resolve([]),
    narrativeVersionIds.length > 0
      ? db.select('narrativeVersions', {
          where: { organizationId, id: { in: narrativeVersionIds } },
        })
      : Promise.resolve([]),
  ]);
  const anchorIds = [
    ...new Set([
      ...currentVersions.flatMap((v) => v.anchorRefs),
      ...narrativeVersions.flatMap((v) => v.sourceAnchorIds),
    ]),
  ];
  const dataPointIds = [...new Set(dpVersions.map((v) => v.dataPointId))];
  const [dataPoints, anchors, narrativeRecords] = await Promise.all([
    dataPointIds.length > 0
      ? db.select('dataPoints', { where: { organizationId, id: { in: dataPointIds } } })
      : Promise.resolve([]),
    anchorIds.length > 0
      ? db.select('sourceAnchors', { where: { organizationId, id: { in: anchorIds } } })
      : Promise.resolve([]),
    narrativeVersions.length > 0
      ? db.select('narrativeRecords', {
          where: {
            organizationId,
            id: { in: [...new Set(narrativeVersions.map((v) => v.narrativeRecordId))] },
          },
        })
      : Promise.resolve([]),
  ]);
  const [metrics, units, periods, fileVersions] = await Promise.all([
    dataPoints.length > 0
      ? db.select('metrics', {
          where: { organizationId, id: { in: [...new Set(dataPoints.map((d) => d.metricId))] } },
        })
      : Promise.resolve([]),
    dataPoints.length > 0
      ? db.select('units', {
          where: { organizationId, id: { in: [...new Set(dataPoints.map((d) => d.unitId))] } },
        })
      : Promise.resolve([]),
    dataPoints.length > 0
      ? db.select('periods', {
          where: {
            organizationId,
            id: { in: [...new Set(dataPoints.map((d) => d.reportingPeriodId))] },
          },
        })
      : Promise.resolve([]),
    anchors.length > 0
      ? db.select('fileVersions', {
          where: {
            organizationId,
            id: { in: [...new Set(anchors.map((a) => a.fileVersionId))] },
          },
        })
      : Promise.resolve([]),
  ]);
  const files =
    fileVersions.length > 0
      ? await db.select('files', {
          where: { organizationId, id: { in: [...new Set(fileVersions.map((v) => v.fileId))] } },
        })
      : [];

  // 横断対応（マスター。要求事項の行に両方向で出す）
  const allItemIds = results.flatMap((r) => r.rows.map((row) => row.item.id));
  const [crosswalksFrom, crosswalksTo] =
    allItemIds.length > 0
      ? await Promise.all([
          db.select('requirementCrosswalks', { where: { fromItemId: { in: allItemIds } } }),
          db.select('requirementCrosswalks', { where: { toItemId: { in: allItemIds } } }),
        ])
      : [[], []];
  const counterpartItemIds = [
    ...new Set(
      [...crosswalksFrom.map((c) => c.toItemId), ...crosswalksTo.map((c) => c.fromItemId)].filter(
        (id): id is Uuid => id !== null,
      ),
    ),
  ];
  const counterpartItems =
    counterpartItemIds.length > 0
      ? await db.select('disclosureItems', { where: { id: { in: counterpartItemIds } } })
      : [];
  const frameworkVersionIdsForLabels = [
    ...new Set([
      ...crosswalksFrom.map((c) => c.toFrameworkVersionId),
      ...counterpartItems.map((i) => i.frameworkVersionId),
    ]),
  ];
  const labelVersions =
    frameworkVersionIdsForLabels.length > 0
      ? await db.select('frameworkVersions', {
          where: { id: { in: frameworkVersionIdsForLabels } },
        })
      : [];
  const versionLabel = (id: Uuid) =>
    labelVersions.find((v) => v.id === id)?.label ?? '（基準不明）';

  const rows: RequirementMatrixRow[] = [];
  const frameworks: RequirementMatrixFramework[] = [];
  for (const { view, rows: requirementRows, mode } of results) {
    const counts = Object.fromEntries(
      (['confirmed', 'needs_check', 'not_addressed', 'undetermined', 'excluded'] as const).map(
        (c) => [c, requirementRows.filter((r) => r.coverage.category === c).length],
      ),
    ) as Record<RequirementCoverageCategory, number>;
    frameworks.push({
      frameworkVersionId: view.version.id,
      label: view.label,
      positioning: view.legal.label,
      isSample: view.legal.isSample,
      mode,
      notCalculatedReason: mode === 'not_loaded' ? MATRIX_NOT_LOADED_REASON : null,
      total: requirementRows.length,
      counts,
    });
    for (const row of requirementRows) {
      const rowBlocks = row.blocks.map((b) => {
        const block = blocks.find((x) => x.id === b.id);
        const current = block?.currentVersionId
          ? versionById.get(block.currentVersionId)
          : undefined;
        const approvedVersion = block?.approvedVersionId
          ? versionById.get(block.approvedVersionId)
          : undefined;
        const approval = approvedVersion
          ? approvalEvents
              .filter((e) => e.targetVersionId === approvedVersion.id)
              .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]
          : undefined;
        return {
          blockId: b.id,
          title: b.title,
          statusLabel: BLOCK_STATUS_LABELS[b.status],
          versionNo: current?.versionNo ?? null,
          approvedVersionNo: approvedVersion?.versionNo ?? null,
          approvedByName: approval ? nameOf(detail.members, approval.actorUserId) : null,
          approvedAt: approval?.createdAt ?? null,
          excerpt: excerptOf(current),
          translation: b.translation,
        };
      });
      const ownVersions = row.blocks
        .map((b) => blocks.find((x) => x.id === b.id)?.currentVersionId)
        .map((id) => (id ? versionById.get(id) : undefined))
        .filter((v): v is DisclosureBlockVersion => v !== undefined);
      const rowMetrics = [...new Set(ownVersions.flatMap((v) => v.metricRefs))]
        .map((id) => dpVersions.find((v) => v.id === id))
        .filter((v) => v !== undefined)
        .map((v) => {
          const dp = dataPoints.find((d) => d.id === v.dataPointId);
          return {
            metricName: metrics.find((m) => m.id === dp?.metricId)?.name ?? '（指標名不明）',
            unitName: units.find((u) => u.id === dp?.unitId)?.name ?? '（組織不明）',
            periodCode: periods.find((p) => p.id === dp?.reportingPeriodId)?.code ?? '',
            boundary: dp?.boundary ?? '',
            value: displayValue(v.value, v.textValue),
            unitOfMeasure: v.unitOfMeasure,
            versionNo: v.versionNo,
            approved:
              v.status === 'approved' ||
              (dp?.status === 'approved' && dp.currentVersionId === v.id),
          };
        });
      const ownNarratives = [...new Set(ownVersions.flatMap((v) => v.narrativeRefs))]
        .map((id) => narrativeVersions.find((v) => v.id === id))
        .filter((v) => v !== undefined);
      const ownAnchorIds = [
        ...new Set([
          ...ownVersions.flatMap((v) => v.anchorRefs),
          ...ownNarratives.flatMap((v) => v.sourceAnchorIds),
        ]),
      ];
      const evidence = ownAnchorIds
        .map((id) => anchors.find((a) => a.id === id))
        .filter((a) => a !== undefined)
        .map((a) => {
          const fv = fileVersions.find((v) => v.id === a.fileVersionId);
          const file = fv ? files.find((f) => f.id === fv.fileId) : undefined;
          return {
            fileName: file?.originalName ?? '（ファイル名不明）',
            fileVersionNo: fv?.versionNo ?? null,
            locator: a.locator ?? (a.page !== null ? `${a.page} ページ` : ''),
          };
        });
      const crosswalk: RequirementMatrixCrosswalkCell[] = [
        ...crosswalksFrom
          .filter((c) => c.fromItemId === row.item.id)
          .map((c) => ({
            relation: c.relation,
            relationLabel: statusLabel('crosswalkRelation', c.relation),
            counterpartCode: counterpartItems.find((i) => i.id === c.toItemId)?.code ?? null,
            counterpartFramework: versionLabel(c.toFrameworkVersionId),
            sample: c.source === 'sample_fixture',
          })),
        ...crosswalksTo
          .filter((c) => c.toItemId === row.item.id)
          .map((c) => {
            const from = counterpartItems.find((i) => i.id === c.fromItemId);
            return {
              relation: c.relation,
              relationLabel: statusLabel('crosswalkRelation', c.relation),
              counterpartCode: from?.code ?? null,
              counterpartFramework: from ? versionLabel(from.frameworkVersionId) : '（基準不明）',
              sample: c.source === 'sample_fixture',
            };
          }),
      ];
      const excluded =
        row.decision.kind === 'not_applicable' ||
        row.decision.kind === 'not_material' ||
        row.decision.exclusion !== null;
      rows.push({
        frameworkVersionId: view.version.id,
        frameworkLabel: view.label,
        frameworkPositioning: view.legal.label,
        isSample: row.isSample,
        itemId: row.item.id,
        code: row.item.code,
        section: row.item.section,
        title: row.item.questionText,
        decisionLabel: row.decision.label,
        decisionSourceLabel: REQUIREMENT_DECISION_SOURCE_LABELS[row.decision.source],
        exclusionReason: excluded ? row.decision.reason : null,
        decidedByName: row.decision.decidedByName,
        approvedByName: row.decision.approvedByName,
        approvedAt: row.decision.approvedAt,
        category: row.coverage.category,
        categoryLabel: statusLabel('requirementCoverage', row.coverage.category),
        gapLabels: row.coverage.gaps.map((g) => REQUIREMENT_GAP_LABELS[g]),
        reasons: row.coverage.reasons,
        blocks: rowBlocks,
        metrics: rowMetrics,
        evidence,
        narratives: ownNarratives.map((v) => ({
          title:
            narrativeRecords.find((r) => r.id === v.narrativeRecordId)?.title ?? '（定性情報）',
          versionNo: v.versionNo,
        })),
        ownerName:
          nameOf(detail.members, row.ownerDue.ownerUserId) ?? row.ownerDue.ownerLabel ?? null,
        dueDate: row.ownerDue.dueDate,
        ownerDueSource: row.ownerDue.source,
        ownerDueSourceLabel: OWNER_DUE_SOURCE_LABELS[row.ownerDue.source],
        actionPlans: row.actionPlans,
        crosswalk,
        humanEvaluationLabel:
          row.contentEvaluation.source === 'human' ? row.contentEvaluation.label : null,
        aiCandidateLabel:
          row.contentEvaluation.source === 'ai_candidate' ? row.contentEvaluation.label : null,
      });
    }
  }
  return { project: detail.project, frameworks, rows };
}
