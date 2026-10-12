import { describe, expect, it } from 'vitest';
import { diffSnapshots } from '@/lib/domain/snapshot-diff';
import type {
  ReportSnapshotDetail,
  SnapshotBlock,
  SnapshotFramework,
  SnapshotMetricValue,
} from '@/lib/services/report-snapshot';

/**
 * 承認版どうしの差分（トライアル対応 NF-13。unit:snapshot-diff）。
 * 写し（スナップショット）だけから、段落の文字差分・数値の版と値・要求事項の付け替え・判断の変更を出す。
 */

const metric = (overrides: Partial<SnapshotMetricValue> = {}): SnapshotMetricValue => ({
  dataPointId: 'dp-1',
  dataPointVersionId: 'dpv-1',
  metricId: 'm-1',
  value: 1240.5,
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
  periodCode: 'FY2025',
  periodStart: '2025-04-01',
  periodEnd: '2026-03-31',
  versionApproved: true,
  changeReason: null,
  absenceReason: null,
  ...overrides,
});

const framework = (overrides: Partial<SnapshotFramework> = {}): SnapshotFramework => ({
  frameworkVersionId: 'fv-ssbj',
  frameworkKey: 'ssbj',
  label: 'SSBJ 2025',
  versionCode: '2025',
  legalStatus: 'effective',
  coverageStatus: 'full_for_scope',
  applicabilityStatus: 'applicable',
  decisionId: 'd-1',
  purpose: 'ssbj_voluntary',
  draftStandardPrep: false,
  frameworkName: 'SSBJ',
  coverageNote: null,
  projectName: 'FY2025',
  reportingEntity: '架空株式会社',
  periodStart: '2025-04-01',
  periodEnd: '2026-03-31',
  scopeRevision: 0,
  requirementState: {
    assessmentEventIds: [],
    exclusionEventIds: ['e-1'],
    assessmentDigest: 'a'.repeat(16),
  },
  ...overrides,
});

const block = (overrides: Partial<SnapshotBlock> = {}): SnapshotBlock => ({
  blockId: 'b-gov',
  versionId: 'bv-1',
  sectionKey: 'governance',
  title: 'ガバナンス',
  language: 'ja',
  status: 'approved',
  body: {
    paragraphs: [
      {
        id: 'g1',
        kind: 'paragraph',
        children: [{ t: 'text', text: '取締役会が年 4 回監督する。' }],
      },
      { id: 'g2', kind: 'paragraph', children: [{ t: 'text', text: '委員会を置く。' }] },
    ],
  },
  contentHash: 'h1',
  frameworkVersionId: 'fv-ssbj',
  sortOrder: 1,
  versionNo: 1,
  versionCreatedBy: 'u',
  versionCreatedAt: '2026-01-01T00:00:00.000Z',
  approvedVersionId: 'bv-1',
  isApprovedVersion: true,
  requirements: [{ itemId: 'i-10', code: '気候-10', section: '気候', text: 'ガバナンス' }],
  issues: [],
  internalComments: [],
  maskedFileNames: [],
  approval: null,
  ...overrides,
});

const snapshot = (overrides: Partial<ReportSnapshotDetail> = {}): ReportSnapshotDetail => ({
  id: 's-1',
  organizationId: 'o-1',
  projectId: 'pr-1',
  snapshotKind: 'approved',
  snapshotNo: 1,
  label: '社内承認済み版',
  frameworkVersions: [framework()],
  decisionIds: ['d-1'],
  blocks: [block()],
  metricValues: [metric()],
  narrativeVersionIds: [],
  anchors: [],
  policyVersion: null,
  contentHash: 'c'.repeat(64),
  createdAt: '2026-04-01T00:00:00.000Z',
  createdBy: 'u',
  ...overrides,
});

describe('承認版どうしの差分', () => {
  it('同じ内容なら「違いなし」', () => {
    const a = snapshot();
    const b = snapshot({ id: 's-2', snapshotNo: 2 });
    const diff = diffSnapshots(a, b);
    expect(diff.summary.identical).toBe(true);
    expect(diff.blocks.every((x) => x.kind === 'unchanged')).toBe(true);
    expect(diff.from.snapshotNo).toBe(1);
    expect(diff.to.snapshotNo).toBe(2);
    expect(diff.summary.decisionsComparable).toBe(true);
  });

  it('片方が判断の状態を固定していない（以前の形式）なら、判断は比べられないとし「違いなし」と言わない', () => {
    const v1 = snapshot({ frameworkVersions: [framework({ requirementState: undefined })] });
    const v2 = snapshot({ id: 's-2', snapshotNo: 2 });
    for (const [from, to] of [
      [v1, v2],
      [v2, v1],
    ] as const) {
      const diff = diffSnapshots(from, to);
      expect(diff.summary.decisionsComparable).toBe(false);
      expect(diff.summary.identical).toBe(false);
      // 本文・数値・要求事項の付け替えの違いは無い
      expect(diff.blocks.every((x) => x.kind === 'unchanged')).toBe(true);
      expect(diff.metrics).toEqual([]);
      expect(diff.requirements).toEqual([]);
    }
  });

  it('段落の文字差分（変更・追加・削除）を節ごとに出す', () => {
    const changed = block({
      versionId: 'bv-2',
      versionNo: 2,
      body: {
        paragraphs: [
          {
            id: 'g1',
            kind: 'paragraph',
            children: [{ t: 'text', text: '取締役会が年 6 回監督する。' }],
          },
          { id: 'g3', kind: 'paragraph', children: [{ t: 'text', text: '新しい段落。' }] },
        ],
      },
    });
    const diff = diffSnapshots(
      snapshot(),
      snapshot({ id: 's-2', snapshotNo: 2, blocks: [changed] }),
    );
    expect(diff.summary.changedBlocks).toBe(1);
    const gov = diff.blocks[0]!;
    expect(gov.kind).toBe('changed');
    expect(gov.fromVersionNo).toBe(1);
    expect(gov.toVersionNo).toBe(2);
    expect(gov.changedParagraphCount).toBe(3);
    const kinds = gov.paragraphs.map((p) => p.kind).sort();
    expect(kinds).toEqual(['added', 'changed', 'removed']);
    const edit = gov.paragraphs.find((p) => p.kind === 'changed');
    expect(edit && edit.kind === 'changed' && edit.segments.some((s) => s.op === 'insert')).toBe(
      true,
    );
  });

  it('節の追加・削除を区別する', () => {
    const extra = block({ blockId: 'b-risk', title: 'リスク及び機会', sortOrder: 2 });
    const added = diffSnapshots(snapshot(), snapshot({ id: 's-2', blocks: [block(), extra] }));
    expect(added.summary.addedBlocks).toBe(1);
    expect(added.blocks.find((b) => b.blockId === 'b-risk')?.kind).toBe('added');
    const removed = diffSnapshots(snapshot({ blocks: [block(), extra] }), snapshot({ id: 's-2' }));
    expect(removed.summary.removedBlocks).toBe(1);
    expect(removed.blocks.find((b) => b.blockId === 'b-risk')?.kind).toBe('removed');
  });

  it('数値の版と値の違い・追加・削除', () => {
    const diff = diffSnapshots(
      snapshot({
        metricValues: [metric(), metric({ dataPointId: 'dp-2', dataPointVersionId: 'dpv-2' })],
      }),
      snapshot({
        id: 's-2',
        metricValues: [
          metric({ dataPointVersionId: 'dpv-1b', versionNo: 2, value: 1300 }),
          metric({ dataPointId: 'dp-3', dataPointVersionId: 'dpv-3', metricName: '水使用量' }),
        ],
      }),
    );
    expect(diff.metrics.map((m) => [m.dataPointId, m.kind])).toEqual([
      ['dp-1', 'changed'],
      ['dp-3', 'added'],
      ['dp-2', 'removed'],
    ]);
    const scope1 = diff.metrics[0]!;
    expect(scope1.from?.value).toBe(1240.5);
    expect(scope1.to?.value).toBe(1300);
    expect(scope1.to?.versionNo).toBe(2);
  });

  it('要求事項の付け替えと判断の変更', () => {
    const diff = diffSnapshots(
      snapshot(),
      snapshot({
        id: 's-2',
        blocks: [
          block({
            requirements: [
              { itemId: 'i-11', code: '気候-11', section: '気候', text: 'リスク管理' },
            ],
          }),
        ],
        frameworkVersions: [
          framework({
            applicabilityStatus: 'not_applicable',
            decisionId: 'd-2',
            requirementState: {
              assessmentEventIds: ['pa-1'],
              exclusionEventIds: ['e-1', 'e-2'],
              assessmentDigest: 'b'.repeat(16),
            },
          }),
        ],
      }),
    );
    expect(diff.requirements).toEqual([
      { blockId: 'b-gov', title: 'ガバナンス', added: ['気候-11'], removed: ['気候-10'] },
    ]);
    expect(diff.decisions).toHaveLength(1);
    expect(diff.decisions[0]).toMatchObject({
      presence: 'both',
      applicability: { from: 'applicable', to: 'not_applicable' },
      decisionChanged: true,
      addedAssessmentEvents: 1,
      addedExclusionEvents: 1,
      assessmentDigestChanged: true,
    });
    expect(diff.summary.identical).toBe(false);
  });

  it('要求事項の状態を固定していない（v1 の）写しはダイジェストを比べない', () => {
    const v1 = framework({ requirementState: undefined });
    const diff = diffSnapshots(
      snapshot({ frameworkVersions: [v1] }),
      snapshot({ id: 's-2', frameworkVersions: [v1] }),
    );
    expect(diff.decisions).toEqual([]);
  });
});
