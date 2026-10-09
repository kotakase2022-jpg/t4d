import { describe, expect, it } from 'vitest';
import {
  approvalMismatches,
  compareDocx,
  compareSheets,
  normalizeCell,
  normalizeText,
  parseCsv,
  reconciledCountsText,
  reconciliationStateOf,
  withApprovalCheck,
  type DocxExpectation,
} from '@/lib/domain/export-reconciliation';
import {
  EMPTY_EXPORT_CONTEXT,
  buildMetricCsv,
  docxExpectation,
  metricCsvExpectation,
  outputParagraphText,
} from '@/lib/exports/disclosure-report';
import type {
  ReportSnapshotDetail,
  SnapshotBlock,
  SnapshotFramework,
  SnapshotMetricValue,
} from '@/lib/services/report-snapshot';

/**
 * 出力の自動突合の照合規則（トライアル対応 NF-15。unit:export-reconciliation）。
 * 期待値は出力と同じ描画から作る（対外用の伏せ字・数式の無害化をそのまま通す）。
 */

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
  ...overrides,
});

const framework: SnapshotFramework = {
  frameworkVersionId: 'fv-ssbj',
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
};

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
          { t: 'text', text: '。社外秘の取締役会資料.pdf による。' },
          { t: 'cite', sourceAnchorId: 'a-1' },
        ],
      },
    ],
  },
  contentHash: 'h',
  frameworkVersionId: 'fv-ssbj',
  sortOrder: 1,
  versionNo: 1,
  versionCreatedBy: 'u',
  versionCreatedAt: '2026-08-01T00:00:00.000Z',
  approvedVersionId: 'bv-1',
  isApprovedVersion: true,
  requirements: [{ itemId: 'i-1', code: '気候-47(1)', section: '気候', text: '指標' }],
  issues: [],
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
  frameworkVersions: [framework],
  decisionIds: ['d-1'],
  blocks: [block],
  metricValues: [metric()],
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

/** 期待値どおりに読み戻した段落の並び（表紙などの前置きを含む） */
function paragraphsOf(expectation: DocxExpectation): string[] {
  const out = ['FY2026 統合開示', '開示原稿 — SSBJ 2026', '報告主体', '架空株式会社'];
  for (const b of expectation.blocks) {
    out.push(b.title);
    if (b.marker) out.push(b.marker);
    out.push(...b.paragraphs.map((p) => p.text));
  }
  for (const table of [expectation.numberTable, expectation.traceTable]) {
    if (!table) continue;
    out.push(table.heading, ...table.header);
    for (const row of table.rows) out.push(...row.cells.filter((c) => c.trim() !== ''));
  }
  return out;
}

describe('正規化', () => {
  it('空白（改行・連続する空白）だけを正規化し、それ以外の文字は変えない', () => {
    expect(normalizeText('  a\n b\t\tc  ')).toBe('a b c');
    expect(normalizeText('１，２３４')).toBe('１，２３４');
    expect(normalizeCell(null)).toBe('');
    expect(normalizeCell(1240.5)).toBe('1240.5');
  });
});

describe('DOCX の照合', () => {
  // 対外用で伏せる名前は、サービスと同じくスナップショットに固定した一覧を渡す
  const external = docxExpectation(
    snapshot,
    {
      audience: 'external',
      frameworkVersionId: 'fv-ssbj',
      nonPublicFileNames: block.maskedFileNames ?? [],
    },
    EMPTY_EXPORT_CONTEXT,
  );
  const internal = docxExpectation(
    snapshot,
    { audience: 'internal', frameworkVersionId: 'fv-ssbj', nonPublicFileNames: [] },
    EMPTY_EXPORT_CONTEXT,
  );

  it('対外用の期待値は非公開資料の名前を伏せ、追跡番号を本文に付けない（追跡表も無い）', () => {
    const text = external.blocks[0]!.paragraphs[0]!.text;
    expect(text).toContain('社内資料');
    expect(text).not.toContain('社外秘の取締役会資料.pdf');
    expect(text).not.toMatch(/［T-/);
    expect(external.traceTable).toBeNull();
    // 社内確認用は段落末に追跡番号、巻末に追跡表
    expect(internal.blocks[0]!.paragraphs[0]!.text).toMatch(/ ［T-M-1］$/);
    expect(internal.traceTable?.rows.length).toBeGreaterThan(0);
  });

  it('期待どおりなら不一致 0 件で、段落・数値・行を数える', () => {
    const result = compareDocx(internal, paragraphsOf(internal));
    expect(result.mismatchCount).toBe(0);
    expect(result.paragraphs).toBe(1);
    expect(result.numbers).toBe(1);
    expect(result.rows).toBe(internal.traceTable!.rows.length);
  });

  it('段落を 1 文字変えると、位置（節・段落）付きで 1 件の不一致になる', () => {
    const paragraphs = paragraphsOf(external);
    const index = paragraphs.indexOf(external.blocks[0]!.paragraphs[0]!.text);
    paragraphs[index] = paragraphs[index]!.replace('当期', '前期');
    const result = compareDocx(external, paragraphs);
    expect(result.mismatchCount).toBe(1);
    expect(result.mismatches[0]).toMatchObject({ kind: 'paragraph' });
    expect(result.mismatches[0]!.location).toContain('指標及び目標 段落 1');
    expect(result.mismatches[0]!.actual).toContain('前期');
  });

  it('付表の数値の違い・節の欠落・余分な段落も見つける', () => {
    const changedValue = paragraphsOf(external).map((p) =>
      p === '1,352.1 t-CO2e' ? '1,352.2 t-CO2e' : p,
    );
    const numberResult = compareDocx(external, changedValue);
    expect(numberResult.mismatches.map((m) => m.kind)).toEqual(['number']);

    const missing = compareDocx(
      external,
      paragraphsOf(external).filter((p) => p !== '指標及び目標'),
    );
    expect(missing.mismatches.some((m) => m.kind === 'missing')).toBe(true);

    const extra = paragraphsOf(external);
    extra.splice(extra.indexOf('指標及び目標') + 1, 0, '外部で足した段落');
    const extraResult = compareDocx(external, extra);
    expect(extraResult.mismatches.map((m) => m.kind)).toEqual(['extra']);
  });

  it('社内確認用の段落と追跡番号の文字列は出力と同じ関数で作る', () => {
    expect(
      outputParagraphText(
        { paragraphId: 'p', kind: 'paragraph', text: '本文', traceId: 'T-G-1' },
        'internal',
      ),
    ).toBe('本文 ［T-G-1］');
  });
});

describe('表計算・CSV の照合', () => {
  it('セル単位で照合し、位置（シート!列行）を返す。足りない・余分な行・シートの欠落も数える', () => {
    const expected = [
      {
        name: '数値',
        header: ['指標', '値'],
        rows: [
          { kind: 'number' as const, cells: ['Scope1', 1240.5] },
          { kind: 'number' as const, cells: ['Scope2', 800] },
        ],
      },
    ];
    const ok = compareSheets(
      expected,
      new Map([
        [
          '数値',
          [
            ['指標', '値'],
            ['Scope1', 1240.5],
            ['Scope2', 800],
          ],
        ],
      ]),
    );
    expect(ok.mismatchCount).toBe(0);
    expect(ok.numbers).toBe(2);

    const changed = compareSheets(
      expected,
      new Map([
        [
          '数値',
          [
            ['指標', '値'],
            ['Scope1', 1240.6],
            ['Scope2', 800],
            ['余分', 1],
          ],
        ],
      ]),
    );
    expect(changed.mismatches.map((m) => [m.kind, m.location])).toEqual([
      ['number', '数値!B2'],
      ['extra', '数値!4 行目以降'],
    ]);

    const noSheet = compareSheets(expected, new Map());
    expect(noSheet.mismatches.map((m) => m.kind)).toEqual(['missing']);
  });

  it('CSV は書き出しと同じ数式の無害化を通した値で照合する（読み戻して 0 件）', () => {
    const tricky: ReportSnapshotDetail = {
      ...snapshot,
      metricValues: [metric({ metricName: '+SUM(1,2)', unitName: '本社, "東"', boundary: '=x' })],
    };
    for (const audience of ['internal', 'external'] as const) {
      const csv = buildMetricCsv(tricky, audience);
      const rows = parseCsv(csv);
      expect(rows[1]).toContain(`'+SUM(1,2)`);
      expect(rows[1]).toContain('本社, "東"');
      const expectation = metricCsvExpectation(tricky, audience);
      const result = compareSheets([expectation], new Map([['CSV', rows]]));
      expect(result.mismatchCount).toBe(0);
      expect(result.numbers).toBe(1);
    }
  });

  it('CSV の読み取り: BOM・引用符・改行・末尾の空行', () => {
    expect(parseCsv('﻿a,b\r\n"x,1","y\r\nz"\r\n"q""q",\r\n')).toEqual([
      ['a', 'b'],
      ['x,1', 'y\r\nz'],
      ['q"q', ''],
    ]);
  });
});

describe('承認の照合と表示', () => {
  it('承認済みスナップショットの未承認の節・数値は不一致に数える。草稿は照合しない', () => {
    expect(approvalMismatches(snapshot, 'fv-ssbj')).toEqual([]);
    const broken: ReportSnapshotDetail = {
      ...snapshot,
      blocks: [{ ...block, isApprovedVersion: false }],
      metricValues: [metric({ versionApproved: false })],
    };
    expect(approvalMismatches(broken, 'fv-ssbj').map((m) => m.kind)).toEqual([
      'approval',
      'approval',
    ]);
    expect(approvalMismatches({ ...broken, snapshotKind: 'review_draft' }, null)).toEqual([]);
    const merged = withApprovalCheck(
      { paragraphs: 1, numbers: 1, rows: 0, mismatchCount: 0, mismatches: [] },
      approvalMismatches(broken, null),
    );
    expect(merged.mismatchCount).toBe(2);
  });

  it('出力の記録の突合の状態と件数の言い方', () => {
    expect(reconciliationStateOf({ mismatchCount: null, checkerVersion: null })).toBe(
      'not_reconciled',
    );
    expect(reconciliationStateOf({ mismatchCount: 0, checkerVersion: 'v' })).toBe('matched');
    expect(reconciliationStateOf({ mismatchCount: 2, checkerVersion: 'v' })).toBe('mismatched');
    expect(reconciledCountsText({ paragraphs: 12, numbers: 4, rows: 0 })).toBe('段落 12・数値 4');
    expect(reconciledCountsText({ paragraphs: 0, numbers: 0, rows: 0 })).toBe('照合対象なし');
  });
});
