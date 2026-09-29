import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError } from '@/lib/authorization/can';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { loadKpiSnapshotComparison } from '@/lib/services/kpi';
import {
  createReviewDraftSnapshot,
  listOrganizationSnapshots,
} from '@/lib/services/report-snapshot';
import { canReadEvidence, createEvidenceSignedUrl, readEvidenceFileBytes } from '@/lib/storage';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * 自己監査 第 3 回（2026-09-30）のセキュリティ指摘の回帰テスト（SEC-3・SEC-6）。
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
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
/** 取引先の入力担当（資料の登録はできるが、閲覧の権限は無い）。デモ利用者に居ないため役割だけを差し替える */
const supplier = () => ctxFor('site-user@demo.local', ['supplier_contributor']);
/** 拠点の入力担当（数値の閲覧はできるが、開示の閲覧の権限は無い） */
const site = () => ctxFor('site-user@demo.local', ['site_contributor']);

describe('SEC-3 資料の閲覧権限が無い人には、自組織の資料の中身も渡さない', () => {
  it('署名付きリンク・実体の読み出し・閲覧の判定がすべて拒否になる（閲覧権限がある人は従来どおり）', async () => {
    const version = fixture.fileVersions.find((v) => v.organizationId === ORG_IDS.aomi)!;
    expect(await canReadEvidence(db, manager(), version, null)).toBe(true);
    expect(await canReadEvidence(db, supplier(), version, null)).toBe(false);
    expect(await createEvidenceSignedUrl(db, supplier(), version.id)).toBeNull();
    expect(await readEvidenceFileBytes(db, supplier(), version.id)).toBeNull();
    // 監査記録（署名付きリンクの発行）も残らない
    expect(
      fixture.storageAccessEvents.some((e) => e.actorUserId === userId('site-user@demo.local')),
    ).toBe(false);
  });
});

describe('SEC-6 ESG 経営の照合モードは、開示の閲覧権限が無い人にスナップショットを見せない', () => {
  it('一覧・照合とも開示の閲覧権限を求める', async () => {
    const snapshot = await createReviewDraftSnapshot(db, manager(), IDS.projects.fy2026);
    expect((await listOrganizationSnapshots(db, manager())).length).toBeGreaterThan(0);
    await expect(listOrganizationSnapshots(db, site())).rejects.toBeInstanceOf(AuthorizationError);
    await expect(loadKpiSnapshotComparison(db, site(), snapshot.id)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});
