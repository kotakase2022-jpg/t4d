import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { previousComparablePeriod } from '@/lib/domain/period-comparability';
import { ORG_IDS, PERIOD_IDS, dataPointId, metricId, userId } from '@/lib/fixtures/dataset';
import { GHG_FIXTURE_IDS } from '@/lib/fixtures/ghg-verification';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { loadPreviousYearDataPoint } from '@/lib/services/data-entry';
import type { AuthorizationContext } from '@/types/domain';

/**
 * 画面の「前年」（plan K10・自己監査 F4・R1）。Fixture には年度（FY2024〜FY2026）と暦年（CY2025。Scope1・2 の
 * 算定の検証用）が並ぶ。開始日の順だけで前年を選ぶと FY2025 の前年が CY2025 になり、Data Point の詳細の
 * 「前年実績」が「前年データなし」になっていた（検証の前年比は FY2024 で比べるのに）。
 */

let fixture: FixtureDb;
let db: DemoDbClient;

const ctx: AuthorizationContext = {
  userId: userId('sustainability@demo.local'),
  email: 'sustainability@demo.local',
  displayName: 'テスト',
  workspace: {
    organizationId: ORG_IDS.aomi,
    organizationType: 'enterprise',
    organizationName: 'テスト',
    roleKeys: ['sustainability_manager'],
    unitScopeIds: [],
  },
  engagementIds: [],
  demo: true,
};

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

const periodsOfAomi = () => fixture.periods.filter((p) => p.organizationId === ORG_IDS.aomi);

describe('Data Point の詳細の前年実績', () => {
  it('FY2025 の前年実績は FY2024 の値（開始日が後の CY2025 ではない）', async () => {
    const periods = periodsOfAomi();
    expect(periods.some((p) => p.id === GHG_FIXTURE_IDS.period)).toBe(true);
    const fy2025 = periods.find((p) => p.id === PERIOD_IDS.fy2025)!;
    const current = fixture.dataPoints.find(
      (d) => d.id === dataPointId('EAST', 'scope1', 'FY2025'),
    )!;
    const previous = await loadPreviousYearDataPoint(db, ctx, {
      period: fy2025,
      periods,
      metricId: metricId('AOMI', 'scope1'),
      unitId: current.unitId,
    });
    expect(previous?.period.code).toBe('FY2024');
    expect(previous?.dataPoint?.id).toBe(dataPointId('EAST', 'scope1', 'FY2024'));
    expect(previous?.dataPoint?.value).not.toBeNull();
  });

  it('暦年の期間（CY2025）には年度の前年を出さない', async () => {
    const periods = periodsOfAomi();
    const cy2025 = periods.find((p) => p.id === GHG_FIXTURE_IDS.period)!;
    const current = fixture.dataPoints.find(
      (d) => d.id === dataPointId('EAST', 'scope1', 'FY2025'),
    )!;
    expect(
      await loadPreviousYearDataPoint(db, ctx, {
        period: cy2025,
        periods,
        metricId: metricId('AOMI', 'scope1'),
        unitId: current.unitId,
      }),
    ).toBeNull();
  });

  it('前年度複製の確認の文言（end）と複製の処理が同じ期間を指す', () => {
    const periods = periodsOfAomi();
    const fy2025 = periods.find((p) => p.id === PERIOD_IDS.fy2025)!;
    const cy2025 = periods.find((p) => p.id === GHG_FIXTURE_IDS.period)!;
    expect(previousComparablePeriod(fy2025, periods, 'end')?.code).toBe('FY2024');
    // CY2025 には複製元が無い（画面も「前年度なし」とし、処理の「複製元となる前年度がありません」と揃う）
    expect(previousComparablePeriod(cy2025, periods, 'end')).toBeNull();
  });
});

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('画面・Action は前年の期間を開始日・終了日の順だけで選ばない（静的検査）', () => {
  it('src/app に「p.startDate <」「p.endDate <」で期間を絞り込む箇所が無い（previousComparablePeriod を使う）', () => {
    const files = filesUnder('src/app');
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.filter((file) =>
      /\.filter\(\s*\(p\)\s*=>\s*p\.(startDate|endDate)\s*</.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
