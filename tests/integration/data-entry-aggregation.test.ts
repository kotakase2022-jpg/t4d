import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { metricId, ORG_IDS, PERIOD_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import {
  computeConsolidatedAggregation,
  consolidationFactor,
  isCountedInTotals,
} from '@/lib/services/aggregation';
import { buildTemplateWorkbook, carryForwardFromPreviousPeriod } from '@/lib/services/data-entry';
import { createIngestionJob, processIngestionJob } from '@/lib/imports/service';
import { parseUploadedFile } from '@/lib/imports/parsers';
import type { AuthorizationContext, ReportingPeriod, RoleKey } from '@/types/domain';

/**
 * DATA-P0-004（前年度複製・テンプレート・コピペ）と
 * DATA-P0-006（合計・加重平均・内部取引控除・除外・推計）の Integration テスト。
 */

let db: DemoDbClient;
let fixture: FixtureDb;
let periods: ReportingPeriod[];
let current: ReportingPeriod;

function ctxFor(email: string, organizationId: string, roleKeys: RoleKey[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const manager = () => ctxFor('sustainability@demo.local', ORG_IDS.aomi, ['sustainability_manager']);

beforeEach(async () => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  periods = await db.select('periods', { where: { organizationId: ORG_IDS.aomi } });
  current = periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
});

describe('連結集計（DATA-P0-006）', () => {
  it('連結係数: full=1 / proportionate=持分% / equity・excluded=0', () => {
    expect(consolidationFactor({ consolidationMethod: 'full', ownershipPercent: 100 })).toBe(1);
    expect(
      consolidationFactor({ consolidationMethod: 'proportionate', ownershipPercent: 60 }),
    ).toBe(0.6);
    expect(consolidationFactor({ consolidationMethod: 'equity', ownershipPercent: 30 })).toBe(0);
    expect(consolidationFactor({ consolidationMethod: 'excluded', ownershipPercent: 100 })).toBe(0);
  });

  it('内部取引控除: 明細行の合計が控除され、連結値 = 持分調整後 − 控除 になる', async () => {
    const agg = await computeConsolidatedAggregation(db, manager(), current, periods, [
      'scope3_cat1',
    ]);
    const scope3 = agg.metrics[0]!;

    // Fixture の内部取引明細（1850.0 + 640.5）が控除される
    expect(scope3.intercompanyEliminated).toBe(2490.5);
    expect(scope3.consolidated).toBe(
      Math.round((scope3.ownershipAdjusted - scope3.intercompanyEliminated) * 100) / 100,
    );
    // 単純合計は控除前（内部取引の明細は含まない）
    expect(scope3.simpleSum).toBeGreaterThan(scope3.consolidated);
  });

  it('内部取引の明細行は通常の合計（isCountedInTotals）から除外される', async () => {
    const rows = await db.select('dataPoints', {
      where: {
        organizationId: ORG_IDS.aomi,
        metricId: metricId('AOMI', 'scope3_cat1'),
        reportingPeriodId: current.id,
        status: 'approved',
      },
    });
    const intercompany = rows.filter((dp) => !isCountedInTotals(dp));
    expect(intercompany).toHaveLength(2);
    expect(intercompany.every((dp) => dp.boundary === '内部取引')).toBe(true);
  });

  it('加重平均: 女性管理職比率 = 女性管理職数合計 ÷ 管理職数合計（単純平均と別に出る）', async () => {
    const agg = await computeConsolidatedAggregation(db, manager(), current, periods, [
      'female_manager_ratio',
    ]);
    const ratio = agg.metrics[0]!;
    expect(ratio.weightedAverage).not.toBeNull();

    // 分子・分母の実データから期待値を検算する（ハードコードしない）
    const [numRows, denRows] = await Promise.all([
      db.select('dataPoints', {
        where: {
          organizationId: ORG_IDS.aomi,
          metricId: metricId('AOMI', 'female_managers'),
          reportingPeriodId: current.id,
          status: 'approved',
        },
      }),
      db.select('dataPoints', {
        where: {
          organizationId: ORG_IDS.aomi,
          metricId: metricId('AOMI', 'managers_total'),
          reportingPeriodId: current.id,
          status: 'approved',
        },
      }),
    ]);
    const num = numRows.reduce((s, dp) => s + (dp.value ?? 0), 0);
    const den = denRows.reduce((s, dp) => s + (dp.value ?? 0), 0);
    expect(den).toBeGreaterThan(0);
    expect(ratio.weightedAverage).toBe(Math.round((num / den) * 100 * 100) / 100);
  });

  it('推計: 当年データの無い連結対象拠点は前年の承認済み値で補完され、推計として別掲される', async () => {
    const ctx = manager();
    // 東日本工場の scope1 当年値を消して「未報告の拠点」を作る
    const eastRows = await db.select('dataPoints', {
      where: {
        organizationId: ORG_IDS.aomi,
        metricId: metricId('AOMI', 'scope1'),
        unitId: UNIT_IDS.east,
        reportingPeriodId: current.id,
      },
    });
    for (const dp of eastRows) {
      await db.update('dataPoints', dp.id, { deletedAt: new Date().toISOString() });
    }

    const agg = await computeConsolidatedAggregation(db, ctx, current, periods, ['scope1']);
    const scope1 = agg.metrics[0]!;
    const estimate = scope1.estimates.find((e) => e.unitId === UNIT_IDS.east);
    expect(estimate).toBeDefined();
    expect(estimate!.value).toBeGreaterThan(0);
    expect(estimate!.basis).toContain('前年');
    // 推計込み = 連結値 + 全推計（未報告の拠点が複数あればすべて補完される）
    const estimateSum = scope1.estimates.reduce((s2, e) => s2 + e.value, 0);
    expect(scope1.consolidatedWithEstimates).toBe(
      Math.round((scope1.consolidated + estimateSum) * 100) / 100,
    );
  });

  it('除外拠点（持分法・連結対象外）が理由つきで別掲される', async () => {
    const ctx = manager();
    // 欧州販売子会社を持分法へ変更して検証
    await db.update('units', UNIT_IDS.eu, {
      consolidationMethod: 'equity',
      ownershipPercent: 40,
    });

    const agg = await computeConsolidatedAggregation(db, ctx, current, periods, ['scope1']);
    const scope1 = agg.metrics[0]!;
    const excluded = scope1.excludedUnits.find((u) => u.unitName.includes('欧州'));
    expect(excluded).toBeDefined();
    expect(excluded!.method).toBe('equity');
    // equity の拠点は連結値へ足されない
    const rows = await db.select('dataPoints', {
      where: {
        organizationId: ORG_IDS.aomi,
        metricId: metricId('AOMI', 'scope1'),
        reportingPeriodId: current.id,
        status: 'approved',
      },
    });
    const euValue = rows
      .filter((dp) => dp.unitId === UNIT_IDS.eu && isCountedInTotals(dp))
      .reduce((s, dp) => s + (dp.value ?? 0), 0);
    expect(scope1.simpleSum - scope1.ownershipAdjusted).toBeCloseTo(euValue, 1);
  });
});

describe('前年度複製（DATA-P0-004）', () => {
  it('前年の承認済み値が当年の draft として複製され、既存の組合せはスキップされる', async () => {
    const ctx = manager();
    const before = await db.count('dataPoints', {
      where: { organizationId: ORG_IDS.aomi, reportingPeriodId: current.id },
    });

    const result = await carryForwardFromPreviousPeriod(db, ctx, current, periods);
    // Fixture では当年に大半の組合せが存在するため、スキップが多いのが正しい
    expect(result.skippedExisting).toBeGreaterThan(0);

    const after = await db.count('dataPoints', {
      where: { organizationId: ORG_IDS.aomi, reportingPeriodId: current.id },
    });
    expect(after).toBe(before + result.created);

    // 複製された行は draft で、承認情報を持たない
    if (result.created > 0) {
      const drafts = await db.select('dataPoints', {
        where: { organizationId: ORG_IDS.aomi, reportingPeriodId: current.id, status: 'draft' },
      });
      const carried = drafts.filter((dp) => dp.createdBy === ctx.userId);
      expect(carried.length).toBeGreaterThan(0);
      expect(carried.every((dp) => dp.approvedAt === null)).toBe(true);
    }
  });

  it('複製は冪等（2 回実行しても増えない）', async () => {
    const ctx = manager();
    const first = await carryForwardFromPreviousPeriod(db, ctx, current, periods);
    const second = await carryForwardFromPreviousPeriod(db, ctx, current, periods);
    expect(second.created).toBe(0);
    expect(second.skippedExisting).toBeGreaterThanOrEqual(first.created);
  });

  it('当年データを消してから複製すると、その組合せが前年値の draft で埋まる', async () => {
    const ctx = manager();
    const target = await db.select('dataPoints', {
      where: {
        organizationId: ORG_IDS.aomi,
        metricId: metricId('AOMI', 'water'),
        unitId: UNIT_IDS.east,
        reportingPeriodId: current.id,
      },
    });
    for (const dp of target) {
      await db.update('dataPoints', dp.id, { deletedAt: new Date().toISOString() });
    }

    const result = await carryForwardFromPreviousPeriod(db, ctx, current, periods);
    expect(result.created).toBeGreaterThan(0);

    const carried = await db.select('dataPoints', {
      where: {
        organizationId: ORG_IDS.aomi,
        metricId: metricId('AOMI', 'water'),
        unitId: UNIT_IDS.east,
        reportingPeriodId: current.id,
        status: 'draft',
        deletedAt: { isNull: true },
      },
    });
    expect(carried).toHaveLength(1);
    expect(carried[0]!.value).toBeGreaterThan(0);
    // Version に複製元が記録される
    const versions = await db.select('dataPointVersions', {
      where: { dataPointId: carried[0]!.id },
    });
    expect(versions[0]!.sourceType).toBe('carry_forward');
  });

  it('拠点担当（unitScope 制限）は担当外拠点の複製をスキップする', async () => {
    const siteCtx: AuthorizationContext = {
      ...ctxFor('site-user@demo.local', ORG_IDS.aomi, ['site_contributor']),
      workspace: {
        ...ctxFor('site-user@demo.local', ORG_IDS.aomi, ['site_contributor']).workspace,
        unitScopeIds: [UNIT_IDS.east],
      },
    };
    // 全拠点ぶん消してから、担当限定で複製
    const all = await db.select('dataPoints', {
      where: {
        organizationId: ORG_IDS.aomi,
        metricId: metricId('AOMI', 'water'),
        reportingPeriodId: current.id,
      },
    });
    for (const dp of all) {
      await db.update('dataPoints', dp.id, { deletedAt: new Date().toISOString() });
    }

    const result = await carryForwardFromPreviousPeriod(db, siteCtx, current, periods);
    expect(result.skippedOutOfScope).toBeGreaterThan(0);

    const created = await db.select('dataPoints', {
      where: {
        organizationId: ORG_IDS.aomi,
        metricId: metricId('AOMI', 'water'),
        reportingPeriodId: current.id,
        status: 'draft',
        deletedAt: { isNull: true },
      },
    });
    // 担当（東日本）以外は作られない
    expect(created.every((dp) => dp.unitId === UNIT_IDS.east)).toBe(true);
  });
});

describe('Excel テンプレート（DATA-P0-004）', () => {
  it('標準形（拠点/項目/値/単位/期間）で生成され、そのまま再取込できる', async () => {
    const ctx = manager();
    const metrics = await db.select('metrics', { where: { organizationId: ORG_IDS.aomi } });
    const units = await db.select('units', { where: { organizationId: ORG_IDS.aomi } });

    const bytes = await buildTemplateWorkbook(metrics, units, current, []);
    const parsed = await parseUploadedFile(
      'テンプレート.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes,
    );
    expect(parsed.kind).toBe('table');
    if (parsed.kind !== 'table') return;
    expect(parsed.table.headers).toEqual(['拠点', '項目', '値', '単位', '期間']);
    expect(parsed.table.rows.length).toBeGreaterThan(10);

    // 記入した体で 1 行を値ありにして、実際に取込パイプラインへ通す
    const filled = [
      '拠点\t項目\t値\t単位\t期間',
      `東日本工場\t電力使用量\t18300.5\tMWh\t${current.code}`,
    ].join('\r\n');
    const job = await createIngestionJob(db, ctx, {
      reportingPeriodId: current.id,
      unitId: null,
      idempotencyKey: 'template-roundtrip',
      files: [
        {
          name: '記入済みテンプレート.tsv',
          type: 'text/tab-separated-values',
          bytes: new TextEncoder().encode(filled),
        },
      ],
    });
    await processIngestionJob(db, ctx, job.id);
    const rows = await db.select('ingestionRows', { where: { jobId: job.id } });
    expect(rows[0]!.metricId).toBe(metricId('AOMI', 'energy'));
    expect(rows[0]!.value).toBe(18300.5);
  });
});
