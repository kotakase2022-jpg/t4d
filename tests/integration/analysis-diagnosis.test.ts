import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError } from '@/lib/authorization/can';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  loadDiagnosis,
  type Diagnosis,
  type DiagnosisArea,
} from '@/lib/services/analysis/diagnosis';
import { listNarratives } from '@/lib/services/narrative';
import type {
  AuthorizationContext,
  MetricDefinition,
  OrganizationUnit,
  ReportingPeriod,
  RoleKey,
  Uuid,
} from '@/types/domain';
import { WriteDetectingDbClient } from '../support/write-detecting-db';

/**
 * 現状診断（docs/disclosure-first.md §9.6）。
 *  - 領域ごとの状態（不足あり／確認待ちあり／不足なし／算定対象外）。単一の総合点・準拠率は出さない
 *  - 数値には分母を併記する。未入力・未収録を 0 として扱わない
 *  - 権限の無い領域は出さず、その旨を 1 行示す
 *  - 読込は書かない
 */

let fixture: FixtureDb;
let db: DemoDbClient;
let fy2026: ReportingPeriod;
let periods: ReportingPeriod[];
let units: OrganizationUnit[];
let metrics: MetricDefinition[];

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  organizationId: Uuid = ORG_IDS.aomi,
  organizationType: 'enterprise' | 'assurance_firm' = 'enterprise',
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType,
      organizationName: 'テスト',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const siteUser = () => ctxFor('site-user@demo.local', ['site_contributor']);

const REF = '2026-08-14';

beforeEach(async () => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  fy2026 = (await db.findById('periods', PERIOD_IDS.fy2026))!;
  periods = await db.select('periods', { where: { organizationId: ORG_IDS.aomi } });
  units = await db.select('units', {
    where: { organizationId: ORG_IDS.aomi, deletedAt: { isNull: true } },
    orderBy: { column: 'sortOrder' },
  });
  metrics = await db.select('metrics', {
    where: { organizationId: ORG_IDS.aomi, deletedAt: { isNull: true } },
  });
});

async function diagnose(ctx = manager(), client = db as DemoDbClient | WriteDetectingDbClient) {
  return loadDiagnosis(client, ctx, {
    period: fy2026,
    periods,
    units,
    metrics,
    referenceDate: REF,
  });
}

function area(diagnosis: Diagnosis, key: DiagnosisArea['key']): DiagnosisArea {
  const found = diagnosis.areas.find((a) => a.key === key);
  if (!found) throw new Error(`領域 ${key} が無い`);
  return found;
}

function fact(a: DiagnosisArea, key: string) {
  const found = a.facts.find((f) => f.key === key);
  if (!found) throw new Error(`${a.key} に ${key} が無い`);
  return found;
}

const fy2026DataPoints = () =>
  fixture.dataPoints.filter(
    (d) =>
      d.organizationId === ORG_IDS.aomi &&
      d.reportingPeriodId === PERIOD_IDS.fy2026 &&
      d.deletedAt === null,
  );

describe('領域と状態', () => {
  it('5 領域を決まった順に返し、単一の総合点・準拠率・割合を持たない', async () => {
    const diagnosis = await diagnose();
    expect(diagnosis.areas.map((a) => a.key)).toEqual([
      'collection',
      'evidence',
      'ghg',
      'narrative',
      'disclosure',
    ]);
    expect(diagnosis.hiddenNote).toBeNull();
    const json = JSON.stringify(diagnosis);
    expect(json).not.toMatch(/"(score|totalScore|rate|overall)"/);
    expect(json).not.toContain('準拠率');
    expect(json).not.toMatch(/\d\s*%/);
    for (const a of diagnosis.areas) {
      expect(['gap', 'pending', 'ok', 'not_applicable']).toContain(a.state);
      expect(a.stateLabel).toMatch(/^(不足あり|確認待ちあり|不足なし|算定対象外)$/);
      expect(a.stateReason.length, a.key).toBeGreaterThan(0);
      expect(a.source.length, a.key).toBeGreaterThan(0);
      expect(a.links.length, `${a.key} に直す画面へのリンクが無い`).toBeGreaterThan(0);
    }
  });

  it('割合の代わりに件数と分母を示す（分母のある事実は分母 > 0 または算定対象外）', async () => {
    const diagnosis = await diagnose();
    for (const a of diagnosis.areas) {
      for (const f of a.facts) {
        if (f.denominator !== null && f.count !== null) {
          expect(f.count, `${a.key}.${f.key}`).toBeLessThanOrEqual(f.denominator);
        }
      }
    }
  });
});

describe('データ収集・承認', () => {
  it('承認済み n / Data Point 総数。未提出・検証エラーがあれば不足あり', async () => {
    const collection = area(await diagnose(), 'collection');
    const all = fy2026DataPoints();
    expect(fact(collection, 'approved')).toMatchObject({
      count: all.filter((d) => d.status === 'approved').length,
      denominator: all.length,
    });
    expect(fact(collection, 'not_submitted')).toMatchObject({
      count: all.filter((d) => d.status === 'not_started' || d.status === 'draft').length,
      denominator: all.length,
    });
    expect(fact(collection, 'review_pending').count).toBe(
      all.filter((d) => d.status === 'submitted' || d.status === 'in_review').length,
    );
    expect(collection.state).toBe('gap');
    expect(collection.stateLabel).toBe('不足あり');
    expect(collection.links.map((l) => l.href)).toEqual(
      expect.arrayContaining(['/enterprise/data', '/enterprise/workflows']),
    );
  });

  it('拠点別に 承認 n / N を示す（サプライヤーは含めない）', async () => {
    const collection = area(await diagnose(), 'collection');
    const reportable = units.filter((u) => u.unitType !== 'supplier');
    expect(collection.units!.map((u) => u.unitName)).toEqual(reportable.map((u) => u.name));
    for (const row of collection.units!) {
      const rows = fy2026DataPoints().filter((d) => d.unitId === row.unitId);
      expect(row.total, row.unitName).toBe(rows.length);
      expect(row.approved, row.unitName).toBe(rows.filter((d) => d.status === 'approved').length);
      expect(row.href).toBe(`/enterprise/data?unit=${row.unitId}`);
    }
  });

  it('Data Point が 1 件も無い年度は算定対象外（0/0 を「不足なし」にしない）', async () => {
    fixture.dataPoints = fixture.dataPoints.filter(
      (d) => d.reportingPeriodId !== PERIOD_IDS.fy2026,
    );
    db = new DemoDbClient(fixture);
    const collection = area(await diagnose(), 'collection');
    expect(collection.state).toBe('not_applicable');
    expect(collection.stateLabel).toBe('算定対象外');
    expect(collection.stateReason).toContain('データ項目');
  });
});

describe('証跡・承認の健全性', () => {
  it('期限超過タスク n / 未完了タスク N（デモ基準日 2026-08-14）', async () => {
    const evidence = area(await diagnose(), 'evidence');
    const open = fixture.tasks.filter(
      (t) => t.organizationId === ORG_IDS.aomi && t.status !== 'done' && t.status !== 'cancelled',
    );
    expect(fact(evidence, 'overdue_tasks')).toMatchObject({
      count: open.filter((t) => t.dueDate !== null && t.dueDate < REF).length,
      denominator: open.length,
    });
    expect(fact(evidence, 'overdue_tasks').count).toBe(4);
    expect(evidence.state).toBe('gap');
    expect(evidence.links.map((l) => l.href)).toEqual(
      expect.arrayContaining(['/enterprise/alerts', '/enterprise/evidence']),
    );
  });
});

describe('GHG 算定の網羅性', () => {
  it('Scope1・Scope2（2 方式）の承認済み拠点 n / N（持分法の合弁会社は分母に入れない）', async () => {
    const ghg = area(await diagnose(), 'ghg');
    const scope = (code: string) => ghg.ghg!.find((r) => r.code === code)!;
    expect(scope('scope1')).toMatchObject({
      approvedUnits: 3,
      expectedUnits: 4,
      reviewUnits: ['欧州販売子会社'],
      missingUnits: [],
    });
    expect(scope('scope2')).toMatchObject({ expectedUnits: 4 });
    expect(scope('scope2_location')).toMatchObject({
      approvedUnits: 0,
      expectedUnits: 4,
    });
    expect(scope('scope2_location').missingUnits).toHaveLength(4);
    expect(ghg.excludedUnitNames).toEqual(['青海マテリアル合弁会社']);
  });

  it('Scope3 はカテゴリ n / 15、合計は未算定（Cat.1 を全量にしない・0 と出さない）', async () => {
    const ghg = area(await diagnose(), 'ghg');
    expect(ghg.scope3!.categoryTotal).toBe(15);
    expect(ghg.scope3!.presentCount + ghg.scope3!.notApplicableCount).toBeLessThan(15);
    expect(ghg.scope3!.totalValue).toBeNull();
    expect(fact(ghg, 'scope3_total')).toMatchObject({ count: null, text: '未算定' });
    expect(ghg.state).toBe('gap');
    expect(ghg.links.map((l) => l.href)).toEqual(
      expect.arrayContaining(['/enterprise/ghg', '/enterprise/ghg/suppliers']),
    );
  });
});

describe('定性情報・開示対応（開示の閲覧権限のときだけ）', () => {
  it('確認済み n / 全件、不足項目のある下書き、要再確認', async () => {
    const narrative = area(await diagnose(), 'narrative');
    const rows = await listNarratives(db, manager());
    expect(fact(narrative, 'confirmed')).toMatchObject({
      count: rows.filter((r) => r.record.status === 'confirmed').length,
      denominator: rows.length,
    });
    expect(fact(narrative, 'draft_missing_fields').count).toBe(
      rows.filter((r) => r.record.status === 'draft' && r.missingFieldCount > 0).length,
    );
    expect(fact(narrative, 'needs_recheck').count).toBe(
      rows.filter((r) => r.record.status === 'needs_recheck').length,
    );
    expect(narrative.links[0]!.href).toBe('/enterprise/narratives');
  });

  it('開示対応は基準ごとに 1 行（SSBJ・CSRD・ESRS-40a・CDP・MSCI・FTSE）', async () => {
    const disclosure = area(await diagnose(), 'disclosure');
    expect(disclosure.frameworks!.map((f) => f.key)).toEqual([
      'ssbj',
      'csrd',
      'esrs_40a',
      'cdp',
      'msci',
      'ftse',
    ]);
    const line = (key: string) => disclosure.frameworks!.find((f) => f.key === key)!.line;
    expect(line('ssbj')).toContain('124 / 133');
    expect(line('csrd')).toContain('9 / 12');
    expect(line('msci')).toContain('今後対応予定');
    expect(line('esrs_40a')).toContain('算定しない');
    expect(disclosure.links.map((l) => l.href)).toContain('/enterprise/analysis/regulations');
  });

  it('開示の閲覧権限が無い役割には出さず、その旨を 1 行示す', async () => {
    const diagnosis = await diagnose(siteUser());
    expect(diagnosis.areas.map((a) => a.key)).toEqual(['collection', 'evidence', 'ghg']);
    expect(diagnosis.hiddenNote).toBe('閲覧権限が無い領域は表示していません');
  });
});

describe('権限と書込', () => {
  it('監査法人のワークスペース・データの閲覧権限の無い利用者は拒否', async () => {
    await expect(
      diagnose(
        ctxFor(
          'assurance-manager@demo.local',
          ['assurance_manager'],
          ORG_IDS.aoba,
          'assurance_firm',
        ),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(diagnose(ctxFor('site-user@demo.local', []))).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it('他組織の期間は扱わない', async () => {
    await expect(
      diagnose(ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten)),
    ).rejects.toThrow();
  });

  it('書込検知ラッパーで包んでも例外が出ない', async () => {
    const spy = new WriteDetectingDbClient(db);
    await diagnose(manager(), spy);
    await diagnose(siteUser(), spy);
    expect(spy.writes).toEqual([]);
  });
});
