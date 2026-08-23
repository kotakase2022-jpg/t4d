import { beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '@/lib/authorization/can';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import {
  createCollectionCampaign,
  createMetricDefinition,
  createOrganizationUnit,
  parseMetricInput,
  parseOrganizationUnitInput,
  updateMetricDefinition,
  updateOrganizationUnit,
} from '@/lib/services/master-data';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * マスターデータ CRUD（MASTER-P0-001 / ORG-P0-001）の Integration テスト。
 * Server Action と同じ Service を通す。権限・テナント分離まで検証する。
 */

let db: DemoDbClient;
let fixture: FixtureDb;

function ctxFor(
  email: string,
  organizationId: string,
  organizationName: string,
  roleKeys: RoleKey[],
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType: 'enterprise',
      organizationName,
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const admin = () =>
  ctxFor('enterprise-admin@demo.local', ORG_IDS.aomi, '青海テクノロジー株式会社', [
    'enterprise_admin',
  ]);
const viewerOnly = () =>
  ctxFor('site-user@demo.local', ORG_IDS.aomi, '青海テクノロジー株式会社', ['viewer']);
const otherAdmin = () =>
  ctxFor('other-enterprise-admin@demo.local', ORG_IDS.soten, '蒼天マテリアル株式会社', [
    'enterprise_admin',
  ]);

function metricForm(overrides: Record<string, string> = {}): (k: string) => string {
  const base: Record<string, string> = {
    code: 'TEST_METRIC',
    name: 'テスト指標',
    description: 'テスト用',
    category: 'ghg',
    unit: 't-CO2e',
    baseUnit: 't-CO2e',
    dataType: 'number',
    aggregationMethod: 'sum',
    formula: '',
    requiresEvidence: 'on',
    materiality: 'high',
    reportingFrequency: 'annual',
    responsibleDepartment: 'サステナ推進部',
    yoyWarningPercent: '30',
    ...overrides,
  };
  return (k: string) => base[k] ?? '';
}

function unitForm(overrides: Record<string, string> = {}): (k: string) => string {
  const base: Record<string, string> = {
    code: 'TEST_UNIT',
    name: 'テスト拠点',
    unitType: 'site',
    parentId: '',
    countryCode: 'JP',
    currencyCode: 'JPY',
    timezone: 'Asia/Tokyo',
    consolidationMethod: 'full',
    ownershipPercent: '80',
    exclusionReason: '',
    ...overrides,
  };
  return (k: string) => base[k] ?? '';
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('指標マスター（MASTER-P0-001）', () => {
  it('管理者は指標を追加でき、DB に保存される', async () => {
    const before = await db.count('metrics', { where: { organizationId: ORG_IDS.aomi } });
    const created = await createMetricDefinition(db, admin(), parseMetricInput(metricForm()));

    expect(created.code).toBe('TEST_METRIC');
    expect(created.organizationId).toBe(ORG_IDS.aomi);
    expect(created.yoyWarningRatio).toBeCloseTo(0.3); // 30% → 0.3
    expect(created.requiresEvidence).toBe(true);

    const after = await db.count('metrics', { where: { organizationId: ORG_IDS.aomi } });
    expect(after).toBe(before + 1);

    const reloaded = await db.findById('metrics', created.id);
    expect(reloaded?.name).toBe('テスト指標');
  });

  it('編集が保存され、監査ログが記録される', async () => {
    const created = await createMetricDefinition(db, admin(), parseMetricInput(metricForm()));
    await updateMetricDefinition(
      db,
      admin(),
      created.id,
      parseMetricInput(metricForm({ name: '改名した指標', materiality: 'low' })),
    );

    const reloaded = await db.findById('metrics', created.id);
    expect(reloaded?.name).toBe('改名した指標');
    expect(reloaded?.materiality).toBe('low');

    const audits = await db.select('auditEvents', {
      where: { resourceType: 'metric_definition' },
    });
    expect(audits.some((a) => a.eventType === 'data_created')).toBe(true);
    expect(audits.some((a) => a.eventType === 'data_updated')).toBe(true);
  });

  it('権限のないロールは追加できない', async () => {
    await expect(
      createMetricDefinition(db, viewerOnly(), parseMetricInput(metricForm())),
    ).rejects.toThrow();
  });

  it('コード重複を拒否する', async () => {
    await createMetricDefinition(db, admin(), parseMetricInput(metricForm({ code: 'DUP' })));
    await expect(
      createMetricDefinition(db, admin(), parseMetricInput(metricForm({ code: 'DUP' }))),
    ).rejects.toThrow(/既に存在/);
  });

  it('不正なカテゴリを拒否する', () => {
    expect(() => parseMetricInput(metricForm({ category: 'not_a_category' }))).toThrow();
  });

  it('他組織の指標は編集できない（テナント分離）', async () => {
    // 青海の指標を作り、蒼天の管理者が編集を試みる
    const created = await createMetricDefinition(db, admin(), parseMetricInput(metricForm()));
    await expect(
      updateMetricDefinition(db, otherAdmin(), created.id, parseMetricInput(metricForm())),
    ).rejects.toBeInstanceOf(NotFoundError);

    // 元データは変わっていない
    const reloaded = await db.findById('metrics', created.id);
    expect(reloaded?.organizationId).toBe(ORG_IDS.aomi);
  });
});

describe('組織・拠点（ORG-P0-001）', () => {
  it('管理者は組織を追加でき、連結方法・持分・除外理由を保存する', async () => {
    const created = await createOrganizationUnit(
      db,
      admin(),
      parseOrganizationUnitInput(
        unitForm({ consolidationMethod: 'proportionate', ownershipPercent: '60' }),
      ),
    );
    expect(created.consolidationMethod).toBe('proportionate');
    expect(created.ownershipPercent).toBe(60);
    expect(created.exclusionReason).toBeNull();
  });

  it('連結対象外のときだけ除外理由を保持する', async () => {
    const excluded = await createOrganizationUnit(
      db,
      admin(),
      parseOrganizationUnitInput(
        unitForm({ code: 'EXC', consolidationMethod: 'excluded', exclusionReason: '重要性が低い' }),
      ),
    );
    expect(excluded.exclusionReason).toBe('重要性が低い');

    // full のときは除外理由を捨てる
    const full = await createOrganizationUnit(
      db,
      admin(),
      parseOrganizationUnitInput(
        unitForm({ code: 'FULL', consolidationMethod: 'full', exclusionReason: '無視される' }),
      ),
    );
    expect(full.exclusionReason).toBeNull();
  });

  it('持分が範囲外だと拒否する', () => {
    expect(() => parseOrganizationUnitInput(unitForm({ ownershipPercent: '150' }))).toThrow();
  });

  it('編集で連結方法と持分を更新できる', async () => {
    const created = await createOrganizationUnit(
      db,
      admin(),
      parseOrganizationUnitInput(unitForm()),
    );
    const updated = await updateOrganizationUnit(
      db,
      admin(),
      created.id,
      parseOrganizationUnitInput(
        unitForm({ consolidationMethod: 'equity', ownershipPercent: '30' }),
      ),
    );
    expect(updated.consolidationMethod).toBe('equity');
    expect(updated.ownershipPercent).toBe(30);
  });

  it('他組織の組織は編集できない（テナント分離）', async () => {
    const created = await createOrganizationUnit(
      db,
      admin(),
      parseOrganizationUnitInput(unitForm()),
    );
    await expect(
      updateOrganizationUnit(db, otherAdmin(), created.id, parseOrganizationUnitInput(unitForm())),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('権限のないロールは追加できない', async () => {
    await expect(
      createOrganizationUnit(db, viewerOnly(), parseOrganizationUnitInput(unitForm())),
    ).rejects.toThrow();
  });
});

describe('収集キャンペーン（ORG-P0-002）', () => {
  it('対象組織×対象指標のスコープを展開して作成する', async () => {
    const periods = await db.select('periods', { where: { organizationId: ORG_IDS.aomi } });
    const units = await db.select('units', {
      where: { organizationId: ORG_IDS.aomi, deletedAt: { isNull: true } },
    });
    const metrics = await db.select('metrics', {
      where: { organizationId: ORG_IDS.aomi, deletedAt: { isNull: true } },
    });
    const targetUnits = units.filter((u) => u.unitType !== 'supplier').slice(0, 2);
    const targetMetrics = metrics.slice(0, 3);

    const result = await createCollectionCampaign(db, admin(), {
      name: 'FY2026 一次収集',
      reportingPeriodId: periods[0]!.id,
      dueDate: '2026-06-30',
      description: null,
      unitIds: targetUnits.map((u) => u.id),
      metricIds: targetMetrics.map((m) => m.id),
      ownerUserId: null,
    });

    // 2 組織 × 3 指標 = 6 スコープ
    expect(result.scopeCount).toBe(6);

    const campaign = await db.findById('campaigns', result.campaignId);
    expect(campaign?.name).toBe('FY2026 一次収集');
    expect(campaign?.status).toBe('open');

    const scopes = await db.select('campaignScopes', {
      where: { campaignId: result.campaignId },
    });
    expect(scopes).toHaveLength(6);
    expect(scopes.every((s) => s.dueDate === '2026-06-30')).toBe(true);
  });

  it('キャンペーンを作ると担当者へタスクと通知が作られる', async () => {
    // スコープを展開するだけでは誰も動けない。タスクと通知まで作る。
    const [periods, units, metrics] = await Promise.all([
      db.select('periods', { where: { organizationId: ORG_IDS.aomi } }),
      db.select('units', { where: { organizationId: ORG_IDS.aomi } }),
      db.select('metrics', {
        where: { organizationId: ORG_IDS.aomi, deletedAt: { isNull: true } },
      }),
    ]);
    const targetUnits = units.filter((u) => u.unitType !== 'supplier').slice(0, 2);
    const owner = userId('site-user@demo.local');

    const tasksBefore = await db.select('tasks', { where: { organizationId: ORG_IDS.aomi } });
    const notificationsBefore = await db.select('notifications', { where: { userId: owner } });

    const result = await createCollectionCampaign(db, admin(), {
      name: 'FY2026 タスク生成テスト',
      reportingPeriodId: periods[0]!.id,
      dueDate: '2026-07-31',
      description: null,
      unitIds: targetUnits.map((u) => u.id),
      metricIds: metrics.slice(0, 2).map((m) => m.id),
      ownerUserId: owner,
    });

    const tasksAfter = await db.select('tasks', { where: { targetId: result.campaignId } });
    expect(tasksAfter, '対象組織ごとにタスクが作られる').toHaveLength(targetUnits.length);
    expect(tasksAfter.every((t) => t.assigneeUserId === owner)).toBe(true);
    expect(tasksAfter.every((t) => t.dueDate === '2026-07-31')).toBe(true);
    expect((await db.select('tasks', { where: { organizationId: ORG_IDS.aomi } })).length).toBe(
      tasksBefore.length + targetUnits.length,
    );

    const notificationsAfter = await db.select('notifications', { where: { userId: owner } });
    expect(notificationsAfter.length, '担当者へ通知が届く').toBe(notificationsBefore.length + 1);
  });

  it('対象組織・指標が未選択だと拒否する', async () => {
    const periods = await db.select('periods', { where: { organizationId: ORG_IDS.aomi } });
    await expect(
      createCollectionCampaign(db, admin(), {
        name: 'x',
        reportingPeriodId: periods[0]!.id,
        dueDate: '2026-06-30',
        description: null,
        unitIds: [],
        metricIds: [],
        ownerUserId: null,
      }),
    ).rejects.toThrow();
  });

  it('他組織の指標を混ぜると拒否する（テナント分離）', async () => {
    const periods = await db.select('periods', { where: { organizationId: ORG_IDS.aomi } });
    const units = await db.select('units', { where: { organizationId: ORG_IDS.aomi } });
    // 蒼天の指標を作り、青海のキャンペーンに混ぜる
    const foreign = await createMetricDefinition(
      db,
      otherAdmin(),
      parseMetricInput(metricForm({ code: 'FOREIGN' })),
    );
    await expect(
      createCollectionCampaign(db, admin(), {
        name: 'x',
        reportingPeriodId: periods[0]!.id,
        dueDate: '2026-06-30',
        description: null,
        unitIds: [units[0]!.id],
        metricIds: [foreign.id],
        ownerUserId: null,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('権限のないロールは作成できない', async () => {
    const periods = await db.select('periods', { where: { organizationId: ORG_IDS.aomi } });
    const units = await db.select('units', { where: { organizationId: ORG_IDS.aomi } });
    const metrics = await db.select('metrics', { where: { organizationId: ORG_IDS.aomi } });
    await expect(
      createCollectionCampaign(db, viewerOnly(), {
        name: 'x',
        reportingPeriodId: periods[0]!.id,
        dueDate: '2026-06-30',
        description: null,
        unitIds: [units[0]!.id],
        metricIds: [metrics[0]!.id],
        ownerUserId: null,
      }),
    ).rejects.toThrow();
  });
});
