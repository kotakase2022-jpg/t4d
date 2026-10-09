import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { ENGAGEMENT_IDS, ORG_IDS, PERIOD_IDS, UNIT_IDS, metricId } from '@/lib/fixtures/dataset';
import { fid } from '@/lib/fixtures/ids';
import { isCountedInTotals } from '@/lib/domain/boundaries';
import {
  deriveSharedDataPoints,
  listSharedDataPoints,
  sharedSince,
} from '@/lib/services/data-room-sync';

/**
 * Data Room の許諾・承認への同期（トライアル対応 NF-22）。
 *
 * 導出の結果が現在の Fixture の data_room_items・監査法人の SNAP-1 と一致することを先に固定する
 * （画面を導出へ置き換えても、既存の件数・母集団・サンプルが変わらないことの保証）。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

const ENG = ENGAGEMENT_IDS.main;

function sharedIds(rows: Awaited<ReturnType<typeof listSharedDataPoints>>): string[] {
  return rows.map((r) => r.dataPoint.id).sort();
}

describe('Fixture の不変条件', () => {
  it('導出した共有中の Data Point は、Fixture の data_room_items（Data Point・取り下げなし）と一致する', async () => {
    const derived = sharedIds(await listSharedDataPoints(db, ENG));
    const items = fixture.dataRoomItems
      .filter((i) => i.engagementId === ENG && i.sourceType === 'data_point' && !i.withdrawnAt)
      .map((i) => i.sourceId)
      .sort();
    expect(derived.length).toBeGreaterThan(0);
    expect(derived).toEqual(items);
  });

  it('SNAP-1 の固定対象は導出結果と同じ Data Point の集合（件数も一致）', async () => {
    const derived = sharedIds(await listSharedDataPoints(db, ENG));
    const snapshotId = fid('snapshot', `${ENG}/SNAP-1`);
    const snap = fixture.snapshots.find((s) => s.id === snapshotId);
    expect(snap).toBeDefined();
    const frozen = fixture.snapshotItems
      .filter((i) => i.snapshotId === snapshotId)
      .map((i) => i.sourceId)
      .sort();
    expect(frozen).toEqual(derived);
    expect(snap!.itemCount).toBe(derived.length);
  });

  it('内部取引の明細行・未承認・他社の Data Point は入らない', async () => {
    const rows = await listSharedDataPoints(db, ENG);
    for (const r of rows) {
      expect(r.dataPoint.status).toBe('approved');
      expect(r.dataPoint.organizationId).toBe(ORG_IDS.aomi);
      expect(isCountedInTotals(r.dataPoint)).toBe(true);
      expect(r.dataPoint.deletedAt).toBeNull();
    }
  });

  it('共有日時は許諾日時と承認日時の遅い方', async () => {
    const rows = await listSharedDataPoints(db, ENG);
    const grantsById = new Map(fixture.grants.map((g) => [g.id, g]));
    for (const r of rows) {
      const latestGrant = r.grantIds
        .map((id) => grantsById.get(id)!.grantedAt)
        .reduce((a, b) => (a >= b ? a : b));
      const expected =
        r.dataPoint.approvedAt && r.dataPoint.approvedAt > latestGrant
          ? r.dataPoint.approvedAt
          : latestGrant;
      expect(r.sharedAt).toBe(expected);
    }
  });

  it('別の案件（他法人）には自社の許諾が無い Data Point は出ない', async () => {
    const other = await listSharedDataPoints(db, ENGAGEMENT_IDS.other);
    const otherGrants = fixture.grants.filter(
      (g) => g.engagementId === ENGAGEMENT_IDS.other && g.revokedAt === null,
    );
    // 許諾が無ければ 0 件。許諾があれば導出はその案件の許諾だけで決まる
    const engagement = fixture.engagements.find((e) => e.id === ENGAGEMENT_IDS.other)!;
    expect(other.map((r) => r.dataPoint.id).sort()).toEqual(
      deriveSharedDataPoints(engagement, otherGrants, fixture.dataPoints)
        .map((r) => r.dataPoint.id)
        .sort(),
    );
  });

  it('存在しない・不正な案件 ID は空', async () => {
    expect(await listSharedDataPoints(db, 'not-a-uuid')).toEqual([]);
    expect(await listSharedDataPoints(db, fid('engagement', 'missing'))).toEqual([]);
  });
});

describe('許諾と承認への同期（読み取り時に導出・書き込みなし）', () => {
  it('期間の許諾を足すと、次の表示でその期間の承認済みデータが出る', async () => {
    const before = await listSharedDataPoints(db, ENG);
    expect(before.some((r) => r.dataPoint.reportingPeriodId === PERIOD_IDS.fy2025)).toBe(false);
    const grantedOf = (subject: 'metric' | 'organization_unit') =>
      new Set(
        fixture.grants
          .filter((g) => g.engagementId === ENG && g.subjectType === subject && !g.revokedAt)
          .map((g) => g.subjectId),
      );
    const metrics = grantedOf('metric');
    const units = grantedOf('organization_unit');
    const fy2025Approved = fixture.dataPoints.filter(
      (dp) =>
        dp.organizationId === ORG_IDS.aomi &&
        dp.reportingPeriodId === PERIOD_IDS.fy2025 &&
        dp.status === 'approved' &&
        dp.deletedAt === null &&
        isCountedInTotals(dp) &&
        metrics.has(dp.metricId) &&
        units.has(dp.unitId),
    );
    expect(fy2025Approved.length).toBeGreaterThan(0);
    // 欧州は組織の許諾が無いので、期間を足しても出ない
    expect(units.has(UNIT_IDS.eu)).toBe(false);

    const now = new Date().toISOString();
    const template = fixture.grants.find(
      (g) => g.engagementId === ENG && g.subjectType === 'reporting_period',
    )!;
    await db.insert('grants', [
      {
        ...template,
        id: fid('grant', `${ENG}/reporting_period/FY2025/test`),
        subjectId: PERIOD_IDS.fy2025,
        grantedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const after = await listSharedDataPoints(db, ENG);
    const added = after.filter((r) => r.dataPoint.reportingPeriodId === PERIOD_IDS.fy2025);
    expect(added.map((r) => r.dataPoint.id).sort()).toEqual(fy2025Approved.map((d) => d.id).sort());
    expect(added.some((r) => r.dataPoint.unitId === UNIT_IDS.eu)).toBe(false);
    // 共有日時は新しい許諾の日時（承認より後）。「前回表示以降」の絞込はこの行だけ
    for (const r of added) expect(r.sharedAt).toBe(now);
    const lastSeen = before
      .map((r) => r.sharedAt)
      .sort()
      .at(-1)!;
    expect(
      sharedSince(after, lastSeen)
        .map((r) => r.dataPoint.id)
        .sort(),
    ).toEqual(added.map((r) => r.dataPoint.id).sort());
  });

  it('指標の許諾を取り消すと消える', async () => {
    const wasteMetric = metricId('AOMI', 'waste');
    const before = await listSharedDataPoints(db, ENG);
    expect(before.some((r) => r.dataPoint.metricId === wasteMetric)).toBe(true);
    const grant = fixture.grants.find(
      (g) => g.engagementId === ENG && g.subjectType === 'metric' && g.subjectId === wasteMetric,
    )!;
    await db.update('grants', grant.id, { revokedAt: new Date().toISOString() });
    const after = await listSharedDataPoints(db, ENG);
    expect(after.some((r) => r.dataPoint.metricId === wasteMetric)).toBe(false);
    expect(after.length).toBeLessThan(before.length);
  });

  it('未承認のデータは出ず、承認すると出る（SNAP-1 は変わらない）', async () => {
    const before = await listSharedDataPoints(db, ENG);
    const beforeIds = new Set(before.map((r) => r.dataPoint.id));
    const grantedMetrics = new Set(
      fixture.grants
        .filter((g) => g.engagementId === ENG && g.subjectType === 'metric' && !g.revokedAt)
        .map((g) => g.subjectId),
    );
    const grantedUnits = new Set(
      fixture.grants
        .filter((g) => g.engagementId === ENG && g.subjectType === 'organization_unit')
        .map((g) => g.subjectId),
    );
    const pending = fixture.dataPoints.find(
      (dp) =>
        dp.organizationId === ORG_IDS.aomi &&
        dp.reportingPeriodId === PERIOD_IDS.fy2026 &&
        dp.status !== 'approved' &&
        dp.deletedAt === null &&
        isCountedInTotals(dp) &&
        grantedMetrics.has(dp.metricId) &&
        grantedUnits.has(dp.unitId),
    );
    expect(pending).toBeDefined();
    expect(beforeIds.has(pending!.id)).toBe(false);

    const snapshotId = fid('snapshot', `${ENG}/SNAP-1`);
    const frozenBefore = fixture.snapshotItems.filter((i) => i.snapshotId === snapshotId).length;
    const approvedAt = new Date().toISOString();
    await db.update('dataPoints', pending!.id, { status: 'approved', approvedAt });
    const after = await listSharedDataPoints(db, ENG);
    const row = after.find((r) => r.dataPoint.id === pending!.id);
    expect(row).toBeDefined();
    expect(row!.sharedAt).toBe(approvedAt);
    // 導出は書き込まない（data_room_items も SNAP-1 も変わらない）
    expect(fixture.snapshotItems.filter((i) => i.snapshotId === snapshotId).length).toBe(
      frozenBefore,
    );
    expect(
      fixture.dataRoomItems.some((i) => i.engagementId === ENG && i.sourceId === pending!.id),
    ).toBe(false);
  });
});
