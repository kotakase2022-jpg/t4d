import { beforeEach, describe, expect, it } from 'vitest';
import { ORG_IDS, PERIOD_IDS, dataPointId, userId } from '@/lib/fixtures/dataset';
import { GHG_VERIFICATION_UNIT_IDS } from '@/lib/fixtures/ghg-verification';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { buildTemplateWorkbook } from '@/lib/services/data-entry';
import { loadEnterpriseDashboard } from '@/lib/services/enterprise-data';
import type { AuthorizationContext } from '@/types/domain';

/**
 * 年度（FY）の収集の画面に、連結対象外の拠点（Scope1・2 の算定の検証拠点 TH1・VN1・MX1・US1）を出さない
 * （plan §2.6・自己監査 R2・R3）。収集キャンペーンの既定の対象と同じ規則（isFyReportingUnit）。
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
    roleKeys: ['sustainability_manager', 'enterprise_admin'],
    unitScopeIds: [],
  },
  engagementIds: [],
  demo: true,
};

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

const aomiUnits = () => fixture.units.filter((u) => u.organizationId === ORG_IDS.aomi);
const verificationNames = () =>
  aomiUnits()
    .filter((u) => (GHG_VERIFICATION_UNIT_IDS as readonly string[]).includes(u.id))
    .filter((u) => u.consolidationMethod === 'excluded')
    .map((u) => u.name);

describe('ホームの拠点別進捗', () => {
  it('FY2026 の拠点別進捗に、連結対象外の検証拠点の空の行（対象 0 件）を出さない', async () => {
    const fy2026 = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
    const metrics = fixture.metrics.filter((m) => m.organizationId === ORG_IDS.aomi);
    const data = await loadEnterpriseDashboard(db, ctx, fy2026, aomiUnits(), metrics);
    const names = data.unitProgress.map((row) => row.unit.name);
    expect(verificationNames()).toHaveLength(4);
    for (const name of verificationNames()) expect(names).not.toContain(name);
    expect(names).toHaveLength(5);
    expect(data.unitProgress.every((row) => row.total > 0)).toBe(true);
  });

  it('連結対象外の拠点でも当期の Data Point があれば行を出す（集めた値の進捗を隠さない）', async () => {
    const fy2026 = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
    const th = aomiUnits().find((u) => u.code === 'TH1')!;
    const template = fixture.dataPoints.find(
      (d) => d.id === dataPointId('EAST', 'scope1', 'FY2026'),
    )!;
    fixture.dataPoints.push({ ...template, id: `${template.id.slice(0, -4)}th01`, unitId: th.id });
    const metrics = fixture.metrics.filter((m) => m.organizationId === ORG_IDS.aomi);
    const data = await loadEnterpriseDashboard(db, ctx, fy2026, aomiUnits(), metrics);
    expect(data.unitProgress.map((row) => row.unit.name)).toContain(th.name);
  });
});

describe('データ入力テンプレート', () => {
  it('FY2026 のテンプレートは年度の拠点だけの 160 行（検証拠点 4 つ × 指標の 100 行を足さない）', async () => {
    const metrics = fixture.metrics.filter((m) => m.organizationId === ORG_IDS.aomi);
    const period = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
    const bytes = await buildTemplateWorkbook(metrics, aomiUnits(), period, []);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('データ入力')!;
    const units: string[] = [];
    ws.eachRow((row, i) => {
      if (i > 1) units.push(String(row.getCell(1).value));
    });
    expect(units).toHaveLength(160);
    for (const name of verificationNames()) expect(units).not.toContain(name);
  });
});
