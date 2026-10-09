import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ENGAGEMENT_IDS, ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { getStorageAdapter } from '@/lib/storage';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * 資料の閲覧記録の補完（トライアル対応 NF-26 の P1・plan int:file-view-logging）。
 *
 *  - 画面内表示（/api/files/inline）で storage_access_events に「閲覧」（viewed）を本人名義で残す
 *    （企業側の監査ログ画面に出る）。権限の判定は変えない（権限の無い人は 404 のまま、記録もしない）
 *  - ダウンロード（/api/files/download）の記録に案件を残すのは、その案件のメンバーが開いたときだけ
 *    （企業の利用者の取得を監査法人の案件の記録へ混ぜない）
 */

const state = vi.hoisted(() => ({
  ctx: null as AuthorizationContext | null,
  db: null as unknown,
}));
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => (state.ctx ? { context: state.ctx } : null),
}));
vi.mock('@/lib/repositories', () => ({
  getDb: async () => state.db,
}));

const inline = await import('@/app/api/files/inline/route');
const download = await import('@/app/api/files/download/route');

let fixture: FixtureDb;
let db: DemoDbClient;

function enterprise(email: string, roleKeys: RoleKey[]): AuthorizationContext {
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

/** 実体を置いた自社の PDF の資料（Fixture の資料の 1 つを PDF として扱う） */
async function pdfVersion() {
  const version = fixture.fileVersions.find((v) => v.organizationId === ORG_IDS.aomi)!;
  const file = fixture.files.find((f) => f.id === version.fileId)!;
  file.mimeType = 'application/pdf';
  await getStorageAdapter().put(
    file.bucket,
    version.storageKey,
    new Uint8Array([37, 80, 68, 70]),
    'application/pdf',
  );
  return { version, file };
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  state.db = db;
  state.ctx = null;
});

describe('画面内表示の記録', () => {
  it('表示した人の名義で「閲覧」を残す', async () => {
    const { version } = await pdfVersion();
    state.ctx = enterprise('sustainability@demo.local', ['sustainability_manager']);
    const response = await inline.GET(
      new Request(`http://localhost/api/files/inline?fileVersionId=${version.id}`),
    );
    expect(response.status).toBe(200);
    const viewed = fixture.storageAccessEvents.filter(
      (e) => e.fileVersionId === version.id && e.action === 'viewed',
    );
    expect(viewed).toHaveLength(1);
    expect(viewed[0]).toMatchObject({
      organizationId: ORG_IDS.aomi,
      actorUserId: userId('sustainability@demo.local'),
      engagementId: null,
    });
    expect(viewed[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('資料の閲覧権限が無い人は 404 のまま、記録もしない', async () => {
    const { version } = await pdfVersion();
    state.ctx = {
      ...enterprise('site-user@demo.local', ['supplier_contributor']),
    };
    const response = await inline.GET(
      new Request(`http://localhost/api/files/inline?fileVersionId=${version.id}`),
    );
    expect(response.status).toBe(404);
    expect(fixture.storageAccessEvents.some((e) => e.action === 'viewed')).toBe(false);
  });
});

describe('ダウンロードの記録の案件', () => {
  it('企業の利用者が案件を付けて開いても、記録を案件に結び付けない', async () => {
    const { version, file } = await pdfVersion();
    state.ctx = enterprise('sustainability@demo.local', ['sustainability_manager']);
    const response = await download.GET(
      new Request(
        `http://localhost/api/files/download?bucket=${file.bucket}&key=${encodeURIComponent(version.storageKey)}&engagementId=${ENGAGEMENT_IDS.main}`,
      ),
    );
    expect(response.status).toBe(200);
    const recorded = fixture.storageAccessEvents.find(
      (e) => e.fileVersionId === version.id && e.action === 'downloaded',
    )!;
    expect(recorded.engagementId).toBeNull();
    expect(recorded.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
