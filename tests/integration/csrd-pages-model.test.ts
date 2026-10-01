import { beforeEach, describe, expect, it } from 'vitest';
import {
  csrdFlowSteps,
  workspaceSummary,
} from '@/app/enterprise/disclosures/csrd/_overview/overview-model';
import {
  CSRD_OPEN_HIGH_PRIORITY_QUERY,
  parseRequirementQuery,
  searchCsrdRequirements,
} from '@/app/enterprise/disclosures/csrd/requirements/form-input';
import { matrixInputsOf } from '@/app/enterprise/disclosures/csrd/settings/dma-view';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { loadDisclosureWorkspace } from '@/lib/services/disclosure';
import {
  filterCsrdRequirements,
  loadCsrdOverview,
  loadCsrdRequirementViews,
} from '@/lib/services/csrd/requirements';
import {
  confirmCsrdDma,
  decideCsrdDmaMatter,
  loadCsrdSettings,
} from '@/lib/services/csrd/settings';
import type { AuthorizationContext, ReportingPeriod } from '@/types/domain';

/**
 * CSRD の画面が使う組み立て（docs/disclosure-first.md §9.4）を、Fixture（§9.3）で確かめる。
 *  - 対応状況の工程 ①〜⑤ の状態と件数（DMA 未確定 → 確定で ① が完了）
 *  - 「優先度『高』（評価対象・未対応）」の一覧への URL は、対応状況の件数と同じ母集団
 *  - マトリクスの位置は §9.3 の算定結果（インパクト × 財務）
 *  - 既存のギャップ分析表の要約（回答済み・データあり）は分母を持つ
 */

const REF = { referenceDate: '2026-08-14' };

const manager: AuthorizationContext = {
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

let db: DemoDbClient;
let fy2026: ReportingPeriod;

beforeEach(async () => {
  db = new DemoDbClient(createFixtureDb());
  fy2026 = (await db.findById('periods', PERIOD_IDS.fy2026))!;
});

async function decideG1AndConfirm() {
  await decideCsrdDmaMatter(db, manager, {
    reportingPeriodId: PERIOD_IDS.fy2026,
    topic: 'G1',
    impactAssessment: 'not_material',
    impactRationale: '算定結果 2.2 で閾値未満（テスト）',
    financialAssessment: 'material',
    financialRationale: '制裁金の算定結果 3.2 が閾値以上（テスト）',
    stakeholderNote: '',
  });
  await confirmCsrdDma(db, manager, PERIOD_IDS.fy2026);
}

describe('対応状況の工程', () => {
  it('Fixture（DMA 未確定・G1 未評価）', async () => {
    const overview = (await loadCsrdOverview(db, manager, fy2026, REF))!;
    const steps = csrdFlowSteps(overview);
    expect(steps.map((s) => [s.title, s.state, s.href])).toEqual([
      [
        '設定（報告範囲・ダブル・マテリアリティ評価）',
        'current',
        '/enterprise/disclosures/csrd/settings',
      ],
      ['要求事項の評価', 'current', '/enterprise/disclosures/csrd/requirements'],
      ['対応計画', 'current', '/enterprise/disclosures/csrd/plans'],
      ['データ収集', 'current', '/enterprise/disclosures/csrd/collection'],
      ['開示ドラフト', 'current', '/enterprise/disclosures/csrd/draft'],
    ]);
    expect(steps[0]!.detail).toBe('DMA 未確定 ／ 判断済み 9 / 10 事項');
    expect(steps[1]!.detail).toBe(
      `評価対象 9 / 12 件 ／ 確認待ち 3 件 ／ 優先度「高」${overview.highPriority} 件`,
    );
    expect(steps[2]!.detail).toBe('対応中 1 件 ／ 未着手 1 件');
    expect(steps[3]!.detail).toBe('計画から作成した収集項目 1 件');
    // Fixture の節はどれも未確定（DMA 未確定のため確定できない。ESRS 2 は本文を保存済み・未確定）
    expect(steps[4]!.detail).toBe('確定 0 節 ／ AI 草案 1 節');
    // 草案の出所は節ごとに示すため、工程の説明では「デモ生成」と決め打ちしない
    expect(steps[4]!.description).toBe(
      '節ごとに AI 草案（候補）を本文に採用し、人が編集して確定します。',
    );
  });

  it('G1 を判断して DMA を確定すると ① が完了になる（重要 6 / 10 事項）', async () => {
    await decideG1AndConfirm();
    const overview = (await loadCsrdOverview(db, manager, fy2026, REF))!;
    const [first, second] = csrdFlowSteps(overview);
    expect(first).toMatchObject({ state: 'done', detail: 'DMA 確定済み ／ 重要 6 / 10 事項' });
    expect(second!.detail).toContain('評価対象 11 / 12 件');
  });

  it('「優先度『高』（評価対象・未対応）」の URL の絞り込みは、対応状況の件数と同じ', async () => {
    const overview = (await loadCsrdOverview(db, manager, fy2026, REF))!;
    const { filters } = parseRequirementQuery(
      Object.fromEntries(
        [...new URLSearchParams(CSRD_OPEN_HIGH_PRIORITY_QUERY).keys()].map((key) => [
          key,
          new URLSearchParams(CSRD_OPEN_HIGH_PRIORITY_QUERY).getAll(key),
        ]),
      ),
    );
    expect(filterCsrdRequirements(overview.views, filters)).toHaveLength(overview.highPriority);
    expect(filterCsrdRequirements(overview.views, { review: ['awaiting'] }).length).toBe(
      overview.awaitingReview,
    );
  });
});

describe('要求事項の検索', () => {
  it('コード・見出しで絞り込み、空の検索語は全件', async () => {
    const { views } = (await loadCsrdRequirementViews(db, manager, fy2026, REF))!;
    expect(searchCsrdRequirements(views, '').map((v) => v.item.code)).toHaveLength(12);
    expect(searchCsrdRequirements(views, 'e1-').map((v) => v.item.code)).toEqual([
      'ESRS-E1-1',
      'ESRS-E1-4',
      'ESRS-E1-5',
      'ESRS-E1-6',
    ]);
    const byTitle = views.find((v) => v.item.code === 'ESRS-S1-9')!.item.questionText.slice(0, 4);
    expect(searchCsrdRequirements(views, byTitle).map((v) => v.item.code)).toContain('ESRS-S1-9');
  });
});

describe('マトリクスの位置', () => {
  it('§9.3 の算定結果（インパクト × 財務）と人の判断', async () => {
    const view = (await loadCsrdSettings(db, manager, fy2026))!;
    expect(
      matrixInputsOf(view.matters).map((p) => [
        p.topic,
        p.impactScore,
        p.financialScore,
        p.outcome,
      ]),
    ).toEqual([
      ['E1', 4.0, 4.0, 'both'],
      ['E2', 2.3, 2.0, 'not_material'],
      ['E3', 3.3, 2.4, 'impact_only'],
      ['E4', 2.2, 1.7, 'not_material'],
      ['E5', 2.0, 2.0, 'not_material'],
      ['S1', 3.3, 3.5, 'both'],
      ['S2', 4.3, 2.0, 'impact_only'],
      ['S3', 1.6, 1.4, 'not_material'],
      ['S4', 1.7, 3.2, 'financial_only'],
      ['G1', 2.2, 3.2, 'not_assessed'],
    ]);
  });
});

describe('既存のギャップ分析表の要約', () => {
  it('回答済み・必須の準備・データあり は分母と並べる', async () => {
    const workspace = (await loadDisclosureWorkspace(
      db,
      manager,
      'csrd',
      fy2026,
      await db.select('periods', { where: { organizationId: ORG_IDS.aomi } }),
      await db.select('metrics', { where: { organizationId: ORG_IDS.aomi } }),
    ))!;
    const summary = workspaceSummary(workspace.rows);
    expect(summary.total).toBe(12);
    expect(summary.answered).toBe(0);
    expect(summary.requiredReady).toBeLessThanOrEqual(summary.requiredTotal);
    expect(summary.withData).toBeLessThanOrEqual(summary.mapped);
    expect(summary.withData + summary.partialData).toBeLessThanOrEqual(summary.mapped);
  });
});
