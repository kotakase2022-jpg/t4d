import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { CONSOLIDATED_UNIT_TAG, isConsolidatedUnit } from '@/lib/domain/boundaries';
import { loadDataPointPage } from '@/lib/services/enterprise-data';
import type { AuthorizationContext } from '@/types/domain';

/**
 * 非財務データ画面の組織タグ「連結対象のみ」。
 * 持分法適用（equity）・対象外（excluded）の組織を落とすことを確かめる。
 */

let db: DemoDbClient;
let fixture: FixtureDb;

const ctx = (): AuthorizationContext => ({
  userId: userId('sustainability@demo.local'),
  email: 'sustainability@demo.local',
  displayName: '海野 みどり',
  workspace: {
    organizationId: ORG_IDS.aomi,
    organizationType: 'enterprise',
    organizationName: '青海テクノロジー株式会社',
    roleKeys: ['sustainability_manager'],
    unitScopeIds: [],
  },
  engagementIds: [],
  demo: true,
});

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('組織タグ「連結対象のみ」', () => {
  it('タグの値は実在の組織 ID と衝突しない', () => {
    expect(fixture.units.some((u) => u.id === CONSOLIDATED_UNIT_TAG)).toBe(false);
  });

  it('全部連結・比例連結だけを対象とし、持分法適用・対象外は含めない', () => {
    const aomiUnits = fixture.units.filter((u) => u.organizationId === ORG_IDS.aomi);
    const consolidated = aomiUnits.filter(isConsolidatedUnit);
    const excluded = aomiUnits.filter((u) => !isConsolidatedUnit(u));

    // 判定の対象になる組織が両方そろっている（そうでないとタグの意味が確認できない）
    expect(consolidated.length).toBeGreaterThan(0);
    expect(excluded.length).toBeGreaterThan(0);

    for (const u of consolidated) {
      expect(['full', 'proportionate']).toContain(u.consolidationMethod);
    }
    for (const u of excluded) {
      expect(['equity', 'excluded']).toContain(u.consolidationMethod);
    }

    // 持分法適用の関連会社が「データは報告するが連結対象ではない」例として存在する
    const jv = aomiUnits.find((u) => u.id === UNIT_IDS.jv);
    expect(jv, '持分法適用の組織が fixture に無い').toBeDefined();
    expect(jv!.consolidationMethod).toBe('equity');
    expect(isConsolidatedUnit(jv!)).toBe(false);
  });

  it('連結対象の組織 ID で絞り込むと、持分法適用の組織の行が含まれない', async () => {
    const aomiUnits = fixture.units.filter((u) => u.organizationId === ORG_IDS.aomi);
    const consolidatedIds = aomiUnits.filter(isConsolidatedUnit).map((u) => u.id);
    const period = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!;

    const all = await loadDataPointPage(db, ctx(), period, fixture.metrics, aomiUnits, {}, 1, 500);
    const consolidatedOnly = await loadDataPointPage(
      db,
      ctx(),
      period,
      fixture.metrics,
      aomiUnits,
      { unitIds: consolidatedIds },
      1,
      500,
    );

    expect(consolidatedOnly.total).toBeLessThan(all.total);
    for (const row of consolidatedOnly.rows) {
      expect(row.dataPoint.unitId).not.toBe(UNIT_IDS.jv);
    }
    // 絞り込み前には持分法適用の組織の行が実際に存在する
    expect(all.rows.some((r) => r.dataPoint.unitId === UNIT_IDS.jv)).toBe(true);
  });
});
