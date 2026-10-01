import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getURLFromRedirectError } from 'next/dist/client/components/redirect';
import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { CSRD_IDS } from '@/lib/fixtures/csrd';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * CSRD 設定の Server Action（docs/disclosure-first.md §9.4）。
 *  - 入力を取り出してサービスへ渡し、成功したら同じ画面へフラッシュ付きで戻る
 *  - 利用者向けのエラー（入力の誤り・権限・対象なし）は ?error= で同じ画面へ戻し、何も書かない
 *  - 再検証は CSRD 全体（layout）と分析（layout）
 *  - 戻り先の事項コードは ESRS のテーマだけ（送られた文字列で別の画面へ飛ばさない）
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

const actions = await import('@/app/enterprise/disclosures/csrd/settings/actions');

let fixture: FixtureDb;

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  organizationId: string = ORG_IDS.aomi,
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
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
const approverOnly = () => ctxFor('approver@demo.local', ['approver']);

function form(entries: Array<[string, string]>): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

/** Server Action を呼び、リダイレクト先の URL を返す（リダイレクトしなければ失敗） */
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

const SETTINGS = '/enterprise/disclosures/csrd/settings';

const G1_DECISION: Array<[string, string]> = [
  ['reportingPeriodId', PERIOD_IDS.fy2026],
  ['topic', 'G1'],
  ['impactAssessment', 'not_material'],
  ['impactRationale', '算定結果 2.2 で閾値未満（テスト）'],
  ['financialAssessment', 'material'],
  ['financialRationale', '制裁金の算定結果 3.2 が閾値以上（テスト）'],
  ['stakeholderNote', ''],
];

beforeEach(() => {
  fixture = createFixtureDb();
  state.db = new DemoDbClient(fixture);
  state.ctx = manager();
  revalidated.length = 0;
});

function settingsRow() {
  return fixture.csrdAnalysisSettings.find((s) => s.id === CSRD_IDS.settings)!;
}

describe('報告範囲・評価方法', () => {
  it('報告範囲を保存し、設定画面へフラッシュ付きで戻る。CSRD と分析を再検証する', async () => {
    const url = await redirectOf(() =>
      actions.saveCsrdBoundaryAction(
        form([
          ['reportingPeriodId', PERIOD_IDS.fy2026],
          ['consolidationScope', 'same_as_financial'],
          ['consolidationNote', ''],
          ['includedUnitIds', UNIT_IDS.hq],
          ['valueChainScope', 'upstream'],
          ['valueChainNote', '主要サプライヤー（テスト）'],
        ]),
      ),
    );
    expect(url.pathname).toBe(SETTINGS);
    expect(url.searchParams.get('flash')).toBe('csrdBoundarySaved');
    expect(settingsRow()).toMatchObject({
      valueChainScope: 'upstream',
      valueChainNote: '主要サプライヤー（テスト）',
      includedUnitIds: [UNIT_IDS.hq],
    });
    expect(revalidated).toEqual([
      ['/enterprise/disclosures/csrd', 'layout'],
      ['/enterprise/analysis', 'layout'],
    ]);
  });

  it('閾値が範囲外なら ?error= で戻り、何も保存しない', async () => {
    const before = structuredClone(settingsRow());
    const url = await redirectOf(() =>
      actions.saveCsrdMethodAction(
        form([
          ['reportingPeriodId', PERIOD_IDS.fy2026],
          ['impactThreshold', '6'],
          ['financialThreshold', '3.0'],
          ['methodNote', ''],
          ['stakeholderEngagementNote', '聞き取り（テスト）'],
        ]),
      ),
    );
    expect(url.pathname).toBe(SETTINGS);
    expect(url.searchParams.get('error')).toContain('インパクトの閾値');
    expect(url.searchParams.get('flash')).toBeNull();
    expect(settingsRow()).toEqual(before);
    expect(revalidated).toEqual([]);
  });

  it('閾値を保存すると数値で入る', async () => {
    const url = await redirectOf(() =>
      actions.saveCsrdMethodAction(
        form([
          ['reportingPeriodId', PERIOD_IDS.fy2026],
          ['impactThreshold', '3.5'],
          ['financialThreshold', '2.5'],
          ['methodNote', '自社の方法（テスト）'],
          ['stakeholderEngagementNote', '従業員への聞き取り（テスト）'],
        ]),
      ),
    );
    expect(url.searchParams.get('flash')).toBe('csrdMethodSaved');
    expect(settingsRow()).toMatchObject({ impactThreshold: 3.5, financialThreshold: 2.5 });
  });

  it('開示の編集権限が無い役割は保存できない（?error= で戻る）', async () => {
    state.ctx = approverOnly();
    const before = structuredClone(settingsRow());
    const url = await redirectOf(() =>
      actions.saveCsrdBoundaryAction(
        form([
          ['reportingPeriodId', PERIOD_IDS.fy2026],
          ['consolidationScope', 'same_as_financial'],
          ['valueChainScope', 'none'],
        ]),
      ),
    );
    expect(url.pathname).toBe(SETTINGS);
    expect(url.searchParams.get('error')).not.toBeNull();
    expect(settingsRow()).toEqual(before);
  });
});

describe('事項の判断・DMA の確定', () => {
  it('G1 を判断すると事項の画面へ戻り、全事項の判断が揃えば確定できる', async () => {
    const decided = await redirectOf(() => actions.decideCsrdDmaMatterAction(form(G1_DECISION)));
    expect(decided.pathname).toBe(`${SETTINGS}/matters/G1`);
    expect(decided.searchParams.get('flash')).toBe('csrdMatterDecided');
    const g1 = fixture.csrdDmaMatters.find((m) => m.id === CSRD_IDS.matters.G1)!;
    expect(g1).toMatchObject({
      impactAssessment: 'not_material',
      financialAssessment: 'material',
      decidedBy: userId('sustainability@demo.local'),
    });

    const confirmed = await redirectOf(() =>
      actions.confirmCsrdDmaAction(form([['reportingPeriodId', PERIOD_IDS.fy2026]])),
    );
    expect(confirmed.pathname).toBe(SETTINGS);
    expect(confirmed.searchParams.get('flash')).toBe('csrdDmaConfirmed');
    expect(settingsRow().dmaConfirmedBy).toBe(userId('sustainability@demo.local'));
  });

  it('未評価の事項が残っていれば確定できない（理由を ?error= で返す）', async () => {
    const url = await redirectOf(() =>
      actions.confirmCsrdDmaAction(form([['reportingPeriodId', PERIOD_IDS.fy2026]])),
    );
    expect(url.pathname).toBe(SETTINGS);
    expect(url.searchParams.get('error')).toContain('G1');
    expect(settingsRow().dmaConfirmedAt).toBeNull();
  });

  it('評価済みの軸に根拠が無ければ ?error= で事項の画面へ戻る', async () => {
    const url = await redirectOf(() =>
      actions.decideCsrdDmaMatterAction(
        form(
          G1_DECISION.map(([key, value]) =>
            key === 'financialRationale' ? [key, '  '] : [key, value],
          ),
        ),
      ),
    );
    expect(url.pathname).toBe(`${SETTINGS}/matters/G1`);
    expect(url.searchParams.get('error')).toContain('根拠');
    const g1 = fixture.csrdDmaMatters.find((m) => m.id === CSRD_IDS.matters.G1)!;
    expect(g1.financialAssessment).toBe('not_assessed');
  });

  it('ESRS のテーマでない事項コードは設定画面へ戻す（URL に使わない）', async () => {
    const url = await redirectOf(() =>
      actions.decideCsrdDmaMatterAction(
        form(
          G1_DECISION.map(([key, value]) =>
            key === 'topic' ? [key, '../../admin'] : [key, value],
          ),
        ),
      ),
    );
    expect(url.pathname).toBe(SETTINGS);
    expect(url.searchParams.get('error')).not.toBeNull();
  });
});

describe('IRO', () => {
  it('IRO を追加すると算定に入り、確定していた DMA は外れる', async () => {
    await redirectOf(() => actions.decideCsrdDmaMatterAction(form(G1_DECISION)));
    await redirectOf(() =>
      actions.confirmCsrdDmaAction(form([['reportingPeriodId', PERIOD_IDS.fy2026]])),
    );
    expect(settingsRow().dmaConfirmedAt).not.toBeNull();

    const before = fixture.csrdDmaIros.filter(
      (i) => i.matterId === CSRD_IDS.matters.E1 && i.deletedAt === null,
    ).length;
    const url = await redirectOf(() =>
      actions.upsertCsrdDmaIroAction(
        form([
          ['reportingPeriodId', PERIOD_IDS.fy2026],
          ['topic', 'E1'],
          ['iroType', 'opportunity'],
          ['subTopic', '気候変動への適応'],
          ['description', '省エネ製品の需要拡大（テスト）'],
          ['valueChainStage', 'downstream'],
          ['timeHorizon', 'medium'],
          ['financialLikelihood', '3'],
          ['financialMagnitude', '3'],
          ['affectedStakeholders', ''],
          ['relatedImpactIroId', ''],
        ]),
      ),
    );
    expect(url.pathname).toBe(`${SETTINGS}/matters/E1`);
    expect(url.searchParams.get('flash')).toBe('csrdIroSaved');
    expect(
      fixture.csrdDmaIros.filter((i) => i.matterId === CSRD_IDS.matters.E1 && i.deletedAt === null),
    ).toHaveLength(before + 1);
    expect(settingsRow().dmaConfirmedAt).toBeNull();
  });

  it('形の合わない IRO は ?error= で戻り、追加しない', async () => {
    const before = fixture.csrdDmaIros.length;
    const url = await redirectOf(() =>
      actions.upsertCsrdDmaIroAction(
        form([
          ['reportingPeriodId', PERIOD_IDS.fy2026],
          ['topic', 'E1'],
          ['iroType', 'impact'],
          ['description', '説明（テスト）'],
          ['valueChainStage', 'own_operations'],
          ['impactOccurrence', 'potential'],
          ['impactDirection', 'negative'],
          ['impactScale', '3'],
          ['impactScope', '3'],
          ['impactIrremediability', '3'],
          ['impactLikelihood', ''],
        ]),
      ),
    );
    expect(url.pathname).toBe(`${SETTINGS}/matters/E1`);
    expect(url.searchParams.get('error')).toContain('発生可能性');
    expect(fixture.csrdDmaIros).toHaveLength(before);
  });

  it('IRO を論理削除して事項の画面へ戻る', async () => {
    const iroId = CSRD_IDS.iros.E5.financial;
    const url = await redirectOf(() =>
      actions.deleteCsrdDmaIroAction(
        form([
          ['iroId', iroId],
          ['topic', 'E5'],
        ]),
      ),
    );
    expect(url.pathname).toBe(`${SETTINGS}/matters/E5`);
    expect(url.searchParams.get('flash')).toBe('csrdIroDeleted');
    expect(fixture.csrdDmaIros.find((i) => i.id === iroId)!.deletedAt).not.toBeNull();
  });

  it('他組織の利用者は IRO を削除できない', async () => {
    state.ctx = ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten);
    const iroId = CSRD_IDS.iros.E5.financial;
    const url = await redirectOf(() =>
      actions.deleteCsrdDmaIroAction(
        form([
          ['iroId', iroId],
          ['topic', 'E5'],
        ]),
      ),
    );
    expect(url.searchParams.get('error')).not.toBeNull();
    expect(fixture.csrdDmaIros.find((i) => i.id === iroId)!.deletedAt).toBeNull();
  });
});
