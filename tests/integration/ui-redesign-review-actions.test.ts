import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getURLFromRedirectError } from 'next/dist/client/components/redirect';
import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { NextRequest } from 'next/server';
import { COMMENT_MAX_LENGTH } from '@/lib/domain/comment-limits';
import { USER_ERROR_TOKEN_COOKIE, USER_ERROR_TOKEN_PARAM } from '@/lib/errors/user-error-token';
import { ENGAGEMENT_IDS, ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { applyDemoEdits } from '@/lib/repositories/demo-edit-codec';
import { readDemoEdits } from '@/lib/repositories/demo-persistence';
import { createCollectionCampaign, createReportingPeriod } from '@/lib/services/master-data';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * UI シンプル化・UX 再設計（5cb0d11）の検証で確定した所見の回帰テスト（Server Action・middleware・Demo Mode の持ち回り）。
 *
 *  - SEC-1: 外から作った `?error=` の文を、本物の画面（ログインなど）の警告として出さない
 *  - SEC-2: 回答の戻り先を、認可の前に他社の回答から組み立てない（存在の有無が分かる）
 *  - SEC-4: 案件のチームに加えられるのは、自法人の有効なメンバーだけ
 *  - BIZ-1: 一括の差戻しで理由が長すぎるときは、1 行も書き換えずに理由を返す
 *  - F8（UX）: 機能設定の保存の業務エラーは「機能設定」タブへ戻す
 *  - F1（持ち回り）: 報告年度・収集キャンペーンを、結果の画面が別のインスタンスに届いても出す
 */

const jar = vi.hoisted(() => new Map<string, string>());
const state = vi.hoisted(() => ({
  ctx: null as AuthorizationContext | null,
  db: null as unknown,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string, options?: { maxAge?: number }) => {
      if (options?.maxAge === 0 || value === '') jar.delete(name);
      else jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
  headers: async () => new Headers(),
}));
vi.mock('@/lib/auth/session', () => ({
  requireEnterpriseContext: async () => state.ctx,
  requireAssuranceContext: async () => state.ctx,
}));
vi.mock('@/lib/repositories', () => ({
  getDb: async () => state.db,
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const enterpriseActions = await import('@/app/enterprise/actions');
const assuranceActions = await import('@/app/assurance/actions');
const settingsActions = await import('@/app/enterprise/settings/actions');
const { redirectWithUserError } = await import('@/lib/errors/user-facing');
const { middleware } = await import('@/middleware');

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  jar.clear();
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  state.db = db;
  state.ctx = null;
  delete (globalThis as { __t4dAppliedDemoResets?: unknown }).__t4dAppliedDemoResets;
});

function enterprise(email: string, roleKeys: RoleKey[]): AuthorizationContext {
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

function assuranceManager(): AuthorizationContext {
  return {
    userId: userId('assurance-manager@demo.local'),
    email: 'assurance-manager@demo.local',
    displayName: 'assurance-manager@demo.local',
    workspace: {
      organizationId: ORG_IDS.aoba,
      organizationType: 'assurance_firm',
      organizationName: 'あおば保証監査法人',
      roleKeys: ['assurance_manager'],
      unitScopeIds: [],
    },
    engagementIds: [ENGAGEMENT_IDS.main],
    demo: true,
  };
}

function form(entries: Array<[string, string]>): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

async function redirectOf(run: () => Promise<unknown>): Promise<URL> {
  try {
    await run();
  } catch (error) {
    if (isRedirectError(error)) return new URL(getURLFromRedirectError(error), 'http://localhost');
    throw error;
  }
  throw new Error('リダイレクトしなかった');
}

// ----------------------------------------------------------------------
// SEC-1 ?error= の出どころの確認
// ----------------------------------------------------------------------

describe('SEC-1 業務エラーの ?error= は、サーバーが載せたものだけ出す', () => {
  it('理由を載せるときに合言葉を Cookie と URL の両方に置く', async () => {
    const url = await redirectOf(() => redirectWithUserError('/login', '入力を確認してください'));
    expect(url.pathname).toBe('/login');
    expect(url.searchParams.get('error')).toBe('入力を確認してください');
    const token = url.searchParams.get(USER_ERROR_TOKEN_PARAM);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(jar.get(USER_ERROR_TOKEN_COOKIE)).toBe(token);
  });

  /** middleware が書き換えた先（内部の書き換え。ブラウザの URL は変えない） */
  const rewrittenTo = (response: Response) => {
    const target = response.headers.get('x-middleware-rewrite');
    return target ? new URL(target) : null;
  };

  it('外から作ったリンク（合言葉なし・違う合言葉）の ?error= は、ログイン画面のサーバーの描画から外す', async () => {
    const phishing = encodeURIComponent('パスワードを support@evil.example へ送ってください');
    const forged = await middleware(
      new NextRequest(`http://localhost/login?error=${phishing}&next=%2Fenterprise`),
    );
    // リダイレクトにしない（Next が 127.0.0.1 を localhost に直し、ローカルで Cookie の無い origin へ移るため）
    expect(forged.headers.get('location')).toBeNull();
    const target = rewrittenTo(forged)!;
    expect(target.pathname).toBe('/login');
    expect(target.searchParams.has('error')).toBe(false);
    // 他の引数は残す
    expect(target.searchParams.get('next')).toBe('/enterprise');

    const wrong = await middleware(
      new NextRequest(`http://localhost/login?error=${phishing}&et=${'a'.repeat(32)}`, {
        headers: { cookie: `${USER_ERROR_TOKEN_COOKIE}=${'b'.repeat(32)}` },
      }),
    );
    const wrongTarget = rewrittenTo(wrong)!;
    expect(wrongTarget.searchParams.has('error')).toBe(false);
    expect(wrongTarget.searchParams.has(USER_ERROR_TOKEN_PARAM)).toBe(false);
  });

  it('ログイン済みの画面でも同じ（CSP は付けたまま）', async () => {
    const response = await middleware(
      new NextRequest('http://localhost/enterprise/data?error=x&status=draft', {
        headers: { cookie: 't4d_demo_user=sustainability@demo.local' },
      }),
    );
    const target = rewrittenTo(response)!;
    expect(target.pathname).toBe('/enterprise/data');
    expect(target.search).toBe('?status=draft');
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self' 'nonce-");
  });

  it('同じブラウザに置いた合言葉と一致すれば、そのまま描く', async () => {
    const url = await redirectOf(() => redirectWithUserError('/login', '入力を確認してください'));
    const token = jar.get(USER_ERROR_TOKEN_COOKIE)!;
    const passed = await middleware(
      new NextRequest(`http://localhost${url.pathname}${url.search}`, {
        headers: { cookie: `${USER_ERROR_TOKEN_COOKIE}=${token}` },
      }),
    );
    expect(passed.headers.get('location')).toBeNull();
    expect(rewrittenTo(passed)).toBeNull();
    expect(passed.headers.get('x-middleware-next')).toBe('1');
  });

  it('?error= が無い画面は何もしない', async () => {
    const plain = await middleware(new NextRequest('http://localhost/login?next=%2Fenterprise'));
    expect(plain.headers.get('location')).toBeNull();
    expect(rewrittenTo(plain)).toBeNull();
  });
});

// ----------------------------------------------------------------------
// SEC-2 回答の戻り先は自組織の回答だけから組み立てる
// ----------------------------------------------------------------------

describe('SEC-2 他社の回答 ID を送っても、戻り先から存在が分からない', () => {
  it('他社の回答と存在しない回答は同じ戻り先。自社の回答は要求事項の画面へ戻る', async () => {
    state.ctx = enterprise('sustainability@demo.local', ['sustainability_manager']);
    const own = fixture.disclosureResponses.find((r) => r.organizationId === ORG_IDS.aomi)!;
    const foreignId = fid('disclosure_response', 'SOTEN/FY2026/test');
    fixture.disclosureResponses.push({ ...own, id: foreignId, organizationId: ORG_IDS.soten });

    const save = (responseId: string) =>
      redirectOf(() =>
        enterpriseActions.saveCdpResponseAction(
          form([
            ['responseId', responseId],
            ['answerText', '回答'],
            ['answerNumeric', '数値ではない'],
          ]),
        ),
      );

    const foreign = await save(foreignId);
    const missing = await save(fid('disclosure_response', 'does-not-exist'));
    expect(foreign.pathname).toBe(missing.pathname);
    expect(foreign.pathname).toBe('/enterprise/disclosures/cdp');
    // 他社の回答は書き換えない
    expect(fixture.disclosureResponses.find((r) => r.id === foreignId)?.organizationId).toBe(
      ORG_IDS.soten,
    );

    const mine = await save(own.id);
    expect(mine.pathname).toMatch(new RegExp(`/enterprise/disclosures/(cdp|csrd)/${own.itemId}$`));
  });
});

// ----------------------------------------------------------------------
// SEC-4 チームに加えられるのは有効なメンバーだけ
// ----------------------------------------------------------------------

describe('SEC-4 停止中・招待中の法人メンバーは案件のチームに加えられない', () => {
  const target = userId('assurance-admin@demo.local');
  const activeRows = () =>
    fixture.engagementMembers.filter(
      (m) => m.engagementId === ENGAGEMENT_IDS.main && m.userId === target && m.removedAt === null,
    );

  beforeEach(() => {
    // 加える対象をチームの外に置く
    fixture.engagementMembers = fixture.engagementMembers.filter(
      (m) => !(m.engagementId === ENGAGEMENT_IDS.main && m.userId === target),
    );
    state.ctx = assuranceManager();
  });

  const assign = () =>
    redirectOf(() =>
      assuranceActions.assignEngagementMemberAction(
        form([
          ['engagementId', ENGAGEMENT_IDS.main],
          ['userId', target],
          ['roleKey', 'assurance_staff'],
        ]),
      ),
    ).catch((error: unknown) => error);

  it.each(['suspended', 'invited'] as const)(
    '%s のメンバーは理由を返して加えない',
    async (status) => {
      const membership = fixture.memberships.find(
        (m) => m.organizationId === ORG_IDS.aoba && m.userId === target,
      )!;
      membership.status = status;
      const result = await assign();
      expect(result).toBeInstanceOf(URL);
      expect((result as URL).searchParams.get('error')).toContain('有効なメンバー');
      expect(activeRows()).toHaveLength(0);
    },
  );

  it('有効なメンバーは加えられる（検査が空回りしていない）', async () => {
    const membership = fixture.memberships.find(
      (m) => m.organizationId === ORG_IDS.aoba && m.userId === target,
    )!;
    expect(membership.status).toBe('active');
    await assign();
    expect(activeRows()).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------
// BIZ-1 一括の差戻し（Action）
// ----------------------------------------------------------------------

describe('BIZ-1 一括の差戻しの理由が長すぎるときは、1 行も書き換えずに理由を返す', () => {
  it('結果は「断った」として返り（成功の色で出さない）、選んだ行は提出済みのまま', async () => {
    state.ctx = enterprise('reviewer@demo.local', ['reviewer']);
    const targets = fixture.dataPoints
      .filter((d) => d.organizationId === ORG_IDS.aomi && d.status === 'submitted' && !d.deletedAt)
      .slice(0, 2);
    expect(targets.length).toBeGreaterThan(0);

    const result = await enterpriseActions.bulkTransitionAction(
      null,
      form([
        ...targets.map((t): [string, string] => ['selected', t.id]),
        ['to', 'returned'],
        ['comment', 'あ'.repeat(COMMENT_MAX_LENGTH + 1)],
      ]),
    );
    expect(result.rejected).toBe(true);
    expect(result.succeeded).toBe(0);
    expect(result.message).toContain(`${COMMENT_MAX_LENGTH} 文字以内`);
    for (const t of targets) {
      expect(fixture.dataPoints.find((d) => d.id === t.id)?.status).toBe('submitted');
    }
  });
});

// ----------------------------------------------------------------------
// F8（UX） 機能設定の業務エラーは機能設定タブへ
// ----------------------------------------------------------------------

describe('F8 機能設定の保存の業務エラーは「機能設定」タブへ戻す', () => {
  it('有効・無効を選ばずに送ると、機能設定タブで理由を出す（メンバーのタブへ飛ばさない）', async () => {
    state.ctx = enterprise('enterprise-admin@demo.local', ['enterprise_admin']);
    const url = await redirectOf(() => settingsActions.setDisclosureFirstAction(form([])));
    expect(url.pathname).toBe('/enterprise/settings');
    expect(url.searchParams.get('tab')).toBe('features');
    expect(url.searchParams.get('error')).toContain('開示優先モード');
  });

  it('権限の無い役割の業務エラーも機能設定タブへ', async () => {
    state.ctx = enterprise('sustainability@demo.local', ['sustainability_manager']);
    const url = await redirectOf(() =>
      settingsActions.setDisclosureFirstAction(form([['disclosureFirst', 'on']])),
    );
    expect(url.searchParams.get('tab')).toBe('features');
    expect(url.searchParams.get('error')).toBeTruthy();
  });
});

// ----------------------------------------------------------------------
// F1（持ち回り） 報告年度・収集キャンペーン
// ----------------------------------------------------------------------

describe('F1 報告年度・収集キャンペーンは Cookie で持ち回す（結果の画面が別のインスタンスでも出る）', () => {
  it('作成した年度・キャンペーン・収集スコープが、新しいインスタンスにも戻る', async () => {
    const admin = enterprise('enterprise-admin@demo.local', ['enterprise_admin']);
    const period = await createReportingPeriod(db, admin, {
      code: 'FY2033',
      label: 'FY2033 年度',
      startDate: '2033-04-01',
      endDate: '2034-03-31',
      status: 'planning',
      submissionDueDate: null,
    });
    const manager = enterprise('sustainability@demo.local', ['sustainability_manager']);
    const units = fixture.units.filter((u) => u.organizationId === ORG_IDS.aomi).slice(0, 2);
    const metrics = fixture.metrics.filter((m) => m.organizationId === ORG_IDS.aomi).slice(0, 3);
    const { campaignId } = await createCollectionCampaign(db, manager, {
      name: '別インスタンスのキャンペーン',
      reportingPeriodId: PERIOD_IDS.fy2026,
      dueDate: '2026-09-30',
      description: null,
      unitIds: units.map((u) => u.id),
      metricIds: metrics.map((m) => m.id),
      ownerUserId: null,
    });

    // 別のインスタンス（新しい Fixture）に、このブラウザの Cookie だけが届く
    const other = createFixtureDb();
    applyDemoEdits(other, await readDemoEdits());
    expect(other.periods.find((p) => p.id === period.id)?.code).toBe('FY2033');
    expect(other.campaigns.find((c) => c.id === campaignId)?.name).toBe(
      '別インスタンスのキャンペーン',
    );
    expect(other.campaignScopes.filter((s) => s.campaignId === campaignId)).toHaveLength(
      units.length * metrics.length,
    );
  });
});
