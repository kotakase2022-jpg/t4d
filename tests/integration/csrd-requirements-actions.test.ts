import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getURLFromRedirectError } from 'next/dist/client/components/redirect';
import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { CSRD_IDS } from '@/lib/fixtures/csrd';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * CSRD 要求事項の Server Action（docs/disclosure-first.md §9.4）。
 *  - 担当者の入力・AI ギャップ分析（候補）・候補を採用／修正して確定・対応計画の追加
 *  - 成功したら要求事項の詳細へフラッシュ付きで戻る。利用者向けのエラーは ?error= で戻し、何も書かない
 *  - AI は ai_* だけを書く（最終判定は人の操作で入る）
 *  - 戻り先には UUID の要求事項 ID だけを使う
 */

const state: { ctx: AuthorizationContext | null; db: DemoDbClient | null } = {
  ctx: null,
  db: null,
};
const revalidated: Array<[string, string | undefined]> = [];

vi.mock('@/lib/auth/session', () => ({
  requireEnterpriseContext: async () => state.ctx,
}));
vi.mock('@/lib/repositories', () => ({
  getDb: async () => state.db,
}));
vi.mock('next/cache', () => ({
  revalidatePath: (path: string, type?: string) => {
    revalidated.push([path, type]);
  },
}));

const actions = await import('@/app/enterprise/disclosures/csrd/requirements/actions');

let fixture: FixtureDb;

function ctxFor(email: string, roleKeys: RoleKey[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: 'テスト組織',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);

function form(entries: Array<[string, string]>): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

async function redirectOf(run: () => Promise<unknown>): Promise<URL> {
  try {
    await run();
  } catch (error) {
    if (isRedirectError(error)) {
      return new URL(getURLFromRedirectError(error), 'http://localhost');
    }
    throw error;
  }
  throw new Error('リダイレクトしなかった');
}

const item = (code: string) => CSRD_IDS.items[code]!;
const assessment = (code: string) =>
  fixture.csrdAssessments.find((a) => a.id === CSRD_IDS.assessments[code])!;
const detailPath = (code: string) => `/enterprise/disclosures/csrd/requirements/${item(code)}`;

beforeEach(() => {
  fixture = createFixtureDb();
  state.db = new DemoDbClient(fixture);
  state.ctx = manager();
  revalidated.length = 0;
});

describe('担当者の入力', () => {
  it('3 観点を保存して最終判定を入れ、詳細へ戻る', async () => {
    const url = await redirectOf(() =>
      actions.saveCsrdAssessmentAction(
        form([
          ['reportingPeriodId', PERIOD_IDS.fy2026],
          ['itemId', item('ESRS-E3-4')],
          ['disclosureStatus', 'partial'],
          ['dataStatus', 'covered'],
          ['processStatus', 'mostly_covered'],
          ['comment', '取水量の資料を確認（テスト）'],
          ['ownerDepartment', '環境部'],
        ]),
      ),
    );
    expect(url.pathname).toBe(detailPath('ESRS-E3-4'));
    expect(url.searchParams.get('flash')).toBe('csrdAssessmentSaved');
    expect(assessment('ESRS-E3-4')).toMatchObject({
      finalStatus: 'partial',
      ownerDepartment: '環境部',
      reviewedBy: userId('sustainability@demo.local'),
    });
    expect(revalidated).toEqual([
      ['/enterprise/disclosures/csrd', 'layout'],
      ['/enterprise/analysis', 'layout'],
    ]);
  });

  it('閲覧だけの役割は入力できない（?error= で戻り、書かない）', async () => {
    state.ctx = ctxFor('approver@demo.local', ['approver']);
    const before = structuredClone(assessment('ESRS-E3-4'));
    const url = await redirectOf(() =>
      actions.saveCsrdAssessmentAction(
        form([
          ['reportingPeriodId', PERIOD_IDS.fy2026],
          ['itemId', item('ESRS-E3-4')],
          ['disclosureStatus', 'covered'],
          ['dataStatus', 'covered'],
          ['processStatus', 'covered'],
          ['comment', ''],
        ]),
      ),
    );
    expect(url.pathname).toBe(detailPath('ESRS-E3-4'));
    expect(url.searchParams.get('error')).not.toBeNull();
    expect(assessment('ESRS-E3-4')).toEqual(before);
  });

  it('要求事項 ID が UUID でなければ一覧へ戻す（URL に使わない）', async () => {
    const url = await redirectOf(() =>
      actions.saveCsrdAssessmentAction(
        form([
          ['reportingPeriodId', PERIOD_IDS.fy2026],
          ['itemId', '../../settings'],
          ['disclosureStatus', 'covered'],
          ['dataStatus', 'covered'],
          ['processStatus', 'covered'],
        ]),
      ),
    );
    expect(url.pathname).toBe('/enterprise/disclosures/csrd/requirements');
    expect(url.searchParams.get('error')).not.toBeNull();
  });
});

describe('AI ギャップ分析と担当者の確認', () => {
  it('AI は候補だけを書き、「候補を採用」で最終判定が入る', async () => {
    const analyzed = await redirectOf(() =>
      actions.runCsrdGapAnalysisAction(
        form([
          ['reportingPeriodId', PERIOD_IDS.fy2026],
          ['itemId', item('ESRS-E1-6')],
        ]),
      ),
    );
    expect(analyzed.pathname).toBe(detailPath('ESRS-E1-6'));
    expect(analyzed.searchParams.get('flash')).toBe('csrdGapAnalyzed');
    const candidate = assessment('ESRS-E1-6');
    expect(candidate.aiStatus).not.toBeNull();
    expect(candidate.finalStatus).toBeNull();
    expect(candidate.reviewedAt).toBeNull();

    const reviewed = await redirectOf(() =>
      actions.reviewCsrdAssessmentAction(
        form([
          ['assessmentId', candidate.id],
          ['itemId', item('ESRS-E1-6')],
          ['decision', 'approved'],
          ['comment', ''],
        ]),
      ),
    );
    expect(reviewed.pathname).toBe(detailPath('ESRS-E1-6'));
    expect(reviewed.searchParams.get('flash')).toBe('csrdReviewSaved');
    expect(reviewed.searchParams.get('decision')).toBe('approved');
    expect(assessment('ESRS-E1-6')).toMatchObject({
      finalStatus: candidate.aiStatus,
      reviewDecision: 'approved',
    });
  });

  it('修正して確定はコメントが必須（無ければ ?error= で戻り、書かない）', async () => {
    const before = structuredClone(assessment('ESRS-E1-4'));
    const url = await redirectOf(() =>
      actions.reviewCsrdAssessmentAction(
        form([
          ['assessmentId', before.id],
          ['itemId', item('ESRS-E1-4')],
          ['decision', 'modified'],
          ['disclosureStatus', 'partial'],
          ['dataStatus', 'partial'],
          ['processStatus', 'partial'],
          ['comment', ''],
        ]),
      ),
    );
    expect(url.pathname).toBe(detailPath('ESRS-E1-4'));
    expect(url.searchParams.get('error')).toContain('コメント');
    expect(assessment('ESRS-E1-4')).toEqual(before);

    const modified = await redirectOf(() =>
      actions.reviewCsrdAssessmentAction(
        form([
          ['assessmentId', before.id],
          ['itemId', item('ESRS-E1-4')],
          ['decision', 'modified'],
          ['disclosureStatus', 'partial'],
          ['dataStatus', 'partial'],
          ['processStatus', 'partial'],
          ['comment', '目標の記載を確認した（テスト）'],
        ]),
      ),
    );
    expect(modified.searchParams.get('decision')).toBe('modified');
    expect(assessment('ESRS-E1-4')).toMatchObject({
      finalStatus: 'partial',
      reviewDecision: 'modified',
    });
  });

  it('評価対象でない要求事項（対象外）は分析できない', async () => {
    const before = structuredClone(assessment('ESRS-E5-5'));
    const url = await redirectOf(() =>
      actions.runCsrdGapAnalysisAction(
        form([
          ['reportingPeriodId', PERIOD_IDS.fy2026],
          ['itemId', item('ESRS-E5-5')],
        ]),
      ),
    );
    expect(url.pathname).toBe(detailPath('ESRS-E5-5'));
    expect(url.searchParams.get('error')).toContain('評価対象');
    expect(assessment('ESRS-E5-5')).toEqual(before);
  });
});

describe('対応計画の追加', () => {
  it('評価対象の要求事項に計画を追加して詳細へ戻る', async () => {
    const before = fixture.csrdActionPlans.length;
    const url = await redirectOf(() =>
      actions.createCsrdActionPlanAction(
        form([
          ['reportingPeriodId', PERIOD_IDS.fy2026],
          ['itemId', item('ESRS-E1-6')],
          ['gapKind', 'data'],
          ['title', 'ロケーション基準の Scope2 を集める（テスト）'],
          ['detail', ''],
          ['actionType', 'data_collection'],
          ['department', '環境部'],
          ['assigneeUserId', ''],
          ['dueDate', '2026-12-31'],
          ['priority', 'high'],
        ]),
      ),
    );
    expect(url.pathname).toBe(detailPath('ESRS-E1-6'));
    expect(url.searchParams.get('flash')).toBe('csrdPlanCreated');
    expect(fixture.csrdActionPlans).toHaveLength(before + 1);
    const plan = fixture.csrdActionPlans.at(-1)!;
    expect(plan).toMatchObject({
      assessmentId: CSRD_IDS.assessments['ESRS-E1-6'],
      status: 'not_started',
      dueDate: '2026-12-31',
    });
  });

  it('対応内容が空なら ?error= で戻り、追加しない', async () => {
    const before = fixture.csrdActionPlans.length;
    const url = await redirectOf(() =>
      actions.createCsrdActionPlanAction(
        form([
          ['reportingPeriodId', PERIOD_IDS.fy2026],
          ['itemId', item('ESRS-E1-6')],
          ['gapKind', 'data'],
          ['title', ' '],
          ['actionType', 'data_collection'],
          ['priority', 'high'],
        ]),
      ),
    );
    expect(url.searchParams.get('error')).toContain('対応内容');
    expect(fixture.csrdActionPlans).toHaveLength(before);
  });
});
