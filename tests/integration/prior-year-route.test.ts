import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '@/lib/errors/user-facing';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, metricId, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  loadApprovalProgress,
  loadDefaultRoute,
  loadPriorYearRoute,
  saveApprovalRoute,
  startApprovalRoute,
} from '@/lib/services/approval-route';
import {
  commitQuantitativeImport,
  validateQuantitativeImport,
  type QuantitativeImportPreview,
} from '@/lib/services/quantitative-import';
import type { AuthorizationContext, RoleKey, Uuid } from '@/types/domain';

/**
 * 過年度確定値の承認経路（トライアル対応 NF-44・plan int:prior-year-route）。
 *
 *  - 経路の用途 prior_year_final は既定の経路にならない（通常の提出に使われない）
 *  - 標準 CSV の確定で「過年度確定値として登録」を選んだときだけ、画面の報告期間より前の期間の行を
 *    過年度確定値の経路で提出する（選ばなければ従来どおり「入力中」で、後の提出は既定の経路）
 *  - 当年度の行だけのときは選べない（確かめる前に書かない）
 */

let fixture: FixtureDb;
let db: DemoDbClient;

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

const admin = () => ctxFor('enterprise-admin@demo.local', ['enterprise_admin']);
const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);

const HEADER =
  'metric_code,period_start,period_end,entity_code,boundary_code,value,unit,value_kind,availability_status,absence_reason,methodology_code,breakdown_key,source_reference';
const FY25 = '2025-04-01,2026-03-31';
const FY26 = '2026-04-01,2027-03-31';

function csv(...lines: string[]): string {
  return [HEADER, ...lines].join('\r\n');
}

async function validate(text: string): Promise<QuantitativeImportPreview> {
  return validateQuantitativeImport(db, manager(), {
    reportingPeriodId: PERIOD_IDS.fy2026,
    source: { kind: 'file', fileName: 'prior-year.csv', bytes: new TextEncoder().encode(text) },
  });
}

async function commit(preview: QuantitativeImportPreview, priorYearFinal: boolean) {
  return commitQuantitativeImport(db, manager(), {
    batchId: preview.batchId,
    previewHash: preview.previewHash,
    idempotencyKey: randomUUID(),
    mode: 'all',
    correctionReason: '過年度の確定値を登録（架空）',
    priorYearFinal,
  });
}

function dpOf(metricCode: string, periodId: Uuid) {
  return fixture.dataPoints.find(
    (dp) =>
      dp.metricId === metricId('AOMI', metricCode) &&
      dp.unitId === UNIT_IDS.hq &&
      dp.reportingPeriodId === periodId &&
      !dp.deletedAt,
  );
}

/** FY2025 の HQ の Scope1 を今の値と違う値で登録する行（過年度の行） */
function priorYearLine(): string {
  const current = dpOf('scope1', PERIOD_IDS.fy2025);
  const value = (current?.value ?? 1000) + 1;
  return `scope1,${FY25},HQ,連結,${value},t-CO2e,actual,,,,,過年度の確定集計（架空）`;
}

async function createPriorYearRoute() {
  return saveApprovalRoute(db, admin(), {
    name: '過年度確定値の登録',
    description: '',
    isDefault: true,
    purpose: 'prior_year_final',
    stages: [
      {
        name: '過年度確定値の確認',
        approverRole: 'approver',
        approverUserId: null,
        department: '',
      },
    ],
  });
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('過年度確定値の経路の定義', () => {
  it('用途が過年度確定値の経路は既定にならず、通常のデータの既定の経路は変わらない', async () => {
    const before = await loadDefaultRoute(db, admin());
    const saved = await createPriorYearRoute();
    // 既定の印を付けて送っても、過年度確定値の経路は既定にしない
    expect(saved.route.purpose).toBe('prior_year_final');
    expect(saved.route.isDefault).toBe(false);
    expect((await loadDefaultRoute(db, admin()))?.route.id).toBe(before?.route.id);
    expect((await loadPriorYearRoute(db, admin()))?.route.id).toBe(saved.route.id);
  });

  it('過年度確定値の経路が無いときに過年度の経路で始めようとすると止める（既定の経路へ黙って切り替えない）', async () => {
    const dp = dpOf('scope1', PERIOD_IDS.fy2026)!;
    await expect(
      startApprovalRoute(db, manager(), dp.id, { purpose: 'prior_year_final' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('標準 CSV の確定で過年度確定値として登録する', () => {
  it('検証の結果に過年度の行の数と使う経路の名前が出る（経路が無ければ名前は無い）', async () => {
    const text = csv(priorYearLine(), `scope2_location,${FY26},HQ,連結,5000,t-CO2e,,,,,,`);
    const withoutRoute = await validate(text);
    expect(withoutRoute.priorYear).toEqual({ rowCount: 1, routeName: null });

    await createPriorYearRoute();
    const withRoute = await validate(text);
    expect(withRoute.priorYear).toEqual({ rowCount: 1, routeName: '過年度確定値の登録' });
  });

  it('選ばなければ過年度の行も「入力中」のまま。後で提出すると既定の経路で始まる', async () => {
    await createPriorYearRoute();
    const preview = await validate(csv(priorYearLine()));
    const result = await commit(preview, false);
    expect(result.priorYearRouted).toBeUndefined();

    const dp = dpOf('scope1', PERIOD_IDS.fy2025)!;
    expect(dp.status).toBe('draft');
    const progress = await loadApprovalProgress(db, manager(), dp.id);
    expect(progress.currentStep).toBeNull();
  });

  it('選ぶと過年度の行だけを過年度確定値の経路（1 段階）で提出し、当年度の行は「入力中」のまま', async () => {
    await createPriorYearRoute();
    const preview = await validate(
      csv(priorYearLine(), `scope2_location,${FY26},HQ,連結,5000,t-CO2e,,,,,,`),
    );
    const result = await commit(preview, true);
    expect(result.priorYearRouted).toEqual({ count: 1, routeName: '過年度確定値の登録' });

    const prior = dpOf('scope1', PERIOD_IDS.fy2025)!;
    expect(prior.status).toBe('submitted');
    const progress = await loadApprovalProgress(db, manager(), prior.id);
    expect(progress.totalCount).toBe(1);
    expect(progress.currentStep?.stageName).toBe('過年度確定値の確認');
    expect(progress.currentStep?.approverRole).toBe('approver');

    // 当年度の行は承認の経路を始めない
    const current = dpOf('scope2_location', PERIOD_IDS.fy2026)!;
    expect(current.status).toBe('draft');
    expect((await loadApprovalProgress(db, manager(), current.id)).totalCount).toBe(0);
  });

  it('当年度の行だけのときは選べず、何も書かない', async () => {
    await createPriorYearRoute();
    const preview = await validate(csv(`scope2_location,${FY26},HQ,連結,5000,t-CO2e,,,,,,`));
    expect(preview.priorYear.rowCount).toBe(0);
    const before = fixture.dataPoints.length;
    await expect(commit(preview, true)).rejects.toThrow(/当年度/);
    expect(fixture.dataPoints.length).toBe(before);
  });

  it('過年度確定値の経路が無いときは選んでも確定せず、何も書かない', async () => {
    const preview = await validate(csv(priorYearLine()));
    const versionsBefore = fixture.dataPointVersions.length;
    await expect(commit(preview, true)).rejects.toThrow(/過年度確定値の承認経路がありません/);
    expect(fixture.dataPointVersions.length).toBe(versionsBefore);
  });
});
