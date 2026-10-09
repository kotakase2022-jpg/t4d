import { beforeEach, describe, expect, it } from 'vitest';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { loadDisclosureOnboarding } from '@/lib/services/disclosure-onboarding';
import type { AuthorizationContext, ReportingPeriod, RoleKey } from '@/types/domain';
import { WriteDetectingDbClient } from '../support/write-detecting-db';

/**
 * 開示の準備段階（版の選択・過去データの取込状況。トライアル対応 NF-40）。
 *
 * 以前は取込状況の件数を「組織の回答」で数えており、FY2026 の CDP に CSRD の回答が混ざって
 * 24 件（CDP 12 + CSRD 12）と出ていた。その基準の版の項目への回答だけを数える。
 * 既定の版は一覧と同じ規則（期間の版。無ければ公開中の版）。読むだけで行を作らない。
 */

let fixture: FixtureDb;
let db: DemoDbClient;
let periods: ReportingPeriod[];

function ctxFor(email: string, organizationId: string, roleKeys: RoleKey[]): AuthorizationContext {
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
  };
}

const manager = () => ctxFor('sustainability@demo.local', ORG_IDS.aomi, ['sustainability_manager']);
const periodOf = (id: string) => periods.find((p) => p.id === id)!;

beforeEach(async () => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  periods = await db.select('periods', { where: { organizationId: ORG_IDS.aomi } });
});

describe('取込状況の件数（NF-40: CDP 12 と CSRD 12 を混ぜない）', () => {
  it('FY2026 の回答は組織に 24 件あるが、CDP は CDP の 12 件、CSRD は CSRD の 12 件と数える', async () => {
    const all = fixture.disclosureResponses.filter(
      (r) => r.organizationId === ORG_IDS.aomi && r.reportingPeriodId === PERIOD_IDS.fy2026,
    );
    expect(all).toHaveLength(24);

    const cdp = (await loadDisclosureOnboarding(
      db,
      manager(),
      'cdp',
      periodOf(PERIOD_IDS.fy2026),
      periods,
    ))!;
    const csrd = (await loadDisclosureOnboarding(
      db,
      manager(),
      'csrd',
      periodOf(PERIOD_IDS.fy2026),
      periods,
    ))!;
    expect(cdp.periods.find((p) => p.periodId === PERIOD_IDS.fy2026)!.responseCount).toBe(12);
    expect(csrd.periods.find((p) => p.periodId === PERIOD_IDS.fy2026)!.responseCount).toBe(12);
  });

  it('過年度（FY2025）は CDP の前年回答（新規の質問を除く 10 件・承認済み）だけを数える', async () => {
    const cdp = (await loadDisclosureOnboarding(
      db,
      manager(),
      'cdp',
      periodOf(PERIOD_IDS.fy2026),
      periods,
    ))!;
    const fy2025 = cdp.periods.find((p) => p.periodId === PERIOD_IDS.fy2025)!;
    expect(fy2025.responseCount).toBe(10);
    expect(fy2025.approvedCount).toBe(10);
    expect(cdp.hasPastData).toBe(true);
  });

  it('他の基準の回答だけが過年度にあっても「過去データあり」にしない', async () => {
    // FY2025 の CDP の回答を、CSRD の質問への回答に付け替えると CDP の過去データは無くなる
    const csrdFramework = fixture.frameworks.find((f) => f.key === 'csrd')!;
    const csrdVersion = fixture.frameworkVersions.find((v) => v.frameworkId === csrdFramework.id)!;
    const csrdItem = fixture.disclosureItems.find((i) => i.frameworkVersionId === csrdVersion.id)!;
    for (const r of fixture.disclosureResponses) {
      if (r.organizationId === ORG_IDS.aomi && r.reportingPeriodId === PERIOD_IDS.fy2025) {
        r.itemId = csrdItem.id;
      }
    }
    const cdp = (await loadDisclosureOnboarding(
      db,
      manager(),
      'cdp',
      periodOf(PERIOD_IDS.fy2026),
      periods,
    ))!;
    expect(cdp.periods.find((p) => p.periodId === PERIOD_IDS.fy2025)!.responseCount).toBe(0);
    expect(cdp.hasPastData).toBe(false);
  });
});

describe('版の既定（一覧と同じ規則）', () => {
  it('期間の開始の年と同じ年の版を既定にする（FY2026 → 2026 年版、FY2025 → 2025 年版）', async () => {
    const fy2026 = (await loadDisclosureOnboarding(
      db,
      manager(),
      'cdp',
      periodOf(PERIOD_IDS.fy2026),
      periods,
    ))!;
    expect(fy2026.selectedVersionId).toBe(fid('framework_version', 'cdp/2026'));
    const fy2025 = (await loadDisclosureOnboarding(
      db,
      manager(),
      'cdp',
      periodOf(PERIOD_IDS.fy2025),
      periods,
    ))!;
    expect(fy2025.selectedVersionId).toBe(fid('framework_version', 'cdp/2025'));
    expect(fy2025.versions.find((v) => v.isDefault)!.label).toBe('CDP 2025（架空）');
  });

  it('同じ年の版が無い期間（FY2024）は公開中の版。選んだ版（?version=）が基準の版ならそれを使う', async () => {
    const fy2024 = (await loadDisclosureOnboarding(
      db,
      manager(),
      'cdp',
      periodOf(PERIOD_IDS.fy2024),
      periods,
    ))!;
    expect(fy2024.selectedVersionId).toBe(fid('framework_version', 'cdp/2026'));
    const chosen = (await loadDisclosureOnboarding(
      db,
      manager(),
      'cdp',
      periodOf(PERIOD_IDS.fy2026),
      periods,
      fid('framework_version', 'cdp/2025'),
    ))!;
    expect(chosen.selectedVersionId).toBe(fid('framework_version', 'cdp/2025'));
    const invalid = (await loadDisclosureOnboarding(
      db,
      manager(),
      'cdp',
      periodOf(PERIOD_IDS.fy2026),
      periods,
      '__invalid__',
    ))!;
    expect(invalid.selectedVersionId).toBe(fid('framework_version', 'cdp/2026'));
  });

  it('読むだけで行を作らない。CDP 対応オプションが無い組織では読まない（null）', async () => {
    const spy = new WriteDetectingDbClient(db);
    await loadDisclosureOnboarding(spy, manager(), 'cdp', periodOf(PERIOD_IDS.fy2026), periods);
    expect(spy.writes).toEqual([]);

    for (const option of fixture.organizationOptions) {
      if (option.organizationId === ORG_IDS.aomi) option.enabled = false;
    }
    expect(
      await loadDisclosureOnboarding(db, manager(), 'cdp', periodOf(PERIOD_IDS.fy2026), periods),
    ).toBeNull();
    // 契約の要らない基準（CSRD）はそのまま読める
    expect(
      await loadDisclosureOnboarding(db, manager(), 'csrd', periodOf(PERIOD_IDS.fy2026), periods),
    ).not.toBeNull();
  });
});
