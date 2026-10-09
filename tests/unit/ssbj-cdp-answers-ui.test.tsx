import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import type { EnterpriseShell } from '@/lib/services/shell';
import type { AuthorizationContext, ResponseStatus, RoleKey } from '@/types/domain';

/**
 * Stage B2（SSBJ・CDP・回答）の画面の再設計（docs/ui-redesign/plan.md S6・S9・S18〜S20）。
 * Server Component をそのまま呼び、Fixture の DB で描画する（Action は呼ばない）。
 *
 * - 回答画面: 状態 × 権限で primary は 1 つ（下書きは「保存（下書き）」、レビュー中は承認者の「承認」）。
 *   作成と承認を兼ねる人が下書きのとき、承認は見出しの「その他」へ（ボタンとしては並べない）
 * - 差戻しは理由必須の確認ダイアログを開くボタン（その場で状態を変えない）
 * - 出力（Word）は出力の権限があるときだけ（R3）
 * - SSBJ 要求事項は 25 件ずつ。低頻度の列は既定で出さない
 * - SSBJ 設定・要求事項の詳細は primary 1 つ
 */

const shellState = vi.hoisted(() => ({ shell: null as unknown }));

vi.mock('@/lib/services/shell', () => ({
  loadEnterpriseShell: async () => shellState.shell,
}));
vi.mock('@/app/enterprise/actions', () => ({
  addCommentAction: vi.fn(),
  applySecuritiesReportAction: vi.fn(),
  assessMaterialityTopicAction: vi.fn(),
  addMaterialityTopicAction: vi.fn(),
  carryOverSsbjAction: vi.fn(),
  confirmSsbjDraftAction: vi.fn(),
  confirmSsbjSettingsAction: vi.fn(),
  createSsbjActionPlanAction: vi.fn(),
  deleteMaterialityTopicAction: vi.fn(),
  generateCdpDraftAction: vi.fn(),
  generateSsbjDraftAction: vi.fn(),
  rejectAiDraftAction: vi.fn(),
  returnCdpResponseAction: vi.fn(),
  runSsbjGapAnalysisAction: vi.fn(),
  runSsbjGapAnalysisBulkAction: vi.fn(),
  saveCdpResponseAction: vi.fn(),
  saveMaterialityRiskOppAction: vi.fn(),
  saveSsbjDraftAction: vi.fn(),
  saveSsbjReviewAction: vi.fn(),
  saveSsbjScopeAction: vi.fn(),
  saveSsbjSettingsAction: vi.fn(),
  transitionCdpResponseAction: vi.fn(),
  updateMaterialityTopicAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  usePathname: () => '/enterprise/disclosures/ssbj',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/shared/filter-bar', () => ({
  FilterBar: ({ total }: { total: number }) => <p data-testid="filter-bar">{total} 件</p>,
}));

const { QuestionDetailView } = await import('@/app/enterprise/disclosures/question-view');
const { default: SsbjDraftPage } = await import('@/app/enterprise/disclosures/ssbj/draft/page');
const { default: SsbjRequirementsPage } =
  await import('@/app/enterprise/disclosures/ssbj/requirements/page');
const { default: SsbjRequirementDetailPage } =
  await import('@/app/enterprise/disclosures/ssbj/requirements/[itemId]/page');
const { default: SsbjSettingsPage } =
  await import('@/app/enterprise/disclosures/ssbj/settings/page');

let fixture: FixtureDb;
let db: DemoDbClient;

const EMAIL: Record<string, { email: string; roles: RoleKey[] }> = {
  preparer: { email: 'sustainability@demo.local', roles: ['sustainability_manager'] },
  approver: { email: 'approver@demo.local', roles: ['approver', 'reviewer'] },
  reviewer: { email: 'reviewer@demo.local', roles: ['reviewer'] },
  admin: { email: 'enterprise-admin@demo.local', roles: ['enterprise_admin'] },
  site: { email: 'site-user@demo.local', roles: ['site_contributor'] },
};

function shellFor(who: keyof typeof EMAIL): EnterpriseShell {
  const { email, roles } = EMAIL[who]!;
  const ctx: AuthorizationContext = {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys: roles,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
  return {
    db,
    session: null as never,
    ctx,
    periods: fixture.periods.filter((p) => p.organizationId === ORG_IDS.aomi),
    currentPeriod: fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!,
    units: fixture.units
      .filter((u) => u.organizationId === ORG_IDS.aomi && u.deletedAt === null)
      .sort((a, b) => a.sortOrder - b.sortOrder),
    metrics: fixture.metrics.filter((m) => m.organizationId === ORG_IDS.aomi),
    unreadNotifications: 0,
  };
}

/** 当期に最終判定がまだ無い SSBJ 要求事項（評価の行が無いものも未確定） */
function undecidedSsbjItemId(): string {
  const decided = new Set(
    fixture.ssbjAssessments
      .filter((a) => a.reportingPeriodId === PERIOD_IDS.fy2026 && a.finalStatus !== null)
      .map((a) => a.itemId),
  );
  const item = fixture.disclosureItems.find(
    (i) => /^(一般|気候)-/.test(i.code) && !decided.has(i.id),
  );
  if (!item) throw new Error('未確定の SSBJ 要求事項が Fixture に無い');
  return item.id;
}

/** 閉じた折りたたみの外で見えている primary のボタン・リンクの名前 */
function visiblePrimaryNames(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-variant="primary"]'))
    .filter((el) => {
      const details = el.closest('details');
      return !details || details.open;
    })
    .map((el) => (el.textContent ?? '').trim());
}

/** CDP 2026 の質問 1 つの回答を、指定の状態・版にする（Fixture を直接書き換える） */
function setCdpResponse(code: string, status: ResponseStatus, options: { ai?: boolean } = {}) {
  const itemId = fid('disclosure_item', `cdp/2026/${code}`);
  const response = fixture.disclosureResponses.find(
    (r) => r.itemId === itemId && r.reportingPeriodId === PERIOD_IDS.fy2026,
  )!;
  const versionId = fid('disclosure_response_version', `test/${code}/v1`);
  let aiRunId: string | null = null;
  if (options.ai) {
    aiRunId = fid('ai_run', `test/${code}`);
    fixture.aiRuns.push({
      ...(fixture.aiRuns[0] ?? ({} as never)),
      id: aiRunId,
      organizationId: ORG_IDS.aomi,
      status: 'succeeded',
      provider: 'mock',
      confidence: 0.7,
      warnings: [],
      sourceReferences: [],
    });
  }
  fixture.disclosureResponseVersions.push({
    id: versionId,
    responseId: response.id,
    organizationId: ORG_IDS.aomi,
    versionNo: 1,
    answerText: '回答本文',
    answerNumeric: null,
    answerChoice: [],
    status,
    originatedFromAiRunId: aiRunId,
    changeReason: null,
    contentHash: `hash-${code}`,
    createdAt: '2026-06-01T00:00:00.000Z',
    createdBy: userId('sustainability@demo.local'),
  });
  response.status = status;
  response.currentVersionId = versionId;
  response.answerText = '回答本文';
  return itemId;
}

/**
 * 回答画面の primary（コメント欄の「コメントする」を除く）。コメント欄の送信ボタンは Stage A 所有の
 * CommentBox が primary 固定のため、C で secondary に揃えるまで数えない（docs/ui-redesign/handoff/B2.md）。
 * 除くのはこの 1 つの名前だけ（ほかの primary は数える）
 */
function answerPrimaryNames(): string[] {
  return visiblePrimaryNames().filter((name) => name !== 'コメントする');
}

async function renderQuestion(itemId: string) {
  render(
    await QuestionDetailView({
      frameworkKey: 'cdp',
      frameworkLabel: 'CDP',
      basePath: '/enterprise/disclosures/cdp',
      questionId: itemId,
    }),
  );
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('回答画面（question-view）: 状態 × 権限で primary は 1 つ', () => {
  it('下書き・作成担当: 主操作は「保存（下書き）」。レビュー依頼は secondary、承認は出さない', async () => {
    shellState.shell = shellFor('preparer');
    const itemId = setCdpResponse('C0.1', 'draft');
    await renderQuestion(itemId);
    expect(answerPrimaryNames()).toEqual(['保存（下書き）']);
    expect(screen.getByRole('button', { name: 'レビュー依頼' })).toHaveAttribute(
      'data-variant',
      'secondary',
    );
    expect(screen.queryByRole('button', { name: '承認' })).toBeNull();
  });

  it('下書き・作成と承認の兼務: 承認はボタンとして並べず「その他」に入れる（primary は保存の 1 つ）', async () => {
    shellState.shell = shellFor('approver');
    const itemId = setCdpResponse('C0.1', 'draft');
    await renderQuestion(itemId);
    expect(answerPrimaryNames()).toEqual(['保存（下書き）']);
    expect(screen.queryByRole('button', { name: '承認' })).toBeNull();
    expect(screen.getByRole('button', { name: /その他/ })).toBeTruthy();
  });

  it('レビュー中・承認者: 主操作は「承認」、保存は secondary、差戻しは理由を求めるダイアログを開く', async () => {
    shellState.shell = shellFor('approver');
    const itemId = setCdpResponse('C0.1', 'in_review');
    await renderQuestion(itemId);
    expect(answerPrimaryNames()).toEqual(['承認']);
    expect(screen.getByRole('button', { name: '保存（下書き）' })).toHaveAttribute(
      'data-variant',
      'secondary',
    );
    const giveBack = screen.getByRole('button', { name: '差戻し…' });
    expect(giveBack).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('レビュー中・AI 生成のまま: 承認は押せない理由を読み上げに出す（サーバーと同じ理由）', async () => {
    shellState.shell = shellFor('approver');
    const itemId = setCdpResponse('C0.1', 'in_review', { ai: true });
    await renderQuestion(itemId);
    const approve = screen.getByRole('button', { name: '承認' });
    expect(approve).toHaveAttribute('aria-disabled', 'true');
    expect(document.body.textContent).toContain('AI が生成したままの回答は承認できません');
    // AI は候補であることは、閉じた節の外に見せる
    const candidate = screen.getAllByText('AI の候補')[0]!;
    expect(candidate.closest('details')).toBeNull();
  });

  it('レビュー担当（承認の権限なし）・レビュー中: primary は無く、差戻しだけを出す', async () => {
    shellState.shell = shellFor('reviewer');
    const itemId = setCdpResponse('C0.1', 'in_review');
    await renderQuestion(itemId);
    expect(answerPrimaryNames()).toEqual([]);
    expect(screen.getByRole('button', { name: '差戻し…' })).toBeTruthy();
  });

  it('前年の回答を入力欄のそばに参照として出す（閉じた節に入れない。plan D7）', async () => {
    shellState.shell = shellFor('preparer');
    const itemId = setCdpResponse('C0.1', 'draft');
    await renderQuestion(itemId);
    const reference = document.querySelector('[data-previous-answer]');
    expect(reference).not.toBeNull();
    expect(reference!.closest('details')).toBeNull();
    expect(reference!.textContent).toContain('精密電子部品の設計・製造・販売');
    // 同じ文を 2 か所に出さない（前年との差分の節は数値だけ）
    expect(screen.getAllByText(/精密電子部品の設計・製造・販売/)).toHaveLength(1);
  });

  it('生の enum を出さない（回答の形・記入の手引き）', async () => {
    shellState.shell = shellFor('preparer');
    const itemId = setCdpResponse('C0.1', 'draft');
    await renderQuestion(itemId);
    expect(document.body.textContent).not.toMatch(/回答型|Guidance|single_choice|numeric/);
    expect(document.body.textContent).toContain('回答の形:');
  });
});

describe('SSBJ 開示ドラフト: 出力は権限があるときだけ（R3）', () => {
  it('出力の権限がある役割には「Word で書き出す」を主操作として出す', async () => {
    shellState.shell = shellFor('admin');
    render(await SsbjDraftPage({ searchParams: Promise.resolve({}) }));
    const link = screen.getByRole('link', { name: /Word で書き出す/ });
    expect(link).toHaveAttribute('data-variant', 'primary');
    expect(link.getAttribute('href')).toContain('format=docx');
  });

  it('出力の権限が無い役割（レビュー担当・拠点担当）には出さない', async () => {
    for (const who of ['reviewer', 'site'] as const) {
      shellState.shell = shellFor(who);
      const { unmount } = render(await SsbjDraftPage({ searchParams: Promise.resolve({}) }));
      expect(screen.queryByRole('link', { name: /Word で書き出す/ }), who).toBeNull();
      expect(document.querySelector('a[href*="/api/exports/"]'), who).toBeNull();
      unmount();
    }
  });

  it('節ごとの操作は secondary（節の数だけ primary を繰り返さない）', async () => {
    shellState.shell = shellFor('preparer');
    render(await SsbjDraftPage({ searchParams: Promise.resolve({}) }));
    expect(visiblePrimaryNames().filter((n) => n.includes('人工知能に草案を作らせる'))).toEqual([]);
  });
});

describe('SSBJ 要求事項の評価: 一覧は 25 件ずつ・低頻度の列は「列」から', () => {
  it('既定は 25 行。領域・重要性・AI による判定・紐づけの列は既定で出さない', async () => {
    shellState.shell = shellFor('preparer');
    render(await SsbjRequirementsPage({ searchParams: Promise.resolve({}) }));
    const table = screen.getByRole('table', { name: 'SSBJ 要求事項' });
    expect(table.querySelectorAll('tbody tr[data-t4d-record]')).toHaveLength(25);
    const headers = Array.from(table.querySelectorAll('th')).map((th) => th.textContent);
    for (const header of ['要求事項', '適用区分', '最終判定', '優先度', '担当部署']) {
      expect(headers).toContain(header);
    }
    for (const header of ['領域', '重要性', '人工知能による判定', '紐づけ']) {
      expect(headers).not.toContain(header);
    }
  });

  it('表示件数と列は URL で変えられる（size・cols）', async () => {
    shellState.shell = shellFor('preparer');
    render(
      await SsbjRequirementsPage({
        searchParams: Promise.resolve({ size: '100', cols: 'requirement,area,ai' }),
      }),
    );
    const table = screen.getByRole('table', { name: 'SSBJ 要求事項' });
    expect(table.querySelectorAll('tbody tr[data-t4d-record]')).toHaveLength(100);
    const headers = Array.from(table.querySelectorAll('th')).map((th) => th.textContent);
    expect(headers).toEqual(['要求事項', '領域', '人工知能による判定']);
  });

  it('見出しに primary を置かない（AI のまとめ分析・CSV・前年度の引継ぎは「その他」）', async () => {
    shellState.shell = shellFor('preparer');
    render(await SsbjRequirementsPage({ searchParams: Promise.resolve({}) }));
    expect(visiblePrimaryNames()).toEqual([]);
    expect(screen.getByRole('button', { name: /その他/ })).toBeTruthy();
  });
});

describe('SSBJ の詳細・設定: primary は 1 つ', () => {
  it('要求事項の詳細（未確定）: 主操作は「最終判定として確定する」だけ。AI 分析は secondary', async () => {
    shellState.shell = shellFor('preparer');
    render(
      await SsbjRequirementDetailPage({
        params: Promise.resolve({ itemId: undecidedSsbjItemId() }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(visiblePrimaryNames()).toEqual(['最終判定として確定する']);
    expect(screen.getByRole('button', { name: /ギャップ分析/ })).toHaveAttribute(
      'data-variant',
      'secondary',
    );
  });

  it('要求事項の詳細: 開示の閲覧権限の無い拠点担当でも開ける（対象外の申請・承認の操作は出さない）', async () => {
    // SSBJ の画面は開示の閲覧権限を求めない。対象外の申請の状態を読みにいって権限の例外で画面ごと落ちていた
    shellState.shell = shellFor('site');
    render(
      await SsbjRequirementDetailPage({
        params: Promise.resolve({ itemId: undecidedSsbjItemId() }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(screen.getAllByRole('heading', { level: 1 }).length).toBe(1);
    expect(screen.queryByRole('button', { name: '対象外として申請' })).toBeNull();
    expect(screen.queryByRole('button', { name: '対象外を承認' })).toBeNull();
  });

  it('要求事項の詳細: 作成欄（?new=1）を開くと、主操作は作成欄の「対応計画に追加」だけ（期限は提出期限）', async () => {
    shellState.shell = shellFor('preparer');
    render(
      await SsbjRequirementDetailPage({
        params: Promise.resolve({ itemId: undecidedSsbjItemId() }),
        searchParams: Promise.resolve({ new: '1' }),
      }),
    );
    expect(visiblePrimaryNames()).toEqual(['対応計画に追加']);
    const due = screen.getByLabelText('対応期限') as HTMLInputElement;
    const period = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
    expect(due.value).toBe(period.submissionDueDate ?? '');
  });

  it('設定: 段階を示し、いまの段階の操作だけを primary にする。確定は確認ダイアログを開く', async () => {
    shellState.shell = shellFor('preparer');
    render(await SsbjSettingsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('navigation', { name: '設定の段階' })).toBeTruthy();
    expect(visiblePrimaryNames()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'この内容で確定する' })).toHaveAttribute(
      'aria-haspopup',
      'dialog',
    );
  });
});
