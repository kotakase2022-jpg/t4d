/**
 * 承認版どうしの差分（トライアル対応 NF-13。スライド 4「不足・変更箇所を検知」）。
 *
 * 2 つのスナップショット（固定した写し）だけを比べる。ライブの行を引かない（同じ 2 つなら、いつ・どの
 * インスタンスで比べても同じ結果）。保存しない。
 *
 *  - 節: 節の ID で対応を取り、段落の差分は既存の diffParagraphs（段落 ID で対応・変更段落は文字単位）
 *  - 数値: Data Point で対応を取り、版・値の違い
 *  - 要求事項の付け替え: 同じ節の要求事項コードの増減
 *  - 判断の変更: 基準ごとの適用区分・判断の記録、要求事項の判断の記録（v2 の写しの ID の増減・
 *    可変の評価行のダイジェストの違い）
 */

import { diffParagraphs, type ParagraphDiff } from '@/lib/domain/disclosure-block';
import type {
  ReportSnapshotDetail,
  SnapshotBlock,
  SnapshotFramework,
  SnapshotMetricValue,
} from '@/lib/domain/report-snapshot-content';
import type { ApplicabilityStatus, IsoDateTime, ReportSnapshotKind, Uuid } from '@/types/domain';

export type BlockChangeKind = 'added' | 'removed' | 'changed' | 'unchanged';

export interface BlockDiff {
  blockId: Uuid;
  title: string;
  frameworkVersionId: Uuid;
  kind: BlockChangeKind;
  fromVersionNo: number | null;
  toVersionNo: number | null;
  /** 変更・追加・削除した節の段落の差分（unchanged は空） */
  paragraphs: ParagraphDiff[];
  /** 変わった段落の数（追加・削除・変更） */
  changedParagraphCount: number;
}

export type MetricChangeKind = 'added' | 'removed' | 'changed';

export interface MetricDiff {
  dataPointId: Uuid;
  label: string;
  kind: MetricChangeKind;
  from: Pick<SnapshotMetricValue, 'versionNo' | 'value' | 'textValue' | 'unitOfMeasure'> | null;
  to: Pick<SnapshotMetricValue, 'versionNo' | 'value' | 'textValue' | 'unitOfMeasure'> | null;
}

export interface RequirementMappingDiff {
  blockId: Uuid;
  title: string;
  added: string[];
  removed: string[];
}

export interface DecisionDiff {
  frameworkVersionId: Uuid;
  label: string;
  /** 基準そのものの追加・削除（片方にしか無い） */
  presence: 'both' | 'added' | 'removed';
  applicability: { from: ApplicabilityStatus; to: ApplicabilityStatus } | null;
  /** 基準の適用判断の記録が変わったか（判断の記録の ID） */
  decisionChanged: boolean;
  /** 要求事項の判断の記録（追記専用の記録の ID）の増加 */
  addedAssessmentEvents: number;
  addedExclusionEvents: number;
  /** 可変の評価行（SSBJ・CSRD）の値が変わったか。どちらかが v1・ダイジェストなしなら null */
  assessmentDigestChanged: boolean | null;
}

export interface SnapshotRef {
  id: Uuid;
  snapshotNo: number;
  snapshotKind: ReportSnapshotKind;
  createdAt: IsoDateTime;
}

export interface SnapshotDiff {
  from: SnapshotRef;
  to: SnapshotRef;
  blocks: BlockDiff[];
  metrics: MetricDiff[];
  requirements: RequirementMappingDiff[];
  decisions: DecisionDiff[];
  summary: {
    addedBlocks: number;
    removedBlocks: number;
    changedBlocks: number;
    changedParagraphs: number;
    metricChanges: number;
    requirementChanges: number;
    decisionChanges: number;
    /** どこにも違いが無い */
    identical: boolean;
  };
}

function refOf(s: ReportSnapshotDetail): SnapshotRef {
  return {
    id: s.id,
    snapshotNo: s.snapshotNo,
    snapshotKind: s.snapshotKind,
    createdAt: s.createdAt,
  };
}

function metricLabel(mv: SnapshotMetricValue): string {
  return `${mv.metricName}（${mv.unitName}・${mv.periodCode}）`;
}

function metricShape(
  mv: SnapshotMetricValue,
): Pick<SnapshotMetricValue, 'versionNo' | 'value' | 'textValue' | 'unitOfMeasure'> {
  return {
    versionNo: mv.versionNo,
    value: mv.value,
    textValue: mv.textValue,
    unitOfMeasure: mv.unitOfMeasure,
  };
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

function blockDiffOf(from: SnapshotBlock | undefined, to: SnapshotBlock | undefined): BlockDiff {
  const base = (to ?? from)!;
  if (!from) {
    const paragraphs = diffParagraphs(null, to!.body);
    return {
      blockId: base.blockId,
      title: base.title,
      frameworkVersionId: base.frameworkVersionId,
      kind: 'added',
      fromVersionNo: null,
      toVersionNo: to!.versionNo,
      paragraphs,
      changedParagraphCount: paragraphs.length,
    };
  }
  if (!to) {
    const paragraphs = diffParagraphs(from.body, { paragraphs: [] });
    return {
      blockId: base.blockId,
      title: base.title,
      frameworkVersionId: base.frameworkVersionId,
      kind: 'removed',
      fromVersionNo: from.versionNo,
      toVersionNo: null,
      paragraphs,
      changedParagraphCount: paragraphs.length,
    };
  }
  const paragraphs = diffParagraphs(from.body, to.body);
  const changed = paragraphs.filter((p) => p.kind !== 'unchanged').length;
  const kind: BlockChangeKind =
    changed > 0 || from.versionId !== to.versionId || from.title !== to.title
      ? 'changed'
      : 'unchanged';
  return {
    blockId: base.blockId,
    title: to.title,
    frameworkVersionId: to.frameworkVersionId,
    kind,
    fromVersionNo: from.versionNo,
    toVersionNo: to.versionNo,
    paragraphs: kind === 'unchanged' ? [] : paragraphs,
    changedParagraphCount: changed,
  };
}

function decisionDiffOf(
  from: SnapshotFramework | undefined,
  to: SnapshotFramework | undefined,
): DecisionDiff | null {
  const base = (to ?? from)!;
  if (!from || !to) {
    return {
      frameworkVersionId: base.frameworkVersionId,
      label: base.label,
      presence: from ? 'removed' : 'added',
      applicability: null,
      decisionChanged: false,
      addedAssessmentEvents: 0,
      addedExclusionEvents: 0,
      assessmentDigestChanged: null,
    };
  }
  const fromState = from.requirementState ?? null;
  const toState = to.requirementState ?? null;
  const newIds = (a: readonly string[], b: readonly string[]) => {
    const set = new Set(a);
    return b.filter((id) => !set.has(id)).length;
  };
  const diff: DecisionDiff = {
    frameworkVersionId: base.frameworkVersionId,
    label: to.label,
    presence: 'both',
    applicability:
      from.applicabilityStatus !== to.applicabilityStatus
        ? { from: from.applicabilityStatus, to: to.applicabilityStatus }
        : null,
    decisionChanged: from.decisionId !== to.decisionId,
    addedAssessmentEvents:
      fromState && toState ? newIds(fromState.assessmentEventIds, toState.assessmentEventIds) : 0,
    addedExclusionEvents:
      fromState && toState ? newIds(fromState.exclusionEventIds, toState.exclusionEventIds) : 0,
    assessmentDigestChanged:
      fromState?.assessmentDigest && toState?.assessmentDigest
        ? fromState.assessmentDigest !== toState.assessmentDigest
        : null,
  };
  const changed =
    diff.applicability !== null ||
    diff.decisionChanged ||
    diff.addedAssessmentEvents > 0 ||
    diff.addedExclusionEvents > 0 ||
    diff.assessmentDigestChanged === true;
  return changed ? diff : null;
}

/** 2 つのスナップショットの差分（from → to）。同じスナップショットを渡すと「違いなし」 */
export function diffSnapshots(from: ReportSnapshotDetail, to: ReportSnapshotDetail): SnapshotDiff {
  // 節: to の並び順を基本に、from にしか無い節を後ろに足す
  const fromBlocks = new Map(from.blocks.map((b) => [b.blockId, b]));
  const toBlocks = new Map(to.blocks.map((b) => [b.blockId, b]));
  const order = [
    ...to.blocks.map((b) => b.blockId),
    ...from.blocks.map((b) => b.blockId).filter((id) => !toBlocks.has(id)),
  ];
  const blocks = order.map((id) => blockDiffOf(fromBlocks.get(id), toBlocks.get(id)));

  // 数値: Data Point ごと
  const fromMetrics = new Map(from.metricValues.map((m) => [m.dataPointId, m]));
  const toMetrics = new Map(to.metricValues.map((m) => [m.dataPointId, m]));
  const metricIds = [
    ...to.metricValues.map((m) => m.dataPointId),
    ...from.metricValues.map((m) => m.dataPointId).filter((id) => !toMetrics.has(id)),
  ];
  const metrics: MetricDiff[] = [];
  for (const id of [...new Set(metricIds)]) {
    const a = fromMetrics.get(id);
    const b = toMetrics.get(id);
    if (a && b) {
      if (
        a.dataPointVersionId === b.dataPointVersionId &&
        a.value === b.value &&
        a.textValue === b.textValue
      ) {
        continue;
      }
      metrics.push({
        dataPointId: id,
        label: metricLabel(b),
        kind: 'changed',
        from: metricShape(a),
        to: metricShape(b),
      });
    } else if (b) {
      metrics.push({
        dataPointId: id,
        label: metricLabel(b),
        kind: 'added',
        from: null,
        to: metricShape(b),
      });
    } else if (a) {
      metrics.push({
        dataPointId: id,
        label: metricLabel(a),
        kind: 'removed',
        from: metricShape(a),
        to: null,
      });
    }
  }

  // 要求事項の付け替え（両方にある節だけ。追加・削除した節は節の差分で示す）
  const requirements: RequirementMappingDiff[] = [];
  for (const id of order) {
    const a = fromBlocks.get(id);
    const b = toBlocks.get(id);
    if (!a || !b) continue;
    const aCodes = a.requirements.map((r) => r.code);
    const bCodes = b.requirements.map((r) => r.code);
    if (sameIds(aCodes, bCodes)) continue;
    requirements.push({
      blockId: id,
      title: b.title,
      added: bCodes.filter((c) => !aCodes.includes(c)),
      removed: aCodes.filter((c) => !bCodes.includes(c)),
    });
  }

  // 判断の変更（基準ごと）
  const fromFrameworks = new Map(from.frameworkVersions.map((f) => [f.frameworkVersionId, f]));
  const toFrameworks = new Map(to.frameworkVersions.map((f) => [f.frameworkVersionId, f]));
  const frameworkIds = [
    ...to.frameworkVersions.map((f) => f.frameworkVersionId),
    ...from.frameworkVersions
      .map((f) => f.frameworkVersionId)
      .filter((id) => !toFrameworks.has(id)),
  ];
  const decisions = frameworkIds
    .map((id) => decisionDiffOf(fromFrameworks.get(id), toFrameworks.get(id)))
    .filter((d): d is DecisionDiff => d !== null);

  const summary = {
    addedBlocks: blocks.filter((b) => b.kind === 'added').length,
    removedBlocks: blocks.filter((b) => b.kind === 'removed').length,
    changedBlocks: blocks.filter((b) => b.kind === 'changed').length,
    changedParagraphs: blocks.reduce((sum, b) => sum + b.changedParagraphCount, 0),
    metricChanges: metrics.length,
    requirementChanges: requirements.length,
    decisionChanges: decisions.length,
    identical: false,
  };
  summary.identical =
    summary.addedBlocks +
      summary.removedBlocks +
      summary.changedBlocks +
      summary.metricChanges +
      summary.requirementChanges +
      summary.decisionChanges ===
    0;
  return { from: refOf(from), to: refOf(to), blocks, metrics, requirements, decisions, summary };
}
