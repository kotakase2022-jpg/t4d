import 'server-only';

import { createHash } from 'node:crypto';
import { renderBlockParagraphs } from '@/lib/exports/disclosure-report';
import type {
  ReportSnapshotDetail,
  SnapshotBlock,
  SnapshotFramework,
  SnapshotMetricValue,
} from '@/lib/domain/report-snapshot-content';
import type { ValueKind, XbrlPeriodRole, XbrlTagMapping } from '@/types/domain';
import {
  UNIDENTIFIED_ENTITY,
  contextIdOf,
  periodRelation,
  type PeriodWindow,
  type XbrlEntity,
  type XbrlPeriod,
} from './context';
import { escapeXml } from './escape';
import { finding, type XbrlFinding } from './rules';
import {
  conceptQName,
  conceptValueClass,
  findConceptById,
  isValueConcept,
  type ConceptValueClass,
  type TaxonomyConcept,
  type TaxonomyPackage,
} from './taxonomy';
import { decimalString, groupedDecimal, mapUnit, scaleValue, unitIdOf } from './unit-map';

/**
 * 承認済みスナップショット＋確定した対応付け＋タクソノミ → XBRL の事実（plan §3.4 facts.ts）。
 *
 * - 値は**スナップショットだけ**から作る（ライブの数値・本文を引かない。同じ入力なら別のインスタンスでも
 *   同じ事実になる）。対応付け・パッケージ・提出者の識別子は出力の設定として入力で受け取る
 * - 事実を作るのは状態が「確定」の対応付けだけ（候補・対象外・削除済みは作らない。AI の候補も確定までは
 *   事実にならない）
 * - 事実を作れなかった理由（値がない・節が空・単位を換算できない など）は検査の指摘として返す
 *   （黙って落とさない）
 * - 事実ごとに出所（数値の版・節の版）と要求事項を持つ（追跡率の分母と分子）
 */

export interface RequirementLabel {
  code: string;
  title: string;
}

export interface FactBuildInput {
  snapshot: ReportSnapshotDetail;
  /** 出力する基準の版（スナップショットに含まれるもの） */
  frameworkVersionId: string;
  pkg: TaxonomyPackage;
  /** 範囲の対応付け（状態を問わず渡してよい。確定だけを使う） */
  mappings: readonly XbrlTagMapping[];
  /** 提出者（無ければ null。検査 V11 が止める） */
  entity: XbrlEntity | null;
  /** 対応付けの要求事項の表示（スナップショットの節に無い要求事項の分） */
  requirementLabels?: ReadonlyMap<string, RequirementLabel>;
}

export interface FactRequirement {
  itemId: string;
  code: string;
  title: string;
}

export type FactSource =
  | {
      kind: 'metric';
      dataPointId: string;
      dataPointVersionId: string;
      versionNo: number;
      metricId: string;
      metricCode: string;
      metricName: string;
      unitId: string;
      unitName: string;
      boundary: string;
      periodCode: string;
      periodStart: string;
      periodEnd: string;
      unitOfMeasure: string;
      valueKind: ValueKind;
      /** T4D の単位での値（10 進の文字列） */
      rawValue: string;
      versionApproved: boolean;
      /** この数値を本文で引用している節（出力する基準の節だけ） */
      citingBlocks: Array<{ blockId: string; versionId: string | null; title: string }>;
    }
  | {
      kind: 'block';
      blockId: string;
      versionId: string | null;
      versionNo: number | null;
      sectionKey: string;
      title: string;
      approved: boolean;
      paragraphCount: number;
    };

export interface XbrlFact {
  id: string;
  mappingId: string;
  concept: TaxonomyConcept;
  qname: string;
  valueClass: ConceptValueClass;
  numeric: boolean;
  /** 事実の値（数値は 10 進の文字列、テキストブロックはエスケープ済みの XHTML の断片） */
  value: string;
  /** XBRL の decimals（事実の単位で。数値で未設定なら null） */
  decimals: number | null;
  unit: { id: string; measure: string } | null;
  /** T4D の値に掛けた 10 の累乗（iXBRL の scale） */
  exponent: number;
  /** iXBRL に表示する数（T4D の単位。丸めない） */
  displayNumber: string | null;
  contextId: string;
  period: XbrlPeriod;
  /** 軸の名前（接頭辞付き）→ メンバーの名前（接頭辞付き） */
  dimensions: Record<string, string>;
  periodRole: XbrlPeriodRole;
  source: FactSource;
  requirements: FactRequirement[];
  /** 版（承認済み）・要求事項・引用した節まで遡れるか（追跡率） */
  traceable: boolean;
}

export interface XbrlContext {
  id: string;
  entity: XbrlEntity;
  period: XbrlPeriod;
  dimensions: Record<string, string>;
}

export interface FactBuildResult {
  framework: SnapshotFramework;
  /** 出力する基準の節（並び順） */
  blocks: SnapshotBlock[];
  report: PeriodWindow;
  entity: XbrlEntity;
  facts: XbrlFact[];
  contexts: XbrlContext[];
  units: Array<{ id: string; measure: string }>;
  /** 範囲の確定した対応付け（事実の出所。対応付け集合のハッシュの入力） */
  confirmedMappings: XbrlTagMapping[];
  /** 事実を作れなかった理由など、組み立ての途中で分かった指摘 */
  findings: XbrlFinding[];
}

/** 出力の範囲の対応付け（パッケージ・プロジェクト・基準の版が合うもの。削除済みを除く） */
export function mappingsInScope(
  mappings: readonly XbrlTagMapping[],
  scope: { packageId: string; projectId: string; frameworkVersionId: string },
): XbrlTagMapping[] {
  return mappings.filter(
    (m) =>
      m.deletedAt === null &&
      m.packageId === scope.packageId &&
      (m.projectId === null || m.projectId === scope.projectId) &&
      (m.frameworkVersionId === null || m.frameworkVersionId === scope.frameworkVersionId),
  );
}

function sha16(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** 節の本文（出力と同じ文字列）を XHTML の断片にする（利用者の文字列はエスケープ） */
export function textBlockValue(
  paragraphs: ReadonlyArray<{ kind: 'heading' | 'paragraph'; text: string }>,
): string {
  return paragraphs
    .map((p) =>
      p.kind === 'heading' ? `<h4>${escapeXml(p.text)}</h4>` : `<p>${escapeXml(p.text)}</p>`,
    )
    .join('');
}

/** 節の本文で引用している数値の版（出力する基準の節だけ） */
function citingBlocksOf(
  blocks: readonly SnapshotBlock[],
  dataPointVersionId: string,
): Array<{ blockId: string; versionId: string | null; title: string }> {
  return blocks
    .filter((b) =>
      b.body.paragraphs.some((p) =>
        p.children.some((c) => c.t === 'metric' && c.dataPointVersionId === dataPointVersionId),
      ),
    )
    .map((b) => ({ blockId: b.blockId, versionId: b.versionId, title: b.title }));
}

function matchesRole(mv: SnapshotMetricValue, role: XbrlPeriodRole, report: PeriodWindow): boolean {
  if (role === 'target') return mv.valueKind === 'target';
  const relation = periodRelation({ start: mv.periodStart, end: mv.periodEnd }, report);
  if (role === 'current') return relation === 'current';
  if (role === 'prior1') return relation === 'prior1';
  return relation === 'earlier';
}

const ROLE_ABSENT_MESSAGE: Record<XbrlPeriodRole, string> = {
  current: '当年度',
  prior1: '前年度',
  base_year: '基準年',
  target: '目標',
};

export function buildFacts(input: FactBuildInput): FactBuildResult {
  const { snapshot, pkg } = input;
  const framework = snapshot.frameworkVersions.find(
    (f) => f.frameworkVersionId === input.frameworkVersionId,
  );
  if (!framework) throw new Error('指定した基準の版はスナップショットに含まれていません。');
  const report: PeriodWindow = { start: framework.periodStart, end: framework.periodEnd };
  const blocks = snapshot.blocks
    .filter((b) => b.frameworkVersionId === framework.frameworkVersionId)
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.blockId < b.blockId ? -1 : 1));
  const entity = input.entity ?? UNIDENTIFIED_ENTITY;
  const findings: XbrlFinding[] = [];
  const facts: XbrlFact[] = [];

  const scoped = mappingsInScope(input.mappings, {
    packageId: pkg.id,
    projectId: snapshot.projectId,
    frameworkVersionId: framework.frameworkVersionId,
  });
  const confirmed = scoped
    .filter((m) => m.status === 'confirmed')
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  const blockRequirements = new Map<string, FactRequirement>();
  for (const block of blocks) {
    for (const r of block.requirements) {
      blockRequirements.set(r.itemId, { itemId: r.itemId, code: r.code, title: r.text });
    }
  }
  const requirementOf = (itemId: string | null): FactRequirement | null => {
    if (!itemId) return null;
    const own = blockRequirements.get(itemId);
    if (own) return own;
    const label = input.requirementLabels?.get(itemId);
    return { itemId, code: label?.code ?? '（不明な要求事項）', title: label?.title ?? '' };
  };

  // 本文で引用している数値だけ（出力する基準の節の中で）
  const cited = new Set<string>();
  for (const block of blocks) {
    for (const p of block.body.paragraphs) {
      for (const c of p.children) if (c.t === 'metric') cited.add(c.dataPointVersionId);
    }
  }
  const metricValues = snapshot.metricValues.filter((mv) => cited.has(mv.dataPointVersionId));

  for (const mapping of confirmed) {
    const refs = { mappingId: mapping.id };
    const concept = findConceptById(pkg, mapping.conceptId);
    if (!concept || !isValueConcept(concept)) {
      findings.push(
        finding(
          'V14',
          concept
            ? `概念「${concept.labelJa}」は値を持たない概念（${concept.kind === 'abstract' ? '抽象' : concept.kind === 'axis' ? '軸' : 'メンバー'}）のため、事実を出しません。`
            : '対応付けの概念がこのパッケージにありません。',
          refs,
        ),
      );
      continue;
    }
    const valueClass = conceptValueClass(concept);
    const qname = conceptQName(concept);
    const dimensions: Record<string, string> = {};
    for (const [axis, member] of Object.entries(mapping.dimensions ?? {})) {
      dimensions[`${pkg.prefix}:${axis}`] = `${pkg.prefix}:${member}`;
    }

    if (mapping.targetKind === 'constant') {
      findings.push(
        finding('V02', '定数の対応付けは Stage 1 では値を出しません（事実を出しません）。', refs),
      );
      continue;
    }

    if (mapping.targetKind === 'block') {
      if (valueClass !== 'text_block') {
        findings.push(
          finding(
            'V03',
            `節は文章の概念（テキストブロック）にだけ対応付けられます（概念「${concept.labelJa}」は数値・文字の概念です）。`,
            refs,
          ),
        );
        continue;
      }
      const block = blocks.find((b) => b.sectionKey === mapping.sectionKey);
      if (!block) {
        findings.push(
          finding(
            'V10',
            `節「${mapping.sectionKey ?? ''}」はこのスナップショットにありません（事実を出しません）。`,
            refs,
          ),
        );
        continue;
      }
      const paragraphs = renderBlockParagraphs(block, snapshot, 'internal');
      if (paragraphs.length === 0) {
        findings.push(
          finding('V10', `節「${block.title}」の本文が空です（事実を出しません）。`, refs),
        );
        continue;
      }
      const approved = block.isApprovedVersion && block.status === 'approved';
      const period: XbrlPeriod =
        concept.periodType === 'instant'
          ? { type: 'instant', instant: report.end }
          : { type: 'duration', start: report.start, end: report.end };
      const contextId = contextIdOf(period, report, mapping.dimensions ?? {});
      const requirements = uniqueRequirements([
        requirementOf(mapping.disclosureItemId),
        ...block.requirements.map((r) => requirementOf(r.itemId)),
      ]);
      facts.push({
        id: `f-${sha16(`${qname}|${contextId}|block|${block.blockId}|${block.versionId ?? ''}|${mapping.id}`)}`,
        mappingId: mapping.id,
        concept,
        qname,
        valueClass,
        numeric: false,
        value: textBlockValue(paragraphs),
        decimals: null,
        unit: null,
        exponent: 0,
        displayNumber: null,
        contextId,
        period,
        dimensions,
        periodRole: mapping.periodRole,
        source: {
          kind: 'block',
          blockId: block.blockId,
          versionId: block.versionId,
          versionNo: block.versionNo,
          sectionKey: block.sectionKey,
          title: block.title,
          approved,
          paragraphCount: paragraphs.length,
        },
        requirements,
        traceable: block.versionId !== null && approved && requirements.length > 0,
      });
      continue;
    }

    // 数値の対応付け（指標 × 組織単位 × 境界）
    if (valueClass === 'text_block' || valueClass === 'string' || valueClass === 'none') {
      findings.push(
        finding(
          'V03',
          `数値は数値の概念にだけ対応付けられます（概念「${concept.labelJa}」は文章の概念です）。`,
          refs,
        ),
      );
      continue;
    }
    const candidates = metricValues.filter(
      (mv) =>
        mv.metricId === mapping.metricId &&
        (mapping.unitId === null || mv.unitId === mapping.unitId) &&
        (mapping.boundary === null || mv.boundary === mapping.boundary) &&
        matchesRole(mv, mapping.periodRole, report),
    );
    if (candidates.length === 0) {
      const role = ROLE_ABSENT_MESSAGE[mapping.periodRole];
      if (mapping.periodRole === 'prior1' || mapping.periodRole === 'base_year') {
        findings.push(
          finding(
            'V15',
            `${role}の値の版が、このスナップショットの本文にありません（事実を出しません）。${role}の値を本文で引用すると固定されます。`,
            refs,
          ),
        );
      } else {
        findings.push(
          finding(
            'V02',
            `対応付けた数値（${role}）が、このスナップショットの本文にありません（事実を出しません）。`,
            refs,
          ),
        );
      }
      continue;
    }
    for (const mv of candidates) {
      if (mv.availabilityStatus !== 'value_present' || mv.value === null) {
        findings.push(
          finding(
            'V02',
            `「${mv.metricName}（${mv.unitName}・${mv.periodCode}）」に値がありません（事実を出しません）。`,
            refs,
          ),
        );
        continue;
      }
      const unit = mapUnit(mv.unitOfMeasure);
      if (!unit) {
        findings.push(
          finding(
            'V03',
            `単位「${mv.unitOfMeasure}」を XBRL の単位に換算できません（事実を出しません）。換算できる単位はヘルプの一覧を参照してください。`,
            refs,
          ),
        );
        continue;
      }
      const period: XbrlPeriod =
        concept.periodType === 'instant'
          ? { type: 'instant', instant: mv.periodEnd }
          : { type: 'duration', start: mv.periodStart, end: mv.periodEnd };
      const contextId = contextIdOf(period, report, mapping.dimensions ?? {});
      const rawValue = decimalString(mv.value);
      const value = scaleValue(mv.value, unit.exponent);
      const citingBlocks = citingBlocksOf(blocks, mv.dataPointVersionId);
      const requirements = uniqueRequirements([
        requirementOf(mapping.disclosureItemId),
        ...blocks
          .filter((b) => citingBlocks.some((c) => c.blockId === b.blockId))
          .flatMap((b) => b.requirements.map((r) => requirementOf(r.itemId))),
      ]);
      const unitId = unitIdOf(unit.measure);
      facts.push({
        id: `f-${sha16(`${qname}|${contextId}|${unitId}|metric|${mv.dataPointVersionId}|${mapping.id}`)}`,
        mappingId: mapping.id,
        concept,
        qname,
        valueClass,
        numeric: true,
        value,
        decimals: mapping.decimals === null ? null : mapping.decimals - unit.exponent,
        unit: { id: unitId, measure: unit.measure },
        exponent: unit.exponent,
        displayNumber: groupedDecimal(rawValue),
        contextId,
        period,
        dimensions,
        periodRole: mapping.periodRole,
        source: {
          kind: 'metric',
          dataPointId: mv.dataPointId,
          dataPointVersionId: mv.dataPointVersionId,
          versionNo: mv.versionNo,
          metricId: mv.metricId,
          metricCode: mv.metricCode,
          metricName: mv.metricName,
          unitId: mv.unitId,
          unitName: mv.unitName,
          boundary: mv.boundary,
          periodCode: mv.periodCode,
          periodStart: mv.periodStart,
          periodEnd: mv.periodEnd,
          unitOfMeasure: mv.unitOfMeasure,
          valueKind: mv.valueKind,
          rawValue,
          versionApproved: mv.versionApproved,
          citingBlocks,
        },
        requirements,
        traceable: mv.versionApproved && requirements.length > 0 && citingBlocks.length > 0,
      });
    }
  }

  facts.sort(
    (a, b) =>
      a.concept.sortOrder - b.concept.sortOrder ||
      (a.contextId < b.contextId ? -1 : a.contextId > b.contextId ? 1 : 0) ||
      (a.id < b.id ? -1 : 1),
  );

  const contexts = new Map<string, XbrlContext>();
  const units = new Map<string, string>();
  for (const fact of facts) {
    if (!contexts.has(fact.contextId)) {
      contexts.set(fact.contextId, {
        id: fact.contextId,
        entity,
        period: fact.period,
        dimensions: fact.dimensions,
      });
    }
    if (fact.unit) units.set(fact.unit.id, fact.unit.measure);
  }

  return {
    framework,
    blocks,
    report,
    entity,
    facts,
    contexts: [...contexts.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    units: [...units.entries()]
      .map(([id, measure]) => ({ id, measure }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    confirmedMappings: confirmed,
    findings,
  };
}

function uniqueRequirements(list: ReadonlyArray<FactRequirement | null>): FactRequirement[] {
  const seen = new Map<string, FactRequirement>();
  for (const r of list) if (r && !seen.has(r.itemId)) seen.set(r.itemId, r);
  return [...seen.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/** 追跡率（遡れる事実 / 事実の数）。事実が無ければ 0 / 0 */
export function factTraceSummary(facts: readonly XbrlFact[]): { traceable: number; total: number } {
  return { traceable: facts.filter((f) => f.traceable).length, total: facts.length };
}
