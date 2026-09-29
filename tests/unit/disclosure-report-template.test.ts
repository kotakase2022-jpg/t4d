import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DISCLOSURE_REPORT_TEMPLATE_VERSION,
  coverRows,
  externalMaskedNames,
  issueDisplay,
  metricDisplay,
  renderBlockParagraphs,
  statusLine,
} from '@/lib/exports/disclosure-report';
import type {
  ReportSnapshotDetail,
  SnapshotBlock,
  SnapshotFramework,
  SnapshotMetricValue,
} from '@/lib/services/report-snapshot';

/**
 * F7（自己監査 第 3 回）: 同じスナップショットから描く本文・表紙が変わったのに、描画の版
 * （DISCLOSURE_REPORT_TEMPLATE_VERSION）が同じままだと、同じ内容ハッシュ・同じテンプレート版の出力が
 * 違う本文になり、違いを説明できない（§6.10・§10.3）。
 *
 * 代表的なスナップショットの描画結果の指紋を、描画の版と組で固定する。描画を変えてこのテストが落ちたら、
 * 版を上げてから指紋を更新する（指紋だけを更新しない）。
 */

const metric = (overrides: Partial<SnapshotMetricValue>): SnapshotMetricValue => ({
  dataPointId: 'dp-1',
  dataPointVersionId: 'dpv-1',
  metricId: 'm-1',
  value: 1352.1,
  textValue: null,
  unitOfMeasure: 't-CO2e',
  reportingPeriodId: 'p-1',
  boundary: 'consolidated',
  status: 'approved',
  valueKind: 'actual',
  availabilityStatus: 'value_present',
  versionNo: 1,
  metricCode: 'scope1',
  metricName: 'Scope1 排出量',
  unitId: 'u-1',
  unitName: '本社',
  periodCode: 'FY2026',
  periodStart: '2026-04-01',
  periodEnd: '2027-03-31',
  versionApproved: true,
  changeReason: null,
  absenceReason: null,
  ...overrides,
});

const framework = (overrides: Partial<SnapshotFramework>): SnapshotFramework => ({
  frameworkVersionId: 'fv-1',
  frameworkKey: 'ssbj',
  label: 'SSBJ 2026',
  versionCode: '2026',
  legalStatus: 'effective',
  coverageStatus: 'full_for_scope',
  applicabilityStatus: 'applicable',
  decisionId: 'd-1',
  purpose: 'ssbj_voluntary',
  draftStandardPrep: false,
  frameworkName: 'SSBJ',
  coverageNote: null,
  projectName: 'FY2026 統合開示',
  reportingEntity: '架空株式会社',
  periodStart: '2026-04-01',
  periodEnd: '2027-03-31',
  scopeRevision: 0,
  ...overrides,
});

const block: SnapshotBlock = {
  blockId: 'b-1',
  versionId: 'bv-1',
  sectionKey: 'metrics',
  title: '指標及び目標',
  language: 'ja',
  status: 'approved',
  body: {
    paragraphs: [
      {
        id: 'p-1',
        kind: 'paragraph',
        children: [
          { t: 'text', text: '当期の Scope1 排出量は ' },
          { t: 'metric', dataPointId: 'dp-1', dataPointVersionId: 'dpv-1', display: '' },
          { t: 'text', text: '、推計の Scope3 は ' },
          { t: 'metric', dataPointId: 'dp-2', dataPointVersionId: 'dpv-2', display: '' },
          { t: 'text', text: '、2030 年の目標は ' },
          { t: 'metric', dataPointId: 'dp-3', dataPointVersionId: 'dpv-3', display: '' },
          { t: 'text', text: '。社外秘の取締役会資料.pdf による。' },
          { t: 'cite', sourceAnchorId: 'a-1' },
        ],
      },
    ],
  },
  contentHash: 'h',
  frameworkVersionId: 'fv-1',
  sortOrder: 1,
  versionNo: 1,
  versionCreatedBy: 'u',
  versionCreatedAt: '2026-08-01T00:00:00.000Z',
  approvedVersionId: 'bv-1',
  isApprovedVersion: true,
  requirements: [],
  issues: [
    { code: 'metric_not_actual', message: '推計の数値を引用しています。' },
    { code: 'not_approved', message: '未承認' },
  ],
  internalComments: [],
  maskedFileNames: ['社外秘の取締役会資料.pdf'],
};

const snapshot: ReportSnapshotDetail = {
  id: 's-1',
  organizationId: 'o-1',
  projectId: 'pr-1',
  snapshotKind: 'approved',
  snapshotNo: 1,
  label: '社内承認済み版',
  frameworkVersions: [
    framework({}),
    framework({
      frameworkVersionId: 'fv-2',
      frameworkKey: 'esrs_40a',
      label: 'ESRS-40a 公開草案',
      legalStatus: 'draft',
      coverageStatus: 'not_loaded',
      applicabilityStatus: 'candidate',
      draftStandardPrep: true,
    }),
  ],
  decisionIds: ['d-1'],
  blocks: [block],
  metricValues: [
    metric({}),
    metric({
      dataPointId: 'dp-2',
      dataPointVersionId: 'dpv-2',
      valueKind: 'estimate',
      value: 48000,
    }),
    metric({ dataPointId: 'dp-3', dataPointVersionId: 'dpv-3', valueKind: 'target', value: 800 }),
  ],
  narrativeVersionIds: [],
  anchors: [
    {
      sourceAnchorId: 'a-1',
      fileVersionId: 'fv',
      anchorKind: 'manual_excerpt',
      page: 3,
      locator: null,
      quoteText: '引用',
      usagePurpose: 'current_fact',
      fileId: 'f-1',
      fileName: '委員会議事録.pdf',
      fileVersionNo: 1,
      confidentiality: 'confidential',
      editionLabel: null,
    },
  ],
  policyVersion: 'sod-3role-v1',
  contentHash: 'c'.repeat(64),
  createdAt: '2026-08-14T01:00:00.000Z',
  createdBy: 'u',
};

function renderAll(): unknown {
  const masked = externalMaskedNames(snapshot, block.maskedFileNames ?? []);
  return snapshot.frameworkVersions.map((f) => ({
    cover: {
      internal: coverRows(snapshot, f, 'internal'),
      external: coverRows(snapshot, f, 'external'),
    },
    status: statusLine(snapshot, f),
    body: {
      internal: renderBlockParagraphs(block, snapshot, 'internal', masked),
      external: renderBlockParagraphs(block, snapshot, 'external', masked),
    },
    issues: block.issues.map((i) => [issueDisplay(i, 'internal'), issueDisplay(i, 'external')]),
    metrics: snapshot.metricValues.map((m) => [
      metricDisplay(m),
      metricDisplay(m, { withKind: false }),
    ]),
  }));
}

describe('F7 描画の版と描画結果の指紋', () => {
  it('描画を変えたら DISCLOSURE_REPORT_TEMPLATE_VERSION を上げる', () => {
    const fingerprint = createHash('sha256').update(JSON.stringify(renderAll())).digest('hex');
    expect({ version: DISCLOSURE_REPORT_TEMPLATE_VERSION, fingerprint }).toEqual({
      version: 'disclosure-report-v2',
      fingerprint: '21d6012f1320d2eaa0fb12a2a9bb3ad651751c7744c6804dad42b75a92801d1f',
    });
  });

  it('v2 の描画: 草案は「公開草案に基づく準備」、推計・目標に区分、非公開資料名を伏せる', () => {
    const rendered = renderAll() as Array<{
      cover: { external: Array<[string, string]> };
      body: { external: Array<{ text: string }>; internal: Array<{ text: string }> };
    }>;
    const draftCover = Object.fromEntries(rendered[1]!.cover.external);
    expect(draftCover['基準の位置付け']).toContain('公開草案');
    const externalBody = rendered[0]!.body.external.map((p) => p.text).join('');
    expect(externalBody).toContain('（推計）');
    expect(externalBody).toContain('（目標）');
    expect(externalBody).not.toContain('社外秘の取締役会資料.pdf');
    expect(externalBody).toContain('［出典: 社内資料］');
    expect(rendered[0]!.body.internal.map((p) => p.text).join('')).toContain('委員会議事録.pdf');
  });
});
