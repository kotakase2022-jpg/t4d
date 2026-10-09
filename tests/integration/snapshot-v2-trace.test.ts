import { beforeEach, describe, expect, it } from 'vitest';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { FY2025_APPROVED_SNAPSHOT_ID } from '@/lib/fixtures/trial-case';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  computeSnapshotContentHash,
  isSnapshotV2,
  snapshotHashVersionOf,
  SNAPSHOT_HASH_VERSION,
  SNAPSHOT_HASH_VERSION_V1,
  type SnapshotContent,
} from '@/lib/domain/report-snapshot-content';
import {
  buildReportTrace,
  blockShortCodes,
  findTraceUnits,
  sectionShortCode,
} from '@/lib/domain/report-trace';
import {
  asSnapshotDetail,
  createReviewDraftSnapshot,
  verifySnapshotIntegrity,
} from '@/lib/services/report-snapshot';
import type { AuthorizationContext, ReportSnapshot, RoleKey } from '@/types/domain';

/**
 * スナップショット v2（承認の記録・根拠資料・要求事項の判断の固定。NF-13）と、写しだけからのトレース（NF-14）。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

function ctxFor(email: string, roleKeys: RoleKey[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: 'テスト',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const author = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);

function fy2025(): ReportSnapshot {
  return fixture.reportSnapshots.find((s) => s.id === FY2025_APPROVED_SNAPSHOT_ID)!;
}

/** v2 の鍵を落とした写し（v2 より前に作ったスナップショットと同じ形） */
function asV1(snapshot: ReportSnapshot): SnapshotContent {
  const detail = asSnapshotDetail(snapshot);
  const content = {
    projectId: detail.projectId,
    snapshotKind: detail.snapshotKind,
    label: detail.label,
    frameworkVersions: detail.frameworkVersions.map(({ requirementState: _r, ...f }) => f),
    decisionIds: detail.decisionIds,
    blocks: detail.blocks.map(({ approval: _a, ...b }) => b),
    metricValues: detail.metricValues.map(({ evidenceFileVersionIds: _e, ...m }) => m),
    narrativeVersionIds: detail.narrativeVersionIds,
    anchors: detail.anchors,
    policyVersion: detail.policyVersion,
  };
  return content as unknown as SnapshotContent;
}

describe('スナップショット v2', () => {
  it('Fixture の FY2025 承認済み版は v2 で、内容ハッシュが一致する', () => {
    const snapshot = fy2025();
    expect(isSnapshotV2(snapshot)).toBe(true);
    expect(snapshotHashVersionOf(snapshot)).toBe(SNAPSHOT_HASH_VERSION);
    expect(verifySnapshotIntegrity(snapshot)).toBe(true);
  });

  it('新しく作るスナップショットは v2（承認の記録・根拠資料・要求事項の判断の状態を固定する）', async () => {
    const detail = await createReviewDraftSnapshot(db, author(), IDS.projects.fy2026);
    const row = fixture.reportSnapshots.find((s) => s.id === detail.id)!;
    expect(isSnapshotV2(row)).toBe(true);
    expect(verifySnapshotIntegrity(row)).toBe(true);
    const full = asSnapshotDetail(row);
    for (const f of full.frameworkVersions) {
      expect(f.requirementState).toBeDefined();
      expect(Array.isArray(f.requirementState!.exclusionEventIds)).toBe(true);
      const digest = f.requirementState!.assessmentDigest;
      // SSBJ・CSRD は評価行のダイジェスト（16 桁）、それ以外の基準は null
      if (digest !== null) expect(digest).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(full.frameworkVersions.some((f) => f.requirementState!.assessmentDigest !== null)).toBe(
      true,
    );
    for (const b of full.blocks) expect(Object.hasOwn(b, 'approval')).toBe(true);
    for (const m of full.metricValues) expect(Array.isArray(m.evidenceFileVersionIds)).toBe(true);
  });

  it('v1 の写し（v2 の鍵が無い）は v1 の規則でハッシュを確かめる（過去の版を壊さない）', () => {
    const v1 = asV1(fy2025());
    expect(isSnapshotV2(v1)).toBe(false);
    expect(snapshotHashVersionOf(v1)).toBe(SNAPSHOT_HASH_VERSION_V1);
    const hash = computeSnapshotContentHash(v1);
    const row = { ...fy2025(), ...v1, contentHash: hash } as unknown as ReportSnapshot;
    expect(verifySnapshotIntegrity(row)).toBe(true);
    // v2 の鍵を足すと別のハッシュになる（版を取り違えない）
    expect(hash).not.toBe(fy2025().contentHash);
  });

  it('内容を 1 か所でも変えるとハッシュが合わない', () => {
    const snapshot = fy2025();
    const tampered = {
      ...snapshot,
      metricValues: snapshot.metricValues.map((m, i) => (i === 0 ? { ...m, value: 1 } : m)),
    };
    expect(verifySnapshotIntegrity(tampered)).toBe(false);
  });
});

describe('トレース（写しだけから導く）', () => {
  it('段落と数値を数え、承認者・日時を写しから出す。同じ写しなら同じ結果', () => {
    const detail = asSnapshotDetail(fy2025());
    const input = {
      blocks: detail.blocks,
      metricValues: detail.metricValues,
      narrativeVersionsWithEvidence: new Set<string>(),
    };
    const first = buildReportTrace(input);
    const second = buildReportTrace(input);
    expect(second).toEqual(first);
    expect(first.summary.all.total).toBe(first.units.length);
    expect(first.summary.all.total).toBeGreaterThan(0);
    expect(first.summary.label).toContain('段落');
    for (const unit of first.units.filter((u) => u.traceable)) {
      expect(unit.approvedBy).not.toBeNull();
      expect(unit.reasons).toEqual([]);
    }
    for (const unit of first.units.filter((u) => !u.traceable)) {
      expect(unit.reasons.length).toBeGreaterThan(0);
    }
    const one = first.units[0]!;
    expect(findTraceUnits(first.units, one.traceId)).toContainEqual(one);
  });

  it('v1 の写しは承認の記録が無いため「承認者・承認日時が写しにありません」になる', () => {
    const v1 = asV1(fy2025());
    const trace = buildReportTrace({
      blocks: v1.blocks as never,
      metricValues: v1.metricValues as never,
      narrativeVersionsWithEvidence: new Set(),
    });
    const approvedParagraphs = trace.units.filter((u) => u.kind === 'paragraph');
    expect(approvedParagraphs.length).toBeGreaterThan(0);
    expect(
      approvedParagraphs.every(
        (u) => u.reasons.includes('approval_unknown') || u.reasons.includes('not_approved'),
      ),
    ).toBe(true);
    expect(trace.units.filter((u) => u.kind === 'number').every((u) => !u.traceable)).toBe(true);
  });

  it('手書きの数値は常に追跡できない。選定ケースで分母を絞れる', () => {
    const detail = asSnapshotDetail(fy2025());
    const block = detail.blocks[0]!;
    const withHandwritten = {
      ...block,
      body: {
        paragraphs: [
          ...block.body.paragraphs,
          {
            id: 'hand',
            kind: 'paragraph' as const,
            children: [{ t: 'text' as const, text: '排出量は 1,234 t-CO2e でした（架空）。' }],
          },
        ],
      },
    };
    const trace = buildReportTrace({
      blocks: [withHandwritten],
      metricValues: detail.metricValues,
      narrativeVersionsWithEvidence: new Set(),
    });
    const hand = trace.units.filter((u) => u.paragraphId === 'hand' && u.kind === 'number');
    expect(hand.length).toBeGreaterThan(0);
    expect(hand.every((u) => u.reasons.includes('handwritten'))).toBe(true);

    const none = buildReportTrace(
      { blocks: [withHandwritten], metricValues: [], narrativeVersionsWithEvidence: new Set() },
      { selectedCodes: ['存在しない要求事項'] },
    );
    expect(none.summary.all.total).toBe(0);
    expect(none.summary.rate).toBeNull();
  });

  it('節の短縮コードは頭文字で、重なれば番号を足す', () => {
    expect(sectionShortCode('metrics_targets')).toBe('MT');
    expect(sectionShortCode('governance')).toBe('G');
    const codes = blockShortCodes([
      { blockId: 'a', sectionKey: 'governance' },
      { blockId: 'b', sectionKey: 'general' },
    ]);
    expect([...codes.values()]).toEqual(['G', 'G2']);
  });
});
