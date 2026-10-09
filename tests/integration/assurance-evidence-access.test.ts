import { beforeEach, describe, expect, it } from 'vitest';
import { isCountedInTotals } from '@/lib/domain/boundaries';
import { parseSharedReportCopy } from '@/lib/domain/report-copy';
import { ENGAGEMENT_IDS, ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { FY2025_APPROVED_SNAPSHOT_ID } from '@/lib/fixtures/trial-case';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { shareReportSnapshot, withdrawSharedReport } from '@/lib/services/report-share';
import { canReadEvidence } from '@/lib/storage';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * 保証側が資料の実体を読める範囲（src/lib/storage/index.ts canReadEvidence。T3 の依頼）。
 *
 *  - Data Room の行は許諾×承認から導く（NF-22。data-room-sync.ts）。新しく共有された Data Point の資料も、
 *    指標の許諾が Evidence を含むときは読める（以前は data_room_items だけを見ていて読めなかった）
 *  - 共有中の開示レポートの写しが引用する資料の版は、Evidence を含む許諾があるときだけ読める
 *    （0050 の t4d.assurance_can_read_shared_file_version と同じ）。取り下げると読めない
 *  - 案件のメンバーでない・企業が取り下げた Data Point の資料は読めない
 */

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

const ENG = ENGAGEMENT_IDS.main;
/** どの Data Point・写しにも紐付いていない、この検査のためだけの資料の版 */
const NEW_VERSION = {
  id: fid('file_version', 'assurance-evidence-test/1'),
  organizationId: ORG_IDS.aomi,
};

function firm(engagementIds: string[]): AuthorizationContext {
  return {
    userId: userId('assurance-manager@demo.local'),
    email: 'assurance-manager@demo.local',
    displayName: 'assurance-manager@demo.local',
    workspace: {
      organizationId: ORG_IDS.aoba,
      organizationType: 'assurance_firm',
      organizationName: 'テスト',
      roleKeys: ['assurance_manager'] as RoleKey[],
      unitScopeIds: [],
    },
    engagementIds,
    demo: true,
  };
}

function admin(): AuthorizationContext {
  return {
    userId: userId('enterprise-admin@demo.local'),
    email: 'enterprise-admin@demo.local',
    displayName: 'enterprise-admin@demo.local',
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: 'テスト',
      roleKeys: ['enterprise_admin'],
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

/** 許諾の範囲（指標・組織・期間）にあるが、まだ承認していない FY2026 の Data Point */
function pendingGrantedDataPoint() {
  const granted = (subject: string) =>
    new Set(
      fixture.grants
        .filter((g) => g.engagementId === ENG && g.subjectType === subject && !g.revokedAt)
        .map((g) => g.subjectId),
    );
  const metrics = granted('metric');
  const units = granted('organization_unit');
  return fixture.dataPoints.find(
    (dp) =>
      dp.organizationId === ORG_IDS.aomi &&
      dp.reportingPeriodId === PERIOD_IDS.fy2026 &&
      dp.status !== 'approved' &&
      dp.deletedAt === null &&
      isCountedInTotals(dp) &&
      metrics.has(dp.metricId) &&
      units.has(dp.unitId) &&
      !fixture.dataRoomItems.some((i) => i.engagementId === ENG && i.sourceId === dp.id),
  );
}

function linkEvidence(dataPointId: string): void {
  const now = new Date().toISOString();
  fixture.evidenceLinks.push({
    id: fid('evidence_link', `${dataPointId}/assurance-evidence-test`),
    organizationId: ORG_IDS.aomi,
    fileVersionId: NEW_VERSION.id,
    targetType: 'data_point',
    targetId: dataPointId,
    page: null,
    cellRef: null,
    fragmentId: null,
    sourceUrl: null,
    coveragePeriodStart: null,
    coveragePeriodEnd: null,
    obtainedAt: null,
    note: null,
    createdAt: now,
    updatedAt: now,
    createdBy: null,
    updatedBy: null,
  });
}

describe('Data Room の導出に合わせた資料の閲覧', () => {
  it('許諾の範囲で新しく承認した Data Point の資料は、指標の許諾が Evidence を含めば読める', async () => {
    const dp = pendingGrantedDataPoint();
    expect(dp, '許諾の範囲の未承認の Data Point が Fixture に無い').toBeDefined();
    linkEvidence(dp!.id);
    const metricGrant = fixture.grants.find(
      (g) =>
        g.engagementId === ENG &&
        g.subjectType === 'metric' &&
        g.subjectId === dp!.metricId &&
        !g.revokedAt,
    )!;
    metricGrant.includesEvidence = true;

    // 未承認のあいだは Data Room に無いので読めない
    expect(await canReadEvidence(db, firm([ENG]), NEW_VERSION, ENG)).toBe(false);
    const now = new Date().toISOString();
    await db.update('dataPoints', dp!.id, { status: 'approved', approvedAt: now });
    expect(await canReadEvidence(db, firm([ENG]), NEW_VERSION, ENG)).toBe(true);

    // 指標の許諾が Evidence を含まなければ読めない。案件のメンバーでなければ読めない
    metricGrant.includesEvidence = false;
    expect(await canReadEvidence(db, firm([ENG]), NEW_VERSION, ENG)).toBe(false);
    metricGrant.includesEvidence = true;
    expect(await canReadEvidence(db, firm([]), NEW_VERSION, ENG)).toBe(false);

    // 企業が Data Room から明示的に取り下げた Data Point の資料は読めない（取り下げの記録を守る）
    const template = fixture.dataRoomItems.find((i) => i.engagementId === ENG)!;
    fixture.dataRoomItems.push({
      ...template,
      id: fid('data_room_item', `${dp!.id}/withdrawn-test`),
      sourceType: 'data_point',
      sourceId: dp!.id,
      withdrawnAt: now,
    });
    expect(await canReadEvidence(db, firm([ENG]), NEW_VERSION, ENG)).toBe(false);
  });
});

describe('共有中の開示レポートの写しが引用する資料（0050 と同じ規則）', () => {
  it('Evidence を含む許諾があれば読め、許諾が Evidence を含まない・取り下げると読めない', async () => {
    const copy = await shareReportSnapshot(db, admin(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      engagementId: ENG,
    });
    // 写しの引用位置に、この検査の資料の版を足す（FY2025 の Fixture の写しには引用位置が無いため）
    const row = fixture.sharedReportCopies.find((c) => c.id === copy.id)!;
    const content = parseSharedReportCopy(row.copy)!;
    row.copy = {
      ...(row.copy as Record<string, unknown>),
      anchors: [
        ...content.anchors,
        {
          ...(content.anchors[0] ?? {}),
          id: fid('source_anchor', 'test'),
          fileVersionId: NEW_VERSION.id,
        },
      ],
    } as typeof row.copy;

    const grants = fixture.grants.filter((g) => g.engagementId === ENG && !g.revokedAt);
    for (const g of grants) g.includesEvidence = false;
    expect(await canReadEvidence(db, firm([ENG]), NEW_VERSION, ENG)).toBe(false);
    grants[0]!.includesEvidence = true;
    expect(await canReadEvidence(db, firm([ENG]), NEW_VERSION, ENG)).toBe(true);
    // 別の案件のメンバー（この案件のメンバーでない）は読めない
    expect(await canReadEvidence(db, firm([ENGAGEMENT_IDS.other]), NEW_VERSION, ENG)).toBe(false);

    await withdrawSharedReport(db, admin(), { copyId: copy.id });
    expect(await canReadEvidence(db, firm([ENG]), NEW_VERSION, ENG)).toBe(false);
  });
});
