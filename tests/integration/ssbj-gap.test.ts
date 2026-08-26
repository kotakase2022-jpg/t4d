import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import {
  carryOverSsbjAssessments,
  createActionPlan,
  createDataCollectionItem,
  filterRequirements,
  loadActionPlans,
  loadDataCollection,
  loadSsbjOverview,
  loadSsbjRequirementDetail,
  loadSsbjRequirementViews,
  runSsbjGapAnalysis,
  saveSsbjReview,
  saveSsbjScope,
} from '@/lib/services/ssbj-gap';
import type { AuthorizationContext, ReportingPeriod, RoleKey } from '@/types/domain';

/**
 * SSBJ ギャップ分析の一連の流れ。
 *
 * 対象判定 → AI ギャップ分析 → 担当者の確認 → 対応計画 → データ収集 が
 * 途切れずにつながること、そして **AI の判定が勝手に最終判定にならないこと** を確かめる。
 */

let db: DemoDbClient;
let fixture: FixtureDb;
let period: ReportingPeriod;

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

const manager = () =>
  ctxFor('sustainability@demo.local', ['sustainability_manager', 'enterprise_admin']);
/** 閲覧のみのロール（開示対応の編集権限を持たない） */
const viewerCtx = () => ctxFor('site-user@demo.local', ['site_contributor']);

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  period = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
});

describe('全体状況', () => {
  it('適用区分・重要性・対応状況を分けて集計する', async () => {
    const overview = await loadSsbjOverview(db, manager(), period, '出所');
    expect(overview).not.toBeNull();
    const { counts } = overview!;

    // 133 要求事項すべてに評価行がある
    expect(counts.total).toBe(133);
    // 対象外・重要性なしは対応状況の内訳から外れる
    expect(counts.notApplicable).toBeGreaterThan(0);
    expect(counts.notMaterial).toBeGreaterThan(0);
    const statusSum = counts.covered + counts.mostlyCovered + counts.partial + counts.notCovered;
    expect(statusSum + counts.notApplicable + counts.notMaterial).toBe(counts.total);
  });

  it('単一の総合点ではなく、3 つの整備度を別々に出す', async () => {
    const overview = (await loadSsbjOverview(db, manager(), period, '出所'))!;
    for (const rate of [overview.disclosureRate, overview.dataRate, overview.processRate]) {
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(100);
    }
    // データ整備・業務プロセスは開示より遅れている（初年度の典型）
    expect(overview.dataRate).toBeLessThan(overview.disclosureRate);
    expect(overview.processRate).toBeLessThan(overview.disclosureRate);
  });

  it('4 領域それぞれの対応率と未対応件数が出る', async () => {
    const overview = (await loadSsbjOverview(db, manager(), period, '出所'))!;
    const areas = overview.areas.map((a) => a.area);
    for (const expected of ['governance', 'strategy', 'risk', 'metrics']) {
      expect(areas, `${expected} 領域の集計が無い`).toContain(expected);
    }
    for (const area of overview.areas) {
      expect(area.total).toBeGreaterThan(0);
      expect(area.rate).toBeGreaterThanOrEqual(0);
    }
  });

  it('優先度の高いギャップが上位に並ぶ（対応済みは含めない）', async () => {
    const overview = (await loadSsbjOverview(db, manager(), period, '出所'))!;
    expect(overview.topPriorities.length).toBeGreaterThan(0);
    for (const view of overview.topPriorities) {
      expect(view.combined).not.toBe('covered');
    }
    // 点数の降順
    const scores = overview.topPriorities.map((v) => v.priority.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});

describe('要求事項一覧の絞り込み', () => {
  it('領域・対応状況・優先度で絞り込める', async () => {
    const loaded = (await loadSsbjRequirementViews(db, manager(), period))!;

    const governance = filterRequirements(loaded.views, { area: ['governance'] });
    expect(governance.length).toBeGreaterThan(0);
    expect(governance.every((v) => v.area === 'governance')).toBe(true);

    const notCovered = filterRequirements(loaded.views, { coverage: ['not_covered'] });
    expect(notCovered.every((v) => v.combined === 'not_covered')).toBe(true);

    const high = filterRequirements(loaded.views, { priority: ['high'] });
    expect(high.every((v) => v.priority.priority === 'high')).toBe(true);
  });

  it('要求事項番号で検索できる', async () => {
    const loaded = (await loadSsbjRequirementViews(db, manager(), period))!;
    const hit = filterRequirements(loaded.views, { search: '気候-47' });
    expect(hit.length).toBe(3);
    expect(hit.every((v) => v.item.code.startsWith('気候-47'))).toBe(true);
  });
});

describe('対象判定・重要性判断', () => {
  it('対象外にするなら理由が必須（理由なしは拒否する）', async () => {
    const loaded = (await loadSsbjRequirementViews(db, manager(), period))!;
    const target = loaded.views[0]!;
    await expect(
      saveSsbjScope(db, manager(), {
        assessmentId: target.assessment.id,
        applicability: 'not_applicable',
        applicabilityReason: '   ',
        materiality: 'not_assessed',
        materialityReason: '',
        ownerDepartment: '',
      }),
    ).rejects.toThrow('対象外とする場合は、その理由を入力してください。');
  });

  it('重要性なしにするなら理由が必須', async () => {
    const loaded = (await loadSsbjRequirementViews(db, manager(), period))!;
    const target = loaded.views[0]!;
    await expect(
      saveSsbjScope(db, manager(), {
        assessmentId: target.assessment.id,
        applicability: 'applicable',
        applicabilityReason: '',
        materiality: 'not_material',
        materialityReason: '',
        ownerDepartment: '',
      }),
    ).rejects.toThrow('重要性なしとする場合は、その理由を入力してください。');
  });

  it('理由を添えれば保存でき、監査ログに前後が残る', async () => {
    const loaded = (await loadSsbjRequirementViews(db, manager(), period))!;
    const target = loaded.views.find((v) => v.assessment.applicability === 'applicable')!;

    await saveSsbjScope(db, manager(), {
      assessmentId: target.assessment.id,
      applicability: 'not_applicable',
      applicabilityReason: '当社は該当する活動を行っていないため',
      materiality: 'not_assessed',
      materialityReason: '',
      ownerDepartment: '経営企画部',
    });

    const after = await db.findById('ssbjAssessments', target.assessment.id);
    expect(after?.applicability).toBe('not_applicable');
    expect(after?.ownerDepartment).toBe('経営企画部');

    const events = fixture.auditEvents.filter(
      (e) => e.resourceType === 'ssbj_assessment' && e.resourceId === target.assessment.id,
    );
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)?.beforeSummary).toContain('適用区分 applicable');
    expect(events.at(-1)?.afterSummary).toContain('適用区分 not_applicable');
  });

  it('閲覧者は判定を保存できない', async () => {
    const loaded = (await loadSsbjRequirementViews(db, manager(), period))!;
    await expect(
      saveSsbjScope(db, viewerCtx(), {
        assessmentId: loaded.views[0]!.assessment.id,
        applicability: 'applicable',
        applicabilityReason: '',
        materiality: 'material',
        materialityReason: '',
        ownerDepartment: '',
      }),
    ).rejects.toThrow();
  });
});

describe('人工知能によるギャップ分析と担当者の確認', () => {
  it('AI は 3 観点を判定するが、最終判定は入れない', async () => {
    const loaded = (await loadSsbjRequirementViews(db, manager(), period))!;
    const target = loaded.views.find((v) => v.item.code === '気候-10')!;

    await runSsbjGapAnalysis(db, manager(), target.assessment.id);
    const after = await db.findById('ssbjAssessments', target.assessment.id);

    expect(after?.aiStatus).not.toBeNull();
    expect(after?.aiComment.length).toBeGreaterThan(10);
    expect(after?.aiRecommendation.length).toBeGreaterThan(10);
    expect(after?.aiRunId).not.toBeNull();
    // ここが肝心: AI は最終判定を確定しない
    expect(after?.finalStatus).toBeNull();
    expect(after?.reviewDecision).toBeNull();
  });

  it('AI の実行結果は ai_runs に残り、根拠と確信度を持つ', async () => {
    const loaded = (await loadSsbjRequirementViews(db, manager(), period))!;
    const target = loaded.views.find((v) => v.item.code === '気候-10')!;
    await runSsbjGapAnalysis(db, manager(), target.assessment.id);

    const runs = fixture.aiRuns.filter((r) => r.featureType === 'ssbjGapAnalysis');
    expect(runs.length).toBe(1);
    expect(runs[0]?.promptVersion).toContain('ssbj-gap-analysis');
    expect(runs[0]?.confidence).toBeGreaterThan(0);
    expect(runs[0]?.warnings.join(' ')).toContain('最終判定は担当者が確認して確定してください');
  });

  it('担当者が確認して初めて最終判定が入る', async () => {
    const loaded = (await loadSsbjRequirementViews(db, manager(), period))!;
    const target = loaded.views.find((v) => v.item.code === '気候-11')!;
    await runSsbjGapAnalysis(db, manager(), target.assessment.id);

    await saveSsbjReview(db, manager(), {
      assessmentId: target.assessment.id,
      decision: 'approve_ai',
      disclosureStatus: 'unconfirmed',
      dataStatus: 'unconfirmed',
      processStatus: 'unconfirmed',
      comment: 'AI の判定内容を確認し、妥当と判断しました。',
    });

    const after = await db.findById('ssbjAssessments', target.assessment.id);
    expect(after?.finalStatus).not.toBeNull();
    expect(after?.reviewDecision).toBe('approved');
    expect(after?.reviewedBy).toBe(userId('sustainability@demo.local'));
    expect(after?.reviewComment).toContain('妥当と判断');
  });

  it('担当者が判定を修正すると、修正後の値が最終判定になる', async () => {
    const loaded = (await loadSsbjRequirementViews(db, manager(), period))!;
    const target = loaded.views.find((v) => v.item.code === '気候-12')!;

    await saveSsbjReview(db, manager(), {
      assessmentId: target.assessment.id,
      decision: 'modify',
      disclosureStatus: 'covered',
      dataStatus: 'covered',
      processStatus: 'partial',
      comment: '記載箇所を確認したうえで引き下げました。',
    });

    const after = await db.findById('ssbjAssessments', target.assessment.id);
    expect(after?.reviewDecision).toBe('modified');
    // 3 観点のうち最も遅れているものが最終判定になる
    expect(after?.finalStatus).toBe('partial');
    expect(after?.processStatus).toBe('partial');
  });

  it('AI 判定が無いまま「AI の判定を承認」はできない', async () => {
    const loaded = (await loadSsbjRequirementViews(db, manager(), period))!;
    const noAi = loaded.views.find((v) => v.assessment.aiStatus === null)!;
    await expect(
      saveSsbjReview(db, manager(), {
        assessmentId: noAi.assessment.id,
        decision: 'approve_ai',
        disclosureStatus: 'covered',
        dataStatus: 'covered',
        processStatus: 'covered',
        comment: '',
      }),
    ).rejects.toThrow('AI による判定がありません');
  });

  it('AI を再実行すると、担当者の確認はやり直しになる', async () => {
    const loaded = (await loadSsbjRequirementViews(db, manager(), period))!;
    const target = loaded.views.find((v) => v.item.code === '気候-13')!;

    await saveSsbjReview(db, manager(), {
      assessmentId: target.assessment.id,
      decision: 'modify',
      disclosureStatus: 'covered',
      dataStatus: 'covered',
      processStatus: 'covered',
      comment: '確認済み',
    });
    expect((await db.findById('ssbjAssessments', target.assessment.id))?.finalStatus).toBe(
      'covered',
    );

    await runSsbjGapAnalysis(db, manager(), target.assessment.id);
    const after = await db.findById('ssbjAssessments', target.assessment.id);
    expect(after?.finalStatus, '再分析後も古い最終判定が残っている').toBeNull();
    expect(after?.reviewDecision).toBeNull();
    // 確認日・確認者も消す（いつの判定を確認したのかが食い違わないように）
    expect(after?.reviewedAt).toBeNull();
    expect(after?.reviewedBy).toBeNull();
    expect(after?.reviewComment).toBe('');
  });
});

describe('対応計画とデータ収集への接続', () => {
  it('ギャップから対応計画を作れる', async () => {
    const loaded = (await loadSsbjRequirementViews(db, manager(), period))!;
    const target = loaded.views.find((v) => v.combined === 'not_covered')!;

    const plan = await createActionPlan(db, manager(), {
      assessmentId: target.assessment.id,
      gapKind: 'data',
      title: 'スコープ3 の算定方法を決めてデータを集める',
      detail: 'カテゴリーごとの算定方法を決める',
      actionType: 'data_collection',
      department: '調達部',
      assigneeUserId: userId('sustainability@demo.local'),
      dueDate: '2026-12-31',
      priority: 'high',
    });

    expect(plan.status).toBe('not_started');
    const plans = await loadActionPlans(db, manager(), period);
    const found = plans.find((p) => p.plan.id === plan.id);
    expect(found?.item?.id).toBe(target.item.id);
    expect(found?.assigneeName).toBeTruthy();
    expect(found?.daysLeft).not.toBeNull();
  });

  it('対応内容が空なら拒否する', async () => {
    const loaded = (await loadSsbjRequirementViews(db, manager(), period))!;
    await expect(
      createActionPlan(db, manager(), {
        assessmentId: loaded.views[0]!.assessment.id,
        gapKind: 'disclosure',
        title: '   ',
        detail: '',
        actionType: 'disclosure_addition',
        department: '',
        assigneeUserId: null,
        dueDate: null,
        priority: 'medium',
      }),
    ).rejects.toThrow('対応内容を入力してください。');
  });

  it('データギャップの対応計画から、担当と期限を持つデータ収集項目を作れる', async () => {
    const loaded = (await loadSsbjRequirementViews(db, manager(), period))!;
    const target = loaded.views.find((v) => v.item.code === '気候-55')!;

    const plan = await createActionPlan(db, manager(), {
      assessmentId: target.assessment.id,
      gapKind: 'data',
      title: 'カテゴリー別排出量を収集する',
      detail: '',
      actionType: 'data_collection',
      department: '調達部',
      assigneeUserId: null,
      dueDate: '2026-12-31',
      priority: 'high',
    });

    await createDataCollectionItem(db, manager(), {
      planId: plan.id,
      metricCode: 'scope3_cat4',
      metricName: 'スコープ3 カテゴリー4（輸送・配送）排出量',
      unit: 't-CO2e',
      unitId: UNIT_IDS.hq,
      ownerUserId: userId('site-user@demo.local'),
      dueDate: '2026-11-30',
      requiresEvidence: true,
      department: '物流部',
    });

    // 指標マスターが作られ、担当・期限つきの割当が入る
    const metric = fixture.metrics.find((m) => m.code === 'scope3_cat4');
    expect(metric?.name).toContain('カテゴリー4');
    expect(metric?.requiresEvidence).toBe(true);
    expect(metric?.responsibleDepartment).toBe('物流部');

    const assignment = fixture.metricAssignments.find(
      (a) => a.metricId === metric?.id && a.unitId === UNIT_IDS.hq,
    );
    expect(assignment?.dueDate).toBe('2026-11-30');
    expect(assignment?.ownerUserId).toBe(userId('site-user@demo.local'));

    // 対応計画から辿れるようになる
    const after = await db.findById('ssbjActionPlans', plan.id);
    expect(after?.linkedMetricCode).toBe('scope3_cat4');
    expect(after?.status).toBe('in_progress');

    // データ収集管理画面に出る
    const rows = await loadDataCollection(db, manager(), period);
    const row = rows.find((r) => r.metricCode === 'scope3_cat4');
    expect(row?.unitName).toBeTruthy();
    expect(row?.ownerName).toBeTruthy();
    expect(row?.collectedValue, 'まだ入力されていないはず').toBeNull();
  });

  it('同じ指標・拠点・期間の収集項目は二重に作らない', async () => {
    const loaded = (await loadSsbjRequirementViews(db, manager(), period))!;
    const plan = await createActionPlan(db, manager(), {
      assessmentId: loaded.views[0]!.assessment.id,
      gapKind: 'data',
      title: 'テスト',
      detail: '',
      actionType: 'data_collection',
      department: '',
      assigneeUserId: null,
      dueDate: null,
      priority: 'low',
    });
    const input = {
      planId: plan.id,
      metricCode: 'test_metric',
      metricName: 'テスト指標',
      unit: 't',
      unitId: UNIT_IDS.hq,
      ownerUserId: null,
      dueDate: '2026-12-31',
      requiresEvidence: false,
      department: '',
    };
    await createDataCollectionItem(db, manager(), input);
    await createDataCollectionItem(db, manager(), input);

    const metric = fixture.metrics.find((m) => m.code === 'test_metric')!;
    const assignments = fixture.metricAssignments.filter((a) => a.metricId === metric.id);
    expect(assignments).toHaveLength(1);
  });
});

describe('前年度からの引き継ぎ', () => {
  it('前年の判断を引き継ぎ、再評価が必要な項目に理由を付ける', async () => {
    const previous = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2025)!;
    const managerCtx = manager();

    // 前年度の評価を用意する（今年度の内容をそのまま前年へ複製）
    const currentAssessments = fixture.ssbjAssessments.filter(
      (a) => a.reportingPeriodId === period.id,
    );
    fixture.ssbjAssessments.push(
      ...currentAssessments.map((a) => ({
        ...a,
        id: `${a.id}-prev`,
        reportingPeriodId: previous.id,
        finalStatus: 'partial' as const,
        materiality: 'material' as const,
        ownerDepartment: '前年度の担当部署',
      })),
    );
    // 今年度側は未確認へ戻す（引き継ぎ対象にするため）
    for (const a of currentAssessments) a.finalStatus = null;

    const result = await carryOverSsbjAssessments(db, managerCtx, period, previous);
    expect(result.copied).toBeGreaterThan(0);
    expect(result.recheck).toBeGreaterThan(0);

    const sample = await db.findById('ssbjAssessments', currentAssessments[0]!.id);
    expect(sample?.ownerDepartment).toBe('前年度の担当部署');
    expect(sample?.carriedOverFrom).toBe(`${currentAssessments[0]!.id}-prev`);
    // 前年に完了していないので、今年度の再評価が必要と記録される
    expect(sample?.recheckReason).toContain('前年度に対応が完了していません');
    // 引き継いだだけでは最終判定にしない
    expect(sample?.finalStatus).toBeNull();
  });
});

describe('要求事項の詳細', () => {
  it('要求事項の原文・関連指標・優先順位の根拠を返す', async () => {
    const loaded = (await loadSsbjRequirementViews(db, manager(), period))!;
    const scope1 = loaded.views.find((v) => v.item.code === '気候-47(1)')!;

    const detail = await loadSsbjRequirementDetail(db, manager(), period, scope1.item.id);
    expect(detail).not.toBeNull();
    // 基準の原文が入っている
    expect(detail!.view.item.guidance).toContain('温室効果ガス排出の絶対総量');
    // 紐づく指標が返る
    expect(detail!.metrics.map((m) => m.code)).toContain('scope1');
    // 優先順位の根拠が 6 項目そろう
    expect(detail!.view.priority.factors).toHaveLength(6);
  });

  it('存在しない要求事項は null を返す', async () => {
    expect(await loadSsbjRequirementDetail(db, manager(), period, 'not-exist')).toBeNull();
  });
});
