import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { ENGAGEMENT_IDS, ORG_IDS, dataPointId, metricId, userId } from '@/lib/fixtures/dataset';
import {
  createSample,
  createSignoff,
  createSnapshot,
  detectSnapshotChanges,
  evaluateSignoffBlockers,
  loadDataRoom,
  loadEngagement,
  loadLatestSnapshot,
  loadPopulation,
  loadTestingWorkspace,
} from '@/lib/services/assurance';
import { updateDataPointValue } from '@/lib/services/data-point-workflow';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * 監査法人 Vertical Slice の Integration テスト（指示書 20 章）。
 *
 *   Engagement → Grant → Data Room → Snapshot → 変更検知
 *   → Population → Sampling → Testing → Issue → PBC → Sign-off 抑止
 */

let db: DemoDbClient;
let fixture: FixtureDb;

function assuranceCtx(
  email: string,
  roleKeys: RoleKey[],
  engagementIds: string[],
  organizationId = ORG_IDS.aoba,
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType: 'assurance_firm',
      organizationName: 'あおば保証監査法人',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds,
    demo: true,
  };
}

function enterpriseCtx(email: string, roleKeys: RoleKey[]): AuthorizationContext {
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

const ENG = ENGAGEMENT_IDS.main;
const manager = () => assuranceCtx('assurance-manager@demo.local', ['assurance_manager'], [ENG]);
const partner = () => assuranceCtx('assurance-partner@demo.local', ['engagement_partner'], [ENG]);
const staff = () => assuranceCtx('assurance-staff@demo.local', ['assurance_staff'], [ENG]);
/** 未アサインの法人管理者 */
const firmAdmin = () => assuranceCtx('assurance-admin@demo.local', ['assurance_admin'], []);
/** 別法人 */
const otherFirm = () =>
  assuranceCtx('other-assurance-manager@demo.local', ['assurance_manager'], [], ORG_IDS.kurobe);

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('案件アクセス（アプリ層の認可）', () => {
  it('アサインされたメンバーは案件を取得できる', async () => {
    const context = await loadEngagement(db, manager(), ENG);
    expect(context.engagement.code).toBe('ENG-2026-001');
    expect(context.clientName).toBe('青海テクノロジー株式会社');
  });

  it('未アサインの法人管理者は案件を取得できない（存在を秘匿）', async () => {
    await expect(loadEngagement(db, firmAdmin(), ENG)).rejects.toThrow(/見つかりません/);
  });

  it('別法人のユーザーは案件を取得できない', async () => {
    await expect(loadEngagement(db, otherFirm(), ENG)).rejects.toThrow(/見つかりません/);
  });
});

describe('Data Room（Read-only・許諾範囲のみ）', () => {
  it('許諾された承認済みデータのみが共有される', async () => {
    const { rows } = await loadDataRoom(db, manager(), ENG);
    expect(rows.length).toBeGreaterThan(0);

    const dataPointIds = rows.map((r) => r.dataPointId);
    // 欧州販売子会社（Unit 未許諾）は含まれない
    expect(dataPointIds).not.toContain(dataPointId('EU', 'scope1', 'FY2026'));
    // 水使用量（Metric 未許諾）も含まれない
    expect(dataPointIds).not.toContain(dataPointId('HQ', 'water', 'FY2026'));
    // 未承認（レビュー中）の東日本工場 廃棄物も含まれない
    expect(dataPointIds).not.toContain(dataPointId('EAST', 'waste', 'FY2026'));
    // 許諾済み・承認済みは含まれる
    expect(dataPointIds).toContain(dataPointId('HQ', 'scope1', 'FY2026'));
  });

  it('許諾（Grant）を取り消すと Data Room から消える', async () => {
    // 既存テストは dataRoomItems の取り下げを試していたが、
    // 企業が実際に押すのは「許諾の取消」。Demo Mode には RLS が無いので、
    // アプリ層が grants を見ていないと取消が効かない。
    const before = await loadDataRoom(db, manager(), ENG);
    const target = metricId('AOMI', 'scope1');
    expect(before.rows.filter((r) => r.metric?.id === target).length).toBeGreaterThan(0);

    for (const g of await db.select('grants', { where: { engagementId: ENG } })) {
      if (g.subjectType === 'metric' && g.subjectId === target) {
        await db.update('grants', g.id, { revokedAt: new Date().toISOString() });
      }
    }

    const after = await loadDataRoom(db, manager(), ENG);
    expect(after.rows.filter((r) => r.metric?.id === target)).toHaveLength(0);
  });

  it('企業が承認を取り消した値は Data Room に出ない', async () => {
    const shared = await db.select('dataRoomItems', {
      where: { engagementId: ENG, sourceType: 'data_point', withdrawnAt: { isNull: true } },
    });
    const first = shared[0]!;
    await db.update('dataPoints', first.sourceId, { status: 'draft' });

    const after = await loadDataRoom(db, manager(), ENG);
    expect(after.rows.map((r) => r.dataPointId)).not.toContain(first.sourceId);
  });

  it('Data Room の行はすべて Snapshot 済みで、Snapshot 後変更が 2 件検出される', async () => {
    const { rows, snapshot } = await loadDataRoom(db, manager(), ENG);
    expect(snapshot).not.toBeNull();
    expect(rows.every((r) => r.snapshotIncluded)).toBe(true);

    const changed = rows.filter((r) => r.changedSinceSnapshot);
    expect(changed).toHaveLength(2);
  });
});

describe('Snapshot と変更検知', () => {
  it('Snapshot は固定時点の値を保持し、後続の変更で不変のまま', async () => {
    const snapshot = await loadLatestSnapshot(db, ENG);
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;

    const items = await db.select('snapshotItems', { where: { snapshotId: snapshot.id } });
    const target = items.find((i) => i.sourceId === dataPointId('HQ', 'scope1', 'FY2026'));
    expect(target).toBeDefined();
    const frozenValue = Number(target?.valueSnapshot.value);

    // 企業側が値を変更する（承認済みの変更には write + review 権限が必要）
    await updateDataPointValue(
      db,
      enterpriseCtx('sustainability@demo.local', ['sustainability_manager']),
      {
        dataPointId: dataPointId('HQ', 'scope1', 'FY2026'),
        value: frozenValue + 500,
        unitOfMeasure: 't-CO2e',
        changeReason: '再集計',
      },
    );

    const after = await db.select('snapshotItems', { where: { snapshotId: snapshot.id } });
    const afterTarget = after.find((i) => i.sourceId === dataPointId('HQ', 'scope1', 'FY2026'));
    // Snapshot 側の値は変わらない
    expect(Number(afterTarget?.valueSnapshot.value)).toBe(frozenValue);

    // 変更として検知される
    const changes = await detectSnapshotChanges(db, manager(), snapshot.id);
    const detected = changes.find((c) => c.snapshotItemId === target?.id);
    expect(detected).toBeDefined();
    expect(detected?.afterSummary).toContain(String(frozenValue + 500));
  });

  it('新しい Snapshot を作成すると現在値で固定され、変更は解消される', async () => {
    const created = await createSnapshot(db, manager(), ENG, 'SNAP-2（再固定）');
    expect(created.itemCount).toBeGreaterThan(0);

    const changes = await detectSnapshotChanges(db, manager(), created.id);
    expect(changes).toHaveLength(0);
  });

  it('Snapshot 作成には権限が必要', async () => {
    const viewer = assuranceCtx('assurance-manager@demo.local', ['assurance_viewer'], [ENG]);
    await expect(createSnapshot(db, viewer, ENG, 'X')).rejects.toThrow(/権限/);
  });
});

describe('母集団とサンプリング', () => {
  it('母集団は Snapshot 由来で、スコープとの差を欠損として持つ', async () => {
    const view = await loadPopulation(db, manager(), ENG);
    expect(view).not.toBeNull();
    if (!view) return;

    expect(view.population.itemCount).toBeGreaterThan(0);
    expect(view.population.missingCount).toBe(
      Math.max(0, view.expectedInScope - view.population.itemCount),
    );
    expect(view.population.completenessProcedureNote).toContain('P-01');
  });

  it('判断による抽出は、選んだ項目だけを抽出する', async () => {
    // 画面に方式は並んでいたが、対象を選ぶ入力が無く、選ぶと必ず 0 件で失敗していた。
    const view = await loadPopulation(db, manager(), ENG);
    if (!view) throw new Error('population missing');
    const picked = view.items.slice(0, 3).map((i) => i.id);

    const sample = await createSample(db, staff(), {
      engagementId: ENG,
      populationId: view.population.id,
      name: 'SMP-JUDGMENTAL',
      method: 'judgmental',
      seed: 'JUDGMENTAL-1',
      parameters: { targetSize: 3, selectedItemIds: picked },
      rationale: '重要と判断した項目を名指しで選定した。',
    });

    const items = await db.select('sampleItems', { where: { sampleId: sample.id } });
    expect(items.map((i) => i.populationItemId).sort()).toEqual([...picked].sort());
  });

  it('判断による抽出で対象未選択なら、理由の分かるエラーになる', async () => {
    const view = await loadPopulation(db, manager(), ENG);
    if (!view) throw new Error('population missing');
    await expect(
      createSample(db, staff(), {
        engagementId: ENG,
        populationId: view.population.id,
        name: 'SMP-EMPTY',
        method: 'judgmental',
        seed: 'JUDGMENTAL-2',
        parameters: { targetSize: 3 },
        rationale: 'テスト',
      }),
    ).rejects.toThrow(/対象の項目を 1 件以上選んで/);
  });

  it('同じ Seed のサンプルは同じ項目を選ぶ（再現可能）', async () => {
    const view = await loadPopulation(db, manager(), ENG);
    if (!view) throw new Error('population missing');

    const first = await createSample(db, staff(), {
      engagementId: ENG,
      populationId: view.population.id,
      name: 'SMP-A',
      method: 'random',
      seed: 'REPRODUCIBLE-SEED',
      parameters: { targetSize: 5 },
      rationale: 'テスト',
    });

    // 別の Fixture インスタンスで同じ操作をしても同じ結果になる
    const fixture2 = createFixtureDb();
    const db2 = new DemoDbClient(fixture2);
    const view2 = await loadPopulation(db2, manager(), ENG);
    if (!view2) throw new Error('population missing');
    const second = await createSample(db2, staff(), {
      engagementId: ENG,
      populationId: view2.population.id,
      name: 'SMP-A',
      method: 'random',
      seed: 'REPRODUCIBLE-SEED',
      parameters: { targetSize: 5 },
      rationale: 'テスト',
    });

    const itemsA = (await db.select('sampleItems', { where: { sampleId: first.id } }))
      .map((i) => i.populationItemId)
      .sort();
    const itemsB = (await db2.select('sampleItems', { where: { sampleId: second.id } }))
      .map((i) => i.populationItemId)
      .sort();
    expect(itemsA).toEqual(itemsB);
  });

  it('サンプル作成時に調書（テスト）が自動生成される', async () => {
    const view = await loadPopulation(db, manager(), ENG);
    if (!view) throw new Error('population missing');
    const sample = await createSample(db, staff(), {
      engagementId: ENG,
      populationId: view.population.id,
      name: 'SMP-B',
      method: 'random',
      seed: 'S',
      parameters: { targetSize: 3 },
      rationale: 'テスト',
    });
    const items = await db.select('sampleItems', { where: { sampleId: sample.id } });
    const tests = await db.select('tests', {
      where: { sampleItemId: { in: items.map((i) => i.id) } },
    });
    expect(tests).toHaveLength(3);
    expect(tests.every((t) => t.status === 'not_started')).toBe(true);
  });

  it('サンプリング権限がないと実行できない', async () => {
    const view = await loadPopulation(db, manager(), ENG);
    if (!view) throw new Error('population missing');
    const viewer = assuranceCtx('assurance-manager@demo.local', ['assurance_viewer'], [ENG]);
    await expect(
      createSample(db, viewer, {
        engagementId: ENG,
        populationId: view.population.id,
        name: 'X',
        method: 'random',
        seed: 'S',
        parameters: { targetSize: 1 },
        rationale: '',
      }),
    ).rejects.toThrow(/権限/);
  });
});

describe('Testing 三ペインのデータ', () => {
  it('サンプル項目・調書・手続を取得できる', async () => {
    const { sample, rows, procedures } = await loadTestingWorkspace(db, manager(), ENG);
    expect(sample).not.toBeNull();
    expect(rows.length).toBe(10);
    expect(procedures.length).toBe(8);
    // P-01〜P-05 と P-08 が必須（P-06 質問 / P-07 閲覧は任意）
    expect(procedures.filter((p) => p.required).length).toBe(6);
  });

  it('Snapshot 固定値と現在値の差分を行ごとに持つ', async () => {
    const { rows } = await loadTestingWorkspace(db, manager(), ENG);
    for (const row of rows) {
      expect(typeof row.snapshotValue).toBe('number');
      expect(row.metricName).not.toBe('');
    }
  });
});

describe('Sign-off の抑止条件', () => {
  it('初期状態では複数の抑止条件が立っている', async () => {
    const blockers = await evaluateSignoffBlockers(db, partner(), ENG, 'partner_approved');
    const codes = blockers.map((b) => b.code);

    expect(codes).toContain('required_sample_incomplete');
    expect(codes).toContain('required_procedure_incomplete');
    expect(codes).toContain('high_issue_unresolved');
    expect(codes).toContain('critical_pbc_outstanding');
    expect(codes).toContain('snapshot_change_unassessed');
    expect(codes).toContain('previous_stage_missing');
  });

  it('抑止条件がある間は Sign-off を作成できない', async () => {
    await expect(createSignoff(db, partner(), ENG, 'partner_approved', null)).rejects.toThrow(
      /抑止条件/,
    );
  });

  it('未解決の High Issue を解消すると該当の抑止が外れる', async () => {
    const before = await evaluateSignoffBlockers(db, manager(), ENG, 'prepared');
    expect(before.map((b) => b.code)).toContain('high_issue_unresolved');

    const issues = await db.select('issues', { where: { engagementId: ENG, severity: 'high' } });
    for (const issue of issues) {
      await db.update('issues', issue.id, {
        status: 'resolved',
        resolution: '企業側で修正済みであることを確認した。',
        resolvedAt: new Date().toISOString(),
      });
    }

    const after = await evaluateSignoffBlockers(db, manager(), ENG, 'prepared');
    expect(after.map((b) => b.code)).not.toContain('high_issue_unresolved');
  });

  it('すべての抑止条件を解消すると Sign-off できる', async () => {
    // 1. High Issue を解消
    for (const issue of await db.select('issues', { where: { engagementId: ENG } })) {
      if (issue.status === 'resolved' || issue.status === 'closed') continue;
      await db.update('issues', issue.id, {
        status: 'resolved',
        resolution: '解消済み',
        resolvedAt: new Date().toISOString(),
      });
    }

    // 2. Critical PBC を受理
    for (const request of await db.select('pbcRequests', { where: { engagementId: ENG } })) {
      if (request.priority !== 'critical') continue;
      await db.update('pbcRequests', request.id, { status: 'accepted' });
    }

    // 3. Snapshot 後変更を評価済みにする
    const snapshot = await loadLatestSnapshot(db, ENG);
    if (snapshot) {
      for (const change of await detectSnapshotChanges(db, manager(), snapshot.id)) {
        await db.insert('snapshotChanges', [
          {
            ...change,
            assessment: 'no_impact',
            assessedBy: manager().userId,
            assessedAt: new Date().toISOString(),
          },
        ]);
      }
    }

    // 4. すべてのテストで必須手続を完了し、reviewed にする
    const { rows, procedures } = await loadTestingWorkspace(db, manager(), ENG);
    const required = procedures.filter((p) => p.required);
    for (const row of rows) {
      for (const procedure of required) {
        const existing = await db.select('testResults', {
          where: { testId: row.testId, procedureId: procedure.id },
        });
        if (existing.length > 0) continue;
        await db.insert('testResults', [
          {
            id: `${row.testId}-${procedure.id}`,
            testId: row.testId,
            procedureId: procedure.id,
            engagementId: ENG,
            assuranceFirmId: ORG_IDS.aoba,
            result: 'pass',
            recalculationInput: null,
            recalculationResult: null,
            recordedValue: null,
            difference: null,
            note: 'テスト',
            completedBy: staff().userId,
            completedAt: new Date().toISOString(),
          },
        ]);
      }
      await db.update('tests', row.testId, {
        status: 'reviewed',
        preparedBy: staff().userId,
        preparedAt: new Date().toISOString(),
        reviewedBy: manager().userId,
        reviewedAt: new Date().toISOString(),
      });
    }

    // 5. prepared → reviewed → partner_approved の順に Sign-off
    const preparedBlockers = await evaluateSignoffBlockers(db, staff(), ENG, 'prepared');
    expect(preparedBlockers).toHaveLength(0);
    await createSignoff(db, staff(), ENG, 'prepared', '作成完了');

    await createSignoff(db, manager(), ENG, 'reviewed', 'レビュー完了');
    await createSignoff(db, partner(), ENG, 'partner_approved', '承認');

    const signoffs = await db.select('signoffs', { where: { engagementId: ENG } });
    expect(signoffs.map((s) => s.signoffStage).sort()).toEqual([
      'partner_approved',
      'prepared',
      'reviewed',
    ]);

    // 代理 Sign-off ではないこと（実行者本人が記録されている）
    const partnerSignoff = signoffs.find((s) => s.signoffStage === 'partner_approved');
    expect(partnerSignoff?.userId).toBe(userId('assurance-partner@demo.local'));
  });

  it('段階に対応する権限がないと Sign-off できない', async () => {
    await expect(createSignoff(db, staff(), ENG, 'partner_approved', null)).rejects.toThrow(/権限/);
  });
});

describe('企業側の許諾取消が即座に反映される', () => {
  it('指標の許諾を取り消すと Data Room から消える', async () => {
    const before = await loadDataRoom(db, manager(), ENG);
    const scope1Count = before.rows.filter(
      (r) => r.metric?.id === metricId('AOMI', 'scope1'),
    ).length;
    expect(scope1Count).toBeGreaterThan(0);

    // Data Room 共有そのものを取り下げる（企業側の操作）
    for (const item of await db.select('dataRoomItems', { where: { engagementId: ENG } })) {
      const dp = await db.findById('dataPoints', item.sourceId);
      if (dp?.metricId === metricId('AOMI', 'scope1')) {
        await db.update('dataRoomItems', item.id, { withdrawnAt: new Date().toISOString() });
      }
    }

    const after = await loadDataRoom(db, manager(), ENG);
    expect(after.rows.filter((r) => r.metric?.id === metricId('AOMI', 'scope1'))).toHaveLength(0);
  });
});
