import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { backupPurgeDueOn } from '@/lib/domain/data-disposal';
import { SCOPE_OVER_NOTICE, STANDARD_SCOPE_NOTE } from '@/lib/domain/trial-scope';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { GHG_FIXTURE_IDS } from '@/lib/fixtures/ghg-verification';
import { trialScenarioId } from '@/lib/fixtures/trial-case';
import { formatJstDate } from '@/lib/format/datetime';
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

  it('計画に算定の検証拠点（国内 1・海外 4・国コード）と将来の展開対象（全 30・うち検証 5）を出す', async () => {
    useShell(author());
    const { container } = await renderPage({ tab: 'overview' });
    const plan = screen.getByRole('region', { name: '計画' });
    const sites = container.querySelector('[data-trial-verification-sites]') as HTMLElement;
    expect(sites).toHaveTextContent('5 拠点（国内 1・海外 4）');
    expect(sites).toHaveTextContent('東日本工場（JP）・タイ工場（TH）・ベトナム工場（VN）');
    expect(plan).toHaveTextContent('全 30 拠点（うち検証対象 5・残り 25）');
    expect(plan).toHaveTextContent('（架空）検証の結果を見て海外の生産拠点へ順に広げる');
    // 対象拠点のタイルの補足に展開対象の総数
    expect(screen.getByRole('region', { name: '計画と実績' })).toHaveTextContent('展開対象 全 30');
  });

  it('算定の検証範囲: 期間・Scope・活動と、拠点別の検証の状況（状態はラベル＋アイコン）', async () => {
    useShell(author());
    await renderPage({ tab: 'overview' });
    const section = screen.getByRole('region', { name: '算定の検証範囲' });
    expect(section).toHaveTextContent('CY2025・5 拠点（国内 1・海外 4）');
    expect(section).toHaveTextContent(
      'Scope1・Scope2（マーケット基準）・Scope2（ロケーション基準）',
    );
    const table = within(section).getByRole('table', { name: '拠点別の検証の状況' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.querySelector('td')?.textContent)).toEqual([
      '東日本工場（JP）',
      'タイ工場（TH）',
      'ベトナム工場（VN）',
      'メキシコ工場（MX）',
      '米国工場（US）',
    ]);
    expect(rows[0]).toHaveTextContent('国内');
    expect(rows[1]).toHaveTextContent('海外');
    // 状況のバッジは語とアイコン（色だけにしない）
    for (const row of rows) {
      expect(row.querySelector('svg')).not.toBeNull();
    }
    expect(
      within(section).getByRole('link', { name: 'Scope1・2算定の概要を開く' }),
    ).toHaveAttribute('href', expect.stringContaining('/enterprise/ghg/calculation?period='));
  });

  it('無償の範囲と別途協議: 合意・標準機能の一覧・4 区分の表・超過の知らせ（金額は出さない）', async () => {
    useShell(author());
    await renderPage({ tab: 'overview' });
    const section = screen.getByRole('region', { name: '無償の範囲と別途協議' });
    expect(section).toHaveTextContent('合意済み');
    expect(section).toHaveTextContent('（架空）標準機能の範囲は無償、追加開発等は別途協議で合意');
    expect(section).toHaveTextContent(STANDARD_SCOPE_NOTE);
    const table = within(section).getByRole('table', { name: '別途協議の区分' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.querySelector('td')?.textContent)).toEqual([
      '大幅な拠点追加',
      '大量の PDF 等の一次データ処理',
      '外部システムとの個別連携',
      '新規機能の個別開発',
    ]);
    expect(rows[1]).toHaveTextContent('0 件 / 目安 20');
    expect(rows[1]).toHaveTextContent('目安の範囲内');
    expect(rows[2]).toHaveTextContent('数えられない');
    expect(rows[3]).toHaveTextContent('別途協議の目安を超過');
    // 超過は止めずに知らせる（折りたたまない）
    const notice = within(section).getByText(SCOPE_OVER_NOTICE);
    expect(notice.closest('details')).toBeNull();
    expect(section.textContent).not.toMatch(/\d円|￥/);
  });

  it('終了時の扱いに返却・削除の予定日と、バックアップから消える見込み日（予定日 + 35 日）', async () => {
    const fixture = useShell(author());
    const plannedOn = (fixture.trialPrograms[0]!.options.disposal as { plannedOn: string })
      .plannedOn;
    const { container } = await renderPage({ tab: 'overview' });
    expect(container.querySelector('[data-trial-disposal]')).toHaveTextContent(
      formatJstDate(plannedOn),
    );
    expect(container.querySelector('[data-trial-purge]')).toHaveTextContent(
      `${formatJstDate(backupPurgeDueOn(plannedOn, 35))}（予定日 + 残存期間 35 日）`,
    );
  });

  it('計画の欄に検証範囲・展開対象・PDF の目安、判断の欄に返却・削除の予定日を、保存済みの値で開く', async () => {
    const fixture = useShell(admin());
    const { container } = await renderPage({ tab: 'overview', edit: '1' });
    const panel = container.querySelector('#trial-plan-panel') as HTMLElement;
    expect(within(panel).getByLabelText(/算定の検証期間/)).toHaveValue(GHG_FIXTURE_IDS.period);
    expect(within(panel).getByLabelText(/将来の展開対象の総拠点数/)).toHaveValue(30);
    expect(within(panel).getByLabelText(/PDF 等の一次データの目安/)).toHaveValue(20);
    expect(panel.querySelectorAll('input[name="ghgUnitIds"]:checked')).toHaveLength(5);
    expect(within(panel).getByRole('checkbox', { name: 'タイ工場（TH）' })).toBeChecked();
    const decision = await renderPage({ tab: 'overview', decision: '1' });
    const decisionPanel = decision.container.querySelector('#trial-decision-panel') as HTMLElement;
    expect(within(decisionPanel).getByLabelText(/返却・削除の予定日/)).toHaveValue(
      (fixture.trialPrograms[0]!.options.disposal as { plannedOn: string }).plannedOn,
    );
    expect(within(decisionPanel).getByLabelText(/無償の範囲の合意日/)).toBeInTheDocument();
  });

  it('作成担当には編集の操作を出さない（欄の引数を付けても開かない）', async () => {
    useShell(author());
    const { container } = await renderPage({ tab: 'overview', edit: '1', decision: '1' });
    expect(container.querySelector('#trial-plan-panel')).toBeNull();
    expect(container.querySelector('#trial-decision-panel')).toBeNull();
    expect(screen.queryByRole('link', { name: '計画を編集' })).toBeNull();
    expect(screen.queryByRole('link', { name: '判断を記録' })).toBeNull();
    expect(screen.queryByRole('link', { name: '合意を記録' })).toBeNull();
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
    // 別途協議の区分（費用区分が別途協議のときは必須）
    const scopeKind = within(panel).getByLabelText(/別途協議の区分/) as HTMLSelectElement;
    expect([...scopeKind.options].map((o) => o.textContent)).toEqual([
      '選ばない',
      '大幅な拠点追加',
      '大量の PDF 等の一次データ処理',
      '外部システムとの個別連携',
      '新規機能の個別開発',
    ]);
  });

  it('集計に「別途協議」の件数のタイル（区分ごとの内訳・費用区分で絞った表へのリンク）', async () => {
    useShell(author());
    const { container } = await renderPage({ tab: 'feedback' });
    const tile = [...container.querySelectorAll('[data-metric-tile]')].find((el) =>
      el.textContent?.startsWith('別途協議'),
    ) as HTMLElement;
    expect(tile).toHaveTextContent('1件');
    expect(tile).toHaveTextContent('新規機能の個別開発 1');
    expect(tile.closest('a') ?? tile.querySelector('a')).toHaveAttribute(
      'href',
      expect.stringContaining('cost=separate_estimate'),
    );
    // 費用区分のラベルは「別途協議」（DB の値は separate_estimate のまま）
    expect(screen.getByRole('table', { name: '改善管理表' })).toHaveTextContent('別途協議');
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
