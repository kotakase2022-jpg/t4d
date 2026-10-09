import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  ReportSnapshotDetail,
  SnapshotBlock,
  SnapshotFramework,
  SnapshotMetricValue,
} from '@/lib/domain/report-snapshot-content';
import { buildFacts, type FactBuildInput } from '@/lib/xbrl/facts';
import { buildIxbrlPreview } from '@/lib/xbrl/ixbrl';
import { SAMPLE_ENTITY_SCHEME_URI } from '@/lib/xbrl/sample-taxonomy';
import type { TaxonomyConcept, TaxonomyPackage } from '@/lib/xbrl/taxonomy';
import { validateXbrl } from '@/lib/xbrl/validate';
import {
  XBRL_GENERATOR_VERSION,
  buildTraceCsv,
  buildXbrlJson,
  mappingSetHash,
  xbrlContentHash,
} from '@/lib/xbrl/xbrl-json';
import type { XbrlTagMapping } from '@/types/domain';

/**
 * xBRL-JSON の指紋（生成器の版と組で固定）と、iXBRL のエスケープ・帯（plan §3.6 unit）。
 *
 * 出力の形を変えてこのテストが落ちたら、XBRL_GENERATOR_VERSION を上げてから指紋を更新する
 * （指紋だけを更新しない。同じ内容ハッシュの出力が別の中身にならないように）。
 */

const NS = 'urn:t4d:sample-taxonomy:2026';

function concept(
  localName: string,
  kind: TaxonomyConcept['kind'],
  dataType: string,
  periodType: TaxonomyConcept['periodType'],
  labelJa: string,
  parentLocalName: string | null = null,
  sortOrder = 0,
): TaxonomyConcept {
  return {
    id: `c-${localName}`,
    prefix: 't4ds',
    localName,
    namespaceUri: NS,
    kind,
    dataType,
    periodType,
    labelJa,
    labelEn: localName,
    parentLocalName,
    deprecated: false,
    sortOrder,
  };
}

const PKG: TaxonomyPackage = {
  id: 'pkg-1',
  key: 'sample-test',
  frameworkKey: 'ssbj',
  profile: 'sample',
  name: '（サンプル）試験用タクソノミ',
  versionLabel: 'SAMPLE（架空）',
  publisher: 'T4D（架空）',
  legalStatus: 'sample',
  licenseStatus: 'not_required',
  licenseNote: '',
  namespaceUri: NS,
  prefix: 't4ds',
  entryPoint: '',
  filingReady: false,
  isSample: true,
  concepts: [
    concept(
      'SampleScope1GhgEmissions',
      'item',
      'xbrli:decimalItemType',
      'duration',
      '（サンプル）スコープ1',
      null,
      1,
    ),
    concept(
      'SampleGovernanceTextBlock',
      'text_block',
      'nonnum:textBlockItemType',
      'duration',
      '（サンプル）ガバナンス',
      null,
      2,
    ),
    concept('SampleGhgBoundaryAxis', 'axis', '', null, '（サンプル）集計範囲［軸］', null, 3),
    concept(
      'SampleFinancialControlMember',
      'member',
      'nonnum:domainItemType',
      null,
      '（サンプル）財務支配力［メンバー］',
      'SampleGhgBoundaryAxis',
      4,
    ),
  ],
  unitRules: { SampleScope1GhgEmissions: ['utr:tCO2e'] },
};

const metricValue: SnapshotMetricValue = {
  dataPointId: 'dp-1',
  dataPointVersionId: 'dpv-1',
  metricId: 'm-1',
  value: 1352.1,
  textValue: null,
  unitOfMeasure: 't-CO2e',
  reportingPeriodId: 'p-1',
  boundary: '連結',
  status: 'approved',
  valueKind: 'actual',
  availabilityStatus: 'value_present',
  versionNo: 2,
  metricCode: 'scope1',
  metricName: 'Scope1 <排出量>',
  unitId: 'u-1',
  unitName: '本社',
  periodCode: 'FY2026',
  periodStart: '2026-04-01',
  periodEnd: '2027-03-31',
  versionApproved: true,
  changeReason: null,
  absenceReason: null,
  evidenceFileVersionIds: [],
};

function block(overrides: Partial<SnapshotBlock>): SnapshotBlock {
  return {
    blockId: 'b-1',
    versionId: 'bv-1',
    sectionKey: 'governance',
    title: 'ガバナンス',
    language: 'ja',
    status: 'approved',
    body: { paragraphs: [] },
    contentHash: null,
    frameworkVersionId: 'fv-1',
    sortOrder: 1,
    versionNo: 3,
    versionCreatedBy: null,
    versionCreatedAt: null,
    approvedVersionId: 'bv-1',
    isApprovedVersion: true,
    requirements: [{ itemId: 'i-1', code: '気候-10', section: '', text: 'ガバナンス' }],
    issues: [],
    internalComments: [],
    maskedFileNames: [],
    approval: null,
    ...overrides,
  };
}

const framework: SnapshotFramework = {
  frameworkVersionId: 'fv-1',
  frameworkKey: 'ssbj',
  label: 'SSBJ（試験）',
  versionCode: '2026',
  legalStatus: 'effective',
  coverageStatus: 'full_for_scope',
  applicabilityStatus: 'applicable',
  decisionId: null,
  purpose: 'ssbj_voluntary',
  draftStandardPrep: false,
  frameworkName: 'SSBJ',
  coverageNote: null,
  projectName: '（架空）試験プロジェクト',
  reportingEntity: '（架空）試験株式会社',
  periodStart: '2026-04-01',
  periodEnd: '2027-03-31',
  scopeRevision: 0,
  requirementState: null,
};

function snapshot(blocks: SnapshotBlock[]): ReportSnapshotDetail {
  return {
    id: 's-1',
    organizationId: 'o-1',
    projectId: 'proj-1',
    snapshotKind: 'approved',
    snapshotNo: 1,
    label: '社内承認済み',
    frameworkVersions: [framework],
    decisionIds: [],
    blocks,
    metricValues: [metricValue],
    narrativeVersionIds: [],
    anchors: [],
    policyVersion: null,
    contentHash: 'snapshot-hash',
    createdAt: '2027-05-01T00:00:00.000Z',
    createdBy: 'u-x',
  };
}

function mapping(overrides: Partial<XbrlTagMapping>): XbrlTagMapping {
  return {
    id: 'map-1',
    organizationId: 'o-1',
    projectId: 'proj-1',
    packageId: 'pkg-1',
    conceptId: 'c-SampleScope1GhgEmissions',
    targetKind: 'metric',
    metricId: 'm-1',
    unitId: 'u-1',
    boundary: '連結',
    frameworkVersionId: null,
    sectionKey: null,
    disclosureItemId: null,
    dimensions: { SampleGhgBoundaryAxis: 'SampleFinancialControlMember' },
    periodRole: 'current',
    decimals: 1,
    scale: 0,
    status: 'confirmed',
    excludedReason: '',
    origin: 'human',
    aiRunId: null,
    confirmedBy: 'u-approver',
    confirmedAt: '2027-04-20T00:00:00.000Z',
    createdAt: '2027-04-19T00:00:00.000Z',
    updatedAt: '2027-04-20T00:00:00.000Z',
    createdBy: 'u-author',
    updatedBy: 'u-approver',
    deletedAt: null,
    ...overrides,
  };
}

function scenario(text = '取締役会は年 1 回報告を受け、Scope1 は ') {
  const snap = snapshot([
    block({
      body: {
        paragraphs: [
          {
            id: 'p-1',
            kind: 'paragraph',
            children: [
              { t: 'text', text },
              {
                t: 'metric',
                dataPointId: 'dp-1',
                dataPointVersionId: 'dpv-1',
                display: '1,352.1 t-CO2e',
              },
              { t: 'text', text: ' でした。' },
            ],
          },
        ],
      },
    }),
  ]);
  const input: FactBuildInput = {
    snapshot: snap,
    frameworkVersionId: 'fv-1',
    pkg: PKG,
    mappings: [
      mapping({}),
      mapping({
        id: 'map-2',
        conceptId: 'c-SampleGovernanceTextBlock',
        targetKind: 'block',
        metricId: null,
        unitId: null,
        boundary: null,
        frameworkVersionId: 'fv-1',
        sectionKey: 'governance',
        dimensions: {},
        decimals: null,
      }),
    ],
    entity: {
      scheme: 'sample',
      schemeUri: SAMPLE_ENTITY_SCHEME_URI,
      value: 'SAMPLE-TEST-1',
      isSample: true,
    },
  };
  const built = buildFacts(input);
  const validation = validateXbrl(input, built);
  const setHash = mappingSetHash(built.confirmedMappings, built.entity);
  const meta = {
    snapshotNo: 1,
    snapshotLabel: '社内承認済み',
    snapshotContentHash: snap.contentHash,
    mappingSetHash: setHash,
    contentHash: xbrlContentHash({
      snapshotContentHash: snap.contentHash,
      mappingSetHash: setHash,
      packageKey: PKG.key,
    }),
  };
  return { snap, input, built, validation, meta };
}

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** 生成器の版 → xBRL-JSON の指紋 */
const FINGERPRINTS: Record<string, string> = {
  't4d-xbrl-stage1-v1': 'b660d9a193cda92c31a71014e6d366e47802a9b78a77b6a2da58359db593a079',
};

describe('xBRL-JSON', () => {
  it('生成器の版と組で指紋を固定する', () => {
    const { built, meta } = scenario();
    const json = buildXbrlJson(built, PKG, meta);
    expect(FINGERPRINTS[XBRL_GENERATOR_VERSION]).toBe(sha(json));
  });

  it('OIM の形（documentType・事実の次元・数値の decimals）と、提出用ではない注記', () => {
    const { built, meta } = scenario();
    const doc = JSON.parse(buildXbrlJson(built, PKG, meta)) as {
      documentInfo: Record<string, unknown>;
      facts: Record<
        string,
        { value: string; decimals?: number; dimensions: Record<string, string> }
      >;
    };
    expect(doc.documentInfo.documentType).toBe('https://xbrl.org/2021/xbrl-json');
    expect(String(doc.documentInfo['t4d:notice'])).toContain('提出用ではありません');
    const facts = Object.values(doc.facts);
    const numeric = facts.find((f) => f.dimensions.concept === 't4ds:SampleScope1GhgEmissions')!;
    expect(numeric).toEqual({
      value: '1352.1',
      decimals: 1,
      dimensions: {
        concept: 't4ds:SampleScope1GhgEmissions',
        entity: 't4d-entity:SAMPLE-TEST-1',
        period: '2026-04-01T00:00:00/2027-04-01T00:00:00',
        unit: 'utr:tCO2e',
        't4ds:SampleGhgBoundaryAxis': 't4ds:SampleFinancialControlMember',
      },
    });
    const text = facts.find((f) => f.dimensions.concept === 't4ds:SampleGovernanceTextBlock')!;
    expect(text.decimals).toBeUndefined();
    expect(text.value).toBe(
      '<p>取締役会は年 1 回報告を受け、Scope1 は 1,352.1 t-CO2e でした。</p>',
    );
  });

  it('対応付け集合のハッシュは確定した行と識別子だけで決まり、内容ハッシュは生成器の版を含む', () => {
    const { built } = scenario();
    const base = mappingSetHash(built.confirmedMappings, built.entity);
    expect(mappingSetHash([...built.confirmedMappings].reverse(), built.entity)).toBe(base);
    expect(
      mappingSetHash(built.confirmedMappings, { scheme: 'sample', value: 'SAMPLE-OTHER' }),
    ).not.toBe(base);
    const candidate = mapping({ id: 'map-3', status: 'candidate' });
    expect(mappingSetHash([...built.confirmedMappings, candidate], built.entity)).toBe(base);
    const a = xbrlContentHash({ snapshotContentHash: 'x', mappingSetHash: base, packageKey: 'k' });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(
      xbrlContentHash({ snapshotContentHash: 'y', mappingSetHash: base, packageKey: 'k' }),
    ).not.toBe(a);
  });

  it('照合表は数式として解釈される文字を無害化する', () => {
    const { built } = scenario();
    const csv = buildTraceCsv(built);
    expect(csv.startsWith('﻿事実 ID')).toBe(true);
    expect(csv).toContain('気候-10');
  });
});

describe('インライン XBRL のプレビュー', () => {
  it('先頭に「提出用ではありません」の帯があり、数値は節のテキストブロックの中に入れ子', () => {
    const { built, snap, meta, validation } = scenario();
    const html = buildIxbrlPreview({ result: built, pkg: PKG, snapshot: snap, meta, validation });
    expect(html.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    const banner = html.indexOf('提出用ではありません');
    expect(banner).toBeGreaterThan(0);
    expect(banner).toBeLessThan(html.indexOf('<ix:header>'));
    expect(html).toContain('（架空）');
    const textBlock = html.indexOf('<ix:nonNumeric');
    const nested = html.indexOf('<ix:nonFraction');
    expect(textBlock).toBeGreaterThan(0);
    expect(nested).toBeGreaterThan(textBlock);
    expect(nested).toBeLessThan(html.indexOf('</ix:nonNumeric>'));
    expect(html).toMatch(
      /<ix:nonFraction[^>]*decimals="1"[^>]*scale="0"[^>]*>1,352\.1<\/ix:nonFraction>/,
    );
    expect(html).toContain(
      '<xbrli:identifier scheme="urn:t4d:sample-entity">SAMPLE-TEST-1</xbrli:identifier>',
    );
  });

  it('本文・節名・指標名の <script> や引用符は要素・属性にならない（エスケープ）', () => {
    const attack = '<script>alert(1)</script>"><img src=x onerror=alert(2)>';
    const { built, snap, meta, validation } = scenario(attack);
    snap.blocks[0]!.title = '<script>alert(3)</script>';
    const html = buildIxbrlPreview({ result: built, pkg: PKG, snapshot: snap, meta, validation });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&gt;&lt;img');
    expect(html).toContain('&lt;script&gt;alert(3)&lt;/script&gt;');
    // 指標名の < > も同じ
    expect(html).toContain('Scope1 &lt;排出量&gt;');
    // テキストブロックの値（xBRL-JSON 側）もエスケープ済みの断片
    const textFact = built.facts.find((f) => !f.numeric)!;
    expect(textFact.value).not.toMatch(/<script/i);
  });
});
