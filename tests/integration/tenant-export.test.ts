import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationError } from '@/lib/authorization/can';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { SQL_TABLE_NAMES } from '@/lib/repositories/table-names';
import type { TableName } from '@/lib/repositories/types';
import { getStorageAdapter } from '@/lib/storage';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * 全データの返却書き出し（トライアル対応 NF-29・plan int:tenant-export）。
 *
 *  - 他テナントの行を含まない（自社の組織 ID の行と、その子の行だけ）
 *  - manifest.json の sha256 が ZIP の中のファイルと一致する
 *  - 表の分類に漏れが無い（新しい表を足したら、書き出すか・書き出さないかを理由付きで決める）
 *  - 組織の管理と出力の両方の権限が要る（API は 403 の JSON）
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

const {
  buildTenantExport,
  planTenantExport,
  TENANT_EXPORT_CHILDREN,
  TENANT_EXPORT_EXCLUDED,
  TENANT_EXPORT_OTHER_KEYS,
  TENANT_EXPORT_TABLES,
} = await import('@/lib/services/tenant-export');
const route = await import('@/app/api/exports/tenant/route');

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

const admin = () => enterprise('enterprise-admin@demo.local', ['enterprise_admin']);

/** ZIP の中身を読む（buildZip が書く形: ローカルヘッダ＋本文。deflate か無圧縮） */
function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const compressed = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.slice(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + extraLength;
    const body = bytes.slice(start, start + compressed);
    out.set(name, method === 8 ? new Uint8Array(inflateRawSync(body)) : body);
    offset = start + compressed;
  }
  return out;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** マイグレーションの CREATE TABLE（と ADD COLUMN）で organization_id を持つ表 */
function tablesWithOrganizationId(): Set<string> {
  const dir = join(process.cwd(), 'supabase', 'migrations');
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
  const result = new Set<string>();
  for (const match of sql.matchAll(
    /create table (?:if not exists )?([a-z_]+)\s*\(([\s\S]*?)\n\);/g,
  )) {
    if (/^\s*organization_id\s+uuid/m.test(match[2]!)) result.add(match[1]!);
  }
  for (const match of sql.matchAll(
    /alter table ([a-z_]+)\s+add column (?:if not exists )?organization_id\b/g,
  )) {
    result.add(match[1]!);
  }
  return result;
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  state.db = db;
  state.ctx = null;
});

describe('表の分類', () => {
  it('すべての表が、書き出す（自社の組織 ID・別の列・親の表）か書き出さない（理由付き）のどれか 1 つに入る', () => {
    const groups = [
      [...TENANT_EXPORT_TABLES],
      Object.keys(TENANT_EXPORT_OTHER_KEYS),
      Object.keys(TENANT_EXPORT_CHILDREN),
      Object.keys(TENANT_EXPORT_EXCLUDED),
    ];
    const all = groups.flat();
    expect(new Set(all).size, '同じ表を 2 つの分類に入れている').toBe(all.length);
    expect([...all].sort()).toEqual(Object.keys(SQL_TABLE_NAMES).sort());
    for (const reason of Object.values(TENANT_EXPORT_EXCLUDED)) expect(reason).toBeTruthy();
  });

  it('自社の組織 ID で読む表は、どれも organization_id 列を持つ', () => {
    const withColumn = tablesWithOrganizationId();
    for (const table of TENANT_EXPORT_TABLES) {
      expect(withColumn.has(SQL_TABLE_NAMES[table as TableName]), table).toBe(true);
    }
  });
});

describe('データの書き出し', () => {
  it('他テナントの行を含まず、manifest の sha256 が ZIP の中のファイルと一致する', async () => {
    const result = await buildTenantExport(db, admin(), 'data');
    const files = unzip(result.zip);
    const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')!));
    expect(manifest.format).toBe('t4d-tenant-export');
    expect(manifest.organizationId).toBe(ORG_IDS.aomi);
    expect(files.has('README.md')).toBe(true);

    for (const table of manifest.tables as Array<{ file: string; sha256: string; rows: number }>) {
      const bytes = files.get(table.file);
      expect(bytes, table.file).toBeDefined();
      expect(sha256(bytes!), table.file).toBe(table.sha256);
    }

    // 他テナント（企業・監査法人）の組織 ID はどの CSV にも出ない（監査法人の ID は自社の許諾・回答の行にだけ現れうる）
    const csvText = [...files.entries()]
      .filter(([name]) => name.startsWith('data/'))
      .map(([, bytes]) => new TextDecoder().decode(bytes))
      .join('\n');
    expect(csvText).not.toContain(ORG_IDS.soten);
    expect(csvText).not.toContain(ORG_IDS.kurobe);

    // 行数は自社の行と一致する
    const dataPoints = (manifest.tables as Array<{ table: string; rows: number }>).find(
      (t) => t.table === 'data_points',
    )!;
    expect(dataPoints.rows).toBe(
      fixture.dataPoints.filter((dp) => dp.organizationId === ORG_IDS.aomi).length,
    );
    const roles = (manifest.tables as Array<{ table: string; rows: number }>).find(
      (t) => t.table === 'membership_roles',
    )!;
    const memberships = new Set(
      fixture.memberships.filter((m) => m.organizationId === ORG_IDS.aomi).map((m) => m.id),
    );
    expect(roles.rows).toBe(
      fixture.membershipRoles.filter((r) => memberships.has(r.membershipId)).length,
    );
    // 監査法人の案件の記録は書き出さない（理由は manifest に）
    expect(files.has('data/engagements.csv')).toBe(false);
    expect(
      (manifest.excluded as Array<{ table: string }>).some((e) => e.table === 'engagements'),
    ).toBe(true);
  });

  it('数式に見える値は CSV で無害化する', async () => {
    fixture.metrics.find((m) => m.organizationId === ORG_IDS.aomi)!.name = '=HYPERLINK("x")';
    const result = await buildTenantExport(db, admin(), 'data');
    const csv = new TextDecoder().decode(unzip(result.zip).get('data/metric_definitions.csv')!);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('書き出しは監査ログに残る。確認の範囲（表・行・資料）を数えられる', async () => {
    const plan = await planTenantExport(db, admin());
    expect(plan.tables).toBeGreaterThan(80);
    expect(plan.rows).toBeGreaterThan(0);
    await buildTenantExport(db, admin(), 'data');
    expect(
      fixture.auditEvents.some(
        (e) => e.eventType === 'export_created' && e.resourceType === 'tenant_export',
      ),
    ).toBe(true);
  });
});

describe('資料の実体の書き出し', () => {
  it('実体のある資料は sha256 付きで入り、実体の無い資料は一覧に残す', async () => {
    const version = fixture.fileVersions.find((v) => v.organizationId === ORG_IDS.aomi)!;
    const file = fixture.files.find((f) => f.id === version.fileId)!;
    const body = new TextEncoder().encode('資料の本文（架空）');
    await getStorageAdapter().put(file.bucket, version.storageKey, body, 'text/plain');

    const result = await buildTenantExport(db, admin(), 'files');
    const files = unzip(result.zip);
    const entry = result.manifest.files.find((f) => f.fileVersionId === version.id)!;
    expect(entry).toBeDefined();
    expect(sha256(files.get(entry.path)!)).toBe(entry.sha256);
    expect(entry.path.startsWith(`files/${version.id}/`)).toBe(true);
    const ownVersions = fixture.fileVersions.filter((v) => v.organizationId === ORG_IDS.aomi);
    expect(result.manifest.files.length + result.manifest.missingFiles.length).toBe(
      ownVersions.length,
    );
  });
});

describe('権限', () => {
  it('組織の管理と出力の両方が要る', async () => {
    await expect(
      buildTenantExport(
        db,
        enterprise('sustainability@demo.local', ['sustainability_manager']),
        'data',
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      buildTenantExport(db, enterprise('approver@demo.local', ['approver']), 'data'),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('API: 権限が無ければ 403 の JSON、企業管理者には ZIP を返す', async () => {
    state.ctx = enterprise('approver@demo.local', ['approver']);
    const denied = await route.GET(new Request('http://localhost/api/exports/tenant?part=data'));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'forbidden' });

    state.ctx = admin();
    const bad = await route.GET(new Request('http://localhost/api/exports/tenant?part=all'));
    expect(bad.status).toBe(400);
    // 設定の画面のフォームから送ったときは、生の JSON ではなく画面へ理由（種類だけ）を戻す
    const fromSettings = await route.GET(
      new Request('http://localhost/api/exports/tenant?part=all&from=settings'),
    );
    expect(fromSettings.status).toBe(303);
    const back = new URL(fromSettings.headers.get('location')!);
    expect(back.pathname).toBe('/enterprise/settings');
    expect(back.searchParams.get('tab')).toBe('data-handling');
    expect(back.searchParams.get('exportError')).toBe('part');
    const ok = await route.GET(new Request('http://localhost/api/exports/tenant?part=data'));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('application/zip');
    expect(ok.headers.get('content-disposition')).toContain('attachment');
  });
});
