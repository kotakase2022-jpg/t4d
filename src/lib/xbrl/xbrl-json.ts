import 'server-only';

import { createHash } from 'node:crypto';
import { canonicalJson } from '@/lib/domain/disclosure-block';
import { toCsv, type ExportColumn } from '@/lib/exports';
import type { XbrlTagMapping } from '@/types/domain';
import {
  FILING_IDENTIFIER_SCHEME_LABELS,
  oimPeriod,
  type XbrlEntity,
  type XbrlPeriod,
} from './context';
import type { FactBuildResult, XbrlFact } from './facts';
import { NOT_FILING_READY_NOTICE, SIMPLE_CHECK_NOTICE } from './sample-taxonomy';
import type { TaxonomyPackage } from './taxonomy';
import { MEASURE_NAMESPACES } from './unit-map';

/**
 * xBRL-JSON（OIM。https://xbrl.org/2021/xbrl-json）と社内用の照合表（CSV）。plan §3.4 xbrl-json.ts。
 *
 * - 生成日時を入れない（同じスナップショット・同じ対応付け・同じパッケージ・同じ生成器の版なら、
 *   ファイルの中身もハッシュも同じ）
 * - 先頭（documentInfo の T4D の拡張）に「提出用ではない」・SAMPLE・簡易検査の注記を入れる
 * - 照合表（事実 ID ⇄ 版 ID ⇄ 要求事項）は社内確認用。対外には出さない
 */

/** 生成器の版（出力の形を変えたら上げる。XBRL の内容ハッシュに含める） */
export const XBRL_GENERATOR_VERSION = 't4d-xbrl-stage1-v1';

/** T4D の拡張の名前空間（documentInfo の注記・ハッシュ） */
export const T4D_EXPORT_NAMESPACE = 'urn:t4d:export-metadata';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 対応付け集合のハッシュ。事実に効く列（確定した対応付け）と、使った提出者の識別子を含める
 * （識別子が変われば出力の entity が変わるため）
 */
export function mappingSetHash(
  mappings: readonly XbrlTagMapping[],
  entity: Pick<XbrlEntity, 'scheme' | 'value'>,
): string {
  const rows = [...mappings]
    .filter((m) => m.status === 'confirmed' && m.deletedAt === null)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((m) => ({
      id: m.id,
      conceptId: m.conceptId,
      targetKind: m.targetKind,
      metricId: m.metricId,
      unitId: m.unitId,
      boundary: m.boundary,
      frameworkVersionId: m.frameworkVersionId,
      sectionKey: m.sectionKey,
      disclosureItemId: m.disclosureItemId,
      dimensions: m.dimensions,
      periodRole: m.periodRole,
      decimals: m.decimals,
      scale: m.scale,
    }));
  return sha256(
    canonicalJson({ mappings: rows, entity: { scheme: entity.scheme, value: entity.value } }),
  );
}

/** XBRL の内容ハッシュ＝hash(スナップショットの内容ハッシュ＋対応付け集合のハッシュ＋パッケージ key＋生成器の版) */
export function xbrlContentHash(input: {
  snapshotContentHash: string;
  mappingSetHash: string;
  packageKey: string;
}): string {
  return sha256(
    canonicalJson({
      snapshotContentHash: input.snapshotContentHash,
      mappingSetHash: input.mappingSetHash,
      packageKey: input.packageKey,
      generator: XBRL_GENERATOR_VERSION,
    }),
  );
}

export interface XbrlDocumentMeta {
  snapshotNo: number;
  snapshotLabel: string;
  snapshotContentHash: string;
  mappingSetHash: string;
  contentHash: string;
}

function periodLabel(period: XbrlPeriod): string {
  return period.type === 'instant' ? period.instant : `${period.start}〜${period.end}`;
}

function measurePrefixes(result: FactBuildResult): Record<string, string> {
  const out: Record<string, string> = {};
  for (const unit of result.units) {
    const prefix = unit.measure.split(':')[0] ?? '';
    if (prefix in MEASURE_NAMESPACES) {
      out[prefix] = MEASURE_NAMESPACES[prefix as keyof typeof MEASURE_NAMESPACES];
    }
  }
  return out;
}

/** xBRL-JSON の文字列（2 字下げ・キーの順は固定） */
export function buildXbrlJson(
  result: FactBuildResult,
  pkg: TaxonomyPackage,
  meta: XbrlDocumentMeta,
): string {
  const facts: Record<string, unknown> = {};
  for (const fact of result.facts) {
    const dimensions: Record<string, string> = {
      concept: fact.qname,
      entity: `t4d-entity:${result.entity.value}`,
      period: oimPeriod(fact.period),
    };
    if (fact.unit) dimensions.unit = fact.unit.measure;
    for (const axis of Object.keys(fact.dimensions).sort()) {
      dimensions[axis] = fact.dimensions[axis]!;
    }
    facts[fact.id] = fact.numeric
      ? { value: fact.value, decimals: fact.decimals ?? undefined, dimensions }
      : { value: fact.value, dimensions };
  }
  const document = {
    documentInfo: {
      documentType: 'https://xbrl.org/2021/xbrl-json',
      namespaces: {
        [pkg.prefix]: pkg.namespaceUri,
        xbrl: 'https://xbrl.org/2021',
        xbrli: MEASURE_NAMESPACES.xbrli,
        ...measurePrefixes(result),
        't4d-entity': result.entity.schemeUri,
        t4d: T4D_EXPORT_NAMESPACE,
      },
      taxonomy: [pkg.entryPoint || pkg.namespaceUri],
      't4d:notice': NOT_FILING_READY_NOTICE,
      't4d:taxonomy': `${pkg.name}（${pkg.versionLabel}）`,
      't4d:sampleTaxonomy': pkg.isSample,
      't4d:filingReady': pkg.filingReady,
      't4d:validation': SIMPLE_CHECK_NOTICE,
      't4d:generator': XBRL_GENERATOR_VERSION,
      't4d:snapshot': `${meta.snapshotLabel} No.${meta.snapshotNo}`,
      't4d:snapshotContentHash': meta.snapshotContentHash,
      't4d:mappingSetHash': meta.mappingSetHash,
      't4d:contentHash': meta.contentHash,
    },
    facts,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

// ----------------------------------------------------------------------
// 照合表（社内確認用 CSV）
// ----------------------------------------------------------------------

function sourceVersionId(fact: XbrlFact): string {
  return fact.source.kind === 'metric'
    ? fact.source.dataPointVersionId
    : (fact.source.versionId ?? '');
}

const TRACE_COLUMNS: ExportColumn<XbrlFact>[] = [
  { key: 'fact', header: '事実 ID', value: (f) => f.id },
  { key: 'concept', header: '概念', value: (f) => f.qname },
  { key: 'label', header: '概念のラベル', value: (f) => f.concept.labelJa },
  {
    key: 'value',
    header: '値',
    // 文章（テキストブロック）は長いため段落の数だけを書く（本文はプレビュー・原稿で見る）
    value: (f) =>
      f.numeric
        ? Number(f.value)
        : `（テキストブロック・${f.source.kind === 'block' ? f.source.paragraphCount : 0} 段落）`,
    numeric: true,
  },
  { key: 'unit', header: '単位', value: (f) => f.unit?.measure ?? '' },
  { key: 'decimals', header: 'decimals', value: (f) => f.decimals ?? '' },
  { key: 'context', header: 'コンテキスト', value: (f) => f.contextId },
  { key: 'period', header: '期間', value: (f) => periodLabel(f.period) },
  {
    key: 'dimensions',
    header: '軸',
    value: (f) =>
      Object.entries(f.dimensions)
        .map(([axis, member]) => `${axis}=${member}`)
        .join(' '),
  },
  {
    key: 'sourceKind',
    header: '出所の種類',
    value: (f) => (f.source.kind === 'metric' ? '数値の版' : '節の版'),
  },
  {
    key: 'source',
    header: '出所',
    value: (f) =>
      f.source.kind === 'metric'
        ? `${f.source.metricName}（${f.source.unitName}・${f.source.boundary}・${f.source.periodCode}）`
        : f.source.title,
  },
  { key: 'versionId', header: '版の ID', value: sourceVersionId },
  {
    key: 'versionNo',
    header: '版',
    value: (f) => (f.source.kind === 'metric' ? f.source.versionNo : (f.source.versionNo ?? '')),
  },
  {
    key: 'approved',
    header: '承認',
    value: (f) =>
      (f.source.kind === 'metric' ? f.source.versionApproved : f.source.approved)
        ? '承認済み'
        : '未承認',
  },
  {
    key: 'citing',
    header: '引用した節',
    value: (f) =>
      f.source.kind === 'metric' ? f.source.citingBlocks.map((b) => b.title).join('・') : '',
  },
  {
    key: 'requirements',
    header: '要求事項',
    value: (f) => f.requirements.map((r) => r.code).join('・'),
  },
  { key: 'traceable', header: '追跡', value: (f) => (f.traceable ? '遡れる' : '遡れない') },
  { key: 'mapping', header: '対応付けの ID', value: (f) => f.mappingId },
];

/** 照合表（事実 ID ⇄ 版 ID ⇄ 要求事項）。社内確認用。先頭に注記の行は入れない（表のまま読めるように） */
export function buildTraceCsv(result: FactBuildResult): string {
  return toCsv({ name: '照合表', columns: TRACE_COLUMNS, rows: result.facts });
}

/** 画面・ファイル名の提出者の表示 */
export function entityLabel(entity: XbrlEntity): string {
  return `${FILING_IDENTIFIER_SCHEME_LABELS[entity.scheme]}: ${entity.value}`;
}
