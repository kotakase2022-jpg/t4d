import { beforeEach, describe, expect, it } from 'vitest';
import { contentHashOf } from '@/lib/domain/disclosure-block';
import {
  computeSnapshotContentHash,
  snapshotCommentOf,
} from '@/lib/domain/report-snapshot-content';
import { ORG_IDS, PERIOD_IDS, dataPointId, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import {
  COMPACT_MARK,
  COMPACT_VERSION,
  compactRow,
  expandRow,
  rehydrateSnapshotManifest,
} from '@/lib/repositories/demo-compact';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  applyDemoEdits,
  decodeDemoEdits,
  encodeDemoEditStream,
  isPersistedTable,
  type DemoEdit,
} from '@/lib/repositories/demo-edit-codec';
import { saveBlockVersion } from '@/lib/services/disclosure-block';
import { createReviewDraftSnapshot } from '@/lib/services/report-snapshot';
import type {
  AuthorizationContext,
  BlockParagraph,
  DisclosureBlockVersion,
  NarrativeVersion,
  QuantitativeImportBatch,
  ReportSnapshot,
  ReviewComment,
  ReviewEvent,
  ReviewRequest,
  RoleKey,
  SourceAnchor,
} from '@/types/domain';

/**
 * Demo Mode の Cookie に小さくして載せる追記専用の表（demo-compact.ts）と、偽の Cookie の拒否。
 *
 * 本文の版・定性情報の版・引用位置・スナップショット・出力記録・標準 CSV の確定の控え・データの承認の記録は、
 * 別インスタンス（Vercel）でも実演の流れを続けるために Cookie で持ち回す（2026-09-30）。
 * Fixture DB はインスタンスの全利用者で共有されるため、偽の Cookie で次のものを戻させない:
 *  - 別の組織の行・権限の無い人の名義の行・既にある行の書き換え（追記専用）
 *  - 本文と食い違うハッシュ・参照（計算し直す）
 *  - 最終承認の記録の無い「承認済み」のスナップショット・承認の根拠の無い「承認済みの数値」
 */

function ctxFor(email: string, roleKeys: RoleKey[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const author = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const AUTHOR = userId('sustainability@demo.local');
const APPROVER = userId('approver@demo.local');
const REVIEWER = userId('reviewer@demo.local');
/** 開示の編集権限・出力権限・取込権限の無い利用者（拠点の入力担当は数値の入力だけ） */
const SITE_USER = userId('site-user@demo.local');
/** 別の組織（蒼天マテリアル）の管理者 */
const OTHER_ORG_ADMIN = userId('other-enterprise-admin@demo.local');
const RISK = IDS.blocks.fy2026RiskOpportunity.block;

let source: FixtureDb;

beforeEach(() => {
  source = createFixtureDb();
});

/** Cookie を往復させて（圧縮・展開）、別インスタンス（新しい Fixture）へ適用する */
function replay(edits: DemoEdit[], target: FixtureDb = createFixtureDb()): FixtureDb {
  applyDemoEdits(target, decodeDemoEdits(encodeDemoEditStream(edits)));
  return target;
}

function editOf(table: string, row: object, db: FixtureDb = source): DemoEdit {
  const v = compactRow(table, row as Record<string, unknown>, db);
  if (!v) throw new Error(`${table} は Cookie に載らない形です`);
  return { t: table, id: (row as { id: string }).id, v };
}

async function newRiskVersion(): Promise<DisclosureBlockVersion> {
  const block = source.disclosureBlocks.find((b) => b.id === RISK)!;
  const current = source.disclosureBlockVersions.find((v) => v.id === block.currentVersionId)!;
  const { version } = await saveBlockVersion(new DemoDbClient(source), author(), {
    blockId: RISK,
    baseVersionId: current.id,
    body: {
      paragraphs: [
        ...current.body.paragraphs,
        {
          id: 'added',
          kind: 'paragraph',
          children: [{ t: 'text', text: '追記した段落（テスト）' }],
        },
      ],
    },
    changeReason: '追記（テスト）',
  });
  return version;
}

describe('小さくして持ち回す表は許可リストに入っている', () => {
  it('版・引用位置・スナップショット・出力記録・確定の控え・データの承認の記録', () => {
    for (const table of [
      'narrativeVersions',
      'sourceAnchors',
      'disclosureBlockVersions',
      'reportSnapshots',
      'exportArtifacts',
      'quantitativeImportBatches',
      'approvals',
    ] as const) {
      expect(isPersistedTable(table), table).toBe(true);
    }
  });
});

describe('原稿の版（disclosure_block_versions）', () => {
  it('土台の版と同じ段落は番号だけで載せ、別インスタンスで同じ版（本文・ハッシュ・参照・出所）に戻る', async () => {
    const version = await newRiskVersion();
    const edit = editOf('disclosureBlockVersions', version);
    // 土台から引き継いだ段落は番号だけ。書き足した段落だけが本文として載る
    const paragraphs = edit.v.b as unknown[];
    expect(paragraphs.filter((p) => typeof p === 'number').length).toBe(
      version.body.paragraphs.length - 1,
    );
    expect(edit.v.plainText).toBeUndefined();
    expect(edit.v.contentHash).toBeUndefined();

    const other = replay([edit]);
    const restored = other.disclosureBlockVersions.find((v) => v.id === version.id);
    expect(restored).toEqual(version);
  });

  it('偽の Cookie: 権限の無い人・別の組織の名義、既にある版番号、既にある版の書き換えは戻さない', async () => {
    const version = await newRiskVersion();
    const edit = editOf('disclosureBlockVersions', version);
    const variants: DemoEdit[] = [
      { ...edit, v: { ...edit.v, createdBy: SITE_USER } },
      { ...edit, v: { ...edit.v, createdBy: OTHER_ORG_ADMIN } },
      { ...edit, v: { ...edit.v, organizationId: ORG_IDS.soten } },
      // 既にある版番号（Fixture の版 1）を名乗って、別の本文を版 1 として足す
      { ...edit, v: { ...edit.v, versionNo: 1, baseVersionId: null, b: [] } },
    ];
    for (const forged of variants) {
      const other = replay([forged]);
      expect(other.disclosureBlockVersions.some((v) => v.id === version.id)).toBe(false);
    }
    // 既にある版（Fixture の版 1）の本文を書き換える
    const fixtureVersion = source.disclosureBlockVersions.find((v) => v.blockId === RISK)!;
    const rewrite: DemoEdit = {
      t: 'disclosureBlockVersions',
      id: fixtureVersion.id,
      v: {
        [COMPACT_MARK]: COMPACT_VERSION,
        id: fixtureVersion.id,
        organizationId: fixtureVersion.organizationId,
        blockId: RISK,
        versionNo: 9,
        createdAt: fixtureVersion.createdAt,
        createdBy: AUTHOR,
        b: [{ id: 'x', kind: 'paragraph', children: [{ t: 'text', text: '改ざん' }] }],
      },
    };
    const other = replay([rewrite]);
    expect(other.disclosureBlockVersions.find((v) => v.id === fixtureVersion.id)).toEqual(
      fixtureVersion,
    );
  });

  it('書いた人を外した偽の版でも、土台の版を書いた人は書いた人に戻る（自分の本文を承認させない）', async () => {
    const version = await newRiskVersion();
    const base = source.disclosureBlockVersions.find((v) => v.id === version.baseVersionId)!;
    // 承認者が書いた土台の版を、承認者の名前を消して引き継いだことにする
    base.createdBy = APPROVER;
    const edit = editOf('disclosureBlockVersions', { ...version, contributorUserIds: [] });
    const target = createFixtureDb();
    target.disclosureBlockVersions.find((v) => v.id === base.id)!.createdBy = APPROVER;
    const restored = replay([edit], target).disclosureBlockVersions.find(
      (v) => v.id === version.id,
    );
    expect(restored?.contributorUserIds).toContain(APPROVER);
  });

  it('形の違う本文（余計なキー・不正な段落 ID・重複した段落）は戻さない', async () => {
    const version = await newRiskVersion();
    const edit = editOf('disclosureBlockVersions', version);
    for (const b of [
      [{ id: 'a', kind: 'paragraph', children: [], extra: 1 }],
      [{ id: 'a b', kind: 'paragraph', children: [] }],
      [
        { id: 'a', kind: 'paragraph', children: [] },
        { id: 'a', kind: 'paragraph', children: [] },
      ],
      [{ id: 'a', kind: 'paragraph', children: [{ t: 'script', text: 'x' }] }],
    ]) {
      const other = replay([{ ...edit, v: { ...edit.v, b } }]);
      expect(other.disclosureBlockVersions.some((v) => v.id === version.id)).toBe(false);
    }
  });

  it('偽の Cookie: 節の現在の版を別の節の版に向けさせない（持ち回した版で確かめる）', () => {
    const governance = source.disclosureBlocks.find(
      (b) => b.id === IDS.blocks.fy2026Governance.block,
    )!;
    const risk = source.disclosureBlocks.find((b) => b.id === RISK)!;
    const other = replay([
      { t: 'disclosureBlocks', id: RISK, v: { currentVersionId: governance.currentVersionId } },
    ]);
    expect(other.disclosureBlocks.find((b) => b.id === RISK)?.currentVersionId).toBe(
      risk.currentVersionId,
    );
  });
});

describe('定性情報の版（narrative_versions）と引用位置（source_anchors）', () => {
  function anchorRow(): SourceAnchor {
    const fragment = source.fragments.find((f) =>
      f.text.includes('識別したリスク及び機会を審議した'),
    )!;
    return {
      id: 'a1a1a1a1-0000-4000-8000-000000000001',
      organizationId: ORG_IDS.aomi,
      fileVersionId: fragment.fileVersionId,
      fragmentId: fragment.id,
      anchorKind: 'heading_paragraph',
      page: null,
      locator: fragment.locator,
      quoteText: '識別したリスク及び機会を審議した',
      acquiredBy: 'extracted',
      createdAt: '2026-09-30T00:00:00.000Z',
      createdBy: AUTHOR,
    };
  }

  function narrativeVersionRow(anchorId: string): NarrativeVersion {
    return {
      id: 'b2b2b2b2-0000-4000-8000-000000000002',
      organizationId: ORG_IDS.aomi,
      narrativeRecordId: IDS.narratives.strategy,
      versionNo: 9,
      reportingPeriodId: PERIOD_IDS.fy2026,
      scopeNote: '',
      fields: { measures: '省電力製品の拡販（架空）' },
      body: '委員会で識別したリスク及び機会を審議した（テスト）。',
      sourceAnchorIds: [anchorId],
      carriedFromVersionId: null,
      changeReason: 'テスト',
      originatedFromAiRunId: null,
      contentHash: 'ここは計算し直される',
      createdAt: '2026-09-30T00:00:00.000Z',
      createdBy: AUTHOR,
    };
  }

  it('往復して同じ行に戻り、内容ハッシュは本文から計算し直す（偽のハッシュを名乗らせない）', () => {
    const anchor = anchorRow();
    const version = narrativeVersionRow(anchor.id);
    const other = replay([editOf('sourceAnchors', anchor), editOf('narrativeVersions', version)]);
    expect(other.sourceAnchors.find((a) => a.id === anchor.id)).toEqual(anchor);
    const restored = other.narrativeVersions.find((v) => v.id === version.id)!;
    expect(restored.body).toBe(version.body);
    expect(restored.contentHash).not.toBe('ここは計算し直される');
    expect(restored.contentHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('偽の Cookie が足した列は行に混ぜない（形の検査に通った列だけを戻す）', () => {
    const anchor = anchorRow();
    const edit = editOf('sourceAnchors', anchor);
    const other = replay([{ ...edit, v: { ...edit.v, status: 'approved', deletedAt: 'x' } }]);
    const restored = other.sourceAnchors.find((a) => a.id === anchor.id) as unknown as Record<
      string,
      unknown
    >;
    expect(restored).toEqual(anchor);
    expect('status' in restored).toBe(false);
  });

  it('偽の Cookie: 資料に無い引用文・別の資料の箇所・権限の無い人の引用位置は戻さない', () => {
    const anchor = anchorRow();
    const otherFileVersion = source.fileVersions.find((v) => v.id !== anchor.fileVersionId)!;
    for (const forged of [
      { ...anchor, quoteText: '資料に書かれていない文言' },
      { ...anchor, fileVersionId: otherFileVersion.id },
      { ...anchor, createdBy: SITE_USER },
      { ...anchor, createdBy: OTHER_ORG_ADMIN },
      { ...anchor, fragmentId: null },
    ]) {
      const other = replay([editOf('sourceAnchors', forged)]);
      expect(other.sourceAnchors.some((a) => a.id === anchor.id)).toBe(false);
    }
  });

  it('偽の Cookie: 別の組織の台帳・権限の無い人・既にある版番号・無い引用位置の定性情報の版は戻さない', () => {
    const anchor = anchorRow();
    const version = narrativeVersionRow(anchor.id);
    const otherOrgRecord = source.narrativeRecords.find((r) => r.organizationId !== ORG_IDS.aomi);
    const variants: NarrativeVersion[] = [
      { ...version, createdBy: SITE_USER },
      { ...version, versionNo: 1 },
      { ...version, sourceAnchorIds: ['c3c3c3c3-0000-4000-8000-000000000003'] },
      { ...version, organizationId: ORG_IDS.soten },
      ...(otherOrgRecord ? [{ ...version, narrativeRecordId: otherOrgRecord.id }] : []),
    ];
    for (const forged of variants) {
      const other = replay([editOf('sourceAnchors', anchor), editOf('narrativeVersions', forged)]);
      expect(other.narrativeVersions.some((v) => v.id === version.id)).toBe(false);
    }
    // 追記専用: 既にある版（Fixture）の本文は書き換えない
    const fixtureVersion = source.narrativeVersions.find(
      (v) => v.id === IDS.narrativeVersions.strategy,
    )!;
    const other = replay([editOf('narrativeVersions', { ...fixtureVersion, body: '改ざん' })]);
    expect(other.narrativeVersions.find((v) => v.id === fixtureVersion.id)?.body).toBe(
      fixtureVersion.body,
    );
  });
});

describe('スナップショット（report_snapshots）は目録だけを持ち回す', () => {
  async function draftSnapshot(): Promise<ReportSnapshot> {
    const detail = await createReviewDraftSnapshot(
      new DemoDbClient(source),
      author(),
      IDS.projects.fy2026,
    );
    return source.reportSnapshots.find((s) => s.id === detail.id)!;
  }

  /** 目録から組み立てた写しに合わせて内容ハッシュを付け直す（鍵の無い sha256 は偽造できる） */
  function withMatchingHash(manifest: Record<string, unknown>, db: FixtureDb) {
    const row = rehydrateSnapshotManifest(manifest, db);
    if (!row) throw new Error('組み立てられない目録');
    return {
      ...manifest,
      contentHash: computeSnapshotContentHash(row as unknown as ReportSnapshot),
    };
  }

  it('目録は写しより小さく、別インスタンスで作成時と同じ内容（ハッシュ）に組み立て直す', async () => {
    const snapshot = await draftSnapshot();
    const edit = editOf('reportSnapshots', snapshot);
    expect(JSON.stringify(edit.v).length).toBeLessThan(JSON.stringify(snapshot).length / 3);
    const restored = replay([edit]).reportSnapshots.find((s) => s.id === snapshot.id);
    expect(restored).toBeDefined();
    expect(computeSnapshotContentHash(restored!)).toBe(snapshot.contentHash);
    expect(restored?.blocks).toEqual(snapshot.blocks);
  });

  it('組み立て直した内容がハッシュと合わない目録（注意の書き換え・上流の行の欠け）は戻さない', async () => {
    const snapshot = await draftSnapshot();
    const edit = editOf('reportSnapshots', snapshot);
    const blocks = (edit.v.bl as Array<Record<string, unknown>>).map((b) => ({ ...b, is: [] }));
    const tampered = replay([{ ...edit, v: { ...edit.v, bl: blocks } }]);
    expect(tampered.reportSnapshots.some((s) => s.id === snapshot.id)).toBe(false);

    // 引用した版がこのインスタンスに無い（別の組織の版を名乗る・押し出された）
    const target = createFixtureDb();
    const cited = (edit.v.bl as Array<{ v: string | null }>).find((b) => b.v)!.v!;
    target.disclosureBlockVersions = target.disclosureBlockVersions.filter((v) => v.id !== cited);
    expect(replay([edit], target).reportSnapshots.some((s) => s.id === snapshot.id)).toBe(false);
  });

  it('偽の Cookie: 最終承認の記録の無い節を「承認済み版」として固定したスナップショットは戻さない', async () => {
    const snapshot = await draftSnapshot();
    const edit = editOf('reportSnapshots', snapshot);
    const target = createFixtureDb();
    // 下書きの節（リスク及び機会）まで承認済みと名乗り、ハッシュも合わせる
    const forged = withMatchingHash(
      {
        ...edit.v,
        id: 'd4d4d4d4-0000-4000-8000-000000000004',
        snapshotKind: 'approved',
        createdBy: APPROVER,
        label: '社内承認済み版',
        bl: (edit.v.bl as Array<Record<string, unknown>>).map((b) => ({
          ...b,
          s: 'approved',
          a: 1,
          ok: 1,
          is: undefined,
        })),
      },
      target,
    );
    const other = replay(
      [{ t: 'reportSnapshots', id: 'd4d4d4d4-0000-4000-8000-000000000004', v: forged }],
      target,
    );
    expect(other.reportSnapshots).toHaveLength(0);
  });

  it('偽の Cookie: 承認の根拠の無い数値の版を「承認済み」と名乗る・権限の無い人の名義は戻さない', async () => {
    const snapshot = await draftSnapshot();
    const edit = editOf('reportSnapshots', snapshot);
    const target = createFixtureDb();
    // 承認していない数値の版（入力中）を足し、その版を承認済みとして固定したと名乗る
    const dp = target.dataPoints.find((d) => d.id === dataPointId('EU', 'water', 'FY2026'))!;
    const base = target.dataPointVersions.find((v) => v.id === dp.currentVersionId)!;
    target.dataPointVersions.push({
      ...base,
      id: 'e5e5e5e5-0000-4000-8000-000000000005',
      versionNo: 99,
      value: 1,
      status: 'draft',
    });
    const forgedMetric = withMatchingHash(
      {
        ...edit.v,
        mv: [
          ...(edit.v.mv as unknown[]),
          { v: 'e5e5e5e5-0000-4000-8000-000000000005', s: 'approved', ok: 1 },
        ],
      },
      target,
    );
    expect(
      replay([{ ...edit, v: forgedMetric }], target).reportSnapshots.some(
        (s) => s.id === snapshot.id,
      ),
    ).toBe(false);

    const noPermission = replay([{ ...edit, v: { ...edit.v, createdBy: SITE_USER } }]);
    expect(noPermission.reportSnapshots.some((s) => s.id === snapshot.id)).toBe(false);
  });

  it('出力記録は、同じ組織のスナップショットと出力権限のある人の名義だけを戻す（内容ハッシュはスナップショットから）', async () => {
    const snapshot = await draftSnapshot();
    const artifact = {
      id: 'f6f6f6f6-0000-4000-8000-000000000006',
      organizationId: ORG_IDS.aomi,
      snapshotId: snapshot.id,
      format: 'docx',
      audience: 'external',
      templateVersion: 'disclosure-report-v2',
      fileName: 'report.docx',
      byteSize: 100,
      fileSha256: 'a'.repeat(64),
      contentHash: '偽のハッシュ',
      generatedAt: '2026-09-30T00:00:00.000Z',
      generatedBy: APPROVER,
    };
    const snapshotEdit = editOf('reportSnapshots', snapshot);
    const ok = replay([snapshotEdit, editOf('exportArtifacts', artifact)]);
    expect(ok.exportArtifacts.find((a) => a.id === artifact.id)?.contentHash).toBe(
      snapshot.contentHash,
    );
    for (const forged of [
      { ...artifact, generatedBy: SITE_USER },
      { ...artifact, snapshotId: 'f7f7f7f7-0000-4000-8000-000000000007' },
      { ...artifact, organizationId: ORG_IDS.soten },
    ]) {
      const other = replay([snapshotEdit, editOf('exportArtifacts', forged)]);
      expect(other.exportArtifacts.some((a) => a.id === artifact.id)).toBe(false);
    }
  });
});

describe('標準 CSV の確定の控え（quantitative_import_batches）', () => {
  const committed: QuantitativeImportBatch = {
    id: 'a7a7a7a7-0000-4000-8000-000000000008',
    organizationId: ORG_IDS.aomi,
    reportingPeriodId: PERIOD_IDS.fy2026,
    projectId: null,
    fileName: 'eu-water.csv',
    fileSha256: 'b'.repeat(64),
    status: 'committed',
    rows: [
      {
        rowNo: 2,
        raw: { value: '1' },
        diffKind: 'changed',
        included: true,
        metricId: null,
        unitId: null,
        boundary: null,
        dataPointId: 'dp-1',
        currentVersionId: 'v-1',
        value: 1,
        textValue: null,
        unitOfMeasure: 'm3',
        valueKind: 'actual',
        availabilityStatus: 'value_present',
        absenceReason: null,
        errors: [],
        warnings: ['承認済みの値です'],
        writtenDataPointId: 'dp-1',
        writtenVersionId: 'v-2',
      } as QuantitativeImportBatch['rows'][number],
    ],
    previewHash: 'c'.repeat(64),
    commitIdempotencyKey: 'key-1',
    committedAt: '2026-09-30T00:00:00.000Z',
    committedBy: AUTHOR,
    excludedCount: 0,
    createdAt: '2026-09-30T00:00:00.000Z',
    createdBy: AUTHOR,
  };

  it('検証しただけのバッチは載せず、確定の控え（確定キー・書いた行）だけを載せて戻す', () => {
    expect(
      compactRow('quantitativeImportBatches', { ...committed, status: 'validated' }, source),
    ).toBeNull();
    const restored = replay([editOf('quantitativeImportBatches', committed)])
      .quantitativeImportBatches[0]!;
    expect(restored.commitIdempotencyKey).toBe('key-1');
    expect(restored.rows[0]).toMatchObject({
      rowNo: 2,
      diffKind: 'changed',
      included: true,
      writtenDataPointId: 'dp-1',
      writtenVersionId: 'v-2',
    });
  });

  it('偽の Cookie: 検証した人と違う人の確定・取込権限の無い人・別の組織の期間は戻さない', () => {
    for (const forged of [
      { ...committed, committedBy: APPROVER },
      { ...committed, createdBy: OTHER_ORG_ADMIN, committedBy: OTHER_ORG_ADMIN },
      { ...committed, reportingPeriodId: 'a8a8a8a8-0000-4000-8000-000000000009' },
    ]) {
      expect(
        replay([editOf('quantitativeImportBatches', forged)]).quantitativeImportBatches,
      ).toEqual([]);
    }
  });
});

describe('データの承認の記録（approvals）', () => {
  function approval(overrides: Record<string, unknown> = {}) {
    const dp = source.dataPoints.find((d) => d.id === dataPointId('EU', 'water', 'FY2026'))!;
    return {
      id: 'b9b9b9b9-0000-4000-8000-00000000000a',
      organizationId: ORG_IDS.aomi,
      targetType: 'data_point',
      targetId: dp.id,
      targetVersionId: dp.currentVersionId,
      stage: 'final',
      decision: 'approved',
      actorUserId: APPROVER,
      comment: null,
      decidedAt: '2026-09-30T00:00:00.000Z',
      ...overrides,
    };
  }

  it('承認権限のある人の承認は戻り、データ以外（開示回答）の承認は Cookie に載せない', () => {
    const row = approval();
    expect(replay([editOf('approvals', row)]).approvals.some((a) => a.id === row.id)).toBe(true);
    expect(
      compactRow('approvals', { ...row, targetType: 'disclosure_response' }, source),
    ).toBeNull();
  });

  it('偽の Cookie: 承認権限の無い人・別の Data Point の版・承認の道筋が済んでいない承認は戻さない', () => {
    const otherVersion = source.dataPointVersions.find(
      (v) => v.dataPointId !== dataPointId('EU', 'water', 'FY2026'),
    )!;
    for (const forged of [
      approval({ actorUserId: SITE_USER }),
      approval({ actorUserId: OTHER_ORG_ADMIN }),
      approval({ targetVersionId: otherVersion.id }),
    ]) {
      expect(replay([editOf('approvals', forged)]).approvals.some((a) => a.id === forged.id)).toBe(
        false,
      );
    }
    // 承認の道筋（5 段階）の途中で「承認済み」を名乗る
    const target = createFixtureDb();
    const row = approval();
    target.dataPointApprovalSteps.push({
      id: 'step-1',
      organizationId: ORG_IDS.aomi,
      dataPointId: row.targetId as string,
      routeId: null,
      stageNo: 1,
      stageName: '確認',
      approverRole: 'reviewer',
      approverUserId: null,
      department: '',
      status: 'pending',
      decidedAt: null,
      decidedBy: null,
      comment: '',
      round: 1,
      createdAt: '2026-09-30T00:00:00.000Z',
      updatedAt: '2026-09-30T00:00:00.000Z',
    });
    expect(replay([editOf('approvals', row)], target).approvals.some((a) => a.id === row.id)).toBe(
      false,
    );
  });
});

describe('組み立て直しの入口', () => {
  it('目印の無い（形の違う）Cookie の値は組み立てない', () => {
    expect(expandRow('sourceAnchors', { id: 'x' }, source)).toBeNull();
  });
});

// ----------------------------------------------------------------------
// 自己監査（2026-09-30 第 2 巡）で確かめた偽の Cookie の経路
// ----------------------------------------------------------------------

const GOVERNANCE = IDS.blocks.fy2026Governance.block;

/** 偽の Cookie が名乗る原稿の版（小さくした形）。本文は段落 1 つ */
function forgedVersion(fields: {
  id: string;
  blockId?: string;
  versionNo: number;
  baseVersionId?: string | null;
  createdBy?: string;
  paragraphs?: unknown[];
}): DemoEdit {
  return {
    t: 'disclosureBlockVersions',
    id: fields.id,
    v: {
      [COMPACT_MARK]: COMPACT_VERSION,
      id: fields.id,
      organizationId: ORG_IDS.aomi,
      blockId: fields.blockId ?? RISK,
      versionNo: fields.versionNo,
      ...(fields.baseVersionId ? { baseVersionId: fields.baseVersionId } : {}),
      createdAt: '2026-09-30T00:00:00.000Z',
      createdBy: fields.createdBy ?? AUTHOR,
      b: fields.paragraphs ?? [
        { id: 'p', kind: 'paragraph', children: [{ t: 'text', text: `版 ${fields.versionNo}` }] },
      ],
    },
  };
}

function nextVersionNo(db: FixtureDb, blockId: string): number {
  return Math.max(
    0,
    ...db.disclosureBlockVersions.filter((v) => v.blockId === blockId).map((v) => v.versionNo),
  );
}

describe('偽の Cookie で 1 回の適用を膨らませない（処理時間・メモリ）', () => {
  const chainId = (k: number) => `c0c0c0c0-0000-4000-8000-${String(k).padStart(12, '0')}`;

  function reversedChain(count: number): DemoEdit[] {
    const v1 = source.disclosureBlocks.find((b) => b.id === RISK)!.currentVersionId!;
    const edits: DemoEdit[] = [];
    for (let k = 1; k <= count; k += 1) {
      edits.push({
        ...forgedVersion({
          id: chainId(k),
          versionNo: k + 1,
          baseVersionId: k === 1 ? v1 : chainId(k - 1),
        }),
        // 新しい順に並べる（どの版も、前の周で土台が戻るまで受け付けられない順）
        n: count - k,
      });
    }
    return edits.reverse();
  }

  it('逆順に並べた版の鎖でも、1 回の適用は短時間で終わり、節ごとの版の数に上限がある', () => {
    // 読み取り（readFrom）と同じく追記の順番（n）の昇順 = 新しい版から並ぶ
    const edits = reversedChain(1750);
    const target = createFixtureDb();
    const started = performance.now();
    applyDemoEdits(target, edits);
    const elapsed = performance.now() - started;
    // 以前は周回ごとに 1 版しか進まず、1750 版で約 18.6 秒かかった（3 乗の処理）
    expect(elapsed).toBeLessThan(3000);
    expect(
      target.disclosureBlockVersions.filter((v) => v.blockId === RISK).length,
    ).toBeLessThanOrEqual(200);
  });

  it('正規の鎖は Cookie の中の順番が逆でも、1 回の適用で全部戻る', () => {
    const target = replay(reversedChain(20));
    const restored = target.disclosureBlockVersions.filter((v) => v.id.startsWith('c0c0c0c0'));
    expect(restored).toHaveLength(20);
  });

  it('大きすぎる本文の版は戻さない（Cookie では強く圧縮できるため、展開後の大きさで止める）', () => {
    const v1 = source.disclosureBlocks.find((b) => b.id === RISK)!.currentVersionId!;
    const huge = forgedVersion({
      id: 'b1b1b1b1-0000-4000-8000-000000000001',
      versionNo: 2,
      baseVersionId: v1,
      paragraphs: Array.from({ length: 20 }, (_, i) => ({
        id: `h${i}`,
        kind: 'paragraph',
        children: [{ t: 'text', text: 'あ'.repeat(19_000) }],
      })),
    });
    const target = replay([huge]);
    expect(target.disclosureBlockVersions.some((v) => v.id === huge.id)).toBe(false);
  });

  it('大きい本文を番号だけで引き継ぐ版を大量に並べても、1 回の適用で組み立てる量に上限がある', () => {
    const v1 = source.disclosureBlocks.find((b) => b.id === RISK)!.currentVersionId!;
    const bigParagraphs = Array.from({ length: 8 }, (_, i) => ({
      id: `k${i}`,
      kind: 'paragraph',
      children: [{ t: 'text', text: 'う'.repeat(19_000) }],
    }));
    const base = forgedVersion({
      id: 'b3b3b3b3-0000-4000-8000-000000000000',
      versionNo: 2,
      baseVersionId: v1,
      paragraphs: bigParagraphs,
    });
    const bh = contentHashOf({ paragraphs: bigParagraphs } as never);
    const copies: DemoEdit[] = Array.from({ length: 900 }, (_, k) => {
      const edit = forgedVersion({
        id: `b3b3b3b3-0000-4000-8000-${String(k + 1).padStart(12, '0')}`,
        blockId: RISK,
        versionNo: k + 3,
        baseVersionId: base.id,
        paragraphs: bigParagraphs.map((_, i) => i),
      });
      return { ...edit, v: { ...edit.v, bh } };
    });
    const target = createFixtureDb();
    const started = performance.now();
    applyDemoEdits(target, [base, ...copies]);
    const elapsed = performance.now() - started;
    expect(target.disclosureBlockVersions.some((v) => v.id === base.id)).toBe(true);
    const restored = target.disclosureBlockVersions.filter((v) => v.id.startsWith('b3b3b3b3'));
    // 引き継いだ版は組み立て直せる（正規の差分）が、本文の総量は 1 回の適用の予算で止まる
    expect(restored.length).toBeGreaterThan(1);
    expect(restored.length).toBeLessThan(100);
    expect(elapsed).toBeLessThan(3000);
  });

  it('同じ節を何度も並べた目録は、組み立て直す前に止める（大きい本文の写しを何千も作らない）', async () => {
    const draft = await createReviewDraftSnapshot(
      new DemoDbClient(source),
      author(),
      IDS.projects.fy2026,
    );
    const snapshot = source.reportSnapshots.find((s) => s.id === draft.id)!;
    const edit = editOf('reportSnapshots', snapshot);
    const v1 = source.disclosureBlocks.find((b) => b.id === RISK)!.currentVersionId!;
    const big = forgedVersion({
      id: 'b2b2b2b2-0000-4000-8000-000000000002',
      versionNo: 2,
      baseVersionId: v1,
      paragraphs: Array.from({ length: 5 }, (_, i) => ({
        id: `g${i}`,
        kind: 'paragraph',
        children: [{ t: 'text', text: 'い'.repeat(19_000) }],
      })),
    });
    const manifest = {
      ...edit.v,
      bl: Array.from({ length: 1000 }, () => ({ i: RISK, v: big.id, s: 'draft' })),
    };
    const target = createFixtureDb();
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    applyDemoEdits(
      target,
      decodeDemoEdits(
        encodeDemoEditStream([big, { t: 'reportSnapshots', id: snapshot.id, v: manifest }]),
      ),
    );
    const elapsed = performance.now() - started;
    expect(target.disclosureBlockVersions.some((v) => v.id === big.id)).toBe(true);
    expect(target.reportSnapshots.some((s) => s.id === snapshot.id)).toBe(false);
    // 以前は 1 リクエストで約 1.15 秒・約 2GB のヒープを使った
    expect(elapsed).toBeLessThan(1500);
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(200 * 1024 * 1024);
  });
});

describe('承認済みスナップショットの目録は、プロジェクトの行で完全性・時点・範囲の番号を確かめる', () => {
  const APPROVED_ID = 'a9a9a9a9-0000-4000-8000-000000000009';

  /**
   * FY2026 の節をすべて承認済みにする（最終承認で終わった依頼と記録を直接足す）。
   * Cookie の検査の前提（追記専用の記録）を作るだけで、検査そのものは applyDemoEdits が行う
   */
  function approveAllBlocks(db: FixtureDb, approvedAt: string): void {
    const requestTemplate = db.reviewRequests[0]!;
    const eventTemplate = db.reviewEvents[0]!;
    for (const block of db.disclosureBlocks.filter(
      (b) => b.projectId === IDS.projects.fy2026 && b.deletedAt === null,
    )) {
      const versionId = block.currentVersionId!;
      const requestId = `${block.id.slice(0, 8)}-0000-4000-8000-00000000aaaa`;
      db.reviewRequests.push({
        ...requestTemplate,
        id: requestId,
        organizationId: ORG_IDS.aomi,
        projectId: IDS.projects.fy2026,
        targetId: block.id,
        targetVersionId: versionId,
        requestedBy: AUTHOR,
        status: 'approved',
        projectScopeRevision: 0,
        createdAt: approvedAt,
      } satisfies ReviewRequest);
      db.reviewEvents.push({
        ...eventTemplate,
        id: `${block.id.slice(0, 8)}-0000-4000-8000-00000000bbbb`,
        organizationId: ORG_IDS.aomi,
        reviewRequestId: requestId,
        eventType: 'approved',
        stage: 'final',
        actorUserId: APPROVER,
        targetVersionId: versionId,
        createdAt: approvedAt,
      } satisfies ReviewEvent);
      block.status = 'approved';
      block.approvedVersionId = versionId;
    }
  }

  const approvedAt = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();

  /** 全節を含む承認済みの目録（数値・引用・定性情報は空にして、節の完全性だけを見る） */
  async function approvedManifest(): Promise<Record<string, unknown>> {
    approveAllBlocks(source, approvedAt());
    const detail = await createReviewDraftSnapshot(
      new DemoDbClient(source),
      author(),
      IDS.projects.fy2026,
    );
    const draft = source.reportSnapshots.find((s) => s.id === detail.id)!;
    const edit = editOf('reportSnapshots', draft);
    return {
      ...edit.v,
      id: APPROVED_ID,
      snapshotKind: 'approved',
      snapshotNo: 99,
      label: '社内承認済み版',
      createdBy: APPROVER,
      createdAt: new Date().toISOString(),
      mv: [],
      an: [],
      narrativeVersionIds: [],
    };
  }

  function forgedHash(manifest: Record<string, unknown>, db: FixtureDb) {
    const row = rehydrateSnapshotManifest(manifest, db);
    if (!row) throw new Error('組み立てられない目録');
    return {
      ...manifest,
      contentHash: computeSnapshotContentHash(row as unknown as ReportSnapshot),
    };
  }

  function replayApproved(
    manifest: Record<string, unknown>,
    prepare: (db: FixtureDb) => void = () => {},
  ): boolean {
    const target = createFixtureDb();
    approveAllBlocks(target, approvedAt());
    prepare(target);
    const forged = forgedHash(manifest, target);
    replay([{ t: 'reportSnapshots', id: APPROVED_ID, v: forged }], target);
    return target.reportSnapshots.some((s) => s.id === APPROVED_ID);
  }

  const onlyGovernance = (manifest: Record<string, unknown>) =>
    (manifest.bl as Array<{ i: string }>).filter((b) => b.i === GOVERNANCE);

  it('全節を含む正規の目録は戻る（検査の前提の確認）', async () => {
    expect(replayApproved(await approvedManifest())).toBe(true);
  });

  it('作成日時を過去にずらして後から作った節を外した目録は戻さない', async () => {
    const manifest = await approvedManifest();
    expect(
      replayApproved({
        ...manifest,
        bl: onlyGovernance(manifest),
        createdAt: '2000-01-01T00:00:00.000Z',
      }),
    ).toBe(false);
    // 未来の作成日時も名乗らせない
    expect(
      replayApproved({ ...manifest, createdAt: new Date(Date.now() + 86_400_000).toISOString() }),
    ).toBe(false);
  });

  it('固定した基準の一覧を空にして節を外した目録は戻さない（完全性はプロジェクトの基準の行で見る）', async () => {
    const manifest = await approvedManifest();
    expect(replayApproved({ ...manifest, bl: onlyGovernance(manifest), fw: [], pj: null })).toBe(
      false,
    );
    expect(replayApproved({ ...manifest, fw: [], pj: null })).toBe(false);
    // 基準を 1 つ外す（ESRS-40a 準備の節ごと）
    const ssbjOnly = (manifest.fw as Array<{ v: string }>).filter(
      (f) => f.v !== IDS.esrs40aVersion,
    );
    const ssbjBlocks = (manifest.bl as Array<{ i: string }>).filter(
      (b) => b.i !== IDS.blocks.fy2026Esrs40aGovernance.block,
    );
    expect(replayApproved({ ...manifest, fw: ssbjOnly, bl: ssbjBlocks })).toBe(false);
  });

  it('範囲の改訂番号は、プロジェクトの番号より小さく名乗っても再確認を外せない', async () => {
    const manifest = await approvedManifest();
    const scopeChanged = (db: FixtureDb) => {
      db.disclosureProjects.find((p) => p.id === IDS.projects.fy2026)!.scopeRevision = 1;
    };
    // 依頼（承認）は範囲の番号 0 のとき。プロジェクトは番号 1 に進んでいる
    expect(replayApproved(manifest, scopeChanged)).toBe(false);
    const withRevision = (r: number) => ({
      ...manifest,
      pj: { ...(manifest.pj as Record<string, unknown>), r },
    });
    expect(replayApproved(withRevision(1), scopeChanged)).toBe(false);
    // プロジェクトより先の番号も名乗らせない
    expect(replayApproved(withRevision(2), scopeChanged)).toBe(false);
  });
});

describe('原稿の版の書いた人・土台・現在の版のポインタ', () => {
  it('土台の版を名乗らない偽の版でも、節の既存の版を書いた人は書いた人に入る（DB のトリガと同じ）', () => {
    const risk = source.disclosureBlocks.find((b) => b.id === RISK)!;
    const v1 = source.disclosureBlockVersions.find((v) => v.id === risk.currentVersionId)!;
    const forged = forgedVersion({
      id: 'f2f2f2f2-0000-4000-8000-000000000002',
      versionNo: nextVersionNo(source, RISK) + 1,
      createdBy: REVIEWER,
      paragraphs: v1.body.paragraphs,
    });
    const restored = replay([forged]).disclosureBlockVersions.find((v) => v.id === forged.id);
    expect(restored).toBeDefined();
    expect(restored!.contributorUserIds).toContain(v1.createdBy);
    for (const id of v1.contributorUserIds ?? []) {
      if (id !== REVIEWER) expect(restored!.contributorUserIds).toContain(id);
    }
  });

  it('差分で持ち回した版は、土台の版の本文が変わっていたら組み立て直さない（再デプロイで別の文になる）', async () => {
    const version = await newRiskVersion();
    const edit = editOf('disclosureBlockVersions', version);
    const target = createFixtureDb();
    const base = target.disclosureBlockVersions.find((v) => v.id === version.baseVersionId)!;
    base.body = {
      paragraphs: base.body.paragraphs.map((p, i) =>
        i === 0 ? { ...p, children: [{ t: 'text', text: 'CHANGED FIXTURE TEXT' }] } : p,
      ) as BlockParagraph[],
    };
    base.contentHash = contentHashOf(base.body);
    const restored = replay([edit], target).disclosureBlockVersions.find(
      (v) => v.id === version.id,
    );
    expect(restored).toBeUndefined();
  });

  it('節の現在の版は、同じ Cookie で後の周に戻る別の節の版へ向けさせない', () => {
    const governance = source.disclosureBlocks.find((b) => b.id === GOVERNANCE)!;
    const risk = source.disclosureBlocks.find((b) => b.id === RISK)!;
    const no = nextVersionNo(source, GOVERNANCE);
    const G = forgedVersion({
      id: 'a1b2c3d4-0000-4000-8000-00000000000a',
      blockId: GOVERNANCE,
      versionNo: no + 1,
      baseVersionId: governance.currentVersionId,
    });
    const F = forgedVersion({
      id: 'a1b2c3d4-0000-4000-8000-00000000000b',
      blockId: GOVERNANCE,
      versionNo: no + 2,
      baseVersionId: G.id,
    });
    const pointer: DemoEdit = { t: 'disclosureBlocks', id: RISK, v: { currentVersionId: F.id } };
    const target = replay([F, G, pointer]);
    expect(target.disclosureBlocks.find((b) => b.id === RISK)?.currentVersionId).toBe(
      risk.currentVersionId,
    );

    // 別のリクエストで後から版が届いても、別の節の版を指したことにならない
    const shared = replay([pointer]);
    replay([G, F], shared);
    const pointed = shared.disclosureBlocks.find((b) => b.id === RISK)!.currentVersionId;
    const version = shared.disclosureBlockVersions.find((v) => v.id === pointed);
    expect(version === undefined || version.blockId === RISK).toBe(true);
  });
});

describe('スナップショットの社内コメント', () => {
  async function draftManifest() {
    const detail = await createReviewDraftSnapshot(
      new DemoDbClient(source),
      author(),
      IDS.projects.fy2026,
    );
    const snapshot = source.reportSnapshots.find((s) => s.id === detail.id)!;
    return editOf('reportSnapshots', snapshot);
  }

  function comment(overrides: Partial<ReviewComment>): ReviewComment {
    const risk = source.disclosureBlocks.find((b) => b.id === RISK)!;
    return {
      id: 'c9c9c9c9-0000-4000-8000-000000000009',
      organizationId: ORG_IDS.aomi,
      blockId: RISK,
      blockVersionId: risk.currentVersionId!,
      paragraphId: null,
      body: 'テストの社内コメント',
      severity: 'info',
      createdAt: '2026-09-30T00:00:00.000Z',
      createdBy: REVIEWER,
      resolvedAt: null,
      resolvedBy: null,
      resolutionNote: null,
      ...overrides,
    };
  }

  /** 以前の組み立て直し（コメントを ID だけで引いた）と同じ写しのハッシュを付けた目録を戻す */
  async function replayWithComment(row: ReviewComment): Promise<ReportSnapshot | undefined> {
    const edit = await draftManifest();
    const target = createFixtureDb();
    target.reviewComments.push(row);
    const bl = (edit.v.bl as Array<Record<string, unknown>>).map((b) => ({ ...b }));
    const entry = bl.findIndex((b) => b.i === RISK);
    const rehydrated = rehydrateSnapshotManifest(
      { ...edit.v, bl },
      target,
    ) as unknown as ReportSnapshot | null;
    if (!rehydrated) throw new Error('組み立てられない目録');
    (rehydrated.blocks[entry] as unknown as { internalComments: unknown[] }).internalComments.push(
      snapshotCommentOf(row),
    );
    bl[entry] = { ...bl[entry], c: [row.id] };
    const manifest = { ...edit.v, bl, contentHash: computeSnapshotContentHash(rehydrated) };
    replay([{ t: 'reportSnapshots', id: edit.id, v: manifest }], target);
    return target.reportSnapshots.find((s) => s.id === edit.id);
  }

  it('同じ組織・同じ節のコメントは戻り、別の組織・別の節のコメントは目録に入れさせない', async () => {
    const ok = await replayWithComment(comment({}));
    expect(ok).toBeDefined();
    const otherOrg = await replayWithComment(
      comment({ organizationId: ORG_IDS.soten, body: 'SOTEN INTERNAL SECRET' }),
    );
    expect(otherOrg).toBeUndefined();
    const otherBlock = await replayWithComment(comment({ blockId: GOVERNANCE }));
    expect(otherBlock).toBeUndefined();
  });
});
