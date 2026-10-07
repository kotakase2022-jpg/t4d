import { beforeEach, describe, expect, it } from 'vitest';
import { ENGAGEMENT_IDS, ORG_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { searchPalette } from '@/lib/services/palette-search';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * Command Palette のデータの検索（plan §4 B2・§1.10）。
 * - 読み取りだけ（検索で行を作らない）
 * - 権限で種類を出し分ける（メンバーはメンバーの管理だけ、資料は資料の閲覧だけ）
 * - 他テナントの行を返さない。監査法人は自分がアサインされた案件だけ
 */

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

function enterprise(
  email: string,
  roleKeys: RoleKey[],
  organizationId: string = ORG_IDS.aomi,
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType: 'enterprise',
      organizationName: '架空の組織',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

function assurance(
  email: string,
  roleKeys: RoleKey[],
  engagementIds: string[],
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aoba,
      organizationType: 'assurance_firm',
      organizationName: 'あおば保証監査法人',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds,
    demo: true,
  };
}

const kinds = (entries: Array<{ hint?: string }>) => [...new Set(entries.map((e) => e.hint))];

describe('searchPalette', () => {
  it('1 文字以下では検索しない（各種類 8 件まで・2 文字以上）', async () => {
    const admin = enterprise('enterprise-admin@demo.local', ['enterprise_admin']);
    expect((await searchPalette(db, admin, '水')).entries).toEqual([]);
    expect((await searchPalette(db, admin, ' ')).entries).toEqual([]);
  });

  it('指標・拠点を名前とコードで引き、行き先は絞り込んだ一覧', async () => {
    const admin = enterprise('enterprise-admin@demo.local', ['enterprise_admin']);
    const water = await searchPalette(db, admin, 'water');
    const metric = water.entries.find((e) => e.hint === '指標');
    expect(metric?.label).toContain('水使用量');
    expect(metric?.href).toMatch(/^\/enterprise\/data\?metric=/);

    const east = await searchPalette(db, admin, '東日本');
    const unit = east.entries.find((e) => e.hint === '組織・拠点');
    expect(unit?.href).toBe(`/enterprise/data?unit=${UNIT_IDS.east}`);
  });

  it('他テナントの行を返さない（同じ名前の指標・拠点があっても自分の組織だけ）', async () => {
    const admin = enterprise('enterprise-admin@demo.local', ['enterprise_admin']);
    const sotenMetricIds = new Set(
      fixture.metrics.filter((m) => m.organizationId === ORG_IDS.soten).map((m) => m.id),
    );
    const result = await searchPalette(db, admin, 'scope');
    const metricHrefs = result.entries.filter((e) => e.hint === '指標').map((e) => e.href);
    expect(metricHrefs.length).toBeGreaterThan(0);
    for (const href of metricHrefs) {
      expect(sotenMetricIds.has(href.split('metric=')[1]!)).toBe(false);
    }
    const sotenUnitIds = fixture.units
      .filter((u) => u.organizationId === ORG_IDS.soten)
      .map((u) => u.id);
    const units = (await searchPalette(db, admin, '本社')).entries.filter(
      (e) => e.hint === '組織・拠点',
    );
    expect(units.map((u) => u.href.split('unit=')[1])).not.toEqual(
      expect.arrayContaining(sotenUnitIds),
    );
  });

  it('メンバーはメンバーの管理の権限があるときだけ', async () => {
    const admin = enterprise('enterprise-admin@demo.local', ['enterprise_admin']);
    const author = enterprise('sustainability@demo.local', ['sustainability_manager']);
    expect(kinds((await searchPalette(db, admin, '海野')).entries)).toContain('メンバー');
    expect(kinds((await searchPalette(db, author, '海野')).entries)).not.toContain('メンバー');
  });

  it('開示の閲覧権限が無い役割には CSRD・プロジェクト・原稿・定性情報を出さない', async () => {
    const site = enterprise('site-user@demo.local', ['site_contributor']);
    const author = enterprise('sustainability@demo.local', ['sustainability_manager']);
    expect(kinds((await searchPalette(db, author, 'FY2026')).entries)).toContain(
      '開示プロジェクト',
    );
    const siteKinds = kinds((await searchPalette(db, site, 'FY2026')).entries);
    expect(siteKinds).not.toContain('開示プロジェクト');
    expect(kinds((await searchPalette(db, site, 'ガバナンス')).entries)).not.toContain('定性情報');
    expect(kinds((await searchPalette(db, author, 'ガバナンス')).entries)).toContain('定性情報');
  });

  it('資料は資料の閲覧権限があるときだけ（サプライヤー担当は登録だけで閲覧できない）', async () => {
    const supplier = enterprise('site-user@demo.local', ['supplier_contributor']);
    const admin = enterprise('enterprise-admin@demo.local', ['enterprise_admin']);
    expect(kinds((await searchPalette(db, admin, '電力請求書')).entries)).toContain('資料');
    expect(kinds((await searchPalette(db, supplier, '電力請求書')).entries)).not.toContain('資料');
  });

  it('監査法人は自分がアサインされた案件だけ、法人管理者（案件の閲覧なし）は何も出さない', async () => {
    const manager = assurance(
      'assurance-manager@demo.local',
      ['assurance_manager'],
      [ENGAGEMENT_IDS.main],
    );
    const result = await searchPalette(db, manager, 'ENG-2026');
    expect(result.entries.map((e) => e.href)).toEqual([
      `/assurance/engagements/${ENGAGEMENT_IDS.main}/overview`,
    ]);
    const firmAdmin = assurance('assurance-admin@demo.local', ['assurance_admin'], []);
    expect((await searchPalette(db, firmAdmin, 'ENG-2026')).entries).toEqual([]);
  });

  it('検索で行を作らない（読み取りだけ）', async () => {
    const author = enterprise('sustainability@demo.local', ['sustainability_manager']);
    const before = JSON.stringify(fixture);
    await searchPalette(db, author, 'GOV');
    await searchPalette(db, author, '気候');
    expect(JSON.stringify(fixture)).toBe(before);
  });
});
