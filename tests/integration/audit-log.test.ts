import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationError } from '@/lib/authorization/can';
import { ENGAGEMENT_IDS, ORG_IDS, at, userId } from '@/lib/fixtures/dataset';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import type { AuditEvent, AuthorizationContext, RoleKey, Uuid } from '@/types/domain';

/**
 * 企業側の監査ログ（トライアル対応 NF-26・plan int:audit-log）。
 *
 *  - 自社のメンバーの操作と、自社の資料へのアクセス（監査法人のメンバーが許諾で開いたものを含む）を出す
 *  - 監査法人の案件の中の操作・他テナントの記録は出さない（RLS と同じ範囲）
 *  - 監査法人のメンバーの氏名は出さない（企業から読めない）。所属は案件の監査法人の名前
 *  - 監査ログの閲覧権限（common.audit.read）が無い人・監査法人のワークスペースは読めない。CSV も同じ（403）
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

const { listOrganizationAudit, listOrganizationAuditForExport } =
  await import('@/lib/services/audit-log');
const auditCsv = await import('@/app/api/exports/audit-log/route');
const { transitionDataPoint } = await import('@/lib/services/data-point-workflow');

let fixture: FixtureDb;
let db: DemoDbClient;

function enterprise(
  email: string,
  roleKeys: RoleKey[],
  organizationId: Uuid = ORG_IDS.aomi,
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType: 'enterprise',
      organizationName: '組織',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const admin = () => enterprise('enterprise-admin@demo.local', ['enterprise_admin']);
const manager = () => enterprise('sustainability@demo.local', ['sustainability_manager']);
const assuranceManager = (): AuthorizationContext => ({
  ...enterprise('assurance-manager@demo.local', ['assurance_manager'], ORG_IDS.aoba),
  workspace: {
    organizationId: ORG_IDS.aoba,
    organizationType: 'assurance_firm',
    organizationName: 'あおば保証監査法人',
    roleKeys: ['assurance_manager'],
    unitScopeIds: [],
  },
  engagementIds: [ENGAGEMENT_IDS.main],
});

/** 基準日（Fixture の今日）。期間の絞り込みを Fixture の時刻で確かめる */
const NOW = new Date(at(0, 12));

function event(
  overrides: Partial<AuditEvent> & Pick<AuditEvent, 'eventType' | 'createdAt'>,
): AuditEvent {
  return {
    id: fid('audit_event', `test/${overrides.eventType}/${overrides.createdAt}/${Math.random()}`),
    actorUserId: userId('sustainability@demo.local'),
    actorOrganizationId: ORG_IDS.aomi,
    resourceType: 'data_point',
    resourceId: null,
    engagementId: null,
    clientIpHash: null,
    userAgent: null,
    beforeSummary: null,
    afterSummary: null,
    metadata: {},
    ...overrides,
  };
}

function aomiFileVersion() {
  const version = fixture.fileVersions.find((v) => v.organizationId === ORG_IDS.aomi);
  if (!version) throw new Error('Fixture に自社の資料の版が無い');
  return version;
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  state.db = db;
  state.ctx = null;
  const version = aomiFileVersion();
  // 監査法人のメンバーが許諾で開いた記録と、自社のメンバーのダウンロード
  fixture.storageAccessEvents.push(
    {
      id: fid('storage_access_event', 'test/firm'),
      organizationId: ORG_IDS.aomi,
      actorUserId: userId('assurance-manager@demo.local'),
      fileVersionId: version.id,
      action: 'signed_url_created',
      engagementId: ENGAGEMENT_IDS.main,
      expiresAt: at(2, 4),
      createdAt: at(2, 3),
    },
    {
      id: fid('storage_access_event', 'test/own'),
      organizationId: ORG_IDS.aomi,
      actorUserId: userId('sustainability@demo.local'),
      fileVersionId: version.id,
      action: 'downloaded',
      engagementId: null,
      expiresAt: null,
      createdAt: at(3, 3),
    },
    {
      // 他テナントの資料の記録（出さない）
      id: fid('storage_access_event', 'test/soten'),
      organizationId: ORG_IDS.soten,
      actorUserId: userId('other-enterprise-admin@demo.local'),
      fileVersionId: version.id,
      action: 'downloaded',
      engagementId: null,
      expiresAt: null,
      createdAt: at(1, 3),
    },
  );
  fixture.auditEvents.push(
    event({
      eventType: 'data_updated',
      createdAt: at(1, 5),
      afterSummary: '値を訂正（架空）',
    }),
    event({
      eventType: 'access_denied',
      createdAt: at(1, 6),
      resourceType: null,
      metadata: { permission: 'enterprise.export.run', route: '/api/exports/data-points' },
    }),
    event({
      eventType: 'data_updated',
      createdAt: at(1, 7),
      actorUserId: userId('other-enterprise-admin@demo.local'),
      actorOrganizationId: ORG_IDS.soten,
      afterSummary: '他テナントの操作（架空）',
    }),
  );
});

describe('出す範囲（RLS と同じ）', () => {
  it('自社のメンバーの操作と自社の資料へのアクセスを新しい順に出し、監査法人の案件の操作・他テナントの記録は出さない', async () => {
    const page = await listOrganizationAudit(db, admin(), {}, { pageSize: 500, now: NOW });
    const events = page.entries.filter((e) => e.source === 'event');
    const ownEventCount = fixture.auditEvents.filter(
      (e) => e.actorOrganizationId === ORG_IDS.aomi,
    ).length;
    expect(events).toHaveLength(ownEventCount);
    expect(page.entries.some((e) => e.summary.includes('他テナントの操作'))).toBe(false);
    // 監査法人の案件の記録（Snapshot の固定など）は出さない
    expect(page.entries.some((e) => e.kindKey === 'snapshot_created')).toBe(false);
    const files = page.entries.filter((e) => e.source === 'file_access');
    expect(files).toHaveLength(2);
    expect(page.total).toBe(ownEventCount + 2);
    // 新しい順
    const times = page.entries.map((e) => e.at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('監査法人のメンバーの資料アクセスは氏名を出さず、所属に案件の監査法人の名前を出す', async () => {
    const page = await listOrganizationAudit(db, admin(), {}, { pageSize: 500, now: NOW });
    const firm = page.entries.find((e) => e.kindKey === 'file:signed_url_created')!;
    expect(firm.actorName).toBe('監査法人のメンバー');
    expect(firm.affiliation).toEqual({ kind: 'firm', label: 'あおば保証監査法人' });
    expect(firm.target).not.toBe('');
    const own = page.entries.find((e) => e.kindKey === 'file:downloaded')!;
    expect(own.affiliation.kind).toBe('own');
    expect(own.actorName).not.toBe('監査法人のメンバー');
  });

  it('権限で断った記録は、権限の名前とルートのパターンで出す（権限キーを出さない）', async () => {
    const page = await listOrganizationAudit(
      db,
      admin(),
      { kind: 'access_denied' },
      { pageSize: 50, now: NOW },
    );
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]!.summary).toContain('「出力」の権限が無いため断りました');
    expect(page.entries[0]!.summary).toContain('/api/exports/data-points');
    expect(page.entries[0]!.summary).not.toContain('enterprise.export.run');
  });
});

describe('要約は画面の言葉（生の enum・役割のキー・内部 ID を出さない。§2.0）', () => {
  it('以前の記録（status=… / ロール … / file_version=… / 適用区分 …）も、読むときに言葉へ置き換える', async () => {
    fixture.auditEvents.push(
      event({
        eventType: 'data_updated',
        createdAt: at(0, 1),
        beforeSummary: 'status=draft',
        afterSummary: 'status=submitted',
      }),
      event({
        eventType: 'data_created',
        createdAt: at(0, 2),
        resourceType: 'membership',
        afterSummary:
          'メンバーを招待（アプリ内リンク発行・メール送信なし）: ロール sustainability_manager,viewer／全社',
      }),
      event({
        eventType: 'data_updated',
        createdAt: at(0, 3),
        afterSummary: 'Evidence を紐付け（file_version=1a2b3c4d）',
      }),
      event({
        eventType: 'data_updated',
        createdAt: at(0, 4),
        resourceType: 'ssbj_assessment',
        beforeSummary: '適用区分 applicable / 重要性 not_assessed',
        afterSummary: '適用区分 not_applicable / 重要性 material',
      }),
    );
    const page = await listOrganizationAudit(db, admin(), {}, { pageSize: 500, now: NOW });
    const summaries = page.entries.map((e) => e.summary).join('\n');
    for (const raw of [
      'status=',
      'sustainability_manager',
      'file_version=',
      '1a2b3c4d',
      'not_applicable',
      'not_assessed',
    ]) {
      expect(summaries, raw).not.toContain(raw);
    }
    expect(summaries).toContain('状態「入力中」 → 状態「提出済み」');
    expect(summaries).toContain('役割 本社サステナビリティ担当・閲覧者');
    expect(summaries).toContain('資料の版');
    expect(summaries).toContain('適用区分 対象外');
  });

  it('新しく記録する要約も言葉で書く（データの提出）', async () => {
    const target = fixture.dataPoints.find(
      (d) => d.organizationId === ORG_IDS.aomi && d.status === 'draft' && !d.deletedAt,
    )!;
    await transitionDataPoint(db, manager(), { dataPointId: target.id, to: 'submitted' });
    const recorded = fixture.auditEvents.find(
      (e) => e.resourceId === target.id && e.beforeSummary !== null && e.afterSummary !== null,
    )!;
    expect(recorded).toBeDefined();
    expect(recorded.beforeSummary).not.toContain('status=');
    expect(recorded.afterSummary).toContain('提出済み');
  });
});

describe('絞り込み・ページ', () => {
  it('監査法人の資料アクセスのみ', async () => {
    const page = await listOrganizationAudit(
      db,
      admin(),
      { firmFilesOnly: true },
      { pageSize: 50, now: NOW },
    );
    expect(page.entries.map((e) => e.kindKey)).toEqual(['file:signed_url_created']);
    expect(page.total).toBe(1);
  });

  it('種類（Fixture の承認の記録）・実行者・期間', async () => {
    const approved = await listOrganizationAudit(
      db,
      admin(),
      { kind: 'data_approved' },
      { pageSize: 50, now: NOW },
    );
    expect(approved.entries.length).toBeGreaterThanOrEqual(1);
    expect(approved.entries.every((e) => e.kindLabel === 'データの承認')).toBe(true);

    const byActor = await listOrganizationAudit(
      db,
      admin(),
      { actorUserId: userId('approver@demo.local') },
      { pageSize: 50, now: NOW },
    );
    expect(byActor.entries.length).toBeGreaterThan(0);
    expect(byActor.entries.every((e) => e.actorUserId === userId('approver@demo.local'))).toBe(
      true,
    );

    // 直近 7 日: 足した記録（1〜3 日前）だけ。Fixture の古い記録（22 日前〜）は出ない
    const recent = await listOrganizationAudit(
      db,
      admin(),
      { period: '7d' },
      { pageSize: 50, now: NOW },
    );
    expect(recent.entries.every((e) => e.at >= at(7, 12))).toBe(true);
    expect(recent.entries.some((e) => e.kindKey === 'data_approved')).toBe(false);
    expect(recent.total).toBe(recent.entries.length);
  });

  it('ページを送っても重ならず、総件数は変わらない', async () => {
    const all = await listOrganizationAudit(db, admin(), {}, { pageSize: 500, now: NOW });
    const first = await listOrganizationAudit(db, admin(), {}, { page: 1, pageSize: 2, now: NOW });
    const second = await listOrganizationAudit(db, admin(), {}, { page: 2, pageSize: 2, now: NOW });
    expect(first.total).toBe(all.total);
    expect([...first.entries, ...second.entries].map((e) => e.id)).toEqual(
      all.entries.slice(0, 4).map((e) => e.id),
    );
  });
});

describe('権限', () => {
  it('監査ログの閲覧権限が無い人・監査法人のワークスペースは読めない', async () => {
    await expect(listOrganizationAudit(db, manager(), {})).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(listOrganizationAudit(db, assuranceManager(), {})).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(listOrganizationAuditForExport(db, manager(), {})).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});

describe('CSV（/api/exports/audit-log）', () => {
  it('権限が無ければ 403 の JSON を返し、断った記録を残す', async () => {
    state.ctx = manager();
    const before = fixture.auditEvents.filter((e) => e.eventType === 'access_denied').length;
    const response = await auditCsv.GET(new Request('http://localhost/api/exports/audit-log'));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
    expect(fixture.auditEvents.filter((e) => e.eventType === 'access_denied').length).toBe(
      before + 1,
    );
  });

  it('企業管理者は画面と同じ絞り込みで CSV を受け取り、出力を監査ログに残す', async () => {
    state.ctx = admin();
    const response = await auditCsv.GET(
      new Request('http://localhost/api/exports/audit-log?scope=firm-files'),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    const bytes = new Uint8Array(await response.arrayBuffer());
    // Excel で文字化けしない UTF-8 の BOM（text() は BOM を外して読むため、バイトで確かめる）
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    const lines = text.trim().split(/\r\n/);
    expect(lines[0]).toContain('日時（日本時間）');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('監査法人のメンバー');
    expect(lines[1]).toContain('あおば保証監査法人');
    expect(
      fixture.auditEvents.some(
        (e) => e.eventType === 'export_created' && e.resourceType === 'audit_events',
      ),
    ).toBe(true);
  });
});
