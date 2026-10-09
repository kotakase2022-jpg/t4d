import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ENGAGEMENT_IDS, ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { FY2025_APPROVED_SNAPSHOT_ID } from '@/lib/fixtures/trial-case';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  buildSharedReportCopy,
  copyHasInternalContent,
  MASKED_FILE_LABEL,
  parseSharedReportCopy,
  sharedReportCopyHash,
} from '@/lib/domain/report-copy';
import { ValidationError } from '@/lib/errors/user-facing';
import {
  listSharedReports,
  listSharedReportsForClient,
  loadSharedReport,
  shareReportSnapshot,
  withdrawSharedReport,
} from '@/lib/services/report-share';
import {
  asSnapshotDetail,
  createReviewDraftSnapshot,
  verifySnapshotIntegrity,
} from '@/lib/services/report-snapshot';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * 承認済みレポートの保証側への共有（トライアル対応 NF-20。int:report-share）。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

const ENG = ENGAGEMENT_IDS.main;

function enterprise(email: string, roleKeys: RoleKey[], organizationId: string = ORG_IDS.aomi) {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType: 'enterprise',
      organizationName: 'テスト',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  } satisfies AuthorizationContext;
}

function firm(
  email: string,
  roleKeys: RoleKey[],
  engagementIds: string[],
  organizationId: string = ORG_IDS.aoba,
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType: 'assurance_firm',
      organizationName: 'テスト',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds,
    demo: true,
  };
}

const admin = () => enterprise('enterprise-admin@demo.local', ['enterprise_admin']);
const approver = () => enterprise('approver@demo.local', ['approver', 'reviewer']);
const author = () => enterprise('sustainability@demo.local', ['sustainability_manager']);
const otherTenant = () =>
  enterprise('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);
const manager = () => firm('assurance-manager@demo.local', ['assurance_manager'], [ENG]);
/** 未アサインの法人管理者 */
const firmAdmin = () => firm('assurance-admin@demo.local', ['assurance_admin'], []);
/** 同じ法人のマネージャーだが未アサイン */
const unassignedManager = () => firm('assurance-manager@demo.local', ['assurance_manager'], []);
/** 別法人 */
const otherFirm = () =>
  firm(
    'other-assurance-manager@demo.local',
    ['assurance_manager'],
    [ENGAGEMENT_IDS.other],
    ORG_IDS.kurobe,
  );

describe('共有（企業側）', () => {
  it('承認済みスナップショットを案件へ共有し、社内向けのものを除いた写しを作る', async () => {
    const snapshot = fixture.reportSnapshots.find((s) => s.id === FY2025_APPROVED_SNAPSHOT_ID)!;
    expect(verifySnapshotIntegrity(snapshot)).toBe(true);
    const copy = await shareReportSnapshot(db, admin(), {
      snapshotId: snapshot.id,
      engagementId: ENG,
    });
    expect(copy.snapshotId).toBe(snapshot.id);
    expect(copy.snapshotContentHash).toBe(snapshot.contentHash);
    expect(copy.sharedBy).toBe(admin().userId);
    expect(copy.withdrawnAt).toBeNull();
    const content = parseSharedReportCopy(copy.copy)!;
    expect(content).not.toBeNull();
    expect(copyHasInternalContent(content)).toBe(false);
    // 同じスナップショットからは同じ写し（別インスタンスで作り直しても copy_hash が一致する）
    expect(sharedReportCopyHash(buildSharedReportCopy(asSnapshotDetail(snapshot)))).toBe(
      copy.copyHash,
    );
    expect(fixture.auditEvents.some((e) => e.eventType === 'report_shared')).toBe(true);
  });

  it('非公開資料の名前・引用文は写しに載せない', () => {
    const snapshot = asSnapshotDetail(
      fixture.reportSnapshots.find((s) => s.id === FY2025_APPROVED_SNAPSHOT_ID)!,
    );
    const withAnchor = {
      ...snapshot,
      anchors: [
        {
          sourceAnchorId: 'a1',
          fileVersionId: 'f1',
          fileId: 'file1',
          fileName: '取締役会議事録（架空）.pdf',
          editionLabel: null,
          anchorKind: 'pdf_page',
          page: 1,
          locator: null,
          quoteText: '社外秘の引用',
          usagePurpose: null,
          confidentiality: 'confidential',
        },
      ],
    } as unknown as typeof snapshot;
    const content = buildSharedReportCopy(withAnchor);
    expect(content.anchors[0]!.fileName).toBe(MASKED_FILE_LABEL);
    expect(content.anchors[0]!.quoteText).toBe('');
    expect(JSON.stringify(content)).not.toContain('取締役会議事録（架空）.pdf');
  });

  it('草稿（review_draft）は共有できない', async () => {
    const draft = await createReviewDraftSnapshot(db, author(), IDS.projects.fy2026);
    await expect(
      shareReportSnapshot(db, admin(), { snapshotId: draft.id, engagementId: ENG }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('二重に共有しない・許諾の無い案件・他社の案件には共有できない', async () => {
    await shareReportSnapshot(db, admin(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      engagementId: ENG,
    });
    await expect(
      shareReportSnapshot(db, admin(), {
        snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
        engagementId: ENG,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    // 他社がクライアントの案件
    await expect(
      shareReportSnapshot(db, admin(), {
        snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
        engagementId: ENGAGEMENT_IDS.other,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('許諾をすべて取り消した案件には共有できない', async () => {
    for (const g of fixture.grants.filter((x) => x.engagementId === ENG)) {
      await db.update('grants', g.id, { revokedAt: new Date().toISOString() });
    }
    await expect(
      shareReportSnapshot(db, admin(), {
        snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
        engagementId: ENG,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('許諾の管理の権限が無い役割は共有できない。他テナントのスナップショットは見つからない', async () => {
    await expect(
      shareReportSnapshot(db, approver(), {
        snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
        engagementId: ENG,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      shareReportSnapshot(db, otherTenant(), {
        snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
        engagementId: ENG,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('閲覧（保証側）と取り下げ', () => {
  it('案件のメンバーは写しを開ける。取り下げると見つからない（写しは消さない）', async () => {
    const copy = await shareReportSnapshot(db, admin(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      engagementId: ENG,
    });
    const listed = await listSharedReports(db, manager(), ENG);
    expect(listed.map((c) => c.id)).toEqual([copy.id]);
    const loaded = await loadSharedReport(db, manager(), { engagementId: ENG, copyId: copy.id });
    expect(loaded.integrityOk).toBe(true);
    expect(loaded.content.metricValues.length).toBeGreaterThan(0);

    await withdrawSharedReport(db, admin(), { copyId: copy.id });
    await expect(
      loadSharedReport(db, manager(), { engagementId: ENG, copyId: copy.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await listSharedReports(db, manager(), ENG)).toEqual([]);
    // 企業側の一覧には取り下げ済みとして残る
    const client = await listSharedReportsForClient(db, admin());
    expect(client).toHaveLength(1);
    expect(client[0]!.withdrawn).toBe(true);
    expect(fixture.sharedReportCopies).toHaveLength(1);
    // 取り下げは 1 回だけ
    await expect(withdrawSharedReport(db, admin(), { copyId: copy.id })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('未アサイン・別法人は読めない', async () => {
    const copy = await shareReportSnapshot(db, admin(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      engagementId: ENG,
    });
    // 法人管理者は案件の閲覧権限を持たない（権限の判定が先）
    await expect(listSharedReports(db, firmAdmin(), ENG)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    // 案件の閲覧権限はあるが未アサイン
    await expect(listSharedReports(db, unassignedManager(), ENG)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      loadSharedReport(db, otherFirm(), { engagementId: ENG, copyId: copy.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // 別の案件の ID と組み合わせても見つからない
    await expect(
      loadSharedReport(db, otherFirm(), {
        engagementId: ENGAGEMENT_IDS.other,
        copyId: copy.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('保存された写しが壊れていれば integrityOk=false（画面は内容を出さない）', async () => {
    const copy = await shareReportSnapshot(db, admin(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      engagementId: ENG,
    });
    const row = fixture.sharedReportCopies.find((c) => c.id === copy.id)!;
    const content = parseSharedReportCopy(row.copy)!;
    row.copy = { ...content, label: '改ざん' } as unknown as Record<string, unknown>;
    const loaded = await loadSharedReport(db, manager(), { engagementId: ENG, copyId: copy.id });
    expect(loaded.integrityOk).toBe(false);
  });

  it('他社は取り下げられない', async () => {
    const copy = await shareReportSnapshot(db, admin(), {
      snapshotId: FY2025_APPROVED_SNAPSHOT_ID,
      engagementId: ENG,
    });
    await expect(
      withdrawSharedReport(db, otherTenant(), { copyId: copy.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
