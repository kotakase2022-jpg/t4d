import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ENGAGEMENT_IDS, ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { FY2025_APPROVED_SNAPSHOT_ID } from '@/lib/fixtures/trial-case';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { ValidationError } from '@/lib/errors/user-facing';
import {
  createSignoff,
  detectSnapshotChanges,
  loadLatestSnapshot,
  loadSignoffReportAttention,
  loadTestingWorkspace,
  signoffReportAttentionOf,
} from '@/lib/services/assurance';
import { shareReportSnapshot, withdrawSharedReport } from '@/lib/services/report-share';
import type { AuthorizationContext, RoleKey, SharedReportCopy, Signoff } from '@/types/domain';

/**
 * Sign-off と共有レポートの結び付け（トライアル対応 NF-23。int:signoff-report-link）。
 *
 *  - Sign-off の確認で選んだ共有中の写しの ID と copy_hash を記録する（任意）
 *  - 同じ案件の共有中の写しだけ（他の案件・取り下げ・改ざんは断る）。DB のトリガ（0050）と同じ条件
 *  - 代理 Sign-off 禁止・段階の権限・抑止条件の既存の規則は変わらない
 *  - Sign-off の後に別の承認版が共有されたら注意を導く（保存しない）
 */

let fixture: FixtureDb;
let db: DemoDbClient;
let copy: SharedReportCopy;

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
const staff = () => firm('assurance-staff@demo.local', ['assurance_staff'], [ENG]);
const manager = () => firm('assurance-manager@demo.local', ['assurance_manager'], [ENG]);
const unassigned = () => firm('assurance-manager@demo.local', ['assurance_manager'], []);

/** Sign-off の抑止条件をすべて外す（assurance-slice.test.ts と同じ手順） */
async function clearBlockers(): Promise<void> {
  for (const issue of await db.select('issues', { where: { engagementId: ENG } })) {
    if (issue.status === 'resolved' || issue.status === 'closed') continue;
    await db.update('issues', issue.id, {
      status: 'resolved',
      resolution: '解消済み',
      resolvedAt: new Date().toISOString(),
    });
  }
  for (const request of await db.select('pbcRequests', { where: { engagementId: ENG } })) {
    if (request.priority === 'critical') {
      await db.update('pbcRequests', request.id, { status: 'accepted' });
    }
  }
  const snapshot = await loadLatestSnapshot(db, ENG);
  if (snapshot) {
    for (const change of await detectSnapshotChanges(db, manager(), snapshot.id)) {
      await db.insert('snapshotChanges', [
        {
          ...change,
          assessment: 'no_impact',
          assessedBy: manager().userId,
          assessedAt: new Date().toISOString(),
        },
      ]);
    }
  }
  const { rows, procedures } = await loadTestingWorkspace(db, manager(), ENG);
  for (const row of rows) {
    for (const procedure of procedures.filter((p) => p.required)) {
      const existing = await db.select('testResults', {
        where: { testId: row.testId, procedureId: procedure.id },
      });
      if (existing.length > 0) continue;
      await db.insert('testResults', [
        {
          id: `${row.testId}-${procedure.id}`,
          testId: row.testId,
          procedureId: procedure.id,
          engagementId: ENG,
          assuranceFirmId: ORG_IDS.aoba,
          result: 'pass',
          recalculationInput: null,
          recalculationResult: null,
          recordedValue: null,
          difference: null,
          note: 'テスト',
          completedBy: staff().userId,
          completedAt: new Date().toISOString(),
        },
      ]);
    }
    await db.update('tests', row.testId, {
      status: 'reviewed',
      preparedBy: staff().userId,
      preparedAt: new Date().toISOString(),
      reviewedBy: manager().userId,
      reviewedAt: new Date().toISOString(),
    });
  }
}

async function signoffsOf(): Promise<Signoff[]> {
  return db.select('signoffs', { where: { engagementId: ENG } });
}

beforeEach(async () => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  copy = await shareReportSnapshot(db, admin(), {
    snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
    engagementId: ENG,
  });
  await clearBlockers();
});

describe('Sign-off に共有レポートを結び付ける', () => {
  it('選んだ共有中の写しの ID と copy_hash を記録し、実行者は本人のまま（代理禁止）', async () => {
    await createSignoff(db, staff(), ENG, 'prepared', '作成完了', {
      sharedReportCopyId: copy.id,
    });
    const [signoff] = await signoffsOf();
    expect(signoff).toBeDefined();
    expect(signoff!.sharedReportCopyId).toBe(copy.id);
    // 内容ハッシュはクライアントから受け取らず、写しの copy_hash（DB のトリガと同じ組）
    expect(signoff!.sharedReportContentHash).toBe(copy.copyHash);
    expect(signoff!.userId).toBe(staff().userId);
    expect(signoff!.signoffStage).toBe('prepared');
    // 監査ログの要約に対象の写しが残る（ID・ハッシュはメタデータ）
    const events = fixture.auditEvents.filter(
      (e) => e.eventType === 'signoff_created' && e.engagementId === ENG,
    );
    expect(events.at(-1)?.afterSummary).toContain('対象の開示レポート');
    expect(events.at(-1)?.metadata).toMatchObject({ sharedReportCopyId: copy.id });
  });

  it('結び付けなければ両方 null（既存の Sign-off と同じ）', async () => {
    await createSignoff(db, staff(), ENG, 'prepared', null);
    const [signoff] = await signoffsOf();
    expect(signoff!.sharedReportCopyId).toBeNull();
    expect(signoff!.sharedReportContentHash).toBeNull();
  });

  it('他の案件の写し・不正な ID は「見つからない」（存在を秘匿）', async () => {
    const foreign: SharedReportCopy = {
      ...copy,
      id: '7f0d7f4a-1111-4222-8333-944444444444',
      engagementId: ENGAGEMENT_IDS.other,
    };
    fixture.sharedReportCopies.push(foreign);
    await expect(
      createSignoff(db, staff(), ENG, 'prepared', null, { sharedReportCopyId: foreign.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      createSignoff(db, staff(), ENG, 'prepared', null, { sharedReportCopyId: 'not-a-uuid' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await signoffsOf()).toHaveLength(0);
  });

  it('企業が取り下げた写しは結び付けられない', async () => {
    await withdrawSharedReport(db, admin(), { copyId: copy.id });
    await expect(
      createSignoff(db, staff(), ENG, 'prepared', null, { sharedReportCopyId: copy.id }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await signoffsOf()).toHaveLength(0);
  });

  it('写しの内容が共有時のハッシュと一致しなければ結び付けられない', async () => {
    const stored = fixture.sharedReportCopies.find((c) => c.id === copy.id)!;
    stored.copy = { ...stored.copy, label: '書き換えた版' };
    await expect(
      createSignoff(db, staff(), ENG, 'prepared', null, { sharedReportCopyId: copy.id }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('段階の権限・案件のメンバーの規則は変わらない', async () => {
    await expect(
      createSignoff(db, staff(), ENG, 'partner_approved', null, { sharedReportCopyId: copy.id }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      createSignoff(db, unassigned(), ENG, 'prepared', null, { sharedReportCopyId: copy.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await signoffsOf()).toHaveLength(0);
  });

  it('前段の Sign-off が無い段階は、写しを選んでも抑止される', async () => {
    await expect(
      createSignoff(db, manager(), ENG, 'reviewed', null, { sharedReportCopyId: copy.id }),
    ).rejects.toThrow(/抑止条件/);
  });
});

describe('Sign-off 後の承認版の共有（注意を導く・保存しない）', () => {
  it('写しを結び付けていなければ注意は出ない', async () => {
    await createSignoff(db, staff(), ENG, 'prepared', null);
    expect(await loadSignoffReportAttention(db, staff(), ENG)).toBeNull();
  });

  it('結び付けた後に取り下げて別の写しが共有されると、注意に両方が出る', async () => {
    await createSignoff(db, staff(), ENG, 'prepared', null, { sharedReportCopyId: copy.id });
    // Sign-off の時刻を過去にして、後の共有と順序を決める（同じミリ秒で並ばないように）
    const [signoff] = await signoffsOf();
    await db.update('signoffs', signoff!.id, { createdAt: '2026-01-01T00:00:00.000Z' });
    expect(await loadSignoffReportAttention(db, staff(), ENG)).toBeNull();

    await withdrawSharedReport(db, admin(), { copyId: copy.id });
    const reshared = await shareReportSnapshot(db, admin(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      engagementId: ENG,
    });
    const attention = await loadSignoffReportAttention(db, staff(), ENG);
    expect(attention).not.toBeNull();
    expect(attention!.signoff.id).toBe(signoff!.id);
    expect(attention!.linkedWithdrawn).toBe(true);
    expect(attention!.newerCopies.map((c) => c.id)).toEqual([reshared.id]);
    // 導くだけで、Sign-off も写しも書き換えない
    const [after] = await signoffsOf();
    expect(after!.sharedReportCopyId).toBe(copy.id);
    expect(after!.sharedReportContentHash).toBe(copy.copyHash);
  });

  it('未アサインの人は注意を読めない', async () => {
    await expect(loadSignoffReportAttention(db, unassigned(), ENG)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('純粋関数: 最新の結び付けた Sign-off より後に共有された共有中の写しだけを数える', () => {
    const base = { ...copy, withdrawnAt: null, withdrawnBy: null };
    const linked = { ...base, id: 'c1', sharedAt: '2026-01-01T00:00:00.000Z' };
    const older = { ...base, id: 'c0', sharedAt: '2025-12-01T00:00:00.000Z' };
    const newer = { ...base, id: 'c2', sharedAt: '2026-03-01T00:00:00.000Z' };
    const newerWithdrawn = {
      ...base,
      id: 'c3',
      sharedAt: '2026-03-02T00:00:00.000Z',
      withdrawnAt: '2026-03-03T00:00:00.000Z',
      withdrawnBy: admin().userId,
    };
    const signoff = (id: string, createdAt: string, copyId: string | null): Signoff => ({
      id,
      engagementId: ENG,
      assuranceFirmId: ORG_IDS.aoba,
      signoffStage: 'prepared',
      userId: staff().userId,
      roleKey: 'assurance_staff',
      version: 1,
      snapshotId: null,
      comment: null,
      createdAt,
      sharedReportCopyId: copyId,
      sharedReportContentHash: copyId ? base.copyHash : null,
    });
    const copies = [linked, older, newer, newerWithdrawn];
    // 結び付けた Sign-off が無ければ null
    expect(
      signoffReportAttentionOf([signoff('s0', '2026-02-01T00:00:00.000Z', null)], copies),
    ).toBeNull();
    const result = signoffReportAttentionOf(
      [
        signoff('s1', '2025-11-01T00:00:00.000Z', 'c0'),
        signoff('s2', '2026-02-01T00:00:00.000Z', 'c1'),
      ],
      copies,
    );
    // 最新の結び付け（s2）を基準に、その後に共有された共有中の写し（c2）だけ。取り下げ済み（c3）は数えない
    expect(result?.signoff.id).toBe('s2');
    expect(result?.newerCopies.map((c) => c.id)).toEqual(['c2']);
    expect(result?.linkedWithdrawn).toBe(false);
    // 後の写しが無く、結び付けた写しも共有中なら注意は無い
    expect(
      signoffReportAttentionOf([signoff('s2', '2026-04-01T00:00:00.000Z', 'c1')], copies),
    ).toBeNull();
  });
});
