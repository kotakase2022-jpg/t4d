import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { trialScenarioId } from '@/lib/fixtures/trial-case';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import type { EnterpriseShell } from '@/lib/services/shell';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * トライアルの評価の画面（NF-32〜NF-36）。Server Component のページをそのまま呼び、Fixture の DB で描画する。
 *  - Demo Mode の架空の注記を、どのタブでも折りたたまずに出す
 *  - 主操作は画面（タブ・欄の開閉）ごとに 1 つまで。作成・編集の欄を開くと見出しの主操作を隠す
 *  - 判定・計画・対応の記録・出力は管理者だけに出す（権限の無い操作は描かない）
 *  - 率は件数（n）と一緒に出し、件数不足は率を出さない。費用対効果は「試算」の注記を常に出す
 */

const shellState = vi.hoisted(() => ({ shell: null as unknown }));

vi.mock('@/lib/services/shell', () => ({
  loadEnterpriseShell: async () => shellState.shell,
}));
vi.mock('@/app/enterprise/trial/actions', () => ({
  saveTrialPlanAction: vi.fn(),
  saveTrialCasesAction: vi.fn(),
  saveTrialDecisionAction: vi.fn(),
  recordScenarioRunAction: vi.fn(),
  judgeScenarioAction: vi.fn(),
  submitFeedbackAction: vi.fn(),
  recordMeetingFeedbackAction: vi.fn(),
  triageFeedbackAction: vi.fn(),
  recordReverificationAction: vi.fn(),
  recordTaskTimingAction: vi.fn(),
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => '/enterprise/trial',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const { default: TrialPage } = await import('@/app/enterprise/trial/page');

const FICTIONAL = '架空のトライアル記録です。実測値・実際の効果ではありません。';

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

const admin = () => ctxFor('enterprise-admin@demo.local', ['enterprise_admin']);
const author = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);

function useShell(ctx: AuthorizationContext, fixture: FixtureDb = createFixtureDb()): FixtureDb {
  shellState.shell = {
    db: new DemoDbClient(fixture),
    session: null as never,
    ctx,
    periods: fixture.periods.filter((p) => p.organizationId === ORG_IDS.aomi),
    currentPeriod: fixture.periods.find((p) => p.organizationId === ORG_IDS.aomi)!,
    units: fixture.units.filter((u) => u.organizationId === ORG_IDS.aomi),
    metrics: fixture.metrics.filter((m) => m.organizationId === ORG_IDS.aomi),
    unreadNotifications: 0,
  } satisfies EnterpriseShell;
  return fixture;
}

async function renderPage(params: Record<string, string>) {
  return render(await TrialPage({ searchParams: Promise.resolve(params) }));
}

function primaries(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-variant="primary"]')].map(
    (el) => el.textContent?.trim() ?? '',
  );
}

describe('トライアルの評価: 全タブ共通', () => {
  it.each([
    ['overview', admin],
    ['scenarios', admin],
    ['feedback', admin],
    ['timing', admin],
    ['roi', admin],
    ['overview', author],
    ['scenarios', author],
    ['feedback', author],
    ['timing', author],
    ['roi', author],
  ] as const)('%s（%#）: 架空の注記を常に出し、主操作は 1 つまで', async (tab, ctx) => {
    useShell(ctx());
    const { container } = await renderPage({ tab });
    expect(screen.getByText(FICTIONAL)).toBeVisible();
    // 注記は折りたたみ（details）の中に置かない
    expect(screen.getByText(FICTIONAL).closest('details')).toBeNull();
    expect(primaries(container).length).toBeLessThanOrEqual(1);
    // ご意見・不具合は全員が開ける（アイコン＋文字）
    expect(screen.getByRole('button', { name: 'ご意見・不具合' })).toBeInTheDocument();
  });

  it('タブは 概要・シナリオ・改善管理表・作業時間・費用対効果 の順', async () => {
    useShell(author());
    await renderPage({});
    const nav = screen.getByRole('navigation', { name: 'トライアルの評価の節' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['概要', 'シナリオ', '改善管理表', '作業時間', '費用対効果']);
  });
});

describe('概要', () => {
  it('計画と実績（分母付き）・超過の知らせ・選定ケース。管理者には「計画を編集」', async () => {
    useShell(admin());
    const { container } = await renderPage({ tab: 'overview' });
    const strip = screen.getByRole('region', { name: '計画と実績' });
    expect(strip).toHaveTextContent('/ 計画 10');
    expect(strip).toHaveTextContent('CDP オプション');
    expect(strip).toHaveTextContent('契約あり');
    expect(screen.getByText('計画を超えている項目があります（操作は止めません）')).toBeVisible();
    expect(screen.getByRole('table', { name: '選定ケース' })).toHaveTextContent('気候-10');
    expect(primaries(container)).toEqual(['計画を編集']);
  });

  it('編集の欄を開くと、欄の「計画を保存」だけが主操作になる', async () => {
    useShell(admin());
    const { container } = await renderPage({ tab: 'overview', edit: '1' });
    const panel = container.querySelector('#trial-plan-panel') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(within(panel).getByLabelText(/計画の名前/)).toHaveValue('試行導入（架空）');
    expect(primaries(container)).toEqual(['計画を保存']);
  });

  it('選定ケースの欄: 対象プロジェクトの基準の要求事項を並べ、選んだものに印', async () => {
    useShell(admin());
    const { container } = await renderPage({ tab: 'overview', cases: '1' });
    const checked = container.querySelectorAll('input[name="requirementIds"]:checked');
    expect(checked).toHaveLength(6);
    expect(container.querySelectorAll('input[name="metricIds"]:checked')).toHaveLength(10);
  });

  it('作成担当には編集の操作を出さない（欄の引数を付けても開かない）', async () => {
    useShell(author());
    const { container } = await renderPage({ tab: 'overview', edit: '1', decision: '1' });
    expect(container.querySelector('#trial-plan-panel')).toBeNull();
    expect(container.querySelector('#trial-decision-panel')).toBeNull();
    expect(screen.queryByRole('link', { name: '計画を編集' })).toBeNull();
    expect(screen.queryByRole('link', { name: '判断を記録' })).toBeNull();
    expect(screen.getByText('人が入力した判断（AI は関与しません）')).toBeVisible();
  });
});

describe('シナリオ', () => {
  it('率は件数と一緒に出し、業務の完遂状況は記録から算出と明記する', async () => {
    useShell(author());
    await renderPage({ tab: 'scenarios' });
    const table = screen.getByRole('table', { name: '検証シナリオ' });
    const ts05 = within(table)
      .getAllByRole('row')
      .find((row) => row.textContent?.includes('TS-05'))!;
    expect(ts05).toHaveTextContent('件数不足（n=2）');
    expect(
      screen.getByText('既存の業務記録から数えます。操作は自動で追跡していません'),
    ).toBeVisible();
    // 判定は管理者だけ（作成担当には行の「操作」メニューが無い）
    expect(screen.queryByRole('button', { name: /の操作$/ })).toBeNull();
  });

  it('管理者には行の「判定を記録…」と出力（その他）を出す', async () => {
    useShell(admin());
    await renderPage({ tab: 'scenarios' });
    expect(
      screen.getByRole('button', {
        name: 'TS-01 出力した原稿の本文・数値から要求事項・根拠・承認版へ遡る の操作',
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /その他/ })).toBeInTheDocument();
  });

  it('実施の欄はシナリオを選んだ状態で開き、主操作は欄の「実施を記録」だけ', async () => {
    useShell(author());
    const { container } = await renderPage({
      tab: 'scenarios',
      new: '1',
      scenario: trialScenarioId('TS-02'),
    });
    const select = container.querySelector('#trial-run-scenario') as HTMLSelectElement;
    expect(select.value).toBe(trialScenarioId('TS-02'));
    expect(primaries(container)).toEqual(['実施を記録']);
  });
});

describe('改善管理表', () => {
  it('見出しに必須要件 × 重大 × 未解決の件数。ご意見のダイアログが主操作', async () => {
    useShell(author());
    const { container } = await renderPage({ tab: 'feedback' });
    expect(
      screen.getByRole('heading', { name: '改善管理表（必須要件 × 重大 × 未解決 1 件）' }),
    ).toBeInTheDocument();
    expect(primaries(container)).toEqual(['ご意見・不具合']);
    // 作成担当には対応の記録・定例会の論点の操作を出さない
    expect(screen.queryByRole('link', { name: '対応を記録' })).toBeNull();
    expect(screen.queryByRole('link', { name: '定例会などの論点を記録' })).toBeNull();
  });

  it('管理者は行の「対応を記録」で対応の欄を開ける（投稿の内容は変えない旨を示す）', async () => {
    const fixture = useShell(admin());
    const item = fixture.trialFeedbackItems[1]!;
    const { container } = await renderPage({ tab: 'feedback', triage: '1', item: item.id });
    const panel = container.querySelector('#trial-triage-panel') as HTMLElement;
    expect(panel).toHaveTextContent('投稿の内容（種類・件名・本文・画面）は変えません');
    expect(primaries(container)).toEqual(['対応を保存']);
  });
});

describe('作業時間・費用対効果', () => {
  it('作業時間: 両方 n ≥ 3 の作業だけ短縮率、それ以外は件数を併記', async () => {
    useShell(author());
    await renderPage({ tab: 'timing' });
    const table = screen.getByRole('table', { name: '作業ごとの比較' });
    expect(table).toHaveTextContent('29.2% 短縮');
    expect(table).toHaveTextContent('件数不足（現行 n=2・T4D n=1）');
    expect(table).toHaveTextContent('目標は未設定');
  });

  it('費用対効果: 試算の注記を常に出し、URL の仮定から 288 時間・1,728,000 円', async () => {
    useShell(author());
    const { container } = await renderPage({
      tab: 'roi',
      price: '6000',
      depts: '3',
      hours: '8',
      months: '12',
    });
    expect(screen.getByText('試算（実測効果ではない）')).toBeVisible();
    for (const note of screen.getAllByText(/人件費の現金削減を意味しません。/)) {
      expect(note.closest('details')).toBeNull();
    }
    const result = screen.getByRole('region', { name: '試算の結果' });
    expect(result).toHaveTextContent('288 時間');
    expect(result).toHaveTextContent('1,728,000 円');
    expect(primaries(container)).toEqual(['試算する']);
  });

  it('費用対効果: 単価・費用の既定値を持たない（未入力では試算しない）', async () => {
    useShell(author());
    const { container } = await renderPage({ tab: 'roi' });
    expect((container.querySelector('#roi-price') as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('region', { name: '試算の数値' })).toBeNull();
    expect(screen.queryByText('円換算（試算）')).toBeNull();
  });
});
