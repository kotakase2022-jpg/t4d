import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getURLFromRedirectError } from 'next/dist/client/components/redirect';
import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { CSRD_IDS } from '@/lib/fixtures/csrd';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { IDLE_FORM_STATE, type FormActionState } from '@/lib/errors/form-action-state';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * CSRD 要求事項の Server Action（docs/disclosure-first.md §9.4）。
 *  - 担当者の入力・AI ギャップ分析（候補）・候補を採用／修正して確定・対応計画の追加
 *  - 成功したら要求事項の詳細へフラッシュ付きで戻る。利用者向けのエラーは ?error= で戻し、何も書かない。
 *    入力を伴う確定（担当者の入力・修正して確定）は、リダイレクトせず理由と送った値を返す（画面が入力を残す）
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

/** 入力を残すフォームの Action が断ったときの状態（遷移したら失敗） */
async function failureOf(
  run: (previous: FormActionState, formData: FormData) => Promise<FormActionState>,
  formData: FormData,
): Promise<FormActionState> {
  try {
    return await run(IDLE_FORM_STATE, formData);
  } catch (error) {
    if (isRedirectError(error)) {
      throw new Error(`断られずに遷移しました: ${getURLFromRedirectError(error)}`, {
        cause: error,
      });
    }
    throw error;
  }
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
        IDLE_FORM_STATE,
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

  it('閲覧だけの役割は入力できない（理由と入力を返し、書かない）', async () => {
    state.ctx = ctxFor('approver@demo.local', ['approver']);
    const before = structuredClone(assessment('ESRS-E3-4'));
    const failed = await failureOf(
      actions.saveCsrdAssessmentAction,
      form([
        ['reportingPeriodId', PERIOD_IDS.fy2026],
        ['itemId', item('ESRS-E3-4')],
        ['disclosureStatus', 'covered'],
        ['dataStatus', 'covered'],
        ['processStatus', 'covered'],
        ['comment', ''],
      ]),
    );
    expect(failed.status).toBe('error');
    expect(failed.message).not.toBeNull();
    expect(assessment('ESRS-E3-4')).toEqual(before);
  });

  it('要求事項 ID が UUID でなければ書かず、理由を返す（URL に使わない）', async () => {
    const failed = await failureOf(
      actions.saveCsrdAssessmentAction,
      form([
        ['reportingPeriodId', PERIOD_IDS.fy2026],
        ['itemId', '../../settings'],
        ['disclosureStatus', 'covered'],
        ['dataStatus', 'covered'],
        ['processStatus', 'covered'],
      ]),
    );
    expect(failed.status).toBe('error');
    expect(failed.message).not.toBeNull();
  });

  it('AI の候補と違う値を理由なしで確定しようとすると、選んだ値を残して理由を求める（書かない）', async () => {
    const before = structuredClone(assessment('ESRS2-SBM-3'));
    const failed = await failureOf(
      actions.saveCsrdAssessmentAction,
      form([
        ['reportingPeriodId', PERIOD_IDS.fy2026],
        ['itemId', item('ESRS2-SBM-3')],
        ['disclosureStatus', 'covered'],
        ['dataStatus', 'covered'],
        ['processStatus', 'covered'],
        ['comment', ''],
      ]),
    );
    expect(failed.message).toContain('修正の理由（コメント）');
    expect(failed.values).toEqual(
      expect.arrayContaining([
        ['disclosureStatus', 'covered'],
        ['dataStatus', 'covered'],
        ['processStatus', 'covered'],
      ]),
    );
    expect(assessment('ESRS2-SBM-3')).toEqual(before);
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
    // 実行した提供元（Mock）をフラッシュに渡す（「デモ生成」と書くのは Mock のときだけ）
    expect(analyzed.searchParams.get('ai')).toBe('mock');
    const candidate = assessment('ESRS-E1-6');
    expect(candidate.aiStatus).not.toBeNull();
    expect(candidate.finalStatus).toBeNull();
    expect(candidate.reviewedAt).toBeNull();

    // 表示した候補の実行日時が違えば（分析がやり直された後）、採用しない
    const stale = await redirectOf(() =>
      actions.reviewCsrdAssessmentAction(
        form([
          ['assessmentId', candidate.id],
          ['itemId', item('ESRS-E1-6')],
          ['decision', 'approved'],
          ['comment', ''],
          ['aiEvaluatedAt', '2000-01-01T00:00:00.000Z'],
        ]),
      ),
    );
    expect(stale.searchParams.get('error')).toContain('AI の候補が更新されています');
    expect(assessment('ESRS-E1-6').finalStatus).toBeNull();

    const reviewed = await redirectOf(() =>
      actions.reviewCsrdAssessmentAction(
        form([
          ['assessmentId', candidate.id],
          ['itemId', item('ESRS-E1-6')],
          ['decision', 'approved'],
          ['comment', ''],
          ['aiEvaluatedAt', candidate.aiEvaluatedAt!],
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

  it('「修正して確定」のフォームは、理由が無ければ選んだ 3 観点を残して理由を求める（書かない）', async () => {
    const before = structuredClone(assessment('ESRS-E1-4'));
    const failed = await failureOf(
      actions.reviewCsrdAssessmentFormAction,
      form([
        ['assessmentId', before.id],
        ['itemId', item('ESRS-E1-4')],
        ['decision', 'modified'],
        ['disclosureStatus', 'covered'],
        ['dataStatus', 'partial'],
        ['processStatus', 'mostly_covered'],
        ['comment', '   '],
      ]),
    );
    expect(failed.message).toContain('修正の理由');
    expect(failed.values).toEqual(
      expect.arrayContaining([
        ['disclosureStatus', 'covered'],
        ['dataStatus', 'partial'],
        ['processStatus', 'mostly_covered'],
      ]),
    );
    expect(assessment('ESRS-E1-4')).toEqual(before);
    // 理由があれば確定して詳細へ戻る（空振りテストでないことの確認）
    const url = await redirectOf(() =>
      actions.reviewCsrdAssessmentFormAction(
        IDLE_FORM_STATE,
        form([
          ['assessmentId', before.id],
          ['itemId', item('ESRS-E1-4')],
          ['decision', 'modified'],
          ['disclosureStatus', 'covered'],
          ['dataStatus', 'partial'],
          ['processStatus', 'mostly_covered'],
          ['comment', '目標の記載を確認した（テスト）'],
        ]),
      ),
    );
    expect(url.searchParams.get('decision')).toBe('modified');
    expect(assessment('ESRS-E1-4').reviewDecision).toBe('modified');
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
