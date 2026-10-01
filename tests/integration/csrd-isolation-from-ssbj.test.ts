import { describe, expect, it } from 'vitest';
import { CSRD_IDS } from '@/lib/fixtures/csrd';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  adoptCsrdDraft,
  confirmCsrdDraft,
  generateCsrdDraft,
  saveCsrdDraftBody,
} from '@/lib/services/csrd/draft';
import {
  createCsrdActionPlan,
  createCsrdCollectionItem,
  updateCsrdActionPlan,
} from '@/lib/services/csrd/plans';
import {
  reviewCsrdAssessment,
  runCsrdGapAnalysis,
  saveCsrdAssessment,
} from '@/lib/services/csrd/requirements';
import {
  confirmCsrdDma,
  decideCsrdDmaMatter,
  saveCsrdBoundary,
  saveCsrdMethod,
  upsertCsrdDmaIro,
} from '@/lib/services/csrd/settings';
import {
  loadActionPlans,
  loadDataCollection,
  loadSsbjHeadline,
  loadSsbjOverview,
  loadSsbjRequirementViews,
} from '@/lib/services/ssbj-gap';
import { loadSsbjDrafts } from '@/lib/services/ssbj-draft';
import { loadSsbjSettings } from '@/lib/services/ssbj-settings';
import type { AuthorizationContext, ReportingPeriod } from '@/types/domain';

/**
 * CSRD の書込が SSBJ に混入しない（docs/disclosure-first.md §9.3「SSBJ の表は再利用しない」）。
 * CSRD の分析条件・DMA・評価・AI 分析・計画・収集項目・草案を一通り書いた前後で、
 * SSBJ の対応状況・要求事項・計画・収集・ドラフト・設定の出力と SSBJ の表が同一であることを確かめる。
 */

const ctx: AuthorizationContext = {
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
};

const REF = { referenceDate: '2026-08-14' };

async function ssbjOutputs(db: DemoDbClient, period: ReportingPeriod) {
  const metrics = await db.select('metrics', { where: { organizationId: ORG_IDS.aomi } });
  return {
    overview: await loadSsbjOverview(db, ctx, period, '架空の出典', REF),
    views: await loadSsbjRequirementViews(db, ctx, period, REF),
    headline: await loadSsbjHeadline(db, ctx, period),
    plans: await loadActionPlans(db, ctx, period, REF),
    collection: await loadDataCollection(db, ctx, period, REF),
    drafts: await loadSsbjDrafts(db, ctx, period),
    settings: await loadSsbjSettings(db, ctx, period, metrics),
  };
}

describe('CSRD の書込の前後で SSBJ の出力が同一', () => {
  it('分析条件・DMA・評価・AI・計画・収集・草案を書いても SSBJ は変わらない', async () => {
    const fixture = createFixtureDb();
    const db = new DemoDbClient(fixture);
    const period = (await db.findById('periods', PERIOD_IDS.fy2026))!;
    // SSBJ の要求事項の読込は初回に評価行を作るため、先に 1 回読んでから比べる
    await ssbjOutputs(db, period);
    const before = await ssbjOutputs(db, period);
    const ssbjTablesBefore = structuredClone({
      assessments: fixture.ssbjAssessments,
      plans: fixture.ssbjActionPlans,
      settings: fixture.ssbjAnalysisSettings,
      drafts: fixture.ssbjDisclosureDrafts,
      topics: fixture.materialityTopics,
    });

    await saveCsrdBoundary(db, ctx, {
      reportingPeriodId: period.id,
      consolidationScope: 'same_as_financial',
      consolidationNote: '',
      includedUnitIds: [UNIT_IDS.hq],
      valueChainScope: 'both',
      valueChainNote: '',
    });
    await saveCsrdMethod(db, ctx, {
      reportingPeriodId: period.id,
      impactThreshold: 3.0,
      financialThreshold: 3.0,
      methodNote: '',
      stakeholderEngagementNote: '従業員への聞き取り（テスト）',
    });
    await upsertCsrdDmaIro(db, ctx, {
      reportingPeriodId: period.id,
      topic: 'G1',
      iroType: 'opportunity',
      subTopic: '',
      description: '企業行動の評価向上（テスト）',
      valueChainStage: 'own_operations',
      timeHorizon: 'long',
      impactOccurrence: null,
      impactDirection: null,
      impactScale: null,
      impactScope: null,
      impactIrremediability: null,
      impactLikelihood: null,
      financialLikelihood: 2,
      financialMagnitude: 2,
      humanRights: false,
      affectedStakeholders: '',
      relatedImpactIroId: null,
    });
    await decideCsrdDmaMatter(db, ctx, {
      reportingPeriodId: period.id,
      topic: 'G1',
      impactAssessment: 'not_material',
      impactRationale: '閾値未満（テスト）',
      financialAssessment: 'material',
      financialRationale: '閾値以上（テスト）',
      stakeholderNote: '',
    });
    await confirmCsrdDma(db, ctx, period.id);
    const { assessment } = await runCsrdGapAnalysis(db, ctx, {
      reportingPeriodId: period.id,
      itemId: CSRD_IDS.items['ESRS-E1-6']!,
    });
    await reviewCsrdAssessment(db, ctx, {
      assessmentId: assessment.id,
      decision: 'approved',
      comment: '',
    });
    await saveCsrdAssessment(db, ctx, {
      reportingPeriodId: period.id,
      itemId: CSRD_IDS.items['ESRS-G1-1']!,
      disclosureStatus: 'partial',
      dataStatus: 'partial',
      processStatus: 'partial',
      comment: '',
    });
    const plan = await createCsrdActionPlan(db, ctx, {
      reportingPeriodId: period.id,
      itemId: CSRD_IDS.items['ESRS-E1-6']!,
      gapKind: 'data',
      title: 'Scope2 ロケーション基準を集める（テスト）',
      detail: '',
      actionType: 'data_collection',
      department: '',
      assigneeUserId: null,
      dueDate: null,
      priority: 'high',
    });
    await updateCsrdActionPlan(db, ctx, {
      planId: plan.id,
      status: 'in_progress',
      department: '',
      assigneeUserId: null,
      dueDate: null,
      priority: 'high',
    });
    // 部署を空にして、指標マスター（SSBJ と共有）の担当部署を書き換えない
    await createCsrdCollectionItem(db, ctx, {
      planId: plan.id,
      metricCode: 'scope2_location',
      metricName: 'Scope2（ロケーション基準）',
      unit: 't-CO2e',
      unitId: UNIT_IDS.west,
      ownerUserId: null,
      dueDate: '2026-12-01',
      requiresEvidence: false,
      department: '',
    });
    const draft = await generateCsrdDraft(db, ctx, period, 'E1');
    await adoptCsrdDraft(db, ctx, draft.id);
    await saveCsrdDraftBody(db, ctx, draft.id, `${draft.aiBody}（加筆）`);
    await confirmCsrdDraft(db, ctx, draft.id);

    const after = await ssbjOutputs(db, period);
    expect(after).toEqual(before);
    expect({
      assessments: fixture.ssbjAssessments,
      plans: fixture.ssbjActionPlans,
      settings: fixture.ssbjAnalysisSettings,
      drafts: fixture.ssbjDisclosureDrafts,
      topics: fixture.materialityTopics,
    }).toEqual(ssbjTablesBefore);
    // CSRD の行は CSRD の表にだけ書かれている（空振りテストでないことの確認）
    expect(fixture.csrdActionPlans.some((p) => p.id === plan.id)).toBe(true);
    expect(fixture.csrdDisclosureDrafts.find((d) => d.id === draft.id)!.confirmedAt).not.toBeNull();
  });
});
