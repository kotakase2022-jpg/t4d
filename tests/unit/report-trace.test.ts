import { describe, expect, it } from 'vitest';
import { buildReportTrace, findTraceUnits } from '@/lib/domain/report-trace';
import {
  EMPTY_EXPORT_CONTEXT,
  outputParagraphText,
  paragraphTraceIds,
  renderTracedParagraphs,
  snapshotTrace,
  traceBookmarkName,
  traceTableRows,
  type ReportExportContext,
} from '@/lib/exports/disclosure-report';
import type {
  ReportSnapshotDetail,
  SnapshotBlock,
  SnapshotMetricValue,
} from '@/lib/services/report-snapshot';
import { parseTraceCodes } from '@/lib/services/report-trace';

/**
 * トレースの判定規則と追跡番号（トライアル対応 NF-14。unit:report-trace）。
 * 見出しを数えない・手書きの数値は追跡できない・未承認の版は追跡できない・選定ケースで分母が変わる。
 * 出力（社内確認用の段落末・追跡表）と同じ番号を使う。
 */

const APPROVAL = {
  reviewRequestId: 'rr-1',
  reviewedBy: 'u-reviewer',
  approvedBy: 'u-approver',
  approvedAt: '2026-08-01T00:00:00.000Z',
};

const metric = (overrides: Partial<SnapshotMetricValue> = {}): SnapshotMetricValue => ({
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
  evidenceFileVersionIds: ['fv-1'],
  ...overrides,
});

function block(overrides: Partial<SnapshotBlock>): SnapshotBlock {
  return {
    blockId: 'b-gov',
    versionId: 'bv-gov',
    sectionKey: 'governance',
    title: 'ガバナンス',
    language: 'ja',
    status: 'approved',
    body: { paragraphs: [] },
    contentHash: 'h',
    frameworkVersionId: 'fv-ssbj',
    sortOrder: 1,
    versionNo: 2,
    versionCreatedBy: 'u-author',
    versionCreatedAt: '2026-07-01T00:00:00.000Z',
    approvedVersionId: 'bv-gov',
    isApprovedVersion: true,
    requirements: [{ itemId: 'i-10', code: '気候-10', section: '気候', text: 'ガバナンス' }],
    issues: [],
    internalComments: [],
    maskedFileNames: [],
    approval: APPROVAL,
    ...overrides,
  };
}

const governance = block({
  body: {
    paragraphs: [
      // 節名と同じ見出しは出力にも出さず、追跡の単位にも数えない
      { id: 'h1', kind: 'heading', children: [{ t: 'text', text: 'ガバナンス' }] },
      {
        id: 'g1',
        kind: 'paragraph',
        children: [
          { t: 'text', text: '取締役会が監督する。' },
          { t: 'cite', sourceAnchorId: 'a-1' },
        ],
      },
      // 空の段落は数えない
      { id: 'g-empty', kind: 'paragraph', children: [{ t: 'text', text: '   ' }] },
      { id: 'g2', kind: 'paragraph', children: [{ t: 'text', text: '根拠の無い段落。' }] },
    ],
  },
});

const metrics = block({
  blockId: 'b-met',
  versionId: 'bv-met',
  sectionKey: 'metrics_targets',
  title: '指標及び目標',
  sortOrder: 2,
  approvedVersionId: 'bv-met',
  requirements: [{ itemId: 'i-47', code: '気候-47(1)', section: '気候', text: '指標' }],
  body: {
    paragraphs: [
      {
        id: 'm1',
        kind: 'paragraph',
        children: [
          { t: 'text', text: 'Scope1 は ' },
          {
            t: 'metric',
            dataPointId: 'dp-1',
            dataPointVersionId: 'dpv-1',
            display: '1,352.1 t-CO2e',
          },
          { t: 'text', text: '、別に手で書いた 1,234 t-CO2e がある。' },
        ],
      },
    ],
  },
});

/** 未承認の版を固定した節（草稿） */
const draftBlock = block({
  blockId: 'b-risk',
  versionId: 'bv-risk-3',
  sectionKey: 'risk_opportunity',
  title: 'リスク及び機会',
  sortOrder: 3,
  status: 'draft',
  approvedVersionId: 'bv-risk-2',
  isApprovedVersion: false,
  approval: null,
  requirements: [{ itemId: 'i-19', code: '気候-19', section: '気候', text: 'リスク' }],
  body: {
    paragraphs: [
      {
        id: 'r1',
        kind: 'paragraph',
        children: [
          { t: 'cite', sourceAnchorId: 'a-1' },
          { t: 'text', text: '物理的リスク。' },
        ],
      },
    ],
  },
});

const snapshot: ReportSnapshotDetail = {
  id: 's-1',
  organizationId: 'o-1',
  projectId: 'pr-1',
  snapshotKind: 'review_draft',
  snapshotNo: 1,
  label: 'レビュー用草稿',
  frameworkVersions: [],
  decisionIds: [],
  blocks: [governance, metrics, draftBlock],
  metricValues: [metric()],
  narrativeVersionIds: [],
  anchors: [
    {
      sourceAnchorId: 'a-1',
      fileVersionId: 'fv-1',
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
  policyVersion: null,
  contentHash: 'c'.repeat(64),
  createdAt: '2026-08-14T01:00:00.000Z',
  createdBy: 'u-author',
};

const context: ReportExportContext = {
  ...EMPTY_EXPORT_CONTEXT,
  userNames: new Map([['u-approver', '承 花子']]),
  fileVersions: new Map([
    [
      'fv-1',
      {
        fileId: 'f-1',
        fileName: '委員会議事録.pdf',
        versionNo: 1,
        confidentiality: 'confidential',
      },
    ],
  ]),
};

function traceOf(selectedCodes?: string[]) {
  return buildReportTrace(
    {
      blocks: snapshot.blocks,
      metricValues: snapshot.metricValues,
      narrativeVersionsWithEvidence: new Set(),
    },
    { selectedCodes },
  );
}

describe('トレースの判定（写しだけから）', () => {
  it('見出し・空の段落を数えず、本文のある段落と数値（参照と手書き）を数える', () => {
    const { units, summary } = traceOf();
    const paragraphs = units.filter((u) => u.kind === 'paragraph');
    expect(paragraphs.map((u) => u.paragraphId)).toEqual(['g1', 'g2', 'm1', 'r1']);
    // 数値: 参照 1・手書き 1
    expect(units.filter((u) => u.kind === 'number')).toHaveLength(2);
    expect(summary.paragraphs.total).toBe(4);
    expect(summary.numbers.total).toBe(2);
    expect(summary.label).toBe(
      `${summary.all.traceable} / 6（段落 ${summary.paragraphs.traceable} / 4・数値 ${summary.numbers.traceable} / 2）`,
    );
  });

  it('根拠の無い段落・手書きの数値・未承認の版は追跡できず、理由を返す', () => {
    const { units } = traceOf();
    const byId = new Map(units.map((u) => [u.traceId, u]));
    expect(byId.get('T-G-1')?.traceable).toBe(true);
    expect(byId.get('T-G-2')?.reasons).toEqual(['no_evidence']);
    expect(byId.get('T-MT-1-N1')?.traceable).toBe(true);
    expect(byId.get('T-MT-1-N2')?.reasons).toEqual(['handwritten']);
    expect(byId.get('T-RO-1')?.reasons).toContain('not_approved');
    // 承認者・日時は写しの承認の記録から出す（未承認の版には無い）
    expect(byId.get('T-G-1')?.approvedBy).toBe('u-approver');
    expect(byId.get('T-RO-1')?.approvedBy).toBeNull();
  });

  it('選定ケース（要求事項コード）で分母が変わる。どの節にも当たらなければ追跡率は出さない', () => {
    expect(traceOf(['気候-47(1)']).summary.all.total).toBe(3);
    expect(traceOf(['気候-10', '気候-19']).summary.all.total).toBe(3);
    const none = traceOf(['存在しない']);
    expect(none.summary.all.total).toBe(0);
    expect(none.summary.rate).toBeNull();
  });

  it('追跡番号・本文の文字列・数値の表示から探せる', () => {
    const { units } = traceOf();
    expect(findTraceUnits(units, 'T-G-2').map((u) => u.traceId)).toEqual(['T-G-2']);
    expect(findTraceUnits(units, '根拠の無い').map((u) => u.traceId)).toEqual(['T-G-2']);
  });
});

describe('出力の追跡番号（DOCX・XLSX と同じ番号）', () => {
  it('社内確認用は段落末に追跡番号を付け、対外用は本文を変えない', () => {
    const trace = snapshotTrace(snapshot, context);
    const ids = paragraphTraceIds(trace.units);
    const internal = renderTracedParagraphs(governance, snapshot, 'internal', [], ids);
    const external = renderTracedParagraphs(governance, snapshot, 'external', [], ids);
    expect(internal.map((p) => outputParagraphText(p, 'internal'))).toEqual([
      '取締役会が監督する。［出典: 委員会議事録.pdf 版1 p.3］ ［T-G-1］',
      '根拠の無い段落。 ［T-G-2］',
    ]);
    expect(external.map((p) => outputParagraphText(p, 'external'))).toEqual([
      '取締役会が監督する。［出典: 社内資料］',
      '根拠の無い段落。',
    ]);
    // Word のブックマーク名は英字で始まり、英数字と _ だけ
    expect(traceBookmarkName('T-MT-1-N2')).toBe('T_MT_1_N2');
  });

  it('追跡表は空のセルを作らず、承認者の名前・根拠・理由を出す', () => {
    const trace = snapshotTrace(snapshot, context);
    const rows = traceTableRows(snapshot, trace.units, context);
    expect(rows).toHaveLength(trace.units.length);
    for (const row of rows) {
      expect(row).toHaveLength(11);
      for (const cell of row) expect(cell.trim()).not.toBe('');
    }
    const g1 = rows.find((r) => r[0] === 'T-G-1')!;
    expect(g1[5]).toBe('承 花子');
    expect(g1[7]).toContain('委員会議事録.pdf');
    expect(g1[9]).toBe('追跡できる');
    const hand = rows.find((r) => r[0] === 'T-MT-1-N2')!;
    expect(hand[8]).toContain('参照なし');
    expect(hand[10]).toContain('直接書いた数値');
  });
});

describe('選定ケースの指定（URL の codes）', () => {
  it('カンマ・読点・空白で区切り、重複と空を除く', () => {
    expect(parseTraceCodes('気候-10, 気候-11、気候-10  40A-S01')).toEqual([
      '気候-10',
      '気候-11',
      '40A-S01',
    ]);
    expect(parseTraceCodes('')).toBeNull();
    expect(parseTraceCodes(null)).toBeNull();
  });
});
