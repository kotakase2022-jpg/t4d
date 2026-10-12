import { beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '@/lib/authorization/can';
import {
  ENGAGEMENT_IDS,
  ORG_IDS,
  PERIOD_IDS,
  dataPointId,
  metricId,
  userId,
} from '@/lib/fixtures/dataset';
import { fid } from '@/lib/fixtures/ids';
import { FY2025_APPROVED_SNAPSHOT_ID } from '@/lib/fixtures/trial-case';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  createSnapshot,
  DATA_ROOM_VIEW_RESOURCE,
  listDataRoomDataPoints,
  loadDataRoom,
  previousSessionViewAt,
  recordDataRoomView,
} from '@/lib/services/assurance';
import { listSharedDataPoints } from '@/lib/services/data-room-sync';
import { shareReportSnapshot, withdrawSharedReport } from '@/lib/services/report-share';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * Data Room の画面・Snapshot・資料依頼の対象を、許諾と承認からの導出（NF-22）へ置き換えた部分
 * （int:data-room-sync の画面部分）と、Data Room の閲覧記録（NF-26）。
 *
 * 導出そのものの規則（許諾×承認・内部取引の除外・共有日時）は tests/integration/data-room-sync.test.ts。
 * ここでは画面が使う loadDataRoom・createSnapshot・listDataRoomDataPoints がそれと同じ集合を使い、
 * data_room_items の取り下げの記録を守り、開示レポート（写し）を「取得元: 開示レポート」として並べることを固定する。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

const ENG = ENGAGEMENT_IDS.main;

function firm(email: string, roleKeys: RoleKey[], engagementIds: string[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aoba,
      organizationType: 'assurance_firm',
      organizationName: 'テスト',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds,
    demo: true,
  };
}

const admin = (): AuthorizationContext => ({
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
});
const manager = () => firm('assurance-manager@demo.local', ['assurance_manager'], [ENG]);
const unassigned = () => firm('assurance-manager@demo.local', ['assurance_manager'], []);

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

function ids(list: Array<{ dataPointId: string }>): string[] {
  return list.map((r) => r.dataPointId).sort();
}

describe('Data Room の行は導出と同じ集合', () => {
  it('画面の行は listSharedDataPoints（許諾×承認）と一致し、Fixture の件数（SNAP-1）を変えない', async () => {
    const { rows } = await loadDataRoom(db, manager(), ENG);
    const derived = (await listSharedDataPoints(db, ENG)).map((r) => r.dataPoint.id).sort();
    expect(ids(rows)).toEqual(derived);
    const snap = fixture.snapshots.find((s) => s.id === fid('snapshot', `${ENG}/SNAP-1`))!;
    expect(rows).toHaveLength(snap.itemCount);
    // すべて承認済み（クライアントの承認の列は導出元の状態）
    expect(rows.every((r) => r.clientStatus === 'approved')).toBe(true);
    expect(rows.every((r) => typeof r.includesEvidence === 'boolean')).toBe(true);
  });

  it('期間の許諾を足すと、次の表示と Snapshot の固定の対象に入る（書き込みなしで同期）', async () => {
    const before = await loadDataRoom(db, manager(), ENG);
    const template = fixture.grants.find(
      (g) => g.engagementId === ENG && g.subjectType === 'reporting_period',
    )!;
    const now = new Date().toISOString();
    await db.insert('grants', [
      {
        ...template,
        id: fid('grant', `${ENG}/reporting_period/FY2025/screen`),
        subjectId: PERIOD_IDS.fy2025,
        grantedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const after = await loadDataRoom(db, manager(), ENG);
    expect(after.rows.length).toBeGreaterThan(before.rows.length);
    const added = after.rows.filter(
      (r) => !before.rows.some((b) => b.dataPointId === r.dataPointId),
    );
    expect(added.length).toBeGreaterThan(0);
    for (const row of added) expect(row.sharedAt).toBe(now);
    // 新しく出た行はまだ固定されていない
    expect(added.every((r) => !r.snapshotIncluded)).toBe(true);
    const itemsBefore = fixture.dataRoomItems.length;

    const snapshot = await createSnapshot(db, manager(), ENG, 'SNAP-同期');
    expect(snapshot.itemCount).toBe(after.rows.length);
    const frozen = fixture.snapshotItems
      .filter((i) => i.snapshotId === snapshot.id)
      .map((i) => i.sourceId)
      .sort();
    expect(frozen).toEqual(ids(after.rows));
    // 導出は data_room_items に行を足さない
    expect(fixture.dataRoomItems.length).toBe(itemsBefore);
  });

  it('指標（水使用量）の許諾を足しても未承認のデータは出ず、承認すると次の表示で出る（e2e:grant-lifecycle の続き）', async () => {
    const water = metricId('AOMI', 'water');
    const before = await loadDataRoom(db, manager(), ENG);
    expect(before.rows.some((r) => r.metric?.id === water)).toBe(false);
    const template = fixture.grants.find(
      (g) => g.engagementId === ENG && g.subjectType === 'metric',
    )!;
    const now = new Date().toISOString();
    await db.insert('grants', [
      {
        ...template,
        id: fid('grant', `${ENG}/metric/water/screen`),
        subjectId: water,
        grantedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    // FY2026 の水使用量は Fixture では未承認（レビュー中・差戻し）。許諾だけでは出ない
    const granted = await loadDataRoom(db, manager(), ENG);
    expect(granted.rows.some((r) => r.metric?.id === water)).toBe(false);

    const hqWater = dataPointId('HQ', 'water', 'FY2026');
    const approvedAt = new Date().toISOString();
    await db.update('dataPoints', hqWater, { status: 'approved', approvedAt });
    const after = await loadDataRoom(db, manager(), ENG);
    const rows = after.rows.filter((r) => r.metric?.id === water);
    expect(rows.map((r) => r.dataPointId)).toEqual([hqWater]);
    expect(rows[0]!.metric?.name).toBe('水使用量');
    expect(rows[0]!.sharedAt).toBe(approvedAt);
  });

  it('企業が取り下げた記録（data_room_items.withdrawn_at）は守る（表示・固定・資料依頼の対象から外す）', async () => {
    const target = metricId('AOMI', 'scope1');
    const before = await loadDataRoom(db, manager(), ENG);
    const scope1 = before.rows.filter((r) => r.metric?.id === target);
    expect(scope1.length).toBeGreaterThan(0);
    for (const item of fixture.dataRoomItems.filter((i) => i.engagementId === ENG)) {
      if (scope1.some((r) => r.dataPointId === item.sourceId)) {
        await db.update('dataRoomItems', item.id, { withdrawnAt: new Date().toISOString() });
      }
    }
    const after = await loadDataRoom(db, manager(), ENG);
    expect(after.rows.filter((r) => r.metric?.id === target)).toHaveLength(0);
    const candidates = await listDataRoomDataPoints(db, ENG);
    expect(candidates.some((r) => r.dataPoint.metricId === target)).toBe(false);
    const snapshot = await createSnapshot(db, manager(), ENG, 'SNAP-取り下げ後');
    expect(snapshot.itemCount).toBe(after.rows.length);
  });

  it('許諾をすべて取り消すと 0 件になり、Snapshot は固定できない', async () => {
    for (const g of fixture.grants.filter((g) => g.engagementId === ENG)) {
      await db.update('grants', g.id, { revokedAt: new Date().toISOString() });
    }
    const { rows } = await loadDataRoom(db, manager(), ENG);
    expect(rows).toHaveLength(0);
    await expect(createSnapshot(db, manager(), ENG, 'X')).rejects.toThrow(
      'Data Room に共有された対象がありません。',
    );
  });

  it('未アサインの人は Data Room を読めない（存在を秘匿）', async () => {
    await expect(loadDataRoom(db, unassigned(), ENG)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      recordDataRoomView(db, unassigned(), ENG, { dataPoints: 0, reports: 0 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('取得元: 開示レポート（NF-20）', () => {
  it('企業が共有した写しが Data Room に並び、取り下げると消える', async () => {
    expect((await loadDataRoom(db, manager(), ENG)).reports).toHaveLength(0);
    const copy = await shareReportSnapshot(db, admin(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      engagementId: ENG,
    });
    const shared = await loadDataRoom(db, manager(), ENG);
    expect(shared.reports.map((r) => r.copyId)).toEqual([copy.id]);
    expect(shared.reports[0]!.label).toMatch(/^No\.\d+ /);
    expect(shared.reports[0]!.frameworkNames.length).toBeGreaterThan(0);
    expect(shared.reports[0]!.copyHash).toBe(copy.copyHash);
    // 写しは Snapshot の固定の対象ではない（非財務データの件数は変わらない）
    expect(shared.rows).toHaveLength((await listDataRoomDataPoints(db, ENG)).length);

    await withdrawSharedReport(db, admin(), { copyId: copy.id });
    expect((await loadDataRoom(db, manager(), ENG)).reports).toHaveLength(0);
  });

  it('案件の閲覧権限が無ければ写しの行は出さない（Data Point の行はメンバーとして読める）', async () => {
    await shareReportSnapshot(db, admin(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      engagementId: ENG,
    });
    const noRead = firm('assurance-staff@demo.local', ['assurance_admin'], [ENG]);
    const view = await loadDataRoom(db, noRead, ENG);
    expect(view.reports).toHaveLength(0);
    expect(view.rows.length).toBeGreaterThan(0);
  });
});

describe('Data Room の閲覧記録（NF-26。1 画面 1 件・要約だけ）', () => {
  it('表示ごとに record_viewed を 1 件残し、前回の表示日時を返す', async () => {
    const viewed = () =>
      fixture.auditEvents.filter(
        (e) =>
          e.eventType === 'record_viewed' &&
          e.engagementId === ENG &&
          e.resourceType === DATA_ROOM_VIEW_RESOURCE,
      );
    expect(viewed()).toHaveLength(0);
    const first = await recordDataRoomView(db, manager(), ENG, { dataPoints: 12, reports: 1 });
    expect(first.previousViewedAt).toBeNull();
    expect(viewed()).toHaveLength(1);
    const event = viewed()[0]!;
    expect(event.actorUserId).toBe(manager().userId);
    // 要約は件数だけ（指標名・値を入れない）
    expect(event.afterSummary).toBe('Data Room を表示（非財務データ 12 件・開示レポート 1 件）');
    expect(event.metadata).toEqual({});

    // 続けて表示した（検索・絞込・ページ送り・再読込）記録は同じ閲覧。「前回」を数秒前の自分の表示にしない
    const second = await recordDataRoomView(db, manager(), ENG, { dataPoints: 12, reports: 1 });
    expect(second.previousViewedAt).toBeNull();
    expect(viewed()).toHaveLength(2);

    // 前の閲覧（2 時間前）があれば、それが「前回表示」。同じ閲覧の中で何度表示しても変わらない
    const earlier = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    fixture.auditEvents.push({
      ...event,
      id: '7a1c0d6e-0000-4000-8000-0000000d0001',
      createdAt: earlier,
    });
    const third = await recordDataRoomView(db, manager(), ENG, { dataPoints: 12, reports: 1 });
    expect(third.previousViewedAt).toBe(earlier);
    const fourth = await recordDataRoomView(db, manager(), ENG, { dataPoints: 12, reports: 1 });
    expect(fourth.previousViewedAt).toBe(earlier);
  });

  it('前回の閲覧: 間が 30 分以内で続く表示を 1 回の閲覧にまとめ、その前の閲覧の最後の時刻を返す', () => {
    const now = '2026-10-12T10:00:00.000Z';
    expect(previousSessionViewAt([], now)).toBeNull();
    // 5 分おきに続く表示（今回の閲覧）と、前日の閲覧の最後
    expect(
      previousSessionViewAt(
        [
          '2026-10-12T09:55:00.000Z',
          '2026-10-12T09:50:00.000Z',
          '2026-10-12T09:25:00.000Z',
          '2026-10-11T17:00:00.000Z',
          '2026-10-11T16:50:00.000Z',
        ],
        now,
      ),
    ).toBe('2026-10-11T17:00:00.000Z');
    // 最後の表示から 30 分を超えて空いていれば、それが前回
    expect(previousSessionViewAt(['2026-10-12T09:00:00.000Z'], now)).toBe(
      '2026-10-12T09:00:00.000Z',
    );
  });

  it('前回の表示日時は本人の記録だけから取る（他の人の閲覧で変わらない）', async () => {
    const other = firm('assurance-partner@demo.local', ['engagement_partner'], [ENG]);
    await recordDataRoomView(db, other, ENG, { dataPoints: 1, reports: 0 });
    const mine = await recordDataRoomView(db, manager(), ENG, { dataPoints: 1, reports: 0 });
    expect(mine.previousViewedAt).toBeNull();
  });
});
